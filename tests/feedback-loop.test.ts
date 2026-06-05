/**
 * Integration tests for the critic self-improvement feedback loop.
 *
 * Deterministic tests for buildDynamicRules always run:
 *   1. Empty DB → returns null
 *   2. Single-plan findings → markdown format correctness
 *   3. Multi-plan cross-dimension → aggregation math (hit rates, severity breakdowns)
 *
 * LLM-dependent end-to-end test requires P7_RUN_FEEDBACK_LOOP_EVAL=true:
 *   - Seed synthetic historical findings
 *   - Call reviewDiff on an over-abstraction fixture
 *   - Verify structured findings contain the expected dimension
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildDynamicRules } from "../src/findings-stats.ts";
import { initDb, closeDb } from "../src/state.ts";
import { reviewDiff, parseFindings } from "../src/diff-critic.ts";
import type { DiffCriticFinding } from "../src/types.ts";

/* ── Helpers ─────────────────────────────────────────────────────── */

function seedFinding(
  projectPath: string,
  planId: string,
  findings: string | null,
  diffCriticFindings: string | null,
): void {
  const db = initDb(projectPath);
  db.run(
    `INSERT OR REPLACE INTO plan_states
     (plan_id, project_path, goal, title, status, created_at, updated_at, findings, diff_critic_findings)
     VALUES ($plan_id, $project_path, $goal, $title, $status, $created_at, $updated_at, $findings, $diff_critic_findings)`,
    {
      $plan_id: planId,
      $project_path: projectPath,
      $goal: "test-goal",
      $title: "Test Plan",
      $status: "approved",
      $created_at: "2026-06-01T00:00:00.000Z",
      $updated_at: "2026-06-01T00:00:00.000Z",
      $findings: findings,
      $diff_critic_findings: diffCriticFindings,
    },
  );
}

/* ── Synthetic finding text constants ───────────────────────────── */

const OVER_ABSTRACTION_1 =
  "- [warning] AI 生成代码特征-过度抽象: unnecessary class wrapping pure function\n";
const OVER_ABSTRACTION_2 =
  "- [info] AI 生成代码特征-过度抽象: single-method class has no state\n";
const TEMPLATE_REPEAT =
  "- [warning] AI 生成代码特征-模板重复: try-catch block repeated in 2 files\n";

const MULTI_PLAN_1 =
  "- [warning] AI 生成代码特征-过度抽象: excessive factory pattern\n" +
  "- [blocker] AI 生成代码特征-过度抽象: circular dependency from abstraction\n";
const MULTI_PLAN_2 =
  "- [warning] AI 生成代码特征-模板重复: try-catch block in 3 files\n" +
  "- [info] AI 生成代码特征-过度抽象: minor abstraction\n";
const MULTI_PLAN_3 =
  "- [blocker] AI 生成代码特征-不合理嵌套: 5-level nested ternary\n";

/* ── 1. buildDynamicRules: deterministic tests ──────────────────── */

