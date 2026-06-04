import { describe, expect, test } from "bun:test";
import {
  resolveBranchRoute,
  validateBranchCoverage,
  executeParallel,
  type StepRoute,
  type PipelineContext,
  type StepResult,
  type ConditionalStep,
  type SubstepConfig,
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

// ---------------------------------------------------------------------------
// executeParallel — concurrent sub-step execution
// ---------------------------------------------------------------------------

describe("executeParallel", () => {
  const ctx: PipelineContext = {
    planId: "test-plan",
    stepName: "parallel_test",
    results: {},
  };

  // -----------------------------------------------------------------------
  // Strategy: all
  // -----------------------------------------------------------------------

  describe("strategy 'all'", () => {
    test("returns success when every sub-step succeeds", async () => {
      const substeps: SubstepConfig[] = [
        { name: "a", execute: async () => "ok_a" },
        { name: "b", execute: async () => "ok_b" },
        { name: "c", execute: async () => "ok_c" },
      ];

      const result = await executeParallel(ctx, substeps, "all");
      expect(result.strategy).toBe("all");
      expect(result.success).toBe(true);
      expect(result.substepResults).toHaveLength(3);
      expect(result.substepResults.every((r) => r.status === "success")).toBe(true);
      expect(result.substepResults[0].output).toBe("ok_a");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("returns failure when any sub-step fails", async () => {
      const substeps: SubstepConfig[] = [
        { name: "good", execute: async () => "ok" },
        { name: "bad", execute: async () => { throw new Error("boom"); } },
        { name: "also_good", execute: async () => "ok" },
      ];

      const result = await executeParallel(ctx, substeps, "all");
      expect(result.success).toBe(false);
      const badResult = result.substepResults.find((r) => r.name === "bad")!;
      expect(badResult.status).toBe("failure");
      expect(badResult.error).toContain("boom");
      expect(result.substepResults.filter((r) => r.status === "success")).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Strategy: any
  // -----------------------------------------------------------------------

  describe("strategy 'any'", () => {
    test("returns success when at least one sub-step succeeds", async () => {
      const substeps: SubstepConfig[] = [
        { name: "fail1", execute: async () => { throw new Error("err1"); } },
        { name: "winner", execute: async () => "win" },
        { name: "fail2", execute: async () => { throw new Error("err2"); } },
      ];

      const result = await executeParallel(ctx, substeps, "any");
      expect(result.strategy).toBe("any");
      expect(result.success).toBe(true);
      expect(result.substepResults.some((r) => r.status === "success")).toBe(true);
    });

    test("returns failure when every sub-step fails", async () => {
      const substeps: SubstepConfig[] = [
        { name: "fail1", execute: async () => { throw new Error("err1"); } },
        { name: "fail2", execute: async () => { throw new Error("err2"); } },
      ];

      const result = await executeParallel(ctx, substeps, "any");
      expect(result.success).toBe(false);
      expect(result.substepResults.every((r) => r.status === "failure")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Strategy: race
  // -----------------------------------------------------------------------

  describe("strategy 'race'", () => {
    test("honours the first completed sub-step (success)", async () => {
      const substeps: SubstepConfig[] = [
        {
          name: "slow_fail",
          execute: async () => {
            await new Promise((r) => setTimeout(r, 50));
            throw new Error("too late");
          },
        },
        {
          name: "fast_win",
          execute: async () => "first_past",
        },
      ];

      const result = await executeParallel(ctx, substeps, "race");
      // fast_win completes first, so overall is success
      expect(result.success).toBe(true);
    });

    test("honours the first completed sub-step (failure)", async () => {
      const substeps: SubstepConfig[] = [
        {
          name: "fast_fail",
          execute: async () => {
            throw new Error("immediate");
          },
        },
        {
          name: "slow_win",
          execute: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return "late_success";
          },
        },
      ];

      const result = await executeParallel(ctx, substeps, "race");
      // fast_fail completes first, so overall is failure
      expect(result.success).toBe(false);
      const failResult = result.substepResults.find((r) => r.name === "fast_fail")!;
      expect(failResult.status).toBe("failure");
    });
  });

  // -----------------------------------------------------------------------
  // Strategy: quorum
  // -----------------------------------------------------------------------

  describe("strategy 'quorum'", () => {
    test("returns success when quorum is met", async () => {
      const substeps: SubstepConfig[] = [
        { name: "a", execute: async () => "ok" },
        { name: "b", execute: async () => "ok" },
        { name: "c", execute: async () => { throw new Error("fail"); } },
      ];

      // Require 2 of 3 — two succeed → quorum met
      const result = await executeParallel(ctx, substeps, "quorum", 2);
      expect(result.strategy).toBe("quorum");
      expect(result.success).toBe(true);
      expect(result.quorum).toEqual({ required: 2, achieved: 2 });
    });

    test("returns failure when quorum is not met", async () => {
      const substeps: SubstepConfig[] = [
        { name: "a", execute: async () => "ok" },
        { name: "b", execute: async () => { throw new Error("fail"); } },
        { name: "c", execute: async () => { throw new Error("fail"); } },
      ];

      // Require 2 of 3 — only one succeeds → quorum missed
      const result = await executeParallel(ctx, substeps, "quorum", 2);
      expect(result.success).toBe(false);
      expect(result.quorum).toEqual({ required: 2, achieved: 1 });
    });

    test("defaults quorum to ceil(N/2)+1 when argument omitted", async () => {
      // For 3 substeps: ceil(3/2)+1 = 2+1 = 3. So all 3 must pass.
      const substeps: SubstepConfig[] = [
        { name: "a", execute: async () => "ok" },
        { name: "b", execute: async () => "ok" },
        { name: "c", execute: async () => { throw new Error("fail"); } },
      ];

      const result = await executeParallel(ctx, substeps, "quorum");
      expect(result.success).toBe(false);
      expect(result.quorum).toEqual({ required: 3, achieved: 2 });
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    test("empty sub-steps list returns immediate success", async () => {
      const result = await executeParallel(ctx, [], "all");
      expect(result.success).toBe(true);
      expect(result.substepResults).toHaveLength(0);
      expect(result.durationMs).toBe(0);
    });

    test("per-sub-step timeout triggers 'timeout' status", async () => {
      const substeps: SubstepConfig[] = [
        {
          name: "tardy",
          execute: async () => {
            await new Promise((r) => setTimeout(r, 200));
            return "too_late";
          },
          timeoutMs: 20,
        },
      ];

      const result = await executeParallel(ctx, substeps, "all");
      const tardy = result.substepResults[0];
      expect(tardy.status).toBe("timeout");
      expect(tardy.error).toContain("timed out");
      expect(tardy.name).toBe("tardy");
      expect(tardy.output).toBeUndefined();
    });

    test("single sub-step with all strategy", async () => {
      const substeps: SubstepConfig[] = [
        { name: "solo", execute: async () => 42 },
      ];

      const result = await executeParallel(ctx, substeps, "all");
      expect(result.success).toBe(true);
      expect(result.substepResults[0].output).toBe(42);
    });
  });
});
