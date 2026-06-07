/**
 * Core sandbox contract types and SandboxProvider interface for
 * sandboxed Python code execution via MicroPython+WASM.
 *
 * This module defines the input/output contracts, capability model,
 * finding taxonomy, and provider interface used by pre-check and
 * critic pipeline stages to invoke safe Python execution.
 *
 * Design follows existing patterns:
 *  - Provider interface mirrors VcsProvider (vcs/types.ts)
 *  - Finding types align with PreCheckFinding / DiffCriticFinding
 *  - Default constants follow DEFAULT_PRE_CHECK_CONFIG convention
 *  - Resource usage pattern follows SdkTokenUsage (sdk-cost.ts)
 *
 * @see PreCheckFinding — pre-check finding type (pre-check.ts)
 * @see DiffCriticFinding — diff-critic finding type (types.ts)
 * @see VcsProvider — strategy/provider pattern (vcs/types.ts)
 */

import type { DcSeverity } from "./types.ts";

/* ──────────────────────────────────────────────────────────────────────────────
 * Sandbox capability flags (WASI capability model)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * WASI capability flags that govern what a sandboxed execution may access.
 *
 * Each flag corresponds to a WASI capability group. The restrictive default
 * (DEFAULT_SANDBOX_CAPABILITY) enables only clock + fd_write (stdout/stderr).
 *
 * When WASI preview 2 matures, these flags may be remapped to component-model
 * capability sets, but the semantic contract remains stable.
 */
export interface SandboxCapability {
  /** Allow filesystem read access (preview 2: wasi:filesystem). */
  filesystemRead: boolean;
  /** Allow filesystem write access (implies read). */
  filesystemWrite: boolean;
  /** Allow network access (preview 2: wasi:socket). */
  network: boolean;
  /** Allow spawning sub-processes (WASI: spawn). */
  processSpawn: boolean;
  /** Allow environment variable access. */
  envRead: boolean;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Input / Output contracts
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Input payload for a single sandboxed Python execution.
 *
 * The caller provides the code to execute, optional stdin content,
 * a timeout in milliseconds, and the capability set the runtime
 * should enforce.
 */
export interface SandboxInput {
  /** Python source code to execute. */
  code: string;
  /** Optional stdin content piped to the executed code. */
  stdin?: string;
  /** Execution timeout in milliseconds (default derived from SandboxConfig.defaultTimeoutMs). */
  timeoutMs: number;
  /** Capability flags the runtime must enforce (default DEFAULT_SANDBOX_CAPABILITY). */
  capabilities: SandboxCapability;
}

/**
 * Raw output from a single sandboxed execution.
 *
 * Contains the captured stdout/stderr streams, the process exit code,
 * and a flag indicating whether the execution was terminated by a
 * watchdog timeout before the code completed naturally.
 */
export interface SandboxOutput {
  /** Captured stdout content. */
  stdout: string;
  /** Captured stderr content. */
  stderr: string;
  /** Process exit code (0 for success, non-zero for error). */
  exitCode: number;
  /** true if the watchdog timeout killed the execution before it completed. */
  terminated: boolean;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Resource usage telemetry
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Resource consumption metrics for a single sandbox execution.
 *
 * This type follows the same pattern as SdkTokenUsage in sdk-cost.ts
 * and is embedded in SandboxResult for observability and cost tracking.
 */
export interface SandboxResourceUsage {
  /** Wall-clock execution time in milliseconds. */
  durationMs: number;
  /** Peak memory usage in bytes (0 if unavailable from the runtime). */
  peakMemoryBytes: number;
  /** CPU time in milliseconds (0 if unavailable from the runtime). */
  cpuTimeMs: number;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Finding types (aligned with PreCheckFinding / DiffCriticFinding)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A single finding produced by sandbox analysis of executed code.
 *
 * Severity aligns with DcSeverity for consistent pipeline handling.
 * The `rule` field mirrors the pattern established by PreCheckFinding.
 * Optional `file`, `line`, `code` fields match DiffCriticFinding for
 * downstream integration when the finding maps to source locations.
 */
export interface SandboxFinding {
  /**
   * Rule identifier, e.g.:
   *  - "sandbox_infinite_loop"   — non-terminating loop detected
   *  - "sandbox_file_access"    — unauthorised filesystem access
   *  - "sandbox_network_call"   — network call from sandboxed code
   *  - "sandbox_restricted_api" — use of a blocked built-in function
   */
  rule: string;

  /** Severity aligned with DcSeverity for consistent pipeline handling. */
  severity: DcSeverity;

  /** Human-readable summary of the finding. */
  message: string;

  /** Optional contextual detail (e.g. what was accessed, call stack excerpt). */
  detail?: string;

  /** Source file where the issue was detected (optional, matches DiffCriticFinding.file). */
  file?: string;

  /** Line number in the source file (optional, matches DiffCriticFinding.line). */
  line?: number;

