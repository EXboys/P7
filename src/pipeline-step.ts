/**
 * Pipeline step primitives for dynamic orchestration.
 *
 * ConditionalStep 原语定义：步骤通过 emit 的 route key 动态选择后续执行路径，
 * 支持单目标、多路扇出（fan-out）、以及默认回退。
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Runtime context carried through the pipeline execution chain. */
export interface PipelineContext {
  /** The top-level plan identifier that spawned this pipeline. */
  planId: string;
  /** Name of the currently executing step. */
  stepName: string;
  /** Accumulated outputs keyed by step name — populated as each step completes. */
  results: Record<string, unknown>;
  /**
   * Arbitrary metadata bag for executor-level concerns (sdkCost, permission
   * findings, tool traces). Shape is unstable until integration with real
   * executor; consumers should access via well-known keys only.
   */
  metadata?: Record<string, unknown>;
}

/** A single branch declaration mapping a route key to one or more next steps. */
export interface StepRoute {
  /** The route key matched against the value returned by a ConditionalStep. */
  key: string;
  /**
   * Next step name(s).
   * - `string`  → 1:1 单目标路由，pipeline 只执行一个后续步骤
   * - `string[]` → 扇出路由，pipeline 并行执行多个后续步骤
   */
  next: string | string[];
}

/** Output envelope produced by a completed pipeline step. */
export interface StepResult<T = unknown> {
  /** Name of the step that produced this result. */
  stepName: string;
  /** The output payload produced by the step. */
  output: T;
  /** Route key emitted at the end of step execution. */
  route: string;
  /** Wall-clock duration of step execution in milliseconds. */
  durationMs: number;
}

/**
 * A pipeline step that emits a route key after execution, enabling the
 * orchestrator (pipeline runner) to select the next step(s) dynamically.
 */
export interface ConditionalStep<TRoutes extends string = string> {
  /** Unique step name used for routing and result lookup. */
  name: string;
  /**
   * Execute the step logic.
   * @param ctx - The current pipeline context (includes accumulated results).
   * @returns A route key that determines the next step(s) to run.
   */
  execute: (ctx: PipelineContext) => Promise<string>;
  /** Declared branches this step can route to — used for static validation. */
  branches: StepRoute[];
  /**
   * Optional fallback target when the returned route key does not match any
   * declared branch. If omitted, an unmatched key throws at runtime.
   */
  defaultBranch?: string;
}

// ---------------------------------------------------------------------------
// Branch resolution & validation
// ---------------------------------------------------------------------------

/**
 * Resolve a runtime route key against a declared branch map.
 *
 * @param routeKey  - The key returned by a step's `execute()`.
 * @param branches  - The declared `StepRoute[]` from a `ConditionalStep`.
 * @param defaultBranch - Fallback step name when `routeKey` is not declared.
 * @returns The next step name (`string` for single-target) or names
 *          (`string[]` for fan-out).
 * @throws If `routeKey` is not in `branches` and no `defaultBranch` is given.
 */
export function resolveBranchRoute(
  routeKey: string,
  branches: StepRoute[],
  defaultBranch?: string,
): string | string[] {
  const matched = branches.find((b) => b.key === routeKey);
  if (matched) return matched.next;
  if (defaultBranch !== undefined) return defaultBranch;
  throw new Error(
    `resolveBranchRoute: unknown route key "${routeKey}" — ` +
    `no matching branch and no defaultBranch configured. ` +
    `Declared branches: [${branches.map((b) => b.key).join(", ")}]`,
  );
}

/**
 * Validate that all declared route keys are covered by the branch map.
 *
 * This is a **static** (runtime-executable) coverage check: you pass the
 * full set of keys a step is *expected* to emit, and this function returns
 * the subset that are **not** present in `branches`.
 *
 * @returns An array of missing route keys (empty = full coverage).
 */
export function validateBranchCoverage(
  expectedKeys: string[],
  branches: StepRoute[],
): string[] {
  const covered = new Set(branches.map((b) => b.key));
  return expectedKeys.filter((k) => !covered.has(k));
}

// ---------------------------------------------------------------------------
// ParallelStep: concurrent sub-step execution with aggregation strategies
// ---------------------------------------------------------------------------

/** Strategy for aggregating parallel sub-step results. */
export type ParallelStrategy = "all" | "any" | "race" | "quorum";

/** A single sub-step within a ParallelStep. */
export interface SubstepConfig<T = unknown> {
  /** Unique name for this sub-step within the parallel group. */
  name: string;
  /** Execute the sub-step logic. */
  execute: (ctx: PipelineContext) => Promise<T>;
  /**
   * Optional per-sub-step timeout in milliseconds.
   * When exceeded the sub-step is reported as `"timeout"` and continues
   * running in the background (no cancellation).
   */
  timeoutMs?: number;
}

