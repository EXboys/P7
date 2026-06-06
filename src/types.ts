import { z } from "zod";
import type { SdkTokenUsage } from "./sdk-cost.ts";

export const PlanSchema = z.object({
  /** English — commit / PR / Issue title on GitHub */
  title: z.string().min(1).max(120),
  /** Chinese — admin console display */
  title_zh: z.string().min(1).max(80).optional(),
  /** English — GitHub PR / Issue body */
  motivation: z.string().min(1),
  /** Chinese — admin console display */
  motivation_zh: z.string().min(1).optional(),
  complexity: z.enum(["simple", "medium", "complex"]).optional(),
  changes: z
    .array(
      z.object({
        file: z.string().min(1),
        /** English — GitHub PR body */
        description: z.string().min(1),
        /** Chinese — admin console display */
        description_zh: z.string().min(1).optional(),
        estimated_lines: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(20),
  /** English — GitHub PR body */
  risks: z.array(z.string()),
  /** Chinese — admin console display */
  risks_zh: z.array(z.string()).optional(),
  validation: z.string().min(1),
  estimated_diff_lines: z.number().int().nonnegative().max(1000),
  critique_notes: z.array(z.string()).optional(),
  baseCommit: z.string().optional(),
});

export type Plan = z.infer<typeof PlanSchema>;

export const GoalSelectionSchema = z.object({
  today_goal: z.string().min(1),
  reasoning: z.string().min(1),
  alternatives: z.array(z.string()).optional(),
});

export type GoalSelection = z.infer<typeof GoalSelectionSchema>;

export interface GitCommit {
  hash: string;
  date: string;
  subject: string;
}

export interface ProjectScan {
  path: string;
  scannedAt: string;
  techStack: {
    languages: string[];
    packageManagers: string[];
    frameworks: string[];
    manifests: string[];
  };
  git: {
    branch: string;
    remoteUrl: string | null;
    recentCommits: GitCommit[];
    uncommittedChanges: number;
  } | null;
  todos: {
    file: string;
    line: number;
    kind: "TODO" | "FIXME" | "HACK" | "XXX";
    text: string;
  }[];
  fileSummary: {
    totalFiles: number;
    byExtension: Record<string, number>;
    topLevelEntries: string[];
  };
  readme: string | null;
}

export interface ExecutionResult {
  ok: boolean;
  branch?: string;
  commitSha?: string;
  reviewUrl?: string;
  /** Sandbox preview URL pointing to the dashboard server serving worktree content */
  previewUrl?: string;
  prUrl?: string;
  issueUrl?: string;
  mergeStatus?:
    | "not_requested"
    | "queued"
    | "merged"
    | "failed"
    | "skipped"
    | "pending_checks"
    | "behind"
    | "merge_blocked"
    | "closed";
  accountResults?: VcsAccountPublishResult[];
  costUsd?: number;
  tokenUsage?: SdkTokenUsage;
  durationSec?: number;
  error?: string;
  worktreePath?: string;
}

export interface ApprovalRecord {
  planId: string;
  projectPath: string;
  status: "pending" | "approved" | "rejected";
  plan: Plan;
  goal: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface PlanRecord {
  planId: string;
  projectPath: string;
  goal: string;
  plan: Plan;
  createdAt: string;
}

export type PlanStateStatus =
  | "planned"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "pushed"
  | "pr_opened"
  | "merged"
  | "failed";

export interface PlanState {
  planId: string;
  projectPath: string;
  goal: string;
  title: string;
  status: PlanStateStatus;
  createdAt: string;
  updatedAt: string;
  branch?: string;
  commitSha?: string;
  reviewUrl?: string;
  prUrl?: string;
  issueUrl?: string;
  mergeStatus?: ExecutionResult["mergeStatus"];
  accountResults?: VcsAccountPublishResult[];
  costUsd?: number;
  tokenUsage?: SdkTokenUsage;
  error?: string;
  findings?: string;
  diffCriticFindings?: string;
  planCriticFindings?: string;
}

export interface VcsAccountPublishResult {
  accountId: string;
  ok: boolean;
  branch?: string;
  prUrl?: string;
  issueUrl?: string;
  mergeStatus?: ExecutionResult["mergeStatus"];
  warning?: string;
}

export interface TechSignal {
  source: "hn" | "github";
  title: string;
  url: string;
  score?: number;
  tags: string[];
  summary?: string;
}

export interface TechDiscoverySnapshot {
  date: string;
  fetchedAt: string;
  signals: TechSignal[];
  themes: string[];
  summary: string;
}

export interface DiscoveryDailyResult {
  date: string;
  snapshotPath: string;
  signalCount: number;
  themes: string[];
  roadmapRefreshed: boolean;
  planId?: string;
  goal?: string;
  phase: string;
  error?: string;
}

export type DcSeverity = "info" | "warning" | "blocker";

export interface DiffCriticFinding {
  dimension: string;
  severity: DcSeverity;
  message: string;
  prefix?: string;
  file?: string;
  line?: number;
  code?: string;
  /** CWE identifier for vulnerability findings, e.g. "CWE-89", "CWE-79" */
  cweId?: string;
  /** Confidence score 0–1 for vulnerability detection certainty */
  confidence?: number;
  /** Suggested remediation guidance for vulnerability findings */
  remediation?: string;
}

/* ── Gradual type-check config types ── */

/**
 * Re-exported from `gradual-typecheck-config.ts` for convenience.
 * Protocol: ordered rules with glob patterns and per-flag strict-mode overrides.
 * First-match-wins semantics; empty rules = fall back to tsconfig defaults.
 */
export type { GradualTypeCheckRule, GradualTypeCheckConfig, TscStrictFlag } from "./gradual-typecheck-config.ts";

/* ── Type coverage dashboard types ── */

/**
 * Per-file resolved type-check strictness information for dashboard display.
 * `matchedRule` is the glob pattern of the matched GradualTypeCheckRule,
 * or `null` if no rule matched (tsconfig defaults apply).
 * `resolvedFlags` maps each strict-mode flag to its effective boolean value
 * for this file based on the matched rule's overrides.
 */
export interface TypeCoverageFileEntry {
  filePath: string;
  matchedRule: string | null;
  resolvedFlags: Record<string, boolean>;
}

/**
 * Aggregated type coverage statistics across all scanned source files.
 *
 * - strictFiles: count of files whose matched rule has all flags set to `true`
 * - partialFiles: count of files whose matched rule has a mix of `true`/`false`
 * - defaultFiles: count of files matching no rule (tsconfig defaults apply)
 * - perFlagCounts: how many files have each flag enabled (value === true)
 */
export interface TypeCoverageStats {
  totalFiles: number;
  strictFiles: number;
  partialFiles: number;
  defaultFiles: number;
  perFlagCounts: Record<string, number>;
}

/**
 * Type coverage report combining config-derived strictness with optional
 * typecheck execution error data. `source` identifies the data origin.
 */
export interface TypeCoverageReport {
  source: "config" | "execution" | "merged";
  stats: TypeCoverageStats;
  files: TypeCoverageFileEntry[];
  /** Per-file type error counts from tsc execution output */
  perFileErrors?: Record<string, number>;
  /** Total number of type errors across all files */
  totalErrors?: number;
}

/* ── Gemma bridge types ── */

/**
 * Re-exported from `gemma-bridge.ts` for cross-module consumption by the
 * diff-critic pipeline, executor, and decision-routing code.
 *
 * GemmaEvalConfig  — latency budget, context-window budget, confidence floor,
 *                    and fallback-enable flag for Gemma 4 12B evaluation.
 * GemmaEvalResult  — aggregate evaluation result containing per-slice findings,
 *                    raw output, latency telemetry, token estimate, aggregate
 *                    confidence, and a fallback flag for downstream routing.
 */
export type { GemmaEvalConfig, GemmaEvalResult } from "./gemma-bridge.ts";

/* ── Evaluator router types ── */

/**
 * Re-exported from `evaluator-router.ts` for cross-module consumption by the
 * executor and diff-critic pipeline.
 *
 * DiffComplexityTier  — trivial / small / medium / large
 * CriticUrgency       — blocker / advisory
 * SelectedEvaluator   — gemma / gemma_with_fallback / claude
 * EvaluatorRouteDecision — route decision result with cost estimate and reason
 */
export type { DiffComplexityTier, CriticUrgency, SelectedEvaluator, EvaluatorRouteDecision } from "./evaluator-router.ts";

/* ── Findings aggregation types ── */

/**
 * Per-dimension statistics within a findings aggregation.
 *
 * - `total`: absolute count of findings in this dimension
 * - `bySeverity`: breakdown by severity level (info / warning / blocker)
 * - `hitRate`: proportion of scanned plans that had at least one
 *   finding in this dimension (0–1)
 * - `blockerRatio`: proportion of findings in this dimension that
 *   are blockers (0–1)
 */
export interface FindingsDimensionStats {
  dimension: string;
  total: number;
  bySeverity: Record<DcSeverity, number>;
  hitRate: number;
  blockerRatio: number;
}

/**
 * Aggregated findings statistics across a set of historical PlanState records.
 *
 * - `scannedPlans`: number of plan records examined
 * - `totalFindings`: total parsed finding entries across all plans
 * - `okRate`: proportion of plans with zero findings (0–1)
 * - `dimensions`: per-dimension stats, sorted by total descending
 * - `tuningInput`: pre-built JSON object ready for prompt template injection
 */
export interface FindingsAggregation {
  scannedPlans: number;
  totalFindings: number;
  okRate: number;
  dimensions: FindingsDimensionStats[];
  tuningInput: PromptTuningInput;
}

/**
 * Minimal JSON structure designed for injection into critic prompt templates.
 *
 * - `summary`: one-line overview of the aggregation
 * - `dimensions`: dimension-level stats for contextual weighting
 * - `patterns`: recurring finding patterns (by message prefix),
 *   sorted by frequency descending, capped at 20 entries
 */
export interface PromptTuningInput {
  summary: {
    totalPlansScanned: number;
    totalFindings: number;
    okRate: number;
  };
  dimensions: Array<{
    name: string;
    hitRate: number;
    severityBreakdown: Record<DcSeverity, number>;
    blockerRatio: number;
  }>;
  patterns: Array<{
    dimension: string;
    description: string;
    frequency: number;
    topSeverity: DcSeverity;
  }>;
}

/* ── Plan-critic structured output types ── */

/**
 * 8-category taxonomy for plan review findings.
 *
 * - `scope_creep`: Plan touches files not relevant to the goal.
 * - `optimistic_lines`: estimated_diff_lines far below realistic.
 * - `missing_validation`: validation field absent or non-executable.
 * - `duplicate_goal`: Plan closely matches a recently-failed goal.
 * - `breaking_change`: Plan introduces backward-incompatible changes
 *   without migration path.
 * - `unclear_goal`: goal field is ambiguous or underspecified.
 * - `stale_context`: Plan based on outdated code structure not yet
 *   confirmed by reading current HEAD.
 * - `other`: Catch-all for findings that don't fit above categories.
 */
export type PlanCriticCategory =
  | "scope_creep"
  | "optimistic_lines"
  | "missing_validation"
  | "duplicate_goal"
  | "breaking_change"
  | "unclear_goal"
  | "stale_context"
  | "other";

/**
 * Structured plan review finding, aligned with `DiffCriticFinding` pattern
 * but adapted for plan-JSON review domain.
 *
 * - `target` replaces `file`/`line` — points to plan field, file path, or "plan"
 * - `description` replaces `message` — the finding rationale
 * - `recommendation` is explicit (DiffCriticFinding leaves this implicit)
 * - `code` is optional, present when quoting a specific plan JSON excerpt
 */
export interface PlanCriticFinding {
  severity: DcSeverity;
  category: PlanCriticCategory;
  /** What part of the plan is affected — file path, field name, or "plan" for global */
  target: string;
  /** Why this is a problem */
  description: string;
  /** What should change to resolve it */
  recommendation: string;
  /** Optional code snippet or excerpt supporting the finding */
  code?: string;
}

/**
 * Result wrapper for plan-critic output.
 *
 * Unlike `reviewDiff` which returns both raw text and structured findings,
 * `PlanCriticResult` is purely structured — the `summary` field provides
 * the quick human-readable verdict that raw text previously served.
 */
export interface PlanCriticResult {
  /** true = plan is safe to execute */
  ok: boolean;
  /** All findings, sorted severity desc then category asc */
  findings: PlanCriticFinding[];
  /** One-line human-readable verdict */
  summary: string;
}

/* ── Pattern extractor types ── */

/**
 * Per-dimension statistics extracted from historical review records.
 * Used by the pattern extractor to identify high-frequency failure types
 * and severity distribution for threshold auto-calibration.
 *
 * - `dimension`: The critic dimension (e.g. "type-safety", "complexity")
 * - `total`: Absolute count of findings in this dimension
 * - `bySeverity`: Breakdown by severity level (info / warning / blocker)
 * - `hitRate`: Proportion of all scanned reviews that had at least one
 *   finding in this dimension (0–1)
 * - `blockerRatio`: Proportion of findings in this dimension that are
 *   blockers (0–1); high values signal dimension is a reliable gate
 */
export interface DimensionStat {
  dimension: string;
  total: number;
  bySeverity: Record<DcSeverity, number>;
  hitRate: number;
  blockerRatio: number;
}

/**
 * Dimension co-occurrence pattern identified in historical reviews.
 * Records how often two dimensions produce findings in the same review run,
 * enabling discovery of correlated failure patterns.
 *
 * - `dimensionA` / `dimensionB`: The paired dimensions (lexicographically
 *   ordered to avoid duplicate pairs)
 * - `count`: Number of review runs where both dimensions had findings
 * - `frequency`: Proportion of all scanned reviews where both fired (0–1)
 */
export interface CoOccurrence {
  dimensionA: string;
  dimensionB: string;
  count: number;
  frequency: number;
}

/**
 * Top-level report from the pattern extractor, aggregating dimension
 * statistics, co-occurrence matrix, and high-frequency patterns.
 *
 * Designed as the output contract for `PatternExtractor.extract()` and
 * consumed by threshold auto-calibration and dynamic rule injection stages.
 *
 * - `scannedRecords`: number of historical PlanState records examined
 * - `source`: identifies which critic pipeline(s) the data comes from
 * - `dimensions`: per-dimension stats, sorted by total descending
 * - `coOccurrences`: co-occurrence pairs, sorted by frequency descending
 * - `topPatterns`: recurring finding patterns (by message prefix),
 *   capped at 20 entries, sorted by frequency descending
 * - `generatedAt`: ISO-8601 timestamp of report generation
 */
export interface PatternExtractorReport {
  scannedRecords: number;
  source: "diff-critic" | "plan-critic" | "mixed";
  dimensions: DimensionStat[];
  coOccurrences: CoOccurrence[];
  topPatterns: Array<{
    dimension: string;
    description: string;
    frequency: number;
    topSeverity: DcSeverity;
  }>;
  generatedAt: string;
}

/* ── Dynamic rules convergence metric types ── */

/**
 * Per-dimension weight configuration for weighted convergence metric computation.
 *
 * Keys are dimension names (e.g. "漏洞发现"), values are multipliers applied
 * to rule counts when computing entropy, coverage stability, and other metrics.
 * Dimensions not present in the map default to 1.0 (no weighting).
 *
 * Used by computeRuleEntropy and computeCoverageStability to bias convergence
 * metrics toward dimensions with higher strategic importance.
 */
export type DimensionWeights = Record<string, number>;

/**
 * A single dynamic rule entity within the self-iteration loop.
 *
 * Each rule associates a critic dimension with a pattern signature and
 * tracks its hit/miss counters across iterations. The version field
 * increments on each auto-tuning adjustment, enabling convergence
 * tracking over the rule's lifecycle.
 *
 * - `dimension`: critic dimension this rule targets (e.g. "type-safety",
 *   "complexity", "漏洞发现")
 * - `pattern`: pattern prefix or message signature this rule matches
 * - `hitCount`: number of times this rule has been triggered (hits)
 * - `falsePositiveCount`: number of false positives identified for this rule
 * - `falseNegativeCount`: number of false negatives identified for this rule
 * - `version`: version number incremented on each auto-tuning iteration
 */
export interface DynamicRule {
  dimension: string;
  pattern: string;
  hitCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  version: number;
}

/**
 * Rule entropy: information-theoretic measure of rule fragmentation
 * across dimensions. Uses Shannon entropy `H = -Σ(pᵢ × log₂(pᵢ))`
 * where `pᵢ` is the proportion of rules in dimension `i`.
 *
 * Lower entropy indicates rules are concentrated in a few dimensions
 * (focused iteration, converging); higher entropy indicates rules are
 * spreading across many dimensions (exploration phase, diverging).
 *
 * - `entropy`: raw Shannon entropy value (bits)
 * - `maxEntropy`: theoretical maximum entropy given dimension count
 * - `normalizedEntropy`: entropy / maxEntropy (0–1); closer to 0 = more concentrated
 * - `dimensionCount`: number of dimensions with at least one rule
 */
export interface RuleEntropyMetric {
  entropy: number;
  maxEntropy: number;
  normalizedEntropy: number;
  dimensionCount: number;
}

/**
 * False-positive rate trend drift: compares the current sliding-window
 * FPR against a baseline FPR to detect rule effectiveness decay.
 *
 * Positive drift (currentFpr > baselineFpr) signals rule degradation
 * that may warrant rollback or adjustment. The `isDrifting` flag
 * triggers when `drift` exceeds `driftThreshold`.
 *
 * - `baselineFpr`: FPR computed from the baseline historical window
 * - `currentFpr`: FPR computed from the current sliding window
 * - `drift`: currentFpr - baselineFpr (positive = degradation)
 * - `driftThreshold`: configurable threshold above which drift triggers alert
 * - `isDrifting`: true when drift exceeds driftThreshold
 */
export interface FprTrendDriftMetric {
  baselineFpr: number;
  currentFpr: number;
  drift: number;
  driftThreshold: number;
  isDrifting: boolean;
}

/**
 * Dimension coverage stability coefficient: coefficient of variation (CV)
 * across per-dimension rule counts. CV = σ / μ, where σ is the standard
 * deviation and μ is the mean of rule counts per dimension.
 *
 * Lower CV indicates balanced coverage across dimensions; high CV signals
 * that one or a few dimensions dominate, which may indicate over-fitting
 * or blind spots in the rule set.
 *
 * - `mean`: average rule count across all tracked dimensions
 * - `standardDeviation`: standard deviation of rule counts
 * - `coefficientOfVariation`: σ / μ (unitless); lower values = more balanced
 * - `dimensionCount`: total number of dimensions tracked
 * - `cvThreshold`: configurable threshold for acceptable imbalance
 * - `isUnstable`: true when coefficientOfVariation exceeds cvThreshold
 */
export interface CoverageStabilityMetric {
  mean: number;
  standardDeviation: number;
  coefficientOfVariation: number;
  dimensionCount: number;
  cvThreshold: number;
  isUnstable: boolean;
}

/**
 * Aggregated convergence metrics for the dynamic_rules self-iteration loop.
 *
 * Contains three quantitative indicators:
 * 1. `ruleEntropy` — fragmentation measure (Shannon entropy across dimensions)
 * 2. `fprTrendDrift` — FPR degradation detection (window vs baseline)
 * 3. `coverageStability` — dimension balance metric (coefficient of variation)
 *
 * Used by the auto-iteration supervisor to determine whether rule iterations
 * are converging toward a stable, effective state — enabling automated
 * decisions about rollback, freeze, or continued tuning.
 */
export interface ConvergenceMetrics {
  ruleEntropy: RuleEntropyMetric;
  fprTrendDrift: FprTrendDriftMetric;
  coverageStability: CoverageStabilityMetric;
  /** ISO-8601 timestamp of metric computation */
  computedAt: string;
}

/**
 * Adaptive trigger configuration: thresholds for the convergence decision matrix.
 *
 * The decision matrix combines three indicators to determine the iteration
 * lifecycle action:
 * 1. Rule entropy normalized (0-1) — fragmentation
 * 2. FPR trend drift — effectiveness decay
 * 3. Coverage stability CV — balance
 *
 * Default heuristics (subject to empirical tuning):
 * - entropyLow: 0.3 — below this, rules are concentrated enough to converge
 * - entropyHigh: 0.7 — above this, rules are too fragmented, need consolidation
 * - fprDriftAlert: 0.03 — above this triggers alert, signaling potential degradation
 * - fprDriftRollback: 0.10 — above this triggers automatic rollback
 * - cvAlert: 0.5 — above this triggers imbalance alert
 * - cvRollback: 0.8 — above this triggers automatic rollback
 */
export interface AdaptiveTriggerConfig {
  entropyLow: number;
  entropyHigh: number;
  fprDriftAlert: number;
  fprDriftRollback: number;
  cvAlert: number;
  cvRollback: number;
}

/**
 * Decision action output from the adaptive trigger joint decision matrix.
 *
 * - `continue`: all indicators within normal range; proceed with next iteration
 * - `alert`: one or more indicators crossed the alert threshold; notify but continue
 * - `freeze`: entropy or coverage imbalance is high; freeze iterations until consolidated
 * - `rollback`: FPR drift or CV crossed the rollback threshold; revert last iteration
 */
export type TriggerAction = "continue" | "alert" | "freeze" | "rollback";

/**
 * Result of the adaptive trigger joint decision matrix evaluation.
 *
 * Combines the three convergence metrics with the configured thresholds
 * to produce a deterministic action recommendation, along with the
 * specific indicators that triggered the decision.
 *
 * - `action`: recommended lifecycle action based on threshold evaluation
 * - `triggeredBy`: list of metric names that crossed their alert/rollback
 *   thresholds (e.g. `["fprTrendDrift", "ruleEntropy"]`), empty for continue
 * - `convergenceMetrics`: snapshot of the metrics at decision time
 * - `config`: effective threshold configuration used for this decision
 */
export interface TriggerDecision {
  action: TriggerAction;
  triggeredBy: string[];
  convergenceMetrics: ConvergenceMetrics;
  config: AdaptiveTriggerConfig;
}

/**
 * A single convergence snapshot stored in the convergence_snapshots table.
 *
 * Each row persists computed ConvergenceMetrics at a specific point in the
 * iteration lifecycle, keyed by planId and iterationRound for time-series
 * queryability. Consumers use these rows to compute trend lines, detect
 * divergence, and drive auto-rollback decisions.
 *
 * - `planId`: the Plan this snapshot belongs to
 * - `iterationRound`: 0-based iteration round at which metrics were computed
 * - `metrics`: the full ConvergenceMetrics payload (entropy, FPR drift, coverage)
 * - `computedAt`: ISO-8601 timestamp of snapshot computation
 */
export interface ConvergenceSnapshotRecord {
  planId: string;
  iterationRound: number;
  metrics: ConvergenceMetrics;
  computedAt: string;
}

/**
 * Query filter for slicing convergence snapshots by time window.
 *
 * Both `since` and `until` are ISO-8601 timestamps; the window is inclusive
 * on both ends (`[since, until]`). When omitted, the query returns all
 * snapshots for the given planId without time-based filtering.
 */
export interface ConvergenceTimeWindow {
  since?: string;
  until?: string;
}

/**
 * Query filter for slicing convergence snapshots by iteration round range.
 *
 * The range is inclusive on both ends (`[startRound, endRound]`).
 * When both are omitted, the query returns all snapshots for the planId
 * without iteration-based filtering.
 */
export interface ConvergenceIterationRange {
  startRound?: number;
  endRound?: number;
}

/* ── Self-play convergence curve types ── */

/**
 * Raw self-play log entry from a single iteration round.
 *
 * The extractor ingests an array of these entries and enriches each with
 * computed convergence metrics (rule entropy, FPR drift, coverage stability)
 * to produce a {@link SelfPlayRound}.
 *
 * - `round`: 0-based iteration round number
 * - `rules`: dynamic rules snapshot at this round
 * - `baselineFpr`: cumulative baseline false-positive rate used for drift
 *   computation in curve extraction (typically carried forward from the
 *   warm-up phase)
 * - `recordedAt`: ISO-8601 timestamp when this entry was recorded
 */
export interface SelfPlayLogEntry {
  round: number;
  rules: DynamicRule[];
  baselineFpr?: number;
  recordedAt: string;
}

/**
 * A single processed round within the convergence curve.
 *
 * Extends the raw log entry with pre-computed {@link ConvergenceMetrics}
 * so consumers can plot trend lines without re-computing statistics from
 * the raw rule arrays.
 *
 * - `round`: 0-based iteration round number
 * - `rules`: dynamic rules snapshot at this round (preserved for drill-down)
 * - `metrics`: pre-computed convergence metrics (entropy, FPR drift, coverage)
 * - `recordedAt`: ISO-8601 timestamp when this round was recorded
 */
export interface SelfPlayRound {
  round: number;
  rules: DynamicRule[];
  metrics: ConvergenceMetrics;
  recordedAt: string;
}

/**
 * Time-series convergence curve for the self-play iteration loop.
 *
 * Aggregates all processed rounds into a sortable sequence that can be
 * rendered as line charts (rule entropy over rounds, FPR drift over rounds,
 * coverage CV over rounds) for operator observability.
 *
 * - `rounds`: chronologically ordered array of processed rounds
 * - `totalRounds`: convenience field equal to `rounds.length`
 * - `generatedAt`: ISO-8601 timestamp of curve generation
 */
export interface ConvergenceCurve {
  rounds: SelfPlayRound[];
  totalRounds: number;
  generatedAt: string;
}

/* ── Convergence trend analysis types ── */

/**
 * Direction classification for a single metric's trend.
 *
 * - `converging`: slope is near zero (within ε) and R² is adequate —
 *   metric has stabilised within the sliding window
 * - `diverging`: slope magnitude is significant and R² is adequate —
 *   metric is trending away from the target level
 * - `oscillating`: high sign-change frequency in consecutive deltas —
 *   metric is unstable, alternating direction each round
 * - `insufficient_data`: too few data points for reliable regression,
 *   or R² is too low to trust the fit
 */
export type TrendDirection = "converging" | "diverging" | "oscillating" | "insufficient_data";

/**
 * Ordinary Least Squares regression result for a single metric.
 *
 * - `metricName`: which metric was analysed (e.g. "normalizedEntropy",
 *   "fprDrift", "coverageCv")
 * - `slope`: OLS slope estimate — per-round rate of change
 * - `intercept`: OLS intercept estimate — estimated value at round 0
 * - `rSquared`: coefficient of determination (0–1); goodness of fit
 * - `direction`: classified trend direction based on thresholds
 * - `windowSize`: actual number of data points included (≤ config.windowSize)
 */
export interface MetricTrend {
  metricName: string;
  slope: number;
  intercept: number;
  rSquared: number;
  direction: TrendDirection;
  windowSize: number;
}

/**
 * Combined trend analysis across all three convergence metrics.
 *
 * Each metric is independently analysed via sliding-window regression.
 * The `verdict` is an aggregate priority vote: diverging > oscillating >
 * converging > insufficient_data.
 *
 * - `entropyTrend`: regression & classification for normalized rule entropy
 * - `fprDriftTrend`: regression & classification for FPR drift
 * - `coverageCvTrend`: regression & classification for coverage CV
 * - `verdict`: aggregate convergence verdict across all three metrics
 * - `analyzedAt`: ISO-8601 timestamp when the analysis was performed
 */
export interface ConvergenceTrendAnalysis {
  entropyTrend: MetricTrend;
  fprDriftTrend: MetricTrend;
  coverageCvTrend: MetricTrend;
  verdict: TrendDirection;
  analyzedAt: string;
}

/**
 * Configuration for trend analysis sliding-window regression.
 *
 * All thresholds are initial heuristics and should be empirically tuned
 * once production convergence data is available.
 *
 * - `windowSize`: number of most recent rounds to include (default 8)
 * - `slopeEpsilon`: absolute slope below which trend is flat (default 0.01)
 * - `rSquaredFloor`: minimum R² to trust the linear fit (default 0.6)
 * - `oscillationSignChanges`: minimum number of sign changes in consecutive
 *   deltas to classify as oscillating (default 3)
 * - `minWindowSize`: minimum data points required for any analysis (default 5)
 */
export interface TrendAnalysisConfig {
  windowSize: number;
  slopeEpsilon: number;
  rSquaredFloor: number;
  oscillationSignChanges: number;
  minWindowSize: number;
}

/* ── Early stop trigger types ── */

/**
 * Configuration for the convergence plateau early stop trigger.
 *
 * When all three convergence metrics (rule entropy, FPR drift, coverage CV)
 * exhibit a flat slope (|slope| < slopeEpsilon) for `plateauRounds` consecutive
 * rounds, the early stop trigger fires and freezes the current rule version.
 *
 * - `slopeEpsilon`: absolute slope threshold below which a metric is considered
 *   flat (default 0.01). Matches TrendAnalysisConfig.slopeEpsilon for consistency.
 * - `plateauRounds`: number of consecutive rounds all three metrics must be
 *   converging to trigger early stop (default 5)
 * - `minRounds`: minimum total rounds that must have elapsed before early stop
 *   can trigger. Prevents premature stopping during the warm-up phase (default 10)
 */
export interface EarlyStopConfig {
  slopeEpsilon: number;
  plateauRounds: number;
  minRounds: number;
}

/**
 * Decision output from the convergence plateau early stop trigger.
 *
 * - `shouldStop`: true when the plateau condition has been sustained for
 *   `plateauRounds` consecutive evaluations
 * - `reason`: human-readable explanation of the decision (why stopped or why not)
 * - `plateauDuration`: how many consecutive rounds the all-three-converging
 *   condition has been true at the time of evaluation
 * - `frozenVersion`: the iteration round number at which the rule set was frozen,
 *   or null if not stopping
 * - `triggeredAt`: ISO-8601 timestamp when this decision was computed
 * - `trendAnalysis`: the ConvergenceTrendAnalysis snapshot used to evaluate
 *   the plateau condition at this round
 */
export interface EarlyStopDecision {
  shouldStop: boolean;
  reason: string;
  plateauDuration: number;
  frozenVersion: number | null;
  triggeredAt: string;
  trendAnalysis: ConvergenceTrendAnalysis;
}

/* ── Calibration dataset types ── */

/**
 * Heuristic label assigned to a single finding for calibration dataset building.
 *
 * - `fp` (false positive): finding likely incorrect — plan was merged/pushed
 *   despite blocker-level finding, suggesting the critic over-flagged.
 * - `tp` (true positive): finding likely correct — plan failed with blocker-level
 *   finding, suggesting the critic correctly identified a real issue.
 * - `unlabeled`: no heuristic confidence; requires manual review.
 */
export type CalibrationLabelValue = "fp" | "tp" | "unlabeled";

/**
 * A single finding within the calibration dataset with its heuristic label.
 */
export interface CalibrationLabel {
  planId: string;
  finding: DiffCriticFinding;
  label: CalibrationLabelValue;
  planStatus: PlanStateStatus;
}

/**
 * Aggregated sample from one plan record, containing all parsed findings
 * and per-finding heuristic labels.
 */
export interface CalibrationSample {
  planId: string;
  status: PlanStateStatus;
  totalFindings: number;
  labels: CalibrationLabel[];
}

/**
 * Full calibration dataset with aggregated label counts.
 *
 * - `samples`: per-plan calibration samples with labelled findings
 * - `labelCounts`: aggregated counts for quick overview
 * - `generatedAt`: ISO-8601 timestamp of extraction
 */
export interface CalibrationDataset {
  samples: CalibrationSample[];
  labelCounts: {
    truePositive: number;
    falsePositive: number;
    unlabeled: number;
  };
  generatedAt: string;
}

/* ── Pipeline orchestration DSL types ── */

/**
 * Re-exported from `pipeline-dsl.ts` for cross-module consumption by the
 * self-iteration orchestration engine and all step implementations.
 *
 * SelfIterationStepKind   — 6-step union (pattern_extract, convergence_analyze,
 *                           early_stop, threshold_calibrate, dynamic_rules_inject,
 *                           ab_validate)
 * ArtifactKind            — union tagging all intermediate artifacts
 * StepExecutionContext   — per-iteration context passed to step execute()
 * PipelineDagNode         — single DAG node with deps, conditions, retry/timeout
 * PipelineDagDefinition   — complete pipeline topology definition
 * StepContract<Input,Output> — generic step contract interface
 */
export type {
  SelfIterationStepKind,
  ArtifactKind,
  StepExecutionContext,
  PipelineDagNode,
  PipelineDagDefinition,
  StepContract,
} from "./pipeline-dsl.ts";

/* ── Pipeline step contract types ── */

/**
 * Re-exported from `pipeline-contracts.ts` for cross-module consumption by
 * the orchestration engine, step implementations, and test fixtures.
 *
 * PatternReport / FailurePattern          — pattern_extract step outputs
 * ConvergenceReport                      — convergence_analyze step output
 * CalibrationReport / PerSeverityCalibration — threshold_calibrate step outputs
 * RuleEntry / DynamicRulesPayload         — dynamic_rules_inject step outputs
 * AbTestBreakdown / AbTestResult         — ab_validate step outputs
 *
 * Note: EarlyStopDecision is defined directly in this module and is not
 * re-exported from pipeline-contracts.ts to avoid name collision.
 */
export type {
  FailurePattern,
  PatternReport,
  ConvergenceReport,
  PerSeverityCalibration,
  CalibrationReport,
  RuleEntry,
  DynamicRulesPayload,
  AbTestBreakdown,
  AbTestResult,
} from "./pipeline-contracts.ts";
