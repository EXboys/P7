import {
  canSchedulerRetryFailedPlan,
  isExecuteRetryExhausted,
  listApprovedForExecution,
  MAX_FAILED_EXECUTE_PER_PLAN,
  sweepStuckApprovedPlans,
} from "../src/approval.ts";
import { runPipelinePreflight } from "../src/pipeline-preflight.ts";
import { detectPipelineStall } from "../src/pipeline-stall.ts";
import { loadConfig } from "../src/config.ts";
import { getPlanState, listPlanStatesByStatuses, transitionPlanState } from "../src/state.ts";
import { planDisplayTitle } from "../src/plan-i18n.ts";
import { listJobsForProject } from "./queue/store.ts";
import type { JobRow } from "./queue/types.ts";

export type OverviewFailureKind = "plan" | "job";

export type OverviewFailureAction = "retry_execute" | "retry_discover" | "view_job" | "view_plan" | "reject";

export type OverviewFailureRow = {
  kind: OverviewFailureKind;
  id: string;
  title: string;
  error: string;
  updatedAt: string;
  /** 是否建议在解决阻塞项后重试 */
  retryable: boolean;
  retryHint: string;
  actions: OverviewFailureAction[];
  planId?: string;
};

export type OverviewStabilityPass = {
  reconciled: string[];
  abandoned: string[];
  failures: OverviewFailureRow[];
  preflightBlocking: boolean;
};

function parsePlanId(payload: string): string | undefined {
  try {
    return (JSON.parse(payload) as { planId?: string }).planId;
  } catch {
    return undefined;
  }
}

function hasActiveExecuteForPlan(alias: string, planId: string): boolean {
  return listJobsForProject(alias, 30).some((j) => {
    if (j.kind !== "execute" || (j.status !== "pending" && j.status !== "running")) return false;
    return parsePlanId(j.payload) === planId;
  });
}

/** 无活动 execute job 却仍为 executing → 标 failed，避免 overview 假「进行中」 */
export function reconcilePhantomExecuting(
  projectPath: string,
  projectAlias: string,
): string[] {
  const fixed: string[] = [];
  for (const s of listPlanStatesByStatuses(projectPath, ["executing"], 50)) {
    if (hasActiveExecuteForPlan(projectAlias, s.planId)) continue;
    transitionPlanState(projectPath, s.planId, "failed", {
      error: "执行已中断（队列无活动 job），可在工作台重试",
    });
    fixed.push(s.planId);
  }
  return fixed;
}

function classifyRetryHint(error: string): { retryable: boolean; hint: string } {
  const e = error.toLowerCase();
  if (/api domain|allowed list|no_llm|llm|auth token|preflight/i.test(e)) {
    return { retryable: false, hint: "先修环境检查 / API 白名单 / LLM Key" };
  }
  if (/open pr|冲突|conflicting/i.test(e)) {
    return { retryable: false, hint: "先处理 OPEN PR（复查页）" };
  }
  if (/max_pending|queue depth/i.test(e)) {
    return { retryable: false, hint: "先审批或清理积压 Plan" };
  }
  if (/exit 143|connection refused|timeout|econnreset|rate limit/i.test(e)) {
    return { retryable: true, hint: "多为瞬时故障，可重试" };
  }
  return { retryable: true, hint: "可尝试重试；多次失败请查看任务日志" };
}

function jobTitle(job: JobRow): string {
  if (job.kind === "execute") {
    const planId = parsePlanId(job.payload);
    return planId ? `执行 Plan ${planId}` : "执行 Plan";
  }
  try {
    const p = JSON.parse(job.payload) as { recoverStall?: boolean };
    if (p.recoverStall) return "管道恢复（生成 Plan）";
  } catch {
    /* ignore */
  }
  return job.kind;
}

function collectFailedJobs(alias: string, limit = 6): OverviewFailureRow[] {
  const rows: OverviewFailureRow[] = [];
  for (const job of listJobsForProject(alias, 40)) {
    if (job.status !== "failed") continue;
    const err = job.error?.trim() || "未知错误";
    const { retryable, hint } = classifyRetryHint(err);
    const actions: OverviewFailureAction[] = ["view_job"];
    if (job.kind === "discover-daily" || job.kind === "daily") {
      if (retryable) actions.unshift("retry_discover");
    }
    rows.push({
      kind: "job",
      id: job.id,
      title: jobTitle(job),
      error: err.slice(0, 280),
      updatedAt: job.finished_at ?? job.created_at,
      retryable,
      retryHint: hint,
      actions,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

function collectFailedPlans(projectPath: string, alias: string): OverviewFailureRow[] {
  const rows: OverviewFailureRow[] = [];
  for (const s of listPlanStatesByStatuses(projectPath, ["failed"], 12)) {
    const err = s.error?.trim() || "执行失败";
    const { retryable, hint } = classifyRetryHint(err);
    const approval = listApprovedForExecution(projectPath).some((r) => r.planId === s.planId);
    const exhausted = isExecuteRetryExhausted(alias, s.planId, s);
    const canAuto = approval && canSchedulerRetryFailedPlan(alias, s.planId, s);
    const actions: OverviewFailureAction[] = ["view_plan"];
    if (approval && !exhausted) actions.unshift("retry_execute");
    if (exhausted) actions.push("reject");
    rows.push({
      kind: "plan",
      id: s.planId,
      planId: s.planId,
      title: s.title ?? s.planId,
      error: err.slice(0, 280),
      updatedAt: s.updatedAt,
      retryable: retryable && canAuto,
      retryHint: exhausted
        ? `已自动重试 ${MAX_FAILED_EXECUTE_PER_PLAN} 次，请手动重试或放弃`
        : approval
          ? hint
          : "非 approved 状态，请到 Plan 详情处理",
      actions,
    });
  }
  return rows;
}

/** 打开 overview 时跑一次：清扫僵尸状态 + 汇总 failed */
export function runOverviewStabilityPass(
  projectPath: string,
  projectAlias: string,
): OverviewStabilityPass {
  const reconciled: string[] = [];
  reconciled.push(...reconcilePhantomExecuting(projectPath, projectAlias));

  const abandoned = sweepStuckApprovedPlans(projectPath, projectAlias);

  const pre = runPipelinePreflight(projectPath);
  const failures = [...collectFailedPlans(projectPath, projectAlias), ...collectFailedJobs(projectAlias)];
  failures.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    reconciled,
    abandoned,
    failures: failures.slice(0, 10),
    preflightBlocking: !pre.ok,
  };
}

export function shouldRecoverStallOnDiscoverRetry(projectPath: string, alias: string): boolean {
  try {
    const dc = loadConfig(projectPath);
    return detectPipelineStall(projectPath, dc, alias) != null;
  } catch {
    return false;
  }
}
