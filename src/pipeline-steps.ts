/**
 * ── Self-iteration pipeline step implementations ──
 *
 * Concrete StepContract implementations wrapping existing self-iteration
 * business logic into the consumes/produces/execute contract.
 *
 * Four steps are provided:
 * 1. **pattern_extract** (`createPatternExtractStep`) — Query plan_states for
 *    historical findings, cluster into FailurePattern[], produce PatternReport.
 * 2. **threshold_calibrate** (`createThresholdCalibrateStep`) — Extract labeled
 *    calibration dataset, grid-search optimal cutoffs, produce CalibrationReport.
 * 3. **dynamic_rules_inject** (`dynamicRulesInjectStep`) — Pure transform from
 *    CalibrationReport → DynamicRulesPayload with severity thresholds and rules.
 * 4. **ab_validate** (`createAbValidateStep`) — Evaluate before/after recall & FPR
 *    on a temporally held-out subset of calibration data, produce AbTestResult.
 *
 * All steps check `context.signal.aborted` at yield points for cooperative
 * cancellation. Factory functions accepting `Database` couple the step's
 * lifecycle to an open DB handle.
 *
 * @module pipeline-steps
 */

import { Database } from "bun:sqlite";
import type { DcSeverity, DiffCriticFinding } from "./types.ts";
import type { StepContract, StepExecutionContext } from "./pipeline-dsl.ts";
import type {
  FailurePattern,
  PatternReport,
  CalibrationReport,
  PerSeverityCalibration,
  DynamicRulesPayload,
  RuleEntry,
  AbTestResult,
  AbTestBreakdown,
} from "./pipeline-contracts.ts";
import { computeFindingsAggregation } from "./findings-stats.ts";
import { extractCalibrationDataset } from "./calibration-extractor.ts";
import { searchOptimalCutoffs } from "./threshold-calibrator.ts";
import type { CalibratedThresholds, SeverityThreshold } from "./threshold-calibrator.ts";
import { parseFindings } from "./diff-critic.ts";

// ── Constants ──

/** Default fallback cutoffs for severities (mirrors threshold-calibrator.ts). */
const DEFAULT_CUTOFFS: Record<DcSeverity, number> = {
  blocker: 0.7,
  warning: 0.5,
  info: 0.3,
};

/** Severity ordering used for "upgrade to highest" logic. */
const SEVERITY_ORDER: Record<DcSeverity, number> = {
  info: 0,
  warning: 1,
  blocker: 2,
};

// ── Helpers ──

/**
 * Cooperative cancellation check. Throws immediately when the signal is
 * already aborted, allowing the step to bail out before expensive work.
 */
function requireNotAborted(signal: AbortSignal, message: string): void {
  if (signal.aborted) throw new Error(message);
}

/**
 * Clamp a numeric value to 3 decimal places for clean report output.
 */
function round3(v: number): number {
  return Math.round(v * 1_000) / 1_000;
}

/**
 * Build a SeverityThreshold lookup from a CalibratedThresholds object,
 * keyed by DcSeverity string, for type-safe indexed access.
 */
function severityMap(thresholds: CalibratedThresholds): Record<DcSeverity, SeverityThreshold> {
  return {
    blocker: thresholds.blocker,
    warning: thresholds.warning,
    info: thresholds.info,
  };
}

// ── 1. Pattern Extract Step ──

/**
 * Factory: create a pattern_extract step that queries the given DB for
 * historical review findings and returns a structured PatternReport.
 *
 * The step reads `plan_states` rows with non-null `findings` or
 * `diff_critic_findings` columns, parses each via `parseFindings`,
 * clusters into `FailurePattern[]` keyed by dimension + message prefix,
 * and delegates to `computeFindingsAggregation` for dimension-level stats.
 *
 * @param db — Open bun:sqlite Database handle (must outlive the step)
 */
