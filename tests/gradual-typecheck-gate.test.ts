/**
 * Integration tests for the unified progressive type-check gate combining:
 *   1. Strictness target resolution + gap analysis (src/gradual-typecheck-config.ts)
 *   2. Gemma bridge pipeline — formatDiffSlice + parseGemmaOutput (src/gemma-bridge.ts)
 *   3. shouldFallbackToClaude decision logic (src/gemma-bridge.ts)
 *   4. Env-gated end-to-end reviewGradualTypeCheck with real diffs (src/gradual-typechecker.ts)
 *
 * Structural/Gemma-bridge tests always run. End-to-end LLM tests require
 * P7_RUN_GRADUAL_TYPECHECK=true.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import type { GradualTypeCheckConfig } from "../src/gradual-typecheck-config.ts";
import {
  resolveStrictnessTarget,
  resolveAchievedLevel,
  computeStrictnessGap,
} from "../src/gradual-typecheck-config.ts";
import type { GemmaEvalConfig, GemmaEvalResult, GemmaSliceMeta } from "../src/gemma-bridge.ts";
import {
  formatDiffSlice,
  parseGemmaOutput,
  shouldFallbackToClaude,
  DEFAULT_GEMMA_CONFIG,
} from "../src/gemma-bridge.ts";
import { reviewGradualTypeCheck } from "../src/gradual-typechecker.ts";
import type { DiffCriticFinding } from "../src/types.ts";

/* ── Fixtures ─────────────────────────────────────────────────────── */

const MULTI_TARGET_CONFIG: GradualTypeCheckConfig = {
  rules: [
    { pattern: "src/new/**/*.ts", flags: { noImplicitAny: true, strictNullChecks: true, strictFunctionTypes: true } },
    { pattern: "src/legacy/**/*.ts", flags: { noImplicitAny: true } },
  ],
  targets: [
    { pattern: "src/new/**/*.ts", targetLevel: "strict", milestone: "Q3 2026" },
    { pattern: "src/legacy/**/*.ts", targetLevel: "moderate", milestone: "Q4 2026", note: "Legacy migration" },
    { pattern: "src/migrated/**/*.ts", targetLevel: "full", milestone: "v2.0", targetFlags: { noUnusedLocals: false } },
  ],
};

/** Type-regression (positive) diff: introduces `any` parameter. */
const DIFF_TYPE_REGRESSION = [
  '--- a/src/user.ts',
  '+++ b/src/user.ts',
  '@@ -1,5 +1,10 @@',
  ' export interface User { id: number; name: string; }',
  '+',
  '+export function processUser(input: any): void {',
  '+  console.log("processing", input);',
  '+}',
].join("\n");

/** Clean (negative) diff: pure type-safe additions. */
const DIFF_CLEAN = [
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -1,3 +1,8 @@',
  ' export function add(a: number, b: number): number {',
  '   return a + b;',
  ' }',
  '+',
  '+export function multiply(a: number, b: number): number {',
  '+  return a * b;',
  '+}',
].join("\n");

/* Simulated Gemma responses (used instead of real inference). */
const GEMMA_TYPE_REGRESSION_OUTPUT =
  "- [blocker] 类型退化 Type Regression: input parameter is typed as `any`, escaping strict type checking\n" +
  "- [info] 模板重复 Template Duplication: minor style concern\n";

const GEMMA_CLEAN_OUTPUT = "";

/* ── 1. Target resolution ─────────────────────────────────────────── */

