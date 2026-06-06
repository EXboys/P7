/**
 * DAG orchestration engine: validates DAG definitions, computes topological
 * order via Kahn's algorithm, and drives step execution through a
 * pending→running→completed|failed|skipped state machine.
 *
 * Supports artifact propagation, conditional skip, per-node timeout via
 * AbortSignal, and fan-out for same-depth nodes.
 */
import type {
  SelfIterationStepKind, ArtifactKind, StepExecutionContext,
  PipelineDagDefinition,
} from "./pipeline-dsl.ts";

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface NodeExecutionState {
  nodeId: string;
  kind: SelfIterationStepKind;
  status: NodeStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
}

export interface PipelineExecutionReport {
  pipelineId: string;
  planId: string;
  iterationRound: number;
  totalNodes: number;
  nodeStates: NodeExecutionState[];
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  succeeded: boolean;
}

export interface EngineStep {
  nodeId: string;
  execute: (input: unknown, context: StepExecutionContext) => Promise<unknown>;
  produces?: ArtifactKind;
}

export class DagValidationError extends Error {
  constructor(msg: string) { super(msg); this.name = "DagValidationError"; }
}

/** Validate DAG: unique IDs, entry invariants, referential integrity, cycle check. */
export function validateDag(def: PipelineDagDefinition): void {
  const ids = new Set<string>();
  for (const n of def.nodes) {
    if (ids.has(n.id)) throw new DagValidationError(`Duplicate node ID: "${n.id}"`);
    ids.add(n.id);
  }
  for (const eid of def.entryNodes) {
    const n = def.nodes.find(x => x.id === eid);
    if (!n) throw new DagValidationError(`Entry node "${eid}" not found`);
    if (n.dependsOn.length > 0) throw new DagValidationError(`Entry node "${eid}" must not have dependsOn`);
  }
  for (const n of def.nodes) {
    for (const d of n.dependsOn) {
      if (!ids.has(d)) throw new DagValidationError(`Node "${n.id}" depends on unknown "${d}"`);
    }
  }
  const visited = new Set<string>(), stack = new Set<string>();
  const dfs = (id: string): void => {
    if (stack.has(id)) throw new DagValidationError(`Cycle involving "${id}"`);
    if (visited.has(id)) return;
    visited.add(id); stack.add(id);
    const n = def.nodes.find(x => x.id === id);
    if (n) for (const d of n.dependsOn) dfs(d);
    stack.delete(id);
  };
  for (const eid of def.entryNodes) dfs(eid);
  for (const n of def.nodes) { if (!visited.has(n.id)) dfs(n.id); }
}

/** Kahn's algorithm returning layers (same depth = fan-out candidates). */
export function topologicalSort(def: PipelineDagDefinition): string[][] {
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of def.nodes) { inDeg.set(n.id, 0); adj.set(n.id, []); }
  for (const n of def.nodes) {
    for (const d of n.dependsOn) {
      adj.get(d)!.push(n.id);
      inDeg.set(n.id, (inDeg.get(n.id) ?? 0) + 1);
    }
  }
  const layers: string[][] = [];
  let q = [...inDeg].filter(([_, d]) => d === 0).map(([id]) => id);
  while (q.length > 0) {
    layers.push([...q]);
    const next: string[] = [];
    for (const id of q) {
      for (const nb of adj.get(id) ?? []) {
        const nd = (inDeg.get(nb) ?? 1) - 1;
        inDeg.set(nb, nd);
        if (nd === 0) next.push(nb);
      }
    }
    q = next;
  }
  const n = layers.flat().length;
  if (n !== def.nodes.length) throw new DagValidationError(`Sort incomplete: ${n}/${def.nodes.length}`);
  return layers;
}

/** Combine multiple AbortSignals: aborts when any input aborts. */
function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/**
 * Orchestration engine: validates DAG, computes topological order, drives
 * step execution, and returns a full PipelineExecutionReport.
 */
export class PipelineEngine {
  async execute(
    def: PipelineDagDefinition,
    planId: string,
    iterationRound: number,
    stepMap: Map<string, EngineStep>,
    pipelineSignal?: AbortSignal,
  ): Promise<PipelineExecutionReport> {
    validateDag(def);
    const layers = topologicalSort(def);
    const nodeMap = new Map(def.nodes.map(n => [n.id, n]));
    const artifacts = new Map<ArtifactKind, unknown>();
    const nodeStates: NodeExecutionState[] = [];
    const startTime = performance.now();

    for (const layer of layers) {
      await Promise.all(layer.map(async (nodeId) => {
        const node = nodeMap.get(nodeId)!;
        const s: NodeExecutionState = { nodeId, kind: node.kind, status: "pending", startedAt: performance.now() };
        nodeStates.push(s);

        if (pipelineSignal?.aborted) { s.status = "skipped"; s.finishedAt = performance.now(); s.durationMs = s.finishedAt - s.startedAt; return; }
        if (node.condition !== undefined && !node.condition) { s.status = "skipped"; s.finishedAt = performance.now(); s.durationMs = s.finishedAt - s.startedAt; return; }

        const step = stepMap.get(node.id);
        if (!step) { s.status = "failed"; s.error = `No step for "${node.id}"`; s.finishedAt = performance.now(); s.durationMs = s.finishedAt - s.startedAt; return; }

        s.status = "running";
        const input: Record<string, unknown> = {};
        for (const depId of node.dependsOn) {
          const dn = nodeMap.get(depId);
          if (dn) input[depId] = artifacts.get(dn.kind as unknown as ArtifactKind);
        }

        try {
          const baseCtx: StepExecutionContext = { planId, iterationRound, artifacts, signal: pipelineSignal ?? new AbortController().signal };
          let ctx = baseCtx;
          if (node.timeoutMs && node.timeoutMs > 0) {
            const tc = new AbortController();
            const tid = setTimeout(() => tc.abort(new Error(`Timeout after ${node.timeoutMs}ms`)), node.timeoutMs);
            ctx = { ...baseCtx, signal: combineSignals(baseCtx.signal, tc.signal) };
            try {
              const out = await step.execute(input, ctx);
              if (step.produces && out !== undefined) artifacts.set(step.produces, out);
            } finally { clearTimeout(tid); }
          } else {
            const out = await step.execute(input, ctx);
            if (step.produces && out !== undefined) artifacts.set(step.produces, out);
          }
          s.status = "completed";
        } catch (err) {
          s.status = "failed";
          s.error = err instanceof Error ? err.message : String(err);
        }
        s.finishedAt = performance.now();
        s.durationMs = s.finishedAt - s.startedAt;
      }));
    }

    const endTime = performance.now();
    return {
      pipelineId: def.id, planId, iterationRound,
      totalNodes: def.nodes.length, nodeStates, startTime, endTime,
      totalDurationMs: endTime - startTime,
      succeeded: nodeStates.every(ns => ns.status === "completed" || ns.status === "skipped"),
    };
  }
}
