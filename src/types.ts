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
  mergeStatus?: "not_requested" | "queued" | "merged" | "failed" | "skipped";
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
