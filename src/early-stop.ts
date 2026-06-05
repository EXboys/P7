/**
 * Early stop trigger for convergence plateau detection.
 *
 * Monitors the convergence curve across successive evaluation calls and fires
 * when all three metrics (rule entropy, FPR drift, coverage CV) remain flat
 * (|slope| < ε) for a configurable number of consecutive rounds.
 *
 * ## Usage
 *
 * ```ts
 * import { evaluateEarlyStop, resetEarlyStopState } from "./early-stop.ts";
 *
 * const decision = evaluateEarlyStop(curve);
 * if (decision.shouldStop) {
 *   // freeze rule set at round decision.frozenVersion
 * }
 *
 * // Reset between iteration runs
 * resetEarlyStopState();
 * ```
 *
 * ## Statefulness
 *
 * The trigger maintains an in-memory plateau counter that persists across calls.
 * This counter increments when all three metrics converge in a single evaluation,
 * and resets to 0 whenever any metric deviates from convergence. The counter
 * is lost on process restart — callers should treat early stop as a best-effort
 * optimisation rather than a hard guarantee.
 *
 * @module early-stop
 */
import type {
  ConvergenceCurve,
  ConvergenceTrendAnalysis,
  EarlyStopConfig,
  EarlyStopDecision,
} from "./types.ts";
import { analyzeConvergenceTrend } from "./convergence-trend.ts";

// ── Default configuration ──

/**
 * Default early stop configuration.
 *
 * - `slopeEpsilon`: 0.01 — matches TrendAnalysisConfig.slopeEpsilon
 * - `plateauRounds`: 5 — require 5 consecutive rounds of flat metrics
 * - `minRounds`: 10 — require at least 10 total rounds before triggering
 */
export const DEFAULT_EARLY_STOP_CONFIG: EarlyStopConfig = {
  slopeEpsilon: 0.01,
  plateauRounds: 5,
  minRounds: 10,
};

// ── In-memory plateau state ──

/**
 * Persistent plateau round counter across evaluateEarlyStop() calls.
 * Incremented each round when all three metrics converge; reset to 0
 * when any metric diverges or oscillates.
 */
let plateauCounter = 0;

/**
 * The round index at which the current plateau streak began.
 * Used for diagnostics. Reset alongside plateauCounter.
 */
let plateauStartRound = 0;

// ── Configuration clamping ──

/**
 * Clamp configuration values to valid, safe ranges.
 *
 * Rules applied:
 * - `slopeEpsilon`: clamped to [0.0001, 1.0]; non-positive values fall back
 *   to the default 0.01
 * - `plateauRounds`: clamped to [1, 100]; non-positive values fall back
 *   to the default 5
 * - `minRounds`: clamped to [1, 200]; non-positive values fall back to the
 *   default 10; also enforces `minRounds >= plateauRounds` to prevent
 *   impossible trigger conditions
 *
 * @param config - Input config (may be partial; undefined fields get defaults)
 * @returns Validated and clamped configuration
 */
function clampConfig(config: Partial<EarlyStopConfig> = {}): EarlyStopConfig {
  const slopeEpsilon =
    config.slopeEpsilon !== undefined && config.slopeEpsilon > 0
      ? Math.max(0.0001, Math.min(1.0, config.slopeEpsilon))
      : DEFAULT_EARLY_STOP_CONFIG.slopeEpsilon;

  const plateauRounds =
    config.plateauRounds !== undefined && config.plateauRounds > 0
      ? Math.max(1, Math.min(100, Math.round(config.plateauRounds)))
      : DEFAULT_EARLY_STOP_CONFIG.plateauRounds;

  const minRounds = Math.max(
    plateauRounds, // minRounds must be at least plateauRounds
    config.minRounds !== undefined && config.minRounds > 0
      ? Math.max(1, Math.min(200, Math.round(config.minRounds)))
      : DEFAULT_EARLY_STOP_CONFIG.minRounds,
  );

  return { slopeEpsilon, plateauRounds, minRounds };
}

// ── Metric convergence check ──

/**
 * Check whether all three convergence metrics are classified as "converging"
 * in the given trend analysis, using the configured slope epsilon.
 *
 * A metric is considered converging when:
 * 1. Its `direction` is `"converging"`
 * 2. Its `|slope|` is strictly less than `config.slopeEpsilon`
 *
 * Both conditions must hold because the trend analysis may classify a metric as
 * converging based on its own thresholds (rSquaredFloor, oscillationSignChanges);
 * the second condition re-validates against the early stop's own epsilon for
 * consistency.
 *
 * @param analysis - Trend analysis from `analyzeConvergenceTrend()`
 * @param config - Early stop config (used for slopeEpsilon)
 * @returns True only when all three metrics are flat and stable
 */
function allMetricsConverging(
  analysis: ConvergenceTrendAnalysis,
  config: EarlyStopConfig,
): boolean {
  const metrics = [
    { name: "normalizedEntropy", trend: analysis.entropyTrend },
    { name: "fprDrift", trend: analysis.fprDriftTrend },
    { name: "coverageCv", trend: analysis.coverageCvTrend },
  ];

  return metrics.every(
    ({ trend }) =>
      trend.direction === "converging" &&
      Math.abs(trend.slope) < config.slopeEpsilon,
  );
}

// ── Public API ──

