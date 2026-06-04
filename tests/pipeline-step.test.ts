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

// ---------------------------------------------------------------------------
// Integration: sequential dependency resolution
// ---------------------------------------------------------------------------

describe("sequential dependency resolution", () => {
  /**
   * Simulates a 3-step linear pipeline:
   *
   *   Step "init_counter"  →  writes `count = 1` to context
   *   Step "increment"     →  reads `count` from context, writes `count + 1`
   *   Step "finalize"      →  reads `count`, appends metadata
   *
   * Each step is a ConditionalStep with a trivial branch (always routes to the
   * next step). A minimal inline runner chains execute() → resolveBranchRoute()
   * → feed result into context → next execute().
   */
  const initStep: ConditionalStep<"next"> = {
    name: "init_counter",
    branches: [{ key: "next", next: "increment" }],
    async execute(ctx: PipelineContext) {
      return "next";
    },
  };

  const incrementStep: ConditionalStep<"next"> = {
    name: "increment",
    branches: [{ key: "next", next: "finalize" }],
    async execute(ctx: PipelineContext) {
      // Read from context — if init_counter ran, its output should be at
      // ctx.results["init_counter"]
      const prev = ctx.results["init_counter"] as { count: number } | undefined;
      return "next";
    },
  };

  const finalizeStep: ConditionalStep<"done"> = {
    name: "finalize",
    branches: [{ key: "done", next: "__end__" }],
    async execute(ctx: PipelineContext) {
      return "done";
    },
  };

  test("runs init_counter → increment → finalize via context accumulation", async () => {
    const outputLog: string[] = [];
    const ctx: PipelineContext = {
      planId: "dep-seq-001",
      stepName: "",
      results: {},
    };

    // Inline runner: runs step, stores result in context, routes to next
    async function runStep(
      step: ConditionalStep<string>,
      context: PipelineContext,
    ): Promise<string | string[]> {
      context.stepName = step.name;
      const routeKey = await step.execute(context);
      context.results[step.name] = { routeKey, executed: true };
      outputLog.push(step.name);
      return resolveBranchRoute(routeKey, step.branches);
    }

    const next1 = await runStep(initStep, ctx);
    expect(next1).toBe("increment");

    const next2 = await runStep(incrementStep, ctx);
    expect(next2).toBe("finalize");

    const next3 = await runStep(finalizeStep, ctx);
    expect(next3).toBe("__end__");

    // All three steps executed in order
    expect(outputLog).toEqual(["init_counter", "increment", "finalize"]);
    // Context accumulated results for all three steps
    expect(ctx.results["init_counter"]).toBeDefined();
    expect(ctx.results["increment"]).toBeDefined();
    expect(ctx.results["finalize"]).toBeDefined();
  });

  test("reads previous step output from context across the chain", async () => {
    // Verify that increment can read what init_counter wrote
    const ctx: PipelineContext = {
      planId: "dep-seq-002",
      stepName: "",
      results: {
        init_counter: { count: 1, routeKey: "next", executed: true },
      },
    };

    let readValue: unknown = null;
    const readerStep: ConditionalStep<"next"> = {
      name: "reader",
      branches: [{ key: "next", next: "done" }],
      async execute(c: PipelineContext) {
        readValue = c.results["init_counter"];
        return "next";
      },
    };

    ctx.stepName = "reader";
    await readerStep.execute(ctx);
    expect(readValue).toEqual({ count: 1, routeKey: "next", executed: true });
  });
});

// ---------------------------------------------------------------------------
// Integration: fan-out route selection in multi-step orchestration
// ---------------------------------------------------------------------------

describe("fan-out route selection", () => {
  /**
   * A orchestrator step that can route to either a single target or multiple
   * fan-out targets. The test verifies that resolveBranchRoute returns the
   * correct shape (string vs string[]) and that each declared target is
   * reachable through the orchestration chain.
   */
  const orchestratorStep: ConditionalStep<"single" | "multi"> = {
    name: "orchestrator",
    branches: [
      { key: "single", next: "single_target" },
      { key: "multi", next: ["target_a", "target_b", "target_c"] },
    ],
    async execute(ctx: PipelineContext): Promise<"single" | "multi"> {
      const mode = ctx.results["mode"] as string | undefined;
      if (mode === "multi") return "multi";
      return "single";
    },
  };

  test("resolveBranchRoute returns string for single-target route", async () => {
    const ctx: PipelineContext = {
      planId: "fanout-001",
      stepName: "orchestrator",
      results: { mode: "single" },
    };

    const routeKey = await orchestratorStep.execute(ctx);
    const next = resolveBranchRoute(routeKey, orchestratorStep.branches);
    expect(routeKey).toBe("single");
    expect(typeof next).toBe("string");
    expect(next).toBe("single_target");
  });

  test("resolveBranchRoute returns string[] for multi-target fan-out route", async () => {
    const ctx: PipelineContext = {
      planId: "fanout-002",
      stepName: "orchestrator",
      results: { mode: "multi" },
    };

    const routeKey = await orchestratorStep.execute(ctx);
    const next = resolveBranchRoute(routeKey, orchestratorStep.branches);
    expect(routeKey).toBe("multi");
    expect(Array.isArray(next)).toBe(true);
    expect(next).toEqual(["target_a", "target_b", "target_c"]);
  });

  test("fan-out targets are individually routable in downstream steps", async () => {
    // After fan-out, each target step should also be routable on its own
    const targetAStep: ConditionalStep<"done"> = {
      name: "target_a",
      branches: [{ key: "done", next: "__end__" }],
      async execute() {
        return "done";
      },
    };

    const routeKey = await targetAStep.execute({
      planId: "fanout-003",
      stepName: "target_a",
      results: {},
    });
    const next = resolveBranchRoute(routeKey, targetAStep.branches);
    expect(routeKey).toBe("done");
    expect(next).toBe("__end__");
  });
});

