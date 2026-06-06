/**
 * ── End-to-end integration test: full 6-node pipeline DAG ──
 *
 * Exercises PipelineEngine with all 6 real step implementations in a
 * single orchestrated execution:
 *
 *   Layer 0: extract-patterns + calibrate-thresholds
 *   Layer 1: analyze-convergence
 *   Layer 2: check-early-stop + inject-rules
 *   Layer 3: ab-validate
 *
 * Seeds plan_states with 10 synthetic finding rows for both
 * pattern_extract and threshold_calibrate (both DB-backed). Builds a
 * converging ConvergenceCurve (10 rounds, constant metrics → slope=0)
 * and pre-warms the early-stop plateau counter via 5 sequential
 * evaluateEarlyStop() calls so the pipeline-internal call triggers
 * shouldStop=true.
 *
 * Manually wires EngineStep entries that read ctx.artifacts by the
 * correct ArtifactKind keys (bypassing the known input routing bug in
 * runSelfIterationPipeline where the engine looks up artifacts by
 * StepKind rather than ArtifactKind).
 *
 * @module pipeline-e2e.test
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { PipelineEngine } from "../src/pipeline-engine.ts";
import type { EngineStep, PipelineExecutionReport } from "../src/pipeline-engine.ts";
import type { PipelineDagDefinition, ArtifactKind, StepExecutionContext } from "../src/pipeline-dsl.ts";
import type {
  ConvergenceCurve,
  SelfPlayRound,
  DynamicRule,
  DcSeverity,
} from "../src/types.ts";
import type {
  ConvergenceReport,
  DynamicRulesPayload,
} from "../src/pipeline-contracts.ts";
import {
  createPatternExtractStep,
  createThresholdCalibrateStep,
  dynamicRulesInjectStep,
  createAbValidateStep,
} from "../src/pipeline-steps.ts";
import { analyzeConvergenceTrend } from "../src/convergence-trend.ts";
import { evaluateEarlyStop, resetEarlyStopState } from "../src/early-stop.ts";
import { initDb, closeDb } from "../src/state.ts";

// ── Inline fixture builders ──

/** Minimal DynamicRule — convergence-trend only reads metrics, not rule counters. */
function r(dimension: string, version = 1): DynamicRule {
  return {
    dimension,
    pattern: `pattern/${dimension}`,
    hitCount: 0,
    falsePositiveCount: 0,
    falseNegativeCount: 0,
    version,
  };
}

/**
 * Build a SelfPlayRound with controlled convergence metrics.
 */
