import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  closeDb,
  countPlanStatesByStatuses,
  countPlanStatesWithDelivery,
  countPlanStatesWithPr,
  dbPath,
  getPlanState,
  listPlanStates,
  listPlanStatesByStatuses,
  listPlanStatesWithDelivery,
  listPlanStatesWithPr,
  transitionPlanState,
  upsertPlanState,
  preparePlanExecuteRetry,
  updatePlanDiffCriticFindings,
} from "../src/state.ts";

function setupWithJsonState(): string {
  const root = join(tmpdir(), `p7-state-${Date.now()}`);
  const da = join(root, ".p7");
  mkdirSync(da, { recursive: true });
  writeFileSync(
    join(da, "state.json"),
    JSON.stringify([
      {
        planId: "legacy-1",
        projectPath: root,
        goal: "g1",
        title: "Legacy plan",
        status: "pr_opened",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        prUrl: "https://github.com/example/pr/1",
      },
    ]),
  );
  return root;
}

describe("PlanState SQLite", () => {
  test("migrates state.json into state.db on first access", () => {
    const root = setupWithJsonState();
    try {
      expect(existsSync(dbPath(root))).toBe(false);
      const s = getPlanState(root, "legacy-1");
      expect(s?.title).toBe("Legacy plan");
      expect(s?.prUrl).toContain("github.com");
      expect(existsSync(dbPath(root))).toBe(true);
      const still = getPlanState(root, "legacy-1");
      expect(still?.status).toBe("pr_opened");
    } finally {
      closeDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("upsert and list ordered by updated_at", () => {
    const root = join(tmpdir(), `p7-state-upsert-${Date.now()}`);
    try {
      upsertPlanState(root, {
        planId: "a",
        projectPath: root,
        goal: "g",
        title: "A",
        status: "planned",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      upsertPlanState(root, {
        planId: "b",
        projectPath: root,
        goal: "g",
        title: "B",
        status: "pending_approval",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      });
      const list = listPlanStates(root, 10);
      expect(list[0]?.planId).toBe("b");
      expect(list.length).toBe(2);
    } finally {
      closeDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lists plan states with PR using limit and offset", () => {
    const root = join(tmpdir(), `p7-state-pr-page-${Date.now()}`);
    try {
      for (let i = 1; i <= 3; i++) {
        upsertPlanState(root, {
          planId: `pr-${i}`,
          projectPath: root,
          goal: "g",
          title: `PR ${i}`,
          status: "pr_opened",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: `2026-01-0${i}T00:00:00.000Z`,
          prUrl: `https://github.com/example/pr/${i}`,
        });
      }
      upsertPlanState(root, {
        planId: "no-pr",
        projectPath: root,
        goal: "g",
        title: "No PR",
        status: "planned",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-04T00:00:00.000Z",
      });

      expect(countPlanStatesWithPr(root)).toBe(3);
      expect(listPlanStatesWithPr(root, 2).map((s) => s.planId)).toEqual(["pr-3", "pr-2"]);
      expect(listPlanStatesWithPr(root, 2, 2).map((s) => s.planId)).toEqual(["pr-1"]);
      expect(countPlanStatesWithDelivery(root)).toBe(3);
      expect(countPlanStatesByStatuses(root, ["pr_opened"])).toBe(3);
      expect(listPlanStatesByStatuses(root, ["pr_opened"], 1, 1).map((s) => s.planId)).toEqual([
        "pr-2",
      ]);
      expect(listPlanStatesWithDelivery(root, 2, 1).map((s) => s.planId)).toEqual([
        "pr-2",
        "pr-1",
      ]);
    } finally {
      closeDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("transitionPlanState updates atomically", () => {
    const root = join(tmpdir(), `p7-state-tx-${Date.now()}`);
    try {
      upsertPlanState(root, {
        planId: "tx-1",
        projectPath: root,
        goal: "g",
        title: "T",
        status: "approved",
        createdAt: new Date().toISOString(),
      });
      const next = transitionPlanState(root, "tx-1", "executing", {
        branch: "p7/tx-1",
      });
      expect(next?.status).toBe("executing");
      expect(next?.branch).toBe("p7/tx-1");
      expect(getPlanState(root, "tx-1")?.status).toBe("executing");
    } finally {
      closeDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preparePlanExecuteRetry clears error and restores approved", () => {
    const root = join(tmpdir(), `p7-state-retry-${Date.now()}`);
    try {
      upsertPlanState(root, {
        planId: "fail-1",
        projectPath: root,
        goal: "g",
        title: "F",
        status: "failed",
        createdAt: new Date().toISOString(),
        error: "nothing to commit",
      });
      const ok = preparePlanExecuteRetry(root, "fail-1");
      expect(ok?.status).toBe("approved");
      expect(ok?.error).toBeUndefined();
      expect(getPlanState(root, "fail-1")?.error).toBeUndefined();
      expect(preparePlanExecuteRetry(root, "fail-1")).toBeNull();
    } finally {
      closeDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("updatePlanDiffCriticFindings writes diff_critic_findings column", () => {
    const root = join(tmpdir(), `p7-state-dc-${Date.now()}`);
    try {
      upsertPlanState(root, {
        planId: "dc-1",
        projectPath: root,
        goal: "g",
        title: "DC",
        status: "executing",
        createdAt: new Date().toISOString(),
      });
      updatePlanDiffCriticFindings(root, "dc-1", "FINDINGS:\n- [blocker] test\nOK: false");
      const s = getPlanState(root, "dc-1");
      expect(s?.diffCriticFindings).toContain("[blocker]");
      expect(s?.findings).toBeUndefined();
    } finally {
      closeDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists accountResults as JSON", () => {
    const root = join(tmpdir(), `p7-state-acc-${Date.now()}`);
    try {
      upsertPlanState(root, {
        planId: "acc-1",
        projectPath: root,
        goal: "g",
        title: "Acc",
        status: "pushed",
        createdAt: new Date().toISOString(),
        accountResults: [{ accountId: "main", ok: true, prUrl: "https://x/pr/1" }],
      });
      const s = getPlanState(root, "acc-1");
      expect(s?.accountResults?.[0]?.accountId).toBe("main");
    } finally {
      closeDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
