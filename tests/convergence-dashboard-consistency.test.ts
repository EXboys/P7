/**
 * Integration test: convergence dashboard data consistency with self-play loop.
 *
 * Validates that ConvergenceMetrics computed via computeAllMetrics are
 * correctly persisted to PlanState and retrievable through both time-window
 * (listConvergenceSnapshots) and iteration-range
 * (listConvergenceSnapshotsByIteration) query interfaces.
 *
 * The self-play fixture generator models 6 realistic iterations:
 * exploration → convergence → FPR drift → recovery → overfitting.
 *
 * @see src/convergence-metrics.ts
 * @see src/state.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { computeAllMetrics } from "../src/convergence-metrics.ts";
import {
  recordConvergenceSnapshot,
  listConvergenceSnapshots,
  listConvergenceSnapshotsByIteration,
  initDb,
  closeDb,
} from "../src/state.ts";
import type { DynamicRule, ConvergenceMetrics } from "../src/types.ts";

/* ── Fixture generator: 6 rounds of self-play iterations ─────────── */

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

function buildSelfPlayIteration(round: number): DynamicRule[] {
  switch (round) {
    case 0:
      /* Exploration: 5 dims × 2 rules → high entropy, stable coverage */
      return [
        r("complexity", 10, 1), r("complexity", 8, 0),
        r("type-safety", 12, 1), r("type-safety", 6, 0),
        r("security", 9, 1), r("security", 7, 0),
        r("performance", 11, 1), r("performance", 5, 0),
        r("docs", 8, 0), r("docs", 10, 1),
      ];
    case 1:
      /* Early convergence: 3 dims (4-3-2) → entropy drops */
      return [
        r("complexity", 15, 1), r("complexity", 12, 0),
        r("complexity", 10, 0), r("complexity", 8, 1),
        r("type-safety", 14, 1), r("type-safety", 9, 0),
        r("type-safety", 7, 0),
        r("security", 10, 0), r("security", 6, 0),
      ];
    case 2:
      /* Convergence: 2 dims (6-2) → low entropy, stable */
      return [
        r("complexity", 20, 1), r("complexity", 18, 0),
        r("complexity", 15, 0), r("complexity", 12, 1),
        r("complexity", 10, 0), r("complexity", 8, 0),
        r("type-safety", 14, 1), r("type-safety", 10, 0),
      ];
    case 3:
      /* FPR drift: same distribution as round 2, high FP ratios */
      return [
        r("complexity", 20, 8), r("complexity", 18, 6),
        r("complexity", 15, 5), r("complexity", 12, 4),
        r("complexity", 10, 3), r("complexity", 8, 2),
        r("type-safety", 14, 5), r("type-safety", 10, 3),
      ];
    case 4:
      /* Recovery: cleaned-up rules, low FP again */
      return [
        r("complexity", 22, 1), r("complexity", 20, 0),
        r("complexity", 18, 0), r("complexity", 14, 0),
        r("complexity", 12, 0), r("complexity", 10, 0),
        r("type-safety", 16, 1), r("type-safety", 12, 0),
      ];
    case 5:
      /* Overfitting: 7-1 dimension split → CV > 0.5, unstable */
      return [
        r("complexity", 25, 1), r("complexity", 22, 0),
        r("complexity", 20, 0), r("complexity", 18, 0),
        r("complexity", 15, 1), r("complexity", 12, 0),
        r("complexity", 10, 0),
        r("type-safety", 14, 0),
      ];
    default:
      return [];
  }
}

/* ── Constants ────────────────────────────────────────────────────── */

const PLAN_ID = "self-play-dashboard-consistency";
const BASELINE_FPR = 0.05;

/* ── Tests ────────────────────────────────────────────────────────── */

