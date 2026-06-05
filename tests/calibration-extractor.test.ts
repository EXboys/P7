import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initDb, closeDb } from "../src/state.ts";
import { extractCalibrationDataset, serializeCalibrationDataset } from "../src/calibration-extractor.ts";

/* ── Helpers ── */

const projectPath = join(tmpdir(), `p7-calibration-${Date.now()}`);

function insertState(
  db: Database,
  planId: string,
  status: string,
  diffCriticFindings: string | null,
): void {
  db.query(
    `INSERT OR IGNORE INTO plan_states
       (plan_id, project_path, goal, title, status, created_at, updated_at, diff_critic_findings)
     VALUES ($plan_id, $project_path, $goal, $title, $status, $created_at, $updated_at, $diff_critic_findings)`,
  ).run({
    $plan_id: planId,
    $project_path: projectPath,
    $goal: "calibration-test",
    $title: planId,
    $status: status,
    $created_at: "2026-06-01T00:00:00.000Z",
    $updated_at: "2026-06-01T12:00:00.000Z",
    $diff_critic_findings: diffCriticFindings,
  });
}

function findingBlock(severity: string, dimension: string, message: string): string {
  return `- [${severity}] AI 生成代码特征-${dimension}: ${message}`;
}

afterAll(() => {
  closeDb(projectPath);
  rmSync(projectPath, { recursive: true, force: true });
});

describe("calibration-extractor", () => {
  test("empty DB returns zero counts and empty samples", () => {
    const db = initDb(projectPath);
    const result = extractCalibrationDataset(db);
    expect(result.samples).toEqual([]);
    expect(result.labelCounts.truePositive).toBe(0);
    expect(result.labelCounts.falsePositive).toBe(0);
    expect(result.labelCounts.unlabeled).toBe(0);
    expect(result.generatedAt).toBeTruthy();
  });

  test("full calibration dataset extraction with all label heuristics", () => {
    const db = initDb(projectPath);

    // Records with null / empty findings — must be skipped
    insertState(db, "null-findings", "failed", null);
    insertState(db, "empty-findings", "failed", "");

    // Blocker + merged/pushed → FP
    insertState(
      db,
      "plan-merged",
      "merged",
      findingBlock("blocker", "漏洞发现", "SQL injection [CWE-89] [confidence:0.95]"),
    );
    insertState(
      db,
      "plan-pushed",
      "pushed",
      findingBlock("blocker", "漏洞发现", "XSS [CWE-79] [confidence:0.85]"),
    );

    // Blocker + failed → TP
    insertState(
      db,
      "plan-failed",
      "failed",
      findingBlock("blocker", "漏洞发现", "Command injection [CWE-77] [confidence:0.90]"),
    );

    // Non-blocker → always unlabeled regardless of status
    insertState(db, "info-merged", "merged", findingBlock("info", "过度抽象", "Minor concern"));
    insertState(db, "warning-failed", "failed", findingBlock("warning", "模板重复", "Style issue"));

    // Blocker + non-terminal status (approved/rejected) → unlabeled
    insertState(db, "plan-approved", "approved", findingBlock("blocker", "幻觉检测", "Unverified"));
    insertState(db, "plan-rejected", "rejected", findingBlock("blocker", "安全越狱", "Suspicious"));

    // Mixed findings in one plan
    const mixedText = [
      findingBlock("blocker", "漏洞发现", "True vulnerability"),
      findingBlock("warning", "过度抽象", "Style note"),
    ].join("\n");
    insertState(db, "plan-mixed", "failed", mixedText);

    const result = extractCalibrationDataset(db);

    // 2 null/empty records skipped → 8 samples expected
    expect(result.samples).toHaveLength(8);

    // ── Label counts ──
    // FP: plan-merged (1 blocker), plan-pushed (1 blocker) = 2
    // TP: plan-failed (1 blocker), plan-mixed blocker (1) = 2
    // Unlabeled: info-merged (1), warning-failed (1),
    //            plan-approved (1), plan-rejected (1),
    //            plan-mixed warning (1) = 5
    expect(result.labelCounts.falsePositive).toBe(2);
    expect(result.labelCounts.truePositive).toBe(2);
    expect(result.labelCounts.unlabeled).toBe(5);

    // ── Per-sample label verification ──
    for (const sample of result.samples) {
      for (const lbl of sample.labels) {
        if (sample.planId === "plan-failed") {
          expect(lbl.label).toBe("tp");
        } else if (sample.planId === "plan-merged" || sample.planId === "plan-pushed") {
          expect(lbl.label).toBe("fp");
        } else if (sample.planId === "plan-mixed") {
          // blocker→tp, warning→unlabeled
          if (lbl.finding.severity === "blocker") expect(lbl.label).toBe("tp");
          else expect(lbl.label).toBe("unlabeled");
        } else {
          expect(lbl.label).toBe("unlabeled");
        }
        expect(lbl.planId).toBe(sample.planId);
        expect(lbl.planStatus).toBe(sample.status);
        expect(lbl.finding.dimension).toBeTruthy();
      }
    }
  });

  test("serializeCalibrationDataset produces valid JSON with all expected keys", () => {
    const db = initDb(projectPath);
    const dataset = extractCalibrationDataset(db);
    const json = serializeCalibrationDataset(dataset);
    const parsed = JSON.parse(json);
    expect(parsed.samples).toBeDefined();
    expect(Array.isArray(parsed.samples)).toBe(true);
    expect(parsed.labelCounts).toBeDefined();
    expect(typeof parsed.labelCounts.truePositive).toBe("number");
    expect(typeof parsed.labelCounts.falsePositive).toBe("number");
    expect(typeof parsed.labelCounts.unlabeled).toBe("number");
    expect(parsed.generatedAt).toBeDefined();

    if (parsed.samples.length > 0) {
      const sample = parsed.samples[0];
      expect(sample.planId).toBeDefined();
      expect(sample.status).toBeDefined();
      expect(sample.totalFindings).toBeDefined();
      expect(Array.isArray(sample.labels)).toBe(true);
      if (sample.labels.length > 0) {
        const lbl = sample.labels[0];
        expect(lbl.planId).toBeDefined();
        expect(lbl.label).toBeDefined();
        expect(lbl.planStatus).toBeDefined();
        expect(lbl.finding).toBeDefined();
        expect(lbl.finding.severity).toBeDefined();
        expect(lbl.finding.dimension).toBeDefined();
        expect(lbl.finding.message).toBeDefined();
      }
    }
  });
});
