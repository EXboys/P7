import { Database } from "bun:sqlite";
import { parseFindings } from "./diff-critic.ts";
import type {
  CalibrationDataset,
  CalibrationLabel,
  CalibrationLabelValue,
  CalibrationSample,
  DiffCriticFinding,
  PlanStateStatus,
} from "./types.ts";

/**
 * Infer a heuristic label for a single finding based on plan status and severity.
 *
 * Heuristic rule:
 * - Blocker + merged/pushed → FP (critic over-flagged; change was accepted)
 * - Blocker + failed → TP (critic correctly identified real issue)
 * - All other combinations → unlabeled (low confidence)
 */
function inferLabel(status: PlanStateStatus, severity: string): CalibrationLabelValue {
  if (severity !== "blocker") return "unlabeled";
  if (status === "merged" || status === "pushed") return "fp";
  if (status === "failed") return "tp";
  return "unlabeled";
}

/**
 * Query plan_states for records with non-null diff_critic_findings,
 * parse findings via parseFindings(), assign heuristic labels by
 * plan-status heuristics, and return a structured CalibrationDataset.
 *
 * Returns an empty dataset (zero counts) when no records exist or
 * when all diff_critic_findings are null/empty.
 */
export function extractCalibrationDataset(db: Database): CalibrationDataset {
  const rows = db
    .query(
      `SELECT plan_id, status, diff_critic_findings
       FROM plan_states
       WHERE diff_critic_findings IS NOT NULL`,
    )
    .all() as Array<{
    plan_id: string;
    status: string;
    diff_critic_findings: string;
  }>;

  const samples: CalibrationSample[] = [];
  let tp = 0;
  let fp = 0;
  let unlabeled = 0;

  for (const row of rows) {
    if (!row.diff_critic_findings || row.diff_critic_findings.trim() === "") continue;

    let findings: DiffCriticFinding[];
    try {
      findings = parseFindings(row.diff_critic_findings);
    } catch {
      continue; // skip malformed records
    }
    if (findings.length === 0) continue;

    const status = row.status as PlanStateStatus;
    const labels: CalibrationLabel[] = findings.map((f) => {
      const label = inferLabel(status, f.severity);
      if (label === "tp") tp++;
      else if (label === "fp") fp++;
      else unlabeled++;
      return { planId: row.plan_id, finding: f, label, planStatus: status };
    });

    samples.push({
      planId: row.plan_id,
      status,
      totalFindings: findings.length,
      labels,
    });
  }

  return {
    samples,
    labelCounts: { truePositive: tp, falsePositive: fp, unlabeled },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Serialize a CalibrationDataset to a pretty-printed JSON string.
 * Useful for writing calibration data to disk for manual review.
 */
export function serializeCalibrationDataset(dataset: CalibrationDataset): string {
  return JSON.stringify(dataset, null, 2);
}
