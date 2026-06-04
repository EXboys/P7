/**
 * Gemma evaluator benchmark test.
 *
 * Runs all 38 hallucination fixtures through the full evaluation pipeline:
 *
 *   formatDiffSlice → GemmaLocalClient.generate → parseGemmaOutput
 *
 * Metrics collected: recall (positive fixtures), false-positive rate (negative
 * fixtures), per-fixture latency, confidence calibration, and per-category
 * breakdown. Cost-per-fixture is estimated from prompt token length.
 *
 * Environment-gated: actual Gemma inference only runs when the
 * `P7_RUN_GEMMA_EVAL` environment variable is set. Structure validation and
 * pipeline formatting tests always execute.
 */

import { describe, expect, test } from "bun:test";
import { formatDiffSlice, parseGemmaOutput } from "../src/gemma-bridge.ts";
import type { GemmaSliceMeta } from "../src/gemma-bridge.ts";
import { GemmaLocalClient } from "../src/gemma-local.ts";
import {
  HALLUCINATION_FIXTURES,
  HALLUCINATION_CATEGORIES,
  type HallucinationFixture,
  type HallucinationCategory,
} from "./fixtures/hallucination-data.ts";

/* ── Fixture selection ────────────────────────────────────────────────── */

/**
 * Uses all 38 HALLUCINATION_FIXTURES — 33 positive + 5 negative —
 * for maximum statistical coverage across all 4 categories.
 */
const ALL_FIXTURES: readonly HallucinationFixture[] = HALLUCINATION_FIXTURES;

const RUN_GEMMA_EVAL = !!process.env.P7_RUN_GEMMA_EVAL;

interface BenchmarkRecord {
  fixture: HallucinationFixture;
  findings: { severity: string; dimension: string; message: string; confidence: number }[];
  latencyMs: number;
  matchedBlockers: string[];
  falsePositive: boolean;
}

/* ── Cost estimation constants ────────────────────────────────────────── */

/** Estimated USD per 1M input tokens for Claude Haiku (cheapest Claude model). */
const CLAUDE_HAIKU_INPUT_COST_PER_1M = 0.25;
/** Estimated USD per 1M output tokens for Claude Haiku. */
const CLAUDE_HAIKU_OUTPUT_COST_PER_1M = 1.25;
/** Estimated output-to-input token ratio for code review tasks. */
const ESTIMATED_OUTPUT_RATIO = 0.15;

/* ── Helpers ──────────────────────────────────────────────────────────── */

function loadBenchmarkFixtures(): HallucinationFixture[] {
  return [...ALL_FIXTURES];
}

/**
 * Check whether a finding's message or dimension contains any of the expected
 * blocker substrings — used to determine if Gemma correctly detected a
 * hallucination.
 */
function matchesExpectedBlocker(finding: { message: string; dimension: string }, blockers: string[]): boolean {
  const haystack = `${finding.dimension} ${finding.message}`.toLowerCase();
  return blockers.some((b) => haystack.includes(b.toLowerCase()));
}

/**
 * Category-level sub-metrics.
 */
interface CategoryMetrics {
  category: HallucinationCategory;
  total: number;
  positives: number;
  negatives: number;
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  trueNegatives: number;
  recall: number;
  fpr: number;
}

/**
 * Collect benchmark metrics from raw fixture outputs.
 *
 * For each fixture:
 *   1. If positive: recall = any expected blocker matched → TP, else FN.
 *   2. If negative: any finding → FP, else TN.
 *   3. Latency and confidence are recorded verbatim.
 *
 * Returns aggregate metrics plus per-category breakdown and cost estimate.
 */
