# Hyper Agentic Pipeline Dynamic Orchestration Patterns

> A design note analyzing conditional branching, parallel fan-out, and dynamic reordering for P7's executor pipeline.

## 1. Background & Motivation

P7's `executor.ts` (lines 341-808) runs a **strictly linear pipeline**:

```
worktree_create → sdk_execution → diff_check → typecheck → test → diff_critic → git_commit_push → vcs_publish
```

All nine steps execute sequentially with zero dynamic branching, parallelism, or runtime reordering. While this linear model ensures predictability, three limitations have emerged from real execution traces:

- **Wasted SDK passes** (line 460-546): The SDK pass retries twice unconditionally (`maxAgentPasses = 2`), even when the first pass already produced all changes. No early-exit branch.
- **Uniform post-processing** (lines 575-663): diff_check, typecheck, test, diff_critic all run regardless of diff size or change type. A 5-line config change pays the same overhead as a 200-line feature diff.
- **No result-dependent routing**: The output of one step cannot alter the *set* of subsequent steps. For example, a typecheck failure always throws (line 602) instead of branching into a targeted fix-retry path.

**Hyper agentic orchestration** addresses these gaps by treating pipeline steps as composable, context-aware primitives that can branch, fan out, and reorder dynamically based on pipeline execution state.

## 2. Conditional Branching

### Concept

Conditional branching routes pipeline execution based on prior step outcomes — not just pass/fail, but rich signals like diff size, typecheck severity, or cost.

### Proposed Primitive: `ConditionalStep<T>`

```typescript
interface ConditionalStep<T = unknown> {
  name: string;
  /** Execute this step; returns a result and a routing key */
  execute(ctx: PipelineContext): Promise<{
    result: T;
    route: string; // routing key for branch selection
  }>;
  /** Branch map: route → next step name(s) */
  branches: Record<string, string | string[]>;
  /** Fallback if route is not in branches */
  defaultBranch?: string | string[];
}
```

### P7 Mapping

| Current Behavior | Conditional Branch |
|---|---|
| `maxAgentPasses=2` always (line 460) | Branch on `stats.files > 0` → skip pass 2 |
| `test` always runs (line 607) | Branch on `diff_stats.lines < 10` → skip test |
| `diff_critic` always runs (line 621) | Branch on `tc.ok && hasChanges` → skip critic if no changes |

### Example: Early-Exit SDK Pass

```typescript
const sdkStep: ConditionalStep = {
  name: "sdk_execution",
  execute: async (ctx) => {
    const result = await runSdkQuery(ctx);
    const files = diffStatsAgainstBase(ctx.wtPath, ctx.baseCommit).files;
    return { result, route: files > 0 ? "has_diff" : "empty" };
  },
  branches: { has_diff: ["diff_check"], empty: ["retry_execution"] },
  defaultBranch: "diff_check",
};
```

### Assumptions

- Branch keys are static strings defined at plan time, not computed dynamically from LLM output.
- Multi-fan-out (one route → multiple next steps) is supported but not the common case.

## 3. Parallel Fan-Out

### Concept

Parallel fan-out executes multiple sub-steps concurrently and aggregates their results. This is useful when pipeline stages are independent — e.g., typechecking and linting can run simultaneously, or multiple diff-critic dimensions can evaluate in parallel.

### Proposed Primitive: `ParallelStep`

```typescript
interface ParallelStep<T = unknown> {
  name: string;
  /** Sub-steps to execute concurrently */
  substeps: Array<{
    name: string;
    execute(ctx: PipelineContext): Promise<T>;
  }>;
  /** Aggregation strategy */
  strategy: "all" | "any" | "race" | "quorum";
  /** Quorum threshold (only for "quorum" strategy) */
  quorum?: number;
  /** Timeout per sub-step, ms */
  timeoutMs?: number;
}
```

### P7 Mapping

| Current Behavior | Parallel Fan-Out |
|---|---|
| Steps run sequentially (lines 575-663) | Run typecheck + test + diff_critic in parallel |
| Single-threaded diff review | Fan out per-dimension (6 dimensions × 1 agent call each) |
| `writeStepState` serial per step | Aggregate step states from parallel forks |

### Example: Parallel Quality Gates

```typescript
const qualityGates: ParallelStep = {
  name: "quality_gates",
  substeps: [
    { name: "typecheck", execute: (ctx) => runTypecheck(ctx.wtPath) },
    { name: "test", execute: (ctx) => runTests(ctx.wtPath, ctx.cfg) },
    { name: "diff_critic", execute: (ctx) => reviewDiff(ctx.wtPath, ctx.diffStatOut, ctx.planTitle) },
  ],
  strategy: "all", // all must pass
  timeoutMs: 30000,
};
```

### Assumptions

- Sub-steps must be **pure in terms of pipeline state** — no sub-step depends on another's output. Shared mutable state (worktree path, config) is read-only.
- The `all` strategy fails on the first sub-step rejection; `any` succeeds on the first success; `race` returns the first completed (success or failure); `quorum` requires N sub-steps to agree.
- Cost tracking (`sdkCost`) must be merged from all sub-step results.

## 4. Dynamic Reordering

### Concept

