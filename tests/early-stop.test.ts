/**
 * Integration tests for evaluateEarlyStop — convergence plateau detection.
 *
 * Tests cover: empty curve (RangeError), insufficient rounds skip,
 * converging plateau trigger, diverging fprDrift, oscillating entropy,
 * and state reset. Uses synthetic SelfPlayRound fixture builders for
 * precise metric control and beforeEach resets for state isolation.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  evaluateEarlyStop,
  resetEarlyStopState,
  getPlateauCounter,
} from "../src/early-stop.ts";
import type {
  SelfPlayRound,
  ConvergenceCurve,
  DynamicRule,
} from "../src/types.ts";

/* ── Inline fixture builders ── */

/** Minimal DynamicRule — early-stop only reads metrics, not rule counters. */
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
 * Build a SelfPlayRound controlling the three metrics that drive
 * convergence trend classification:
 * - normalizedEntropy (ruleEntropy)
 * - drift (fprTrendDrift)
 * - cv (coverageStability.coefficientOfVariation)
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
      ruleEntropy: { entropy: 0.5, maxEntropy: 1, normalizedEntropy, dimensionCount: 2 },
      fprTrendDrift: {
        baselineFpr: 0.02, currentFpr: 0.02 + drift, drift,
        driftThreshold: 0.05, isDrifting: Math.abs(drift) > 0.05,
      },
      coverageStability: {
        mean: 5, standardDeviation: cv * 5, coefficientOfVariation: cv,
        dimensionCount: 3, cvThreshold: 0.5, isUnstable: cv > 0.5,
      },
      computedAt: new Date().toISOString(),
    },
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Build a curve with N flat-metric rounds. Constant values give slope=0,
 * R²=1 → all three metrics classify as "converging".
 */
function buildFlatCurve(numRounds: number, entropy = 0.15, drift = 0.02, cv = 0.30): ConvergenceCurve {
  return {
    rounds: Array.from({ length: numRounds }, (_, i) => buildRound(i, entropy, drift, cv)),
    totalRounds: numRounds,
    generatedAt: new Date().toISOString(),
  };
}

/* ── Tests ── */

describe("evaluateEarlyStop", () => {
  // Module-level plateauCounter must be reset before each test.
  // Do NOT use test.concurrent — state would leak between tests.
  beforeEach(() => { resetEarlyStopState(); });

  test("empty curve throws RangeError", () => {
    const curve: ConvergenceCurve = { rounds: [], totalRounds: 0, generatedAt: new Date().toISOString() };
    expect(() => evaluateEarlyStop(curve)).toThrow(RangeError);
    expect(() => evaluateEarlyStop(curve)).toThrow("must not be empty");
  });

  test("insufficient rounds skips evaluation with correct reason", () => {
    // 9 rounds < default minRounds (10)
    const decision = evaluateEarlyStop(buildFlatCurve(9));
    expect(decision.shouldStop).toBe(false);
    expect(decision.reason).toContain("Insufficient rounds");
    expect(decision.reason).toContain("9");
    expect(decision.reason).toContain("10");
    expect(decision.plateauDuration).toBe(0);
    expect(decision.frozenVersion).toBeNull();
    // insufficient-rounds path returns early without modifying counter
    expect(getPlateauCounter()).toBe(0);
  });

  test("converging plateau triggers stop after plateauRounds consecutive calls", () => {
    // 11 rounds > minRounds(10), flat metrics → converging verdict
    const curve = buildFlatCurve(11);
    const PR = 5; // default plateauRounds

    // Calls 1-4: counter increments, not yet at threshold
    for (let i = 1; i < PR; i++) {
      const d = evaluateEarlyStop(curve);
      expect(d.shouldStop).toBe(false);
      expect(d.plateauDuration).toBe(i);
      expect(d.trendAnalysis.verdict).toBe("converging");
    }

    // Call 5: counter reaches plateauRounds → triggers stop
    const d = evaluateEarlyStop(curve);
    expect(d.shouldStop).toBe(true);
    expect(d.plateauDuration).toBe(PR);
    expect(d.frozenVersion).toBe(10); // last round index 10 (0-based, 11 rounds)
    expect(d.reason).toContain("Convergence plateau");
    expect(d.trendAnalysis.verdict).toBe("converging");
  });

  test("diverging FPR drift yields diverging verdict and zero plateau duration", () => {
    // 11 rounds: fprDrift.drift trends upward 0, 0.03, 0.06, ..., 0.30
    // Sliding window slope ≈ 0.03 > 0.01 → diverging. Entropy & CV stay flat → converging.
    const rounds = Array.from({ length: 11 }, (_, i) => buildRound(i, 0.15, i * 0.03, 0.30));
    const curve: ConvergenceCurve = { rounds, totalRounds: 11, generatedAt: new Date().toISOString() };

    const d = evaluateEarlyStop(curve);
    expect(d.shouldStop).toBe(false);
    expect(d.plateauDuration).toBe(0);
    expect(d.frozenVersion).toBeNull();
    expect(getPlateauCounter()).toBe(0);
    expect(d.trendAnalysis.fprDriftTrend.direction).toBe("diverging");
    expect(d.trendAnalysis.verdict).toBe("diverging");
    expect(d.reason).toContain("Non-converging metrics");
    expect(d.reason).toContain("fprDrift");
  });

  test("oscillating normalizedEntropy yields oscillating verdict", () => {
    // 11 rounds: normalizedEntropy alternates 0.1, 0.9, 0.1, 0.9, ...
    // Over 8+ data points → ≥3 sign changes → oscillation detected.
    const rounds = Array.from({ length: 11 }, (_, i) => buildRound(i, i % 2 === 0 ? 0.1 : 0.9, 0.02, 0.30));
    const curve: ConvergenceCurve = { rounds, totalRounds: 11, generatedAt: new Date().toISOString() };

    const d = evaluateEarlyStop(curve);
    expect(d.shouldStop).toBe(false);
    expect(d.plateauDuration).toBe(0);
    expect(d.trendAnalysis.entropyTrend.direction).toBe("oscillating");
    expect(d.trendAnalysis.verdict).toBe("oscillating");
    expect(d.reason).toContain("Non-converging metrics");
    expect(d.reason).toContain("normalizedEntropy");
  });

  test("resetEarlyStopState clears plateau counter", () => {
    const curve = buildFlatCurve(11);

    // Build up plateau counter
    for (let i = 0; i < 3; i++) evaluateEarlyStop(curve);
    expect(getPlateauCounter()).toBe(3);

    // Reset and verify
    resetEarlyStopState();
    expect(getPlateauCounter()).toBe(0);

    // Next call starts a fresh streak
    expect(evaluateEarlyStop(curve).plateauDuration).toBe(1);
    expect(getPlateauCounter()).toBe(1);
  });
});