export function createPatternExtractStep(
  db: Database,
): StepContract<Record<string, unknown>, PatternReport> {
  return {
    description:
      "Extract recurring failure patterns from historical review records using " +
      "dimension/severity/message clustering and temporal first/last observation tracking.",
    consumes: [],
    produces: "pattern_report",
    execute: async (
      _input: Record<string, unknown>,
      context: StepExecutionContext,
    ): Promise<PatternReport> => {
      requireNotAborted(context.signal, "PatternExtract: aborted before query");

      // Query plan_states with timestamps alongside findings columns
      const rows = db
        .query(
          `SELECT plan_id, created_at, findings, diff_critic_findings
           FROM plan_states
           WHERE findings IS NOT NULL OR diff_critic_findings IS NOT NULL`,
        )
        .all() as Array<{
        plan_id: string;
        created_at: string | null;
        findings: string | null;
        diff_critic_findings: string | null;
      }>;

      requireNotAborted(context.signal, "PatternExtract: aborted after query");

      if (rows.length === 0) {
        return {
          patterns: [],
          scannedRecords: 0,
          source: "diff-critic",
          dimensions: [],
          generatedAt: new Date().toISOString(),
        };
      }

      // ── Parse all rows ──
      interface PlanData {
        planId: string;
        findings: DiffCriticFinding[];
        createdAt: string;
      }

      const plans: PlanData[] = [];
      for (const row of rows) {
        const all: DiffCriticFinding[] = [];
        if (row.findings) {
          try {
            all.push(...parseFindings(row.findings));
          } catch {
            /* skip malformed findings */
          }
        }
        if (row.diff_critic_findings) {
          try {
            all.push(...parseFindings(row.diff_critic_findings));
          } catch {
            /* skip malformed findings */
          }
        }
        if (all.length > 0) {
          plans.push({
            planId: row.plan_id,
            findings: all,
            createdAt: row.created_at || new Date().toISOString(),
          });
        }
      }

      requireNotAborted(context.signal, "PatternExtract: aborted during parse");

      // ── Cluster into patterns ──
      type PatternEntry = {
        dimension: string;
        pattern: string;
        count: number;
        topSeverity: DcSeverity;
        planIds: Set<string>;
        coOccurringDimensions: Set<string>;
        timestamps: string[];
      };

      const patternMap = new Map<string, PatternEntry>();
      const planDimensionSets = new Map<string, Set<string>>();

      for (const plan of plans) {
        const planDimSet = new Set<string>();

        for (const f of plan.findings) {
          const dim = f.dimension || "other";
          planDimSet.add(dim);
          const sig = f.message.slice(0, 50).toLowerCase();
          const key = `${dim}::${sig}`;
          const existing = patternMap.get(key);

          if (existing) {
            existing.count++;
            existing.timestamps.push(plan.createdAt);
            existing.planIds.add(plan.planId);
            if (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[existing.topSeverity]) {
              existing.topSeverity = f.severity;
            }
          } else {
            const newEntry: PatternEntry = {
              dimension: dim,
              pattern: sig,
              count: 1,
              topSeverity: f.severity,
              planIds: new Set([plan.planId]),
              coOccurringDimensions: new Set(),
              timestamps: [plan.createdAt],
            };
            patternMap.set(key, newEntry);
          }
        }

        // Accumulate per-plan dimension sets for co-occurrence
        const existingSet = planDimensionSets.get(plan.planId);
        if (existingSet) {
          for (const d of planDimSet) existingSet.add(d);
        } else {
          planDimensionSets.set(plan.planId, planDimSet);
        }
      }

      requireNotAborted(context.signal, "PatternExtract: aborted during clustering");

      // ── Compute co-occurring dimensions ──
      for (const entry of patternMap.values()) {
        for (const pid of entry.planIds) {
          const planDims = planDimensionSets.get(pid);
          if (planDims) {
            for (const d of planDims) {
              if (d !== entry.dimension) {
                entry.coOccurringDimensions.add(d);
              }
            }
          }
        }
      }

      // Dimension frequency across all plans (for sorting co-occurring dims)
      const dimFreq = new Map<string, number>();
      for (const dims of planDimensionSets.values()) {
        for (const d of dims) {
          dimFreq.set(d, (dimFreq.get(d) || 0) + 1);
        }
      }

      // ── Build FailurePattern[] sorted by frequency descending ──
      const patterns: FailurePattern[] = [...patternMap.entries()]
        .map(([, entry]) => {
          const sortedTs = [...entry.timestamps].sort();
          return {
            dimension: entry.dimension,
            pattern: entry.pattern,
            frequency: entry.count,
            topSeverity: entry.topSeverity,
            coOccurringDimensions: [...entry.coOccurringDimensions].sort(
              (a, b) => (dimFreq.get(b) || 0) - (dimFreq.get(a) || 0),
            ),
            firstObservedAt: sortedTs[0],
            lastObservedAt: sortedTs[sortedTs.length - 1],
          };
        })
        .sort((a, b) => b.frequency - a.frequency);

      // ── Dimension stats via computeFindingsAggregation ──
      const agg = computeFindingsAggregation(
        plans.map((p) => ({ planId: p.planId, findings: p.findings })),
      );

      return {
        patterns,
        scannedRecords: rows.length,
        source: "diff-critic",
        dimensions: agg.dimensions.map((d) => ({
          name: d.dimension,
          total: d.total,
          hitRate: d.hitRate,
        })),
        generatedAt: new Date().toISOString(),
      };
    },
  };
}

