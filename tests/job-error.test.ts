import { describe, expect, test } from "bun:test";
import { normalizeJobError } from "../server/job-error.ts";

describe("normalizeJobError", () => {
  test("exit 143 explains timeout", () => {
    const msg = normalizeJobError("超时 35 分钟，终止进程\n进程结束 exit=143", 143);
    expect(msg).toContain("超时");
    expect(msg).not.toContain("baseURL=X.baseURL");
  });

  test("extracts API connection error from noisy stderr", () => {
    const blob = `55 | minified junk
error: Claude Code returned an error result: API Error: Unable to connect to API (FailedToOpenSocket)`;
    expect(normalizeJobError(blob, 1)).toMatch(/Unable to connect/i);
  });

  test("humanizes plan schema line-limit errors", () => {
    const blob = `ZodError: [
      {"code":"too_big","path":["estimated_diff_lines"],"message":"Too big: expected number to be <=200"}
    ]`;
    expect(normalizeJobError(blob, 1)).toContain("Plan 校验失败");
  });
});
