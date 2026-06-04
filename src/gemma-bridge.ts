#!/usr/bin/env bun
/**
 * Gemma ↔ diff-critic bridge protocol.
 *
 * Abstracts local Gemma 4 12B inference behind a GemmaClient interface so the
 * diff-critic pipeline can invoke it or fall back to Claude/SDK based on
 * configurable cost/latency/confidence thresholds.
 *
 * Depends on:
 *   - src/types.ts  — DiffCriticFinding, DcSeverity
 *
 * See also:
 *   - src/diff-critic.ts  — existing evaluation pipeline (integration target)
 *   - src/gemma-local.ts  — Ollama-based Gemma inference (PR #71, one concrete client)
 */

import type { DiffCriticFinding, DcSeverity } from "./types.ts";

/* ──────────────────────────────────────────────────────────────────────────────
 * Config
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Evaluation configuration controlling latency budget, context-window
 * utilisation, confidence floor, and fallback behaviour.
 *
 * Fields:
 *   maxLatencyMs         — Hard ceiling for a single Gemma invocation (ms).
 *                          Exceeding this triggers fallback.
 *   tokenBudgetPerSlice  — Tokens budgeted for the *input* side of one slice
 *                          (prompt + diff).  The 32K total window must also
 *                          accommodate ~4K for the output.
 *   confidenceThreshold  — Aggregate confidence below which the result is
 *                          considered unreliable.
 *   fallbackOnUncertain  — If `true`, results below `confidenceThreshold`
 *                          automatically route to the SDK fallback path.
 *   modelParams          — Optional overrides for temperature, top-p, max
 *                          output tokens passed to the inference endpoint.
 */
export interface GemmaEvalConfig {
  maxLatencyMs: number;
  tokenBudgetPerSlice: number;
  confidenceThreshold: number;
  fallbackOnUncertain: boolean;
  modelParams?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  };
}

/**
 * Default evaluation configuration targeting:
 *   - 15 s max latency (Gemma 4 12B on a consumer GPU typically completes
 *     medium-sized diffs in 3–12 s)
 *   - 28 K token input budget (4 K reserved for output from a 32 K window)
 *   - 0.6 confidence floor (moderate threshold — favours catching regressions
 *     over silencing noise)
 *   - fallback enabled (pessimistic: uncertain → route to Claude)
 */
export const DEFAULT_GEMMA_CONFIG: GemmaEvalConfig = {
  maxLatencyMs: 15_000,
  tokenBudgetPerSlice: 28_000,
  confidenceThreshold: 0.6,
  fallbackOnUncertain: true,
  modelParams: {
    temperature: 0.1,
    topP: 0.9,
    maxTokens: 2048,
  },
};

/* ──────────────────────────────────────────────────────────────────────────────
 * Per-finding & aggregate result types
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Per-finding result produced by the bridge, extending the standard
 * DiffCriticFinding with a confidence score and slice-level provenance.
 */
export interface GemmaSliceFinding extends DiffCriticFinding {
  /** Confidence in the 0–1 range (severity-derived heuristic). */
  confidence: number;
  /** Metadata about the diff slice this finding was extracted from. */
  sliceMeta: GemmaSliceMeta;
}

export interface GemmaSliceMeta {
  sliceIndex: number;
  totalSlices: number;
  charsInSlice: number;
}

/**
 * Aggregate evaluation result wrapping all per-slice findings together with
 * performance telemetry and a fallback flag for downstream routing.
 *
 * When a diff is too large for a single slice the bridge runs multiple
 * invocations; `findings` is the merged list across all slices.  The top-level
 * `confidence` is the *minimum* confidence across all findings (pessimistic
 * aggregation — a single low-confidence finding casts doubt on the whole eval).
 */
