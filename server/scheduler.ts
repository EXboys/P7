import type { ServerConfig } from "./config.ts";
import { audit } from "./audit.ts";
import {
  enqueueJob,
  hasActiveExecuteJob,
  hasActiveJob,
  hasPendingDailyToday,
  hasProjectMutexInFlight,
} from "./queue/store.ts";
import { loadConfig } from "../src/config.ts";
import { pickNextApprovedPlanForExecution } from "../src/approval.ts";
import { getPlanState, preparePlanExecuteRetry } from "../src/state.ts";
import { checkPrWorkGate } from "../src/vcs/pr-work-gate.ts";
import { ghInstalled, gitRemoteOrigin } from "../src/gh-status.ts";

export function schedulerIntervalMs(cfg: ServerConfig): number {
  return (cfg.scheduler_interval_minutes ?? 2) * 60 * 1000;
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

    if (
      dc.discovery.auto_execute_after_approve !== false &&
      !hasActiveExecuteJob(alias) &&
      !hasProjectMutexInFlight(alias, "execute")
    ) {
      const next = pickNextApprovedPlanForExecution(path, { projectAlias: alias });
      if (next) {
        const gate =
          ghInstalled() && gitRemoteOrigin(path)
            ? checkPrWorkGate(path, dc)
            : { blocked: false };
        if (!gate.blocked) {
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
        audit("scheduler.skipped", { alias, reason: "open_prs_block_execute" });
      }
    }

    if (hasActiveJob(alias)) {
      audit("scheduler.skipped", { alias, reason: "active_job" });
      continue;
    }
    if (hasPendingDailyToday(alias)) {
      audit("scheduler.skipped", { alias, reason: "daily_exists" });
      continue;
    }
    if (
      ghInstalled() &&
      gitRemoteOrigin(path) &&
      checkPrWorkGate(path, dc).blocked
    ) {
      audit("scheduler.skipped", { alias, reason: "open_prs_block" });
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
