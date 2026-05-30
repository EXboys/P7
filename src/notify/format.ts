import type { Plan } from "../types.ts";

export function formatPlanCard(plan: Plan, goal: string, approvalUrl?: string): string {
  const changes = plan.changes.map((c) => `- ${c.file}: ${c.description}`).join("\n");
  let body = `### ${plan.title}\n\n**目标**: ${goal}\n\n${plan.motivation}\n\n**变更**:\n${changes}\n\n**风险**: ${plan.risks.join("; ") || "无"}`;
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