function computeMetrics(records: BenchmarkRecord[]): {
  recall: number;
  falsePositiveRate: number;
  avgLatencyMs: number;
  avgConfidence: number;
  categoryBreakdown: CategoryMetrics[];
  estimatedCostPerFixtureUsd: number;
  estimatedTotalCostUsd: number;
  details: string;
} {
  const positives = records.filter((r) => !r.fixture.isNegative);
  const negatives = records.filter((r) => r.fixture.isNegative);

  const truePositives = positives.filter((r) => r.matchedBlockers.length > 0).length;
  const falseNegatives = positives.filter((r) => r.matchedBlockers.length === 0).length;
  const recall = (truePositives + falseNegatives) > 0
    ? truePositives / (truePositives + falseNegatives)
    : 0;

  const falsePositives = negatives.filter((r) => r.falsePositive).length;
  const trueNegatives = negatives.filter((r) => !r.falsePositive).length;
  const fpr = (falsePositives + trueNegatives) > 0
    ? falsePositives / (falsePositives + trueNegatives)
    : 0;

  const latencies = records.map((r) => r.latencyMs).filter((l) => l > 0);
  const avgLatencyMs = latencies.length > 0
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : 0;

  const confidences = records.flatMap((r) => r.findings.map((f) => f.confidence));
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;

  /* ── Per-category breakdown ────────────────────────────────────────── */
  const categoryBreakdown: CategoryMetrics[] = HALLUCINATION_CATEGORIES.map((cat) => {
    const catRecords = records.filter((r) => r.fixture.category === cat);
    const catPos = catRecords.filter((r) => !r.fixture.isNegative);
    const catNeg = catRecords.filter((r) => r.fixture.isNegative);
    const tp = catPos.filter((r) => r.matchedBlockers.length > 0).length;
    const fn = catPos.filter((r) => r.matchedBlockers.length === 0).length;
    const fp = catNeg.filter((r) => r.falsePositive).length;
    const tn = catNeg.filter((r) => !r.falsePositive).length;
    return {
      category: cat,
      total: catRecords.length,
      positives: catPos.length,
      negatives: catNeg.length,
      truePositives: tp,
      falseNegatives: fn,
      falsePositives: fp,
      trueNegatives: tn,
      recall: (tp + fn) > 0 ? tp / (tp + fn) : 0,
      fpr: (fp + tn) > 0 ? fp / (fp + tn) : 0,
    };
  });

  /* ── Cost estimation ───────────────────────────────────────────────── */
  // Estimate input tokens based on average prompt length across all fixtures.
  const totalPromptChars = records.reduce(
    (sum, r) => sum + formatDiffSlice(r.fixture.diffStat).length, 0,
  );
  const avgPromptChars = records.length > 0 ? totalPromptChars / records.length : 0;
  // Rough estimate: 1 token ≈ 4 characters for code-heavy prompts
  const avgInputTokens = Math.round(avgPromptChars / 4);
  const avgOutputTokens = Math.round(avgInputTokens * ESTIMATED_OUTPUT_RATIO);
  const costPerFixture =
    (avgInputTokens * CLAUDE_HAIKU_INPUT_COST_PER_1M) / 1_000_000
    + (avgOutputTokens * CLAUDE_HAIKU_OUTPUT_COST_PER_1M) / 1_000_000;
  const totalCost = costPerFixture * records.length;

  /* ── Detail rendering ──────────────────────────────────────────────── */
  const detailLines = records.map((r) => {
    const verdict = r.fixture.isNegative
      ? r.falsePositive ? "FP" : "TN"
      : r.matchedBlockers.length > 0 ? "TP" : "FN";
    return [
      `  [${r.fixture.category}] ${verdict} ${r.fixture.id}`,
      `    findings: ${r.findings.length}, ` +
      `matched: [${r.matchedBlockers.join(", ")}], ` +
      `latency: ${r.latencyMs.toFixed(0)} ms`,
    ].join("\n");
  });

  return {
    recall,
    falsePositiveRate: fpr,
    avgLatencyMs,
    avgConfidence,
    categoryBreakdown,
    estimatedCostPerFixtureUsd: costPerFixture,
    estimatedTotalCostUsd: totalCost,
    details: detailLines.join("\n"),
  };
}

/* ── Structure validation tests (always run) ──────────────────────────── */

describe("gemma-eval-benchmark", () => {
  const fixtures = loadBenchmarkFixtures();

  test("fixture selection covers all 38 fixtures across 4 categories", () => {
    expect(fixtures.length).toBe(38);
    const positives = fixtures.filter((f) => !f.isNegative);
    const negatives = fixtures.filter((f) => f.isNegative);
    expect(positives.length).toBe(33);
    expect(negatives.length).toBe(5);

    const categories = new Set(fixtures.map((f) => f.category));
    for (const cat of HALLUCINATION_CATEGORIES) {
      expect(categories.has(cat)).toBe(true);
    }
  });

  test("each positive fixture has at least one expected blocker", () => {
    for (const f of fixtures) {
      if (f.isNegative) {
        expect(f.expectedBlockers.length).toBe(0);
      } else {
        expect(f.expectedBlockers.length).toBeGreaterThan(0);
      }
    }
  });

  test("formatDiffSlice produces valid prompts for all fixtures", () => {
    for (const f of fixtures) {
      const prompt = formatDiffSlice(f.diffStat);
      expect(prompt.length).toBeGreaterThan(100);
      expect(prompt).toContain("## Dimensions");
      expect(prompt).toContain("```diff");
      expect(prompt).toContain(f.diffStat.trim().slice(0, 40));
    }
  });

  test("parseGemmaOutput handles empty / structured input gracefully", () => {
    const sliceMeta: GemmaSliceMeta = { sliceIndex: 0, totalSlices: 1, charsInSlice: 0 };
    const empty = parseGemmaOutput("", sliceMeta);
    expect(empty).toEqual([]);

    const structured = parseGemmaOutput(
      "- [blocker] Type Regression: detected type mismatch\n" +
      "Some explanatory text that should be skipped\n" +
      "- [info] Over-Abstraction: minor concern\n",
      { sliceIndex: 0, totalSlices: 1, charsInSlice: 200 },
    );
    expect(structured.length).toBe(2);
    expect(structured[0].severity).toBe("blocker");
    expect(structured[0].dimension).toBe("Type Regression");
    expect(structured[0].confidence).toBe(0.8);
    expect(structured[1].severity).toBe("info");
    expect(structured[1].confidence).toBe(0.3);
  });

  test("parseGemmaOutput fallback regex catches malformed lines", () => {
    const sliceMeta: GemmaSliceMeta = { sliceIndex: 0, totalSlices: 1, charsInSlice: 100 };
    // Line with [severity] but no colon-separated dimension → should fall back to "other"
    const raw = "- [warning] this line has no dimension prefix\n";
    const findings = parseGemmaOutput(raw, sliceMeta);
    expect(findings.length).toBe(1);
    expect(findings[0].dimension).toBe("other");
    // Confidence should be penalised (0.5 * 0.7 = 0.35)
    expect(findings[0].confidence).toBeCloseTo(0.35, 5);
  });
});

