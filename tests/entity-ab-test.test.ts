import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { reviewDiff } from "../src/diff-critic.ts";
import type { DiffCriticFinding } from "../src/types.ts";

/* ── Fixture interface ── */

interface AbFixture {
  id: string;
  description: string;
  /** Whether this fixture represents a clean change (no expected findings). */
  isNegative: boolean;
  /** Source files to write to the temp directory before running reviewDiff. */
  setupFiles: Record<string, string>;
  /** Unified diff content passed as diffStat to reviewDiff. */
  diffStat: string;
  /** Pre-formatted entity context string simulating captureEntityDiff output. */
  entityContext: string;
  /** Substrings that must appear in blocker/relevant findings for a positive fixture. */
  expectedKeywords: string[];
}

/* ── Fixtures ── */

const FIXTURES: AbFixture[] = [
  {
    id: "security-sql-injection",
    description: "Refactor database query helper for code clarity",
    isNegative: false,
    setupFiles: {
      "src/db.ts": `import { z } from "zod";

interface User {
  id: number;
  email: string;
  name: string;
}

export async function query(sql: string, params: unknown[]): Promise<unknown[]> {
  // Placeholder: in production this calls a parameterized query driver
  return [];
}

export async function findUser(email: string): Promise<User | null> {
  const rows = await query("SELECT * FROM users WHERE email = $1", [email]);
  return rows.length > 0 ? (rows[0] as User) : null;
}
`,
    },
    diffStat: ` src/db.ts | 11 ++++++++---
@@ -1,11 +1,13 @@
 import { z } from "zod";

 interface User {
   id: number;
   email: string;
   name: string;
 }

-export async function query(sql: string, params: unknown[]): Promise<unknown[]> {
-  // Placeholder: in production this calls a parameterized query driver
-  return [];
+export async function query(queryStr: string): Promise<unknown[]> {
+  // Build query by concatenating input directly
+  const executed = "SELECT " + queryStr;
+  // Placeholder: calls exec(executed)
+  return [];
 }

 export async function findUser(email: string): Promise<User | null> {
-  const rows = await query("SELECT * FROM users WHERE email = $1", [email]);
+  const rows = await query("SELECT * FROM users WHERE email = '" + email + "'");
   return rows.length > 0 ? (rows[0] as User) : null;
 }
`,
    entityContext: `#### src/db.ts
- modified function \`query\`:5
- modified function \`findUser\`:16`,
    expectedKeywords: ["SQL", "injection", "concatenation", "parameterized"],
  },
  {
    id: "config-hardcoded-secret",
    description: "Update database configuration for local development",
    isNegative: false,
    setupFiles: {
      "src/config.ts": `export interface DbConfig {
  host: string;
  port: number;
  password: string;
}

export function loadConfig(): DbConfig {
  return {
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? "5432"),
    password: process.env.DB_PASSWORD ?? "",
  };
}
`,
    },
    diffStat: ` src/config.ts | 6 +++---
@@ -7,10 +7,10 @@ export interface DbConfig {

 export function loadConfig(): DbConfig {
   return {
     host: process.env.DB_HOST ?? "localhost",
     port: Number(process.env.DB_PORT ?? "5432"),
-    password: process.env.DB_PASSWORD ?? "",
+    password: "super_secret_2024!",
   };
 }
`,
    entityContext: `#### src/config.ts
- modified function \`loadConfig\`:6`,
    expectedKeywords: ["password", "secret", "credential", "hardcoded"],
  },
  {
    id: "xss-missing-sanitization",
    description: "Add user profile rendering endpoint",
    isNegative: false,
    setupFiles: {
      "src/profile.ts": `import { Hono } from "hono";

const app = new Hono();

export function renderProfile(name: string, bio: string): string {
  return \`<div><h1>\${name}</h1><p>\${bio}</p></div>\`;
}

export default app;
`,
    },
    diffStat: ` src/profile.ts | 14 ++++++++++++++
@@ -1,7 +1,21 @@
 import { Hono } from "hono";

 const app = new Hono();

 export function renderProfile(name: string, bio: string): string {
   return \`<div><h1>\${name}</h1><p>\${bio}</p></div>\`;
 }
+
+export function renderUserCard(user: { displayName: string; about: string }): string {
+  const html = \`
+    <div class="card">
+      <h3>\${user.displayName}</h3>
+      <p>\${user.about}</p>
+    </div>\`;
+  return html;
+}
+
+app.get("/user/:id", async (c) => {
+  const user = { displayName: c.req.query("name") ?? "", about: c.req.query("bio") ?? "" };
+  return c.html(renderUserCard(user));
+});
`,
    entityContext: `#### src/profile.ts
- added function \`renderUserCard\`:10
- added function (anonymous):20`,
    expectedKeywords: ["XSS", "sanitiz", "escape", "injection"],
  },
  {
    id: "safe-variable-rename",
    description: "Rename internal variables for consistency",
    isNegative: true,
    setupFiles: {
      "src/utils.ts": `export function calculateTotal(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}

export function formatLabel(text: string): string {
  const trimmed = text.trim();
  return trimmed.toUpperCase();
}
`,
    },
    diffStat: ` src/utils.ts | 16 ++++++++--------
@@ -1,16 +1,16 @@
 export function calculateTotal(items: number[]): number {
-  let sum = 0;
+  let total = 0;
   for (const item of items) {
-    sum += item;
+    total += item;
   }
-  return sum;
+  return total;
 }

 export function formatLabel(text: string): string {
-  const trimmed = text.trim();
-  return trimmed.toUpperCase();
+  const cleaned = text.trim();
+  return cleaned.toUpperCase();
 }
`,
    entityContext: `#### src/utils.ts
- modified function \`calculateTotal\`:1
- modified function \`formatLabel\`:9`,
    expectedKeywords: [],
  },
];

