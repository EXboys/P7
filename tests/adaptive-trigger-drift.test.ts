/**
 * Integration test: adaptive trigger decision matrix under simulated drift.
 *
 * Validates the full decision pipeline:
 * 1. Decision matrix correctness — each action (continue/alert/freeze/rollback)
 *    fires at the right thresholds, priority cascade is respected
 * 2. 4-phase drift simulation — normal → FPR alert → FPR rollback → recovery,
 *    verifying action transitions across actual computeAllMetrics rounds
 * 3. Persistence round-trip — snapshot written via recordConvergenceSnapshot
 *    is retrieved through both listConvergenceSnapshots (time-window) and
 *    listConvergenceSnapshotsByIteration (iteration-range) with correct filters
 *
 * @see src/convergence-metrics.ts — evaluateAdaptiveTrigger, computeAllMetrics
 * @see src/state.ts — recordConvergenceSnapshot, listConvergenceSnapshots
 */

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  computeAllMetrics,
  evaluateAdaptiveTrigger,
  DEFAULT_TRIGGER_CONFIG,
} from "../src/convergence-metrics.ts";
import {
  recordConvergenceSnapshot,
  listConvergenceSnapshots,
  listConvergenceSnapshotsByIteration,
  initDb,
  closeDb,
} from "../src/state.ts";
import type {
  DynamicRule,
  ConvergenceMetrics,
  AdaptiveTriggerConfig,
} from "../src/types.ts";

/* ── Fixture builder ──────────────────────────────────────────────── */

function r(
  dim: string,
  hit: number,
  fp: number,
  fn = 0,
  ver = 1,
): DynamicRule {
  return {
    dimension: dim,
    pattern: `pattern/${dim}`,
    hitCount: hit,
    falsePositiveCount: fp,
    falseNegativeCount: fn,
    version: ver,
  };
}

/**
 * All-<dimension> ruleset: every rule belongs to the same dimension.
 * This produces normalisedEntropy = 0 (single dimension → entropy 0 → "low"),
 * isolating FPR drift and CV as the only action drivers.
 */
function singleDimRules(dim: string, count: number, perHit: number, perFp: number): DynamicRule[] {
  const rules: DynamicRule[] = [];
  for (let i = 0; i < count; i++) {
    rules.push(r(dim, perHit, perFp));
  }
  return rules;
}

/* ── Constants ─────────────────────────────────────────────────────── */

const PLAN_ID = "adaptive-trigger-drift-sim";
const BASELINE_FPR = 0.05;
const HIT_PER_RULE = 20;
const RULE_COUNT = 5;
const LOW_FP_RATIO = 1;   // FPR ≈ 0.05 → drift ≈ 0
const ALERT_FP_RATIO = 2;  // FPR ≈ 0.10 → drift ≈ 0.05 (alert threshold: 0.03)
const ROLLBACK_FP_RATIO = 5; // FPR ≈ 0.25 → drift ≈ 0.20 (rollback threshold: 0.10)

/* ── Test suite ────────────────────────────────────────────────────── */