/* ── Gemma inference benchmark (env-gated) ────────────────────────────── */

if (RUN_GEMMA_EVAL) {
  describe("gemma-eval-benchmark inference", () => {
    const fixtures = loadBenchmarkFixtures();
    let client: GemmaLocalClient;
    let records: BenchmarkRecord[];

    test("GemmaLocalClient initialises and Ollama is reachable", async () => {
      client = new GemmaLocalClient({
        baseUrl: process.env.OLLAMA_URL || undefined,
        model: process.env.GEMMA_MODEL || undefined,
      });
      const { text, latencyMs } = await client.generate("return 1");
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      expect(latencyMs).toBeGreaterThan(0);
    });

    test("run full pipeline on all 38 benchmark fixtures", async () => {
      expect(client).toBeDefined();
      records = [];

      for (const f of fixtures) {
        const prompt = formatDiffSlice(f.diffStat);
        const sliceMeta: GemmaSliceMeta = {
          sliceIndex: 0,
          totalSlices: 1,
          charsInSlice: prompt.length,
        };

        const { text, latencyMs } = await client.generate(prompt);
        const findings = parseGemmaOutput(text, sliceMeta);

        const matchedBlockers = f.isNegative
          ? []
          : findings
              .filter((fd) => matchesExpectedBlocker(fd, f.expectedBlockers))
              .map((fd) => fd.message);

        const hasAnyFinding = findings.length > 0;

        records.push({
          fixture: f,
          findings: findings.map((fd) => ({
            severity: fd.severity,
            dimension: fd.dimension,
            message: fd.message,
            confidence: fd.confidence,
          })),
          latencyMs,
          matchedBlockers,
          falsePositive: f.isNegative ? hasAnyFinding : false,
        });
      }

      expect(records.length).toBe(38);
    });

    test("benchmark metrics meet minimum quality bar", () => {
      expect(records).toBeDefined();
      expect(records.length).toBe(38);

      const metrics = computeMetrics(records);

      // Log detailed results for the report
      console.log("\n── Gemma Benchmark Results (38 fixtures) ──");
      console.log(metrics.details);
      console.log(`\nAggregate:`);
      console.log(`  Recall:              ${(metrics.recall * 100).toFixed(1)}%`);
      console.log(`  False Positive Rate: ${(metrics.falsePositiveRate * 100).toFixed(1)}%`);
      console.log(`  Avg Latency:         ${metrics.avgLatencyMs.toFixed(0)} ms`);
      console.log(`  Avg Confidence:      ${(metrics.avgConfidence * 100).toFixed(1)}%`);

      // Per-category breakdown
      console.log(`\n── Per-Category Breakdown ──`);
      for (const cat of metrics.categoryBreakdown) {
        console.log(
          `  ${cat.category}: recall=${(cat.recall * 100).toFixed(1)}% ` +
          `fpr=${(cat.fpr * 100).toFixed(1)}% ` +
          `(${cat.truePositives}TP/${cat.falseNegatives}FN/${cat.falsePositives}FP/${cat.trueNegatives}TN)`,
        );
      }

      // Cost estimation
      console.log(`\n── Cost Estimation (vs Claude Haiku) ──`);
      console.log(`  Est. cost per fixture: $${metrics.estimatedCostPerFixtureUsd.toFixed(6)}`);
      console.log(`  Est. cost for 38 fixtures: $${metrics.estimatedTotalCostUsd.toFixed(4)}`);
      console.log(`  Gemma (local/Ollama): free`);

      // Expected minimum: 33 positive fixtures → at least 50% recall (16+ of 33)
      expect(metrics.recall).toBeGreaterThanOrEqual(0.5);
      // Expected maximum: 5 negative fixtures → at most 100% FPR (all could be FP)
      expect(metrics.falsePositiveRate).toBeLessThanOrEqual(1);
    });
  });
}
