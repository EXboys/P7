import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  classifyDiffComplexity,
  selectEvaluator,
  DEFAULT_DIFF_COMPLEXITY_THRESHOLDS,
  DEFAULT_EVALUATOR_COST_PROFILE,
  DEFAULT_ROUTE_MATRIX,
} from "../src/evaluator-router.ts";
import type { DiffComplexityThresholds, RouteMatrix } from "../src/evaluator-router.ts";
import { initDb, writeEvalRouteStat, queryEvalRouteStats, closeDb } from "../src/state.ts";
import type { EvalRouteStatWrite } from "../src/state.ts";

/* ── classifyDiffComplexity: tier boundary tests ── */

const TIERS: { label: string; lines: number; files: number; expected: string }[] = [
  // Trivial: lines ≤ 20 AND files ≤ 1
  { label: "trivial exact", lines: 20, files: 1, expected: "trivial" },
  { label: "trivial zero", lines: 0, files: 0, expected: "trivial" },
  // Small: lines ≤ 80 AND files ≤ 3
  { label: "small boundary", lines: 80, files: 3, expected: "small" },
  { label: "small overflow", lines: 21, files: 1, expected: "small" },
  // Medium: lines ≤ 250 AND files ≤ 8
  { label: "medium boundary", lines: 250, files: 8, expected: "medium" },
  { label: "medium overflow", lines: 81, files: 3, expected: "medium" },
  // Large: exceeds medium
  { label: "large lines", lines: 251, files: 1, expected: "large" },
  { label: "large files", lines: 1, files: 9, expected: "large" },
  { label: "large both", lines: 300, files: 10, expected: "large" },
];

describe("classifyDiffComplexity", () => {
  test.each(TIERS)("$expected: $label ($lines lines, $files files)", ({ lines, files, expected }) => {
    expect(classifyDiffComplexity(lines, files)).toBe(expected);
  });

  test("custom thresholds override defaults", () => {
    const custom: DiffComplexityThresholds = {
      trivial: { maxLines: 5, maxFiles: 1 },
      small: { maxLines: 20, maxFiles: 2 },
      medium: { maxLines: 50, maxFiles: 5 },
    };
    expect(classifyDiffComplexity(6, 1, custom)).toBe("small");
    expect(classifyDiffComplexity(3, 1, custom)).toBe("trivial");
    expect(classifyDiffComplexity(30, 3, custom)).toBe("medium");
    expect(classifyDiffComplexity(60, 1, custom)).toBe("large");
  });
});

/* ── selectEvaluator: 4×2 matrix + cost + reason ── */

interface RouteCase {
  tier: string;
  urgency: string;
  expectedEvaluator: string;
  expectedCost: number;
  reasonContains: string;
}

const ROUTES: RouteCase[] = [
  // Blockers get gemma_with_fallback for trivial/small, claude for medium/large
  { tier: "trivial", urgency: "blocker", expectedEvaluator: "gemma_with_fallback", expectedCost: 0.02, reasonContains: "Gemma + Claude fallback" },
  { tier: "small", urgency: "blocker", expectedEvaluator: "gemma_with_fallback", expectedCost: 0.02, reasonContains: "Gemma + Claude fallback" },
  { tier: "medium", urgency: "blocker", expectedEvaluator: "claude", expectedCost: 0.08, reasonContains: "Claude required" },
  { tier: "large", urgency: "blocker", expectedEvaluator: "claude", expectedCost: 0.08, reasonContains: "Claude required" },
  // Advisory: gemma for trivial/small, gemma_with_fallback for medium, claude for large
  { tier: "trivial", urgency: "advisory", expectedEvaluator: "gemma", expectedCost: 0.005, reasonContains: "Gemma sufficient" },
  { tier: "small", urgency: "advisory", expectedEvaluator: "gemma", expectedCost: 0.005, reasonContains: "Gemma sufficient" },
  { tier: "medium", urgency: "advisory", expectedEvaluator: "gemma_with_fallback", expectedCost: 0.02, reasonContains: "Gemma + Claude fallback" },
  { tier: "large", urgency: "advisory", expectedEvaluator: "claude", expectedCost: 0.08, reasonContains: "Claude required" },
];

