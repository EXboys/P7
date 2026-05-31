import { describe, expect, test } from "bun:test";
import { canSchedulerRetryFailedPlan } from "../src/approval.ts";
import type { PlanState } from "../src/types.ts";

describe("canSchedulerRetryFailedPlan", () => {
  test("allows retry after cooldown", () => {
    const state: PlanState = {
      planId: "p1",
      projectPath: "/tmp",
      goal: "g",
      title: "t",
      status: "failed",
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      error: "boom",
    };
    expect(canSchedulerRetryFailedPlan(undefined, "p1", state)).toBe(true);
  });

  test("blocks retry during cooldown", () => {
    const state: PlanState = {
      planId: "p1",
      projectPath: "/tmp",
      goal: "g",
      title: "t",
      status: "failed",
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: new Date(Date.now() - 30 * 1000).toISOString(),
      error: "boom",
    };
    expect(canSchedulerRetryFailedPlan(undefined, "p1", state)).toBe(false);
  });
});
