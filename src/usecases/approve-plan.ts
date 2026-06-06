import { decideApproval } from "../approval.ts";
import { executeApprovedPlanUseCase } from "./execute-approved-plan.ts";

export async function approvePlanUseCase(
  projectPath: string,
  planId: string,
  opts: { execute?: boolean } = {},
): Promise<unknown> {
  const approval = decideApproval(projectPath, planId, "approved");
  if (!approval) throw new Error(`Approval not found: ${planId}`);
  if (!opts.execute) return { approved: planId };
  const result = await executeApprovedPlanUseCase(projectPath, { planId, force: true });
  return { approved: planId, result };
}

export function rejectPlanUseCase(projectPath: string, planId: string): { rejected: string } {
  decideApproval(projectPath, planId, "rejected");
  return { rejected: planId };
}
