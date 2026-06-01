import type { Plan } from "../types.ts";
import {
  planDisplayChangeDescription,
  planDisplayMotivation,
  planDisplayRisks,
  planDisplayTitle,
} from "../plan-i18n.ts";

export function formatPlanCard(plan: Plan, goal: string, approvalUrl?: string): string {
  const changes = plan.changes
    .map((c) => `- ${c.file}: ${planDisplayChangeDescription(c)}`)
    .join("\n");
  const risks = planDisplayRisks(plan).join("; ") || "无";
  let body = `### ${planDisplayTitle(plan)}\n\n**目标**: ${goal}\n\n${planDisplayMotivation(plan)}\n\n**变更**:\n${changes}\n\n**风险**: ${risks}`;
  if (approvalUrl) body += `\n\n[审批](${approvalUrl})`;
  return body;
}

export function formatStatusMarkdown(
  title: string,
  ok: boolean,
  detail: string,
): string {
  return `## ${ok ? "✅" : "❌"} ${title}\n\n${detail}`;
}
