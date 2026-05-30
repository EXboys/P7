import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { projectSubpathForRead, projectSubpathForWrite } from "./p7-paths.ts";
import type { DevAgentConfig } from "./config.ts";
import { transitionPlanState, upsertPlanState } from "./state.ts";
import type { ApprovalRecord, Plan, PlanRecord } from "./types.ts";

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
    title: planRecord.plan.title,
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

export function shouldAutoApprove(plan: Plan, cfg: DevAgentConfig): boolean {
  if (!cfg.auto_approve.enabled) return false;
  if (plan.changes.length > cfg.auto_approve.files_max) return false;
  if (plan.estimated_diff_lines > cfg.auto_approve.diff_lines_max) return false;
  if (plan.risks.length > cfg.auto_approve.risks_max) return false;
  return true;
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
