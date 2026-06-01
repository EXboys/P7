import { describe, expect, test } from "bun:test";
import {
  planDisplayChangeDescription,
  planDisplayMotivation,
  planDisplayRisks,
  planDisplayTitle,
  planPublishTitle,
  planRoadmapHint,
} from "../src/plan-i18n.ts";
import type { Plan } from "../src/types.ts";

const bilingualPlan: Plan = {
  title: "Add executor retry backoff cap",
  title_zh: "为 executor 重试添加上限",
  motivation: "Prevent unbounded retry storms.",
  motivation_zh: "防止无限重试风暴。",
  changes: [
    {
      file: "src/retry.ts",
      description: "Add max backoff constant",
      description_zh: "添加最大退避常量",
      estimated_lines: 20,
    },
  ],
  risks: ["May delay recovery on transient errors"],
  risks_zh: ["可能延迟瞬时错误的恢复"],
  validation: "bun test",
  estimated_diff_lines: 20,
};

describe("plan-i18n", () => {
  test("prefers Chinese fields for admin display", () => {
    expect(planDisplayTitle(bilingualPlan)).toBe("为 executor 重试添加上限");
    expect(planDisplayMotivation(bilingualPlan)).toBe("防止无限重试风暴。");
    expect(planDisplayChangeDescription(bilingualPlan.changes[0]!)).toBe("添加最大退避常量");
    expect(planDisplayRisks(bilingualPlan)).toEqual(["可能延迟瞬时错误的恢复"]);
  });

  test("uses English fields for GitHub publish", () => {
    expect(planPublishTitle(bilingualPlan)).toBe("Add executor retry backoff cap");
  });

  test("falls back to legacy single-language plans", () => {
    const legacy: Plan = {
      title: "旧计划标题",
      motivation: "旧动机",
      changes: [{ file: "a.ts", description: "改 a", estimated_lines: 1 }],
      risks: ["风险"],
      validation: "tsc",
      estimated_diff_lines: 1,
    };
    expect(planDisplayTitle(legacy)).toBe("旧计划标题");
    expect(planRoadmapHint(legacy, "对齐目标")).toBe("旧计划标题");
  });

  test("roadmap hint prefers Chinese title", () => {
    expect(planRoadmapHint(bilingualPlan, "goal")).toBe("为 executor 重试添加上限");
  });
});
