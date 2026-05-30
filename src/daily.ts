import { loadConfig } from "./config.ts";
import { scanProject } from "./scanner.ts";
import { selectGoal } from "./goal-selector.ts";
import { generatePlan } from "./planner.ts";
import { executePlan } from "./executor.ts";
import {
  savePendingApproval,
  shouldAutoApprove,
  decideApproval,
  getApprovalRecord,
} from "./approval.ts";
import { appendLesson } from "./agent-memory.ts";
import { notifyPlanReady, notifyExecutionResult, type NotifyConfig } from "./notify/sender.ts";
import { resolveNotifyConfig } from "./notify/env.ts";
import { runDiscovery } from "./tech-discovery.ts";
import { listApprovedForExecution } from "./approval.ts";

export interface DailyRunResult {
  phase: string;
  goal?: string;
  planId?: string;
  executed?: boolean;
  executionOk?: boolean;
  error?: string;
  costUsd?: number;
}

export async function runDaily(
  projectPath: string,
  opts: {
    goal?: string;
    notify?: NotifyConfig;
    skipExecute?: boolean;
    skipDiscovery?: boolean;
    projectAlias?: string;
  } = {},
): Promise<DailyRunResult> {
  const cfg = loadConfig(projectPath);
  const notify = opts.notify ?? resolveNotifyConfig(opts.projectAlias);

  const approved = listApprovedForExecution(projectPath);
  if (approved.length > 0 && !opts.skipExecute && !opts.goal) {
    const a = approved[0];
    const scan = await scanProject(projectPath);
    const result = await executePlan(
      projectPath,
      { ...a.plan, planId: a.planId, goal: a.goal },
      cfg,
      scan.git?.remoteUrl ?? null,
    );
    if (notify) {
      await notifyExecutionResult(
        notify,
        a.plan.title,
        result.ok,
        result.ok
          ? `分支 ${result.branch} 提交 ${result.commitSha}\n${result.prUrl ?? ""}`
          : result.error ?? "unknown",
      );
    }
    return {
      phase: result.ok ? "done" : "execute_failed",
      goal: a.goal,
      planId: a.planId,
      executed: true,
      executionOk: result.ok,
      error: result.error,
      costUsd: result.costUsd,
    };
  }

  if (!opts.skipDiscovery && cfg.discovery.enabled) {
    await runDiscovery(projectPath, cfg, { useLlmThemes: true });
  }
  const scan = await scanProject(projectPath);

  let goal = opts.goal ?? cfg.initial_goal;
  if (cfg.auto_select_goal && !opts.goal) {
    const sel = await selectGoal(projectPath, scan, cfg);
    goal = sel.today_goal;
  }

  const planRecord = await generatePlan(projectPath, scan, goal);
  const { plan, planId } = planRecord;
  if (!getApprovalRecord(projectPath, planId)) {
    savePendingApproval(projectPath, planRecord);
  }

  if (notify) {
    await notifyPlanReady(notify, plan, goal, planId);
  }

  const auto = shouldAutoApprove(plan, cfg);
  if (!auto) {
    await appendLesson(projectPath, `plan:pending "${plan.title}" awaiting approval`);
    return { phase: "awaiting_approval", goal, planId };
  }

  decideApproval(projectPath, planId, "approved", "auto");

  if (opts.skipExecute) {
    return { phase: "planned", goal, planId };
  }

  const result = await executePlan(
    projectPath,
    { ...plan, planId, goal },
    cfg,
    scan.git?.remoteUrl ?? null,
  );

  if (notify) {
    await notifyExecutionResult(
      notify,
      plan.title,
      result.ok,
      result.ok
        ? `分支 ${result.branch} 提交 ${result.commitSha}\n${result.reviewUrl ?? ""}`
        : result.error ?? "unknown",
    );
  }

  return {
    phase: result.ok ? "done" : "execute_failed",
    goal,
    planId,
    executed: true,
    executionOk: result.ok,
    error: result.error,
    costUsd: result.costUsd,
  };
}
