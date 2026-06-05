import { describe, expect, test } from "bun:test";
import {
  computeGemmaCriticAgreement,
  normalizeDim,
  extractKeywords,
  findingsMatch,
  type GemmaCriticAgreement,
  type PerDimMetrics,
} from "../src/gemma-validator.ts";
import type { DiffCriticFinding } from "../src/types.ts";
import type { GemmaSliceFinding } from "../src/gemma-bridge.ts";

/* ── Helpers ── */

function gemma(
  dimension: string,
  message: string,
  overrides?: Partial<GemmaSliceFinding>,
): GemmaSliceFinding {
  return {
    dimension,
    severity: "warning",
    message,
    confidence: 0.5,
    sliceMeta: { sliceIndex: 0, totalSlices: 1, charsInSlice: 100 },
    ...overrides,
  };
}

function critic(
  dimension: string,
  message: string,
  overrides?: Partial<DiffCriticFinding>,
): DiffCriticFinding {
  return { dimension, severity: "warning", message, ...overrides };
}

/* ── normalizeDim ── */

describe("normalizeDim", () => {
  test("maps bilingual Gemma dimension to Chinese", () => {
    expect(normalizeDim("过度抽象 Over-Abstraction")).toBe("过度抽象");
    expect(normalizeDim("类型退化 Type Regression")).toBe("类型退化");
  });
  test("passes through already-normal Chinese", () => {
    expect(normalizeDim("过度抽象")).toBe("过度抽象");
    expect(normalizeDim("幻觉检测")).toBe("幻觉检测");
  });
  test("maps English-only input", () => {
    expect(normalizeDim("over-abstraction")).toBe("过度抽象");
    expect(normalizeDim("type regression")).toBe("类型退化");
  });
  test("returns unknown dimension as-is", () => {
    expect(normalizeDim("Custom Dim")).toBe("Custom Dim");
  });
});

/* ── extractKeywords ── */

describe("extractKeywords", () => {
  test("extracts CJK bigrams from Chinese message", () => {
    const kw = extractKeywords("函数返回类型不一致，导致类型错误");
    expect(kw).toContain("返回");
    expect(kw).toContain("类型");
    expect(kw).toContain("错误");
  });
  test("extracts English keywords", () => {
    const kw = extractKeywords("Return type mismatch causes type error");
    expect(kw).toContain("return");
    expect(kw).toContain("mismatch");
    expect(kw).toContain("type");
  });
  test("extracts bigrams from CJK without punctuation", () => {
    const kw = extractKeywords("使用这个函数");
    // CJK bigrams: no stop-word filtering for bigrams
    expect(kw.length).toBeGreaterThanOrEqual(3);
    expect(kw).toContain("函数");
  });
  test("returns empty array for short message", () => {
    expect(extractKeywords("a b")).toEqual([]);
  });
});

/* ── findingsMatch ── */

describe("findingsMatch", () => {
  test("matches findings with same dimension and overlapping keywords", () => {
    expect(
      findingsMatch(
        gemma("过度抽象", "过度封装导致接口不清晰"),
        critic("过度抽象 Over-Abstraction", "过度封装接口不清晰"),
      ),
    ).toBe(true);
  });
  test("rejects findings with different dimensions", () => {
    expect(
      findingsMatch(
        gemma("过度抽象", "过度封装"),
        critic("模板重复", "代码重复"),
      ),
    ).toBe(false);
  });
  test("rejects findings with no keyword overlap", () => {
    expect(
      findingsMatch(
        gemma("幻觉检测", "幻影函数调用"),
        critic("幻觉检测", "不存在的API引用"),
      ),
    ).toBe(false);
  });
  test("rejects when one side has no keywords", () => {
    expect(findingsMatch(gemma("过度抽象", "ab"), critic("过度抽象", "xy"))).toBe(false);
  });
});

/* ── computeGemmaCriticAgreement ── */

describe("computeGemmaCriticAgreement", () => {
  function check(ag: GemmaCriticAgreement, expected: Partial<PerDimMetrics>) {
    for (const k of Object.keys(expected) as (keyof PerDimMetrics)[]) {
      expect(ag.overall[k]).toBeCloseTo(expected[k]!, 4);
    }
  }

  test("perfect agreement → 1.0 metrics", () => {
    const g = [gemma("过度抽象", "过度封装导致接口不清晰")];
    const c = [critic("过度抽象", "过度封装接口不清晰")];
    check(computeGemmaCriticAgreement(g, c), {
      tp: 1, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1, fpr: 0, fnr: 0,
    });
  });

  test("no overlap → zero metrics", () => {
    const g = [gemma("过度抽象", "过度封装")];
    const c = [critic("幻觉检测", "幻影函数")];
    const ag = computeGemmaCriticAgreement(g, c);
    expect(ag.overall.precision).toBe(0);
    expect(ag.overall.recall).toBe(0);
    expect(ag.overall.f1).toBe(0);
    expect(ag.overall.tp).toBe(0);
    expect(ag.overall.fp).toBe(1);
    expect(ag.overall.fn).toBe(1);
  });

  test("partial overlap → correct ratios", () => {
    // Gemma: 2 findings (1 correct, 1 false positive)
    // Critic: 2 findings (1 matched, 1 false negative)
    const g = [
      gemma("过度抽象", "过度封装接口不清晰"),
      gemma("模板重复", "不存在的模板问题"), // FP: critic doesn't mention this
    ];
    const c = [
      critic("过度抽象", "过度封装接口不清晰"),
      critic("幻觉检测", "幻影函数调用"), // FN: Gemma didn't catch this
    ];
    const ag = computeGemmaCriticAgreement(g, c);
    expect(ag.overall.tp).toBe(1);
    expect(ag.overall.fp).toBe(1);
    expect(ag.overall.fn).toBe(1);
    expect(ag.overall.precision).toBeCloseTo(0.5, 4);
    expect(ag.overall.recall).toBeCloseTo(0.5, 4);
    expect(ag.overall.f1).toBeCloseTo(0.5, 4);
  });

  test("per-dimension breakdown", () => {
    const g = [
      gemma("过度抽象", "过度封装接口"),
      gemma("模板重复", "代码重复"),
    ];
    const c = [
      critic("过度抽象", "过度封装接口"),
      critic("模板重复", "代码重复"),
    ];
    const ag = computeGemmaCriticAgreement(g, c);
    expect(ag.perDimension["过度抽象"].tp).toBe(1);
    expect(ag.perDimension["过度抽象"].precision).toBe(1);
    expect(ag.perDimension["模板重复"].tp).toBe(1);
    expect(ag.perDimension["模板重复"].recall).toBe(1);
  });

  test("empty inputs → zero metrics", () => {
    const ag = computeGemmaCriticAgreement([], []);
    expect(ag.overall.tp).toBe(0);
    expect(ag.overall.fp).toBe(0);
    expect(ag.overall.fn).toBe(0);
    expect(ag.overall.precision).toBe(0);
    expect(ag.overall.recall).toBe(0);
    expect(ag.overall.f1).toBe(0);
    expect(Object.keys(ag.perDimension).length).toBe(0);
  });
});
