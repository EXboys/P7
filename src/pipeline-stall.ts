import type { DevAgentConfig } from "./config.ts";
import {
  firstUnfinishedStep,
  isRoadmapExhausted,
  loadRoadmap,
} from "./roadmap.ts";
import { getApprovalRecord, listApprovedForExecution, listPendingApprovals, sweepStuckApprovedPlans } from "./approval.ts";
import { countQueuedPlans, getPlanState } from "./state.ts";
import { listJobsForProject } from "./job-read-model.ts";
import type { JobRow } from "./job-types.ts";

export const PIPELINE_RECOVERY_COOLDOWN_MS = 30 * 60 * 1000;

export type PipelineStallReason = "no_work_queue";

export type PipelineStall = {
  reason: PipelineStallReason;
  unfinishedSteps: number;
  suggestedGoal: string | null;
};

/** Roadmap 仍有未完成步骤，但无 approved / pending Plan 可推进时判定为停滞。 */
export function detectPipelineStall(
  projectPath: string,
  dc: DevAgentConfig,
  projectAlias?: string,
): PipelineStall | null {
  if (dc.discovery.auto_recover_stall === false) return null;

  sweepStuckApprovedPlans(projectPath, projectAlias);

  // 队列深度 ≥ 70% 时不触发 stall 恢复——系统正在高负荷运转
  const degradeThreshold = Math.ceil(dc.max_pending_plans * 0.7);
  const depth = countQueuedPlans(projectPath);
  if (depth >= degradeThreshold) return null;

  if (isRoadmapExhausted(projectPath)) return null;
  if (listApprovedForExecution(projectPath).length > 0) return null;
  if (listPendingApprovals(projectPath).length > 0) return null;

  const rm = loadRoadmap(projectPath);
  const unfinished = rm?.active.filter((s) => !s.done).length ?? 0;
  if (unfinished === 0) return null;

  const step = firstUnfinishedStep(projectPath);
  return {
    reason: "no_work_queue",
    unfinishedSteps: unfinished,
    suggestedGoal: step?.text ?? null,
  };
}

const RECOVERY_DELIVERED_STATUSES = new Set(["merged", "pr_opened", "pushed"]);
const RECOVERY_CLEANUP_REASONS = new Set([
  "plan-already-delivered",
  "roadmap-already-done",
  "stale-roadmap-goal",
]);

function parseRecoveryPlanId(job: JobRow): string | null {
  if (!job.result_json) return null;
  try {
    const outer = JSON.parse(job.result_json) as { raw?: string };
    const raw = outer.raw ?? job.result_json;
    const inner = JSON.parse(String(raw).trim()) as { planId?: string };
    return inner.planId ?? null;
  } catch {
    return null;
  }
}

/** 最近一次 stall 恢复仍在冷却中；已成功交付的恢复不再阻塞下一轮。 */
export function pipelineRecoveryCooldownRemainingMs(
  projectAlias: string,
  projectPath?: string,
  cooldownMs = PIPELINE_RECOVERY_COOLDOWN_MS,
): number {
  const cutoff = Date.now() - cooldownMs;
  for (const job of listJobsForProject(projectAlias, 40)) {
    if (job.kind !== "discover-daily") continue;
    if (job.status === "failed") continue;
    const jobTime = new Date(job.created_at).getTime();
    if (jobTime < cutoff) continue;
    try {
      const payload = JSON.parse(job.payload) as { recoverStall?: boolean };
      if (!payload.recoverStall) continue;
      if (projectPath) {
        const planId = parseRecoveryPlanId(job);
        if (planId) {
          const approval = getApprovalRecord(projectPath, planId);
          if (approval?.decidedBy && RECOVERY_CLEANUP_REASONS.has(approval.decidedBy)) continue;
          const state = getPlanState(projectPath, planId);
          if (
            state &&
            (RECOVERY_DELIVERED_STATUSES.has(state.status) || state.mergeStatus === "merged")
          ) {
            continue;
          }
        }
      }
      return Math.max(0, jobTime + cooldownMs - Date.now());
    } catch {
      /* ignore */
    }
  }
  return 0;
}

export function hasRecentPipelineRecovery(
  projectAlias: string,
  projectPath?: string,
  cooldownMs = PIPELINE_RECOVERY_COOLDOWN_MS,
): boolean {
  return pipelineRecoveryCooldownRemainingMs(projectAlias, projectPath, cooldownMs) > 0;
}

export function shouldEnqueuePipelineRecovery(
  projectPath: string,
  projectAlias: string,
  dc: DevAgentConfig,
): PipelineStall | null {
  const stall = detectPipelineStall(projectPath, dc, projectAlias);
  if (!stall) return null;
  if (hasRecentPipelineRecovery(projectAlias, projectPath)) return null;
  if (hasRecentFailedStallRecovery(projectAlias, 3 * 60 * 1000)) return null;
  return stall;
}

const FAILED_RECOVERY_BACKOFF_MS = 3 * 60 * 1000;

/** 最近一次 stall 恢复 job 失败信息（供 UI 展示真实阻塞原因） */
export function lastFailedStallRecovery(
  projectAlias: string,
  lookbackMs = 24 * 60 * 60 * 1000,
): { error: string; at: string } | null {
  const cutoff = Date.now() - lookbackMs;
  for (const job of listJobsForProject(projectAlias, 30)) {
    if (job.kind !== "discover-daily" || job.status !== "failed") continue;
    if (new Date(job.created_at).getTime() < cutoff) continue;
    try {
      const payload = JSON.parse(job.payload) as { recoverStall?: boolean };
      if (!payload.recoverStall) continue;
      const err = job.error?.trim();
      if (!err) continue;
      return { error: err.slice(0, 280), at: job.created_at };
    } catch {
      /* ignore */
    }
  }
  return null;
}

function hasRecentFailedStallRecovery(
  projectAlias: string,
  backoffMs = FAILED_RECOVERY_BACKOFF_MS,
): boolean {
  const cutoff = Date.now() - backoffMs;
  for (const job of listJobsForProject(projectAlias, 15)) {
    if (job.kind !== "discover-daily" || job.status !== "failed") continue;
    if (new Date(job.created_at).getTime() < cutoff) continue;
    try {
      const payload = JSON.parse(job.payload) as { recoverStall?: boolean };
      if (payload.recoverStall) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}
