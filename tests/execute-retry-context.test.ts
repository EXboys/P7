import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  formatExecuteRetryPromptBlock,
  loadPreviousExecuteFailureContext,
} from "../src/execute-retry-context.ts";

describe("execute retry context", () => {
  test("loads archived failed-plans reason", () => {
    const root = join(tmpdir(), `p7-retry-ctx-${Date.now()}`);
    const failedDir = join(root, ".p7", "failed-plans");
    mkdirSync(failedDir, { recursive: true });
    writeFileSync(
      join(failedDir, "1.json"),
      JSON.stringify({
        planId: "plan-1",
        title: "Add tests",
        reason: "no file changes",
        failedAt: "2026-05-31T10:00:00.000Z",
      }),
    );
    const ctx = loadPreviousExecuteFailureContext(root, "plan-1", "Add tests");
    expect(ctx).toContain("no file changes");
    rmSync(root, { recursive: true, force: true });
  });

  test("formatExecuteRetryPromptBlock wraps context", () => {
    const block = formatExecuteRetryPromptBlock("上次：timeout");
    expect(block).toContain("上次执行失败");
    expect(block).toContain("timeout");
  });

  test("returns empty when no history", () => {
    const root = join(tmpdir(), `p7-retry-empty-${Date.now()}`);
    mkdirSync(join(root, ".p7"), { recursive: true });
    expect(loadPreviousExecuteFailureContext(root, "x", "y")).toBe("");
    rmSync(root, { recursive: true, force: true });
  });
});
