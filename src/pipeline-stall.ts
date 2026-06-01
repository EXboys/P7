import type { DevAgentConfig } from "./config.ts";
import {
  firstUnfinishedStep,
  isRoadmapExhausted,
  loadRoadmap,
} from "./roadmap.ts";
import { listApprovedForExecution, listPendingApprovals, sweepStuckApprovedPlans } from "./approval.ts";
import { countQueuedPlans } from "./state.ts";
import { listJobsForProject } from "../server/queue/store.ts";

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

export function hasRecentPipelineRecovery(
  projectAlias: string,
  cooldownMs = PIPELINE_RECOVERY_COOLDOWN_MS,
): boolean {
  const cutoff = Date.now() - cooldownMs;
  for (const job of listJobsForProject(projectAlias, 40)) {
    if (job.kind !== "discover-daily") continue;
    if (job.status === "failed") continue;
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

export function shouldEnqueuePipelineRecovery(
  projectPath: string,
  projectAlias: string,
  dc: DevAgentConfig,
): PipelineStall | null {
  const stall = detectPipelineStall(projectPath, dc, projectAlias);
  if (!stall) return null;
  if (hasRecentPipelineRecovery(projectAlias)) return null;
  return stall;
}
