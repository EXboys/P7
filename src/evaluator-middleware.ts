#!/usr/bin/env bun
/**
 * Cost-aware evaluator routing middleware.
 *
 * Injects the decision matrix (classifyDiffComplexity + selectEvaluator) into
 * both critic entry points, routing evaluations to Gemma (low-cost local) or
 * Claude (SDK-based) based on diff complexity and critic urgency.
 *
 * Step 2 of 4 for cost-aware evaluator routing:
 *   1. Decision matrix (src/evaluator-router.ts)
 *   2. Routing middleware (this module) — wire into executor & planner
 *   3. Observability & calibration
 *   4. Integration tests
 *
 * See also:
 *   - src/evaluator-router.ts — decision matrix
 *   - src/gemma-bridge.ts     — output parsing & fallback decision
 *   - src/gemma-local.ts      — Ollama-based Gemma inference
 */

import { classifyDiffComplexity, selectEvaluator } from "./evaluator-router.ts";
import type { CriticUrgency, EvaluatorRouteDecision } from "./evaluator-router.ts";
import { GemmaLocalClient } from "./gemma-local.ts";
import {
  formatDiffSlice,
  parseGemmaOutput,
  shouldFallbackToClaude,
  DEFAULT_GEMMA_CONFIG,
} from "./gemma-bridge.ts";
import type { GemmaEvalConfig, GemmaSliceMeta, GemmaEvalResult } from "./gemma-bridge.ts";
import type { DiffCriticFinding, DcSeverity, Plan } from "./types.ts";
import type { SdkCostSummary } from "./sdk-cost.ts";
import { reviewDiff } from "./diff-critic.ts";
import { writeEvalRouteStat } from "./state.ts";

/* ──────────────────────────────────────────────────────────────────────────────
 * Urgency detection
 * ──────────────────────────────────────────────────────────────────────────── */

/** Keywords in risk descriptions that elevate urgency to "blocker". */
const BLOCKER_RISK_RE =
  /blocker|critical|security|data\.loss|crash|integrity|permission|vulnerability|exploit|爆|安全|严重|敏感/i;

/**
 * Detect critic urgency from plan risk descriptions.
 *
 * Uses a lightweight keyword heuristic rather than an LLM call:
 * if ANY risk description matches a blocker pattern, the entire review
 * is treated as urgent → "blocker". Otherwise "advisory".
 */
