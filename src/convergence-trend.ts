/**
 * Convergence trend analyser: sliding-window regression for iteration state.
 *
 * Applies Ordinary Least Squares linear regression on a sliding window of
 * per-round convergence metrics (normalised entropy, FPR drift, coverage CV)
 * to classify the self-play iteration loop state as one of:
 *
 * - **converging** — slope ≈ 0 with adequate fit; metric has stabilised
 * - **diverging** — |slope| > ε with adequate fit; metric is trending away
 * - **oscillating** — high sign-change frequency in consecutive deltas
 * - **insufficient_data** — too few points or poor fit for reliable classification
 *
 * ## Usage
 *
 * ```ts
 * import { analyzeConvergenceTrend } from "./convergence-trend.ts";
 *
 * const analysis = analyzeConvergenceTrend(curve);
 * // analysis.verdict → "converging" | "diverging" | "oscillating"
 * // analysis.entropyTrend.slope → per-round rate of change
 * ```
 *
 * ## Sliding-window semantics
 *
 * Only the most recent `config.windowSize` rounds are analysed, so the trend
 * reflects the **current trajectory** rather than full-history drift. This
 * aligns with the early-stop use case: detect plateau or divergence as soon
 * as it emerges, not after it has persisted across the entire run.
 *
 * @module convergence-trend
 */
import type {
  ConvergenceCurve,
  MetricTrend,
  ConvergenceTrendAnalysis,
  TrendDirection,
  TrendAnalysisConfig,
} from "./types.ts";

/**
 * Default trend analysis configuration.
 *
 * All values are initial heuristics subject to empirical tuning once
 * production convergence-curve data is available.
 *
 * - `windowSize`: 8 — analyse the most recent 8 rounds
 * - `slopeEpsilon`: 0.01 — absolute slope below this is considered flat
 * - `rSquaredFloor`: 0.6 — minimum R² to trust the linear fit
 * - `oscillationSignChanges`: 3 — minimum sign changes (over ~8 points) to
 *   classify as oscillating
 * - `minWindowSize`: 5 — refuse to analyse fewer than 5 data points
 */
export const DEFAULT_TREND_CONFIG: TrendAnalysisConfig = {
  windowSize: 8,
  slopeEpsilon: 0.01,
  rSquaredFloor: 0.6,
  oscillationSignChanges: 3,
  minWindowSize: 5,
};

/**
 * Ordinary Least Squares linear regression on an array of scalar values.
 *
 * The independent variable `x` is the array index ([0, 1, …, n-1]), so the
 * slope represents change **per round** across the window.
 *
 * Mathematical formulation:
 * ```
 * slope     = Σ((x_i - x̄)(y_i - ȳ)) / Σ((x_i - x̄)²)
 * intercept = ȳ - slope × x̄
 * R²        = 1 - SS_res / SS_tot
 * ```
 *
 * Edge cases:
 * - **Single unique value** (zero variance in y): slope = 0, intercept = y[0],
 *   R² = 1 (the constant model is a perfect fit).
 * - **Two data points**: the fit is exact (R² = 1).
 * - **NaN / Inf values**: not expected; caller must sanitise inputs.
 *
 * @param values - Metric values ordered chronologically (round 0 … round n-1)
 * @returns OLS result: slope, intercept, rSquared
 */
export function computeLinearRegression(values: number[]): {
  slope: number;
  intercept: number;
  rSquared: number;
} {
  const n = values.length;
  if (n === 0) return { slope: 0, intercept: 0, rSquared: 0 };

  // x is array index [0, 1, ..., n-1]
  const xMean = (n - 1) / 2; // arithmetic series: sum(0..n-1) = n(n-1)/2
  const yMean = values.reduce((s, v) => s + v, 0) / n;

  let num = 0; // Σ((x_i - x̄)(y_i - ȳ))
  let denX = 0; // Σ((x_i - x̄)²)
  let denY = 0; // Σ((y_i - ȳ)²)  — for R²

  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    const dy = values[i] - yMean;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  // ── Edge case: all y values identical (zero variance) ──
  if (denY === 0) {
    return { slope: 0, intercept: yMean, rSquared: 1 };
  }

  // ── Edge case: single point or zero x variance ──
  if (denX === 0) {
    return { slope: 0, intercept: yMean, rSquared: 0 };
  }

  const slope = num / denX;
  const intercept = yMean - slope * xMean;

  // R² = 1 - SS_res / SS_tot
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const yPred = slope * i + intercept;
    const residual = values[i] - yPred;
    ssRes += residual * residual;
  }
  const rSquared = 1 - ssRes / denY;

  return { slope, intercept, rSquared };
}

