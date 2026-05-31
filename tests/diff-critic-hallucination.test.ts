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
      expect(fixture.expectedBlockers.length).toBeGreaterThan(0);
      expect(Object.keys(fixture.setupFiles).length).toBeGreaterThan(0);
      for (const [path, content] of Object.entries(fixture.setupFiles)) {
        expect(path.length).toBeGreaterThan(0);
        expect(content.trim().length).toBeGreaterThan(0);
      }
      expect(fixture.diffStat.trim().length).toBeGreaterThan(0);
    }
  });

  test("covers all three hallucination categories with at least one fixture each", () => {
    const seen = new Set<HallucinationCategory>();
    for (const fixture of HALLUCINATION_FIXTURES) {
      seen.add(fixture.category);
    }
    for (const category of HALLUCINATION_CATEGORIES) {
      expect(seen.has(category)).toBe(true);
    }
    expect(HALLUCINATION_FIXTURES.length).toBe(9);
  });

  test("each fixture diffStat contains its expectedBlockers keywords", () => {
    for (const fixture of HALLUCINATION_FIXTURES) {
      for (const keyword of fixture.expectedBlockers) {
        expect(fixture.diffStat).toContain(keyword);
      }
    }
  });

  test("fixture ids are unique", () => {
    const ids = HALLUCINATION_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
