import type { Plan } from "./types.ts";

type TitledPlan = Pick<Plan, "title" | "title_zh">;
type MotivatedPlan = Pick<Plan, "motivation" | "motivation_zh">;
type PlanChange = Plan["changes"][number];

/** 管理后台展示标题（中文优先）。 */
export function planDisplayTitle(plan: TitledPlan): string {
  return plan.title_zh?.trim() || plan.title;
}

/** GitHub commit / PR / Issue 标题（英文）。 */
export function planPublishTitle(plan: Pick<Plan, "title">): string {
  return plan.title.trim();
}

/** 管理后台展示动机。 */
export function planDisplayMotivation(plan: MotivatedPlan): string {
  return plan.motivation_zh?.trim() || plan.motivation;
}

/** GitHub PR / Issue 正文动机段。 */
export function planPublishMotivation(plan: Pick<Plan, "motivation">): string {
  return plan.motivation.trim();
}

/** 管理后台展示变更说明。 */
export function planDisplayChangeDescription(change: PlanChange): string {
  return change.description_zh?.trim() || change.description;
}

/** 管理后台展示风险列表。 */
export function planDisplayRisks(plan: Plan): string[] {
  if (plan.risks_zh?.length) return plan.risks_zh;
  return plan.risks;
}

/** 与 ROADMAP Active 步骤对齐时使用的文本（中文优先）。 */
export function planRoadmapHint(plan: TitledPlan, goal?: string): string {
  return planDisplayTitle(plan) || goal?.trim() || plan.title;
}
