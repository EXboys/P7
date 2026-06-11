import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { projectSubpathForRead, projectSubpathForWrite } from "./p7-paths.ts";
import { bigramJaccard, extractLastJsonBlock } from "./json-utils.ts";
import { readPrompt, renderPrompt, runSdkQuery } from "./sdk.ts";
import { formatDiscoveryForPrompt, loadSnapshot } from "./tech-discovery.ts";
import { shouldDegrade, splitPlan } from "./degrade.ts";
import { buildDynamicRules } from "./findings-stats.ts";
import { appendLesson } from "./agent-memory.ts";
import { countQueuedPlans, recordBackpressureEvent, updatePlanCriticFindings, upsertPlanState } from "./state.ts";
import { processAutoApprovals, savePendingApproval } from "./approval.ts";
import { loadConfig } from "./config.ts";
import { planDisplayTitle } from "./plan-i18n.ts";
import { PlanSchema, type Plan, type PlanRecord, type ProjectScan } from "./types.ts";
import { getHeadCommit } from "./worktree.ts";
import { reviewPlanWithRouting } from "./evaluator-middleware.ts";

const FAILED_PLANS_DIR = "failed-plans";

/* ── Structured plan-critic output parsing ── */

/**
 * Parse structured PlanCriticResult from planner response text.
 *
 * Strategy — the planner's response contains two JSON fenced code blocks:
 *   - The **last** block is the plan JSON (consumed by PlanSchema).
 *   - The **second-to-last** block is the critic's structured output.
 *
 * Resolution:
 *   1. Collect all fenced JSON blocks; if >= 2, try second-to-last as critic.
 *   2. If that fails, strip the last JSON block (via extractLastJsonBlock +
 *      string remove) and re-parse the remainder.
 *   3. Ultimate fallback: regex-based OK: true/false extraction (same as
 *      old parseCriticOk behaviour).
 */
export function parsePlanCriticFindings(text: string): {
  ok: boolean;
  findings: Array<{
    severity: string;
    category: string;
    target: string;
    description: string;
    recommendation: string;
    code?: string;
  }>;
  summary: string;
} {
  // Method 1: second-to-last fenced JSON block
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (fenced.length >= 2) {
    const criticRaw = fenced[fenced.length - 2][1].trim();
    const result = tryParseCriticJson(criticRaw);
    if (result) return result;
  }

  // Method 2: remove last JSON block and re-extract
  try {
    const planJson = extractLastJsonBlock(text);
    const planStr = JSON.stringify(planJson);
    const planIdx = text.lastIndexOf(planStr);
    if (planIdx >= 0) {
      const remaining = text.slice(0, planIdx) + text.slice(planIdx + planStr.length);
      try {
        const criticRaw = extractLastJsonBlock(remaining);
        if (criticRaw && typeof criticRaw === "object") {
          const result = tryParseCriticJson(JSON.stringify(criticRaw));
          if (result) return result;
        }
      } catch {
        /* fall through */
      }
    }
  } catch {
    /* fall through */
  }

  // Fallback: regex-based OK extraction
  return fallbackParseCriticResult(text);
}

/**
 * Attempt to parse and validate a raw JSON string as PlanCriticResult.
 * Returns null on complete failure.
 */
export function tryParseCriticJson(raw: string): ReturnType<typeof parsePlanCriticFindings> | null {
  try {
    const parsed = JSON.parse(raw);
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.ok !== "boolean") return null;
    const findings = Array.isArray(obj.findings)
      ? obj.findings.map(
          (f: unknown): {
            severity: string;
            category: string;
            target: string;
            description: string;
            recommendation: string;
            code?: string;
          } => {
            const finding = f as Record<string, unknown>;
            const sev = String(finding.severity ?? "info").toLowerCase();
            return {
              severity: sev === "warning" || sev === "blocker" ? sev : "info",
              category: String(finding.category ?? "other"),
              target: String(finding.target ?? "plan"),
              description: String(finding.description ?? ""),
              recommendation: String(finding.recommendation ?? ""),
              code: finding.code != null ? String(finding.code) : undefined,
            };
          },
        )
      : [];
    return {
      ok: obj.ok,
      summary: String(obj.summary ?? ""),
      findings,
    };
  } catch {
    return null;
  }
}

/** Fallback: regex-based OK extraction for when JSON parsing fails entirely. */
function fallbackParseCriticResult(text: string): ReturnType<typeof parsePlanCriticFindings> {
  const okMatch = text.match(/OK:\s*(true|false)/i);
  const ok = okMatch ? okMatch[1].toLowerCase() === "true" : true;
  return { ok, findings: [], summary: "" };
}

