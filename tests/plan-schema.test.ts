import { describe, expect, test } from "bun:test";
import { PlanSchema } from "../src/types.ts";

describe("PlanSchema", () => {
  test("accepts larger plans so planner can degrade/split them", () => {
    const parsed = PlanSchema.parse({
      title: "Large but splittable plan",
      motivation: "Allow planner to split instead of failing during schema parse",
      complexity: "complex",
      changes: [
        { file: "a.ts", description: "a", estimated_lines: 80 },
        { file: "b.ts", description: "b", estimated_lines: 80 },
        { file: "c.ts", description: "c", estimated_lines: 80 },
        { file: "d.ts", description: "d", estimated_lines: 80 },
        { file: "e.ts", description: "e", estimated_lines: 80 },
        { file: "f.ts", description: "f", estimated_lines: 80 },
      ],
      risks: [],
      validation: "bun test",
      estimated_diff_lines: 480,
    });

    expect(parsed.estimated_diff_lines).toBe(480);
    expect(parsed.changes).toHaveLength(6);
  });
});
