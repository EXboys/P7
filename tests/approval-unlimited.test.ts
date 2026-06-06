import { describe, expect, test } from "bun:test";
import { autoApproveBlockReason } from "../src/approval.ts";
import type { DevAgentConfig } from "../src/config.ts";
import type { Plan } from "../src/types.ts";

function basePlan(): Plan {
  return {
    title: "Large automated change",
    motivation: "Exercise unattended automation limits.",
    changes: Array.from({ length: 25 }, (_, i) => ({
      file: `src/file-${i}.ts`,
      description: "change",
      estimated_lines: 200,
    })),
    risks: Array.from({ length: 12 }, (_, i) => `risk ${i}`),
    validation: "bun test",
    estimated_diff_lines: 1000,
  };
}

describe("autoApproveBlockReason unlimited limits", () => {
  test("treats zero auto-approve and diff limits as unlimited", () => {
    const cfg = {
      auto_approve: {
        enabled: true,
        diff_lines_max: 0,
        files_max: 0,
        risks_max: 0,
      },
      diff_critic: {
        tolerated_files: [],
        max_diff_multiplier: 1.5,
        max_diff_ceiling: 0,
        max_files_ceiling: 0,
      },
    } as DevAgentConfig;

    expect(autoApproveBlockReason(basePlan(), cfg)).toBeNull();
  });
});
