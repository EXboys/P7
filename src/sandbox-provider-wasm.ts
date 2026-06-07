#!/usr/bin/env bun
/**
 * Concrete SandboxProvider implementation using wasmtime + MicroPython WASM.
 *
 * Spawns `wasmtime run` with a MicroPython .wasm binary, pipes Python code
 * via stdin, enforces timeout via process supervision, and returns structured
 * SandboxResult with resource telemetry.
 *
 * ## Runtime requirements
 * - wasmtime CLI (≥v14 recommended for WASI preview 2 support)
 * - MicroPython WASM binary (wasi-preview1 or preview2 build)
 *
 * ## Graceful degradation
 * When the runtime binary or wasmtime is not found, execute() returns a
 * terminated result with the error message in stderr (never throws), and
 * healthCheck() returns a descriptive error string.
 *
 * @see SandboxProvider — interface contract (sandbox.ts)
 * @see SandboxConfig  — runtime configuration (sandbox.ts)
 */
import type {
  SandboxConfig,
  SandboxInput,
  SandboxProvider,
  SandboxResourceUsage,
  SandboxResult,
} from "./sandbox.ts";

/* ──────────────────────────────────────────────────────────────────────────────
 * Wasm-specific configuration
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Wasmtime-specific configuration for the WasmSandboxProvider.
 *
 * Controls the wasmtime binary path, extra CLI arguments, and WASI
 * compatibility flags. These are separate from SandboxConfig because
 * they are transport-level details, not sandbox contract semantics.
 */
export interface WasmProviderConfig {
  /** Path to the wasmtime executable (default: "wasmtime"). */
  wasmtimePath: string;

  /**
   * Extra CLI arguments passed to wasmtime **before** the `run` subcommand.
   * Use this for WASI version flags, e.g. `["--wasm", "wasi=preview1"]`.
   */
  wasmtimeArgs: string[];
}

const DEFAULT_WASM_CONFIG: WasmProviderConfig = {
  wasmtimePath: "wasmtime",
  wasmtimeArgs: [],
};

/* ──────────────────────────────────────────────────────────────────────────────
 * Provider
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * SandboxProvider powered by wasmtime + MicroPython WASM binary.
 *
 * ## Lifecycle
 * 1. Construct with a SandboxConfig (binary path, defaults) and optional
 *    WasmProviderConfig (wasmtime CLI path, extra args).
 * 2. Call `healthCheck()` to verify the runtime is reachable.
 * 3. Call `execute(input)` for each sandboxed Python execution.
 *
 * ## Resource isolation
 * Timeout is enforced via `Bun.sleep()` + `proc.kill(SIGKILL)`. Memory
 * hard-limiting is not yet implemented — the prototype only tracks
 * wall-clock duration. Full resource cgroups / wasmtime --wasi max-memory
 * integration is deferred to a hardened follow-up.
 *
 * ## Thread safety
 * Each `execute()` call spawns a fresh wasmtime process. Concurrent calls
 * are safe and fully isolated from each other.
 *
 * @example
 * ```ts
 * const provider = new WasmSandboxProvider({
 *   runtimePath: "/path/to/micropython.wasm",
 *   defaultTimeoutMs: 30_000,
 *   maxTimeoutMs: 60_000,
 *   captureOutput: true,
 *   scratchDir: "",
 * });
 *
 * const result = await provider.execute({
 *   code: "print(2 + 2)",
 *   timeoutMs: 10_000,
 *   capabilities: { filesystemRead: false, filesystemWrite: false, network: false, processSpawn: false, envRead: false },
 * });
 * console.log(result.output.stdout); // "4\n"
 * ```
 */
export class WasmSandboxProvider implements SandboxProvider {
  private readonly sandboxConfig: SandboxConfig;
  private readonly wasmConfig: WasmProviderConfig;

  constructor(
    sandboxConfig: SandboxConfig,
    wasmConfig?: Partial<WasmProviderConfig>,
  ) {
    this.sandboxConfig = sandboxConfig;
    this.wasmConfig = { ...DEFAULT_WASM_CONFIG, ...wasmConfig };
  }

  /* ── Provider identity ── */

  /**
   * Returns true when the runtime path looks like a MicroPython WASM binary:
   * ends with ".wasm" or contains "micropython" in the path string.
   */
  canHandle(runtimePath: string): boolean {
    return runtimePath.endsWith(".wasm") || runtimePath.includes("micropython");
  }

  /* ── Execution ── */

