import {
  canSchedulerRetryFailedPlan,
  FAILED_RETRY_COOLDOWN_MS,
  listApprovedForExecution,
  MAX_FAILED_EXECUTE_PER_PLAN,
} from "../src/approval.ts";
import { getPlanState } from "../src/state.ts";
import { listJobsForProject } from "./queue/store.ts";
import type { JobRow } from "./queue/types.ts";

export type ProjectActivity = {
  /** 当前 running / pending 任务 */
  activeJob: JobRow | null;
  /** failed 但仍 approved、等待调度器重试 */
  failedPlan: {
    planId: string;
    title: string;
    error: string;
    canRetryNow: boolean;
    retryAtMs: number | null;
    attemptsUsed: number;
    maxAttempts: number;
  } | null;
  schedulerEnabled: boolean;
  schedulerIntervalMinutes: number;
};

export const FAILED_EXECUTE_MAX_ATTEMPTS = MAX_FAILED_EXECUTE_PER_PLAN;

function parsePlanId(payload: string): string | undefined {
  try {
    return (JSON.parse(payload) as { planId?: string }).planId;
  } catch {
    return undefined;
  }
}

function countFailedExecuteJobsForPlan(projectAlias: string, planId: string): number {
  return listJobsForProject(projectAlias, 100).filter((j) => {
    if (j.kind !== "execute" || j.status !== "failed") return false;
    return parsePlanId(j.payload) === planId;
  }).length;
}

export function getProjectActivity(
  projectAlias: string,
  projectPath: string,
  schedulerEnabled: boolean,
  schedulerIntervalMinutes = 2,
): ProjectActivity {
  const jobs = listJobsForProject(projectAlias, 40);
  const activeJob =
    jobs.find((j) => j.status === "running") ??
    jobs.find((j) => j.status === "pending") ??
    null;

  let failedPlan: ProjectActivity["failedPlan"] = null;
  for (const rec of listApprovedForExecution(projectPath)) {
    const state = getPlanState(projectPath, rec.planId);
    if (!state || state.status !== "failed") continue;
    const attemptsUsed = countFailedExecuteJobsForPlan(projectAlias, rec.planId);
    const canRetryNow = canSchedulerRetryFailedPlan(projectAlias, rec.planId, state);
    const retryAtMs = canRetryNow
      ? null
      : new Date(state.updatedAt).getTime() + FAILED_RETRY_COOLDOWN_MS;
    failedPlan = {
      planId: rec.planId,
      title: state.title ?? rec.plan.title,
      error: state.error ?? "执行失败",
      canRetryNow,
      retryAtMs,
      attemptsUsed,
      maxAttempts: FAILED_EXECUTE_MAX_ATTEMPTS,
    };
    break;
  }

  return { activeJob, failedPlan, schedulerEnabled, schedulerIntervalMinutes };
}