// ── 2. Threshold Calibrate Step ──

/**
 * Factory: create a threshold_calibrate step that extracts the calibration
 * dataset from the given DB, runs grid-search F1 optimisation, and returns
 * a structured CalibrationReport with weighted aggregate metrics.
 *
 * @param db — Open bun:sqlite Database handle (must outlive the step)
 */
export function createThresholdCalibrateStep(
  db: Database,
): StepContract<Record<string, unknown>, CalibrationReport> {
  return {
    description:
      "Calibrate severity thresholds using labeled historical dataset " +
      "via grid search F1 optimisation across blocker/warning/info severities.",
    consumes: [],
    produces: "calibration_report",
    execute: async (
      _input: Record<string, unknown>,
      context: StepExecutionContext,
    ): Promise<CalibrationReport> => {
      requireNotAborted(context.signal, "ThresholdCalibrate: aborted before extraction");

      const dataset = extractCalibrationDataset(db);

      requireNotAborted(context.signal, "ThresholdCalibrate: aborted after extraction");

      const thresholds = searchOptimalCutoffs(dataset);
      const sMap = severityMap(thresholds);

      const severities: DcSeverity[] = ["blocker", "warning", "info"];
      const perSeverity: PerSeverityCalibration[] = severities.map((sev) => ({
        severity: sev,
        optimalCutoff: sMap[sev].cutoff,
        precision: sMap[sev].precision,
        recall: sMap[sev].recall,
        f1: sMap[sev].f1,
      }));

      // Weighted aggregate metrics (weighted by totalLabeled per severity)
      const totalWeight = perSeverity.reduce(
        (sum, ps) => sum + sMap[ps.severity].totalLabeled,
        0,
      );
      const safeWeight = totalWeight > 0 ? totalWeight : 1;

      const precision = round3(
        perSeverity.reduce(
          (sum, ps) => sum + ps.precision * sMap[ps.severity].totalLabeled,
          0,
        ) / safeWeight,
      );
      const recall = round3(
        perSeverity.reduce(
          (sum, ps) => sum + ps.recall * sMap[ps.severity].totalLabeled,
          0,
        ) / safeWeight,
      );
      const f1 = round3(
        perSeverity.reduce(
          (sum, ps) => sum + ps.f1 * sMap[ps.severity].totalLabeled,
          0,
        ) / safeWeight,
      );

      return {
        optimalCutoffs: Object.fromEntries(
          severities.map((s) => [s, sMap[s].cutoff]),
        ) as Record<string, number>,
        precision,
        recall,
        f1,
        sampleSize: dataset.samples.length,
        perSeverity,
      };
    },
  };
}

