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
      const items = runPipelineCheck(root);
      const git = items.find((i) => i.id === "git");
      expect(git?.ok).toBe(false);
      expect(git?.label).toContain("Git");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
