#!/usr/bin/env bun
/**
 * Cost-aware evaluator routing decision matrix.
 *
 * Selects the optimal evaluator (gemma / gemma-with-fallback / claude) based on
 * diff complexity (lines + files) and critic urgency (blocker vs advisory).
 *
 * Step 1 of 4 for cost-aware evaluator routing:
 *   1. Decision matrix (this module)
 *   2. Wire into executor
 *   3. Observability & calibration
 *   4. Integration tests
 *
 * See also:
 *   - src/gemma-bridge.ts  — runtime fallback decision (shouldFallbackToClaude)
 *   - src/diff-critic.ts   — evaluation pipeline (integration target)
 */

/* ── Types ── */

/** Diff complexity tier based on lines changed and files touched. */
export type DiffComplexityTier = "trivial" | "small" | "medium" | "large";

/** Urgency level of the review — blocker findings gate the merge. */
export type CriticUrgency = "blocker" | "advisory";

/** Available evaluator choices for a given route. */
export type SelectedEvaluator = "gemma" | "gemma_with_fallback" | "claude";

/* ── Interfaces ── */

/**
 * Thresholds for classifying diff into complexity tiers.
 * A diff is classified by the highest tier whose maxLines AND maxFiles are both satisfied.
 */
export interface DiffComplexityThresholds {
  trivial: { maxLines: number; maxFiles: number };
  small: { maxLines: number; maxFiles: number };
  medium: { maxLines: number; maxFiles: number };
}

/** Estimated per-evaluator cost in US cents — used for explainability and future optimization. */
export interface EvaluatorCostProfile {
  gemma: number;
  gemma_with_fallback: number;
  claude: number;
}

/** 4×2 decision matrix mapping (DiffComplexityTier × CriticUrgency) → SelectedEvaluator. */
export type RouteMatrix = Record<DiffComplexityTier, Record<CriticUrgency, SelectedEvaluator>>;

/** Route decision result with evaluator choice, explainable reason, and estimated cost (USD). */
export interface EvaluatorRouteDecision {
  tier: DiffComplexityTier;
  urgency: CriticUrgency;
  evaluator: SelectedEvaluator;
  estimatedCostUsd: number;
  reason: string;
}

/* ── Defaults ── */

export const DEFAULT_DIFF_COMPLEXITY_THRESHOLDS: DiffComplexityThresholds = {
  trivial: { maxLines: 20, maxFiles: 1 },
  small: { maxLines: 80, maxFiles: 3 },
  medium: { maxLines: 250, maxFiles: 8 },
};

export const DEFAULT_EVALUATOR_COST_PROFILE: EvaluatorCostProfile = {
  gemma: 0.5,
  gemma_with_fallback: 2.0,
  claude: 8.0,
};

/**
 * Default 4×2 route matrix.
 *
 * Rationale:
 * - Trivial/small diffs: gemma is fully capable; fallback adds safety for blockers.
 * - Medium diffs: fallback baseline; blocker urgency escalates to claude for certainty.
 * - Large diffs: claude always — Gemma's 32K context window may be insufficient.
 */
export const DEFAULT_ROUTE_MATRIX: RouteMatrix = {
  trivial: { blocker: "gemma_with_fallback", advisory: "gemma" },
  small: { blocker: "gemma_with_fallback", advisory: "gemma" },
  medium: { blocker: "claude", advisory: "gemma_with_fallback" },
  large: { blocker: "claude", advisory: "claude" },
};

/* ── Classifier ── */

/**
 * Classify a diff into a complexity tier based on lines changed and files touched.
 *
 * Both conditions (lines AND files) must be satisfied to match a tier.
 * A single-file 200-line diff correctly classifies as "medium" (80→250 range)
 * rather than "trivial" or "small" based on file count alone.
 */
export function classifyDiffComplexity(
  lines: number,
  files: number,
  thresholds: DiffComplexityThresholds = DEFAULT_DIFF_COMPLEXITY_THRESHOLDS,
): DiffComplexityTier {
  if (lines <= thresholds.trivial.maxLines && files <= thresholds.trivial.maxFiles) return "trivial";
  if (lines <= thresholds.small.maxLines && files <= thresholds.small.maxFiles) return "small";
  if (lines <= thresholds.medium.maxLines && files <= thresholds.medium.maxFiles) return "medium";
  return "large";
}

/* ── Decision function ── */

/**
 * Select the optimal evaluator based on diff complexity and critic urgency.
 *
 * Returns a fully explainable decision record containing the chosen evaluator,
 * estimated cost (in USD), and a human-readable reason.
 */
export function selectEvaluator(
  tier: DiffComplexityTier,
  urgency: CriticUrgency,
  matrix: RouteMatrix = DEFAULT_ROUTE_MATRIX,
  costs: EvaluatorCostProfile = DEFAULT_EVALUATOR_COST_PROFILE,
): EvaluatorRouteDecision {
  const evaluator = matrix[tier][urgency];
  const estimatedCostUsd = costs[evaluator] / 100;
  const reasonMap: Record<SelectedEvaluator, string> = {
    gemma: `Diff "${tier}" / "${urgency}" → Gemma sufficient`,
    gemma_with_fallback: `Diff "${tier}" / "${urgency}" → Gemma + Claude fallback`,
    claude: `Diff "${tier}" / "${urgency}" → Claude required`,
  };
  return { tier, urgency, evaluator, estimatedCostUsd, reason: reasonMap[evaluator] };
}
