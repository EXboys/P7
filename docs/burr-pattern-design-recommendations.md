# Burr Pattern Design Recommendations for Hyper-Agentic Pipeline

> **Distilled from**: `docs/burr-executor-comparison.md` (Apache Burr v0.18.x 8-dimension analysis)
> **Target**: `src/pipeline-step.ts` (ConditionalStep/ParallelStep primitives) → `src/pipeline-engine.ts` (DAG orchestration) → `src/executor.ts` (linear pipeline integration)
> **Status**: Design recommendation — not an implementation spec
> **Date**: 2026-06-11

---

## Table of Contents

1. [Overview & Key Insight](#1-overview--key-insight)
2. [ConditionalStep Integration into PipelineEngine](#2-conditionalstep-integration-into-pipelineengine)
3. [StateContext + reads/writes Contract](#3-statecontext--readswrites-contract)
4. [Transition-Driven Dynamic Reordering](#4-transition-driven-dynamic-reordering)
5. [Phased Integration Roadmap](#5-phased-integration-roadmap)
6. [Appendix](#6-appendix)

---

## 1. Overview & Key Insight

### 1.1 Executive Summary

The Burr executor comparison identified **6 actionable gaps** from 8 dimensions where Burr's patterns can directly evolve P7's hyper-agentic pipeline. This document distills those gaps into concrete design recommendations targeting three integration layers:

| Layer | Current Asset | Burr Pattern | Design Target |
|-------|---------------|--------------|---------------|
| **Conditional branching** | `ConditionalStep` + `resolveBranchRoute` in `pipeline-step.ts` | `Transition(from, to, condition)` | Wire branches into `PipelineEngine.execute()` loop + `PipelineDagNode` |
| **State persistence** | `PlanState` SQLite (write-step-state, no snapshot chain) | Immutable `State` + `reads/writes` contract + `StatePersister` | `StateContext` with automatic parallelism detection from declared deps |
| **Dynamic reordering** | `PipelineEngine.topologicalSort` Kahn layers (static) | State-driven Transition selection | `TransitionRule` with cost-aware + circuit-breaker routing modes |

### 1.2 Core Thesis

> **Burr's `State` + `Transition` model is a superset of HAP's ConditionalStep, and P7's PipelineEngine already implements DAG execution — the missing bridge is wiring `PipelineDagNode.branches` into the execute loop and upgrading `PipelineContext` to a Burr-style `StateContext` with immutable snapshots and declared reads/writes.**

### 1.3 Reference Architecture

```
src/pipeline-step.ts                 src/pipeline-dsl.ts                src/pipeline-engine.ts
┌─────────────────────────┐          ┌──────────────────┐              ┌───────────────────────┐
│ ConditionalStep          │          │ PipelineDagNode   │              │ PipelineEngine         │
│  • branches + route      │ ────→   │  • id, kind       │ ──→          │  • validateDag()       │
│  • defaultBranch         │  model  │  • dependsOn      │  integrate   │  • topologicalSort()   │
│                          │   map   │  • condition      │              │  • execute() loop      │
│ ParallelStep             │          │  • timeoutMs      │              │                       │
│  • substeps + strategy   │          │  • retry          │              │  MISSING:             │
│  • executeParallel()     │          └──────────────────┘              │  • Node branches       │
│                          │                                                │  • Transition routing  │
│ StateContext (NEW)       │                                                │  • State snapshots     │
│  • reads / writes dep    │                                                └───────────────────────┘
│  • immutable snapshot    │          src/executor.ts
│  • persister interface   │          ┌───────────────────────┐
└─────────────────────────┘          │ 10-step linear chain  │
                                     │ (no runtime routing)  │
                                     └───────────────────────┘
```

---

## 2. ConditionalStep Integration into PipelineEngine

### 2.1 Problem

PipelineEngine already supports `condition` on `PipelineDagNode` as a skip predicate, but:
- It evaluates a **static string expression**, not a route key returned by step execution.
- There is no `branches` field — the engine cannot select among multiple downstream targets after a step completes.
- The `StepContract` interface (`pipeline-dsl.ts:151-164`) has no concept of routing.

### 2.2 Design: `branches` Field on PipelineDagNode

Add an optional `branches` field directly to `PipelineDagNode`:

```typescript
// src/pipeline-dsl.ts — proposed extension
interface PipelineDagNode {
  id: string;
  kind: SelfIterationStepKind;
  dependsOn: string[];
  condition?: string;
  retry?: { maxAttempts: number; backoffMs: number };
  timeoutMs?: number;

  /** NEW: Branch routes keyed by step output — replaces or supplements `condition`.
   *
   * After this node completes, the engine reads the step's emitted route key
   * and selects the next node(s) from this map. If omitted, the engine falls
   * back to the static dependsOn topology (current behavior).
   *
   * For single-target: `"has_diff": "diff_check"`
   * For fan-out:      `"has_diff": ["diff_check", "coverage_gate"]`
   */
  branches?: Record<string, string | string[]>;

  /** NEW: Fallback target when the emitted route key is not found in `branches`.
   *  If omitted AND route key is unmatched, the engine throws a `DagValidationError`. */
  defaultBranch?: string | string[];
}
```

**Why Record instead of StepRoute[]**: The `StepRoute` type in `pipeline-step.ts` uses `{ key, next }` objects. For DAG definition serialization (JSON/config), a flat `Record<string, string | string[]>` is more ergonomic — it matches the branching pattern in Burr's `with_transitions()` and HAP's `RouteMap`.

### 2.3 Design: Routing Logic in Execute Loop

Modify `PipelineEngine.execute()` to handle branches after each step completes:

```
┌─────────────────────────────────────────┐
│ Current execute() loop                   │
│                                          │
│ for each layer in topologicalSort():     │
│   await Promise.all(layer.map(...))       │
│                                          │
│ Limitation: steps within a layer are     │
│ unordered — all must complete before     │
│ the NEXT layer begins. No runtime        │
│ branch-based layer injection.            │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│ Proposed: Branch-Aware Execution         │
│                                          │
│ active = [...entryNodes]                 │
│ while active is not empty:               │
│   layer = resolveNextLayer(active, dag)  │  ← resolves deps AND branch chaining
│   await Promise.all(layer.map(...))       │
│   for each completed node:               │
│     if node.branches exists:             │
│       route = stepResult.route           │
│       next = branches[route] ??          │
│              defaultBranch               │
│       add next to active (if not done)   │
│     else:                                │
│       add static dependents to active    │
└──────────────────────────────────────────┘
```

Key changes vs current `topologicalSort`:
1. **Remove the static layer precomputation** — layers become dynamic: the next layer depends on which route each completed node chose.
2. **Track completed nodes** — prevent re-adding already-executed nodes when branches create diamond dependencies.
3. **Fan-out handling** — `string[]` values in `branches` add multiple targets to the active set (they will execute concurrently in the next `Promise.all`).
4. **Cycle guard** — nodes cannot branch back to a node that is currently `"running"` (enforced by execution state check).

### 2.4 Design: validateDag Extension

Extend `validateDag()` with branch-specific checks:

```typescript
function validateDag(def: PipelineDagDefinition): void {
  // … existing: unique IDs, entry invariants, dependsOn integrity, cycle check

  // NEW: Branch target integrity
  for (const n of def.nodes) {
    if (!n.branches) continue;

    // All branch targets must reference valid node IDs
    for (const [routeKey, targets] of Object.entries(n.branches)) {
      const tids = Array.isArray(targets) ? targets : [targets];
      for (const tid of tids) {
        if (!ids.has(tid)) throw new DagValidationError(
          `Node "${n.id}" branch "${routeKey}" → unknown target "${tid}"`,
        );
        // Branch targets that create cycles are allowed IF the target is not
        // an ancestor of this node in the static dependsOn graph.
        // Run a separate reachability check:
        if (isAncestor(n.id, tid, def)) throw new DagValidationError(
          `Node "${n.id}" branch "${routeKey}" → "${tid}" creates a cycle`,
        );
      }
    }

    // Warn (not error) if a node has both dependsOn and branches — mixed mode
    // is valid (dependsOn for artifacts, branches for routing) but may confuse
    // readers.
  }
}
```

**Cycle detection**: A branch that targets an ancestor node (via static `dependsOn` edges) is a cycle. However, a branch that targets a non-ancestor node that *later* depends on the original node is NOT a cycle — it's a diamond. The DFS cycle check from the original `validateDag` (`pipeline-engine.ts:65-75`) already catches true cycles. Add an additional guard: no branch target may be a node whose (transitive) dependsOn includes the source node.

### 2.5 Integration with Existing `resolveBranchRoute`

The existing `resolveBranchRoute` function (`pipeline-step.ts:90-103`) serves as the **runtime branch resolver**. The engine calls it during the execute loop:

```typescript
// Inside execute loop, after step completes:
if (node.branches) {
  const nextTargets = resolveBranchRoute(
    stepResult.route,
    // Convert Record to StepRoute[] for the existing resolver
    Object.entries(node.branches).map(([key, next]) => ({ key, next })),
    node.defaultBranch,
  );
  // Add targets to active set
}
```

**Backward compat**: When `branches` is undefined, the engine falls back to the static topological order — existing `PipelineDagDefinition` objects work unchanged.

---

## 3. StateContext + reads/writes Contract

### 3.1 Problem

The current `PipelineContext` (`pipeline-step.ts:15-28`) is a flat metadata bag:

```typescript
interface PipelineContext {
  planId: string;
  stepName: string;
  results: Record<string, unknown>;   // accumulation, no isolation
  metadata?: Record<string, unknown>;  // implicit, no schema
}
```

Issues:
- **No immutability**: steps can mutate `results` and `metadata` in-place.
- **No dependency declaration**: the engine cannot know which keys a step reads/writes, making automatic parallelism detection impossible.
- **No persistence**: state lives in memory only — no snapshot chain for recovery or debugging.
- **No version chain**: lost the ability to `fork_from_sequence_id` (Burr's debugging superpower).

### 3.2 Design: Immutable StateSnapshot

```typescript
// state-context.ts (NEW module)
export class StateSnapshot {
  /** Unique snapshot ID (monotonic sequence per pipeline execution). */
  readonly sequenceId: number;
  /** Step name that produced this snapshot (null for initial). */
  readonly producedBy: string | null;
  /** Snapshot data — immutable from consumer's perspective. */
  readonly data: Readonly<Record<string, unknown>>;

  constructor(sequenceId: number, producedBy: string | null, data: Record<string, unknown>) {
    this.sequenceId = sequenceId;
    this.producedBy = producedBy;
    this.data = Object.freeze({ ...data });
  }

  /** Create a new snapshot by merging a delta onto this snapshot. */
  merge(delta: Record<string, unknown>): StateSnapshot {
    return new StateSnapshot(this.sequenceId + 1, this.producedBy, {
      ...this.data,
      ...delta,
    });
  }

  /** Subset: extract only the keys this step reads. */
  subset(keys: string[]): Readonly<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const k of keys) {
      if (k in this.data) result[k] = this.data[k];
    }
    return Object.freeze(result);
  }
}
```

### 3.3 Design: reads/writes Contract on Steps

Each step declares what state keys it reads and writes, mirroring Burr's `Action` contract:

```typescript
// As a new interface extending the existing conditional/parallel step patterns:
interface StatefulStep<TRoutes extends string = string> {
  name: string;

  /** State keys this step reads. Used for:
   *  - Automatic parallelism detection (diamond deps = overlapping writes)
   *  - Snapshot subset extraction (isolate what the step sees)
   *  - Validation (warn if a step reads a key no prior step wrote) */
  reads: string[];

  /** State keys this step writes. Used for:
   *  - Dependency tracking via write-set conflicts
   *  - Snapshot merge scoping (only declared keys are merged back)
   *  - Validation (prevent accidental state pollution) */
  writes: string[];

  /** Execute with a read-only subset of the current state.
   *  Returns a WriteDelta — only the declared `writes` keys are merged back. */
  execute(ctx: StateContext): Promise<StateDelta>;

  /** Branch routes — same structure as ConditionalStep. */
  branches: StepRoute[];
  defaultBranch?: string;
}

/** The delta a step writes back to the global state. */
export interface StateDelta {
  route: string;
  values: Record<string, unknown>;  // subset of this.writes
}
```

### 3.4 Design: StatePersister Interface

```typescript
/** Pluggable persister for state snapshots — Burr StatePersister equivalent. */
export interface StatePersister {
  /** Persist a snapshot after a step completes. */
  save(snapshot: StateSnapshot): Promise<void>;

  /** Load the latest snapshot for a given pipeline+plan. */
  loadLatest(pipelineId: string, planId: string): Promise<StateSnapshot | null>;

  /** Load a snapshot by sequence ID (for fork_from_sequence_id). */
  loadBySequence(pipelineId: string, planId: string, sequenceId: number): Promise<StateSnapshot | null>;
}
```

### 3.5 Design: SQLite `state_snapshots` Table

```typescript
// Proposed schema — separate from PlanState to avoid migration conflicts
const STATE_SNAPSHOTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS state_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id   TEXT    NOT NULL,
    plan_id       TEXT    NOT NULL,
    sequence_id   INTEGER NOT NULL,
    produced_by   TEXT,
    data_json     TEXT    NOT NULL,  -- JSON-serialized snapshot data
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pipeline_id, plan_id, sequence_id)
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_lookup
    ON state_snapshots(pipeline_id, plan_id, sequence_id DESC);
`;
```

**Design rationale for separate table**:
- `PlanState` is a mutable "execution log" — it's written to incrementally and can be updated.
- `state_snapshots` is an append-only immutable chain — each snapshot is created once and never mutated.
- This separation prevents accidental mutation of historical state when the engine retries or recovers.

**Potential conflict with PlanState**: The `state_snapshots` table references `plan_id` as a foreign-key-ish identifier but doesn't enforce FK constraints (SQLite default). If PlanState is ever migrated, the snapshot chain should remain intact by plan_id. No schema migration needed today — the table is additive.

### 3.6 Design: Automatic Parallelism Detection

With declared `reads` and `writes`, the engine can automatically detect parallelizable steps:

```typescript
function canRunInParallel(a: StatefulStep, b: StatefulStep): boolean {
  // Two steps can run in parallel if their write sets do not overlap
  // (no conflicting mutations).
  const aWrites = new Set(a.writes);
  const bWrites = new Set(b.writes);
  for (const key of bWrites) {
    if (aWrites.has(key)) return false;
  }
  // Reads overlapping with the other's writes are fine as long as
  // both are not *also* writing to them (true dependency — not anti-dependency).
  return true;
}
```

The engine uses this in the topological sort layer resolution: within a single Kahn layer, nodes with non-overlapping write sets can run concurrently; nodes with overlapping write sets must run sequentially (or in a sub-layer).

### 3.7 Integration with `PipelineContext`

The existing `PipelineContext` becomes a thin wrapper around `StateSnapshot`:

```typescript
// Updated PipelineContext
interface PipelineContext {
  planId: string;
  stepName: string;

  /** Immutable state snapshot for this step's execution window. */
  readonly state: StateSnapshot;

  /** Declared reads — the engine subsets state.data for this step. */
  readonly reads: string[];

  /** Declared writes — the engine only merges these keys back. */
  readonly writes: string[];
}
```

**Backward compat**: Existing steps that don't declare `reads`/`writes` default to `reads: ["*"]` and `writes: ["*"]` (full access, current behavior). This preserves the existing `results` accumulation pattern.

---

## 4. Transition-Driven Dynamic Reordering

### 4.1 Problem

Current routing is either:
- **Static topological order** (PipelineEngine): layers computed once, execution order fixed.
- **Hardcoded linear sequence** (executor.ts): 10 steps, no runtime variation.

Dynamic reordering (HAP §4) requires the pipeline to select the next step at runtime based on cost, diff size, failure counts, or other execution signals.

### 4.2 Design: TransitionRule Type

Burr's `Transition(from, to, condition)` maps to a `TransitionRule`:

```typescript
/** A single transition rule: when `condition` is met, route to `target`. */
export interface TransitionRule {
  /** Target step name(s). */
  target: string | string[];
  /** Condition function evaluated against the current StateContext.
   *  First-match-wins semantics (same as Burr). */
  condition: (ctx: StateContext) => boolean;
}

/** Extended ConditionalStep with Transition rules.
 *  Replaces the simple `branches` Record with ordered rule list. */
export interface TransitionDrivenStep extends ConditionalStep {
  /** Ordered transition rules. The first rule whose condition matches wins.
   *  If no rule matches, dispatch falls back to defaultBranch (or throws). */
  transitions: TransitionRule[];
}
```

**Why ordered transitions instead of unordered branches**: Burr uses first-match-wins semantics, which enables priority-based routing. An unordered `Record` cannot express "try cost-aware first, fall back to circuit-breaker, then default." The ordered list maps directly to Burr's `with_transitions()`.

### 4.3 Design: Cost-Aware Routing

```typescript
// Pre-built condition factories for common routing patterns

/** Route to an alternative step when cumulative cost exceeds threshold. */
export function costThreshold(ratio: number, alternativeStep: string): TransitionRule {
  return {
    target: alternativeStep,
    condition: (ctx: StateContext) => {
      const cost = ctx.state.data.cumulativeCost as number;
      const limit = ctx.state.data.executionCostLimit as number;
      return cost > 0 && limit > 0 && (cost / limit) > ratio;
    },
  };
}

/** Route to cooling step when consecutive failures exceed limit. */
export function circuitBreaker(maxConsecutive: number, cooldownStep: string): TransitionRule {
  return {
    target: cooldownStep,
    condition: (ctx: StateContext) => {
      const failures = ctx.state.data.consecutiveFailures as number;
      return failures >= maxConsecutive;
    },
  };
}

/** Route to fast-path when diff size is below a threshold. */
export function smallDiff(skipStep: string, maxLines: number = 10): TransitionRule {
  return {
    target: skipStep,
    condition: (ctx: StateContext) => {
      const lines = ctx.state.data.diffStats?.lines as number ?? Infinity;
      return lines <= maxLines;
    },
  };
}
```

### 4.4 Design: Fallback Compatibility

When a `TransitionDrivenStep` has no matching transition, the fallback chain is:

```
1. Match transitions in order  → first win
2. Match static branches       → exact key match
3. defaultBranch               → configured fallback
4. Throw                       → DagValidationError (unroutable)
```

For backward compatibility, existing `ConditionalStep` (which uses `branches` Record) is treated as `transitions` with the condition `(ctx) => emittedRoute === key` — the engine wraps the Record into ordered rules internally.

### 4.5 Integration with PipelineEngine

The branch-aware execute loop (Section 2.3) uses `TransitionRule` instead of `Record` when available:

```typescript
// Inside execute loop — step resolution phase
function resolveNextSteps(
  completedNode: PipelineDagNode,
  stepResult: { route: string },
  ctx: StateContext,
): string[] {
  if (completedNode.transitions) {
    // Transition-driven: first-match-wins
    for (const rule of completedNode.transitions) {
      if (rule.condition(ctx)) {
        return Array.isArray(rule.target) ? rule.target : [rule.target];
      }
    }
    // Fallback to default
    if (completedNode.defaultBranch) {
      return Array.isArray(completedNode.defaultBranch)
        ? completedNode.defaultBranch
        : [completedNode.defaultBranch];
    }
    throw new DagValidationError(`No transition matched for "${completedNode.id}"`);
  }

  if (completedNode.branches) {
    // Static branch: exact key match via resolveBranchRoute
    const next = resolveBranchRoute(
      stepResult.route,
      Object.entries(completedNode.branches).map(([k, v]) => ({ key: k, next: v })),
      completedNode.defaultBranch,
    );
    return Array.isArray(next) ? next : [next];
  }

  // No branching — use static dependsOn topology
  return getDependentNodes(completedNode.id, def);
}
```

---

## 5. Phased Integration Roadmap

### 5.1 Asset Inventory

| Asset | Location | Lines | Status |
|-------|----------|-------|--------|
| `ConditionalStep` interface | `src/pipeline-step.ts:58-74` | ~16 | ✅ Complete |
| `resolveBranchRoute` function | `src/pipeline-step.ts:90-103` | ~13 | ✅ Complete |
| `validateBranchCoverage` function | `src/pipeline-step.ts:114-120` | ~7 | ✅ Complete |
| `ParallelStep` interface | `src/pipeline-step.ts:170-178` | ~9 | ✅ Complete |
| `executeParallel` function | `src/pipeline-step.ts:195-272` | ~78 | ✅ Complete |
| `PipelineEngine` class | `src/pipeline-engine.ts:122-189` | ~67 | ✅ Complex (static DAG) |
| `validateDag` function | `src/pipeline-engine.ts:49-76` | ~27 | ✅ Basic DAG validation |
| `topologicalSort` function | `src/pipeline-engine.ts:79-106` | ~27 | ✅ Kahn algorithm |
| `PipelineContext` interface | `src/pipeline-step.ts:15-28` | ~13 | ⏳ Needs upgrade to StateContext |
| `PipelineDagNode` interface | `src/pipeline-dsl.ts:89-113` | ~24 | ⏳ Needs branches + transitions fields |
| `StepContract` interface | `src/pipeline-dsl.ts:151-164` | ~13 | ⏳ Needs reads/writes + route return |
| `executor.ts` main loop | `src/executor.ts` | ~480 | 🔴 Hardcoded linear — needs DAG integration |

### 5.2 Phase 1: Conditional Branching (Next Active Sprint)

**Goal**: Wire existing `ConditionalStep` + `PipelineEngine` to support branch-based non-linear execution.

| Step | Files Changed | Estimated Diff | Dependencies |
|------|--------------|---------------|--------------|
| 1. Add `branches` + `defaultBranch` to `PipelineDagNode` | `src/pipeline-dsl.ts` | ~20 lines | None |
| 2. Add `branches` + `defaultBranch` to ``StepContract` return type | `src/pipeline-dsl.ts` | ~10 lines | Step 1 |
| 3. Extend `validateDag` with branch target integrity checks | `src/pipeline-engine.ts` | ~30 lines | Step 1 |
| 4. Modify `PipelineEngine.execute()` loop to use branch routing | `src/pipeline-engine.ts` | ~40 lines | Steps 1-3 |
| 5. Add `TransitionRule` type + condition factories | `src/pipeline-step.ts` (or new `src/transition-rule.ts`) | ~40 lines | Step 4 |
| 6. Port `executor.ts` early-exit logic into a `ConditionalStep` fixture | `tests/` | ~50 lines | Steps 1-5 |

**Validation gate**: `maxAgentPasses` early-exit can be expressed as a `PipelineDagNode` with `branches: { "has_diff": "git_commit_push", "empty": "retry_execution" }` instead of hardcoded `if (stats.files > 0) break`.

**Risk**: Adding branches to PipelineEngine may increase the execute loop complexity by ~30%. Mitigate by keeping the non-branching path as the fast path (no allocation of the branch resolver when `branches` is undefined).

### 5.3 Phase 2: State Context + reads/writes (Next-Roadmap Sprint)

**Goal**: Upgrade `PipelineContext` to `StateContext` with immutable snapshots and declared dependency tracking.

| Step | Files Changed | Estimated Diff | Dependencies |
|------|--------------|---------------|--------------|
| 1. Implement `StateSnapshot` immutable class | `src/state-context.ts` (NEW) | ~60 lines | None |
| 2. Implement `StatePersister` interface + SQLite backend | `src/state-context.ts` + `src/db.ts` | ~80 lines | Step 1 |
| 3. Add `reads`/`writes` fields to `StepContract` | `src/pipeline-dsl.ts` | ~10 lines | None |
| 4. Add automatic parallelism detection from write-set conflicts | `src/pipeline-engine.ts` | ~25 lines | Step 3 |
| 5. Integrate `StateSnapshot` into `PipelineEngine.execute()` loop | `src/pipeline-engine.ts` | ~30 lines | Steps 1-4 |
| 6. Persist snapshots after each step completes (opt-in) | `src/pipeline-engine.ts` | ~15 lines | Step 2 |

**Validation gate**: A `StatefulStep` with `reads: ["diffStats"]` and `writes: ["qualityGates"]` that runs concurrently with another step that writes `["diffStats"]` should be automatically serialized by the engine.

**Risk**: Existing steps using the flat `PipelineContext.results` pattern will need migration. Mitigate by supporting `reads: ["*"]` as a compat fallback that triggers the old accumulation behavior.

### 5.4 Phase 3: Transition-Driven Dynamic Reordering (Evaluation Sprint)

**Goal**: Full runtime step selection using cost-aware + circuit-breaker transition rules.

| Step | Files Changed | Estimated Diff | Dependencies |
|------|--------------|---------------|--------------|
| 1. Implement `TransitionRule` condition engine with first-match-wins | `src/transition-rule.ts` (or extend `src/pipeline-step.ts`) | ~50 lines | Phase 1 |
| 2. Implement cost-aware + circuit-breaker condition factories | `src/transition-rule.ts` | ~40 lines | Step 1 |
| 3. Integrate transition rules into `PipelineEngine` execute loop | `src/pipeline-engine.ts` | ~30 lines | Steps 1-2 |
| 4. Add fallback/compat mode: linear order as default transition set | `src/pipeline-engine.ts` | ~15 lines | Step 3 |
| 5. Write test fixtures: cost-threshold reordering, circuit-breaker cooling | `tests/` | ~60 lines | Steps 1-4 |

**Validation gate**: Given a `PipelineDagDefinition` where step A has `transitions: [costThreshold(0.8, "cooldown"), { target: "B", condition: () => true }]` and cumulative cost > 80% of limit, the engine should route to "cooldown" instead of "B".

**Risk**: Dynamic reordering may expose hidden ordering dependencies (steps that implicitly depend on prior steps without declaring it). Mitigate with an "ordering audit" pass that runs the pipeline in linear mode first, records the output, then runs in dynamic mode and compares.

---

## 6. Appendix

### A. File Change Inventory

| File | Phase | Change Type | Estimated Δ |
|------|-------|-------------|-------------|
| `src/pipeline-dsl.ts` | P1, P2 | Add fields: `branches`, `defaultBranch`, `reads`, `writes`, `transitions` | +30 lines |
| `src/pipeline-engine.ts` | P1, P2, P3 | Branch-aware execute loop, validateDag extension, StateSnapshot integration, Transition routing | +100 lines |
| `src/pipeline-step.ts` | P1, P3 | Add `TransitionRule` type, condition factories, `StatefulStep` interface | +60 lines |
| `src/state-context.ts` | P2 | NEW: `StateSnapshot`, `StatePersister`, `StateDelta` types | ~80 lines |
| `src/db.ts` | P2 | Add `state_snapshots` table schema + CRUD (if not already in db.ts) | +40 lines |
| `src/executor.ts` | P1 (soft) | Optionally: replace hardcoded early-exit with `ConditionalStep` branch | -20 lines |
| `tests/` | P1-P3 | Integration + unit tests per phase | +200 lines total |

### B. Backward-Compatibility Strategy

| Change | Compat Mode | Trigger |
|--------|-------------|---------|
| `branches` on `PipelineDagNode` | `undefined` = static dependsOn topology (current behavior) | Absence of field |
| `reads`/`writes` on steps | `reads: ["*"]`, `writes: ["*"]` = full access (current behavior) | Absence of fields |
| `transitions` on nodes | `undefined` = use `branches` Record (Phase 1 compat) | Absence of field |
| State snapshots | Opt-in: only persisted when `StatePersister` is configured on the engine | Engine configuration |
| `executor.ts` | Unchanged — the linear pipeline remains the default execution mode | `mode: "hyper"` on Plan |

### C. Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Branch targets create reverse dependency cycles in DAG | Low | High (infinite loop) | validateDag extension blocks cycles at definition time |
| State persistence conflicts with existing PlanState table | Medium | Medium (schema drift) | Separate table, FK constraint not enforced, additive migration |
| Dynamic reordering exposes implicit step dependencies | Medium | Medium (non-deterministic output) | Ordering audit pass compares linear vs dynamic output |
| Transition condition evaluation adds latency to execute loop | Low | Low (function call overhead) | Conditions are synchronous, O(1) per rule |
| `reads: ["*"]` compat mode prevents parallelism detection | Low-Medium | Medium (all steps serialize) | Phase 2 migration guide encourages explicit declarations |
| Phase 1 scope overlaps with next roadmap "动态编排设计草案" | Medium | High (duplicate work) | This doc focuses on recommendation, not implementation — use as input to the design draft |

### D. Burr Pattern Mapping Reference

| Burr Pattern | P7 Target | Mapping Confidence | Key Gap |
|-------------|-----------|-------------------|---------|
| `State` immutable + `subset`/`merge` | `StateSnapshot` | ★★★ High | P7 lacks immutability pattern in state; `Readonly<Record>` in TS is a close equivalent |
| `Transition(from, to, condition)` | `TransitionRule` | ★★★ High | Burr uses Python expression strings; P7 uses TS function predicates — not serializable to JSON |
| `StatePersister` (SQLite/Postgres) | `StatePersister` interface | ★★★ High | P7 already has SQLite (`PlanState`); add a separate table for snapshot chain |
| `fork_from_sequence_id` | `loadBySequence()` | ★★☆ Medium | Requires full snapshot chain + versioned execution context; P7 doesn't have this concept today |
| `@trace()` decorator | `Hook` lifecycle | ★☆☆ Low | Decorator pattern requires TypeScript experimental decorators or explicit wrapper — low priority |
| `error(Exception, max=N)` | Transition retry policy | ★★☆ Medium | Engine already supports `retry` on node; integrate with transition routing for "retry→alternative" |

### E. References

- `docs/burr-executor-comparison.md` — 8-dimension Burr vs P7 analysis (primary source)
- `docs/hyper-agentic-pipeline-patterns.md` — HAP ConditionalStep, ParallelStep, DynamicPipeline proposals
- `src/pipeline-step.ts` — Existing primitives: ConditionalStep, ParallelStep, executeParallel
- `src/pipeline-engine.ts` — DAG validation, topological sort, execute loop
- `src/pipeline-dsl.ts` — PipelineDagNode, StepContract, ArtifactKind
- `src/executor.ts` — Linear 10-step pipeline production code
- `src/config.ts` — execution_retry, max_consecutive_failures, cost_limit configs
- Apache Burr Documentation (apache.org, v0.18.x) — State/Transition/Persister primitives

---

*This document distills the Burr comparison analysis into actionable design directions. The next step is to produce an implementation draft for Phase 1 (ConditionalStep → PipelineEngine integration) as the next ROADMAP Active step.*
