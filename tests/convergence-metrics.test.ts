/**
 * Tests for dynamic_rules convergence metric computation.
 *
 * Three metrics are tested:
 * 1. RuleEntropyMetric — Shannon entropy of rule distribution across
 *    critic dimensions (fragmentation measure)
 * 2. FprTrendDriftMetric — Pooled false-positive rate vs baseline drift
 * 3. CoverageStabilityMetric — Coefficient of variation across
 *    per-dimension rule counts
 *
 * All computation helpers are defined inline (SUT contract mirror).
 * Types imported from src/types.ts.
 */

import { describe, expect, test } from "bun:test";
import { computeVulnDimensionWeight } from "../src/convergence-metrics.ts";
import type {
  DimensionWeights,
  DynamicRule,
  RuleEntropyMetric,
  FprTrendDriftMetric,
  CoverageStabilityMetric,
} from "../src/types.ts";

/* ── Inline SUT: metric computation helpers ──────────────────────── */

function computeRuleEntropy(
  rules: DynamicRule[],
  dimensionWeights?: DimensionWeights,
): RuleEntropyMetric {
  const dimCounts = new Map<string, number>();
  for (const r of rules) {
    dimCounts.set(r.dimension, (dimCounts.get(r.dimension) ?? 0) + 1);
  }
  const dimensionCount = dimCounts.size;

  if (dimensionCount === 0) {
    return { entropy: 0, maxEntropy: 0, normalizedEntropy: 0, dimensionCount: 0 };
  }

  let total: number;
  const weightedCounts = new Map<string, number>();
  if (dimensionWeights) {
    for (const [dim, count] of dimCounts) {
      const w = dimensionWeights[dim] ?? 1;
      weightedCounts.set(dim, count * w);
    }
    total = [...weightedCounts.values()].reduce((s, c) => s + c, 0);
  } else {
    total = rules.length;
  }

  const working = dimensionWeights ? weightedCounts : dimCounts;
  let entropy = 0;
  for (const count of working.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  const maxEntropy = Math.log2(dimensionCount);
  const normalizedEntropy = dimensionCount > 1 ? entropy / maxEntropy : 0;

  return { entropy, maxEntropy, normalizedEntropy, dimensionCount };
}

function computeFprTrendDrift(
  rules: DynamicRule[],
  baselineFpr: number,
  driftThreshold = 0.05,
): FprTrendDriftMetric {
  const totalHits = rules.reduce((s, r) => s + r.hitCount, 0);
  const totalFp = rules.reduce((s, r) => s + r.falsePositiveCount, 0);
  const currentFpr = totalHits > 0 ? totalFp / totalHits : 0;
  const drift = currentFpr - baselineFpr;
  const isDrifting = drift > driftThreshold;

  return { baselineFpr, currentFpr, drift, driftThreshold, isDrifting };
}

function computeCoverageStability(
  rules: DynamicRule[],
  cvThreshold = 0.5,
  dimensionWeights?: DimensionWeights,
): CoverageStabilityMetric {
  const dimCounts = new Map<string, number>();
  for (const r of rules) {
    dimCounts.set(r.dimension, (dimCounts.get(r.dimension) ?? 0) + 1);
  }
  const dimensionCount = dimCounts.size;

  let counts: number[];
  if (dimensionWeights) {
    counts = [...dimCounts.entries()].map(
      ([dim, count]) => count * (dimensionWeights[dim] ?? 1),
    );
  } else {
    counts = [...dimCounts.values()];
  }

  if (dimensionCount === 0) {
    return {
      mean: 0,
      standardDeviation: 0,
      coefficientOfVariation: 0,
      dimensionCount: 0,
      cvThreshold,
      isUnstable: false,
    };
  }

  const mean = counts.reduce((s, c) => s + c, 0) / dimensionCount;
  const variance = counts.reduce((s, c) => s + (c - mean) ** 2, 0) / dimensionCount;
  const standardDeviation = Math.sqrt(variance);
  const coefficientOfVariation = mean > 0 ? standardDeviation / mean : 0;
  const isUnstable = coefficientOfVariation > cvThreshold;

  return { mean, standardDeviation, coefficientOfVariation, dimensionCount, cvThreshold, isUnstable };
}

/* ── Fixture builder ─────────────────────────────────────────────── */

function r(
  dimension: string,
  hitCount: number,
  fpCount: number,
  fnCount = 0,
  version = 1,
): DynamicRule {
  return {
    dimension,
    pattern: `pattern/${dimension}`,
    hitCount,
    falsePositiveCount: fpCount,
    falseNegativeCount: fnCount,
    version,
  };
}

/* ── computeRuleEntropy ──────────────────────────────────────────── */

describe("computeRuleEntropy", () => {
  test("empty array → all zeroes", () => {
    const m = computeRuleEntropy([]);
    expect(m.entropy).toBe(0);
    expect(m.maxEntropy).toBe(0);
    expect(m.normalizedEntropy).toBe(0);
    expect(m.dimensionCount).toBe(0);
  });

  test("single dimension → zero entropy", () => {
    const m = computeRuleEntropy([
      r("complexity", 5, 1),
      r("complexity", 3, 0),
    ]);
    expect(m.dimensionCount).toBe(1);
    expect(m.entropy).toBe(0);
    expect(m.maxEntropy).toBe(0);
    expect(m.normalizedEntropy).toBe(0);
  });

  test("uniform 1-per-dimension → normalized ≈ 1", () => {
    const m = computeRuleEntropy([
      r("complexity", 5, 1),
      r("type-safety", 3, 0),
      r("security", 4, 1),
      r("performance", 2, 0),
    ]);
    // counts: [1,1,1,1]; each p=0.25 → H = -4×(0.25×log2(0.25)) = 2
    // maxEntropy = log2(4) = 2 → normalized = 1
    expect(m.dimensionCount).toBe(4);
    expect(m.entropy).toBeCloseTo(2, 10);
    expect(m.maxEntropy).toBeCloseTo(2, 10);
    expect(m.normalizedEntropy).toBeCloseTo(1, 5);
  });

  test("skewed multi-dimension → low normalized entropy", () => {
    const m = computeRuleEntropy([
      r("complexity", 5, 1),
      r("complexity", 3, 0),
      r("complexity", 4, 0),
      r("complexity", 2, 1),
      r("complexity", 1, 0),
      r("type-safety", 3, 0),
    ]);
    // 6 rules: 5 in complexity, 1 in type-safety
    // p₁=5/6, p₂=1/6 → H ≈ 0.65, max=log2(2)=1, normalized=0.65
    expect(m.dimensionCount).toBe(2);
    expect(m.entropy).toBeCloseTo(0.65, 2);
    expect(m.normalizedEntropy).toBeCloseTo(0.65, 2);
  });
});

/* ── computeFprTrendDrift ────────────────────────────────────────── */

describe("computeFprTrendDrift", () => {
  test("current FPR ≈ baseline → isDrifting = false", () => {
    const m = computeFprTrendDrift(
      [r("complexity", 100, 5), r("type-safety", 100, 7)],
      0.06,
    );
    // pooled FPR = (5+7)/(100+100) = 0.06 = baseline
    expect(m.currentFpr).toBeCloseTo(0.06, 5);
    expect(m.drift).toBeCloseTo(0, 5);
    expect(m.isDrifting).toBe(false);
  });

  test("significantly higher FPR → isDrifting = true", () => {
    const m = computeFprTrendDrift(
      [r("complexity", 100, 20), r("type-safety", 100, 15)],
      0.05,
    );
    // pooled FPR = 35/200 = 0.175, drift = 0.125 > 0.05
    expect(m.currentFpr).toBeCloseTo(0.175, 5);
    expect(m.drift).toBeCloseTo(0.125, 5);
    expect(m.isDrifting).toBe(true);
  });

  test("zero hitCount → currentFpr = 0, no drift", () => {
    const m = computeFprTrendDrift(
      [r("complexity", 0, 0)],
      0.05,
    );
    expect(m.currentFpr).toBe(0);
    expect(m.drift).toBe(-0.05);
    expect(m.isDrifting).toBe(false);
  });

  test("custom driftThreshold relaxes alert", () => {
    // drift = 0.05, threshold = 0.1 → not drifting
    const m = computeFprTrendDrift(
      [r("complexity", 100, 10)],
      0.05,
      0.1,
    );
    expect(m.drift).toBeCloseTo(0.05, 5);
    expect(m.isDrifting).toBe(false);
  });
});

/* ── computeCoverageStability ────────────────────────────────────── */

describe("computeCoverageStability", () => {
  test("empty array → zero fields, isUnstable = false", () => {
    const m = computeCoverageStability([]);
    expect(m.mean).toBe(0);
    expect(m.standardDeviation).toBe(0);
    expect(m.coefficientOfVariation).toBe(0);
    expect(m.dimensionCount).toBe(0);
    expect(m.isUnstable).toBe(false);
  });

  test("even 1-per-dimension → CV = 0, stable", () => {
    const m = computeCoverageStability([
      r("complexity", 5, 1),
      r("type-safety", 3, 0),
      r("security", 4, 1),
      r("performance", 2, 0),
    ]);
    // counts: [1,1,1,1] → μ=1, σ=0, CV=0
    expect(m.mean).toBe(1);
    expect(m.standardDeviation).toBe(0);
    expect(m.coefficientOfVariation).toBe(0);
    expect(m.isUnstable).toBe(false);
  });

  test("uneven → CV > threshold, unstable", () => {
    const m = computeCoverageStability([
      r("complexity", 5, 1),
      r("complexity", 3, 0),
      r("complexity", 4, 0),
      r("complexity", 2, 1),
      r("type-safety", 3, 0),
      r("security", 4, 0),
    ]);
    // counts: [4 (complexity), 1 (type-safety), 1 (security)]
    // μ=2, σ²=((4-2)²+(1-2)²+(1-2)²)/3=(4+1+1)/3=2, σ=√2≈1.414, CV≈0.707
    expect(m.dimensionCount).toBe(3);
    expect(m.mean).toBe(2);
    expect(m.standardDeviation).toBeCloseTo(Math.sqrt(2), 5);
    expect(m.coefficientOfVariation).toBeGreaterThan(0.5);
    expect(m.isUnstable).toBe(true);
  });

  test("single dimension → CV = 0, stable", () => {
    const m = computeCoverageStability([
      r("complexity", 5, 1),
      r("complexity", 3, 0),
    ]);
    expect(m.dimensionCount).toBe(1);
    expect(m.mean).toBe(2);
    expect(m.standardDeviation).toBe(0);
    expect(m.coefficientOfVariation).toBe(0);
    expect(m.isUnstable).toBe(false);
  });
});

/* ── Weighted metric computation (dimensionWeights) ────────────────── */

describe("weighted computeRuleEntropy", () => {
  test("vuln dimension with 2x weight shifts entropy toward concentration", () => {
    // 3 dimensions, 1 rule each: type-safety, complexity, 漏洞发现
    // Without weight: uniform → H=log2(3)≈1.585, normalized=1
    // With vuln 2x: counts become [1, 1, 2], total=4
    //   p_type-safety=0.25, p_complexity=0.25, p_vuln=0.5
    //   H = -(0.25*log2(0.25) + 0.25*log2(0.25) + 0.5*log2(0.5))
    //     = -(0.25*(-2) + 0.25*(-2) + 0.5*(-1)) = 1.5
    //   normalized = 1.5 / log2(3) ≈ 1.5 / 1.585 ≈ 0.946
    const weights: DimensionWeights = { 漏洞发现: 2 };
    const rules = [
      r("type-safety", 5, 1),
      r("complexity", 3, 0),
      r("漏洞发现", 4, 1),
    ];

    const m = computeRuleEntropy(rules, weights);
    expect(m.dimensionCount).toBe(3);
    expect(m.entropy).toBeCloseTo(1.5, 5);
    expect(m.normalizedEntropy).toBeCloseTo(0.946, 2);
  });

  test("dimension not in weights map defaults to 1.0 multiplier", () => {
    const weights: DimensionWeights = { 漏洞发现: 3 };
    const rules = [
      r("complexity", 5, 1),
      r("security", 3, 0),
    ];

    const m = computeRuleEntropy(rules, weights);
    expect(m.dimensionCount).toBe(2);
    expect(m.entropy).toBeCloseTo(1, 5);
    expect(m.normalizedEntropy).toBeCloseTo(1, 5);
  });

  test("empty weights map behaves as unweighted", () => {
    const rules = [
      r("complexity", 5, 1),
      r("type-safety", 3, 0),
    ];
    const unweighted = computeRuleEntropy(rules);
    const weighted = computeRuleEntropy(rules, {});
    expect(weighted.entropy).toBeCloseTo(unweighted.entropy, 10);
    expect(weighted.normalizedEntropy).toBeCloseTo(unweighted.normalizedEntropy, 10);
  });
});

describe("weighted computeCoverageStability", () => {
  test("weighted CV reflects dimension importance", () => {
    // 3 dimensions: complexity(4 rules), type-safety(1), 漏洞发现(1)
    // Unweighted counts: [4, 1, 1] → μ=2, σ≈1.414, CV≈0.707 (unstable)
    // With vuln 2x: counts become [4, 1, 2] → μ≈2.333, σ²≈1.556, σ≈1.247, CV≈0.535
    const weights: DimensionWeights = { 漏洞发现: 2 };
    const rules = [
      r("complexity", 5, 1),
      r("complexity", 3, 0),
      r("complexity", 4, 0),
      r("complexity", 2, 1),
      r("type-safety", 3, 0),
      r("漏洞发现", 4, 1),
    ];

    const m = computeCoverageStability(rules, 0.5, weights);
    expect(m.dimensionCount).toBe(3);
    // weighted counts: [4, 1, 2] → μ = 7/3 ≈ 2.333
    expect(m.mean).toBeCloseTo(7 / 3, 5);
    // σ² = ((4-2.333)² + (1-2.333)² + (2-2.333)²) / 3
    //     = (2.778 + 1.778 + 0.111) / 3 ≈ 1.556
    // σ ≈ 1.247
    expect(m.standardDeviation).toBeCloseTo(1.247, 2);
    // CV = 1.247 / 2.333 ≈ 0.535
    expect(m.coefficientOfVariation).toBeCloseTo(0.535, 2);
    expect(m.isUnstable).toBe(true);
  });

  test("weighted all-equal 1x → CV=0 regardless of weights specified", () => {
    // Uniform counts with equal per-dimension weight of 1
    // Actually each count is 1 for each dimension, and weight of 1 → still [1,1,1] → CV=0
    const weights: DimensionWeights = { 漏洞发现: 1, complexity: 1 };
    const rules = [
      r("complexity", 5, 1),
      r("type-safety", 3, 0),
      r("漏洞发现", 4, 1),
    ];

    const m = computeCoverageStability(rules, 0.5, weights);
    // weighted counts: [1, 1, 1] (type-safety not in weights, defaults to 1)
    expect(m.dimensionCount).toBe(3);
    expect(m.coefficientOfVariation).toBeCloseTo(0, 5);
    expect(m.isUnstable).toBe(false);
  });
});

describe("computeVulnDimensionWeight", () => {
  test("returns default calibrated weight (1.5)", () => {
    const w = computeVulnDimensionWeight();
    expect(w).toBe(1.5);
  });
});
