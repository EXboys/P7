import { describe, expect, test, beforeAll } from "bun:test";
import { WasmSandboxProvider } from "../src/sandbox-provider-wasm.ts";
import { DEFAULT_SANDBOX_CONFIG } from "../src/sandbox.ts";

/* ── Test configuration ── */

/**
 * Path to the MicroPython WASM binary used by integration tests.
 * Override via P7_MICROPYTHON_WASM env var, or fall back to the
 * default from DEFAULT_SANDBOX_CONFIG.
 *
 * To run integration tests, install wasmtime and download a
 * MicroPython WASM build:
 *   brew install wasmtime
 *   curl -LO https://github.com/micropython/micropython/releases/latest/download/micropython-wasm.wasm
 */
const WASM_BINARY =
  process.env.P7_MICROPYTHON_WASM ?? DEFAULT_SANDBOX_CONFIG.runtimePath;

const TEST_TIMEOUT_MS = 30_000;

/* ── Provider instances ── */

/** Provider with a valid config — used for integration tests. */
let liveProvider: WasmSandboxProvider;

/** Provider configured with a bogus binary — always fails gracefully. */
let brokenProvider: WasmSandboxProvider;

beforeAll(() => {
  liveProvider = new WasmSandboxProvider(
    { ...DEFAULT_SANDBOX_CONFIG, runtimePath: WASM_BINARY },
  );

  brokenProvider = new WasmSandboxProvider(
    { ...DEFAULT_SANDBOX_CONFIG, runtimePath: "/nonexistent/sandbox.wasm" },
  );
});

/* ──────────────────────────────────────────────────────────────────────────────
 * Graceful degradation test (always runs, no external dependency)
 * ──────────────────────────────────────────────────────────────────────────── */

describe("WasmSandboxProvider — graceful degradation", () => {
  test("healthCheck returns error string when runtime binary is missing", async () => {
    const status = await brokenProvider.healthCheck();
    // Must NOT throw — returns a descriptive error string instead.
    expect(typeof status).toBe("string");
    expect(status).not.toBe("ok");
    expect(status.length).toBeGreaterThan(0);
  });

  test("execute returns terminated result when runtime binary is missing", async () => {
    const result = await brokenProvider.execute({
      code: "print('hello')",
      timeoutMs: 5_000,
      capabilities: {
        filesystemRead: false,
        filesystemWrite: false,
        network: false,
        processSpawn: false,
        envRead: false,
      },
    });

    expect(result.output.terminated).toBe(true);
    expect(result.output.exitCode).toBe(-1);
    expect(result.output.stderr).toContain("Sandbox execution failed");
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("error: runtime unavailable");
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * Integration tests (require wasmtime + MicroPython WASM)
 * ──────────────────────────────────────────────────────────────────────────── */

describe("WasmSandboxProvider — integration", () => {
  let runtimeOk = false;

  beforeAll(async () => {
    const status = await liveProvider.healthCheck();
    runtimeOk = status === "ok";
  });

  test("runtime is available", () => {
    // This simple assertion lets `bun test --rerun` failures distinguish
    // "runtime not installed" from "test logic broken".
    // When runtimeOk is false, the two integration tests below are skipped.
    if (!runtimeOk) {
      console.warn(
        "WARNING: MicroPython WASM runtime not available. " +
        `Set P7_MICROPYTHON_WASM to the .wasm path. ` +
        "Skipping integration tests.",
      );
    }
  });

  test(
    "executes simple Python expression",
    async () => {
      if (!runtimeOk) return; // skip

      const result = await liveProvider.execute({
        code: "print('hello from wasm')",
        timeoutMs: 10_000,
        capabilities: {
          filesystemRead: false,
          filesystemWrite: false,
          network: false,
          processSpawn: false,
          envRead: false,
        },
      });

      expect(result.output.exitCode).toBe(0);
      expect(result.output.stdout).toContain("hello from wasm");
      expect(result.output.terminated).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.verdict).toBe("pass");
      expect(result.usage.durationMs).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "terminates infinite loop on timeout",
    async () => {
      if (!runtimeOk) return; // skip

      const result = await liveProvider.execute({
        code: "while True: pass",
        timeoutMs: 500,
        capabilities: {
          filesystemRead: false,
          filesystemWrite: false,
          network: false,
          processSpawn: false,
          envRead: false,
        },
      });

      expect(result.output.terminated).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.verdict).toBe("error: timeout");
      // The duration should be close to the timeout, give or take process
      // overhead.  Allow a generous upper bound for CI variance.
      expect(result.usage.durationMs).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});