describe("gradual-typecheck-gate target resolution", () => {
  test("resolves strict target for src/new/** pattern", () => {
    const t = resolveStrictnessTarget("src/new/feature.ts", MULTI_TARGET_CONFIG);
    expect(t).not.toBeNull();
    expect(t!.targetLevel).toBe("strict");
    expect(t!.milestone).toBe("Q3 2026");
  });

  test("resolves moderate target for src/legacy/** pattern", () => {
    const t = resolveStrictnessTarget("src/legacy/api.ts", MULTI_TARGET_CONFIG);
    expect(t).not.toBeNull();
    expect(t!.targetLevel).toBe("moderate");
    expect(t!.note).toBe("Legacy migration");
  });

  test("resolves full target with per-flag override for src/migrated/**", () => {
    const t = resolveStrictnessTarget("src/migrated/core.ts", MULTI_TARGET_CONFIG);
    expect(t).not.toBeNull();
    expect(t!.targetLevel).toBe("full");
    expect(t!.targetFlags?.noUnusedLocals).toBe(false);
  });

  test("returns null for unmatched file path", () => {
    expect(resolveStrictnessTarget("vendor/lib.ts", MULTI_TARGET_CONFIG)).toBeNull();
  });

  test("returns null when config has no targets", () => {
    const noTargets: GradualTypeCheckConfig = { rules: [] };
    expect(resolveStrictnessTarget("src/any.ts", noTargets)).toBeNull();
  });
});

/* ── 2. Gap analysis ──────────────────────────────────────────────── */

describe("gradual-typecheck-gate gap analysis", () => {
  test("resolveAchievedLevel returns 'loose' when moderate-level flags are incomplete", () => {
    // noImplicitThis and strictBindCallApply missing from moderate requirements
    expect(resolveAchievedLevel({ noImplicitAny: true, strictNullChecks: true, strictFunctionTypes: true })).toBe("loose");
  });

  test("resolveAchievedLevel returns 'strict' for all strict flags", () => {
    const strictFlags = {
      alwaysStrict: true, noImplicitAny: true, noImplicitThis: true,
      strictBindCallApply: true, strictFunctionTypes: true,
      strictNullChecks: true, strictPropertyInitialization: true,
      useUnknownInCatchVariables: true,
    };
    expect(resolveAchievedLevel(strictFlags)).toBe("strict");
  });

  test("resolveAchievedLevel returns 'loose' for empty flags", () => {
    expect(resolveAchievedLevel({})).toBe("loose");
  });

  test("computeStrictnessGap isMet when flags satisfy target", () => {
    const gap = computeStrictnessGap(
      { noImplicitAny: true, noImplicitThis: true, strictNullChecks: true, strictBindCallApply: true },
      { pattern: "src/**/*.ts", targetLevel: "moderate" },
    );
    expect(gap.isMet).toBe(true);
    expect(gap.achievedLevel).toBe("moderate");
    expect(Object.keys(gap.missingFlags)).toHaveLength(0);
  });

  test("computeStrictnessGap identifies missing flags when target not met", () => {
    const gap = computeStrictnessGap(
      { noImplicitAny: true },
      { pattern: "src/**/*.ts", targetLevel: "moderate" },
    );
    expect(gap.isMet).toBe(false);
    expect(gap.achievedLevel).toBe("loose");
    expect(Object.keys(gap.missingFlags).length).toBeGreaterThan(0);
    expect(gap.missingFlags.strictNullChecks).toBe(true);
  });

  test("computeStrictnessGap respects per-target flag overrides", () => {
    const gap = computeStrictnessGap(
      { noImplicitAny: true, strictNullChecks: true, noUnusedLocals: true },
      { pattern: "src/**/*.ts", targetLevel: "full", targetFlags: { noUnusedLocals: false } },
    );
    // noUnusedLocals expected to be false, but resolved has true → gap
    expect(gap.isMet).toBe(false);
    expect(gap.missingFlags.noUnusedLocals).toBe(false);
  });
});

/* ── 3. Gemma bridge pipeline (formatDiffSlice + parseGemmaOutput) ── */

