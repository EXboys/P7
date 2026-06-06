/**
 * ── Self-iteration pipeline orchestrator ──
 *
 * High-level wiring: creates the default 6-node DAG, builds step handlers
 * from existing business modules, executes via topological layer-by-layer
 * execution with concurrent fan-out, and collects structured execution
 * traces with per-step timing/status/results.
 *
 * @module pipeline-iterator
 */

import { Database } from "bun:sqlite";
import type {
  PipelineDagDefinition,
  PipelineDagNode,
  SelfIterationStepKind,
  ArtifactKind,
  StepExecutionContext,
} from "./pipeline-dsl.ts";
import { topologicalSort } from "./pipeline-engine.ts";
import type {
  PatternReport,
  CalibrationReport,
  ConvergenceReport,
  EarlyStopDecision,
  DynamicRulesPayload,
  AbTestResult,
} from "./pipeline-contracts.ts";
import type { ConvergenceCurve } from "./types.ts";
import {
  createPatternExtractStep,
  createThresholdCalibrateStep,
  dynamicRulesInjectStep,
  createAbValidateStep,
} from "./pipeline-steps.ts";
import { analyzeConvergenceTrend } from "./convergence-trend.ts";
import { evaluateEarlyStop, resetEarlyStopState } from "./early-stop.ts";

// ── Execution trace types ──