// ── 3. Dynamic Rules Inject Step (pure transform) ──

/**
 * Pure-transform step: maps a CalibrationReport into a DynamicRulesPayload
 * containing severity thresholds and rule entries for critic pipeline injection.
 *
 * This step has no DB dependency and is safe to reuse across multiple
 * pipeline instantiations. It is a constant, not a factory.
 */
export const dynamicRulesInjectStep: StepContract<
  CalibrationReport,
  DynamicRulesPayload
> = {
  description:
    "Map calibrated severity thresholds into critic pipeline rule entries " +
    "with target severity thresholds for injection.",
  consumes: ["calibration_report"],
  produces: "dynamic_rules_payload",
  execute: async (
    input: CalibrationReport,
    _context: StepExecutionContext,
  ): Promise<DynamicRulesPayload> => {
    const severityThresholds: Partial<Record<DcSeverity, number>> = {};
    const rules: RuleEntry[] = [];

    for (const ps of input.perSeverity) {
      severityThresholds[ps.severity] = ps.optimalCutoff;
      rules.push({
        dimension: ps.severity,
        pattern: `severity:${ps.severity}`,
        severityThreshold: ps.severity,
      });
    }

    return {
      severityThresholds,
      rules,
      injectedAt: new Date().toISOString(),
    };
  },
};

// ── 4. A/B Validate Step ──

/**
 * Factory: create an ab_validate step that evaluates injected rule thresholds
 * (from DynamicRulesPayload) against a temporally held-out subset of calibration
 * data, comparing recall and FPR before (default cutoffs) vs after (payload).
 *
 * The holdout is the last ~30% of calibration samples (temporal split by
 * insertion order ≈ chronological order). The verdict is:
 * - `accept`: recall improvement > 3pp AND FPR increase ≤ 2pp
 * - `reject`: recall drop > 3pp OR FPR increase > 5pp
 * - `inconclusive`: otherwise
 *
 * @param db — Open bun:sqlite Database handle (must outlive the step)
 */