describe("buildDynamicRules feedback loop", () => {
  test("empty DB returns null", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "p7-feedback-empty-"));
    try {
      const result = buildDynamicRules(tempDir);
      expect(result).toBeNull();
    } finally {
      closeDb(tempDir);
    }
  });

  test("single-plan markdown correctness", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "p7-feedback-single-"));
    try {
      seedFinding(
        tempDir,
        "plan-1",
        OVER_ABSTRACTION_1 + OVER_ABSTRACTION_2 + TEMPLATE_REPEAT,
        null,
      );
      const result = buildDynamicRules(tempDir);
      expect(result).not.toBeNull();

      // Summary line
      expect(result!).toContain("基于最近 1 条评审记录的统计分析（共 3 条发现，OK率 0%）");

      // Table header
      expect(result!).toContain("| 维度 | 出现率 | info | warning | blocker | blocker占比 |");
      expect(result!).toContain("|------|--------|------|---------|---------|------------|");

      // Dimension rows: sorted by total desc → 过度抽象 (2), 模板重复 (1)
      expect(result!).toContain("| 过度抽象 | 100% | 1 | 1 | 0 | 0% |");
      expect(result!).toContain("| 模板重复 | 100% | 0 | 1 | 0 | 0% |");

      // Patterns header
      expect(result!).toContain("高频模式（Top 5）：");

      // Each pattern appears in the output
      expect(result!).toContain(
        '[过度抽象] "unnecessary class wrapping pure function" — 出现 1 次（最高严重度: warning）',
      );
      expect(result!).toContain(
        '[过度抽象] "single-method class has no state" — 出现 1 次（最高严重度: info）',
      );
      expect(result!).toContain(
        '[模板重复] "try-catch block repeated in 2 files" — 出现 1 次（最高严重度: warning）',
      );
    } finally {
      closeDb(tempDir);
    }
  });

  test("multi-plan cross-dimension aggregation", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "p7-feedback-multi-"));
    try {
      seedFinding(tempDir, "plan-1", MULTI_PLAN_1, null);
      seedFinding(tempDir, "plan-2", null, MULTI_PLAN_2);
      seedFinding(tempDir, "plan-3", MULTI_PLAN_3, null);

      const result = buildDynamicRules(tempDir);
      expect(result).not.toBeNull();

      // Summary: 3 plans with findings, 5 total findings
      expect(result!).toContain("基于最近 3 条评审记录的统计分析（共 5 条发现，OK率 0%）");

      // 过度抽象: total=3, info=1, warning=1, blocker=1, hitRate=2/3≈67%, blockerRatio=1/3≈33%
      expect(result!).toContain("| 过度抽象 | 67% | 1 | 1 | 1 | 33% |");

      // 模板重复: total=1, hitRate=1/3≈33%
      expect(result!).toContain("| 模板重复 | 33% | 0 | 1 | 0 | 0% |");

      // 不合理嵌套: total=1, hitRate=1/3≈33%, blockerRatio=1/1=100%
      expect(result!).toContain("| 不合理嵌套 | 33% | 0 | 0 | 1 | 100% |");

      // Top patterns (frequency-sorted; all =1 so insertion order preserved)
      expect(result!).toContain(
        '[过度抽象] "excessive factory pattern" — 出现 1 次（最高严重度: warning）',
      );
      expect(result!).toContain(
        '[过度抽象] "circular dependency from abstraction" — 出现 1 次（最高严重度: blocker）',
      );
      expect(result!).toContain(
        '[模板重复] "try-catch block in 3 files" — 出现 1 次（最高严重度: warning）',
      );
      expect(result!).toContain(
        '[过度抽象] "minor abstraction" — 出现 1 次（最高严重度: info）',
      );
      expect(result!).toContain(
        '[不合理嵌套] "5-level nested ternary" — 出现 1 次（最高严重度: blocker）',
      );
    } finally {
      closeDb(tempDir);
    }
  });

  test("seed data does not leak between temp dirs", () => {
    // Verify that separate temp dirs produce independent DBs
    const dirA = mkdtempSync(join(tmpdir(), "p7-feedback-iso-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "p7-feedback-iso-b-"));
    try {
      seedFinding(dirA, "plan-a", OVER_ABSTRACTION_1, null);
      expect(buildDynamicRules(dirA)).not.toBeNull();
      expect(buildDynamicRules(dirB)).toBeNull();
    } finally {
      closeDb(dirA);
      closeDb(dirB);
    }
  });
});

/* ── 2. Over-abstraction fixture for env-gated e2e test ────────── */

/**
 * Diff adding a stateless class wrapper around a pure function.
 * Classic over-abstraction pattern: class with single method and no state.
 */
const OVER_ABSTRACTION_DIFF = [
  '--- a/src/user.ts',
  '+++ b/src/user.ts',
  '@@ -1,3 +1,25 @@',
  ' export function formatUserName(user: { first: string; last: string }): string {',
  '   return `${user.first} ${user.last}`;',
  ' }',
  '+',
  '+class UserNameFormatter {',
  '+  private user: { first: string; last: string };',
  '+  constructor(user: { first: string; last: string }) {',
  '+    this.user = user;',
  '+  }',
  '+  format(): string {',
  '+    return `${this.user.first} ${this.user.last}`;',
  '+  }',
  '+}',
  '+',
  '+export function processUser(user: { first: string; last: string }): string {',
  '+  const fmt = new UserNameFormatter(user);',
  '+  return fmt.format();',
  '+}',
].join("\n");