export interface GemmaEvalResult {
  findings: GemmaSliceFinding[];
  rawOutput: string;
  latencyMs: number;
  tokenEstimate: number;
  /** Aggregate confidence (minimum across findings). */
  confidence: number;
  /** `true` if this result was routed to the fallback (Claude/SDK) path. */
  fallback: boolean;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * GemmaClient abstraction
 * ──────────────────────────────────────────────────────────────────────────── */

/** Raw output from a single Gemma invocation. */
export interface GemmaClientOutput {
  text: string;
  latencyMs: number;
}

/**
 * Abstract interface for Gemma inference.
 *
 * Any concrete implementation (Ollama-based, local binary, remote API) can be
 * swapped in without changing the bridge logic, enabling isolated testing with
 * mocks.
 *
 * @see src/gemma-local.ts — one concrete implementation via Ollama REST API
 */
export interface GemmaClient {
  generate(prompt: string): Promise<GemmaClientOutput>;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Diff-review dimension taxonomy
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The dimension taxonomy injected into the prompt by `formatDiffSlice`.
 *
 * It intentionally mirrors the dimensions used by the existing Claude-based
 * diff-critic pipeline so that findings across the two sources are directly
 * comparable in structure.
 */
const DIFF_REVIEW_DIMENSIONS: readonly string[] = [
  "类型退化 Type Regression",
  "过度抽象 Over-Abstraction",
  "模板重复 Template Duplication",
  "不合理嵌套 Unreasonable Nesting",
  "幻觉检测 Hallucination Detection",
  "安全越狱 Security Jailbreak",
] as const;

/* ──────────────────────────────────────────────────────────────────────────────
 * Input formatting
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Format a raw diff string for Gemma consumption.
 *
 * Strategy:
 *   1. Build the full prompt header (dimension taxonomy + format instructions).
 *   2. If the diff fits within `tokenBudgetPerSlice` (roughly ≈4× chars) the
 *      whole diff is included verbatim.
 *   3. Otherwise the middle section is discarded and replaced with a truncation
 *      marker, preserving the head and tail of the diff (most informative for
 *      review).
 */
export function formatDiffSlice(
  diffContent: string,
  config: GemmaEvalConfig = DEFAULT_GEMMA_CONFIG,
): string {
  const dimensionLines = DIFF_REVIEW_DIMENSIONS
    .map((d) => `  - [ ] ${d}`)
    .join("\n");

  const header = [
    "You are a code review assistant. Analyze the following diff and produce",
    "findings for each applicable dimension.",
    "",
    "## Dimensions",
    dimensionLines,
    "",
    "For each finding, output exactly one line in this format:",
    "- [severity] dimension: message",
    "",
    "Where severity is one of: info, warning, blocker.",
    "If a dimension has no finding for this diff, skip it — do not list it with",
    "a 'no issue' message.",
    "",
    "## Diff",
    "```diff",
  ].join("\n");

  const footer = "\n```";

  // Rough char budget: 1 token ≈ 4 characters for English + code text.
  const charBudget = config.tokenBudgetPerSlice * 4;
  const overhead = header.length + footer.length + 200; // 200-char safety margin
  const maxBody = Math.max(charBudget - overhead, 200);

  let body: string;
  if (diffContent.length <= maxBody) {
    body = diffContent;
  } else {
    // Preserve head (one third) and tail (two thirds) — the head shows
    // context, the tail usually contains the actual changed hunks.
    const headLen = Math.floor(maxBody * 0.33);
    const tailLen = maxBody - headLen - "... [diff truncated …] ".length;
    body =
      diffContent.slice(0, headLen) +
      "\n… [diff truncated …] \n" +
      diffContent.slice(-tailLen);
  }

  return `${header}${body}${footer}`;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Output parsing
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Regex matching the canonical finding line format:
 *   `- [severity] dimension: message`
 *
 * This mirrors the parser in src/diff-critic.ts but is intentionally simpler
 * (no AI-code-generation-specific prefix matching) because Gemma is prompted
 * with the generic dimension taxonomy directly.
 */
const GEMMA_FINDING_LINE_RE =
  /^\s*-\s*\[(info|warning|blocker)\]\s*(.+?):\s*(.+)$/i;

/** Fallback regex capturing any line beginning with `-[severity]` regardless of
 * dimension presence — catches malformed or extra-verbose output. */
const GEMMA_FALLBACK_LINE_RE =
  /^\s*-\s*\[(info|warning|blocker)\]\s*(.+)$/i;

/**
 * Parse raw Gemma output into structured findings.
 *
 * Strategy:
 *   1. Try the canonical format first (`GEMMA_FINDING_LINE_RE`).
 *   2. If a line has a severity bracketed prefix but no colon-separated
 *      dimension, fall back to `GEMMA_FALLBACK_LINE_RE` and label the
 *      dimension `"other"`.
 *   3. Lines that match neither pattern are silently skipped (Gemma may
 *      produce explanatory text around the structured findings).
 *
 * @param raw      — Raw text output from a Gemma invocation.
 * @param sliceMeta — Metadata about the diff slice from which this output was
 *                    generated (index, total-chunks, byte-length).
 */
export function parseGemmaOutput(
  raw: string,
  sliceMeta: GemmaSliceMeta,
): GemmaSliceFinding[] {
  const findings: GemmaSliceFinding[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let m = trimmed.match(GEMMA_FINDING_LINE_RE);
    if (m) {
      findings.push({
        dimension: m[2].trim(),
        severity: m[1].toLowerCase() as DcSeverity,
        message: m[3].trim(),
        confidence: estimateConfidence(m[1].toLowerCase() as DcSeverity),
        sliceMeta,
      });
      continue;
    }

    // Fallback: line has "[severity]" but no "dimension:" structure.
    m = trimmed.match(GEMMA_FALLBACK_LINE_RE);
    if (m) {
      findings.push({
        dimension: "other",
        severity: m[1].toLowerCase() as DcSeverity,
        message: m[2].trim(),
        confidence: estimateConfidence(m[1].toLowerCase() as DcSeverity) * 0.7, // penalised for format drift
        sliceMeta,
      });
    }
    // Non-matching lines (explanatory text, empty lines) are silently skipped.
  }

  return findings;
}

/**
 * Heuristic confidence estimator based on severity.
 *
 *   blocker → 0.8  (high — concrete, actionable)
 *   warning → 0.5  (moderate — plausible but not definitive)
 *   info    → 0.3  (low — contextual, may be noise)
 *
 * These are intentionally conservative; as real-world confidence calibration
 * data accumulates the function can be extended with message-keyword boosting
 * or a learned scoring model.
 */
function estimateConfidence(severity: DcSeverity): number {
  switch (severity) {
    case "blocker":
      return 0.8;
    case "warning":
      return 0.5;
    case "info":
      return 0.3;
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Fallback decision
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Decide whether a Gemma evaluation result should be discarded in favour of a
 * Claude/SDK fallback evaluation.
 *
 * Returns `true` (→ fall back) when:
 *   1. `fallbackOnUncertain` is enabled **and** the aggregate confidence is
 *      below the configured threshold.
 *   2. The actual latency exceeded `maxLatencyMs` (potential stall or
 *      degraded inference speed).
 *
 * The caller is responsible for triggering the actual fallback invocation.
 *
 * @example
 * ```ts
 * const result = await evaluateViaGemma(diff, config);
 * if (shouldFallbackToClaude(result, config)) {
 *   result = await evaluateViaClaude(diff);  // SDK fallback path
 * }
 * ```
 */
export function shouldFallbackToClaude(
  result: GemmaEvalResult,
  config: GemmaEvalConfig = DEFAULT_GEMMA_CONFIG,
): boolean {
  if (config.fallbackOnUncertain && result.confidence < config.confidenceThreshold) {
    return true;
  }
  if (result.latencyMs > config.maxLatencyMs) {
    return true;
  }
  return false;
}