Dynamic reordering selects the next pipeline step at runtime based on pipeline execution context — diff size, change category, historical cost, or resource availability. Unlike conditional branching (which chooses between fixed branches), reordering can reorder, skip, or insert steps.

### Proposed Primitive: `DynamicPipeline`

```typescript
interface StepEvaluator {
  name: string;
  /** Priority score — higher = earlier execution */
  score(ctx: PipelineContext): number;
  /** Whether this step is eligible given current context */
  eligible(ctx: PipelineContext): boolean;
  /** Execute the step */
  execute(ctx: PipelineContext): Promise<void>;
}

interface DynamicPipeline {
  /** All available steps */
  steps: StepEvaluator[];
  /** Select the next step from the eligible set */
  selectNext(ctx: PipelineContext, remaining: StepEvaluator[]): StepEvaluator;
}
```

### P7 Mapping

| Current Behavior | Dynamic Reordering |
|---|---|
| Fixed order: `typecheck → test → critic` (lines 599-663) | If diff < 10 lines: run critic first (cheaper), skip test |
| Uniform retry for all failures | If typecheck fails: insert auto-fix step before retry |
| Cost-insensitive ordering | If budget consumed > 80%: skip non-critical gates |

### Example: Cost-Aware Reordering

```typescript
class AdaptivePipeline implements DynamicPipeline {
  steps = [diffCheckStep, typecheckStep, testStep, criticStep];

  selectNext(ctx, remaining): StepEvaluator {
    const budgetRatio = ctx.cumulativeCost / ctx.executionCostLimit;
    if (budgetRatio > 0.8) {
      // Near budget limit: prioritize cheap, high-signal gates
      return remaining.sort((a, b) => b.signalToCostRatio(ctx) - a.signalToCostRatio(ctx))[0];
    }
    return remaining.sort((a, b) => b.score(ctx) - a.score(ctx))[0];
  }
}
```

### Assumptions

- Step ordering is *soft* — the pipeline must produce equivalent outcomes regardless of order (quality gates are commutative). This holds for independent quality gates but may break for steps with hidden dependencies.
- An escape hatch is required: if reordering loops or stalls, fall back to the linear default order.
- Each step must declare its estimated cost and signal value for the evaluator to compute trade-offs.

## 5. Comparison Matrix

| Dimension | Conditional Branching | Parallel Fan-Out | Dynamic Reordering |
|---|---|---|---|
| **Complexity** | Low (static route map) | Medium (concurrency mgmt) | High (runtime evaluator) |
| **Use Case** | Early-exit, retry routing | Independent quality gates | Cost-aware scheduling |
| **Risk** | Route explosion (N branches × M steps) | Shared state races | Order-dependent outcomes |
| **Benefit** | Skips unnecessary work immediately | Reduces wall-clock by 2-3× | Optimal resource allocation |
| **P7 Alignment** | Direct fit: maps to `maxAgentPasses` branching | Fits: typecheck + test + critic are independent | Partial fit: most P7 steps have hidden ordering deps |
| **Implementation Effort** | ~150 lines (ConditionalStep + branch resolver) | ~250 lines (ParallelStep + result aggregator) | ~400 lines (DynamicPipeline + evaluator + fallback) |
| **Testability** | High (branch table is declarative) | Medium (need concurrent test harness) | Low (depends on runtime context) |

## 6. Phased Implementation Roadmap

### Phase 1 (Next Active Step)

**Implement ConditionalStep branching** — lowest effort, highest immediate value:
- Extract the `maxAgentPasses` retry into a conditional branch (early-exit when diff > 0).
- Add a `branches` field to the step execution model.
- Validate with: 2 fixture plans (one with immediate diff, one requiring retry).

### Phase 2

**Implement ParallelStep fan-out** for independent quality gates:
- Run typecheck, test, and diff_critic concurrently within a configurable timeout.
- Aggregate step states and cost from parallel forks.
- Validate with: 5 fixture plans of varying diff sizes, measure wall-clock reduction.

### Phase 3

**Implement DynamicPipeline reordering** (conditional on Phase 1 & 2 success):
- Build the `StepEvaluator` scoring model (cost, signal value, elapsed time).
- Implement cost-aware scheduling with linear fallback.
- Validate with: 10 production execution traces, compare cost and duration vs linear baseline.

## 7. Conclusions & Recommendations

1. **Implement ConditionalStep first** (Phase 1) — it directly addresses the most painful inefficiency (unnecessary retry passes) with the lowest complexity and risk.
2. **Parallel fan-out should follow** (Phase 2) — the three quality gates (typecheck, test, critic) are already independent in `executor.ts` and can safely run concurrently, offering 2-3× wall-clock improvement.
3. **Dynamic reordering requires more design** (Phase 3) — P7's pipeline steps have subtle ordering dependencies (e.g., diff_critic requires `diffStatOut` from the prior step). A full dependency graph must be extracted before implementing runtime reordering.
4. **All three patterns compose**: a ParallelStep can contain ConditionalSteps, and a DynamicPipeline can use ConditionalSteps as building blocks. The primitives are designed to nest.
5. **Backward compatibility**: existing linear executor behavior must remain as the default execution strategy. Hyper patterns are opt-in per plan via a `mode: "linear" | "hyper"` field, defaulting to `linear`.

---

*Analysis date: 2026-06-04 | Based on executor.ts @ 1fd6b1e*