describe("gradual-typecheck-gate Gemma bridge", () => {
  test("formatDiffSlice includes dimension taxonomy and diff content", () => {
    const prompt = formatDiffSlice(DIFF_TYPE_REGRESSION);
    expect(prompt).toContain("## Dimensions");
    expect(prompt).toContain("类型退化 Type Regression");
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("processUser");
  });

  test("formatDiffSlice handles empty diff gracefully", () => {
    const prompt = formatDiffSlice("");
    expect(prompt).toContain("## Dimensions");
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("```");
  });

  test("parseGemmaOutput extracts blocker finding from type-regression output", () => {
    const meta: GemmaSliceMeta = { sliceIndex: 0, totalSlices: 1, charsInSlice: GEMMA_TYPE_REGRESSION_OUTPUT.length };
    const findings = parseGemmaOutput(GEMMA_TYPE_REGRESSION_OUTPUT, meta);
    expect(findings.length).toBe(2);
    const blocker = findings.find((f) => f.severity === "blocker");
    expect(blocker).toBeDefined();
    expect(blocker!.dimension).toContain("Type Regression");
    expect(blocker!.confidence).toBe(0.8);
    expect(blocker!.sliceMeta.sliceIndex).toBe(0);
  });

  test("parseGemmaOutput returns empty array for clean output", () => {
    const meta: GemmaSliceMeta = { sliceIndex: 0, totalSlices: 1, charsInSlice: 0 };
    expect(parseGemmaOutput(GEMMA_CLEAN_OUTPUT, meta)).toEqual([]);
  });

  test("full pipeline: format → simulated Gemma → parse yields blocker for type regression", () => {
    const formatted = formatDiffSlice(DIFF_TYPE_REGRESSION);
    const meta: GemmaSliceMeta = { sliceIndex: 0, totalSlices: 1, charsInSlice: formatted.length };
    const simulatedResponse =
      "- [blocker] 类型退化 Type Regression: input parameter typed as `any`\n" +
      "- [warning] 过度抽象 Over-Abstraction: could extract type alias\n";
    const findings = parseGemmaOutput(simulatedResponse, meta);
    expect(findings.some((f) => f.severity === "blocker")).toBe(true);
    expect(findings.some((f) => f.dimension.includes("Type Regression"))).toBe(true);
    expect(findings.every((f) => f.sliceMeta.totalSlices === 1)).toBe(true);
  });

  test("full pipeline: format → simulated Gemma → parse yields no blocker for clean diff", () => {
    const formatted = formatDiffSlice(DIFF_CLEAN);
    const meta: GemmaSliceMeta = { sliceIndex: 0, totalSlices: 1, charsInSlice: formatted.length };
    const simulatedResponse = "- [info] 模板重复 Template Duplication: minor\n";
    const findings = parseGemmaOutput(simulatedResponse, meta);
    expect(findings.some((f) => f.severity === "blocker")).toBe(false);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("info");
  });

  test("parseGemmaOutput fallback regex handles malformed lines", () => {
    const meta: GemmaSliceMeta = { sliceIndex: 0, totalSlices: 1, charsInSlice: 50 };
    const findings = parseGemmaOutput("- [warning] line without dimension colon\n", meta);
    expect(findings.length).toBe(1);
    expect(findings[0].dimension).toBe("other");
    expect(findings[0].confidence).toBeCloseTo(0.35, 5);
  });
});

/* ── 4. shouldFallbackToClaude ────────────────────────────────────── */

