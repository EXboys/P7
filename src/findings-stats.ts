import { Database } from "bun:sqlite";
import { parseFindings } from "./diff-critic.ts";
import { initDb } from "./state.ts";
import type {
  DiffCriticFinding,
  DcSeverity,
  FindingsAggregation,
  FindingsDimensionStats,
  PromptTuningInput,
} from "./types.ts";
import { extractCalibrationDataset } from "./calibration-extractor.ts";
import { searchOptimalCutoffs } from "./threshold-calibrator.ts";
import type { CalibratedThresholds } from "./threshold-calibrator.ts";

/**
 * Security-relevant file path pattern categories for threat model preamble
 * generation. Each group pairs an array of substring patterns (case-insensitive
 * match against lowercased file path) with a concise Chinese label.
 */
const THREAT_PATTERNS: Array<{ patterns: string[]; label: string }> = [
  { patterns: ["route", "api", "endpoint", "controller", "router", "handler", "middleware"], label: "路由/API" },
  { patterns: ["db", "sql", "schema", "migration", "query", "database", "repository", "model", "orm"], label: "数据层" },
  { patterns: ["shell", "exec", "cmd", "command", "spawn", "child_process"], label: "命令执行" },
  { patterns: ["crypto", "encrypt", "decrypt", "cipher", "hash", "salt"], label: "加密" },
  { patterns: ["auth", "login", "session", "token", "jwt", "permission", "rbac", "oauth", "credential"], label: "鉴权" },
  { patterns: ["upload", "download", "file", "fs", "filesystem", "path", "stream"], label: "文件操作" },
  { patterns: ["input", "form", "param", "validate", "sanitize", "xss", "inject"], label: "输入处理" },
  { patterns: ["config", "secret", "key", "env", "cert"], label: "密钥配置" },
];

/**
 * Query `plan_states` for all records with non-null findings text
 * (`findings` or `diff_critic_findings` columns), parse each via
 * `parseFindings()`, and return the results grouped by plan ID.
 *
 * Returns an empty array when no findings exist or the DB is empty —
 * callers MUST handle this gracefully (zeroed stats rather than crash).
 *
 * @param db — open bun:sqlite Database handle (from `initDb()`)
 */
export function readAllPlanFindings(
  db: Database,
): Array<{ planId: string; findings: DiffCriticFinding[] }> {
  const rows = db
    .query(
      `SELECT plan_id, findings, diff_critic_findings
       FROM plan_states
       WHERE findings IS NOT NULL OR diff_critic_findings IS NOT NULL`,
    )
    .all() as Array<{
    plan_id: string;
    findings: string | null;
    diff_critic_findings: string | null;
  }>;

  const results: Array<{ planId: string; findings: DiffCriticFinding[] }> = [];

  for (const row of rows) {
    const all: DiffCriticFinding[] = [];

    if (row.findings) {
      try {
        all.push(...parseFindings(row.findings));
      } catch {
        /* skip malformed findings text — treat as empty */
      }
    }
    if (row.diff_critic_findings) {
      try {
        all.push(...parseFindings(row.diff_critic_findings));
      } catch {
        /* skip malformed findings text — treat as empty */
      }
    }

    if (all.length > 0) {
      results.push({ planId: row.plan_id, findings: all });
    }
  }

  return results;
}

/**
 * Compute aggregated findings statistics across a set of parsed plan findings.
 *
 * Calculates for each dimension:
 *  - `total`: absolute finding count
 *  - `bySeverity`: info / warning / blocker breakdown
 *  - `hitRate`: proportion of plans with ≥1 finding in this dimension
 *  - `blockerRatio`: proportion of findings in this dimension that are blockers
 *
 * Also produces `okRate` (plans with zero findings / total plans) and a
 * pre-built `tuningInput` for prompt self-tuning injection.
 *
 * @param plans — parsed findings grouped by planId (output of `readAllPlanFindings`)
 */
