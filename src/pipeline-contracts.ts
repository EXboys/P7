/**
 * ── Pipeline step contract types ──
 *
 * Concrete input/output types for each step in the self-iteration pipeline.
 * Each group is tagged by the {@link SelfIterationStepKind} that produces it,
 * enabling the orchestration engine to route artifacts deterministically.
 *
 * References to `DcSeverity` and `TrendDirection` align with the critic
 * system's existing severity taxonomy and convergence trend classification.
 *
 * @module pipeline-contracts
 */

import type { DcSeverity, TrendDirection } from "./types.ts";

/* ── Pattern Extractor (pattern_extract) ── */

/**
 * A single recurring failure pattern extracted from historical review records.
 *
 * Produced by the **pattern_extract** step as part of {@link PatternReport}.
 * Each instance represents a concrete pattern signature observed across
 * multiple review records, with dimension attribution and frequency stats.
 */
export interface FailurePattern {
  /** The critic dimension this pattern belongs to (e.g. "type-safety", "复杂度") */
  dimension: string;
  /** Pattern prefix or message signature used for matching */
  pattern: string;
  /** How many times this pattern appears across the scanned records */
  frequency: number;
  /** Most common severity level for this pattern across all occurrences */
  topSeverity: DcSeverity;
  /** Dimensions that co-occur with this pattern, sorted by frequency descending */
  coOccurringDimensions?: string[];
  /** ISO-8601 timestamp of the first observed occurrence */
  firstObservedAt: string;
  /** ISO-8601 timestamp of the most recent observed occurrence */
  lastObservedAt: string;
}

/**
 * Output of the **pattern_extract** step.
 *
 * Aggregates extracted failure patterns with dimension-level statistics,
 * enabling downstream steps (convergence_analyze, threshold_calibrate)
 * to operate on structured pattern data rather than raw review records.
 */
export interface PatternReport {
  /** Extracted failure patterns, sorted by frequency descending */
  patterns: FailurePattern[];
  /** Number of historical review records scanned for extraction */
  scannedRecords: number;
  /** Source pipeline(s) the input data originates from */
  source: "diff-critic" | "plan-critic" | "mixed";
  /** Per-dimension summary statistics for quick overview */
  dimensions: Array<{
    name: string;
    total: number;
    hitRate: number;
  }>;
  /** ISO-8601 timestamp of report generation */
  generatedAt: string;
}

/* ── Convergence Analyzer (convergence_analyze) ── */

/**
 * Output of the **convergence_analyze** step.
 *
 * Contains linear regression results and trend classification across
 * convergence metrics for the current iteration window. Downstream
 * consumers (early_stop, threshold_calibrate) use slope and rSquared
 * to determine whether the iteration loop is stabilising or diverging.
 */
export interface ConvergenceReport {
  /** OLS slope estimate for the primary convergence metric —
   *  per-round rate of change */
  slope: number;
  /** Coefficient of determination (0–1); goodness of fit for the
   *  linear regression */
  rSquared: number;
  /** Current normalized rule entropy value (0–1) computed across
   *  all tracked dimensions */
  ruleEntropy: number;
  /** Current false-positive rate drift from the baseline window;
   *  positive values indicate degradation */
  fprDrift: number;
  /** Trend direction classification based on slope and R² thresholds */
  trend: TrendDirection;
  /** ISO-8601 timestamp when the analysis was performed */
  analyzedAt: string;
}

/* ── Early Stop (early_stop) ── */

/**
 * Output of the **early_stop** step.
 *
 * Decision on whether to freeze the current rule version based on
 * convergence plateau detection. The `trendAnalysis` snapshot provides
 * full traceability for audit and rollback decisions.
 */
export interface EarlyStopDecision {
  /** True when all three convergence metrics have plateaued for
   *  `plateauRounds` consecutive evaluations */
  shouldStop: boolean;
  /** Human-readable explanation of the decision (why stopped or why not) */
  reason: string;
  /** Number of consecutive converging rounds observed at decision time */
  plateauDuration: number;
  /** The iteration round at which the rule set was frozen, or null
   *  if no freeze was triggered */
  frozenVersion: number | null;
  /** ISO-8601 timestamp when this decision was computed */
  triggeredAt: string;
  /** Snapshot of convergence trend analysis at decision time */
  trendAnalysis: {
    entropySlope: number;
    fprDriftSlope: number;
    coverageCvSlope: number;
    verdict: TrendDirection;
  };
}

/* ── Threshold Calibrator (threshold_calibrate) ── */

/**
 * Per-severity calibration result within a {@link CalibrationReport}.
 *
 * Each entry represents the optimal decision threshold and associated
 * precision/recall/f1 for a single severity level, computed from the
 * labeled calibration dataset.
 */
