import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runPipelineCheck } from "../src/pipeline-check.ts";

describe("runPipelineCheck", () => {
  test("reports git missing for non-repo directory", () => {
    const root = join(tmpdir(), `p7-pcheck-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const items = runPipelineCheck(root, { remote: false });
      const git = items.find((i) => i.id === "git");
      expect(git?.ok).toBe(false);
      expect(git?.label).toContain("Git");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips remote git/gh checks when remote is false", () => {
    const root = join(tmpdir(), `p7-pcheck-local-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const items = runPipelineCheck(root, { remote: false });
      const sync = items.find((i) => i.id === "git_sync");
      const ghAuth = items.find((i) => i.id === "gh_auth");
      expect(sync).toBeUndefined();
      expect(ghAuth?.detail).toContain("打开页面时跳过");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