export function computeFindingsAggregation(
  plans: Array<{ planId: string; findings: DiffCriticFinding[] }>,
): FindingsAggregation {
  const scannedPlans = plans.length;
  const allFindings = plans.flatMap((p) => p.findings);
  const totalFindings = allFindings.length;
  const plansWithAnyFinding = plans.filter((p) => p.findings.length > 0).length;
  const okRate = scannedPlans > 0
    ? (scannedPlans - plansWithAnyFinding) / scannedPlans
    : 0;

  // Group findings by dimension
  const dimGroups = new Map<string, DiffCriticFinding[]>();
  for (const f of allFindings) {
    const dim = f.dimension || "other";
    if (!dimGroups.has(dim)) dimGroups.set(dim, []);
    dimGroups.get(dim)!.push(f);
  }

  // Count unique plans hit per dimension (for hitRate)
  const dimPlanIds = new Map<string, Set<string>>();
  for (const plan of plans) {
    const seen = new Set<string>();
    for (const f of plan.findings) {
      const dim = f.dimension || "other";
      if (!seen.has(dim)) {
        seen.add(dim);
        if (!dimPlanIds.has(dim)) dimPlanIds.set(dim, new Set());
        dimPlanIds.get(dim)!.add(plan.planId);
      }
    }
  }

  // Build per-dimension stats
  const dimensions: FindingsDimensionStats[] = [];
  for (const [dim, group] of dimGroups) {
    const bySeverity: Record<DcSeverity, number> = {
      info: 0,
      warning: 0,
      blocker: 0,
    };
    let blockerCount = 0;

    for (const f of group) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      if (f.severity === "blocker") blockerCount++;
    }

    const hitPlanCount = dimPlanIds.get(dim)?.size ?? 0;

    dimensions.push({
      dimension: dim,
      total: group.length,
      bySeverity,
      hitRate: scannedPlans > 0 ? hitPlanCount / scannedPlans : 0,
      blockerRatio: group.length > 0 ? blockerCount / group.length : 0,
    });
  }

  // Sort by total descending
  dimensions.sort((a, b) => b.total - a.total);

  const agg: Omit<FindingsAggregation, "tuningInput"> = {
    scannedPlans,
    totalFindings,
    okRate,
    dimensions,
  };

  return { ...agg, tuningInput: buildPromptTuningInput(agg, allFindings) };
}

/**
 * Transform an aggregation into the minimal JSON format ready for injection
 * into critic prompt templates.
 *
 * Pattern extraction groups findings by the first 50 characters of their
 * message text, enabling the prompt template to surface recurring judgment
 * themes. Only the top 20 patterns (by frequency) are included to keep the
 * injected payload small.
 */
