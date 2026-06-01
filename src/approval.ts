import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { projectSubpathForRead, projectSubpathForWrite } from "./p7-paths.ts";
import type { DevAgentConfig } from "./config.ts";
import { countQueuedPlans, getPlanState, preparePlanExecuteRetry, transitionPlanState, upsertPlanState } from "./state.ts";
import { planDisplayTitle } from "./plan-i18n.ts";
import { recommendRoadmapGoal } from "./roadmap.ts";
import { listJobsForProject } from "../server/queue/store.ts";
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
  const dir = projectSubpathForWrite(projectPath, "approvals");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(approvalFilePath(projectPath, planId, true), JSON.stringify(record, null, 2));
  transitionPlanState(projectPath, planId, status === "approved" ? "approved" : "rejected");
  return record;
}

function autoApproveLimits(cfg: DevAgentConfig): {
  filesMax: number;
  linesMax: number;
  risksMax: number;
} {
  return {
    filesMax: Math.max(cfg.auto_approve.files_max, cfg.diff_critic.max_files_ceiling),
    linesMax: Math.max(cfg.auto_approve.diff_lines_max, cfg.diff_critic.max_diff_ceiling),
    risksMax: cfg.auto_approve.risks_max,
  };
}

/** 不符合自动审批时返回原因；符合则返回 null */
export function autoApproveBlockReason(plan: Plan, cfg: DevAgentConfig): string | null {
  if (!cfg.auto_approve.enabled) return "自动审批已关闭";
  const { filesMax, linesMax, risksMax } = autoApproveLimits(cfg);
  if (plan.changes.length > filesMax) {
    return `文件 ${plan.changes.length} 个，超过上限 ${filesMax}`;
  }
  if (plan.estimated_diff_lines > linesMax) {
    return `约 ${plan.estimated_diff_lines} 行，超过上限 ${linesMax}`;
  }
  if (plan.risks.length > risksMax) {
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
  // 队列深度 ≥ 70% 时暂停所有自动审批，避免已积压时继续产生 approved Plan
  const degradeThreshold = Math.ceil(cfg.max_pending_plans * 0.7);
  const depth = countQueuedPlans(projectPath);
  if (depth >= degradeThreshold) {
    const pending = listPendingApprovals(projectPath).filter((p) =>
      opts?.planIds ? opts.planIds.includes(p.planId) : true,
    );
    return {
      approved: [],
      skipped: pending.map((p) => ({ planId: p.planId, reason: "queue_depth" })),
    };
  }

  const approved: string[] = [];
  const skipped: { planId: string; reason: string }[] = [];
  const pending = listPendingApprovals(projectPath).filter((p) =>
    opts?.planIds ? opts.planIds.includes(p.planId) : true,
  );

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

function titleMatchesRoadmapGoal(title: string, goal: string): boolean {
  const t = title.toLowerCase();
  const g = goal.toLowerCase();
  const a = g.slice(0, Math.min(18, g.length));
  const b = t.slice(0, Math.min(18, t.length));
  return a.length >= 8 && (g.includes(b) || t.includes(a));
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
