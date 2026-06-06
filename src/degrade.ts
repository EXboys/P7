import type { Plan } from "./types.ts";

export function shouldDegrade(plan: Plan): boolean {
  return (
    (plan.complexity === "complex" || plan.changes.length > 3) &&
    plan.estimated_diff_lines > 120
  );
}

export function splitPlan(plan: Plan): Plan[] {
  return plan.changes.map((c, i) => {
    const prefix = `Part ${i + 1}/${plan.changes.length}`;
    return {
      ...plan,
      title: `${prefix}: ${plan.title} (${c.file})`,
      title_zh: plan.title_zh
        ? `第 ${i + 1}/${plan.changes.length} 段：${plan.title_zh}（${c.file}）`
        : undefined,
      motivation: `${plan.motivation}\n\nThis is ${prefix} of a degraded multi-step plan; keep the change independently reviewable and do not implement later parts early.`,
      motivation_zh: plan.motivation_zh
        ? `${plan.motivation_zh}\n\n这是拆分后的第 ${i + 1}/${plan.changes.length} 段；保持本段可独立验证，不提前实现后续段。`
        : undefined,
      complexity: "simple" as const,
      changes: [c],
      estimated_diff_lines: Math.min(c.estimated_lines + 20, 80),
      risks: plan.risks.slice(0, 2),
      validation: `${plan.validation}\n# degraded-step: run after part ${i + 1}/${plan.changes.length}`,
    };
  });
}
