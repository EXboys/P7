import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { diffStatsAgainstBase } from "../src/executor.ts";

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new TextDecoder().decode(proc.stdout).trim();
  const err = new TextDecoder().decode(proc.stderr).trim();
  return { ok: proc.exitCode === 0, out: out || err };
}

describe("diffStatsAgainstBase", () => {
  test("counts untracked new files against base commit", () => {
    const root = join(tmpdir(), `p7-diff-${Date.now()}`);
    mkdirSync(join(root, "docs"), { recursive: true });
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "t@test"]);
      git(root, ["config", "user.name", "t"]);
      writeFileSync(join(root, "README.md"), "base\n");
      git(root, ["add", "README.md"]);
      git(root, ["commit", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]).out;

      writeFileSync(join(root, "docs/new.md"), "line1\nline2\nline3\n");
      expect(diffStatsAgainstBase(root, base)).toEqual({ files: 1, lines: 4 });
      expect(git(root, ["diff", base, "--stat"]).out).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
