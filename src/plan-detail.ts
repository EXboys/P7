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
  /** 执行失败且尚无 PR 时可从控制台重试 */
  canRetryExecute: boolean;
};

function canRetryExecuteFor(state: PlanState | null): boolean {
  if (!state || state.status !== "failed") return false;
  if (state.prUrl) return false;
  return true;
}

export function getPlanDetailView(projectPath: string, planId: string): PlanDetailView | null {
  const approval = getApprovalRecord(projectPath, planId);
  const state = getPlanState(projectPath, planId);
  const retry = canRetryExecuteFor(state);

  if (approval) {
    return {
      planId,
      goal: approval.goal,
      status: approval.status,
      plan: approval.plan,
      state,
      canApprove: approval.status === "pending",
      canRetryExecute: retry,
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
      canRetryExecute: retry,
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
      canRetryExecute: retry,
    };
  }

  return null;
}
