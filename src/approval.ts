import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { projectSubpathForRead, projectSubpathForWrite } from "./p7-paths.ts";
import type { DevAgentConfig } from "./config.ts";
import { countQueuedPlans, getPlanState, preparePlanExecuteRetry, transitionPlanState, upsertPlanState } from "./state.ts";
import { planDisplayTitle } from "./plan-i18n.ts";
import { planGoalMatchesRoadmapDone, recommendRoadmapGoal, roadmapTextMatches, firstUnfinishedStep } from "./roadmap.ts";
import { appendLesson } from "./agent-memory.ts";
import { listJobsForProject } from "./job-read-model.ts";
import type { ApprovalRecord, Plan, PlanRecord, PlanState } from "./types.ts";

export function approvalsDir(projectPath: string): string {
  return projectSubpathForRead(projectPath, "approvals");
}

function approvalFilePath(projectPath: string, planId: string, write = false): string {
  const base = write ? projectSubpathForWrite : projectSubpathForRead;
  return join(base(projectPath, "approvals"), `${planId}.json`);
}

export function savePendingApproval(
  projectPath: string,
  planRecord: PlanRecord,
): ApprovalRecord {
  const dir = projectSubpathForWrite(projectPath, "approvals");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const approval: ApprovalRecord = {
    planId: planRecord.planId,
    projectPath,
    status: "pending",
    plan: planRecord.plan,
    goal: planRecord.goal,
    createdAt: planRecord.createdAt,
  };
  writeFileSync(join(dir, `${planRecord.planId}.json`), JSON.stringify(approval, null, 2));
  upsertPlanState(projectPath, {
    planId: planRecord.planId,
    projectPath,
    goal: planRecord.goal,
    title: planDisplayTitle(planRecord.plan),
    status: "pending_approval",
    createdAt: planRecord.createdAt,
  });
  return approval;
}

