import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  abandonStuckApprovedPlan,
  decideApproval,
  getApprovalRecord,
  listApprovedForExecution,
  processAutoApprovals,
  savePendingApproval,
  sweepStuckApprovedPlans,
} from "../src/approval.ts";
import { planGoalMatchesRoadmapDone } from "../src/roadmap.ts";
import type { PlanRecord } from "../src/types.ts";
import { getPlanState, upsertPlanState } from "../src/state.ts";

function setupProject(roadmap: string): string {
  const root = join(tmpdir(), `p7-stuck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const da = join(root, ".p7");
  mkdirSync(join(da, "approvals"), { recursive: true });
  mkdirSync(join(da, "plans"), { recursive: true });
  writeFileSync(join(root, "ROADMAP.md"), roadmap);
  return root;
}

const samplePlan: PlanRecord = {
  planId: "stuck-1",
  projectPath: "",
  goal: "分析 executor pipeline 各环节的背压缺口——识别无界队列、无限重试、同步阻塞等反压缺失点",
  createdAt: "2026-06-01T00:00:00.000Z",
  plan: {
    title: "Analyze executor pipeline backpressure gaps",
    title_zh: "分析 executor pipeline 各环节背压缺口并输出文档",
    motivation: "Document gaps.",
    changes: [{ file: "docs/backpressure-analysis.md", description: "Add doc", estimated_lines: 100 }],
    risks: ["Large doc"],
    validation: "true",
    estimated_diff_lines: 100,
  },
};

function testConfig() {
  return {
    auto_approve: { enabled: true, diff_lines_max: 300, files_max: 5, risks_max: 5 },
    diff_critic: { max_files_ceiling: 5, max_diff_ceiling: 300 },
    max_pending_plans: 5,
  } as never;
}

describe("stuck approved plans", () => {
  test("planGoalMatchesRoadmapDone matches completed roadmap entries", () => {
    const root = setupProject(`# Roadmap
## Active
- [ ] Next task

## Done
- 分析 executor pipeline 各环节的背压缺口——识别无界队列、无限重试、同步阻塞等 10 个反压缺失点
`);
    try {
      samplePlan.projectPath = root;
      expect(
        planGoalMatchesRoadmapDone(root, samplePlan.goal, samplePlan.plan.title_zh),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sweep rejects approved plan when goal already in ROADMAP Done", () => {
    const root = setupProject(`# Roadmap
## Active
- [ ] Next task

## Done
- 分析 executor pipeline 各环节的背压缺口——识别无界队列、无限重试、同步阻塞等反压缺失点
`);
    try {
      samplePlan.projectPath = root;
      savePendingApproval(root, samplePlan);
      decideApproval(root, samplePlan.planId, "approved", "test");
      upsertPlanState(root, {
        planId: samplePlan.planId,
        projectPath: root,
        goal: samplePlan.goal,
        title: samplePlan.plan.title_zh!,
        status: "failed",
        createdAt: samplePlan.createdAt,
        error: "executor produced no file changes",
      });

      const reasons = sweepStuckApprovedPlans(root);
      expect(reasons).toEqual(["roadmap-already-done"]);
      expect(listApprovedForExecution(root)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("abandonStuckApprovedPlan rejects failed plan not aligned with active roadmap", () => {
    const root = setupProject(`# Roadmap
## Active
- [ ] Unrelated active task for current sprint

## Done
- Something else entirely unrelated to this plan goal text here
`);
    try {
      samplePlan.projectPath = root;
      samplePlan.goal = "Implement unrelated feature xyz";
      savePendingApproval(root, samplePlan);
      decideApproval(root, samplePlan.planId, "approved", "test");
      upsertPlanState(root, {
        planId: samplePlan.planId,
        projectPath: root,
        goal: samplePlan.goal,
        title: "Unrelated",
        status: "failed",
        createdAt: samplePlan.createdAt,
        error: "boom",
      });

      const reason = abandonStuckApprovedPlan(root, samplePlan.planId, {
        projectAlias: "demo",
        goal: samplePlan.goal,
      });
      expect(reason).toBe("stale-roadmap-goal");
      expect(listApprovedForExecution(root)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("abandon delivered approved plan preserves delivered plan state", () => {
    const root = setupProject(`# Roadmap
## Active
- [x] Shipped task

## Done
`);
    try {
      samplePlan.projectPath = root;
      samplePlan.goal = "Shipped task";
      savePendingApproval(root, samplePlan);
      decideApproval(root, samplePlan.planId, "approved", "test");
      upsertPlanState(root, {
        planId: samplePlan.planId,
        projectPath: root,
        goal: samplePlan.goal,
        title: "Shipped",
        status: "pr_opened",
        createdAt: samplePlan.createdAt,
        prUrl: "https://github.com/example/pr/123",
        mergeStatus: "merged",
      });

      const reason = abandonStuckApprovedPlan(root, samplePlan.planId, {
        projectAlias: "demo",
        goal: samplePlan.goal,
      });
      expect(reason).toBe("plan-already-delivered");
      expect(getApprovalRecord(root, samplePlan.planId)?.status).toBe("rejected");
      expect(getApprovalRecord(root, samplePlan.planId)?.decidedBy).toBe("plan-already-delivered");
      expect(getPlanState(root, samplePlan.planId)?.status).toBe("pr_opened");
      expect(getPlanState(root, samplePlan.planId)?.mergeStatus).toBe("merged");
      expect(listApprovedForExecution(root)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("auto approval does not count its own pending candidates as queue backlog", () => {
    const root = setupProject(`# Roadmap
## Active
- [ ] Next task

## Done
`);
    try {
      const ids = ["split-1", "split-2", "split-3", "split-4"];
      for (const planId of ids) {
        savePendingApproval(root, {
          ...samplePlan,
          planId,
          projectPath: root,
          goal: "Next task",
          plan: {
            ...samplePlan.plan,
            title: `Split ${planId}`,
            changes: [{ file: `${planId}.ts`, description: "d", estimated_lines: 10 }],
            risks: ["small"],
            estimated_diff_lines: 10,
          },
        });
      }

      const batch = processAutoApprovals(root, testConfig(), { planIds: ids });
      expect(batch.skipped).toHaveLength(0);
      expect(new Set(batch.approved)).toEqual(new Set(ids));
      expect(new Set(listApprovedForExecution(root).map((p) => p.planId))).toEqual(new Set(ids));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
