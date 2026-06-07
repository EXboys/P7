/**
 * Integration adapter types and helpers for injecting sandbox execution
 * into the pre-check and critic pipelines.
 *
 * This module bridges the generic SandboxResult / SandboxFinding types
 * (defined in sandbox.ts) with the pipeline-specific PreCheckFinding
 * and DiffCriticFinding types, enabling seamless wiring without
 * coupling the sandbox contract to either pipeline.
 *
 * @see sandbox.ts — core sandbox contract types
 * @see pre-check.ts — PreCheckFinding, PreCheckResult
 * @see types.ts — DiffCriticFinding, DcSeverity
 */

import type { SandboxFinding, SandboxInput, SandboxResult } from "./sandbox.ts";
import type { DiffCriticFinding } from "./types.ts";
import type { PreCheckFinding } from "./pre-check.ts";

/* ──────────────────────────────────────────────────────────────────────────────
 * Integration context types
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Context passed to a sandbox pre-check hook when a deterministic rule
 * flags suspicious code that warrants deeper sandbox analysis.
 *
 * `triggerRule` identifies which pre-check rule prompted the sandbox
 * invocation (e.g. "unsafe_eval", "shell_injection"). `suspiciousCode`
 * is the code snippet that triggered the rule. `originalFinding` may
 * be absent for sandbox-only rules that run independently.
 */
export interface PreCheckSandboxContext {
  /** The pre-check rule that triggered sandbox analysis, e.g. "unsafe_eval". */
  triggerRule: string;

  /** Code snippet or pattern that triggered the rule. */
  suspiciousCode: string;

  /** Optional original pre-check finding that prompted the sandbox run. */
  originalFinding?: PreCheckFinding;
}

/**
 * Context passed to a sandbox critic hook during diff or plan review.
 *
 * Provides the file path, code snippet, critic dimension, and the
 * reason the critic requests sandbox analysis (e.g. "run untrusted
 * script to verify output", "validate format transformation").
 */
export interface CriticSandboxContext {
  /** File path of the code being reviewed (relative to repo root). */
  filePath: string;

  /** Code snippet extracted from the diff for sandbox execution. */
  codeSnippet: string;

  /** Critic dimension requesting analysis, e.g. "security", "correctness". */
  dimension: string;

  /** Human-readable reason for the sandbox invocation. */
  reason: string;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Hook type aliases
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Pre-check sandbox hook signature.
 *
 * Returns a SandboxResult when sandbox execution is applicable and
 * successful, or null if the context cannot be handled (graceful
 * degradation — the pipeline continues without sandbox analysis).
 *
 * Callers MUST handle the null case correctly to avoid silently
 * skipping security checks.
 */
export type PreCheckSandboxHook = (
  context: PreCheckSandboxContext,
) => Promise<SandboxResult | null>;

/**
 * Critic sandbox hook signature.
 *
 * Returns a SandboxResult when sandbox execution is applicable and
 * successful, or null if the context cannot be handled (graceful
 * degradation — the critic proceeds with its usual LLM evaluation).
 *
 * Callers MUST handle the null case correctly to avoid silently
 * skipping security checks.
 */
export type CriticSandboxHook = (
  context: CriticSandboxContext,
) => Promise<SandboxResult | null>;

/* ──────────────────────────────────────────────────────────────────────────────
 * Type-level adapters: SandboxFinding ↔ PreCheckFinding / DiffCriticFinding
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Convert a SandboxFinding to a PreCheckFinding for pre-check pipeline
 * integration.
 *
 * Severity mapping:
 *   - "blocker" → "blocker"
 *   - "warning" | "info" → "warning"
 *
 * PreCheckFinding has no "info" severity, so info findings are elevated
 * to warning to ensure they are visible in the pre-check report rather
 * than silently dropped.
 *
 * @param finding — Sandbox finding from a sandbox execution.
 * @returns Equivalent PreCheckFinding with all fields mapped.
 */
export function sandboxFindingToPreCheck(finding: SandboxFinding): PreCheckFinding {
  return {
    rule: finding.rule,
    severity: finding.severity === "blocker" ? "blocker" : "warning",
    message: finding.message,
    detail: finding.detail,
  };
}

/**
 * Convert a SandboxFinding to a DiffCriticFinding for critic pipeline
 * integration.
 *
 * Maps severity directly (both use DcSeverity) and copies optional
 * file, line, and code fields when present. The `dimension` is always
 * set to "sandbox" for traceability.
 *
 * DiffCriticFinding does not have a `detail` field — when the sandbox
 * finding includes detail, it is appended to the message in parens.
 *
 * @param finding — Sandbox finding from a sandbox execution.
 * @returns Equivalent DiffCriticFinding with dimension "sandbox".
 */
export function sandboxFindingToCritic(finding: SandboxFinding): DiffCriticFinding {
  const msg = finding.detail
    ? `${finding.message} (${finding.detail})`
    : finding.message;

  return {
    dimension: "sandbox",
    severity: finding.severity,
    message: msg,
    file: finding.file,
    line: finding.line,
    code: finding.code,
  };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Formatting helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Format a sandbox execution summary string for pipeline logging or display.
 *
 * Produces a compact one-line summary in the format:
 * ```
 * sandbox [ok] 847ms, 0 findings
 * sandbox [blocked] timeout after 30000ms, 2 findings
 * ```
 *
 * The `ok`/`blocked` prefix matches the PreCheckResult.ok convention.
 *
 * @param result — The sandbox execution result to summarise.
 * @returns One-line summary string suitable for log output.
 */
export function formatSandboxSummary(result: SandboxResult): string {
  const status = result.ok ? "ok" : "blocked";
  const suffix = result.output.terminated ? " (terminated)" : "";
  return `sandbox [${status}] ${result.usage.durationMs}ms${suffix}, ${result.findings.length} findings`;
}

/**
 * Build a human-readable description of a SandboxInput for debugging or
 * audit logs.
 *
 * Example output:
 * ```
 * SandboxInput: code=123 chars, stdin=0 chars, timeout=30000ms, capabilities={filesystem:-,network:-,process:-,env:-}
 * ```
 *
 * @param input — The sandbox input to describe.
 * @returns Human-readable description string.
 */
export function describeSandboxInput(input: SandboxInput): string {
  const codeLen = input.code.length;
  const stdinLen = input.stdin?.length ?? 0;
  const caps = input.capabilities;

  const capsDesc = [
    `filesystem:${caps.filesystemRead ? "r" : "-"}${caps.filesystemWrite ? "w" : "-"}`,
    `network:${caps.network ? "+" : "-"}`,
    `process:${caps.processSpawn ? "+" : "-"}`,
    `env:${caps.envRead ? "+" : "-"}`,
  ].join(",");

  return `SandboxInput: code=${codeLen} chars, stdin=${stdinLen} chars, timeout=${input.timeoutMs}ms, capabilities={${capsDesc}}`;
}
