/**
 * Convergence metrics for the dynamic_rules self-iteration loop.
 *
 * Three quantitative indicators for validating iteration convergence:
 *
 * 1. **Rule Entropy** — Shannon entropy of rule distribution across
 *    critic dimensions. Measures fragmentation vs concentration.
 * 2. **FPR Trend Drift** — Pooled false-positive rate vs baseline drift.
 *    Detects rule effectiveness decay.
 * 3. **Coverage Stability** — Coefficient of variation across per-dimension
 *    rule counts. Measures balance / over-fitting risk.
 *
 * ## Integration
 *
 * Compute all three metrics via {@linkcode computeAllMetrics}, then persist
 * the result as a time-series row via `recordConvergenceSnapshot` in
 * `state.ts`. Query historical trends with `listConvergenceSnapshots`
 * (time-window slicing) or `listConvergenceSnapshotsByIteration`
 * (iteration-round slicing).
 *
 * @module convergence-metrics
 */

import type {
  DynamicRule,
  RuleEntropyMetric,
  FprTrendDriftMetric,
  CoverageStabilityMetric,
  ConvergenceMetrics,
  AdaptiveTriggerConfig,
  TriggerAction,
  TriggerDecision,
} from "./types.ts";

/**
 * Compute Shannon entropy of rule distribution across critic dimensions.
 *
 * Uses `H = -Σ(pᵢ × log₂(pᵢ))` where `pᵢ` is the proportion of rules
 * in dimension `i`.
 *
 * - Lower entropy → rules concentrated in few dimensions (converging)
 * - Higher entropy → rules spread across many dimensions (exploring)
 * - `normalizedEntropy` (0–1) normalises by theoretical maximum for the
 *   observed dimension count.
 *
 * @param rules - Current dynamic rules to analyse
 * @returns Entropy metric with raw, max, and normalised values
 */