/** A single step's execution record within an {@link IterationTrace}. */
export interface StepTraceEntry {
  /** DAG node identifier (e.g. "extract-patterns") */
  nodeId: string;
  /** Step kind */
  kind: SelfIterationStepKind;
  /** Execution outcome */
  status: "completed" | "failed" | "skipped";
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Human-readable one-line result summary */
  resultSummary: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Complete execution trace for a single pipeline run.
 * Returned by {@link runSelfIterationPipeline} for CLI output.
 */
export interface IterationTrace {
  /** Plan ID this iteration belongs to */
  planId: string;
  /** 0-based iteration round number */
  iterationRound: number;
  /** Total number of DAG nodes */
  totalSteps: number;
  /** Nodes that completed successfully */
  completedSteps: number;
  /** Nodes that failed */
  failedSteps: number;
  /** Nodes that were skipped */
  skippedSteps: number;
  /** Total wall-clock duration in milliseconds */
  totalDurationMs: number;
  /** Per-step execution records */
  steps: StepTraceEntry[];
  /** Aggregate pipeline outcome based on step results */
  pipelineResult: "converged" | "diverged" | "inconclusive";
}

// ── Default 6-node DAG ──

/**
 * Create the default self-iteration pipeline DAG with 6 nodes.
 *
 * Topology:
 * ```
 * extract-patterns ──→ analyze-convergence ──→ check-early-stop
 *                                                      │
 * calibrate-thresholds ──→ inject-rules ──→ ab-validate
 * ```
 *
 * `extract-patterns` and `calibrate-thresholds` start in parallel (no deps).
 * `analyze-convergence` depends on `extract-patterns`.
 * `check-early-stop` depends on `analyze-convergence`.
 * `inject-rules` depends on `calibrate-thresholds`.
 * `ab-validate` depends on `inject-rules`.
 *
 * @returns A {@link PipelineDagDefinition} ready for engine execution
 */
export function createSelfIterationDag(): PipelineDagDefinition {
  const nodes: PipelineDagNode[] = [
    {
      id: "extract-patterns",
      kind: "pattern_extract",
      dependsOn: [],
    },
    {
      id: "calibrate-thresholds",
      kind: "threshold_calibrate",
      dependsOn: [],
    },
    {
      id: "analyze-convergence",
      kind: "convergence_analyze",
      dependsOn: ["extract-patterns"],
    },
    {
      id: "check-early-stop",
      kind: "early_stop",
      dependsOn: ["analyze-convergence"],
    },
    {
      id: "inject-rules",
      kind: "dynamic_rules_inject",
      dependsOn: ["calibrate-thresholds"],
    },
    {
      id: "ab-validate",
      kind: "ab_validate",
      dependsOn: ["inject-rules"],
    },
  ];

  return {
    id: "self-iteration-v1",
    description:
      "Default 6-node self-iteration pipeline: pattern extract, " +
      "threshold calibrate, convergence analyze, early stop, " +
      "dynamic rules inject, A/B validate",
    nodes,
    entryNodes: ["extract-patterns", "calibrate-thresholds"],
  };
}

// ── Step handler map type ──

/** Map of step kinds to their typed execute functions. */
export interface StepHandlerMap {
  pattern_extract: (
    input: unknown,
    ctx: StepExecutionContext,
  ) => Promise<PatternReport>;
  threshold_calibrate: (
    input: unknown,
    ctx: StepExecutionContext,
  ) => Promise<CalibrationReport>;
  convergence_analyze: (
    input: unknown,
    ctx: StepExecutionContext,
  ) => Promise<ConvergenceReport>;
  early_stop: (
    input: unknown,
    ctx: StepExecutionContext,
  ) => Promise<EarlyStopDecision>;
  dynamic_rules_inject: (
    input: unknown,
    ctx: StepExecutionContext,
  ) => Promise<DynamicRulesPayload>;
  ab_validate: (
    input: unknown,
    ctx: StepExecutionContext,
  ) => Promise<AbTestResult>;
}

// ── Step handler factory ──

/**
 * Build step handler map from existing business modules.
 *
 * Each handler delegates to the corresponding StepContract implementation
 * from pipeline-steps.ts, with shallow wrappers for `convergence_analyze`
 * and `early_stop` that extract convergence curve data from the artifact map.
 *
 * @param db — Open bun:sqlite Database handle (must outlive the pipeline run)
 * @returns A fully populated StepHandlerMap
 */
export function buildStepHandlers(db: Database): StepHandlerMap {
  const patternExtractStep = createPatternExtractStep(db);
  const thresholdCalibrateStep = createThresholdCalibrateStep(db);
  const abValidateStep = createAbValidateStep(db);

  return {
    pattern_extract: (input, ctx) =>
      patternExtractStep.execute(input as Record<string, unknown>, ctx),

    threshold_calibrate: (input, ctx) =>
      thresholdCalibrateStep.execute(input as Record<string, unknown>, ctx),

    convergence_analyze: async (_input, ctx) => {
      const curve = ctx.artifacts.get("convergence_curve") as
        | ConvergenceCurve
        | undefined;
      if (!curve || curve.rounds.length === 0) {
        return {
          slope: 0,
          rSquared: 0,
          ruleEntropy: 0,
          fprDrift: 0,
          trend: "insufficient_data" as const,
          analyzedAt: new Date().toISOString(),
        };
      }
      const analysis = analyzeConvergenceTrend(curve);
      const latest = curve.rounds[curve.rounds.length - 1];
      return {
        slope: analysis.entropyTrend.slope,
        rSquared: analysis.entropyTrend.rSquared,
        ruleEntropy: latest.metrics.ruleEntropy.normalizedEntropy,
        fprDrift: latest.metrics.fprTrendDrift.drift,
        trend: analysis.verdict,
        analyzedAt: new Date().toISOString(),
      };
    },

    early_stop: async (_input, ctx) => {
      const curve = ctx.artifacts.get("convergence_curve") as
        | ConvergenceCurve
        | undefined;
      if (!curve || curve.rounds.length === 0) {
        return {
          shouldStop: false,
          reason: "No convergence curve available in artifacts",
          plateauDuration: 0,
          frozenVersion: null,
          triggeredAt: new Date().toISOString(),
          trendAnalysis: {
            entropySlope: 0,
            fprDriftSlope: 0,
            coverageCvSlope: 0,
            verdict: "insufficient_data" as const,
          },
        };
      }
      // evaluateEarlyStop returns types.ts EarlyStopDecision with
      // ConvergenceTrendAnalysis; map to pipeline-contracts flattened shape
      const decision = evaluateEarlyStop(curve);
      return {
        shouldStop: decision.shouldStop,
        reason: decision.reason,
        plateauDuration: decision.plateauDuration,
        frozenVersion: decision.frozenVersion,
        triggeredAt: decision.triggeredAt,
        trendAnalysis: {
          entropySlope: decision.trendAnalysis.entropyTrend.slope,
          fprDriftSlope: decision.trendAnalysis.fprDriftTrend.slope,
          coverageCvSlope: decision.trendAnalysis.coverageCvTrend.slope,
          verdict: decision.trendAnalysis.verdict,
        },
      };
    },

    dynamic_rules_inject: (input, ctx) =>
      dynamicRulesInjectStep.execute(input as CalibrationReport, ctx),

    ab_validate: (input, ctx) =>
      abValidateStep.execute(input as DynamicRulesPayload, ctx),
  };
}

// ── Result summary helpers ──

function summarizeReport(
  kind: SelfIterationStepKind,
  output: unknown,
): string {
  switch (kind) {
    case "pattern_extract": {
      const r = output as PatternReport;
      return `Found ${r.patterns.length} patterns across ${r.scannedRecords} records in ${r.dimensions.length} dimensions`;
    }
    case "threshold_calibrate": {
      const r = output as CalibrationReport;
      return `F1=${r.f1.toFixed(3)}, sampleSize=${r.sampleSize}, precision=${r.precision.toFixed(3)}, recall=${r.recall.toFixed(3)}`;
    }
    case "convergence_analyze": {
      const r = output as ConvergenceReport;
      return `trend=${r.trend}, slope=${r.slope.toFixed(4)}, R²=${r.rSquared.toFixed(3)}`;
    }
    case "early_stop": {
      const r = output as EarlyStopDecision;
      return `shouldStop=${r.shouldStop}, plateauDuration=${r.plateauDuration}, frozenVersion=${r.frozenVersion ?? "null"}`;
    }
    case "dynamic_rules_inject": {
      const r = output as DynamicRulesPayload;
      return `Injected ${r.rules.length} rules at ${r.injectedAt}`;
    }
    case "ab_validate": {
      const r = output as AbTestResult;
      return `verdict=${r.verdict}, recall: ${r.recallBefore.toFixed(3)}→${r.recallAfter.toFixed(3)}, FPR: ${r.fprBefore.toFixed(3)}→${r.fprAfter.toFixed(3)}`;
    }
  }
}

// ── Kind-to-artifact mapping ──

function kindToArtifactKind(
  kind: SelfIterationStepKind,
): ArtifactKind | null {
  switch (kind) {
    case "pattern_extract":
      return "pattern_report";
    case "convergence_analyze":
      return "convergence_report";
    case "early_stop":
      return "early_stop_decision";
    case "threshold_calibrate":
      return "calibration_report";
    case "dynamic_rules_inject":
      return "dynamic_rules_payload";
    case "ab_validate":
      return "ab_test_result";
  }
}

// ── Main orchestrator ──

/**
 * Execute the self-iteration pipeline and return a structured execution trace.
 *
 * Orchestration flow:
 * 1. Create default 6-node DAG via {@link createSelfIterationDag}
 * 2. Build step handlers via {@link buildStepHandlers}
 * 3. Compute topological layers using Kahn's algorithm (from pipeline-engine)
 * 4. Execute steps layer-by-layer with concurrent fan-out within each layer
 * 5. Propagate step outputs through the shared artifact map
 * 6. Collect timing, error, and result summaries into an {@link IterationTrace}
 * 7. Print a formatted timeline to console
 *
 * @param db — Open bun:sqlite Database handle
 * @param planId — Plan ID for scoping
 * @param iterationRound — Current iteration round number
 * @returns A completed IterationTrace with per-step timing and summaries
 */
export async function runSelfIterationPipeline(
  db: Database,
  planId: string,
  iterationRound: number,
): Promise<IterationTrace> {
  // Reset early-stop state for fresh evaluation
  resetEarlyStopState();

  const dag = createSelfIterationDag();
  const handlers = buildStepHandlers(db);
  const nodeMap = new Map(dag.nodes.map((n) => [n.id, n]));
  const layers = topologicalSort(dag);
  const artifacts = new Map<ArtifactKind, unknown>();
  const steps: StepTraceEntry[] = [];
  const startTime = performance.now();

  const baseCtx: StepExecutionContext = {
    planId,
    iterationRound,
    artifacts,
    signal: new AbortController().signal,
  };

  for (const layer of layers) {
    const layerResults = await Promise.all(
      layer.map(async (nodeId) => {
        const node = nodeMap.get(nodeId)!;
        const kind = node.kind;
        const handler = handlers[kind];
        const stepStart = performance.now();
        const entry: StepTraceEntry = {
          nodeId,
          kind,
          status: "completed",
          durationMs: 0,
          resultSummary: "",
        };

        // Build input map from upstream artifacts
        const input: Record<string, unknown> = {};
        for (const depId of node.dependsOn) {
          const depNode = nodeMap.get(depId);
          if (depNode) {
            const depKind = depNode.kind as unknown as ArtifactKind;
            input[depId] = artifacts.get(depKind);
          }
        }

        try {
          const output = await handler(input, baseCtx);
          entry.resultSummary = summarizeReport(kind, output);

          // Store output artifact for downstream steps
          const artifactKind = kindToArtifactKind(kind);
          if (artifactKind && output !== undefined) {
            artifacts.set(artifactKind, output);
          }
        } catch (err) {
          entry.status = "failed";
          entry.error = err instanceof Error ? err.message : String(err);
          entry.resultSummary = `ERROR: ${entry.error}`;
        }

        entry.durationMs = Math.round(performance.now() - stepStart);
        return entry;
      }),
    );

    steps.push(...layerResults);
  }

  const totalDurationMs = Math.round(performance.now() - startTime);
  const completedSteps = steps.filter((s) => s.status === "completed").length;
  const failedSteps = steps.filter((s) => s.status === "failed").length;
  const skippedSteps = steps.filter((s) => s.status === "skipped").length;

  const pipelineResult: "converged" | "diverged" | "inconclusive" =
    failedSteps > 0 ? "diverged" : "converged";

  // ── Formatted timeline output ──
  console.log(
    `\n── Pipeline: ${dag.id} (plan: ${planId}, round: ${iterationRound}) ──`,
  );
  console.log("─".repeat(78));
  console.log(
    `${"NODE".padEnd(22)} ${"KIND".padEnd(20)} ${"STATUS".padEnd(12)} ${"DURATION".padEnd(10)} SUMMARY`,
  );
  console.log("─".repeat(78));
  for (const step of steps) {
    console.log(
      `${step.nodeId.padEnd(22)} ${step.kind.padEnd(20)} ${step.status.padEnd(12)} ${`${step.durationMs}ms`.padEnd(10)} ${step.resultSummary}`,
    );
  }
  console.log("─".repeat(78));
  console.log(
    `Total: ${totalDurationMs}ms | completed=${completedSteps} failed=${failedSteps} skipped=${skippedSteps} | result=${pipelineResult}\n`,
  );

  return {
    planId,
    iterationRound,
    totalSteps: dag.nodes.length,
    completedSteps,
    failedSteps,
    skippedSteps,
    totalDurationMs,
    steps,
    pipelineResult,
  };
}
