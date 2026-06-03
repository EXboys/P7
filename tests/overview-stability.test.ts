import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { reconcilePhantomExecuting } from "../server/overview-stability.ts";
import { getPlanState, upsertPlanState } from "../src/state.ts";
import { enqueueJob } from "../server/queue/store.ts";

describe("reconcilePhantomExecuting", () => {
  test("marks executing as failed when no active execute job", () => {
    const root = mkdtempSync(join(tmpdir(), "p7-overview-"));
    const alias = `ov-${Date.now()}`;
    try {
      upsertPlanState(root, {
        planId: "phantom-1",
        projectPath: root,
        goal: "g",
        title: "t",
        status: "executing",
        createdAt: new Date().toISOString(),
      });
      const fixed = reconcilePhantomExecuting(root, alias);
      expect(fixed).toEqual(["phantom-1"]);
      const st = getPlanState(root, "phantom-1");
      expect(st?.status).toBe("failed");
      expect(st?.error).toContain("无活动");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves executing when execute job is running", () => {
    const root = mkdtempSync(join(tmpdir(), "p7-overview-"));
    const alias = `ov-run-${Date.now()}`;
    try {
      upsertPlanState(root, {
        planId: "live-1",
        projectPath: root,
        goal: "g",
        title: "t",
        status: "executing",
        createdAt: new Date().toISOString(),
      });
      enqueueJob({
        kind: "execute",
        projectAlias: alias,
        payload: { projectPath: root, planId: "live-1" },
      });
      const fixed = reconcilePhantomExecuting(root, alias);
      expect(fixed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
