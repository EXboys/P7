import { getApprovalRecord } from "./approval.ts";
import { loadPlanRecord } from "./planner.ts";
import { getPlanState } from "./state.ts";
import type { ApprovalRecord, Plan, PlanState } from "./types.ts";

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

function deliveredStatus(state: PlanState | null): string | null {
  if (!state) return null;
  if (state.mergeStatus === "merged") return "merged";
  if (state.status === "merged" || state.status === "pr_opened" || state.status === "pushed") {
    return state.status;
  }
  return null;
}

/** 已交付 Plan 的 approval 会被 sweep 标为 rejected，展示应跟随 PlanState。 */
function resolveApprovalDisplayStatus(approval: ApprovalRecord, state: PlanState | null): string {
  const delivered = deliveredStatus(state);
  if (delivered) return delivered;
  if (
    approval.status === "rejected" &&
    (approval.decidedBy === "plan-already-delivered" || approval.decidedBy === "roadmap-already-done")
  ) {
    return state?.status ?? "merged";
  }
  if (state?.status && state.status !== "pending_approval") return state.status;
  return approval.status;
}

export function getPlanDetailView(projectPath: string, planId: string): PlanDetailView | null {
  const approval = getApprovalRecord(projectPath, planId);
  const state = getPlanState(projectPath, planId);
  const retry = canRetryExecuteFor(state);

  if (approval) {
    return {
      planId,
      goal: approval.goal,
      status: resolveApprovalDisplayStatus(approval, state),
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
