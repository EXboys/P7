import { Database } from "bun:sqlite";
import { parseFindings } from "./diff-critic.ts";
import type {
  DiffCriticFinding,
  DcSeverity,
  FindingsAggregation,
  FindingsDimensionStats,
  PromptTuningInput,
} from "./types.ts";

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
