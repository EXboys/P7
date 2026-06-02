import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getPlanDetailView } from "../src/plan-detail.ts";

function setupProject(): string {
  const root = join(tmpdir(), `p7-test-${Date.now()}`);
  const da = join(root, ".p7");
  mkdirSync(join(da, "approvals"), { recursive: true });
  mkdirSync(join(da, "plans"), { recursive: true });
  writeFileSync(
    join(da, "state.json"),
    JSON.stringify([
      {
        planId: "state-only-1",
        projectPath: root,
        goal: "from state",
        title: "State title",
        status: "pr_opened",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        prUrl: "https://github.com/example/pr/1",
      },
    ]),
  );
  writeFileSync(
    join(da, "approvals", "pending-1.json"),
    JSON.stringify({
      planId: "pending-1",
      projectPath: root,
      status: "pending",
      goal: "g",
      createdAt: "2026-01-01T00:00:00.000Z",
      plan: {
        title: "Pending plan",
        motivation: "m",
        changes: [{ file: "a.ts", description: "d", estimated_lines: 10 }],
        risks: [],
        validation: "tsc",
        estimated_diff_lines: 10,
      },
    }),
  );
  return root;
}

describe("getPlanDetailView", () => {
  test("loads pending approval with plan body", () => {
    const root = setupProject();
    try {
      const v = getPlanDetailView(root, "pending-1");
      expect(v?.planId).toBe("pending-1");
      expect(v?.canApprove).toBe(true);
      expect(v?.plan?.title).toBe("Pending plan");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads state-only plan without approval file", () => {
    const root = setupProject();
    try {
      const v = getPlanDetailView(root, "state-only-1");
      expect(v?.status).toBe("pr_opened");
      expect(v?.plan).toBeNull();
      expect(v?.state?.prUrl).toContain("github.com");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canRetryExecute when failed without pr", () => {
    const root = setupProject();
    const da = join(root, ".p7");
    writeFileSync(
      join(da, "state.json"),
      JSON.stringify([
        {
          planId: "failed-1",
          projectPath: root,
          goal: "g",
          title: "Failed",
          status: "failed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          error: "commit failed",
        },
      ]),
    );
    try {
      const v = getPlanDetailView(root, "failed-1");
      expect(v?.canRetryExecute).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("shows delivered rejected approval as merged", () => {
    const root = setupProject();
    const da = join(root, ".p7");
    writeFileSync(
      join(da, "approvals", "delivered-1.json"),
      JSON.stringify({
        planId: "delivered-1",
        projectPath: root,
        status: "rejected",
        goal: "g",
        createdAt: "2026-01-01T00:00:00.000Z",
        decidedAt: "2026-01-02T00:00:00.000Z",
        decidedBy: "plan-already-delivered",
        plan: {
          title: "Delivered plan",
          motivation: "m",
          changes: [{ file: "a.ts", description: "d", estimated_lines: 10 }],
          risks: [],
          validation: "tsc",
          estimated_diff_lines: 10,
        },
      }),
    );
    writeFileSync(
      join(da, "state.json"),
      JSON.stringify([
        {
          planId: "delivered-1",
          projectPath: root,
          goal: "g",
          title: "Delivered plan",
          status: "rejected",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          prUrl: "https://github.com/example/pr/2",
          mergeStatus: "merged",
        },
      ]),
    );
    try {
      const v = getPlanDetailView(root, "delivered-1");
      expect(v?.status).toBe("merged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null for unknown id", () => {
    const root = setupProject();
    try {
      expect(getPlanDetailView(root, "missing")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