/* ── Metric computation ── */

interface FixtureMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  recall: number;
  precision: number;
  fpr: number;
  f1: number;
}

function computeMetrics(
  fixture: AbFixture,
  findings: DiffCriticFinding[],
): FixtureMetrics {
  // For positive fixtures: expectedKeywords are the truth labels
  if (!fixture.isNegative) {
    const allFindingsText = findings.map((f) => f.message).join("\n").toLowerCase();
    let tp = 0;
    let fn = 0;
    for (const keyword of fixture.expectedKeywords) {
      if (allFindingsText.includes(keyword.toLowerCase())) {
        tp++;
      } else {
        fn++;
      }
    }
    // FP: blocker findings that don't match any expected keyword
    const blockerFindings = findings.filter((f) => f.severity === "blocker");
    const fp = blockerFindings.filter(
      (f) => !fixture.expectedKeywords.some((kw) =>
        f.message.toLowerCase().includes(kw.toLowerCase()),
      ),
    ).length;
    // TN: approximated as 1 if no spurious blockers, else 0
    const tn = fp === 0 ? 1 : 0;

    const precision = tp + fp > 0 ? tp / (tp + fp) : tp > 0 ? 1 : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
    const f1 = precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;

    return { truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn, recall, precision, fpr, f1 };
  }

  // For negative fixtures: clean diff should have zero blocker findings
  const blockers = findings.filter((f) => f.severity === "blocker");
  const tp = 0;
  const fn = 0;
  const fp = blockers.length;
  const tn = fp === 0 ? 1 : 0;

  const precision = 1; // No expected positives → precision is perfect by definition
  const recall = 1; // No expected positives → recall is perfect
  const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
  const f1 = 1; // No expected positives → F1 is perfect

  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn, recall, precision, fpr, f1 };
}

interface AggregateMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  recall: number;
  precision: number;
  fpr: number;
  f1: number;
}

