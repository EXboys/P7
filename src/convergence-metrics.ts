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
 * @module convergence-metrics
 */

import type {
  DynamicRule,
  RuleEntropyMetric,
  FprTrendDriftMetric,
  CoverageStabilityMetric,
  ConvergenceMetrics,
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