/** Result envelope for a single parallel sub-step. */
export interface SubstepResult<T = unknown> {
  name: string;
  status: "success" | "failure" | "timeout";
  /** Payload produced on success; undefined on failure/timeout. */
  output?: T;
  /** Error message on failure or timeout description. */
  error?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/** Aggregate result produced by executeParallel(). */
export interface ParallelStepResult<T = unknown> {
  /** The strategy used for aggregation. */
  strategy: ParallelStrategy;
  /** Results of every sub-step (completed or abandoned). */
  substepResults: SubstepResult<T>[];
  /** Whether the parallel execution as a whole is considered successful. */
  success: boolean;
  /** Quorum metadata — only present when strategy is "quorum". */
  quorum?: { required: number; achieved: number };
  /** Total wall-clock duration across all sub-steps (wait + execution). */
  durationMs: number;
}

/** A pipeline step that executes sub-steps concurrently with aggregation. */
export interface ParallelStep<TRoutes extends string = string> {
  name: string;
  strategy: ParallelStrategy;
  substeps: SubstepConfig[];
  quorum?: number;
  branches: StepRoute[];
  defaultBranch?: string;
  execute: (ctx: PipelineContext) => Promise<ParallelStepResult>;
}

// ---------------------------------------------------------------------------
// executeParallel — run sub-steps concurrently, aggregate by strategy
// ---------------------------------------------------------------------------

/**
 * Execute an array of sub-steps concurrently and aggregate results according
 * to the chosen strategy.
 *
 * @param ctx      - Pipeline context (passed to each sub-step's execute).
 * @param substeps - Sub-step configurations to run in parallel.
 * @param strategy - Aggregation strategy (default: "all").
 * @param quorum   - Required success count for "quorum" strategy; defaults
 *                   to ceil(N/2)+1 (simple majority+1) when omitted.
 * @returns An aggregated ParallelStepResult covering all sub-steps.
 */
export async function executeParallel<T = unknown>(
  ctx: PipelineContext,
  substeps: SubstepConfig<T>[],
  strategy: ParallelStrategy = "all",
  quorum?: number,
): Promise<ParallelStepResult<T>> {
  const start = performance.now();

  if (substeps.length === 0) {
    return {
      strategy,
      substepResults: [],
      success: true,
      durationMs: 0,
    };
  }

  // Fire all sub-steps concurrently with per-step timeout protection
  const executions = substeps.map((s) =>
    executeOneSubstep(s.name, s.execute as (ctx: PipelineContext) => Promise<T>, ctx, s.timeoutMs),
  );

  switch (strategy) {
    case "all": {
      const substepResults = await Promise.all(executions);
      return {
        strategy,
        substepResults,
        success: substepResults.every((r) => r.status === "success"),
        durationMs: performance.now() - start,
      };
    }

    case "any": {
      const substepResults = await Promise.all(executions);
      return {
        strategy,
        substepResults,
        success: substepResults.some((r) => r.status === "success"),
        durationMs: performance.now() - start,
      };
    }

    case "race": {
      // First completed sub-step (by wall-clock) determines overall result.
      // Race FIRST (while sub-steps are still running), then gather all results.
      const raceWinner = await Promise.race(
        executions.map((p) => p.then((r) => r)),
      );
      const substepResults = await Promise.all(executions);
      return {
        strategy,
        substepResults,
        success: raceWinner.status === "success",
        durationMs: performance.now() - start,
      };
    }

    case "quorum": {
      const substepResults = await Promise.all(executions);
      const achieved = substepResults.filter((r) => r.status === "success").length;
      const required = quorum ?? Math.ceil(substeps.length / 2) + 1;
      return {
        strategy,
        substepResults,
        success: achieved >= required,
        quorum: { required, achieved },
        durationMs: performance.now() - start,
      };
    }

    default:
      throw new Error(
        `executeParallel: unknown strategy "${String(strategy)}" — ` +
        `expected one of: all, any, race, quorum`,
      );
  }
}

// ---------------------------------------------------------------------------
// Helper: execute a single sub-step with optional timeout
// ---------------------------------------------------------------------------

/**
 * Execute one sub-step and return a SubstepResult.
 *
 * The returned promise **never rejects**: errors and timeouts are captured
 * as structured result fields. The `settled` flag guards against races
 * between the sub-step completing and its timeout firing, preventing
 * double-resolution and unhandled rejection leaks.
 */
async function executeOneSubstep<T>(
  name: string,
  fn: (ctx: PipelineContext) => Promise<T>,
  ctx: PipelineContext,
  timeoutMs?: number,
): Promise<SubstepResult<T>> {
  const start = performance.now();

  if (timeoutMs === undefined || timeoutMs <= 0) {
    try {
      const output = await fn(ctx);
      return { name, status: "success", output, durationMs: performance.now() - start };
    } catch (error) {
      return {
        name,
        status: "failure",
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - start,
      };
    }
  }

  // With timeout — use a settled flag to avoid double-resolution
  return new Promise<SubstepResult<T>>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        name,
        status: "timeout",
        error: `Sub-step "${name}" timed out after ${timeoutMs}ms`,
        durationMs: performance.now() - start,
      });
    }, timeoutMs);

    fn(ctx).then(
      (output) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ name, status: "success", output, durationMs: performance.now() - start });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          name,
          status: "failure",
          error: error instanceof Error ? error.message : String(error),
          durationMs: performance.now() - start,
        });
      },
    );
  });
}
