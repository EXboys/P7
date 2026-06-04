import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import type { DiffCriticFinding } from "../src/types.ts";
import { reviewGradualTypeCheck } from "../src/gradual-typechecker.ts";

/* ── Inline fixtures ── */

interface GradualTypeFixture {
  id: string;
  description: string;
  diffStat: string;
  /** Files to write into the temp project directory before running review. */
  setupFiles: Record<string, string>;
  /** When true, this fixture expects ok:true (no violations detected). */
  isNegative?: boolean;
}

const GRADUAL_TYPE_FIXTURES: GradualTypeFixture[] = [
  {
    id: "any-type-escape",
    description: "Introduces `any` type in function parameter, escaping strict type checking",
    setupFiles: {
      "src/user.ts": [
        "export interface User {",
        "  id: number;",
        "  name: string;",
        "}",
      ].join("\n"),
    },
    diffStat: [
      '--- a/src/user.ts',
      '+++ b/src/user.ts',
      '@@ -1,5 +1,10 @@',
      ' export interface User {',
      '   id: number;',
      '   name: string;',
      ' }',
      '+',
      '+/** Process user data — accepts any input */',
      '+export function processUser(input: any): void {',
      '+  console.log("processing", input);',
      '+}',
    ].join("\n"),
  },
  {
    id: "ts-ignore-suppression",
    description: "Adds @ts-ignore comment to bypass type error in an assignment",
    setupFiles: {
      "src/api.ts": [
        "export function fetchData(): Promise<string> {",
        "  return Promise.resolve(\"data\");",
        "}",
      ].join("\n"),
    },
    diffStat: [
      '--- a/src/api.ts',
      '+++ b/src/api.ts',
      '@@ -1,3 +1,12 @@',
      ' export function fetchData(): Promise<string> {',
      '   return Promise.resolve("data");',
      ' }',
      '+',
      '+import { fetchData } from \"./api\";',
      '+',
      '+export function process(): number {',
      '+  // @ts-ignore',
      '+  const result: number = fetchData();',
      '+  return result;',
      '+}',
    ].join("\n"),
  },
  {
    id: "as-any-unsafe-cast",
    description: "Uses `as any` double cast to bypass type safety when parsing config",
    setupFiles: {
      "src/config.ts": [
        "export interface Config {",
        "  apiUrl: string;",
        "  timeout: number;",
        "}",
      ].join("\n"),
    },
    diffStat: [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,3 +1,11 @@',
      ' export interface Config {',
      '   apiUrl: string;',
      '   timeout: number;',
      ' }',
      '+',
      '+import type { Config } from \"./config\";',
      '+',
      '+export function loadConfig(data: unknown): Config {',
      '+  // Unsafe cast: forces unknown to Config without validation',
      '+  return data as any as Config;',
      '+}',
    ].join("\n"),
  },
  {
    id: "clean-type-safe",
    description: "Adds a pure type-safe function with proper types — no violations",
    isNegative: true,
    setupFiles: {
      "src/math.ts": [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
      ].join("\n"),
    },
    diffStat: [
      '--- a/src/math.ts',
      '+++ b/src/math.ts',
      '@@ -1,3 +1,13 @@',
      ' export function add(a: number, b: number): number {',
      '   return a + b;',
      ' }',
      '+',
      '+/** Multiply two numbers. */',
      '+export function multiply(a: number, b: number): number {',
      '+  return a * b;',
      '+}',
      '+',
      '+/** Compute square of a number. */',
      '+export function square(n: number): number {',
      '+  return multiply(n, n);',
      '+}',
    ].join("\n"),
  },
];

/* ── Integration tests (environment-gated) ── */

const RUN_EVAL = process.env.P7_RUN_GRADUAL_TYPECHECK === "true";

/**
 * Check whether structured findings include a finding with severity "blocker"
 * for positive fixtures. Negative fixtures (isNegative) always return true.
 */
function hasBlocker(findings: DiffCriticFinding[]): boolean {
  return findings.some((f) => f.severity === "blocker");
}

/**
 * Set P7_RUN_GRADUAL_TYPECHECK=true to run these integration tests.
 * Each positive fixture calls reviewGradualTypeCheck against an LLM — expect 4 API calls.
 * Set P7_MODEL=claude-3-5-haiku-latest to reduce cost during iteration.
 */
