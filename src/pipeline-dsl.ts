/**
 * ── Pipeline DAG orchestration DSL ──
 *
 * Type-level protocol for the recursive self-improvement pipeline DAG:
 * step kinds, DAG node/definition schemas, generic StepContract interface,
 * and artifact kind taxonomy.
 *
 * @module pipeline-dsl
 */

/**
 * The 6 step kinds in the self-iteration pipeline DAG.
 * Each kind maps to a dedicated step implementation.
 *
 * - `pattern_extract`: Extract failure patterns from historical review records
 * - `convergence_analyze`: Analyze convergence metrics across iteration rounds
 * - `early_stop`: Decide whether to early-stop based on convergence plateau
 * - `threshold_calibrate`: Calibrate severity thresholds using labeled dataset
 * - `dynamic_rules_inject`: Inject adjusted rules into the critic pipeline
 * - `ab_validate`: A/B validate injected rules against a holdout set
 *
 * ⚠️ This union must stay exhaustive — adding a new step kind requires updating
 * the union, PipelineDagNode condition types, and artifact mapping simultaneously.
 */
export type SelfIterationStepKind =
  | "pattern_extract"
  | "convergence_analyze"
  | "early_stop"
  | "threshold_calibrate"
  | "dynamic_rules_inject"
  | "ab_validate";

/**
 * Artifact kind union tagging all intermediate artifacts flowing between steps.
 *
 * - `pattern_report`: Output of pattern_extract step
 * - `convergence_report`: Output of convergence_analyze step
 * - `early_stop_decision`: Output of early_stop step
 * - `calibration_report`: Output of threshold_calibrate step
 * - `dynamic_rules_payload`: Output of dynamic_rules_inject step
 * - `ab_test_result`: Output of ab_validate step
 * - `convergence_curve`: Time-series convergence curve data
 * - `trend_analysis`: Trend analysis result (convergence_analyze secondary output)
 * - `freeze_snapshot`: Frozen rule version snapshot produced when early_stop fires
 */
export type ArtifactKind =
  | "pattern_report"
  | "convergence_report"
  | "early_stop_decision"
  | "calibration_report"
  | "dynamic_rules_payload"
  | "ab_test_result"
  | "convergence_curve"
  | "trend_analysis"
  | "freeze_snapshot";

/**
 * Execution context passed to every step contract's execute function.
 *
 * Provides iteration-scoped metadata, a shared artifact map populated by
 * upstream nodes, and an AbortSignal for cooperative cancellation.
 */
export interface StepExecutionContext {
  /** The plan ID this iteration belongs to */
  planId: string;
  /** 0-based iteration round number */
  iterationRound: number;
  /**
   * Artifacts produced by upstream steps, keyed by {@link ArtifactKind}.
   * The orchestration engine populates this map before each step executes.
   */
  artifacts: Map<ArtifactKind, unknown>;
  /** AbortSignal for cooperative cancellation (timeout or user interrupt) */
  signal: AbortSignal;
}

/**
 * A single node in the pipeline DAG.
 *
 * Each node references a {@link SelfIterationStepKind} and declares its
 * upstream dependencies, optional condition expression for branching,
 * retry policy, and execution timeout.
 *
 * The engine uses `dependsOn` to topologically sort nodes and resolve
 * artifact dependencies: a node whose kind is `convergence_analyze` with
 * `dependsOn: ["extract-patterns"]` expects `artifacts.get("pattern_report")`
 * to be available when its `execute` is called.
 */
export interface PipelineDagNode {
  /** Unique node identifier (e.g. "extract-patterns", "analyze-convergence") */
  id: string;
  /** Step kind that this node executes */
  kind: SelfIterationStepKind;
  /** IDs of nodes that must complete before this node runs */
  dependsOn: string[];
  /**
   * Optional condition expression for conditional branching.
   * Evaluated against upstream artifacts and context at runtime.
   * When falsy, the node is skipped (no-op, downstream sees no artifact).
   * Expression syntax is engine-defined (e.g. a JSONPath predicate).
   */
  condition?: string;
  /** Optional retry policy for transient step failures */
  retry?: {
    /** Maximum number of execution attempts (including the first) */
    maxAttempts: number;
    /** Base backoff delay in milliseconds (exponential backoff applied) */
    backoffMs: number;
  };
  /** Optional per-node timeout in milliseconds. Exceeding this triggers
   * `signal.aborted` and the step should terminate cooperatively. */
  timeoutMs?: number;
}

/**
 * Top-level DAG definition for the self-iteration pipeline.
 *
 * Defines the complete pipeline topology via a flat node list and an
 * explicit entry-point list. The orchestration engine validates:
 * - All entryNodes reference valid node ids
 * - Entry nodes have no dependsOn entries
 * - The dependency graph is acyclic (DAG property)
 * - All node ids are unique within the definition
 */
export interface PipelineDagDefinition {
  /** Unique pipeline identifier (e.g. "self-iteration-v1") */
  id: string;
  /** Human-readable description of the pipeline's purpose */
  description: string;
  /** All nodes in the DAG; node ids must be unique within this array */
  nodes: PipelineDagNode[];
  /**
   * Subset of node ids that have no dependencies and start the DAG.
   * The engine validates that entryNodes ⊆ nodes.map(n => n.id) and that no
   * entry node specifies dependsOn entries.
   */
  entryNodes: string[];
}

/**
 * Generic contract interface for a single pipeline step.
 *
 * Each step declares what artifact kinds it consumes and produces,
 * along with an idempotent execution function. The orchestration engine
 * uses this contract to wire steps together, resolve artifact dependencies,
 * and enforce the DAG execution order.
 *
 * @template Input - The step's input data type (deserialized from upstream artifacts)
 * @template Output - The step's output data type (persisted as a new artifact)
 */
export interface StepContract<Input, Output> {
  /** Human-readable description of what this step does */
  description: string;
  /** Artifact kinds this step reads as inputs */
  consumes: ArtifactKind[];
  /** Artifact kind this step produces as output */
  produces: ArtifactKind;
  /**
   * Execute the step logic with given input and execution context.
   * Implementations should respect `context.signal.aborted` for timely
   * termination on timeout or user interrupt.
   */
  execute: (input: Input, context: StepExecutionContext) => Promise<Output>;
}