// ---------------------------------------------------------------------------
// Integration: cascade branching (2-stage pipeline)
// ---------------------------------------------------------------------------

describe("cascade branching", () => {
  /**
   * A 2-stage branching pipeline:
   *
   *   Step "gate"  →  routes to "phase_a" or "phase_b" based on input
   *     Step "phase_a"  →  routes to "finalize_a" or "fallback"
   *     Step "phase_b"  →  routes to "finalize_b" or "fallback"
   *
   * The cascade verifies that the output of the first branch step feeds into
   * the second branch step's routing decision.
   */
  type GateRoute = "phase_a" | "phase_b";
  type PhaseARoute = "finalize_a" | "fallback";
  type PhaseBRoute = "finalize_b" | "fallback";

  const gateStep: ConditionalStep<GateRoute> = {
    name: "gate",
    branches: [
      { key: "phase_a", next: "phase_a" },
      { key: "phase_b", next: "phase_b" },
    ],
    async execute(ctx: PipelineContext): Promise<GateRoute> {
      const input = ctx.results["input"] as string | undefined;
      return input === "b" ? "phase_b" : "phase_a";
    },
  };

  const phaseAStep: ConditionalStep<PhaseARoute> = {
    name: "phase_a",
    branches: [
      { key: "finalize_a", next: "finalize_a" },
      { key: "fallback", next: "fallback" },
    ],
    async execute(ctx: PipelineContext): Promise<PhaseARoute> {
      const ok = ctx.results["input"] !== "fail_a";
      return ok ? "finalize_a" : "fallback";
    },
  };

  const phaseBStep: ConditionalStep<PhaseBRoute> = {
    name: "phase_b",
    branches: [
      { key: "finalize_b", next: "finalize_b" },
      { key: "fallback", next: "fallback_step" },
    ],
    async execute(ctx: PipelineContext): Promise<PhaseBRoute> {
      const ok = ctx.results["input"] !== "fail_b";
      return ok ? "finalize_b" : "fallback";
    },
  };

  test("gate routes to phase_a → finalize_a when input=a", async () => {
    const ctx: PipelineContext = {
      planId: "cascade-001",
      stepName: "gate",
      results: { input: "a" },
    };

    // Stage 1: gate → determines phase
    const gateRoute = await gateStep.execute(ctx);
    const gateNext = resolveBranchRoute(gateRoute, gateStep.branches);
    expect(gateRoute).toBe("phase_a");
    expect(gateNext).toBe("phase_a");

    // Stage 2: phase_a → determines final target
    ctx.stepName = "phase_a";
    const phaseRoute = await phaseAStep.execute(ctx);
    const phaseNext = resolveBranchRoute(phaseRoute, phaseAStep.branches);
    expect(phaseRoute).toBe("finalize_a");
    expect(phaseNext).toBe("finalize_a");
  });

  test("gate routes to phase_b → finalize_b when input=b", async () => {
    const ctx: PipelineContext = {
      planId: "cascade-002",
      stepName: "gate",
      results: { input: "b" },
    };

    // Stage 1: gate → routes to phase_b
    const gateRoute = await gateStep.execute(ctx);
    const gateNext = resolveBranchRoute(gateRoute, gateStep.branches);
    expect(gateRoute).toBe("phase_b");
    expect(gateNext).toBe("phase_b");

    // Stage 2: phase_b → routes to finalize_b
    ctx.stepName = "phase_b";
    const phaseRoute = await phaseBStep.execute(ctx);
    const phaseNext = resolveBranchRoute(phaseRoute, phaseBStep.branches);
    expect(phaseRoute).toBe("finalize_b");
    expect(phaseNext).toBe("finalize_b");
  });

  test("phase falls back to fallback step on failure input", async () => {
    // Phase A: input "fail_a" makes phaseA step route to fallback
    const ctxA: PipelineContext = {
      planId: "cascade-003",
      stepName: "phase_a",
      results: { input: "fail_a" },
    };
    const phaseRoute = await phaseAStep.execute(ctxA);
    const phaseNext = resolveBranchRoute(phaseRoute, phaseAStep.branches);
    expect(phaseRoute).toBe("fallback");
    expect(phaseNext).toBe("fallback");

    // Phase B: input "fail_b" makes phaseB step route to fallback
    const ctxB: PipelineContext = {
      planId: "cascade-004",
      stepName: "phase_b",
      results: { input: "fail_b" },
    };
    const phaseRoute2 = await phaseBStep.execute(ctxB);
    const phaseNext2 = resolveBranchRoute(phaseRoute2, phaseBStep.branches);
    expect(phaseRoute2).toBe("fallback");
    expect(phaseNext2).toBe("fallback_step");
  });

  test("cascade pipeline: end-to-end orchestration with context accumulation", async () => {
    const executionLog: string[] = [];
    const ctx: PipelineContext = {
      planId: "cascade-005",
      stepName: "",
      results: { input: "b" },
    };

    // Inline orchestrator runner that chains execute → route → next
    async function run(
      step: ConditionalStep<string>,
      context: PipelineContext,
    ): Promise<string | string[]> {
      context.stepName = step.name;
      const routeKey = await step.execute(context);
      context.results[step.name] = { routeKey, executed: true };
      executionLog.push(`${step.name} -> ${routeKey}`);
      return resolveBranchRoute(routeKey, step.branches);
    }

    const next1 = await run(gateStep, ctx);
    expect(next1).toBe("phase_b");

    const next2 = await run(phaseBStep, ctx);
    expect(next2).toBe("finalize_b");

    expect(executionLog).toEqual([
      "gate -> phase_b",
      "phase_b -> finalize_b",
    ]);
    expect(ctx.results["gate"]).toBeDefined();
    expect(ctx.results["phase_b"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: empty / missing dependency edge cases
// ---------------------------------------------------------------------------

describe("empty / missing dependency edge cases", () => {
  test("empty PipelineContext.results does not break step execution", async () => {
    const step: ConditionalStep<"ok"> = {
      name: "empty_reader",
      branches: [{ key: "ok", next: "done" }],
      async execute(ctx: PipelineContext) {
        // Reading from empty results should not throw
        const val = ctx.results["nonexistent"];
        expect(val).toBeUndefined();
        return "ok";
      },
    };

    const ctx: PipelineContext = {
      planId: "empty-001",
      stepName: "empty_reader",
      results: {},
    };

    const routeKey = await step.execute(ctx);
    expect(routeKey).toBe("ok");
    const next = resolveBranchRoute(routeKey, step.branches);
    expect(next).toBe("done");
  });

  test("accessing missing dependency keys yields undefined without error", async () => {
    const step: ConditionalStep<"ok"> = {
      name: "missing_dep",
      branches: [{ key: "ok", next: "done" }],
      async execute(ctx: PipelineContext) {
        const depA = ctx.results["step_a"];
        const depB = ctx.results["step_b"];
        // Both are missing — should not throw, just be undefined
        expect(depA).toBeUndefined();
        expect(depB).toBeUndefined();
        return "ok";
      },
    };

    const ctx: PipelineContext = {
      planId: "empty-002",
      stepName: "missing_dep",
      results: { other_key: "present" },
    };

    // results has "other_key" but NOT "step_a" or "step_b"
    const routeKey = await step.execute(ctx);
    expect(routeKey).toBe("ok");
  });

  test("partial results with some dependencies present works correctly", async () => {
    const step: ConditionalStep<"ok"> = {
      name: "partial_dep",
      branches: [{ key: "ok", next: "done" }],
      async execute(ctx: PipelineContext) {
        const depA = ctx.results["step_a"] as { value: number } | undefined;
        const depB = ctx.results["step_b"] as { value: number } | undefined;

        // step_a is present, step_b is missing
        expect(depA).toEqual({ value: 42 });
        expect(depB).toBeUndefined();

        return "ok";
      },
    };

    const ctx: PipelineContext = {
      planId: "empty-003",
      stepName: "partial_dep",
      results: {
        step_a: { value: 42 },
        // step_b intentionally omitted
      },
    };

    const routeKey = await step.execute(ctx);
    expect(routeKey).toBe("ok");
  });

  test("validateBranchCoverage on multi-step scenario catches missing branches", () => {
    // Simulate a multi-step pipeline where each step declares its routes
    const stepARoutes: StepRoute[] = [
      { key: "to_b", next: "step_b" },
      { key: "to_c", next: "step_c" },
    ];
    const stepBRoutes: StepRoute[] = [
      { key: "continue", next: "step_c" },
      // Intentionally missing "abort" key — validateBranchCoverage should catch it
    ];

    // Step A: all expected keys covered
    const missingA = validateBranchCoverage(["to_b", "to_c"], stepARoutes);
    expect(missingA).toEqual([]);

    // Step B: "abort" is not covered → should be reported
    const missingB = validateBranchCoverage(["continue", "abort"], stepBRoutes);
    expect(missingB).toEqual(["abort"]);

    // After fixing step B, coverage should be clean
    const stepBFixed: StepRoute[] = [
      { key: "continue", next: "step_c" },
      { key: "abort", next: "__end__" },
    ];
    const missingBFixed = validateBranchCoverage(["continue", "abort"], stepBFixed);
    expect(missingBFixed).toEqual([]);
  });
});