describe("convergence dashboard consistency with self-play loop", () => {
  const projectPath = join(tmpdir(), `p7-convergence-dashboard-${Date.now()}`);

  afterAll(() => {
    closeDb(projectPath);
    rmSync(projectPath, { recursive: true, force: true });
  });

  test("validates all 5 consistency dimensions", () => {
    initDb(projectPath);

    /* ── Compute and persist 6 self-play iterations ──────────── */
    const snapshots: ConvergenceMetrics[] = [];
    for (let round = 0; round < 6; round++) {
      const rules = buildSelfPlayIteration(round);
      const metrics = computeAllMetrics(rules, BASELINE_FPR);
      snapshots.push(metrics);
      recordConvergenceSnapshot(projectPath, metrics, PLAN_ID, round);
      Bun.sleepSync(1); // guarantee distinct computedAt timestamps
    }

    /* ── Validation (1): all 6 persisted, both interfaces ────── */
    const fromTimeWindow = listConvergenceSnapshots(projectPath);
    expect(fromTimeWindow.length).toBe(6);

    const fromIteration = listConvergenceSnapshotsByIteration(
      projectPath,
      0,
      5,
    );
    expect(fromIteration.length).toBe(6);

    /* ── Validation (2): value fidelity to floating-point ────── */
    // Sort time-window results chronologically to match insertion order
    const sortedTW = [...fromTimeWindow].sort((a, b) =>
      a.computedAt.localeCompare(b.computedAt),
    );
    for (let i = 0; i < 6; i++) {
      expect(sortedTW[i].ruleEntropy.entropy).toBeCloseTo(
        snapshots[i].ruleEntropy.entropy,
        10,
      );
      expect(sortedTW[i].ruleEntropy.normalizedEntropy).toBeCloseTo(
        snapshots[i].ruleEntropy.normalizedEntropy,
        10,
      );
      expect(sortedTW[i].fprTrendDrift.currentFpr).toBeCloseTo(
        snapshots[i].fprTrendDrift.currentFpr,
        10,
      );
      expect(sortedTW[i].fprTrendDrift.drift).toBeCloseTo(
        snapshots[i].fprTrendDrift.drift,
        10,
      );
      expect(sortedTW[i].fprTrendDrift.isDrifting).toBe(
        snapshots[i].fprTrendDrift.isDrifting,
      );
      expect(sortedTW[i].coverageStability.coefficientOfVariation).toBeCloseTo(
        snapshots[i].coverageStability.coefficientOfVariation,
        10,
      );
      expect(sortedTW[i].coverageStability.isUnstable).toBe(
        snapshots[i].coverageStability.isUnstable,
      );
    }

    /* ── Validation (3): trend integrity ─────────────────────── */
    // Entropy drops monotonically across exploration→convergence (rounds 0→2)
    expect(snapshots[0].ruleEntropy.entropy).toBeGreaterThan(
      snapshots[1].ruleEntropy.entropy,
    );
    expect(snapshots[1].ruleEntropy.entropy).toBeGreaterThan(
      snapshots[2].ruleEntropy.entropy,
    );
    // FPR drift triggers on round 3
    expect(snapshots[3].fprTrendDrift.isDrifting).toBe(true);
    expect(snapshots[3].fprTrendDrift.drift).toBeGreaterThan(0.05);
    // Round 4 recovers from drift
    expect(snapshots[4].fprTrendDrift.isDrifting).toBe(false);
    // Coverage instability triggers on round 5
    expect(snapshots[5].coverageStability.isUnstable).toBe(true);
    expect(
      snapshots[5].coverageStability.coefficientOfVariation,
    ).toBeGreaterThan(0.5);

    /* ── Validation (4): time-window slicing ─────────────────── */
    const since = snapshots[1].computedAt;
    const until = snapshots[4].computedAt;
    const timeSliced = listConvergenceSnapshots(projectPath, {
      since,
      until,
    });

    // Expect rounds 1-4 (4 snapshots) within [since, until]
    expect(timeSliced.length).toBe(4);
    for (const m of timeSliced) {
      expect(m.computedAt >= since).toBe(true);
      expect(m.computedAt <= until).toBe(true);
    }

    /* ── Validation (5): iteration-range slicing ─────────────── */
    const mid = listConvergenceSnapshotsByIteration(projectPath, 1, 4);
    expect(mid.length).toBe(4);

    const early = listConvergenceSnapshotsByIteration(projectPath, 0, 2);
    expect(early.length).toBe(3);

    const single = listConvergenceSnapshotsByIteration(projectPath, 3, 3);
    expect(single.length).toBe(1);

    // Out-of-range returns empty
    const empty = listConvergenceSnapshotsByIteration(projectPath, 99, 100);
    expect(empty.length).toBe(0);
  });
});