/**
 * Detect oscillation by counting sign changes in consecutive deltas.
 *
 * Oscillation is characterised by the metric alternating direction from
 * one round to the next. This function computes the first differences
 * (deltas between consecutive values) and counts how many times the
 * sign flips between adjacent deltas.
 *
 * A single outlier can cause one spurious sign change, so classification
 * requires at least `minSignChanges` net sign changes to rule out noise.
 *
 * @param values - Metric values ordered chronologically
 * @param minSignChanges - Minimum sign changes required to classify as
 *  oscillating (default 3)
 * @returns Oscillation detection result
 */
export function detectOscillation(
  values: number[],
  minSignChanges = 3,
): { isOscillating: boolean; signChangeCount: number; signChangeRate: number } {
  const n = values.length;

  // Need at least 3 points to have a delta pair
  if (n < 3) {
    return { isOscillating: false, signChangeCount: 0, signChangeRate: 0 };
  }

  // First differences
  const deltas: number[] = [];
  for (let i = 1; i < n; i++) {
    deltas.push(values[i] - values[i - 1]);
  }

  // Count sign changes between consecutive deltas
  let signChanges = 0;
  for (let i = 1; i < deltas.length; i++) {
    const prev = Math.sign(deltas[i - 1]);
    const curr = Math.sign(deltas[i]);
    // A sign change occurs when non-zero deltas have opposite signs.
    // Zero deltas (no change) preserve the previous direction.
    if (curr !== 0 && prev !== 0 && curr !== prev) {
      signChanges++;
    }
  }

  // Total possible sign-change positions: (n - 2) because we compare
  // (n-1) deltas pairwise → (n-2) adjacent pairs.
  const maxPossible = n - 2;
  const signChangeRate = maxPossible > 0 ? signChanges / maxPossible : 0;

  return {
    isOscillating: signChanges >= minSignChanges,
    signChangeCount: signChanges,
    signChangeRate,
  };
}

/**
 * Analyse a single metric's trend via linear regression + oscillation check.
 *
 * Classification decision tree:
 * 1. If `values.length < config.minWindowSize` → `insufficient_data`
 * 2. If oscillation detected (sign changes ≥ threshold) → `oscillating`
 * 3. If |slope| < config.slopeEpsilon **and** R² ≥ config.rSquaredFloor
 *    → `converging` (flat trajectory, well-explained by constant model)
 * 4. If |slope| ≥ config.slopeEpsilon **and** R² ≥ config.rSquaredFloor
 *    → `diverging` (significant slope, well-explained by linear model)
 * 5. Otherwise → `insufficient_data` (low R², cannot trust the fit)
 *
 * @param metricName - Human-readable label for the metric
 * @param values - Chronologically ordered metric values
 * @param config - Trend analysis thresholds (omit for defaults)
 * @returns Classified metric trend with regression coefficients
 */
function analyzeSingleMetric(
  metricName: string,
  values: number[],
  config: TrendAnalysisConfig,
): MetricTrend {
  const windowSize = values.length;

  // ── Step 1: Insufficient data ──
  if (windowSize < config.minWindowSize) {
    return {
      metricName,
      slope: 0,
      intercept: values.length > 0 ? values[values.length - 1] : 0,
      rSquared: 0,
      direction: "insufficient_data",
      windowSize,
    };
  }

  // ── Step 2: Linear regression ──
  const { slope, intercept, rSquared } = computeLinearRegression(values);

  // ── Step 3: Oscillation check ──
  const { isOscillating } = detectOscillation(
    values,
    config.oscillationSignChanges,
  );
  if (isOscillating) {
    return {
      metricName,
      slope,
      intercept,
      rSquared,
      direction: "oscillating",
      windowSize,
    };
  }

  // ── Step 4: Classify based on slope magnitude and fit quality ──
  if (rSquared >= config.rSquaredFloor) {
    if (Math.abs(slope) < config.slopeEpsilon) {
      return {
        metricName,
        slope,
        intercept,
        rSquared,
        direction: "converging",
        windowSize,
      };
    }
    return {
      metricName,
      slope,
      intercept,
      rSquared,
      direction: "diverging",
      windowSize,
    };
  }

  // ── Step 5: Low R² — cannot trust the regression ──
  return {
    metricName,
    slope,
    intercept,
    rSquared,
    direction: "insufficient_data",
    windowSize,
  };
}

