import { describe, expect, test } from "bun:test";
import {
  HALLUCINATION_CATEGORIES,
  HALLUCINATION_FIXTURES,
  type HallucinationCategory,
} from "./fixtures/hallucination-data.ts";

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
    expect(HALLUCINATION_FIXTURES.length).toBe(33);
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