  /** Code snippet or symbol name (optional, matches DiffCriticFinding.code). */
  code?: string;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Aggregate result
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Enriched sandbox execution result combining raw output with analysis findings.
 *
 * - `ok` follows the PreCheckResult convention: true when no blocker findings exist.
 * - `verdict` provides a concise summary for pipeline decision-making.
 */
export interface SandboxResult {
  /** Raw execution output (stdout, stderr, exit code, termination flag). */
  output: SandboxOutput;

  /** Resource consumption telemetry. */
  usage: SandboxResourceUsage;

  /** Analysis findings from the executed code. */
  findings: SandboxFinding[];

  /** true when no blocker findings exist (warnings and info findings alone do not fail). */
  ok: boolean;

  /**
   * Concise verdict string for pipeline logging, e.g.:
   *  - "pass"                    — no issues detected
   *  - "blocked: infinite loop"  — blocker finding present
   *  - "error: timeout"          — execution was terminated
   *  - "error: runtime crash"    — non-zero exit without findings
   */
  verdict: string;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Configuration
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Sandbox runtime configuration.
 *
 * `runtimePath` points to the MicroPython+WASM executable or wrapper script.
 * Defaults are defined in DEFAULT_SANDBOX_CONFIG and may be overridden
 * per-invocation through the pipeline config or environment setup.
 */
export interface SandboxConfig {
  /** Path to the sandbox runtime executable (e.g. "micropython-wasm" or a full path). */
  runtimePath: string;

  /** Default execution timeout in milliseconds (recommended: 30_000). */
  defaultTimeoutMs: number;

  /** Maximum allowed timeout in milliseconds — hard cap enforced by the provider (recommended: 60_000). */
  maxTimeoutMs: number;

  /** Whether to enable stdout/stderr capture (disable for headless execution). */
  captureOutput: boolean;

  /**
   * Path to a temporary directory for scratch files.
   * Empty string means "use the system temporary directory".
   */
  scratchDir: string;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Provider interface
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * SandboxProvider interface for executing Python code in a sandboxed runtime.
 *
 * Follows the same strategy/provider pattern as VcsProvider (vcs/types.ts):
 * a small interface with a guard method (`canHandle`) and the primary action
 * method (`execute`). Concrete implementations (e.g. MicroPythonWasmProvider,
 * DockerProvider) register themselves and are selected by the caller.
 *
 * The `healthCheck` method returns a status string — "ok" when the runtime
 * is reachable and functional, or an error description otherwise.
 */
export interface SandboxProvider {
  /**
   * Returns true if this provider can handle the given runtime path or
   * configuration string (e.g. matching a binary name or URL scheme such
   * as "micropython-wasm" or a custom executable path).
   */
  canHandle(runtimePath: string): boolean;

  /**
   * Execute Python code in a sandboxed environment with the given input.
   *
   * Implementations MUST:
   *  - Respect `input.timeoutMs` via a watchdog timer
   *  - Enforce `input.capabilities` at the WASI or OS level when supported
   *  - Set `output.terminated` when the watchdog kills the process
   *  - Never block indefinitely (always use the watchdog as a safety net)
   *
   * @param input — Complete execution input (code, capabilities, timeout).
   * @returns SandboxResult with raw output, resource usage, and findings.
   */
  execute(input: SandboxInput): Promise<SandboxResult>;

  /**
   * Check that the sandbox runtime is installed and functional.
   *
   * Implementations should verify the runtime binary exists, is executable,
   * and can start (e.g. by running a trivial "print('ok')" snippet or
   * checking the binary's --version output).
   *
   * @returns "ok" when healthy, or an error description string.
   */
  healthCheck(): Promise<string>;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Defaults
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Restrictive default capability set — no filesystem, no network, no sub-processes,
 * no environment variables. Only clock and fd_write (stdout/stderr) are permitted.
 *
 * This aligns with the security evaluation report's recommendation (PR #142)
 * to start with the most restrictive profile and open capabilities selectively
 * per use case.
 */
export const DEFAULT_SANDBOX_CAPABILITY: SandboxCapability = {
  filesystemRead: false,
  filesystemWrite: false,
  network: false,
  processSpawn: false,
  envRead: false,
};

/**
 * Default sandbox configuration.
 *
 * - `runtimePath` is a placeholder — concrete implementations should
 *   override it in their own config or environment setup.
 * - `defaultTimeoutMs` of 30s matches the watchdog deadline recommended
 *   in the security evaluation report.
 * - `maxTimeoutMs` of 60s provides headroom for legitimate long-running
 *   analysis while preventing runaway execution.
 * - `captureOutput` is enabled by default for audit logging.
 * - `scratchDir` is empty (use system tmp) by default.
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  runtimePath: "micropython-wasm",
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 60_000,
  captureOutput: true,
  scratchDir: "",
};