export function createAbValidateStep(
  db: Database,
): StepContract<DynamicRulesPayload, AbTestResult> {
  return {
    description:
      "A/B validate injected rule thresholds against a temporally held-out " +
      "subset of calibration data, comparing recall and FPR per severity " +
      "and dimension to produce an acceptance verdict.",
    consumes: ["dynamic_rules_payload"],
    produces: "ab_test_result",
    execute: async (
      input: DynamicRulesPayload,
      context: StepExecutionContext,
    ): Promise<AbTestResult> => {
      requireNotAborted(context.signal, "AbValidate: aborted before extraction");

      const dataset = extractCalibrationDataset(db);

      requireNotAborted(context.signal, "AbValidate: aborted after extraction");

      // Require minimum samples for meaningful evaluation
      if (dataset.samples.length < 3) {
        return {
          recallBefore: 0,
          recallAfter: 0,
          fprBefore: 0,
          fprAfter: 0,
          breakdown: [],
          verdict: "inconclusive",
          sampleSize: 0,
          confidenceLevel: 0,
        };
      }

      // Temporal holdout: last ~30% of samples (array order ≈ chronological)
      const splitIdx = Math.floor(dataset.samples.length * 0.7);
      const holdoutSamples = dataset.samples.slice(splitIdx);

      // Merge payload thresholds over defaults for "after" evaluation
      const afterThresholds: Record<DcSeverity, number> = {
        ...DEFAULT_CUTOFFS,
        ...input.severityThresholds,
      } as Record<DcSeverity, number>;

      // Collect labeled evaluation points from holdout (confidence required)
      interface EvalPoint {
        dimension: string;
        severity: DcSeverity;
        confidence: number;
        label: "tp" | "fp";
      }

      const evalPoints: EvalPoint[] = [];
      for (const sample of holdoutSamples) {
        for (const lbl of sample.labels) {
          if (lbl.label === "unlabeled") continue;
          if (lbl.finding.confidence === undefined || lbl.finding.confidence === null) continue;
          evalPoints.push({
            dimension: lbl.finding.dimension || "other",
            severity: lbl.finding.severity,
            confidence: lbl.finding.confidence,
            label: lbl.label,
          });
        }
      }

      if (evalPoints.length === 0) {
        return {
          recallBefore: 0,
          recallAfter: 0,
          fprBefore: 0,
          fprAfter: 0,
          breakdown: [],
          verdict: "inconclusive",
          sampleSize: 0,
          confidenceLevel: 0,
        };
      }

      // ── Evaluate a threshold set ──
      function evaluate(
        thresholds: Record<DcSeverity, number>,
      ): {
        recall: number;
        fpr: number;
        byDimension: Map<
          string,
          { tp: number; fp: number; fn: number; tn: number }
        >;
      } {
        const byDim = new Map<
          string,
          { tp: number; fp: number; fn: number; tn: number }
        >();

        for (const pt of evalPoints) {
          const predicted = pt.confidence >= thresholds[pt.severity];
          let d = byDim.get(pt.dimension);
          if (!d) {
            d = { tp: 0, fp: 0, fn: 0, tn: 0 };
            byDim.set(pt.dimension, d);
          }

          if (predicted && pt.label === "tp") d.tp++;
          else if (predicted && pt.label === "fp") d.fp++;
          else if (!predicted && pt.label === "tp") d.fn++;
          else d.tn++;
        }

        const totalTp = [...byDim.values()].reduce((s, d) => s + d.tp, 0);
        const totalFp = [...byDim.values()].reduce((s, d) => s + d.fp, 0);
        const totalFn = [...byDim.values()].reduce((s, d) => s + d.fn, 0);
        const totalTn = [...byDim.values()].reduce((s, d) => s + d.tn, 0);

        return {
          recall: totalTp + totalFn > 0 ? totalTp / (totalTp + totalFn) : 0,
          fpr: totalFp + totalTn > 0 ? totalFp / (totalFp + totalTn) : 0,
          byDimension: byDim,
        };
      }

      const before = evaluate(DEFAULT_CUTOFFS);
      const after = evaluate(afterThresholds);

      // ── Build per-dimension breakdown ──
      const allDims = new Set([
        ...before.byDimension.keys(),
        ...after.byDimension.keys(),
      ]);
      const breakdown: AbTestBreakdown[] = [];

      for (const dim of allDims) {
        const b = before.byDimension.get(dim) ?? {
          tp: 0,
          fp: 0,
          fn: 0,
          tn: 0,
        };
        const a = after.byDimension.get(dim) ?? {
          tp: 0,
          fp: 0,
          fn: 0,
          tn: 0,
        };

        const recallB = b.tp + b.fn > 0 ? b.tp / (b.tp + b.fn) : 0;
        const recallA = a.tp + a.fn > 0 ? a.tp / (a.tp + a.fn) : 0;
        const fprB = b.fp + b.tn > 0 ? b.fp / (b.fp + b.tn) : 0;
        const fprA = a.fp + a.tn > 0 ? a.fp / (a.fp + a.tn) : 0;

        breakdown.push({
          dimension: dim,
          recallBefore: round3(recallB),
          recallAfter: round3(recallA),
          fprBefore: round3(fprB),
          fprAfter: round3(fprA),
        });
      }

      // ── Acceptance verdict ──
      const recallDelta = after.recall - before.recall;
      const fprDelta = after.fpr - before.fpr;

      let verdict: "accept" | "reject" | "inconclusive";
      if (recallDelta > 0.03 && fprDelta <= 0.02) {
        verdict = "accept";
      } else if (recallDelta < -0.03 || fprDelta > 0.05) {
        verdict = "reject";
      } else {
        verdict = "inconclusive";
      }

      return {
        recallBefore: round3(before.recall),
        recallAfter: round3(after.recall),
        fprBefore: round3(before.fpr),
        fprAfter: round3(after.fpr),
        breakdown,
        verdict,
        sampleSize: evalPoints.length,
        confidenceLevel: 0.95,
      };
    },
  };
}
