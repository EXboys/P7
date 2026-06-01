import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { projectSubpathForRead, projectSubpathForWrite } from "./p7-paths.ts";
import { bigramJaccard, extractLastJsonBlock } from "./json-utils.ts";
import { readPrompt, runSdkQuery } from "./sdk.ts";
import { formatDiscoveryForPrompt, loadSnapshot } from "./tech-discovery.ts";
import { shouldDegrade, splitPlan } from "./degrade.ts";
import { appendLesson } from "./agent-memory.ts";
import { countQueuedPlans, upsertPlanState } from "./state.ts";
import { processAutoApprovals, savePendingApproval } from "./approval.ts";
import { loadConfig } from "./config.ts";
import { PlanSchema, type Plan, type PlanRecord, type ProjectScan } from "./types.ts";
import { getHeadCommit } from "./worktree.ts";

const FAILED_PLANS_DIR = "failed-plans";

function parseCriticOk(text: string): boolean {
  const m = text.match(/OK:\s*(true|false)/i);
  if (!m) return false;
  return m[1].toLowerCase() === "true";
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
    throw new Error(
      `max_pending_plans (${cfg.max_pending_plans}) exceeded: ${depth} plans queued`,
    );
  }
  if (depth >= degradeThreshold) {
    await appendLesson(
      projectPath,
      `plan:degrade queue depth ${depth}/${cfg.max_pending_plans}`,
    );
  }

  const system = readPrompt("planner-system.md");
  const criticPrompt = readPrompt("plan-critic.md");

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

    for (const f of recentFailed) {
      if (bigramJaccard(parsed.title, f.title) > 0.6) {
        throw new Error(
          `Plan title too similar to recent failure: "${parsed.title}" ~ "${f.title}"`,
        );
      }
    }

    const criticMatch = text.match(/FINDINGS:[\s\S]*?OK:\s*(true|false)/i);
    lastCritic = criticMatch?.[0] ?? "";
    if (!criticMatch || parseCriticOk(lastCritic)) {
      plan = parsed;
      break;
    }
    plan = parsed;
  }

  if (!plan) throw new Error("Failed to generate plan");

  const plansToSave = shouldDegrade(plan) ? splitPlan(plan) : [plan];
  const createdAt = new Date().toISOString();
  let first: PlanRecord | null = null;
  const savedIds: string[] = [];

  for (let i = 0; i < plansToSave.length; i++) {
    const p = plansToSave[i];
    const id = `${Date.now()}${i > 0 ? `-${i}` : ""}`;
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
      title: p.title,
      status: "planned",
      createdAt: record.createdAt,
    });
    savePendingApproval(projectPath, record);
    savedIds.push(record.planId);
    if (!first) first = record;
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
      title: plan.title,
      reason,
      failedAt: new Date().toISOString(),
    }),
  );
}
