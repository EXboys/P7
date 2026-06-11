import { getApprovalRecord } from "../approval.ts";
import { loadConfig } from "../config.ts";
import { executePlan, loadLatestPlan } from "../executor.ts";
import { scanProject } from "../scanner.ts";
import type { ExecutionResult } from "../types.ts";

export async function executeApprovedPlanUseCase(
  projectPath: string,
  opts: {
    planId?: string;
    force?: boolean;
    jobId?: string;
    projectAlias?: string;
    dashboardBaseUrl?: string;
    signal?: AbortSignal;
    onPhase?: (phase: string) => void;
  } = {},
): Promise<ExecutionResult> {
  opts.onPhase?.("加载 Plan 与扫描项目");
  if (opts.signal?.aborted) {
    throw new Error("任务超时被终止");
  }
  const cfg = loadConfig(projectPath);
  const scan = await scanProject(projectPath);
  const approval = opts.planId ? getApprovalRecord(projectPath, opts.planId) : null;
  if (opts.planId && approval?.status !== "approved" && !opts.force) {
    throw new Error(`Plan ${opts.planId} is not approved; pass --force to execute anyway`);
  }
  const loaded = approval
    ? { ...approval.plan, planId: approval.planId, goal: approval.goal }
    : loadLatestPlan(projectPath);
  if (!loaded) throw new Error("No plan found in .p7/plans");
  opts.onPhase?.("执行 Plan");
  return executePlan(projectPath, loaded, cfg, scan.git?.remoteUrl ?? null, {
    jobId: opts.jobId,
    projectAlias: opts.projectAlias,
    dashboardBaseUrl: opts.dashboardBaseUrl,
    signal: opts.signal,
    onPhase: opts.onPhase,
  });
}