/**
 * Aggregate per-metric trend directions into a single verdict.
 *
 * Priority cascade (highest to lowest):
 * 1. **diverging** — any single metric diverging → overall is diverging
 * 2. **oscillating** — any single metric oscillating → overall is oscillating
 *    (unless already diverging)
 * 3. **converging** — at least 2 of 3 metrics show converging
 * 4. **insufficient_data** — fallback when ≥2 metrics have insufficient data
 *
 * @param trends - Analysed metric trends (always exactly 3)
 * @returns Aggregate trend direction
 */
function aggregateVerdict(trends: MetricTrend[]): TrendDirection {
  const directions = trends.map((t) => t.direction);

  // Priority 1: diverging
  if (directions.some((d) => d === "diverging")) return "diverging";

  // Priority 2: oscillating
  if (directions.some((d) => d === "oscillating")) return "oscillating";

  // Priority 3: converging (majority)
  const convergingCount = directions.filter((d) => d === "converging").length;
  if (convergingCount >= 2) return "converging";

  // Priority 4: insufficient data (majority)
  const insufficientCount = directions.filter(
    (d) => d === "insufficient_data",
  ).length;
  if (insufficientCount >= 2) return "insufficient_data";

  // Mixed / ambiguous
  return "insufficient_data";
}

/**
 * Apply a sliding window to extract the most recent N rounds of a metric.
 *
 * @param curve - Processed convergence curve
 * @param extractor - Function that maps a SelfPlayRound to the metric value
 * @param windowSize - Number of most recent rounds to include
 * @returns Chronologically ordered metric values (oldest first)
 */
function extractWindow(
  curve: ConvergenceCurve,
  extractor: (round: ConvergenceCurve["rounds"][number]) => number,
  windowSize: number,
): number[] {
  const n = Math.min(windowSize, curve.rounds.length);
  const start = curve.rounds.length - n;
  return curve.rounds.slice(start).map(extractor);
}

/**
 * Analyse convergence trends across all three metrics.
 *
 * Main entry point for the convergence trend analyser. Takes a processed
 * {@link ConvergenceCurve} and an optional {@link TrendAnalysisConfig},
 * applies sliding-window linear regression to each of the three convergence
 * indicators, and returns a {@link ConvergenceTrendAnalysis} with per-metric
 * trends plus an aggregate verdict.
 *
 * @param curve - Processed convergence curve (at least 1 round)
 * @param config - Analysis configuration (omit for defaults)
 * @returns Combined trend analysis with per-metric regression and verdict
 *
 * @throws {RangeError} If `curve.rounds` is empty — a curve with zero rounds
 *  cannot be analysed.
 */
export function analyzeConvergenceTrend(
  curve: ConvergenceCurve,
  config: TrendAnalysisConfig = DEFAULT_TREND_CONFIG,
): ConvergenceTrendAnalysis {
  if (curve.rounds.length === 0) {
    throw new RangeError(
      "analyzeConvergenceTrend: curve.rounds must not be empty",
    );
  }

  // Extract sliding-window values for each of the three metrics
  const entropyValues = extractWindow(
    curve,
    (r) => r.metrics.ruleEntropy.normalizedEntropy,
    config.windowSize,
  );
  const fprValues = extractWindow(
    curve,
    (r) => r.metrics.fprTrendDrift.drift,
    config.windowSize,
  );
  const cvValues = extractWindow(
    curve,
    (r) => r.metrics.coverageStability.coefficientOfVariation,
    config.windowSize,
  );

  // Analyse each metric independently
  const entropyTrend = analyzeSingleMetric(
    "normalizedEntropy",
    entropyValues,
    config,
  );
  const fprDriftTrend = analyzeSingleMetric("fprDrift", fprValues, config);
  const coverageCvTrend = analyzeSingleMetric("coverageCv", cvValues, config);

  // Aggregate verdict
  const verdict = aggregateVerdict([entropyTrend, fprDriftTrend, coverageCvTrend]);

  return {
    entropyTrend,
    fprDriftTrend,
    coverageCvTrend,
    verdict,
    analyzedAt: new Date().toISOString(),
  };
}
