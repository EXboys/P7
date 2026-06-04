import { describe, expect, test } from "bun:test";
import {
  resolveBranchRoute,
  validateBranchCoverage,
  type StepRoute,
  type PipelineContext,
  type StepResult,
  type ConditionalStep,
} from "../src/pipeline-step.ts";

// ---------------------------------------------------------------------------
// resolveBranchRoute
// ---------------------------------------------------------------------------

describe("resolveBranchRoute", () => {
  const branches: StepRoute[] = [
    { key: "has_diff", next: "quality_gates" },
    { key: "empty", next: "retry_pass" },
    { key: "error", next: "notify_failure" },
    { key: "fanout_key", next: ["step_a", "step_b", "step_c"] },
  ];

  test("returns single target for a matched route key", () => {
    expect(resolveBranchRoute("has_diff", branches)).toBe("quality_gates");
    expect(resolveBranchRoute("empty", branches)).toBe("retry_pass");
  });

  test("returns fan-out array when the branch declares string[] next", () => {
    const result = resolveBranchRoute("fanout_key", branches);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(["step_a", "step_b", "step_c"]);
  });

  test("falls back to defaultBranch when route key is unknown", () => {
    const result = resolveBranchRoute("unknown_route", branches, "fallback_step");
    expect(result).toBe("fallback_step");
  });

  test("throws when route key is unknown and no defaultBranch is given", () => {
    expect(() => resolveBranchRoute("bogus", branches)).toThrow(
      'resolveBranchRoute: unknown route key "bogus"',
    );
  });

  test("preserves defaultBranch as-is for unmatched keys even when it is an array", () => {
    const result = resolveBranchRoute("nowhere", branches, ["cleanup", "abort"]);
    expect(result).toEqual(["cleanup", "abort"]);
  });
});

// ---------------------------------------------------------------------------
// validateBranchCoverage
// ---------------------------------------------------------------------------

describe("validateBranchCoverage", () => {
  const expected = ["has_diff", "empty", "error"];

  test("returns empty array when all expected keys are covered", () => {
    const branches: StepRoute[] = [
      { key: "has_diff", next: "quality_gates" },
      { key: "empty", next: "retry_pass" },
      { key: "error", next: "notify_failure" },
    ];
    expect(validateBranchCoverage(expected, branches)).toEqual([]);
  });

  test("returns missing keys when some expected keys are uncovered", () => {
    const branches: StepRoute[] = [
      { key: "has_diff", next: "quality_gates" },
    ];
    const missing = validateBranchCoverage(expected, branches);
    expect(missing).toEqual(["empty", "error"]);
  });

  test("is not fooled by defaultBranch — only checks branches array", () => {
    const branches: StepRoute[] = [
      { key: "has_diff", next: "quality_gates" },
    ];
    const missing = validateBranchCoverage(expected, branches, "fallback");
    // defaultBranch is not a branch declaration; "empty" and "error" remain uncovered
    expect(missing).toEqual(["empty", "error"]);
  });

  test("handles empty expected keys (nothing to validate)", () => {
    expect(validateBranchCoverage([], [])).toEqual([]);
  });

  test("reports all expected keys when branches is empty", () => {
    expect(validateBranchCoverage(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Integration scenario: SDK pass routing
// ---------------------------------------------------------------------------

describe("SDK pass routing integration scenario", () => {
  /**
   * Simulates the SDK pass branch decision:
   *
   *   ┌──────────┐
   *   │ sdk_pass │
   *   └────┬─────┘
   *        │
   *   ┌────┴────┐
   *   │ has_diff│─→ quality_gates
   *   │ empty   │─→ retry_pass
   *   └─────────┘
   */
  const branches: StepRoute[] = [
    { key: "has_diff", next: "quality_gates" },
    { key: "empty", next: "retry_pass" },
  ];

  // ConditionalStep that models the SDK pass step
  const sdkPassStep: ConditionalStep<"has_diff" | "empty"> = {
    name: "sdk_pass",
    branches,
    async execute(ctx: PipelineContext) {
      // Simplified: returns a route key based on whether context has diffs
      const diffs = ctx.results["diff_collector"] as string[] | undefined;
      return diffs && diffs.length > 0 ? "has_diff" : "empty";
    },
  };

  test("has_diff → quality_gates (single target)", async () => {
    const ctx: PipelineContext = {
      planId: "plan-001",
      stepName: "sdk_pass",
      results: { diff_collector: ["src/foo.ts:+5"] },
    };
    const routeKey = await sdkPassStep.execute(ctx);
    const next = resolveBranchRoute(routeKey, branches);
    expect(routeKey).toBe("has_diff");
    expect(next).toBe("quality_gates");
  });

  test("empty → retry_pass (single target)", async () => {
    const ctx: PipelineContext = {
      planId: "plan-002",
      stepName: "sdk_pass",
      results: { diff_collector: [] },
    };
    const routeKey = await sdkPassStep.execute(ctx);
    const next = resolveBranchRoute(routeKey, branches);
    expect(routeKey).toBe("empty");
    expect(next).toBe("retry_pass");
  });

  test("StepResult envelope shape from a completed step", () => {
    const result: StepResult<string[]> = {
      stepName: "diff_collector",
      output: ["src/bar.ts:-2", "src/bar.ts:+4"],
      route: "has_diff",
      durationMs: 1234,
    };
    expect(result.stepName).toBe("diff_collector");
    expect(Array.isArray(result.output)).toBe(true);
    expect(result.output).toContain("src/bar.ts:+4");
    expect(result.route).toBe("has_diff");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test("validateBranchCoverage for SDK pass scenario", () => {
    const expectedKeys = ["has_diff", "empty"];
    expect(validateBranchCoverage(expectedKeys, branches)).toEqual([]);
  });
});