export function getApprovalRecord(projectPath: string, planId: string): ApprovalRecord | null {
  const path = approvalFilePath(projectPath, planId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as ApprovalRecord;
}

function writeApprovalRecord(projectPath: string, record: ApprovalRecord): void {
  const dir = projectSubpathForWrite(projectPath, "approvals");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(approvalFilePath(projectPath, record.planId, true), JSON.stringify(record, null, 2));
}

export function listPendingApprovals(projectPath: string): ApprovalRecord[] {
  const dir = approvalsDir(projectPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as ApprovalRecord)
    .filter((r) => r.status === "pending");
}

export function decideApproval(
  projectPath: string,
  planId: string,
  status: "approved" | "rejected",
  decidedBy?: string,
): ApprovalRecord | null {
  const record = getApprovalRecord(projectPath, planId);
  if (!record) return null;
  record.status = status;
  record.decidedAt = new Date().toISOString();
  record.decidedBy = decidedBy;
  writeApprovalRecord(projectPath, record);
  transitionPlanState(projectPath, planId, status === "approved" ? "approved" : "rejected");
  return record;
}

function autoApproveLimits(cfg: DevAgentConfig): {
  filesMax: number | null;
  linesMax: number | null;
  risksMax: number | null;
} {
  const filesUnlimited =
    cfg.auto_approve.files_max === 0 || cfg.diff_critic.max_files_ceiling === 0;
  const linesUnlimited =
    cfg.auto_approve.diff_lines_max === 0 || cfg.diff_critic.max_diff_ceiling === 0;
  return {
    filesMax: filesUnlimited
      ? null
      : Math.max(cfg.auto_approve.files_max, cfg.diff_critic.max_files_ceiling),
    linesMax: linesUnlimited
      ? null
      : Math.max(cfg.auto_approve.diff_lines_max, cfg.diff_critic.max_diff_ceiling),
    risksMax: cfg.auto_approve.risks_max === 0 ? null : cfg.auto_approve.risks_max,
  };
}

/** 不符合自动审批时返回原因；符合则返回 null */
export function autoApproveBlockReason(plan: Plan, cfg: DevAgentConfig): string | null {
  if (!cfg.auto_approve.enabled) return "自动审批已关闭";
  const { filesMax, linesMax, risksMax } = autoApproveLimits(cfg);
  if (filesMax !== null && plan.changes.length > filesMax) {
    return `文件 ${plan.changes.length} 个，超过上限 ${filesMax}`;
  }
  if (linesMax !== null && plan.estimated_diff_lines > linesMax) {
    return `约 ${plan.estimated_diff_lines} 行，超过上限 ${linesMax}`;
  }
  if (risksMax !== null && plan.risks.length > risksMax) {
    return `风险 ${plan.risks.length} 条，超过上限 ${risksMax}`;
  }
  return null;
}

export function shouldAutoApprove(plan: Plan, cfg: DevAgentConfig): boolean {
  return autoApproveBlockReason(plan, cfg) === null;
}

export type AutoApproveBatchResult = {
  approved: string[];
  skipped: { planId: string; reason: string }[];
};

/** 批量自动批准待审批 Plan；可选对每个批准的 plan 入队 execute */
export function processAutoApprovals(
  projectPath: string,
  cfg: DevAgentConfig,
  opts?: {
    planIds?: string[];
    enqueueExecute?: (planId: string) => void;
  },
): AutoApproveBatchResult {
  const pending = listPendingApprovals(projectPath).filter((p) =>
    opts?.planIds ? opts.planIds.includes(p.planId) : true,
  );
  // 队列深度 ≥ 70% 时暂停所有自动审批，避免已积压时继续产生 approved Plan
  const degradeThreshold = Math.ceil(cfg.max_pending_plans * 0.7);
  const candidateIds = new Set(pending.map((p) => p.planId));
  const candidateDepth = listPendingApprovals(projectPath).filter((p) =>
    candidateIds.has(p.planId),
  ).length;
  const existingDepth = Math.max(0, countQueuedPlans(projectPath) - candidateDepth);
  if (existingDepth >= degradeThreshold) {
    return {
      approved: [],
      skipped: pending.map((p) => ({ planId: p.planId, reason: "queue_depth" })),
    };
  }

  const approved: string[] = [];
  const skipped: { planId: string; reason: string }[] = [];

  for (const rec of pending) {
    const reason = autoApproveBlockReason(rec.plan, cfg);
    if (reason) {
      skipped.push({ planId: rec.planId, reason });
      continue;
    }
    decideApproval(projectPath, rec.planId, "approved", "auto");
    approved.push(rec.planId);
    opts?.enqueueExecute?.(rec.planId);
  }
  return { approved, skipped };
}

export function countPendingPlans(projectPath: string): number {
  return listPendingApprovals(projectPath).length;
}

export function listApprovedForExecution(projectPath: string): ApprovalRecord[] {
  const dir = approvalsDir(projectPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as ApprovalRecord)
    .filter((r) => r.status === "approved");
}

const EXECUTE_SKIP_STATES = new Set([
  "executing",
  "pushed",
  "pr_opened",
  "merged",
]);

export const FAILED_RETRY_COOLDOWN_MS = 2 * 60 * 1000;
export const MAX_FAILED_EXECUTE_PER_PLAN = 3;

function countFailedExecuteJobsForPlan(projectAlias: string, planId: string): number {
  return listJobsForProject(projectAlias, 100).filter((j) => {
    if (j.kind !== "execute" || j.status !== "failed") return false;
    try {
      return (JSON.parse(j.payload) as { planId?: string }).planId === planId;
    } catch {
      return false;
    }
  }).length;
}

/** 调度器是否可自动重试 failed 且仍 approved 的 Plan */
export function canSchedulerRetryFailedPlan(
  projectAlias: string | undefined,
  planId: string,
  state: PlanState,
): boolean {
  if (state.status !== "failed") return false;
  if (Date.now() - new Date(state.updatedAt).getTime() < FAILED_RETRY_COOLDOWN_MS) return false;
  if (!projectAlias) return true;
  return countFailedExecuteJobsForPlan(projectAlias, planId) < MAX_FAILED_EXECUTE_PER_PLAN;
}

function isEligibleForExecute(
  state: PlanState | null | undefined,
  projectAlias: string | undefined,
  planId: string,
): boolean {
  if (!state) return true;
  if (EXECUTE_SKIP_STATES.has(state.status)) return false;
  if (state.status === "failed") return canSchedulerRetryFailedPlan(projectAlias, planId, state);
  return true;
}

export function isExecuteRetryExhausted(
  projectAlias: string | undefined,
  planId: string,
  state: PlanState,
): boolean {
  if (state.status !== "failed") return false;
  if (!projectAlias) return false;
  return countFailedExecuteJobsForPlan(projectAlias, planId) >= MAX_FAILED_EXECUTE_PER_PLAN;
}

export type AbandonPlanReason =
  | "auto-exhausted-retries"
  | "roadmap-already-done"
  | "stale-roadmap-goal"
  | "plan-already-delivered";

/** Reject an approved plan that should no longer block the pipeline. */
export function abandonApprovedPlan(
  projectPath: string,
  planId: string,
  decidedBy: AbandonPlanReason,
): boolean {
  const approval = getApprovalRecord(projectPath, planId);
  if (!approval || approval.status !== "approved") return false;
  approval.status = "rejected";
  approval.decidedAt = new Date().toISOString();
  approval.decidedBy = decidedBy;
  writeApprovalRecord(projectPath, approval);
  return true;
}

/** Drop failed plans after max auto-retries, or goals already listed in ROADMAP Done. */
export function abandonStuckApprovedPlan(
  projectPath: string,
  planId: string,
  opts?: { projectAlias?: string; title?: string; goal?: string },
): AbandonPlanReason | null {
  const approval = getApprovalRecord(projectPath, planId);
  if (!approval || approval.status !== "approved") return null;

  const state = getPlanState(projectPath, planId);
  if (
    state &&
    (state.status === "merged" ||
      state.status === "pr_opened" ||
      state.status === "pushed" ||
      state.mergeStatus === "merged")
  ) {
    if (abandonApprovedPlan(projectPath, planId, "plan-already-delivered")) {
      return "plan-already-delivered";
    }
    return null;
  }

  const goal = opts?.goal ?? approval.goal;
  const title = opts?.title ?? planDisplayTitle(approval.plan);
  if (planGoalMatchesRoadmapDone(projectPath, goal, title)) {
    if (abandonApprovedPlan(projectPath, planId, "roadmap-already-done")) {
      void appendLesson(
        projectPath,
        `plan:abandon ${planId} roadmap-already-done "${title.slice(0, 60)}"`,
      );
      return "roadmap-already-done";
    }
    return null;
  }

  if (state?.status === "failed") {
    const active = firstUnfinishedStep(projectPath);
    if (active) {
      const aligned =
        roadmapTextMatches(goal, active.text) ||
        roadmapTextMatches(title, active.text);
      if (!aligned) {
        if (abandonApprovedPlan(projectPath, planId, "stale-roadmap-goal")) {
          void appendLesson(
            projectPath,
            `plan:abandon ${planId} stale-roadmap-goal active="${active.text.slice(0, 48)}"`,
          );
          return "stale-roadmap-goal";
        }
        return null;
      }
    }
  }

  if (!state || state.status !== "failed") return null;
  if (!isExecuteRetryExhausted(opts?.projectAlias, planId, state)) return null;
  if (abandonApprovedPlan(projectPath, planId, "auto-exhausted-retries")) {
    void appendLesson(
      projectPath,
      `plan:abandon ${planId} auto-exhausted-retries (${MAX_FAILED_EXECUTE_PER_PLAN} execute failures)`,
    );
    return "auto-exhausted-retries";
  }
  return null;
}

/** Scheduler tick: clear plans that would otherwise stay approved+failed forever. */
export function sweepStuckApprovedPlans(
  projectPath: string,
  projectAlias?: string,
): AbandonPlanReason[] {
  const reasons: AbandonPlanReason[] = [];
  for (const rec of listApprovedForExecution(projectPath)) {
    const reason = abandonStuckApprovedPlan(projectPath, rec.planId, {
      projectAlias,
      goal: rec.goal,
      title: planDisplayTitle(rec.plan),
    });
    if (reason) reasons.push(reason);
  }
  return reasons;
}

function titleMatchesRoadmapGoal(title: string, goal: string): boolean {
  return roadmapTextMatches(title, goal);
}

/** 下一个应入队 execute 的已批准 Plan（跳过已结束；优先对齐当前 Roadmap 步骤） */
export function pickNextApprovedPlanForExecution(
  projectPath: string,
  opts?: { projectAlias?: string },
): ApprovalRecord | null {
  const candidates: ApprovalRecord[] = [];
  for (const rec of listApprovedForExecution(projectPath)) {
    const state = getPlanState(projectPath, rec.planId);
    if (!isEligibleForExecute(state, opts?.projectAlias, rec.planId)) continue;
    candidates.push(rec);
  }
  if (candidates.length === 0) return null;

  const roadmapGoal = recommendRoadmapGoal(projectPath);
  if (roadmapGoal) {
    const aligned = candidates.find((r) =>
      titleMatchesRoadmapGoal(planDisplayTitle(r.plan), roadmapGoal) ||
      titleMatchesRoadmapGoal(r.goal, roadmapGoal),
    );
    if (aligned) return aligned;
  }

  candidates.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return candidates[0];
}