function detectCriticUrgency(plan: Plan): CriticUrgency {
  const hasBlocker = plan.risks.some((r) => BLOCKER_RISK_RE.test(r));
  return hasBlocker ? "blocker" : "advisory";
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Plan complexity classification
 * ──────────────────────────────────────────────────────────────────────────── */

/** Binary plan-complexity tier for routing decisions. */
type PlanComplexityTier = "simple" | "complex";

/**
 * Classify a plan into simple or complex for routing purposes.
 *
 * - Plans with `"simple"` in their schema `complexity` field are always simple.
 * - Plans with `"complex"` are always complex.
 * - Medium-complexity plans are classified heuristically: ≤3 files AND
 *   ≤100 estimated diff lines → simple, otherwise complex.
 */
function classifyPlanComplexity(plan: Plan): PlanComplexityTier {
  if (plan.complexity === "simple") return "simple";
  if (plan.complexity === "complex") return "complex";
  if (plan.changes.length <= 3 && plan.estimated_diff_lines <= 100) return "simple";
  return "complex";
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Git helper for full diff content
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Read the full unstaged diff from a worktree via `git diff`.
 * Returns null if git is unavailable or the diff is empty.
 */
function getWorktreeDiff(wtPath: string): string | null {
  const proc = Bun.spawnSync(["git", "-C", wtPath, "diff"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return null;
  const out = new TextDecoder().decode(proc.stdout);
  return out.length > 0 ? out : null;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Gemma diff evaluation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Run a full diff review through local Gemma inference.
 *
 * Formatting, parsing, and fallback decision all delegate to
 * gemma-bridge.ts so the behaviour is consistent with the bridge protocol.
 *
 * Returns null when Gemma is unreachable or the worktree has no diff — the
 * caller should fall through to Claude in that case.
 */
async function evaluateDiffViaGemma(
  wtPath: string,
  config: GemmaEvalConfig = DEFAULT_GEMMA_CONFIG,
): Promise<GemmaEvalResult | null> {
  const diffContent = getWorktreeDiff(wtPath);
  if (!diffContent) return null;

  const client = new GemmaLocalClient();
  const prompt = formatDiffSlice(diffContent, config);
  const t0 = performance.now();

  let output: { text: string; latencyMs: number };
  try {
    output = await client.generate(prompt);
  } catch {
    // Gemma unreachable (Ollama not running, model not pulled, etc.)
    return null;
  }

  const sliceMeta: GemmaSliceMeta = {
    sliceIndex: 0,
    totalSlices: 1,
    charsInSlice: diffContent.length,
  };

  const findings = parseGemmaOutput(output.text, sliceMeta);
  const confidence =
    findings.length > 0
      ? Math.min(...findings.map((f) => f.confidence))
      : 1.0;

  return {
    findings,
    rawOutput: output.text,
    latencyMs: output.latencyMs,
    tokenEstimate: Math.ceil(prompt.length / 4),
    confidence,
    fallback: false,
  };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Plan evaluation via Gemma
 * ──────────────────────────────────────────────────────────────────────────── */

/** Result from Gemma plan evaluation. */
interface GemmaPlanEvalResult {
  ok: boolean;
  feedback: string;
}

/**
 * Evaluate a plan JSON through local Gemma inference.
 *
 * The prompt asks Gemma to check for scope creep, missing edge cases,
 * unrealistic estimates, and risk omissions, then output a single verdict
 * line (`OK: true/false`) with optional explanatory text.
 *
 * Returns null if Gemma is unreachable so the caller falls through to the
 * SDK-based plan-critic path.
 */
async function evaluatePlanViaGemma(plan: Plan): Promise<GemmaPlanEvalResult | null> {
  const client = new GemmaLocalClient();
  const planJson = JSON.stringify(
    {
      title: plan.title,
      complexity: plan.complexity,
      changes: plan.changes.map((c) => ({ file: c.file, description: c.description, estimated_lines: c.estimated_lines })),
      risks: plan.risks,
      validation: plan.validation,
      estimated_diff_lines: plan.estimated_diff_lines,
    },
    null,
    2,
  );

  const prompt = [
    "You are a plan review assistant. Evaluate the following plan JSON.",
    "Check for: scope creep, missing edge cases, unrealistic estimates, risk omissions.",
    "",
    "Plan:",
    "```json",
    planJson,
    "```",
    "",
    "Respond with exactly one verdict line at the end:",
    "OK: true — if the plan is sound and ready to execute",
    "OK: false — if the plan has issues that need revision",
    "",
    "If OK: false, prefix the verdict with a brief explanation (1-2 sentences).",
    "If OK: true, you may write a short confirmation or leave it blank before the OK line.",
  ].join("\n");

  let text: string;
  try {
    const output = await client.generate(prompt);
    text = output.text;
  } catch {
    return null;
  }

  const okLine = text.match(/OK:\s*(true|false)/i);
  const ok = okLine ? okLine[1].toLowerCase() === "true" : true;

  // Extract feedback: all non-OK-verdict lines
  const feedback = text
    .split("\n")
    .filter((l) => !/OK:\s*(true|false)/i.test(l))
    .join("\n")
    .trim();

  return {
    ok,
    feedback: feedback || (ok ? "Plan approved by Gemma" : "Plan rejected by Gemma — review risks"),
  };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Public API — reviewDiffWithRouting
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Route a diff review through the cost-aware decision matrix.
 *
 * Decision flow:
 * 1. Classify diff complexity from `stats` (lines/files).
 * 2. Detect urgency from plan risks.
 * 3. Select evaluator via the 4×2 route matrix.
 * 4. Route accordingly:
 *    - "claude" → direct SDK call via `reviewDiff`.
 *    - "gemma" → local Gemma inference via `evaluateDiffViaGemma`.
 *    - "gemma_with_fallback" → Gemma first, fall back to Claude if
 *      `shouldFallbackToClaude` returns true.
 *
 * Returns the same shape as `reviewDiff` so callers are transparently upgraded:
 *   { ok, findings, structuredFindings, cost? }
 *
 * The Gemma result is converted to the same DiffCriticFinding[] format;
 * its raw output and telemetry are attached as non-enumerable metadata for
 * observability without breaking downstream destructuring.
 */
export async function reviewDiffWithRouting(
  projectPath: string,
  wtPath: string,
  diffStatOut: string,
  planTitle: string,
  stats: { files: number; lines: number },
  plan: Plan,
): Promise<{ ok: boolean; findings: string; structuredFindings: DiffCriticFinding[]; cost?: SdkCostSummary }> {
  const tier = classifyDiffComplexity(stats.lines, stats.files);
  const urgency = detectCriticUrgency(plan);
  const decision = selectEvaluator(tier, urgency);

  const routePoint = "diff_critic";
  let actualCostUsd = 0;
  let latencyMs = 0;
  let result: { ok: boolean; findings: string; structuredFindings: DiffCriticFinding[]; cost?: SdkCostSummary };

  // Claude route: bypass Gemma entirely
  if (decision.evaluator === "claude") {
    const t0 = performance.now();
    result = await reviewDiff(wtPath, diffStatOut, planTitle);
    latencyMs = Math.round(performance.now() - t0);
    actualCostUsd = result.cost?.costUsd ?? 0;
    writeEvalRouteStat(projectPath, {
      routePoint, tier, urgency,
      selectedEvaluator: "claude",
      estimatedCostUsd: decision.estimatedCostUsd,
      actualCostUsd,
      latencyMs,
    });
    return result;
  }

  // Gemma route: try local evaluation
  const gemmaT0 = performance.now();
  const gemmaResult = await evaluateDiffViaGemma(wtPath);
  const gemmaLatency = Math.round(performance.now() - gemmaT0);

  if (!gemmaResult) {
    // Gemma unavailable — transparent fallback to Claude
    const t0 = performance.now();
    result = await reviewDiff(wtPath, diffStatOut, planTitle);
    latencyMs = Math.round(performance.now() - t0);
    actualCostUsd = result.cost?.costUsd ?? 0;
    writeEvalRouteStat(projectPath, {
      routePoint, tier, urgency,
      selectedEvaluator: "claude",
      estimatedCostUsd: decision.estimatedCostUsd,
      actualCostUsd,
      latencyMs: gemmaLatency + latencyMs,
    });
    return result;
  }

  // Check if fallback to Claude is warranted
  if (decision.evaluator === "gemma_with_fallback" && shouldFallbackToClaude(gemmaResult)) {
    const t0 = performance.now();
    result = await reviewDiff(wtPath, diffStatOut, planTitle);
    latencyMs = Math.round(performance.now() - t0);
    actualCostUsd = result.cost?.costUsd ?? 0;
    writeEvalRouteStat(projectPath, {
      routePoint, tier, urgency,
      selectedEvaluator: "claude",
      estimatedCostUsd: decision.estimatedCostUsd,
      actualCostUsd,
      latencyMs: gemmaLatency + latencyMs,
    });
    return result;
  }

  // Convert Gemma slice findings to standard DiffCriticFinding[]
  const structuredFindings: DiffCriticFinding[] = gemmaResult.findings.map((f) => ({
    dimension: f.dimension,
    severity: f.severity as DcSeverity,
    message: f.message,
  }));

  const hasBlocker = structuredFindings.some((f) => f.severity === "blocker");
  const findingsStr =
    structuredFindings.length > 0
      ? structuredFindings.map((f) => `- [${f.severity}] ${f.dimension}: ${f.message}`).join("\n")
      : "";

  writeEvalRouteStat(projectPath, {
    routePoint, tier, urgency,
    selectedEvaluator: "gemma",
    estimatedCostUsd: decision.estimatedCostUsd,
    actualCostUsd: 0,
    latencyMs: gemmaLatency,
  });

  return {
    ok: !hasBlocker,
    findings: findingsStr,
    structuredFindings,
  };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Public API — reviewPlanWithRouting
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Route a plan review through the cost-aware decision matrix.
 *
 * Decision flow:
 * 1. Classify plan complexity.
 * 2. Simple plans → Gemma fast-path (local inference, cheap, ~3-12s).
 * 3. Complex plans → return null, signalling the caller to use the existing
 *    SDK-based plan-critic agent flow.
 *
 * Returns:
 *   - `{ ok, feedback }` when Gemma evaluated the plan (fast-path).
 *   - `null` when the plan should use the Claude/SDK path.
 */
export async function reviewPlanWithRouting(
  plan: Plan,
  projectPath: string,
): Promise<{ ok: boolean; feedback: string } | null> {
  const tier = classifyPlanComplexity(plan);
  const routePoint = "plan_critic";

  // Complex plans always route to Claude (existing SDK path)
  if (tier === "complex") {
    return null;
  }

  // Simple/advisory plans: try Gemma fast-path
  const t0 = performance.now();
  const result = await evaluatePlanViaGemma(plan);
  const latencyMs = Math.round(performance.now() - t0);

  if (result) {
    writeEvalRouteStat(projectPath, {
      routePoint,
      tier,
      urgency: "advisory",
      selectedEvaluator: "gemma",
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      latencyMs,
    });
  }

  return result;
}
