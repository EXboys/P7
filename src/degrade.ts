import type { Plan } from "./types.ts";

export function shouldDegrade(plan: Plan): boolean {
  return (
    (plan.complexity === "complex" || plan.changes.length > 3) &&
    plan.estimated_diff_lines > 120
  );
}

export function splitPlan(plan: Plan): Plan[] {
  return plan.changes.map((c) => ({
    ...plan,
    title: `${plan.title} (${c.file})`,
    title_zh: plan.title_zh ? `${plan.title_zh}（${c.file}）` : undefined,
    complexity: "simple" as const,
    changes: [c],
    estimated_diff_lines: Math.min(c.estimated_lines + 20, 80),
    risks: plan.risks.slice(0, 2),
  }));
}
