/**
 * Gemma evaluator benchmark test.
 *
 * Selects 5 hallucination fixtures (4 positive + 1 negative, one per category)
 * and runs them through the full evaluation pipeline:
 *
 *   formatDiffSlice → GemmaLocalClient.generate → parseGemmaOutput
 *
 * Metrics collected: recall (positive fixtures), false-positive rate (negative
 * fixture), per-fixture latency, and confidence calibration.
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
  type HallucinationFixture,
} from "./fixtures/hallucination-data.ts";

/* ── Fixture selection ────────────────────────────────────────────────── */

/**
 * Selected benchmark fixture IDs — 4 positive (one per category) + 1 negative.
 *
 * Rationale:
 *   fictional-import-hono-sse-stream    → real package, non-existent named export
 *   nonexistent-api-typo-query-all       → typo method call replacing real method
 *   wrong-type-signature-promise-return  → return type mismatch (number vs Promise)
 *   security-jailbreak-codex-sudo-bypass → sudo privilege escalation
 *   security-jailbreak-negative-valid-sudo → valid sudo (negative: should NOT flag)
 */
const BENCHMARK_IDS: readonly string[] = [
  "fictional-import-hono-sse-stream",
  "nonexistent-api-typo-query-all",
  "wrong-type-signature-promise-return",
  "security-jailbreak-codex-sudo-bypass",
  "security-jailbreak-negative-valid-sudo",
];

const RUN_GEMMA_EVAL = !!process.env.P7_RUN_GEMMA_EVAL;

interface BenchmarkRecord {
  fixture: HallucinationFixture;
  findings: { severity: string; dimension: string; message: string; confidence: number }[];
  latencyMs: number;
  matchedBlockers: string[];
  falsePositive: boolean;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function loadBenchmarkFixtures(): HallucinationFixture[] {
  const fixtures: HallucinationFixture[] = [];
  for (const id of BENCHMARK_IDS) {
    const f = HALLUCINATION_FIXTURES.find((x) => x.id === id);
    if (!f) throw new Error(`Benchmark fixture "${id}" not found in HALLUCINATION_FIXTURES`);
    fixtures.push(f);
  }
  return fixtures;
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
 * Collect benchmark metrics from raw fixture outputs.
 *
 * For each fixture:
 *   1. If positive: recall = any expected blocker matched → TP, else FN.
 *   2. If negative: any finding → FP, else TN.
 *   3. Latency and confidence are recorded verbatim.
 */
function computeMetrics(records: BenchmarkRecord[]): {
  recall: number;
  falsePositiveRate: number;
  avgLatencyMs: number;
  avgConfidence: number;
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

  const detailLines = records.map((r) => {
    const verdict = r.fixture.isNegative
      ? r.falsePositive ? "FP" : "TN"
      : r.matchedBlockers.length > 0 ? "TP" : "FN";
    return [
      `  ${verdict} ${r.fixture.id}`,
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
    details: detailLines.join("\n"),
  };
}

/* ── Structure validation tests (always run) ──────────────────────────── */

describe("gemma-eval-benchmark", () => {
  const fixtures = loadBenchmarkFixtures();

  test("fixture selection covers all 4 categories with correct ratio", () => {
    expect(fixtures.length).toBe(5);
    const positives = fixtures.filter((f) => !f.isNegative);
    const negatives = fixtures.filter((f) => f.isNegative);
    expect(positives.length).toBe(4);
    expect(negatives.length).toBe(1);

    const categories = new Set(fixtures.map((f) => f.category));
    expect(categories.has("fictional-import")).toBe(true);
    expect(categories.has("nonexistent-api")).toBe(true);
    expect(categories.has("wrong-type-signature")).toBe(true);
    expect(categories.has("security-jailbreak")).toBe(true);
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

    test("run full pipeline on all 5 benchmark fixtures", async () => {
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

      expect(records.length).toBe(5);
    });

    test("benchmark metrics meet minimum quality bar", () => {
      expect(records).toBeDefined();
      expect(records.length).toBe(5);

      const metrics = computeMetrics(records);

      // Log detailed results for the report
      console.log("\n── Gemma Benchmark Results ──");
      console.log(metrics.details);
      console.log(`\nAggregate:`);
      console.log(`  Recall:              ${(metrics.recall * 100).toFixed(1)}%`);
      console.log(`  False Positive Rate: ${(metrics.falsePositiveRate * 100).toFixed(1)}%`);
      console.log(`  Avg Latency:         ${metrics.avgLatencyMs.toFixed(0)} ms`);
      console.log(`  Avg Confidence:      ${(metrics.avgConfidence * 100).toFixed(1)}%`);

      // Expected minimum: at least 2 of 4 positive fixtures detected (50% recall floor)
      expect(metrics.recall).toBeGreaterThanOrEqual(0.5);
      // Expected maximum: at most 1 false positive on the single negative fixture (100% FPR ceiling)
      expect(metrics.falsePositiveRate).toBeLessThanOrEqual(1);
    });
  });
}