export function computeRuleEntropy(rules: DynamicRule[]): RuleEntropyMetric {
  const dimCounts = new Map<string, number>();
  for (const r of rules) {
    dimCounts.set(r.dimension, (dimCounts.get(r.dimension) ?? 0) + 1);
  }
  const dimensionCount = dimCounts.size;
  const total = rules.length;

  if (total === 0 || dimensionCount === 0) {
    return { entropy: 0, maxEntropy: 0, normalizedEntropy: 0, dimensionCount: 0 };
  }

  let entropy = 0;
  for (const count of dimCounts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  const maxEntropy = Math.log2(dimensionCount);
  const normalizedEntropy = dimensionCount > 1 ? entropy / maxEntropy : 0;

  return { entropy, maxEntropy, normalizedEntropy, dimensionCount };
}

/**
 * Compute pooled false-positive rate drift against a baseline.
 *
 * Aggregates all rules' hit/false-positive counts to derive a pooled
 * current FPR, then compares it to the supplied baseline.
 *
 * - Positive drift (`currentFpr > baselineFpr`) signals degradation
 * - `isDrifting` triggers when drift exceeds the configurable threshold
 *
 * @param rules - Current window of dynamic rules
 * @param baselineFpr - Baseline false-positive rate (0–1)
 * @param driftThreshold - Threshold above which drift is flagged (default 0.05)
 * @returns FPR drift metric with baseline, current, drift, and alert flag
 */
export function computeFprTrendDrift(
  rules: DynamicRule[],
  baselineFpr: number,
  driftThreshold = 0.05,
): FprTrendDriftMetric {
  const totalHits = rules.reduce((s, r) => s + r.hitCount, 0);
  const totalFp = rules.reduce((s, r) => s + r.falsePositiveCount, 0);
  const currentFpr = totalHits > 0 ? totalFp / totalHits : 0;
  const drift = currentFpr - baselineFpr;
  const isDrifting = drift > driftThreshold;

  return { baselineFpr, currentFpr, drift, driftThreshold, isDrifting };
}

/**
 * Compute coefficient of variation (CV) across per-dimension rule counts.
 *
 * CV = σ / μ, where σ is the population standard deviation and μ is the
 * mean of rule counts per dimension.
 *
 * - Lower CV → balanced coverage across dimensions
 * - Higher CV → one or a few dimensions dominate (over-fitting / blind spots)
 * - `isUnstable` triggers when CV exceeds the configurable threshold
 *
 * @param rules - Current dynamic rules
 * @param cvThreshold - CV above this flags instability (default 0.5)
 * @returns Coverage stability metric with mean, σ, CV, and alert flag
 */
export function computeCoverageStability(
  rules: DynamicRule[],
  cvThreshold = 0.5,
): CoverageStabilityMetric {
  const dimCounts = new Map<string, number>();
  for (const r of rules) {
    dimCounts.set(r.dimension, (dimCounts.get(r.dimension) ?? 0) + 1);
  }
  const dimensionCount = dimCounts.size;
  const counts = [...dimCounts.values()];

  if (dimensionCount === 0) {
    return {
      mean: 0,
      standardDeviation: 0,
      coefficientOfVariation: 0,
      dimensionCount: 0,
      cvThreshold,
      isUnstable: false,
    };
  }

  const mean = counts.reduce((s, c) => s + c, 0) / dimensionCount;
  const variance = counts.reduce((s, c) => s + (c - mean) ** 2, 0) / dimensionCount;
  const standardDeviation = Math.sqrt(variance);
  const coefficientOfVariation = mean > 0 ? standardDeviation / mean : 0;
  const isUnstable = coefficientOfVariation > cvThreshold;

  return {
    mean,
    standardDeviation,
    coefficientOfVariation,
    dimensionCount,
    cvThreshold,
    isUnstable,
  };
}

/**
 * Aggregator: compute all three convergence metrics in a single call.
 *
 * Convenience wrapper that timestamps the result with the current UTC
 * time for traceability in the auto-iteration supervisor.
 *
 * @param rules - Current dynamic rules
 * @param baselineFpr - Baseline false-positive rate for drift comparison
 * @param driftThreshold - FPR drift threshold (default 0.05)
 * @param cvThreshold - Coverage CV threshold (default 0.5)
 * @returns Aggregated convergence metrics with timestamp
 */
export function computeAllMetrics(
  rules: DynamicRule[],
  baselineFpr: number,
  driftThreshold = 0.05,
  cvThreshold = 0.5,
): ConvergenceMetrics {
  return {
    ruleEntropy: computeRuleEntropy(rules),
    fprTrendDrift: computeFprTrendDrift(rules, baselineFpr, driftThreshold),
    coverageStability: computeCoverageStability(rules, cvThreshold),
    computedAt: new Date().toISOString(),
  };
}

/**
 * Default adaptive trigger thresholds.
 *
 * These are initial heuristics that MUST be empirically tuned via the
 * convergence observability panel once production data is available.
 *
 * - `entropyLow`: 0.3  — below this, rules are concentrated enough to converge
 * - `entropyHigh`: 0.7 — above this, rules are too fragmented, need consolidation
 * - `fprDriftAlert`: 0.03  — above this triggers alert, signaling potential degradation
 * - `fprDriftRollback`: 0.10 — above this triggers automatic rollback
 * - `cvAlert`: 0.5  — above this triggers imbalance alert
 * - `cvRollback`: 0.8 — above this triggers automatic rollback
 */
export const DEFAULT_TRIGGER_CONFIG: AdaptiveTriggerConfig = {
  entropyLow: 0.3,
  entropyHigh: 0.7,
  fprDriftAlert: 0.03,
  fprDriftRollback: 0.10,
  cvAlert: 0.5,
  cvRollback: 0.8,
};

/**
 * Classify normalised entropy into low / medium / high buckets.
 *
 * - **low** (→ converge): `normalizedEntropy < entropyLow`
 *   Rules are concentrated in a few dimensions; iteration is converging.
 * - **medium** (→ explore): `entropyLow ≤ normalizedEntropy < entropyHigh`
 *   Rules are moderately spread; still in exploration phase.
 * - **high** (→ consolidate): `normalizedEntropy ≥ entropyHigh`
 *   Rules are highly fragmented; consolidation is needed before further iteration.
 */
function classifyEntropyLevel(
  normalizedEntropy: number,
  entropyLow: number,
  entropyHigh: number,
): "low" | "medium" | "high" {
  if (normalizedEntropy >= entropyHigh) return "high";
  if (normalizedEntropy >= entropyLow) return "medium";
  return "low";
}

/**
 * Evaluate the joint decision matrix and produce a lifecycle action.
 *
 * The matrix combines three indicators — rule entropy, FPR trend drift,
 * and coverage stability CV — against configurable thresholds, using
 * a deterministic priority cascade:
 *
 * 1. **rollback** — FPR drift ≥ `fprDriftRollback` **or** CV ≥ `cvRollback`
 *    (rule effectiveness has degraded or coverage is severely imbalanced)
 * 2. **freeze** — entropy is **high** (≥ entropyHigh) — fragmentation too large
 *    **or** entropy is medium **and** CV ≥ cvAlert
 *    (consolidation required before next iteration)
 * 3. **alert** — FPR drift ≥ `fprDriftAlert`, **or** entropy is medium,
 *    **or** CV ≥ cvAlert
 *    (notify operator but allow iteration to continue)
 * 4. **continue** — all indicators within normal bounds
 *
 * @param metrics - Pre-computed convergence metrics snapshot
 * @param config  - Threshold configuration (omit for defaults)
 * @returns Decision result with action, triggered-by labels, and snapshot
 */
export function evaluateAdaptiveTrigger(
  metrics: ConvergenceMetrics,
  config: AdaptiveTriggerConfig = DEFAULT_TRIGGER_CONFIG,
): TriggerDecision {
  const triggeredBy: string[] = [];
  const { ruleEntropy, fprTrendDrift, coverageStability } = metrics;

  const entropyLevel = classifyEntropyLevel(
    ruleEntropy.normalizedEntropy,
    config.entropyLow,
    config.entropyHigh,
  );

  let action: TriggerAction;

  // ── Priority 1: rollback (irreversible degradation) ──
  if (fprTrendDrift.drift >= config.fprDriftRollback) {
    action = "rollback";
    triggeredBy.push("fprTrendDrift");
  } else if (coverageStability.coefficientOfVariation >= config.cvRollback) {
    action = "rollback";
    triggeredBy.push("coverageStability");
  }

  // ── Priority 2: freeze (needs consolidation) ──
  else if (entropyLevel === "high") {
    action = "freeze";
    triggeredBy.push("ruleEntropy");
  } else if (
    entropyLevel === "medium" &&
    coverageStability.coefficientOfVariation >= config.cvAlert
  ) {
    action = "freeze";
    triggeredBy.push("ruleEntropy", "coverageStability");
  }

  // ── Priority 3: alert (monitor-worthy but not blocking) ──
  else if (fprTrendDrift.drift >= config.fprDriftAlert) {
    action = "alert";
    triggeredBy.push("fprTrendDrift");
  } else if (entropyLevel === "medium") {
    action = "alert";
    triggeredBy.push("ruleEntropy");
  } else if (coverageStability.coefficientOfVariation >= config.cvAlert) {
    action = "alert";
    triggeredBy.push("coverageStability");
  }

  // ── Priority 4: continue (all clear) ──
  else {
    action = "continue";
  }

  return { action, triggeredBy, convergenceMetrics: metrics, config };
}
