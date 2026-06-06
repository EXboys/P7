import { describe, expect, test } from "bun:test";
import { validateDag, topologicalSort, PipelineEngine, DagValidationError } from "../src/pipeline-engine.ts";
import type { EngineStep } from "../src/pipeline-engine.ts";
import type { PipelineDagDefinition, StepExecutionContext, ArtifactKind } from "../src/pipeline-dsl.ts";

function linearDag(overrides?: Partial<PipelineDagDefinition>): PipelineDagDefinition {
  return {
    id: "linear-test", description: "3-node linear DAG",
    nodes: [
      { id: "A", kind: "pattern_extract" as const, dependsOn: [] },
      { id: "B", kind: "convergence_analyze" as const, dependsOn: ["A"] },
      { id: "C", kind: "early_stop" as const, dependsOn: ["B"] },
    ],
    entryNodes: ["A"],
    ...overrides,
  };
}

function diamondDag(): PipelineDagDefinition {
  return {
    id: "diamond-test", description: "diamond DAG",
    nodes: [
      { id: "A", kind: "pattern_extract" as const, dependsOn: [] },
      { id: "B", kind: "convergence_analyze" as const, dependsOn: ["A"] },
      { id: "C", kind: "threshold_calibrate" as const, dependsOn: ["A"] },
      { id: "D", kind: "dynamic_rules_inject" as const, dependsOn: ["B", "C"] },
    ],
    entryNodes: ["A"],
  };
}

function makeStep(label: string, log: string[], produces?: ArtifactKind): EngineStep {
  return {
    nodeId: label, produces,
    async execute() { log.push(label); return `${label}_result`; },
  };
}

// ── DAG validation ──

describe("validateDag", () => {
  test("passes for valid linear DAG", () => expect(() => validateDag(linearDag())).not.toThrow());
  test("passes for valid diamond DAG", () => expect(() => validateDag(diamondDag())).not.toThrow());

  test("throws on cycle", () => {
    expect(() => validateDag({
      id: "cycle", description: "",
      nodes: [
        { id: "A", kind: "pattern_extract", dependsOn: [] },
        { id: "B", kind: "convergence_analyze", dependsOn: ["A", "C"] },
        { id: "C", kind: "early_stop", dependsOn: ["B"] },
      ],
      entryNodes: ["A"],
    })).toThrow(DagValidationError);
  });

  test("throws on duplicate node ID", () => {
    expect(() => validateDag({
      id: "dup", description: "",
      nodes: [
        { id: "A", kind: "pattern_extract", dependsOn: [] },
        { id: "A", kind: "convergence_analyze", dependsOn: [] },
      ],
      entryNodes: ["A"],
    })).toThrow(/Duplicate/);
  });

  test("throws on missing dependency ref", () => {
    expect(() => validateDag(linearDag({ nodes: [
      { id: "A", kind: "pattern_extract", dependsOn: [] },
      { id: "B", kind: "convergence_analyze", dependsOn: ["NOPE"] },
    ]}))).toThrow(/unknown/);
  });

  test("throws when entry node has dependsOn", () => {
    expect(() => validateDag(linearDag({ entryNodes: ["B"] }))).toThrow(/must not have dependsOn/);
  });

  test("throws when entry node not in nodes list", () => {
    expect(() => validateDag(linearDag({ entryNodes: ["MISSING"] }))).toThrow(/not found/);
  });
});

// ── Topological sort ──

describe("topologicalSort", () => {
  test("linear chain produces correct order", () => {
    const order = topologicalSort(linearDag()).flat();
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("C"));
    expect(order).toEqual(expect.arrayContaining(["A", "B", "C"]));
  });

  test("diamond DAG groups B/C in same layer", () => {
    const layers = topologicalSort(diamondDag());
    expect(layers[0]).toEqual(["A"]);
    expect(layers[1]).toHaveLength(2);
    expect(layers[1]).toEqual(expect.arrayContaining(["B", "C"]));
    expect(layers[2]).toEqual(["D"]);
  });

  test("flat DAG forms single layer", () => {
    const dag: PipelineDagDefinition = {
      id: "flat", description: "",
      nodes: [
        { id: "A", kind: "pattern_extract", dependsOn: [] },
        { id: "B", kind: "convergence_analyze", dependsOn: [] },
      ],
      entryNodes: ["A", "B"],
    };
    expect(topologicalSort(dag)).toEqual([["A", "B"]]);
  });

  test("single node returns one layer", () => {
    expect(topologicalSort({
      id: "single", description: "",
      nodes: [{ id: "X", kind: "pattern_extract", dependsOn: [] }],
      entryNodes: ["X"],
    })).toEqual([["X"]]);
  });
});

// ── PipelineEngine execution ──