function buildPromptTuningInput(
  agg: Omit<FindingsAggregation, "tuningInput">,
  allFindings: DiffCriticFinding[],
): PromptTuningInput {
  // Group by truncated message signature
  const patternMap = new Map<
    string,
    { dimension: string; count: number; topSeverity: DcSeverity }
  >();

  for (const f of allFindings) {
    const sig = f.message.slice(0, 50).toLowerCase();
    const existing = patternMap.get(sig);
    if (existing) {
      existing.count++;
      // Upgrade severity: info < warning < blocker
      const sevOrder: DcSeverity[] = ["info", "warning", "blocker"];
      if (sevOrder.indexOf(f.severity) > sevOrder.indexOf(existing.topSeverity)) {
        existing.topSeverity = f.severity;
      }
    } else {
      patternMap.set(sig, {
        dimension: f.dimension || "other",
        count: 1,
        topSeverity: f.severity,
      });
    }
  }

  // Top 20 patterns by frequency
  const patterns = [...patternMap.entries()]
    .map(([sig, entry]) => ({
      dimension: entry.dimension,
      description: sig,
      frequency: entry.count,
      topSeverity: entry.topSeverity,
    }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 20);

  return {
    summary: {
      totalPlansScanned: agg.scannedPlans,
      totalFindings: agg.totalFindings,
      okRate: agg.okRate,
    },
    dimensions: agg.dimensions.map((d) => ({
      name: d.dimension,
      hitRate: d.hitRate,
      severityBreakdown: d.bySeverity,
      blockerRatio: d.blockerRatio,
    })),
    patterns,
  };
}

interface CweBreakdownEntry {
  cweId: string;
  total: number;
  bySeverity: Record<DcSeverity, number>;
}

/**
 * Group vulnerability-dimension findings by CWE identifier and compute
 * per-CWE severity distribution for the dynamic_rules CWE breakdown table.
 *
 * Returns an empty array when no vulnerability findings with CWE IDs exist —
 * callers MUST check the length before rendering to avoid empty table headers.
 */
function computeCweBreakdown(
  plans: Array<{ planId: string; findings: DiffCriticFinding[] }>,
): CweBreakdownEntry[] {
  const vulnFindings = plans
    .flatMap((p) => p.findings)
    .filter((f) => f.dimension === "漏洞发现" && f.cweId);

  const groups = new Map<string, DiffCriticFinding[]>();
  for (const f of vulnFindings) {
    const cwe = f.cweId!;
    if (!groups.has(cwe)) groups.set(cwe, []);
    groups.get(cwe)!.push(f);
  }

  const entries: CweBreakdownEntry[] = [];
  for (const [cweId, group] of groups) {
    const bySeverity: Record<DcSeverity, number> = { info: 0, warning: 0, blocker: 0 };
    for (const f of group) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    }
    entries.push({ cweId, total: group.length, bySeverity });
  }

  entries.sort((a, b) => b.total - a.total);
  return entries;
}

// ── Calibrated thresholds formatting ──

/**
 * Render CalibratedThresholds as a compact markdown table for injection
 * into the dynamic_rules section of critic prompt templates.
 *
 * Columns: severity, cutoff, F1, TP, FP, total labeled samples.
 * Returns an empty array when no severity has labeled data (all cutoffs zero).
 */
function formatCalibratedThresholds(thresholds: CalibratedThresholds): string[] {
  const lines: string[] = [];
  lines.push("校准严重度阈值（基于历史标注数据）：");
  lines.push("| 严重度 | cutoff | F1 | TP | FP | 标注样本 |");
  lines.push("|--------|--------|----|----|----|---------|");

  const severities: DcSeverity[] = ["blocker", "warning", "info"];
  for (const sev of severities) {
    const t = thresholds[sev];
    lines.push(
      `| ${t.severity} | ${t.cutoff.toFixed(3)} | ${t.f1.toFixed(3)} | ${t.truePositives} | ${t.falsePositives} | ${t.totalLabeled} |`,
    );
  }
  lines.push("");
  lines.push(`> 基于 ${thresholds.totalSamplesUsed} 个标注样本校准`);
  lines.push("");

  return lines;
}

/**
 * Build a formatted markdown string of historical findings patterns
 * for injection into critic prompt templates as `{{dynamic_rules}}`.
 *
 * Queries plan_states for non-null findings records, aggregates them
 * by dimension, and formats the top patterns and stats into a concise
 * markdown section. Returns null when no historical data exists —
 * callers should pass the result through `renderPrompt` with a
 * `{{$if dynamic_rules}}` guard so the section is cleanly omitted.
 */