export interface PerSeverityCalibration {
  /** The severity level this calibration applies to */
  severity: DcSeverity;
  /** Optimal decision threshold for this severity level (0–1) */
  optimalCutoff: number;
  /** Precision at the optimal cutoff (0–1) */
  precision: number;
  /** Recall at the optimal cutoff (0–1) */
  recall: number;
  /** F1 score at the optimal cutoff (0–1) */
  f1: number;
}

/**
 * Output of the **threshold_calibrate** step.
 *
 * Contains optimal severity thresholds computed from the labeled
 * calibration dataset, with precision/recall/f1 metrics at both the
 * aggregate and per-severity levels. Downstream consumers
 * (dynamic_rules_inject) use these thresholds to adjust rule sensitivity.
 */
export interface CalibrationReport {
  /** Optimal cutoff values keyed by dimension name
   *  (e.g. `{ "type-safety": 0.85, "复杂度": 0.72 }`) */
  optimalCutoffs: Record<string, number>;
  /** Aggregate precision across all dimensions (0–1) */
  precision: number;
  /** Aggregate recall across all dimensions (0–1) */
  recall: number;
  /** Aggregate F1 score across all dimensions (0–1) */
  f1: number;
  /** Total sample size used for calibration */
  sampleSize: number;
  /** Per-severity breakdown of calibration metrics */
  perSeverity: PerSeverityCalibration[];
}

/* ── Dynamic Rules Injector (dynamic_rules_inject) ── */

/**
 * A single rule entry within a {@link DynamicRulesPayload}.
 *
 * Each entry defines a dimension-pattern pair with an associated severity
 * threshold. When injected, these rules augment or override the existing
 * critic pipeline configuration for the matching patterns.
 */
export interface RuleEntry {
  /** Critic dimension this rule targets (e.g. "type-safety", "复杂度") */
  dimension: string;
  /** Pattern signature to match against finding messages */
  pattern: string;
  /** Severity threshold assigned to matching findings */
  severityThreshold: DcSeverity;
  /** Optional template path or module reference for the rule implementation */
  targetTemplate?: string;
}

/**
 * Output of the **dynamic_rules_inject** step.
 *
 * Contains the adjusted severity thresholds and new/adjusted rules to be
 * injected into the critic pipeline. The orchestration engine applies
 * this payload after the early_stop gate clears and threshold_calibrate
 * produces updated cutoffs.
 */
export interface DynamicRulesPayload {
  /** Global severity thresholds by severity level —
   *  keys are DcSeverity values, values are the threshold (0–1) */
  severityThresholds: Partial<Record<DcSeverity, number>>;
  /** New or adjusted rules to inject into the critic pipeline */
  rules: RuleEntry[];
  /** Optional template path or module reference for rule generation */
  targetTemplate?: string;
  /** ISO-8601 timestamp of the injection */
  injectedAt: string;
}

/* ── A/B Validator (ab_validate) ── */

/**
 * Per-dimension breakdown within an {@link AbTestResult}.
 *
 * Enables drill-down analysis to identify which dimensions improved,
 * regressed, or stayed neutral after rule injection.
 */
export interface AbTestBreakdown {
  /** Dimension name (e.g. "type-safety", "复杂度") */
  dimension: string;
  /** Recall before rule injection (0–1) */
  recallBefore: number;
  /** Recall after rule injection (0–1) */
  recallAfter: number;
  /** False-positive rate before rule injection (0–1) */
  fprBefore: number;
  /** False-positive rate after rule injection (0–1) */
  fprAfter: number;
}

/**
 * Output of the **ab_validate** step.
 *
 * Compares critic pipeline performance before and after dynamic rule
 * injection using a held-out test set. Returns per-dimension breakdowns
 * and an aggregate acceptance verdict to guide the iteration loop's
 * next decision (continue, rollback, or freeze).
 */
export interface AbTestResult {
  /** Aggregate recall before rule injection (0–1) */
  recallBefore: number;
  /** Aggregate recall after rule injection (0–1) */
  recallAfter: number;
  /** Aggregate false-positive rate before rule injection (0–1) */
  fprBefore: number;
  /** Aggregate false-positive rate after rule injection (0–1) */
  fprAfter: number;
  /** Per-dimension performance breakdown */
  breakdown: AbTestBreakdown[];
  /**
   * Acceptance verdict:
   * - `accept`: significant improvement at the configured confidence level
   * - `reject`: no significant improvement or regression detected
   * - `inconclusive`: insufficient data or confidence to decide
   */
  verdict: "accept" | "reject" | "inconclusive";
  /** Number of samples used in the A/B test */
  sampleSize: number;
  /** Statistical confidence level for the verdict (0–1) */
  confidenceLevel: number;
}