function sumMetrics(metricsList: FixtureMetrics[]): AggregateMetrics {
  const tp = metricsList.reduce((s, m) => s + m.truePositives, 0);
  const fp = metricsList.reduce((s, m) => s + m.falsePositives, 0);
  const fn = metricsList.reduce((s, m) => s + m.falseNegatives, 0);
  const tn = metricsList.reduce((s, m) => s + m.trueNegatives, 0);

  const precision = tp + fp > 0 ? tp / (tp + fp) : tp > 0 ? 1 : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
  const f1 = precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0;

  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn, recall, precision, fpr, f1 };
}

/* ── Structured JSON output for trends ── */

interface AbTestResult {
  test: "entity-ab-test";
  model: string;
  withoutEntity: AggregateMetrics;
  withEntity: AggregateMetrics;
  improvement: {
    recallDelta: number;
    fprDelta: number;
    precisionDelta: number;
    f1Delta: number;
  };
  timestamp: string;
}

/* ── Guard: only run when P7_RUN_ENTITY_AB_TEST=true ── */

const RUN_AB = process.env.P7_RUN_ENTITY_AB_TEST === "true";

if (RUN_AB) {
  describe("entity context A/B test", () => {
    // Per-fixture results, collected in beforeAll/afterAll
    const withoutEntityMetrics: FixtureMetrics[] = [];
    const withEntityMetrics: FixtureMetrics[] = [];

    // One temp directory per fixture
    const tempDirs = new Map<string, string>();

    beforeAll(() => {
      for (const fixture of FIXTURES) {
        const tempDir = mkdtempSync(join(tmpdir(), "p7-ab-"));
        for (const [filePath, content] of Object.entries(fixture.setupFiles)) {
          const fullPath = join(tempDir, filePath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content, "utf-8");
        }
        tempDirs.set(fixture.id, tempDir);
      }
    });

    // ── Per-fixture A/B comparison ──
    for (const fixture of FIXTURES) {
      test.concurrent(
        `ab:${fixture.id}: reviewDiff without entity context`,
        async () => {
          const tempDir = tempDirs.get(fixture.id)!;
          const result = await reviewDiff(tempDir, fixture.diffStat, fixture.description);
          const metrics = computeMetrics(fixture, result.structuredFindings);
          withoutEntityMetrics.push(metrics);
          // Log per-fixture metrics
          console.log(
            `[without-entity] ${fixture.id} recall=${(metrics.recall * 100).toFixed(1)}% fpr=${(metrics.fpr * 100).toFixed(1)}% precision=${(metrics.precision * 100).toFixed(1)}% f1=${(metrics.f1 * 100).toFixed(1)}%`,
          );
        },
        120_000,
      );

      test.concurrent(
        `ab:${fixture.id}: reviewDiff with entity context`,
        async () => {
          const tempDir = tempDirs.get(fixture.id)!;
          const result = await reviewDiff(tempDir, fixture.diffStat, fixture.description, fixture.entityContext);
          const metrics = computeMetrics(fixture, result.structuredFindings);
          withEntityMetrics.push(metrics);
          console.log(
            `[with-entity] ${fixture.id} recall=${(metrics.recall * 100).toFixed(1)}% fpr=${(metrics.fpr * 100).toFixed(1)}% precision=${(metrics.precision * 100).toFixed(1)}% f1=${(metrics.f1 * 100).toFixed(1)}%`,
          );
        },
        120_000,
      );
    }

    // ── Aggregate A/B comparison ──
    afterAll(() => {
      const aggregateBefore = sumMetrics(withoutEntityMetrics);
      const aggregateAfter = sumMetrics(withEntityMetrics);

      const recallDelta = aggregateAfter.recall - aggregateBefore.recall;
      const fprDelta = aggregateAfter.fpr - aggregateBefore.fpr;
      const precisionDelta = aggregateAfter.precision - aggregateBefore.precision;
      const f1Delta = aggregateAfter.f1 - aggregateBefore.f1;

      console.log("\n═══ Entity Context A/B Test Results ═══");
      console.log(`Without entity context:`);
      console.log(`  recall=${(aggregateBefore.recall * 100).toFixed(1)}%  fpr=${(aggregateBefore.fpr * 100).toFixed(1)}%  precision=${(aggregateBefore.precision * 100).toFixed(1)}%  f1=${(aggregateBefore.f1 * 100).toFixed(1)}%`);
      console.log(`  TP=${aggregateBefore.truePositives}  FP=${aggregateBefore.falsePositives}  FN=${aggregateBefore.falseNegatives}  TN=${aggregateBefore.trueNegatives}`);
      console.log(`With entity context:`);
      console.log(`  recall=${(aggregateAfter.recall * 100).toFixed(1)}%  fpr=${(aggregateAfter.fpr * 100).toFixed(1)}%  precision=${(aggregateAfter.precision * 100).toFixed(1)}%  f1=${(aggregateAfter.f1 * 100).toFixed(1)}%`);
      console.log(`  TP=${aggregateAfter.truePositives}  FP=${aggregateAfter.falsePositives}  FN=${aggregateAfter.falseNegatives}  TN=${aggregateAfter.trueNegatives}`);
      console.log(`Improvement:`);
      console.log(`  recallDelta=${(recallDelta * 100).toFixed(1)}%  fprDelta=${(fprDelta * 100).toFixed(1)}%  f1Delta=${(f1Delta * 100).toFixed(1)}%`);

      // Emit structured JSON metrics to stderr for programmatic comparison
      const model = process.env.P7_MODEL ?? "unknown";
      const result: AbTestResult = {
        test: "entity-ab-test",
        model,
        withoutEntity: aggregateBefore,
        withEntity: aggregateAfter,
        improvement: { recallDelta, fprDelta, precisionDelta, f1Delta },
        timestamp: new Date().toISOString(),
      };
      console.error(`[ab-metrics] ${JSON.stringify(result)}`);
    });
  });
}