  async execute(input: SandboxInput): Promise<SandboxResult> {
    const startTime = performance.now();

    // Resolve effective timeout: use input spec or fall back to config default.
    const effectiveTimeoutMs =
      input.timeoutMs > 0
        ? input.timeoutMs
        : this.sandboxConfig.defaultTimeoutMs;

    // Cap at max to prevent accidental runaway.
    const timeoutMs = Math.min(
      effectiveTimeoutMs,
      this.sandboxConfig.maxTimeoutMs,
    );

    // ── Spawn wasmtime ──
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn(
        [
          this.wasmConfig.wasmtimePath,
          "run",
          "--dir=.",
          ...this.wasmConfig.wasmtimeArgs,
          this.sandboxConfig.runtimePath,
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    } catch (err: unknown) {
      return this.buildErrorResult(
        startTime,
        err instanceof Error ? err.message : String(err),
      );
    }

    // ── Write code to stdin ──
    // When stdin: "pipe", Bun returns a FileSink (not a WritableStream).
    // We write directly and end() to signal EOF so the process knows
    // there is no more input.
    try {
      const encoder = new TextEncoder();
      const stdin = proc.stdin as any;
      stdin.write(encoder.encode(input.code));
      if (input.stdin) {
        stdin.write(encoder.encode(input.stdin));
      }
      stdin.end();
    } catch {
      // stdin closed early or broken pipe — not fatal, the process will
      // still run (reading empty stdin) and produce output.
    }

    // ── Consume stdout / stderr concurrently ──
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];

    const readStdout = this.collectStream(
      proc.stdout as ReadableStream<Uint8Array> | undefined,
      stdoutChunks,
    );
    const readStderr = this.collectStream(
      proc.stderr as ReadableStream<Uint8Array> | undefined,
      stderrChunks,
    );

    // ── Timeout watchdog ──
    let terminated = false;
    const exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(timeoutMs).then(() => {
        terminated = true;
        proc.kill(9); // SIGKILL
        return null;
      }),
    ]);

    // Wait for stream readers to finish (they close when the process dies).
    await Promise.all([readStdout, readStderr]);

    const durationMs = Math.round(performance.now() - startTime);
    const stdout = this.decodeChunks(stdoutChunks);
    const stderr = this.decodeChunks(stderrChunks);

    const usage: SandboxResourceUsage = {
      durationMs,
      peakMemoryBytes: 0,
      cpuTimeMs: 0,
    };

    const ok = !terminated && exitCode === 0;

    return {
      output: {
        stdout,
        stderr,
        exitCode: exitCode ?? -1,
        terminated,
      },
      usage,
      findings: [],
      ok,
      verdict: this.buildVerdict(ok, terminated, exitCode, stderr),
    };
  }

  /* ── Health check ── */

  async healthCheck(): Promise<string> {
    try {
      const result = await this.execute({
        code: "print('ok')",
        timeoutMs: 10_000,
        capabilities: {
          filesystemRead: false,
          filesystemWrite: false,
          network: false,
          processSpawn: false,
          envRead: false,
        },
      });

      if (result.output.exitCode === 0 && result.output.stdout.trim() === "ok") {
        return "ok";
      }

      return [
        "health check failed:",
        `exitCode=${result.output.exitCode}`,
        `stdout="${result.output.stdout.trim()}"`,
        `stderr="${result.output.stderr.trim()}"`,
      ].join(" ");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `health check error: ${msg}`;
    }
  }

  /* ── Private helpers ── */

  /**
   * Drain a ReadableStream<Uint8Array> into a chunks array.
   * Resolves when the stream closes or errors.
   */
  private async collectStream(
    stream: ReadableStream<Uint8Array> | undefined,
    chunks: Uint8Array[],
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Concatenate Uint8Array chunks into a single UTF-8 string.
   */
  private decodeChunks(chunks: Uint8Array[]): string {
    if (chunks.length === 0) return "";
    if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
    const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }

  /**
   * Build a graceful-degradation error result when spawning fails.
   */
  private buildErrorResult(
    startTime: number,
    errorMessage: string,
  ): SandboxResult {
    const durationMs = Math.round(performance.now() - startTime);
    return {
      output: {
        stdout: "",
        stderr: `Sandbox execution failed: ${errorMessage}`,
        exitCode: -1,
        terminated: true,
      },
      usage: { durationMs, peakMemoryBytes: 0, cpuTimeMs: 0 },
      findings: [],
      ok: false,
      verdict: "error: runtime unavailable",
    };
  }

  /**
   * Build a verdict string matching the conventions in SandboxResult.verdict.
   */
  private buildVerdict(
    ok: boolean,
    terminated: boolean,
    exitCode: number | null,
    stderr: string,
  ): string {
    if (terminated) return "error: timeout";
    if (ok) return "pass";
    if (exitCode !== null && exitCode !== 0 && stderr.length > 0) {
      // Truncate the stderr excerpt to keep the verdict concise.
      const excerpt = stderr.trim().split("\n")[0].slice(0, 60);
      return `error: exit ${exitCode} — ${excerpt}`;
    }
    return `error: exit ${exitCode ?? -1}`;
  }
}