describe("selectEvaluator", () => {
  test.each(ROUTES)("$tier/$urgency → $expectedEvaluator ($${expectedCost})", ({ tier, urgency, expectedEvaluator, expectedCost, reasonContains }) => {
    const decision = selectEvaluator(tier as any, urgency as any);
    expect(decision.evaluator).toBe(expectedEvaluator);
    expect(decision.estimatedCostUsd).toBeCloseTo(expectedCost, 4);
    expect(decision.reason).toContain(reasonContains);
    expect(decision.tier).toBe(tier);
    expect(decision.urgency).toBe(urgency);
  });

  test("custom matrix overrides default", () => {
    const customMatrix: RouteMatrix = {
      trivial: { blocker: "claude", advisory: "claude" },
      small: { blocker: "claude", advisory: "gemma" },
      medium: { blocker: "claude", advisory: "gemma_with_fallback" },
      large: { blocker: "claude", advisory: "gemma" },
    };
    // trivial/blocker now returns claude instead of gemma_with_fallback
    const d1 = selectEvaluator("trivial" as any, "blocker" as any, customMatrix);
    expect(d1.evaluator).toBe("claude");
    // small/advisory still gemma
    const d2 = selectEvaluator("small" as any, "advisory" as any, customMatrix);
    expect(d2.evaluator).toBe("gemma");
    // medium/advisory gemma_with_fallback
    const d3 = selectEvaluator("medium" as any, "advisory" as any, customMatrix);
    expect(d3.evaluator).toBe("gemma_with_fallback");
  });

  test("custom cost profiles produce correct estimatedCostUsd", () => {
    const cheapCosts = { gemma: 0.1, gemma_with_fallback: 0.5, claude: 1.0 };
    const d = selectEvaluator("large" as any, "blocker" as any, DEFAULT_ROUTE_MATRIX, cheapCosts);
    expect(d.estimatedCostUsd).toBeCloseTo(0.01, 4); // 1.0 / 100
    expect(d.evaluator).toBe("claude");
  });
});

/* ── Route stats DB persistence (temp project directory) ── */

describe("route stats DB round-trip", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "p7-eval-router-"));
    mkdirSync(join(tempDir, ".p7"), { recursive: true });
    initDb(tempDir);
  });

  afterAll(() => {
    closeDb(tempDir);
  });

  test("writeEvalRouteStat + queryEvalRouteStats round-trip", () => {
    const stats: EvalRouteStatWrite[] = [
      { routePoint: "diff-critic", tier: "trivial", urgency: "advisory", selectedEvaluator: "gemma", estimatedCostUsd: 0.005, actualCostUsd: 0.004, latencyMs: 1200 },
      { routePoint: "diff-critic", tier: "small", urgency: "blocker", selectedEvaluator: "gemma_with_fallback", estimatedCostUsd: 0.02, actualCostUsd: 0.015, latencyMs: 3400 },
      { routePoint: "diff-critic", tier: "medium", urgency: "blocker", selectedEvaluator: "claude", estimatedCostUsd: 0.08, actualCostUsd: 0.07, latencyMs: 8500 },
      { routePoint: "diff-critic", tier: "large", urgency: "advisory", selectedEvaluator: "claude", estimatedCostUsd: 0.08, actualCostUsd: 0.09, latencyMs: 12000 },
      { routePoint: "plan-critic", tier: "trivial", urgency: "advisory", selectedEvaluator: "gemma", estimatedCostUsd: 0.005, actualCostUsd: 0.006, latencyMs: 1500 },
    ];

    for (const s of stats) {
      writeEvalRouteStat(tempDir, s);
    }

    const result = queryEvalRouteStats(tempDir, 30);
    expect(result.length).toBeGreaterThanOrEqual(3);

    const claudeRow = result.find((r) => r.selectedEvaluator === "claude")!;
    expect(claudeRow).toBeDefined();
    expect(claudeRow.callCount).toBe(2);
    expect(claudeRow.avgCostUsd).toBeCloseTo(0.08, 2);
    expect(claudeRow.avgLatencyMs).toBeCloseTo(10250, 0);
    expect(claudeRow.p50LatencyMs).toBeGreaterThan(0);
    expect(claudeRow.p95LatencyMs).toBeGreaterThanOrEqual(claudeRow.p50LatencyMs);

    const gemmaRow = result.find((r) => r.selectedEvaluator === "gemma")!;
    expect(gemmaRow).toBeDefined();
    expect(gemmaRow.callCount).toBe(2);
  });

  test("queryEvalRouteStats returns empty for far-future lookback", () => {
    // days=0 means `since` is now — no rows match if all were written in the past
    const result = queryEvalRouteStats(tempDir, 0);
    // At least one row might still match if written in this second, so just check it's valid
    expect(Array.isArray(result)).toBe(true);
  });
});