describe("gradual-typecheck-gate shouldFallbackToClaude", () => {
  const BASE_RESULT: GemmaEvalResult = {
    findings: [],
    rawOutput: "",
    latencyMs: 5_000,
    tokenEstimate: 1000,
    confidence: 0.8,
    fallback: false,
  };

  test("returns false when confidence is above threshold and latency is below max", () => {
    expect(shouldFallbackToClaude(BASE_RESULT)).toBe(false);
  });

  test("returns true when confidence is below threshold and fallbackOnUncertain is enabled", () => {
    const lowConfResult: GemmaEvalResult = { ...BASE_RESULT, confidence: 0.3 };
    expect(shouldFallbackToClaude(lowConfResult)).toBe(true);
  });

  test("returns false when confidence is below threshold but fallbackOnUncertain is disabled", () => {
    const config: GemmaEvalConfig = { ...DEFAULT_GEMMA_CONFIG, fallbackOnUncertain: false };
    const lowConfResult: GemmaEvalResult = { ...BASE_RESULT, confidence: 0.3 };
    expect(shouldFallbackToClaude(lowConfResult, config)).toBe(false);
  });

  test("returns true when latency exceeds maxLatencyMs", () => {
    const slowResult: GemmaEvalResult = { ...BASE_RESULT, latencyMs: 20_000 };
    expect(shouldFallbackToClaude(slowResult)).toBe(true);
  });

  test("returns false when latency is exactly at maxLatencyMs boundary", () => {
    const exactResult: GemmaEvalResult = { ...BASE_RESULT, latencyMs: 15_000 };
    expect(shouldFallbackToClaude(exactResult)).toBe(false);
  });

  test("returns false when both confidence and latency are within bounds with custom config", () => {
    const tightConfig: GemmaEvalConfig = { maxLatencyMs: 10_000, tokenBudgetPerSlice: 10_000, confidenceThreshold: 0.7, fallbackOnUncertain: true };
    const goodResult: GemmaEvalResult = { ...BASE_RESULT, confidence: 0.75, latencyMs: 8_000 };
    expect(shouldFallbackToClaude(goodResult, tightConfig)).toBe(false);
  });

  test("returns true when both confidence and latency violate bounds", () => {
    const badResult: GemmaEvalResult = { ...BASE_RESULT, confidence: 0.2, latencyMs: 25_000 };
    expect(shouldFallbackToClaude(badResult)).toBe(true);
  });
});

/* ── 5. Env-gated end-to-end with real LLM ────────────────────────── */

const RUN_EVAL = process.env.P7_RUN_GRADUAL_TYPECHECK === "true";

/**
 * Set P7_RUN_GRADUAL_TYPECHECK=true to run these integration tests.
 * Each calls reviewGradualTypeCheck against a real LLM — expect 2 API calls
 * (one positive, one negative fixture).
 */
if (RUN_EVAL) {
  describe("gradual-typecheck-gate e2e", () => {
    const tempDirs = new Map<string, string>();

    beforeAll(() => {
      for (const id of ["any-type-escape", "clean-type-safe"]) {
        const dir = mkdtempSync(join(tmpdir(), `p7-gate-${id}-`));
        // Shared setup: write a minimal tsconfig and source file
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src/user.ts"), "export interface User { id: number; name: string; }\n", "utf-8");
        writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number { return a + b; }\n", "utf-8");
        tempDirs.set(id, dir);
      }
    });

    test("blocks any-type-escape diff with blocker finding", async () => {
      const dir = tempDirs.get("any-type-escape")!;
      const result = await reviewGradualTypeCheck(dir, DIFF_TYPE_REGRESSION);
      expect(result.structuredFindings.some((f) => f.severity === "blocker")).toBe(true);
      expect(result.ok).toBe(false);
    }, 120_000);

    test("passes clean type-safe diff without blocker", async () => {
      const dir = tempDirs.get("clean-type-safe")!;
      const result = await reviewGradualTypeCheck(dir, DIFF_CLEAN);
      expect(result.structuredFindings.some((f) => f.severity === "blocker")).toBe(false);
      expect(result.ok).toBe(true);
    }, 120_000);
  });
} else {
  describe("gradual-typecheck-gate structure", () => {
    test("fixtures exist and have valid content", () => {
      expect(DIFF_TYPE_REGRESSION).toContain(": any");
      expect(DIFF_TYPE_REGRESSION).toMatch(/--- a\//);
      expect(DIFF_TYPE_REGRESSION).toMatch(/\+\+\+ b\//);
      expect(DIFF_CLEAN).not.toContain(": any");
      expect(DIFF_CLEAN).not.toContain("as any");
      expect(DIFF_CLEAN).toMatch(/--- a\//);
      expect(DIFF_CLEAN).toMatch(/\+\+\+ b\//);
    });

    test("multi-target config is correctly structured", () => {
      expect(MULTI_TARGET_CONFIG.targets).toHaveLength(3);
      expect(MULTI_TARGET_CONFIG.rules).toHaveLength(2);
    });
  });
}