describe("PipelineEngine", () => {
  test("executes 3-step linear pipeline in order", async () => {
    const log: string[] = [];
    const report = await new PipelineEngine().execute(linearDag(), "p1", 0,
      new Map([["A", makeStep("A", log)], ["B", makeStep("B", log)], ["C", makeStep("C", log)]]));
    expect(log).toEqual(["A", "B", "C"]);
    expect(report.succeeded).toBe(true);
  });

  test("propagates artifacts via EngineStep.produces", async () => {
    const dag: PipelineDagDefinition = {
      id: "art-test", description: "",
      nodes: [
        { id: "gen", kind: "pattern_extract", dependsOn: [] },
        { id: "use", kind: "convergence_analyze", dependsOn: ["gen"] },
      ],
      entryNodes: ["gen"],
    };
    let consumed: unknown = null;
    const report = await new PipelineEngine().execute(dag, "p2", 1, new Map([
      ["gen", { nodeId: "gen", produces: "pattern_report" as ArtifactKind, async execute() { return { data: 42 }; } }],
      ["use", { nodeId: "use", async execute(_i: unknown, ctx: StepExecutionContext) { consumed = ctx.artifacts.get("pattern_report" as ArtifactKind); return {}; } }],
    ]));
    expect(report.succeeded).toBe(true);
    expect(consumed).toEqual({ data: 42 });
  });

  test("skips node when condition is falsy", async () => {
    const dag: PipelineDagDefinition = {
      id: "cond-test", description: "",
      nodes: [
        { id: "A", kind: "pattern_extract", dependsOn: [], condition: "" },
        { id: "B", kind: "convergence_analyze", dependsOn: [] },
      ],
      entryNodes: ["A", "B"],
    };
    const log: string[] = [];
    const report = await new PipelineEngine().execute(dag, "p3", 0, new Map([
      ["A", makeStep("A", log)], ["B", makeStep("B", log)]]));
    expect(log).toEqual(["B"]);
    expect(report.nodeStates.find(s => s.nodeId === "A")!.status).toBe("skipped");
  });

  test("truthy condition does not skip", async () => {
    const dag: PipelineDagDefinition = {
      id: "cond-true", description: "",
      nodes: [{ id: "A", kind: "pattern_extract", dependsOn: [], condition: "expr" }],
      entryNodes: ["A"],
    };
    const log: string[] = [];
    const report = await new PipelineEngine().execute(dag, "p4", 0, new Map([["A", makeStep("A", log)]]));
    expect(log).toEqual(["A"]);
    expect(report.nodeStates[0].status).toBe("completed");
  });

  test("per-node timeout fails node", async () => {
    const dag: PipelineDagDefinition = {
      id: "timeout-test", description: "",
      nodes: [{ id: "slow", kind: "pattern_extract", dependsOn: [], timeoutMs: 10 }],
      entryNodes: ["slow"],
    };
    const report = await new PipelineEngine().execute(dag, "p5", 0, new Map([
      ["slow", {
        nodeId: "slow",
        async execute(_i: unknown, ctx: StepExecutionContext) {
          await new Promise((_, rej) => {
            if (ctx.signal.aborted) { rej(new Error("aborted")); return; }
            ctx.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
          });
        },
      }],
    ]));
    expect(report.succeeded).toBe(false);
    expect(report.nodeStates[0].status).toBe("failed");
    expect(report.nodeStates[0].error).toBeTruthy();
  });

  test("report contains timing fields", async () => {
    const report = await new PipelineEngine().execute(linearDag(), "p6", 2, new Map([
      ["A", { nodeId: "A", async execute() { return 1; } }],
      ["B", { nodeId: "B", async execute() { return 2; } }],
      ["C", { nodeId: "C", async execute() { return 3; } }],
    ]));
    expect(report.succeeded).toBe(true);
    expect(report.totalNodes).toBe(3);
    expect(report.nodeStates).toHaveLength(3);
    for (const ns of report.nodeStates) {
      expect(typeof ns.startedAt).toBe("number");
      expect(ns.finishedAt! >= ns.startedAt).toBe(true);
      expect(typeof ns.durationMs).toBe("number");
    }
    expect(report.totalDurationMs).toBeGreaterThan(0);
    expect(report.pipelineId).toBe("linear-test");
    expect(report.planId).toBe("p6");
    expect(report.iterationRound).toBe(2);
  });

  test("fails node when no step registered", async () => {
    const report = await new PipelineEngine().execute(linearDag(), "p7", 0,
      new Map([["A", makeStep("A", [])], ["B", makeStep("B", [])]]));
    const c = report.nodeStates.find(s => s.nodeId === "C")!;
    expect(c.status).toBe("failed");
    expect(c.error).toContain("No step for");
  });

  test("pipeline-level abort skips all nodes", async () => {
    const ctrl = new AbortController(); ctrl.abort();
    const log: string[] = [];
    const report = await new PipelineEngine().execute(linearDag(), "p8", 0,
      new Map([["A", makeStep("A", log)], ["B", makeStep("B", log)], ["C", makeStep("C", log)]]),
      ctrl.signal);
    expect(log).toEqual([]);
    expect(report.nodeStates.every(s => s.status === "skipped")).toBe(true);
  });
});
