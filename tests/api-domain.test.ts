import { describe, expect, test } from "bun:test";
import { resolveAllowedApiDomains } from "../src/api-domain.ts";
import { validateApiDomain } from "../src/sdk.ts";

describe("resolveAllowedApiDomains", () => {
  test("includes hostname from ANTHROPIC_BASE_URL", () => {
    const domains = resolveAllowedApiDomains(
      ["api.anthropic.com"],
      "https://api.deepseek.com/anthropic",
    );
    expect(domains).toContain("api.deepseek.com");
  });
});

describe("validateApiDomain with proxy", () => {
  test("allows deepseek when base URL matches", () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
    try {
      expect(() => validateApiDomain()).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prev;
    }
  });
});
