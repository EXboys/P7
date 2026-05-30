import { getApprovalRecord } from "./approval.ts";
import { loadPlanRecord } from "./planner.ts";
import { getPlanState } from "./state.ts";
import type { Plan, PlanState } from "./types.ts";

export type PlanDetailView = {
  planId: string;
  goal: string;
  status: string;
  plan: Plan | null;
  state: PlanState | null;
  canApprove: boolean;
};

export function getPlanDetailView(projectPath: string, planId: string): PlanDetailView | null {
  const approval = getApprovalRecord(projectPath, planId);
  const state = getPlanState(projectPath, planId);

  if (approval) {
    return {
      planId,
      goal: approval.goal,
      status: approval.status,
      plan: approval.plan,
      state,
      canApprove: approval.status === "pending",
    };
  }

  const record = loadPlanRecord(projectPath, planId);
  if (record) {
    return {
      planId,
      goal: record.goal,
      status: state?.status ?? "pending_approval",
      plan: record.plan,
      state,
      canApprove: state?.status === "pending_approval",
    };
  }

  if (state) {
    return {
      planId,
      goal: state.goal,
      status: state.status,
      plan: null,
      state,
      canApprove: state.status === "pending_approval",
    };
  }

  return null;
}