/** Format structured critic findings into human-readable revision-feedback text. */
function formatCriticFindings(result: ReturnType<typeof parsePlanCriticFindings>): string {
  if (result.findings.length === 0) {
    return `OK: ${result.ok}`;
  }
  const lines: string[] = ["FINDINGS:"];
  for (const f of result.findings) {
    const entry = `- [${f.severity}] ${f.category} (target: ${f.target}): ${f.description}`;
    lines.push(entry);
    if (f.recommendation) {
      lines.push(`  → ${f.recommendation}`);
    }
    if (f.code) {
      lines.push(`  code: ${f.code}`);
    }
  }
  lines.push(`OK: ${result.ok}`);
  return lines.join("\n");
}

function loadRecentFailedTitles(projectPath: string): { title: string; at: number }[] {
  const dir = projectSubpathForRead(projectPath, FAILED_PLANS_DIR);
  if (!existsSync(dir)) return [];
  const out: { title: string; at: number }[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      if (raw.title && raw.failedAt) {
        out.push({ title: raw.title, at: new Date(raw.failedAt).getTime() });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export async function generatePlan(
  projectPath: string,
  scan: ProjectScan,
  goal: string,
): Promise<PlanRecord> {
  let baseCommit: string | undefined;
  try {
    baseCommit = getHeadCommit(projectPath);
  } catch {
    baseCommit = undefined;
  }

  // 队列深度检查：积压超标时拒绝新 Plan
  const cfg = loadConfig(projectPath);
  const depth = countQueuedPlans(projectPath);
  const degradeThreshold = Math.ceil(cfg.max_pending_plans * 0.7);
  if (depth >= cfg.max_pending_plans) {
    await appendLesson(
      projectPath,
      `plan:queue-full ${depth}/${cfg.max_pending_plans}; wait for execute drain before generating new plan`,
    );
    throw new Error(
      `queue full: ${depth}/${cfg.max_pending_plans} plans queued; waiting for execute drain`,
    );
  }
  if (depth >= degradeThreshold) {
    await appendLesson(
      projectPath,
      `plan:degrade queue depth ${depth}/${cfg.max_pending_plans}`,
    );
  }

  const system = readPrompt("planner-system.md");
  const dynamicRules = buildDynamicRules(projectPath);
  const criticPrompt = renderPrompt("plan-critic.md", { dynamic_rules: dynamicRules });

  const failed = loadRecentFailedTitles(projectPath);
  const now = Date.now();
  const recentFailed = failed.filter((f) => now - f.at < 24 * 3600 * 1000);

  const roadmapHint = existsSync(join(projectPath, "ROADMAP.md"))
    ? readFileSync(join(projectPath, "ROADMAP.md"), "utf-8").slice(0, 2500)
    : "（无 ROADMAP.md）";
  const radar = formatDiscoveryForPrompt(loadSnapshot(projectPath));
  const userPrompt = `## 今日目标\n${goal}\n\n## 今日技术雷达\n${radar}\n\n## ROADMAP（节选）\n${roadmapHint}\n\n## 项目扫描\n\`\`\`json\n${JSON.stringify(scan, null, 2)}\n\`\`\`\n\n请输出计划 JSON。`;

  let plan: Plan | null = null;
  let lastCritic = "";
  let lastCriticFindings: Array<{
    severity: string;
    category: string;
    target: string;
    description: string;
    recommendation: string;
    code?: string;
  }> = [];

  for (let round = 0; round < 3; round++) {
    const revision =
      round > 0
        ? `\n\nplan-critic 反馈：\n${lastCritic}\n请修订计划并重新输出 JSON。`
        : "";
    const { text } = await runSdkQuery({
      prompt: userPrompt + revision,
      cwd: projectPath,
      systemPrompt: system,
      role: "planner",
      allowedTools: ["Read", "Glob", "Grep", "Agent"],
      agents: {
        "plan-critic": {
          description: "Reviews plan for scope and risks",
          prompt: criticPrompt,
          tools: ["Read", "Glob", "Grep"],
        },
      },
    });

    const raw = extractLastJsonBlock(text);
    const parsed = PlanSchema.parse(raw);
    parsed.baseCommit = baseCommit;

    /* ── Gemma fast-path ── */
    {
      const gemmaResult = await reviewPlanWithRouting(parsed, projectPath);
      if (gemmaResult !== null) {
        if (gemmaResult.ok) {
          plan = parsed;
          lastCritic = gemmaResult.feedback;
          break;
        }
        // Gemma rejected — use its feedback and continue to next revision round
        lastCritic = gemmaResult.feedback;
        lastCriticFindings = [];
        plan = parsed;
        continue;
      }
    }
    /* ── end Gemma fast-path ── */

    for (const f of recentFailed) {
      if (bigramJaccard(parsed.title, f.title) > 0.6) {
        throw new Error(
          `Plan title too similar to recent failure: "${parsed.title}" ~ "${f.title}"`,
        );
      }
    }

    const criticResult = parsePlanCriticFindings(text);
    lastCriticFindings = criticResult.findings;
    lastCritic = formatCriticFindings(criticResult);
    if (criticResult.ok) {
      plan = parsed;
      break;
    }
    plan = parsed;
  }

  if (!plan) throw new Error("Failed to generate plan");

  const degraded = shouldDegrade(plan);
  const rawPlansToSave = degraded ? splitPlan(plan) : [plan];
  const availableSlots = Math.max(1, cfg.max_pending_plans - depth);
  const plansToSave = rawPlansToSave.slice(0, availableSlots);
  if (plansToSave.length < rawPlansToSave.length) {
    await appendLesson(
      projectPath,
      `plan:degrade truncated ${rawPlansToSave.length}->${plansToSave.length} due to max_pending_plans=${cfg.max_pending_plans}`,
    );
  }
  const createdAt = new Date().toISOString();
  let first: PlanRecord | null = null;
  const savedIds: string[] = [];

  for (let i = 0; i < plansToSave.length; i++) {
    const p = plansToSave[i];
    const id = `${Date.now()}${i > 0 ? `-${i}` : ""}`;
    if (degraded) {
      recordBackpressureEvent(projectPath, id, {
        type: "degradation",
        detail: `Sub-plan ${i + 1}/${plansToSave.length} from "${plan.title}": ${p.changes.length} files (original ${plan.changes.length})`,
      });
    }
    const record = savePlanRecord(projectPath, {
      planId: id,
      projectPath,
      goal,
      plan: p,
      createdAt,
    });
    upsertPlanState(projectPath, {
      planId: record.planId,
      projectPath,
      goal,
      title: planDisplayTitle(p),
      status: "planned",
      createdAt: record.createdAt,
    });
    savePendingApproval(projectPath, record);
    savedIds.push(record.planId);
    if (!first) first = record;
  }

  // Persist plan-critic findings to each saved plan
  const findingsJson = JSON.stringify(lastCriticFindings);
  for (const id of savedIds) {
    updatePlanCriticFindings(projectPath, id, findingsJson);
  }

  processAutoApprovals(projectPath, cfg, { planIds: savedIds });

  return first!;
}

export function plansDir(projectPath: string): string {
  return projectSubpathForRead(projectPath, "plans");
}

function plansWriteDir(projectPath: string): string {
  return projectSubpathForWrite(projectPath, "plans");
}

export function planPath(projectPath: string, planId: string): string {
  return join(plansDir(projectPath), `${planId}.json`);
}

export function savePlanRecord(projectPath: string, record: PlanRecord): PlanRecord {
  const dir = plansWriteDir(projectPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${record.planId}.json`),
    JSON.stringify(record, null, 2),
  );
  return record;
}

export function loadPlanRecord(projectPath: string, planId: string): PlanRecord | null {
  const path = planPath(projectPath, planId);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (raw.plan) return raw as PlanRecord;
  return {
    planId: raw.planId ?? planId,
    projectPath,
    goal: raw.goal ?? "",
    plan: PlanSchema.parse(raw),
    createdAt: raw.createdAt ?? new Date().toISOString(),
  };
}

export function loadLatestPlanRecord(projectPath: string): PlanRecord | null {
  const dir = plansDir(projectPath);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  return loadPlanRecord(projectPath, files[0].replace(/\.json$/, ""));
}

export function recordFailedPlan(
  projectPath: string,
  plan: Plan & { planId?: string },
  reason: string,
): void {
  const dir = projectSubpathForWrite(projectPath, FAILED_PLANS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${Date.now()}.json`),
    JSON.stringify({
      planId: plan.planId,
      title: planDisplayTitle(plan),
      reason,
      failedAt: new Date().toISOString(),
    }),
  );
}