describe("evaluateAdaptiveTrigger decision matrix", () => {

  /* ── Helper: build a ConvergenceMetrics snapshot with given FPR drift ── */
  function metricsWithDrift(drift: number): ConvergenceMetrics {
    // Use 1-dimension rules so entropy stays "low" (normalizedEntropy = 0)
    // and only FPR drift drives the action.
    return {
      ruleEntropy: { entropy: 0, maxEntropy: 0, normalizedEntropy: 0, dimensionCount: 1 },
      fprTrendDrift: {
        baselineFpr: BASELINE_FPR,
        currentFpr: BASELINE_FPR + drift,
        drift,
        driftThreshold: 0.05,
        isDrifting: drift > 0.05,
      },
      coverageStability: {
        mean: RULE_COUNT,
        standardDeviation: 0,
        coefficientOfVariation: 0,
        dimensionCount: 1,
        cvThreshold: 0.5,
        isUnstable: false,
      },
      computedAt: new Date().toISOString(),
    };
  }

  function metricsWithCv(cv: number): ConvergenceMetrics {
    return {
      ruleEntropy: { entropy: 0, maxEntropy: 0, normalizedEntropy: 0, dimensionCount: 1 },
      fprTrendDrift: {
        baselineFpr: BASELINE_FPR,
        currentFpr: BASELINE_FPR,
        drift: 0,
        driftThreshold: 0.05,
        isDrifting: false,
      },
      coverageStability: {
        mean: 10,
        standardDeviation: cv * 10,
        coefficientOfVariation: cv,
        dimensionCount: 2,
        cvThreshold: 0.5,
        isUnstable: cv > 0.5,
      },
      computedAt: new Date().toISOString(),
    };
  }

  function metricsWithEntropy(normalizedEntropy: number, cv: number): ConvergenceMetrics {
    const maxE = 1;
    const entropy = normalizedEntropy; // simplified: assume maxEntropy = 1
    return {
      ruleEntropy: {
        entropy,
        maxEntropy: maxE,
        normalizedEntropy,
        dimensionCount: 2,
      },
      fprTrendDrift: {
        baselineFpr: BASELINE_FPR,
        currentFpr: BASELINE_FPR,
        drift: 0,
        driftThreshold: 0.05,
        isDrifting: false,
      },
      coverageStability: {
        mean: 10,
        standardDeviation: cv * 10,
        coefficientOfVariation: cv,
        dimensionCount: 2,
        cvThreshold: 0.5,
        isUnstable: cv > 0.5,
      },
      computedAt: new Date().toISOString(),
    };
  }

  /* ── continue ─────────────────────────────────────────────────── */

  test("continue when all indicators within normal bounds", () => {
    const d = evaluateAdaptiveTrigger(metricsWithDrift(0));
    expect(d.action).toBe("continue");
    expect(d.triggeredBy).toEqual([]);
  });

  test("continue when small negative drift is harmless", () => {
    const d = evaluateAdaptiveTrigger(metricsWithDrift(-0.02));
    expect(d.action).toBe("continue");
  });

  /* ── alert via FPR drift ──────────────────────────────────────── */

  test("alert when FPR drift exceeds alert threshold but below rollback", () => {
    // drift = 0.05 → >= 0.03 (alert) but < 0.10 (rollback), entropy low, CV stable
    const d = evaluateAdaptiveTrigger(metricsWithDrift(0.05));
    expect(d.action).toBe("alert");
    expect(d.triggeredBy).toContain("fprTrendDrift");
  });

  test("alert via medium entropy alone", () => {
    // normalizedEntropy = 0.5 → "medium" (between 0.3 and 0.7)
    const d = evaluateAdaptiveTrigger(metricsWithEntropy(0.5, 0.3));
    expect(d.action).toBe("alert");
    expect(d.triggeredBy).toContain("ruleEntropy");
  });

  test("alert via CV >= cvAlert alone", () => {
    // CV = 0.5 → == cvAlert threshold (code checks >=)
    const d = evaluateAdaptiveTrigger(metricsWithEntropy(0.2, 0.5));
    expect(d.action).toBe("alert");
    expect(d.triggeredBy).toContain("coverageStability");
  });

  /* ── freeze via high entropy ──────────────────────────────────── */

  test("freeze when normalizedEntropy >= entropyHigh", () => {
    // normalizedEntropy = 0.7 → "high"
    const d = evaluateAdaptiveTrigger(metricsWithEntropy(0.7, 0.3));
    expect(d.action).toBe("freeze");
    expect(d.triggeredBy).toContain("ruleEntropy");
  });

  test("freeze when entropy medium AND CV >= cvAlert", () => {
    // normalizedEntropy = 0.5 (medium), CV = 0.5 (>= cvAlert)
    const d = evaluateAdaptiveTrigger(metricsWithEntropy(0.5, 0.5));
    expect(d.action).toBe("freeze");
    expect(d.triggeredBy).toContain("ruleEntropy");
    expect(d.triggeredBy).toContain("coverageStability");
  });

  /* ── rollback via FPR drift ───────────────────────────────────── */

  test("rollback when FPR drift >= fprDriftRollback", () => {
    const d = evaluateAdaptiveTrigger(metricsWithDrift(0.10));
    expect(d.action).toBe("rollback");
    expect(d.triggeredBy).toContain("fprTrendDrift");
  });

  test("rollback when CV >= cvRollback", () => {
    // CV = 0.8 → >= cvRollback
    const d = evaluateAdaptiveTrigger(metricsWithCv(0.8));
    expect(d.action).toBe("rollback");
    expect(d.triggeredBy).toContain("coverageStability");
  });

  /* ── Priority cascade ─────────────────────────────────────────── */

  test("rollback overrides freeze when both FPR drift and high entropy fire", () => {
    const d = evaluateAdaptiveTrigger({
      ...metricsWithEntropy(0.7, 0.3),
      fprTrendDrift: {
        baselineFpr: BASELINE_FPR,
        currentFpr: BASELINE_FPR + 0.10,
        drift: 0.10,
        driftThreshold: 0.05,
        isDrifting: true,
      },
    });
    // drift >= rollback (0.10) → rollback, even though entropy is "high"
    expect(d.action).toBe("rollback");
    expect(d.triggeredBy).toEqual(["fprTrendDrift"]);
  });

  test("rollback via CV overrides freeze from high entropy", () => {
    const d = evaluateAdaptiveTrigger({
      ...metricsWithEntropy(0.7, 0.3),
      coverageStability: {
        mean: 10,
        standardDeviation: 8,
        coefficientOfVariation: 0.8,
        dimensionCount: 2,
        cvThreshold: 0.5,
        isUnstable: true,
      },
    });
    // CV >= 0.8 → rollback, even though entropy is "high"
    expect(d.action).toBe("rollback");
    expect(d.triggeredBy).toEqual(["coverageStability"]);
  });

  test("freeze overrides alert when high entropy and FPR alert coexist", () => {
    const d = evaluateAdaptiveTrigger({
      ...metricsWithEntropy(0.7, 0.3),
      fprTrendDrift: {
        baselineFpr: BASELINE_FPR,
        currentFpr: BASELINE_FPR + 0.05,
        drift: 0.05,
        driftThreshold: 0.05,
        isDrifting: true,
      },
    });
    // entropy "high" → freeze, even though drift >= alert (0.05)
    expect(d.action).toBe("freeze");
    expect(d.triggeredBy).toEqual(["ruleEntropy"]);
  });

  test("alert overrides continue when medium entropy and low CV", () => {
    const d = evaluateAdaptiveTrigger(metricsWithEntropy(0.5, 0.3));
    expect(d.action).toBe("alert");
    expect(d.triggeredBy).toEqual(["ruleEntropy"]);
  });

  /* ── Custom config ────────────────────────────────────────────── */

  test("custom relaxed config suppresses alert that default would fire", () => {
    // drift = 0.05 with default config → alert
    // With custom config that raises alert threshold to 0.08 → continue
    const custom: AdaptiveTriggerConfig = {
      ...DEFAULT_TRIGGER_CONFIG,
      fprDriftAlert: 0.08,
    };
    const d = evaluateAdaptiveTrigger(metricsWithDrift(0.05), custom);
    expect(d.action).toBe("continue");
  });

  test("custom strict config triggers rollback earlier", () => {
    // drift = 0.05 with default config → alert (0.03 <= 0.05 < 0.10)
    // With custom config that lowers rollback threshold to 0.04 → rollback
    const custom: AdaptiveTriggerConfig = {
      ...DEFAULT_TRIGGER_CONFIG,
      fprDriftRollback: 0.04,
    };
    const d = evaluateAdaptiveTrigger(metricsWithDrift(0.05), custom);
    expect(d.action).toBe("rollback");
    expect(d.triggeredBy).toContain("fprTrendDrift");
  });
});

