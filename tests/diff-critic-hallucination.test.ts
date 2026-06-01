import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import {
  HALLUCINATION_CATEGORIES,
  HALLUCINATION_FIXTURES,
  type HallucinationCategory,
  type HallucinationFixture,
} from "./fixtures/hallucination-data.ts";
import { reviewDiff } from "../src/diff-critic.ts";
import type { DiffCriticFinding } from "../src/types.ts";

describe("hallucination diff fixtures", () => {
  test("each fixture has valid structure", () => {
    for (const fixture of HALLUCINATION_FIXTURES) {
      expect(fixture.id.length).toBeGreaterThan(0);
      expect(HALLUCINATION_CATEGORIES).toContain(fixture.category);
      if (fixture.isNegative) {
        // Negative fixtures validate that no blockers are raised.
        expect(fixture.expectedBlockers.length).toBe(0);
      } else {
        expect(fixture.expectedBlockers.length).toBeGreaterThan(0);
      }
      expect(Object.keys(fixture.setupFiles).length).toBeGreaterThan(0);
      for (const [path, content] of Object.entries(fixture.setupFiles)) {
        expect(path.length).toBeGreaterThan(0);
        expect(content.trim().length).toBeGreaterThan(0);
      }
      expect(fixture.diffStat.trim().length).toBeGreaterThan(0);
    }
  });

  test("covers all hallucination categories with at least one fixture each", () => {
    const seen = new Set<HallucinationCategory>();
    for (const fixture of HALLUCINATION_FIXTURES) {
      seen.add(fixture.category);
    }
    for (const category of HALLUCINATION_CATEGORIES) {
      expect(seen.has(category)).toBe(true);
    }
    expect(HALLUCINATION_FIXTURES.length).toBe(38);
  });

  test("covers security-jailbreak category with at least one fixture", () => {
    const jailbreakFixtures = HALLUCINATION_FIXTURES.filter(
      (f) => f.category === "security-jailbreak",
    );
    expect(jailbreakFixtures.length).toBeGreaterThanOrEqual(1);
    for (const fixture of jailbreakFixtures) {
      expect(fixture.hallucinationPattern).toBe("security-jailbreak");
    }
  });

  test("hallucinationPattern field is non-empty string when present", () => {
    const withPattern = HALLUCINATION_FIXTURES.filter((f) => f.hallucinationPattern !== undefined);
    expect(withPattern.length).toBeGreaterThanOrEqual(7);
    for (const fixture of withPattern) {
      expect(typeof fixture.hallucinationPattern).toBe("string");
      expect(fixture.hallucinationPattern!.length).toBeGreaterThan(0);
    }
  });

  test("each category has at least 5 fixtures", () => {
    const counts = new Map<HallucinationCategory, number>();
    for (const fixture of HALLUCINATION_FIXTURES) {
      counts.set(fixture.category, (counts.get(fixture.category) ?? 0) + 1);
    }
    for (const category of HALLUCINATION_CATEGORIES) {
      expect(counts.get(category) ?? 0).toBeGreaterThanOrEqual(5);
    }
  });

  test("each fixture diffStat contains its expectedBlockers keywords (skip negative)", () => {
    for (const fixture of HALLUCINATION_FIXTURES) {
      if (fixture.isNegative) {
        // Negative fixtures are expected to have no blockers; skip keyword check.
        continue;
      }
      for (const keyword of fixture.expectedBlockers) {
        expect(fixture.diffStat).toContain(keyword);
      }
    }
  });

  test("fixture ids are unique", () => {
    const ids = HALLUCINATION_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("negative fixtures have empty expectedBlockers and isNegative flag", () => {
    const negatives = HALLUCINATION_FIXTURES.filter((f) => f.isNegative);
    expect(negatives.length).toBeGreaterThanOrEqual(2);
    for (const fixture of negatives) {
      expect(fixture.expectedBlockers.length).toBe(0);
      // Negative fixtures' diffStat should NOT reference obviously fictional symbols.
      const suspicious = /@[a-z]+[/-][a-z]+|Fake[A-Z]|NonExistent|\/\/\s+TODO/.test(
        fixture.diffStat,
      );
      expect(suspicious).toBe(false);
    }
  });

  test("fictional-import / nonexistent-api / wrong-type-signature each cover at least 1 negative fixture", () => {
    const targetCategories: HallucinationCategory[] = [
      "fictional-import",
      "nonexistent-api",
      "wrong-type-signature",
    ];
    for (const category of targetCategories) {
      const negatives = HALLUCINATION_FIXTURES.filter(
        (f) => f.category === category && f.isNegative === true,
      );
      expect(negatives.length).toBeGreaterThanOrEqual(1);
    }
  });
});

/* ── Integration tests: hallucination capture rate ── */

const RUN_EVAL = process.env.P7_RUN_HALLUCINATION_EVAL === "true";

/**
 * Check whether reviewDiff structured findings detect at least one of the
 * fixture's expected blocker keywords (case-insensitive substring match).
 * Negative fixtures (expectedBlockers.length === 0) always return true.
 */
function hasExpectedBlockers(
  fixture: HallucinationFixture,
  findings: DiffCriticFinding[],
): boolean {
  if (fixture.expectedBlockers.length === 0) return true;
  const blockers = findings.filter((f) => f.severity === "blocker");
  return fixture.expectedBlockers.some((keyword) =>
    blockers.some((f) => f.message.toLowerCase().includes(keyword.toLowerCase())),
  );
}

/**
 * Set P7_RUN_HALLUCINATION_EVAL=true to run these integration tests.
 * Each positive fixture calls reviewDiff against an LLM — expect 33+ API calls.
 * Set P7_MODEL=claude-3-5-haiku-latest to reduce cost during iteration.
 */
if (RUN_EVAL) {
  describe("hallucination capture rate evaluation", () => {
    // Collect per-fixture results for aggregate assertion in afterAll.
    const positiveResults: Array<{
      fixture: HallucinationFixture;
      captured: boolean;
      blockerCount: number;
    }> = [];
    const negativeResults: Array<{
      fixture: HallucinationFixture;
      falsePositive: boolean;
    }> = [];

    // One temp directory per fixture, populated with its setupFiles.
    const tempDirs = new Map<string, string>();

    beforeAll(() => {
      for (const fixture of HALLUCINATION_FIXTURES) {
        const tempDir = mkdtempSync(join(tmpdir(), "p7-halluc-"));
        for (const [filePath, content] of Object.entries(fixture.setupFiles)) {
          const fullPath = join(tempDir, filePath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content, "utf-8");
        }
        tempDirs.set(fixture.id, tempDir);
      }
    });

    // ── Per-fixture concurrent tests: positive fixtures ──
    for (const fixture of HALLUCINATION_FIXTURES) {
      if (fixture.isNegative) continue;

      test.concurrent(
        `captures ${fixture.id}: ${fixture.description.slice(0, 60)}`,
        async () => {
          const tempDir = tempDirs.get(fixture.id)!;
          const result = await reviewDiff(tempDir, fixture.diffStat, fixture.description);
          const captured = hasExpectedBlockers(fixture, result.structuredFindings);
          const blockerCount = result.structuredFindings.filter(
            (f) => f.severity === "blocker",
          ).length;
          positiveResults.push({ fixture, captured, blockerCount });
          expect(captured).toBe(true);
        },
        120_000,
      );
    }

    // ── Per-fixture concurrent tests: negative fixtures ──
    for (const fixture of HALLUCINATION_FIXTURES) {
      if (!fixture.isNegative) continue;

      test.concurrent(
        `no-false-positive ${fixture.id}`,
        async () => {
          const tempDir = tempDirs.get(fixture.id)!;
          const result = await reviewDiff(tempDir, fixture.diffStat, fixture.description);
          const falsePositive = result.structuredFindings.some(
            (f) => f.severity === "blocker",
          );
          negativeResults.push({ fixture, falsePositive });
          expect(falsePositive).toBe(false);
        },
        120_000,
      );
    }

    // ── Aggregate capture rate ≥ 80% ──
    afterAll(() => {
      const total = positiveResults.length;
      const captured = positiveResults.filter((r) => r.captured).length;
      const rate = total > 0 ? captured / total : 0;
      console.log(
        `[capture-rate] ${captured}/${total} positive fixtures detected (${(rate * 100).toFixed(1)}%)`,
      );
      if (negativeResults.length > 0) {
        const fps = negativeResults.filter((r) => r.falsePositive).length;
        console.log(
          `[capture-rate] ${fps}/${negativeResults.length} negative fixtures had false positives`,
        );
      }
      expect(rate).toBeGreaterThanOrEqual(0.8);
    });
  });
}
