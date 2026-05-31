import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { DevAgentConfig } from "../src/config.ts";
import { createWorktree, removeWorktree, resolveWorkBranch } from "../src/worktree.ts";

function minimalCfg(workBranch?: string): DevAgentConfig {
  return {
    initial_goal: "test",
    auto_select_goal: false,
    loop_planning: false,
    allow_to_main: false,
    auto_approve: {
      enabled: false,
      diff_lines_max: 300,
      files_max: 5,
      risks_max: 5,
    },
    execution_cost_limit: 5,
    execution_timeout_minutes: 35,
    diff_critic: {
      tolerated_files: [],
      max_diff_multiplier: 1.5,
      max_diff_ceiling: 300,
      max_files_ceiling: 5,
    },
    vcs: {
      enabled: true,
      provider: "auto",
      create_issue: false,
      create_pr: true,
      auto_merge: false,
      auto_review: true,
      merge_resolve_conflicts: true,
      merge_wait_minutes: 20,
      review_open_prs: true,
      pr_review_interval_minutes: 15,
      pr_review_fast_interval_minutes: 8,
      pr_review_only_p7_label: false,
      block_new_work_until_prs_clear: true,
      block_new_work_only_conflicting: true,
      work_branch: workBranch,
      reviewers: [],
      labels: ["p7"],
      accounts: [],
    },
    discovery: {
      enabled: false,
      hn_limit: 25,
      github_limit: 15,
      theme_count: 5,
      auto_refresh_roadmap: false,
      auto_plan_after_refresh: false,
      auto_execute_after_approve: false,
      allow_template_fallback: false,
    },
    max_pending_plans: 5,
    max_consecutive_failures: 3,
  };
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(proc.stdout).trim();
  const err = new TextDecoder().decode(proc.stderr).trim();
  return { ok: proc.exitCode === 0, out: out || err };
}

describe("resolveWorkBranch", () => {
  test("returns null when unset", () => {
    expect(resolveWorkBranch(minimalCfg())).toBeNull();
    expect(resolveWorkBranch(minimalCfg("  "))).toBeNull();
  });

  test("returns trimmed branch name", () => {
    expect(resolveWorkBranch(minimalCfg("  p7/dev  "))).toBe("p7/dev");
  });
});

describe("createWorktree reuse", () => {
  test("creates and reuses fixed branch worktree", () => {
    const root = join(tmpdir(), `p7-wt-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "p7@test"]);
      git(root, ["config", "user.name", "p7"]);
      git(root, ["commit", "--allow-empty", "-m", "init"]);
      const cfg = minimalCfg("p7/dev");
      const base = git(root, ["rev-parse", "HEAD"]).out;
      const wt1 = createWorktree(root, base, cfg);
      expect(wt1.branch).toBe("p7/dev");
      removeWorktree(root, wt1, true, { keepBranch: true });
      const wt2 = createWorktree(root, base, cfg);
      expect(wt2.branch).toBe("p7/dev");
      expect(wt2.path).toBe(wt1.path);
      removeWorktree(root, wt2, true, { keepBranch: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
