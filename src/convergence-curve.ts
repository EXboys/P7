/**
 * Self-play convergence curve extraction.
 *
 * Transforms raw self-play log entries into a processed {@link ConvergenceCurve}
 * — a chronologically ordered time-series of rounds enriched with pre-computed
 * convergence metrics (rule entropy, FPR trend drift, coverage stability).
 *
 * ## Usage
 *
 * ```ts
 * import { extractConvergenceCurve } from "./convergence-curve.ts";
 *
 * const curve = extractConvergenceCurve(logEntries);
 * // curve.rounds[i].metrics.ruleEntropy.normalizedEntropy
 * ```
 *
 * ## Curve semantics
 *
 * - Each round's metrics are computed from the *cumulative* rule state at that
 *   round, so trend lines reflect the full iteration history rather than
 *   per-round deltas.
 * - The baseline FPR used for drift computation can be provided explicitly or
 *   will default to the pooled FPR of the earliest entry.
 * - Rounds are sorted by `round` ascending regardless of input order.
 *
 * @module convergence-curve
 */
import type { SelfPlayLogEntry, SelfPlayRound, ConvergenceCurve } from "./types.ts";
import {
  computeRuleEntropy,
  computeFprTrendDrift,
  computeCoverageStability,
} from "./convergence-metrics.ts";

/**
 * Baseline FPR used when no explicit baseline is provided and no entry has
 * a non-undefined `baselineFpr` field.
 */
const FALLBACK_BASELINE_FPR = 0.05;

/**
 * Resolve the effective baseline FPR from available sources.
 *
 * Priority:
 * 1. Explicit `baselineFpr` parameter (caller-provided)
 * 2. First entry's `baselineFpr` field (if non-undefined)
 * 3. Pooled FPR of the earliest entry (computed from its rules)
 * 4. Fallback constant {@linkcode FALLBACK_BASELINE_FPR}
 */
function resolveBaselineFpr(
  entries: SelfPlayLogEntry[],
  explicitBaseline: number | undefined,
): number {
  if (explicitBaseline !== undefined) return explicitBaseline;

  const sorted = [...entries].sort((a, b) => a.round - b.round);
  const first = sorted[0];
  if (first && first.baselineFpr !== undefined) return first.baselineFpr;

  if (first && first.rules.length > 0) {
    const totalHits = first.rules.reduce((s, r) => s + r.hitCount, 0);
    const totalFp = first.rules.reduce((s, r) => s + r.falsePositiveCount, 0);
    if (totalHits > 0) return totalFp / totalHits;
  }

  return FALLBACK_BASELINE_FPR;
}

/**
 * Compute convergence metrics for a single round.
 *
 * Wraps the three independent metric computations (entropy, drift, stability)
 * into one call, attaching a `computedAt` timestamp for traceability.
 *
 * @param rules  - Dynamic rules snapshot at this round
 * @param baselineFpr - Baseline FPR for drift calculation
 * @returns Composite convergence metrics with timestamp
 */
function computeRoundMetrics(
  rules: SelfPlayLogEntry["rules"],
  baselineFpr: number,
): SelfPlayRound["metrics"] {
  return {
    ruleEntropy: computeRuleEntropy(rules),
    fprTrendDrift: computeFprTrendDrift(rules, baselineFpr),
    coverageStability: computeCoverageStability(rules),
    computedAt: new Date().toISOString(),
  };
}

/**
 * Extract a {@link ConvergenceCurve} from raw self-play log entries.
 *
 * Processes each entry into a {@link SelfPlayRound} by computing convergence
 * metrics from its rules snapshot. The result is a chronologically ordered
 * time-series suitable for trend analysis and chart rendering.
 *
 * @param entries - Raw self-play log entries (one per iteration round)
 * @param baselineFpr - Optional baseline FPR for drift detection.
 *  When omitted, the function resolves it from the earliest entry's data.
 * @returns Processed convergence curve with pre-computed per-round metrics
 *
 * @throws {RangeError} If `entries` is empty — a curve must have at least
 *  one round.
 */
export function extractConvergenceCurve(
  entries: SelfPlayLogEntry[],
  baselineFpr?: number,
): ConvergenceCurve {
  if (entries.length === 0) {
    throw new RangeError("extractConvergenceCurve: entries must not be empty");
  }

  const baseline = resolveBaselineFpr(entries, baselineFpr);

  // Sort by round ascending to ensure chronological order
  const sorted = [...entries].sort((a, b) => a.round - b.round);

  const rounds: SelfPlayRound[] = sorted.map((entry) => ({
    round: entry.round,
    rules: entry.rules,
    metrics: computeRoundMetrics(entry.rules, baseline),
    recordedAt: entry.recordedAt,
  }));

  return {
    rounds,
    totalRounds: rounds.length,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Convenience: extract the rule-entropy trend line from a curve as a flat
 * array of `{ round, normalizedEntropy }` tuples for chart libraries.
 *
 * @param curve - Processed convergence curve
 * @returns Flattened entropy trend data points
 */
export function entropyTrendLine(
  curve: ConvergenceCurve,
): Array<{ round: number; normalizedEntropy: number; rawEntropy: number }> {
  return curve.rounds.map((r) => ({
    round: r.round,
    normalizedEntropy: r.metrics.ruleEntropy.normalizedEntropy,
    rawEntropy: r.metrics.ruleEntropy.entropy,
  }));
}

/**
 * Convenience: extract the FPR drift trend line from a curve as a flat
 * array of `{ round, drift, isDrifting }` tuples for chart libraries.
 *
 * @param curve - Processed convergence curve
 * @returns Flattened FPR drift trend data points
 */
export function fprDriftTrendLine(
  curve: ConvergenceCurve,
): Array<{ round: number; drift: number; isDrifting: boolean }> {
  return curve.rounds.map((r) => ({
    round: r.round,
    drift: r.metrics.fprTrendDrift.drift,
    isDrifting: r.metrics.fprTrendDrift.isDrifting,
  }));
}

/**
 * Convenience: extract the coverage CV trend line from a curve as a flat
 * array of `{ round, cv, isUnstable }` tuples for chart libraries.
 *
 * @param curve - Processed convergence curve
 * @returns Flattened coverage CV trend data points
 */
export function coverageCvTrendLine(
  curve: ConvergenceCurve,
): Array<{ round: number; cv: number; isUnstable: boolean }> {
  return curve.rounds.map((r) => ({
    round: r.round,
    cv: r.metrics.coverageStability.coefficientOfVariation,
    isUnstable: r.metrics.coverageStability.isUnstable,
  }));
}
