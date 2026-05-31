import { describe, expect, test } from "bun:test";
import { llmConfigFingerprint } from "../src/llm-probe-cache.ts";

describe("llm-probe-cache", () => {
  test("fingerprint changes when key changes", () => {
    const envA = {
      ANTHROPIC_API_KEY: "sk-test-key-aaaa",
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
    };
    const envB = { ...envA, ANTHROPIC_API_KEY: "sk-test-key-bbbb" };
    expect(llmConfigFingerprint(envA)).not.toBe(llmConfigFingerprint(envB));
  });

  test("fingerprint stable for same config", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-same",
      ANTHROPIC_BASE_URL: "https://api.example.com",
      ANTHROPIC_MODEL: "m1",
    };
    expect(llmConfigFingerprint(env)).toBe(llmConfigFingerprint({ ...env }));
  });
});
