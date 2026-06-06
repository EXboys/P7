import type { ServerConfig } from "./config.ts";
import { audit } from "./audit.ts";
import {
  countCompletedFullDailyToday,
  enqueueJob,
  hasActiveDailyJob,
  hasActiveExecuteJob,
  hasProjectMutexInFlight,
  hasPrReviewInFlight,
} from "./queue/store.ts";
import { loadConfig } from "../src/config.ts";
import { pickNextApprovedPlanForExecution, sweepStuckApprovedPlans } from "../src/approval.ts";
import { getPlanState, preparePlanExecuteRetry } from "../src/state.ts";
import { checkPrWorkGate } from "../src/vcs/pr-work-gate.ts";
import { ghInstalled, gitRemoteOrigin } from "../src/gh-status.ts";
import {
  detectPipelineStall,
  shouldEnqueuePipelineRecovery,
} from "../src/pipeline-stall.ts";
import { runPipelinePreflight, formatPreflightIssues } from "../src/pipeline-preflight.ts";

export function schedulerIntervalMs(cfg: ServerConfig): number {
  return (cfg.scheduler_interval_minutes ?? 2) * 60 * 1000;
}

function prGate(path: string, dc: ReturnType<typeof loadConfig>) {
  return ghInstalled() && gitRemoteOrigin(path)
    ? checkPrWorkGate(path, dc)
    : { blocked: false, reason: "no_gh" };
}

function enqueuePrReviewForBlock(
  alias: string,
  projectPath: string,
  reason: string,
  dc: ReturnType<typeof loadConfig>,
): boolean {
  if (!dc.vcs.enabled || dc.vcs.review_open_prs === false) return false;
  if (hasPrReviewInFlight(alias) || hasProjectMutexInFlight(alias, "pr-review")) return false;
  enqueueJob({
    kind: "pr-review",
    payload: { projectPath },
    projectAlias: alias,
  });
  audit("scheduler.pr_review_enqueued_for_block", { alias, reason });
  return true;
}

function runSchedulerTick(cfg: ServerConfig): void {
  for (const [alias, projectPath] of Object.entries(cfg.project_aliases)) {
    const path = String(projectPath);
    let dc;
    try {
      dc = loadConfig(path);
    } catch {
      continue;
    }

    sweepStuckApprovedPlans(path, alias);

    if (
      dc.discovery.auto_execute_after_approve !== false &&
      !hasActiveExecuteJob(alias) &&
      !hasProjectMutexInFlight(alias, "execute")
    ) {
      const next = pickNextApprovedPlanForExecution(path, { projectAlias: alias });
      if (next) {
        const gate = prGate(path, dc);
        if (!gate.blocked) {
          const pre = runPipelinePreflight(path, { requireLlm: false });
          if (!pre.ok) {
            audit("scheduler.skipped", {
              alias,
              reason: "preflight",
              detail: formatPreflightIssues(pre.issues).slice(0, 120),
            });
          } else {
            const state = getPlanState(path, next.planId);
            if (state?.status === "failed") {
              preparePlanExecuteRetry(path, next.planId);
            }
            enqueueJob({
              kind: "execute",
              payload: { projectPath: path, planId: next.planId },
              projectAlias: alias,
            });
            audit("scheduler.enqueued", {
              alias,
              kind: "execute",
              planId: next.planId,
            });
            continue;
          }
        } else {
          enqueuePrReviewForBlock(alias, path, "open_prs_block_execute", dc);
          audit("scheduler.skipped", { alias, reason: "open_prs_block_execute" });
        }
      }
    }

    if (hasActiveDailyJob(alias)) {
      audit("scheduler.skipped", { alias, reason: "daily_in_flight" });
      continue;
    }
    if (hasProjectMutexInFlight(alias)) {
      audit("scheduler.skipped", { alias, reason: "active_job" });
      continue;
    }

    const gate = prGate(path, dc);

    // 管道停滞优先于「今日已跑过 daily」——避免 recover 失败后被 daily_exists 卡死
    const stall = shouldEnqueuePipelineRecovery(path, alias, dc);
    if (stall) {
      if (gate.blocked) {
        enqueuePrReviewForBlock(alias, path, "open_prs_block_recovery", dc);
        audit("scheduler.skipped", { alias, reason: "open_prs_block_recovery" });
        continue;
      }
      const pre = runPipelinePreflight(path);
      if (!pre.ok) {
        audit("scheduler.skipped", {
          alias,
          reason: "preflight_recovery",
          detail: formatPreflightIssues(pre.issues).slice(0, 120),
        });
        continue;
      }
      enqueueJob({
        kind: "discover-daily",
        payload: { projectPath: path, recoverStall: true },
        projectAlias: alias,
      });
      audit("scheduler.recovery_enqueued", {
        alias,
        reason: stall.reason,
        goal: stall.suggestedGoal?.slice(0, 80),
      });
      continue;
    }

    const dailyLimit = dc.discovery.daily_run_limit ?? 1;
    if (dailyLimit > 0 && countCompletedFullDailyToday(alias) >= dailyLimit) {
      audit("scheduler.skipped", { alias, reason: "daily_limit_reached", dailyLimit });
      continue;
    }

    if (gate.blocked) {
      enqueuePrReviewForBlock(alias, path, "open_prs_block", dc);
      audit("scheduler.skipped", { alias, reason: "open_prs_block" });
      continue;
    }

    const pre = runPipelinePreflight(path);
    if (!pre.ok) {
      audit("scheduler.skipped", {
        alias,
        reason: "preflight",
        detail: formatPreflightIssues(pre.issues).slice(0, 120),
      });
      continue;
    }

    const planOnly = !dc.discovery.auto_execute_after_approve;
    enqueueJob({
      kind: "discover-daily",
      payload: { projectPath: path, planOnly },
      projectAlias: alias,
    });
    audit("scheduler.enqueued", { alias, kind: "discover-daily" });
  }
  detectReverts(cfg);
}

export function startScheduler(getCfg: () => ServerConfig): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    const cfg = getCfg();
    if (!cfg.scheduler_enabled) {
      timer = setTimeout(scheduleNext, schedulerIntervalMs(cfg));
      return;
    }
    runSchedulerTick(cfg);
    timer = setTimeout(scheduleNext, schedulerIntervalMs(cfg));
  };

  runSchedulerTick(getCfg());
  timer = setTimeout(scheduleNext, schedulerIntervalMs(getCfg()));

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function detectReverts(cfg: ServerConfig): void {
  for (const [, projectPath] of Object.entries(cfg.project_aliases)) {
    const proc = Bun.spawnSync(
      ["git", "-C", String(projectPath), "log", "-20", "--oneline"],
      { stdout: "pipe" },
    );
    if (proc.exitCode !== 0) continue;
    const log = new TextDecoder().decode(proc.stdout);
    if (/reverts commit/i.test(log)) {
      audit("revert.detected", { projectPath });
    }
  }
}