/* ── 4-phase drift simulation with persistence round-trip ──────────── */

describe("4-phase drift simulation with persistence round-trip", () => {
  const projectPath = join(tmpdir(), `p7-adaptive-trigger-${Date.now()}`);

  afterAll(() => {
    closeDb(projectPath);
    rmSync(projectPath, { recursive: true, force: true });
  });

  test("simulates normal → alert → rollback → recovery and verifies all checkpoints", () => {
    initDb(projectPath);

    /* ── Phase 1: Normal (continue) ──────────────────────────────── */
    // All rules in one dimension → normalizedEntropy = 0 (low);
    // FPR ≈ 0.05 → drift ≈ 0; CV = 0 → stable
    const normalRules = singleDimRules("complexity", RULE_COUNT, HIT_PER_RULE, LOW_FP_RATIO);
    const normalMetrics = computeAllMetrics(normalRules, BASELINE_FPR);
    const normalDecision = evaluateAdaptiveTrigger(normalMetrics);

    expect(normalDecision.action).toBe("continue");
    expect(normalDecision.triggeredBy).toEqual([]);

    recordConvergenceSnapshot(projectPath, normalMetrics, PLAN_ID, 0);
    Bun.sleepSync(1);

    /* ── Phase 2: FPR Alert ──────────────────────────────────────── */
    // Same dimension distribution, FPR drift crosses alert threshold (0.03)
    // but stays below rollback (0.10)
    const alertRules = singleDimRules("complexity", RULE_COUNT, HIT_PER_RULE, ALERT_FP_RATIO);
    const alertMetrics = computeAllMetrics(alertRules, BASELINE_FPR);
    const alertDecision = evaluateAdaptiveTrigger(alertMetrics);

    expect(alertDecision.action).toBe("alert");
    expect(alertDecision.triggeredBy).toContain("fprTrendDrift");

    recordConvergenceSnapshot(projectPath, alertMetrics, PLAN_ID, 1);
    Bun.sleepSync(1);

    /* ── Phase 3: FPR Rollback ───────────────────────────────────── */
    // FPR drift crosses the rollback threshold (0.10)
    const rollbackRules = singleDimRules("complexity", RULE_COUNT, HIT_PER_RULE, ROLLBACK_FP_RATIO);
    const rollbackMetrics = computeAllMetrics(rollbackRules, BASELINE_FPR);
    const rollbackDecision = evaluateAdaptiveTrigger(rollbackMetrics);

    expect(rollbackDecision.action).toBe("rollback");
    expect(rollbackDecision.triggeredBy).toContain("fprTrendDrift");

    recordConvergenceSnapshot(projectPath, rollbackMetrics, PLAN_ID, 2);
    Bun.sleepSync(1);

    /* ── Phase 4: Recovery (back to continue) ────────────────────── */
    // Ruleset recovered to low FPR
    const recoveryRules = singleDimRules("complexity", RULE_COUNT, HIT_PER_RULE, LOW_FP_RATIO);
    const recoveryMetrics = computeAllMetrics(recoveryRules, BASELINE_FPR);
    const recoveryDecision = evaluateAdaptiveTrigger(recoveryMetrics);

    expect(recoveryDecision.action).toBe("continue");
    expect(recoveryDecision.triggeredBy).toEqual([]);

    recordConvergenceSnapshot(projectPath, recoveryMetrics, PLAN_ID, 3);

    /* ── Verify action transitions match simulation phases ────────── */
    const actions = [
      normalDecision.action,
      alertDecision.action,
      rollbackDecision.action,
      recoveryDecision.action,
    ];
    expect(actions).toEqual(["continue", "alert", "rollback", "continue"]);

    /* ── Persistence round-trip: all 4 snapshots persisted ───────── */
    const allSnapshots = listConvergenceSnapshots(projectPath);
    expect(allSnapshots.length).toBe(4);

    const allByIteration = listConvergenceSnapshotsByIteration(projectPath, 0, 3);
    expect(allByIteration.length).toBe(4);

    /* ── Value fidelity ──────────────────────────────────────────── */
    // Sort time-window results chronologically to match insertion order
    const sorted = [...allSnapshots].sort((a, b) =>
      a.computedAt.localeCompare(b.computedAt),
    );
    // Store original metrics for direct fidelity comparison
    const originalMetrics = [normalMetrics, alertMetrics, rollbackMetrics, recoveryMetrics];

    for (let i = 0; i < 4; i++) {
      expect(sorted[i].ruleEntropy.entropy).toBeCloseTo(
        originalMetrics[i].ruleEntropy.entropy, 10,
      );
      expect(sorted[i].ruleEntropy.normalizedEntropy).toBeCloseTo(
        originalMetrics[i].ruleEntropy.normalizedEntropy, 10,
      );
      expect(sorted[i].fprTrendDrift.drift).toBeCloseTo(
        originalMetrics[i].fprTrendDrift.drift, 10,
      );
      expect(sorted[i].coverageStability.coefficientOfVariation).toBeCloseTo(
        originalMetrics[i].coverageStability.coefficientOfVariation, 10,
      );
    }

    // Phase 1: normal — drift ≈ 0
    expect(sorted[0].fprTrendDrift.drift).toBeCloseTo(0, 5);

    // Phase 2: alert — positive drift
    expect(sorted[1].fprTrendDrift.drift).toBeGreaterThan(0);

    // Phase 3: rollback — drift higher than alert phase
    expect(sorted[2].fprTrendDrift.drift).toBeGreaterThan(sorted[1].fprTrendDrift.drift);

    // Phase 4: recovery — drift back to ≈ 0
    expect(sorted[3].fprTrendDrift.drift).toBeCloseTo(0, 5);

    /* ── Time-window slicing ─────────────────────────────────────── */
    const since = sorted[1].computedAt;
    const until = sorted[2].computedAt;
    const timeSliced = listConvergenceSnapshots(projectPath, { since, until });
    expect(timeSliced.length).toBe(2); // phases 2 and 3 (alert + rollback)
    for (const m of timeSliced) {
      expect(m.computedAt >= since).toBe(true);
      expect(m.computedAt <= until).toBe(true);
    }

    /* ── Iteration-range slicing ─────────────────────────────────── */
    // Middle two phases (alert + rollback)
    const mid = listConvergenceSnapshotsByIteration(projectPath, 1, 2);
    expect(mid.length).toBe(2);

    // Single phase
    const single = listConvergenceSnapshotsByIteration(projectPath, 0, 0);
    expect(single.length).toBe(1);

    // Out of range → empty
    const empty = listConvergenceSnapshotsByIteration(projectPath, 99, 100);
    expect(empty.length).toBe(0);

    // Only first phase (normal)
    const early = listConvergenceSnapshotsByIteration(projectPath, 0, 1);
    expect(early.length).toBe(2);
  });
});