export function buildDynamicRules(projectPath: string): string | null {
  const db = initDb(projectPath);
  const plans = readAllPlanFindings(db);
  if (plans.length === 0) return null;

  const agg = computeFindingsAggregation(plans);
  const { summary, dimensions, patterns } = agg.tuningInput;

  const lines: string[] = [];
  lines.push(
    `基于最近 ${summary.totalPlansScanned} 条评审记录的统计分析（共 ${summary.totalFindings} 条发现，OK率 ${Math.round(summary.okRate * 100)}%）：`,
  );
  lines.push("");

  if (dimensions.length > 0) {
    lines.push("| 维度 | 出现率 | info | warning | blocker | blocker占比 |");
    lines.push("|------|--------|------|---------|---------|------------|");
    for (const d of dimensions) {
      const ib = d.severityBreakdown;
      lines.push(
        `| ${d.name} | ${Math.round(d.hitRate * 100)}% | ${ib.info ?? 0} | ${ib.warning ?? 0} | ${ib.blocker ?? 0} | ${Math.round(d.blockerRatio * 100)}% |`,
      );
    }
    lines.push("");
  }

  if (patterns.length > 0) {
    const top = patterns.slice(0, 5);
    lines.push("高频模式（Top 5）：");
    for (const p of top) {
      lines.push(
        `- [${p.dimension}] "${p.description}" — 出现 ${p.frequency} 次（最高严重度: ${p.topSeverity}）`,
      );
    }
    lines.push("");
  }

  const cweBreakdown = computeCweBreakdown(plans);
  if (cweBreakdown.length > 0) {
    lines.push("CWE 漏洞分布：");
    lines.push("| CWE ID | 数量 | info | warning | blocker |");
    lines.push("|--------|------|------|---------|---------|");
    for (const entry of cweBreakdown) {
      lines.push(
        `| ${entry.cweId} | ${entry.total} | ${entry.bySeverity.info ?? 0} | ${entry.bySeverity.warning ?? 0} | ${entry.bySeverity.blocker ?? 0} |`,
      );
    }
    lines.push("");
  }

  // ── Calibrated severity thresholds (empirical, from historical data) ──
  try {
    const calibrationDataset = extractCalibrationDataset(db);
    const labeledCount =
      calibrationDataset.labelCounts.truePositive + calibrationDataset.labelCounts.falsePositive;
    if (labeledCount > 0) {
      const thresholds = searchOptimalCutoffs(calibrationDataset);
      lines.push(...formatCalibratedThresholds(thresholds));
    }
  } catch {
    /* skip calibration section on malformed DB records */
  }

  return lines.join("\n");
}

/**
 * Parse file path strings from a `git diff --stat` output.
 * Extracts paths from standard diff-stat lines like:
 * ```
 *  src/file.ts | 2 +-
 *  src/db/query.ts | 10 ++++++++++
 * ```
 * Skips binary file indicators and deleted-file markers.
 * Returns an empty array when the input has no parseable paths.
 */
function parseDiffStatPaths(diffStat: string): string[] {
  const paths: string[] = [];
  for (const line of diffStat.split("\n")) {
    const m = line.match(/^\s*(.+?)\s+\|\s+\d+/);
    if (m) {
      const path = m[1].trim();
      if (path !== "deleted" && !path.startsWith("Bin")) {
        paths.push(path);
      }
    }
  }
  return paths;
}

/**
 * Scan diff stat output for security-relevant file path patterns and generate
 * a concise attack surface preamble (~50 tokens) for injection into the critic
 * prompt's threat model section.
 *
 * Checks file paths against categories: routes/API, database, shell/command
 * execution, cryptography, authentication, file operations, input handling,
 * and secrets/config. Each matched category is included in the output.
 *
 * Returns a compact Chinese markdown paragraph (~50 tokens) listing the
 * affected security domains, or `null` if no relevant patterns are found.
 * Callers should pass the result through `renderPrompt` with a
 * `{{$if threat_model}}` guard so the section is cleanly omitted.
 *
 * @param diffStat — raw `git diff --stat` string (same value passed to reviewDiff)
 */
export function buildThreatModelPreamble(diffStat: string): string | null {
  const paths = parseDiffStatPaths(diffStat);
  if (paths.length === 0) return null;

  const lowerPaths = paths.map((p) => p.toLowerCase());
  const matched = new Set<string>();

  for (const { patterns, label } of THREAT_PATTERNS) {
    for (const fp of lowerPaths) {
      for (const pat of patterns) {
        if (fp.includes(pat)) {
          matched.add(label);
          break;
        }
      }
    }
  }

  if (matched.size === 0) return null;

  return `攻击面: ${[...matched].join("、")}。审查时重点关注该上下文中的注入、越权、泄露、路径遍历等经典漏洞。`;
}