if (RUN_EVAL) {
  describe("gradual type-check evaluation", () => {
    // One temp directory per fixture, populated with its setupFiles.
    const tempDirs = new Map<string, string>();

    beforeAll(() => {
      for (const fixture of GRADUAL_TYPE_FIXTURES) {
        const tempDir = mkdtempSync(join(tmpdir(), "p7-gradual-type-"));
        for (const [filePath, content] of Object.entries(fixture.setupFiles)) {
          const fullPath = join(tempDir, filePath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content, "utf-8");
        }
        tempDirs.set(fixture.id, tempDir);
      }
    });

    // ── Positive fixtures: each must be detected as ok:false ──
    for (const fixture of GRADUAL_TYPE_FIXTURES) {
      if (fixture.isNegative) continue;

      test.concurrent(
        `detects ${fixture.id}: ${fixture.description.slice(0, 60)}`,
        async () => {
          const tempDir = tempDirs.get(fixture.id)!;
          const result = await reviewGradualTypeCheck(tempDir, fixture.diffStat);
          // Positive fixtures must have a blocker finding
          expect(hasBlocker(result.structuredFindings)).toBe(true);
          // ok should be false when blockers are present
          expect(result.ok).toBe(false);
        },
        120_000,
      );
    }

    // ── Negative fixtures: clean diffs must pass as ok:true ──
    for (const fixture of GRADUAL_TYPE_FIXTURES) {
      if (!fixture.isNegative) continue;

      test.concurrent(
        `no-false-positive ${fixture.id}`,
        async () => {
          const tempDir = tempDirs.get(fixture.id)!;
          const result = await reviewGradualTypeCheck(tempDir, fixture.diffStat);
          const hasAnyBlocker = hasBlocker(result.structuredFindings);
          expect(hasAnyBlocker).toBe(false);
          expect(result.ok).toBe(true);
        },
        120_000,
      );
    }
  });
} else {
  // Structural tests run regardless of env gate
  describe("gradual type-check fixtures structure", () => {
    test("each fixture has valid id and setup files", () => {
      for (const fixture of GRADUAL_TYPE_FIXTURES) {
        expect(fixture.id.length).toBeGreaterThan(0);
        expect(Object.keys(fixture.setupFiles).length).toBeGreaterThan(0);
        for (const [path, content] of Object.entries(fixture.setupFiles)) {
          expect(path.length).toBeGreaterThan(0);
          expect(content.trim().length).toBeGreaterThan(0);
        }
        expect(fixture.diffStat.trim().length).toBeGreaterThan(0);
      }
    });

    test("fixture ids are unique", () => {
      const ids = GRADUAL_TYPE_FIXTURES.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    test("covers all 4 gradual type categories", () => {
      const expectedMap: Record<string, boolean> = {
        "any-type-escape": false,
        "ts-ignore-suppression": false,
        "as-any-unsafe-cast": false,
        "clean-type-safe": false,
      };
      for (const fixture of GRADUAL_TYPE_FIXTURES) {
        if (fixture.id in expectedMap) {
          expectedMap[fixture.id] = true;
        }
      }
      for (const [id, covered] of Object.entries(expectedMap)) {
        expect(covered).toBe(true);
      }
    });

    test("captures 3 positive + 1 negative fixture exactly", () => {
      const positives = GRADUAL_TYPE_FIXTURES.filter((f) => !f.isNegative);
      const negatives = GRADUAL_TYPE_FIXTURES.filter((f) => f.isNegative);
      expect(positives.length).toBe(3);
      expect(negatives.length).toBe(1);
    });

    test("positive fixture diffStats contain their violation markers", () => {
      for (const fixture of GRADUAL_TYPE_FIXTURES) {
        if (fixture.isNegative) continue;
        // Each positive fixture's diffStat must contain the key pattern
        const diff = fixture.diffStat;
        switch (fixture.id) {
          case "any-type-escape":
            expect(diff).toContain(": any");
            break;
          case "ts-ignore-suppression":
            expect(diff).toContain("@ts-ignore");
            break;
          case "as-any-unsafe-cast":
            expect(diff).toContain("as any");
            break;
        }
      }
    });

    test("negative fixture diffStat contains no violation markers", () => {
      const negative = GRADUAL_TYPE_FIXTURES.filter((f) => f.isNegative);
      for (const fixture of negative) {
        const diff = fixture.diffStat;
        expect(diff).not.toContain(": any");
        expect(diff).not.toContain("@ts-ignore");
        expect(diff).not.toContain("@ts-expect-error");
        expect(diff).not.toContain("as any");
        expect(diff).not.toContain("as unknown");
      }
    });

    test("each fixture diffStat is a valid diff with ---/+++ headers", () => {
      for (const fixture of GRADUAL_TYPE_FIXTURES) {
        expect(fixture.diffStat).toMatch(/--- a\//);
        expect(fixture.diffStat).toMatch(/\+\+\+ b\//);
      }
    });
  });
}