/** Synthetic historical findings emphasizing over-abstraction patterns. */
const SYNTHETIC_HISTORICAL_FINDINGS =
  "- [warning] AI 生成代码特征-过度抽象: unnecessary class wrapping pure function\n" +
  "- [blocker] AI 生成代码特征-过度抽象: abstract factory with single implementation\n" +
  "- [warning] AI 生成代码特征-模板重复: try-catch block repeated across 3 files\n";

/* ── 3. Env-gated end-to-end test ───────────────────────────────── */

const RUN_EVAL = process.env.P7_RUN_FEEDBACK_LOOP_EVAL === "true";

/**
 * Set P7_RUN_FEEDBACK_LOOP_EVAL=true to run the end-to-end test.
 * Seeds synthetic historical findings, then calls reviewDiff on an
 * over-abstraction fixture, verifying that structured findings
 * capture the over-abstraction dimension.
 */
if (RUN_EVAL) {
  describe("feedback loop e2e with reviewDiff", () => {
    const tempDirs = new Map<string, string>();

    beforeAll(() => {
      for (const id of ["e2e-over-abstraction"]) {
        const dir = mkdtempSync(join(tmpdir(), `p7-feedback-e2e-${id}-`));
        mkdirSync(join(dir, "src"), { recursive: true });

        // Write source file (existing code before the diff)
        writeFileSync(
          join(dir, "src/user.ts"),
          `export function formatUserName(user: { first: string; last: string }): string {
  return \`\${user.first} \${user.last}\`;
}
`,
          "utf-8",
        );

        // Seed synthetic historical findings into the plan_states DB
        seedFinding(dir, "history-1", SYNTHETIC_HISTORICAL_FINDINGS, null);

        tempDirs.set(id, dir);
      }
    });

    test("catches over-abstraction class wrapper in diff", async () => {
      const dir = tempDirs.get("e2e-over-abstraction")!;
      const planSummary = "Add UserNameFormatter class to format user names";

      const result = await reviewDiff(dir, OVER_ABSTRACTION_DIFF, planSummary);

      // reviewDiff should succeed and produce findings
      expect(result.structuredFindings.length).toBeGreaterThan(0);

      // At least one finding should reference over-abstraction or the class pattern
      const hasOverAbstraction = result.structuredFindings.some(
        (f: DiffCriticFinding) =>
          f.dimension.includes("过度抽象") ||
          f.message.toLowerCase().includes("unnecessary class") ||
          f.message.toLowerCase().includes("class wrapping") ||
          f.message.toLowerCase().includes("stateless class") ||
          f.message.toLowerCase().includes("user name formatter"),
      );
      expect(hasOverAbstraction).toBe(true);
    }, 120_000);
  });
} else {
  describe("feedback loop fixture structure", () => {
    test("over-abstraction fixture has valid diff format", () => {
      expect(OVER_ABSTRACTION_DIFF).toContain("--- a/");
      expect(OVER_ABSTRACTION_DIFF).toContain("+++ b/");
      expect(OVER_ABSTRACTION_DIFF).toContain("class UserNameFormatter");
      expect(OVER_ABSTRACTION_DIFF).toContain("export function processUser");
    });

    test("synthetic historical findings parse correctly", () => {
      const findings = parseFindings(SYNTHETIC_HISTORICAL_FINDINGS);
      expect(findings.length).toBe(3);
      const dims = findings.map((f: DiffCriticFinding) => f.dimension);
      expect(dims.filter((d: string) => d === "过度抽象").length).toBe(2);
      expect(dims.filter((d: string) => d === "模板重复").length).toBe(1);
    });
  });
}