function buildRound(
  round: number,
  normalizedEntropy: number,
  drift: number,
  cv: number,
): SelfPlayRound {
  return {
    round,
    rules: [r("type-safety", 1)],
    metrics: {
      ruleEntropy: {
        entropy: 0.5,
        maxEntropy: 1,
        normalizedEntropy,
        dimensionCount: 2,
      },
      fprTrendDrift: {
        baselineFpr: 0.02,
        currentFpr: 0.02 + drift,
        drift,
        driftThreshold: 0.05,
        isDrifting: Math.abs(drift) > 0.05,
      },
      coverageStability: {
        mean: 5,
        standardDeviation: cv * 5,
        coefficientOfVariation: cv,
        dimensionCount: 3,
        cvThreshold: 0.5,
        isUnstable: cv > 0.5,
      },
      computedAt: new Date().toISOString(),
    },
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Build a flat-metric convergence curve.
 * Constant values give slope=0, R²=1 → all three metrics classify as "converging".
 */
function buildFlatCurve(
  numRounds: number,
  entropy = 0.15,
  drift = 0.02,
  cv = 0.30,
): ConvergenceCurve {
  return {
    rounds: Array.from({ length: numRounds }, (_, i) =>
      buildRound(i, entropy, drift, cv),
    ),
    totalRounds: numRounds,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate a single-line finding block as produced by the critic pipeline.
 * Compatible with parseFindings() from diff-critic.ts.
 */
function findingBlock(severity: string, dimension: string, message: string): string {
  return `- [${severity}] AI 生成代码特征-${dimension}: ${message}`;
}

/**
 * Generate a vulnerability-dimension finding with CWE and confidence.
 * parseFindings extracts confidence and cweId for dimension === "漏洞发现".
 */
function vulnFinding(
  severity: string,
  message: string,
  cwe: string,
  confidence: number,
): string {
  return (
    `- [${severity}] AI 生成代码特征-漏洞发现: ${message} ` +
    `[CWE-${cwe}] [confidence:${confidence}]`
  );
}

/**
 * Insert a plan_states row for testing. Uses INSERT OR IGNORE so the same
 * plan_id will not be duplicated on re-insertion.
 */
function insertState(
  db: Database,
  projectPath: string,
  planId: string,
  status: string,
  createdAt: string,
  diffCriticFindings: string | null,
): void {
  db.query(
    `INSERT OR IGNORE INTO plan_states
       (plan_id, project_path, goal, title, status, created_at, updated_at, diff_critic_findings)
     VALUES ($plan_id, $project_path, $goal, $title, $status, $created_at, $updated_at, $diff_critic_findings)`,
  ).run({
    $plan_id: planId,
    $project_path: projectPath,
    $goal: "pipeline-e2e-test",
    $title: planId,
    $status: status,
    $created_at: createdAt,
    $updated_at: createdAt,
    $diff_critic_findings: diffCriticFindings,
  });
}

// ── Shared test context ──

const noopCtx: StepExecutionContext = {
  planId: "e2e-plan",
  iterationRound: 0,
  artifacts: new Map(),
  signal: new AbortController().signal,
};

// ── Tests ──

describe("pipeline-e2e", () => {
  const dbDir = join(tmpdir(), `p7-e2e-${Date.now()}`);
  let db: Database;
  // Convergence curve fixture (10 rounds, constant metrics → converging)
  const curve = buildFlatCurve(10);

  // Module-level plateau counter resets
  beforeEach(() => {
    resetEarlyStopState();
  });

  afterAll(() => {
    closeDb(dbDir);
    rmSync(dbDir, { recursive: true, force: true });
  });

  test("full 6-node pipeline executes in topological order and detects convergence", async () => {
    // ── 1. Initialise DB and seed plan_states (10 synthetic records) ──
    db = initDb(dbDir);

    // TP records (failed plans → true positive labels for calibration)
    insertState(
      db, dbDir, "e2e-tp-1", "failed", "2026-06-01T00:00:00.000Z",
      vulnFinding("blocker", "SQL injection in user input parameter", "89", 0.95),
    );
    insertState(
      db, dbDir, "e2e-tp-2", "failed", "2026-06-02T00:00:00.000Z",
      vulnFinding("blocker", "Command injection in exec call", "77", 0.90),
    );
    insertState(
      db, dbDir, "e2e-tp-3", "failed", "2026-06-03T00:00:00.000Z",
      vulnFinding("blocker", "XSS in template rendering", "79", 0.88),
    );
    insertState(
      db, dbDir, "e2e-tp-4", "failed", "2026-06-04T00:00:00.000Z",
      vulnFinding("blocker", "SQL injection in user input parameter", "89", 0.92),
    );
    insertState(
      db, dbDir, "e2e-tp-5", "failed", "2026-06-05T00:00:00.000Z",
      [
        vulnFinding("blocker", "SQL injection in user input parameter", "89", 0.85),
        findingBlock("warning", "过度抽象", "Unnecessary abstraction in service layer"),
      ].join("\n"),
    );

    // FP records (merged/pushed plans → false positive labels)
    insertState(
      db, dbDir, "e2e-fp-1", "merged", "2026-06-01T00:00:00.000Z",
      vulnFinding("blocker", "Potential SQL injection (false alarm)", "89", 0.30),
    );
    insertState(
      db, dbDir, "e2e-fp-2", "merged", "2026-06-02T00:00:00.000Z",
      vulnFinding("blocker", "Overly cautious warning", "", 0.25),
    );
    insertState(
      db, dbDir, "e2e-fp-3", "pushed", "2026-06-03T00:00:00.000Z",
      vulnFinding("blocker", "False positive pattern in test file", "89", 0.15),
    );

    // Mixed-dimension records for pattern extraction variety
    insertState(
      db, dbDir, "e2e-mix-1", "merged", "2026-06-06T00:00:00.000Z",
      [
        findingBlock("warning", "模板重复", "Repeated try-catch pattern in every handler"),
        findingBlock("info", "不合理嵌套", "Callback nested 5 levels deep"),
      ].join("\n"),
    );
    insertState(
      db, dbDir, "e2e-mix-2", "failed", "2026-06-07T00:00:00.000Z",
      [
        findingBlock("warning", "模板重复", "Repeated error handling in middleware"),
        findingBlock("warning", "过度抽象", "Abstract factory over single use case"),
      ].join("\n"),
    );

    // ── 2. Pre-warm early-stop state ──
    // 5 sequential evaluateEarlyStop() calls with the flat convergence curve
    // stack the plateau counter to 5. The 6th call (inside the pipeline's
    // check-early-stop step) will reach plateauRounds (5) → shouldStop=true.
    resetEarlyStopState();
    for (let i = 0; i < 5; i++) {
      evaluateEarlyStop(curve);
    }

    // ── 3. Build DAG definition ──
    const dag: PipelineDagDefinition = {
      id: "self-iteration-e2e",
      description: "Full 6-node self-iteration pipeline",
      nodes: [
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
          dependsOn: ["calibrate-thresholds", "analyze-convergence"],
        },
        {
          id: "ab-validate",
          kind: "ab_validate",
          dependsOn: ["check-early-stop", "inject-rules"],
        },
      ],
      entryNodes: ["extract-patterns", "calibrate-thresholds"],
    };

    // ── 4. Wire EngineStep entries ──
    const patternExtractStep = createPatternExtractStep(db);
    const thresholdCalibrateStep = createThresholdCalibrateStep(db);
    const abValidateStep = createAbValidateStep(db);

    // Side-channel storage for step output assertions
    let convergenceReport: ConvergenceReport | null = null;
    let earlyStopDecision: unknown = null;

    const stepMap = new Map<string, EngineStep>([
      // Layer 0: extract patterns from historical judgment data
      [
        "extract-patterns",
        {
          nodeId: "extract-patterns",
          produces: "pattern_report" as ArtifactKind,
          async execute(
            _input: unknown,
            ctx: StepExecutionContext,
          ): Promise<unknown> {
            return patternExtractStep.execute({}, ctx);
          },
        },
      ],
      // Layer 0: calibrate thresholds from labeled dataset
      [
        "calibrate-thresholds",
        {
          nodeId: "calibrate-thresholds",
          produces: "calibration_report" as ArtifactKind,
          async execute(
            _input: unknown,
            ctx: StepExecutionContext,
          ): Promise<unknown> {
            return thresholdCalibrateStep.execute({}, ctx);
          },
        },
      ],
      // Layer 1: analyse convergence trend from the pre-built curve
      [
        "analyze-convergence",
        {
          nodeId: "analyze-convergence",
          produces: "convergence_report" as ArtifactKind,
          async execute(
            _input: unknown,
            _ctx: StepExecutionContext,
          ): Promise<unknown> {
            const analysis = analyzeConvergenceTrend(curve);
            const report: ConvergenceReport = {
              slope: analysis.entropyTrend.slope,
              rSquared: analysis.entropyTrend.rSquared,
              ruleEntropy:
                curve.rounds[curve.rounds.length - 1].metrics.ruleEntropy
                  .normalizedEntropy,
              fprDrift:
                curve.rounds[curve.rounds.length - 1].metrics.fprTrendDrift
                  .drift,
              trend: analysis.verdict,
              analyzedAt: analysis.analyzedAt,
            };
            convergenceReport = report;
            return report;
          },
        },
      ],
      // Layer 2: evaluate early stop (pre-warmed → shouldStop=true)
      [
        "check-early-stop",
        {
          nodeId: "check-early-stop",
          produces: "early_stop_decision" as ArtifactKind,
          async execute(
            _input: unknown,
            _ctx: StepExecutionContext,
          ): Promise<unknown> {
            const decision = evaluateEarlyStop(curve);
            earlyStopDecision = decision;
            return decision;
          },
        },
      ],
      // Layer 2: inject dynamic rules from calibration report
      [
        "inject-rules",
        {
          nodeId: "inject-rules",
          produces: "dynamic_rules_payload" as ArtifactKind,
          async execute(
            _input: unknown,
            ctx: StepExecutionContext,
          ): Promise<unknown> {
            const calibrationReport = ctx.artifacts.get(
              "calibration_report" as ArtifactKind,
            );
            return dynamicRulesInjectStep.execute(calibrationReport, ctx);
          },
        },
      ],
      // Layer 3: A/B validate injected rules against holdout data
      [
        "ab-validate",
        {
          nodeId: "ab-validate",
          produces: "ab_test_result" as ArtifactKind,
          async execute(
            _input: unknown,
            ctx: StepExecutionContext,
          ): Promise<unknown> {
            const payload = ctx.artifacts.get(
              "dynamic_rules_payload" as ArtifactKind,
            ) as DynamicRulesPayload;
            return abValidateStep.execute(payload, ctx);
          },
        },
      ],
    ]);

    // ── 5. Execute pipeline ──
    const report: PipelineExecutionReport = await new PipelineEngine().execute(
      dag,
      "e2e-plan",
      0,
      stepMap,
    );

    // ── 6. Assertions ──

    // (a) All 6 nodes completed
    expect(report.nodeStates).toHaveLength(6);
    for (const ns of report.nodeStates) {
      expect(ns.status).toBe("completed");
    }
    expect(report.succeeded).toBe(true);

    // (b) Topological order respects dependsOn
    const order = report.nodeStates.map((ns) => ns.nodeId);

    // Layer 0 nodes run first
    expect(order.indexOf("extract-patterns")).toBeLessThan(
      order.indexOf("analyze-convergence"),
    );
    expect(order.indexOf("calibrate-thresholds")).toBeLessThan(
      order.indexOf("inject-rules"),
    );

    // Layer 1 (analyze-convergence) before Layer 2
    expect(order.indexOf("analyze-convergence")).toBeLessThan(
      order.indexOf("check-early-stop"),
    );
    expect(order.indexOf("analyze-convergence")).toBeLessThan(
      order.indexOf("inject-rules"),
    );

    // Layer 2 nodes before Layer 3
    expect(order.indexOf("check-early-stop")).toBeLessThan(
      order.indexOf("ab-validate"),
    );
    expect(order.indexOf("inject-rules")).toBeLessThan(
      order.indexOf("ab-validate"),
    );

    // (c) Convergence analysis produced converging trend
    expect(convergenceReport).not.toBeNull();
    expect(convergenceReport!.trend).toBe("converging");
    expect(Math.abs(convergenceReport!.slope)).toBeLessThanOrEqual(0.01);
    expect(convergenceReport!.rSquared).toBeGreaterThanOrEqual(0.6);

    // (d) Early stop triggered with sufficient plateau duration
    expect(earlyStopDecision).not.toBeNull();
    const esd = earlyStopDecision as {
      shouldStop: boolean;
      plateauDuration: number;
      reason: string;
      frozenVersion: number | null;
    };
    expect(esd.shouldStop).toBe(true);
    expect(esd.plateauDuration).toBeGreaterThanOrEqual(5);
    expect(typeof esd.frozenVersion).toBe("number");
    expect(esd.reason).toContain("Convergence plateau");

    // (e) Artifacts propagated: inject-rules read calibration_report
    //    and ab-validate read dynamic_rules_payload without errors —
    //    proven by all nodes reaching "completed" status.

    // (f) Report meta-fields
    expect(report.pipelineId).toBe("self-iteration-e2e");
    expect(report.planId).toBe("e2e-plan");
    expect(report.totalNodes).toBe(6);
    expect(report.totalDurationMs).toBeGreaterThan(0);
    expect(report.startTime).toBeLessThan(report.endTime);
  });
});