/**
 * Evaluate whether the convergence curve has entered a plateau warranting
 * early stop.
 *
 * **Evaluation flow:**
 * 1. Validate the curve is non-empty (throws `RangeError` otherwise).
 * 2. Clamp the config to valid ranges via {@linkcode clampConfig}.
 * 3. Run {@linkcode analyzeConvergenceTrend} on the full curve.
 * 4. If `curve.rounds.length < minRounds`, return `shouldStop: false` with
 *    a descriptive reason — plateau detection is deferred.
 * 5. Check whether all three metrics converge (flat slope + converging
 *    classification) via {@linkcode allMetricsConverging}.
 * 6. If yes → increment the plateau counter; track the start round.
 * 7. If no → reset the plateau counter to 0.
 * 8. If plateau counter >= plateauRounds → return `shouldStop: true` with
 *    the current iteration round as `frozenVersion`.
 *
 * @param curve - Processed convergence curve (must have at least 1 round)
 * @param config - Partial config overrides (omit for defaults)
 * @returns Early stop decision with rationale, plateau duration, and trend analysis
 *
 * @throws {RangeError} If `curve.rounds` is empty — a curve with zero rounds
 *  cannot be evaluated for plateau detection.
 */
export function evaluateEarlyStop(
  curve: ConvergenceCurve,
  config: Partial<EarlyStopConfig> = {},
): EarlyStopDecision {
  if (curve.rounds.length === 0) {
    throw new RangeError(
      "evaluateEarlyStop: curve.rounds must not be empty",
    );
  }

  const effectiveConfig = clampConfig(config);
  const now = new Date().toISOString();

  // Run trend analysis first (required for the EarlyStopDecision return type
  // and for diagnostic information even when minRounds pre-check prevents
  // actual plateau evaluation).
  const trendAnalysis = analyzeConvergenceTrend(curve);

  // ── Step 1: minRounds pre-check ──
  // Skip plateau detection entirely until enough rounds have accumulated.
  if (curve.rounds.length < effectiveConfig.minRounds) {
    return {
      shouldStop: false,
      reason:
        `Insufficient rounds: ${curve.rounds.length} < minRounds ` +
        `(${effectiveConfig.minRounds}). Early stop requires at least ` +
        `${effectiveConfig.minRounds} rounds before evaluation.`,
      plateauDuration: 0,
      frozenVersion: null,
      triggeredAt: now,
      trendAnalysis,
    };
  }

  // ── Step 2: All-three-metrics convergence check ──
  const metricsConverging = allMetricsConverging(
    trendAnalysis,
    effectiveConfig,
  );

  if (metricsConverging) {
    // Track the start of the plateau if this is a new streak
    if (plateauCounter === 0) {
      plateauStartRound = curve.rounds.length - 1;
    }
    plateauCounter++;
  } else {
    // At least one metric has deviated from convergence; reset the counter
    plateauCounter = 0;
    plateauStartRound = 0;
  }

  const plateauDuration = plateauCounter;

  // ── Step 3: Check against plateauRounds threshold ──
  if (plateauDuration >= effectiveConfig.plateauRounds) {
    const frozenVersion = curve.rounds[curve.rounds.length - 1].round;
    return {
      shouldStop: true,
      reason:
        `Convergence plateau sustained for ${plateauDuration} rounds ` +
        `(threshold: ${effectiveConfig.plateauRounds}). ` +
        `All three metrics (normalizedEntropy, fprDrift, coverageCv) are ` +
        `flat (|slope| < ${effectiveConfig.slopeEpsilon}). ` +
        `Frozen at round ${frozenVersion}.`,
      plateauDuration,
      frozenVersion,
      triggeredAt: now,
      trendAnalysis,
    };
  }

  // ── Step 4: Not yet plateaued — explain why ──
  const nonConvergingMetrics = [
    { name: "normalizedEntropy", trend: trendAnalysis.entropyTrend },
    { name: "fprDrift", trend: trendAnalysis.fprDriftTrend },
    { name: "coverageCv", trend: trendAnalysis.coverageCvTrend },
  ]
    .filter(({ trend }) => trend.direction !== "converging")
    .map(
      ({ name, trend }) =>
        `${name}(${trend.direction}, slope=${trend.slope.toFixed(4)})`,
    );

  const convergenceStatus =
    nonConvergingMetrics.length > 0
      ? `Non-converging metrics: [${nonConvergingMetrics.join(", ")}]`
      : `All metrics converging but plateau duration (${plateauDuration}) ` +
        `< plateauRounds (${effectiveConfig.plateauRounds})`;

  return {
    shouldStop: false,
    reason:
      `Plateau not reached. ${convergenceStatus}. ` +
      `Plateau rounds accrued: ${plateauDuration}/${effectiveConfig.plateauRounds}.`,
    plateauDuration,
    frozenVersion: null,
    triggeredAt: now,
    trendAnalysis,
  };
}

/**
 * Reset the in-memory early stop plateau counter and start-round tracker.
 *
 * Call this between iteration runs (e.g., when a new self-play loop starts)
 * to prevent stale plateau state from a previous run influencing the new one.
 * Also call this when the iteration configuration changes significantly enough
 * that a fresh plateau evaluation window is warranted.
 */
export function resetEarlyStopState(): void {
  plateauCounter = 0;
  plateauStartRound = 0;
}

/**
 * Get the current plateau counter value without triggering a full evaluation.
 *
 * Useful for diagnostics, dashboard display of early-stop readiness, or
 * pre-checking whether the system is approaching a stop condition before
 * committing to a full trend analysis. Returns the number of consecutive
 * rounds the plateau condition has been sustained (or 0 if no plateau is
 * currently active).
 */
export function getPlateauCounter(): number {
  return plateauCounter;
}
