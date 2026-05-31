import { describe, expect, test } from "bun:test";
import { addSdkCost, emptySdkCost, parseUsage, totalTokens } from "../src/sdk-cost.ts";

describe("sdk-cost", () => {
  test("parseUsage reads snake_case fields", () => {
    const u = parseUsage({ input_tokens: 100, output_tokens: 20 });
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(20);
  });

  test("addSdkCost accumulates", () => {
    const a = addSdkCost(emptySdkCost(), {
      costUsd: 0.01,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    const b = addSdkCost(a, {
      costUsd: 0.02,
      usage: { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    expect(b.costUsd).toBeCloseTo(0.03);
    expect(totalTokens(b.usage)).toBe(165);
  });
});
