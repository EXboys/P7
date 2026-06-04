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