/* ── Structural validation tests (always run, no LLM cost) ── */

describe("entity A/B fixture validation", () => {
  test("each fixture has valid structure", () => {
    for (const fixture of FIXTURES) {
      expect(fixture.id.length).toBeGreaterThan(0);
      expect(Object.keys(fixture.setupFiles).length).toBeGreaterThan(0);
      expect(fixture.diffStat.trim().length).toBeGreaterThan(0);
      expect(fixture.entityContext.trim().length).toBeGreaterThan(0);
      if (fixture.isNegative) {
        expect(fixture.expectedKeywords.length).toBe(0);
      } else {
        expect(fixture.expectedKeywords.length).toBeGreaterThan(0);
      }
    }
  });

  test("fixture ids are unique", () => {
    const ids = FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("covers positive and negative cases", () => {
    const positives = FIXTURES.filter((f) => !f.isNegative);
    const negatives = FIXTURES.filter((f) => f.isNegative);
    expect(positives.length).toBeGreaterThanOrEqual(3);
    expect(negatives.length).toBeGreaterThanOrEqual(1);
  });

  test("negative fixture diffStat contains no obvious bug patterns", () => {
    const negatives = FIXTURES.filter((f) => f.isNegative);
    for (const fixture of negatives) {
      // Should not contain patterns associated with security vulnerabilities
      const suspicious = /sql|password|secret|hardcoded|injection|xss|escape/i.test(
        fixture.diffStat,
      );
      expect(suspicious).toBe(false);
    }
  });

  test("each positive fixture has entity context with matching file paths", () => {
    const positives = FIXTURES.filter((f) => !f.isNegative);
    for (const fixture of positives) {
      // Entity context should reference a file that also appears in diffStat
      const diffFiles = fixture.diffStat.match(/^\s+src\/\S+/gm) ?? [];
      const entityFiles = fixture.entityContext.match(/src\/\S+/g) ?? [];
      const hasOverlap = entityFiles.some((ef) => diffFiles.some((df) => df.trim().startsWith(ef)));
      expect(hasOverlap).toBe(true);
    }
  });
});
