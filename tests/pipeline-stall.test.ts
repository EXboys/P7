import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectPipelineStall, hasRecentPipelineRecovery } from "../src/pipeline-stall.ts";
import { saveConfig } from "../src/config.ts";

function setupProject(roadmap: string): string {
  const root = join(tmpdir(), `p7-stall-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const p7 = join(root, ".p7");
  mkdirSync(p7, { recursive: true });
  writeFileSync(join(root, "ROADMAP.md"), roadmap);
  saveConfig(root, {
    initial_goal: "test goal",
    auto_select_goal: false,
    loop_planning: true,
    allow_to_main: false,
    auto_approve: { enabled: true, diff_lines_max: 300, files_max: 5, risks_max: 5 },
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
      block_new_work_until_prs_clear: false,
      block_new_work_only_conflicting: false,
      reviewers: [],
      labels: ["p7"],
      accounts: [],
    },
    discovery: {
      enabled: true,
      hn_limit: 25,
      github_limit: 15,
      theme_count: 5,
      auto_refresh_roadmap: true,
      auto_plan_after_refresh: true,
      auto_execute_after_approve: true,
      allow_template_fallback: false,
      auto_recover_stall: true,
    },
    max_pending_plans: 5,
    max_consecutive_failures: 3,
  });
  return root;
}

describe("pipeline stall recovery", () => {
  test("detects stall when roadmap has unchecked steps and no queue", () => {
    const root = setupProject(`# Roadmap
## Active
Feature: Test
- [ ] Do the next thing
## Backlog
## Done
`);
    try {
      const dc = { discovery: { auto_recover_stall: true } } as never;
      const stall = detectPipelineStall(root, dc);
      expect(stall?.reason).toBe("no_work_queue");
      expect(stall?.unfinishedSteps).toBe(1);
      expect(stall?.suggestedGoal).toBe("Do the next thing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null when auto_recover_stall is disabled", () => {
    const root = setupProject(`# Roadmap
## Active
- [ ] Step
## Backlog
## Done
`);
    try {
      const stall = detectPipelineStall(root, {
        discovery: { auto_recover_stall: false },
      } as never);
      expect(stall).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hasRecentPipelineRecovery is false without jobs", () => {
    expect(hasRecentPipelineRecovery(`alias-${Date.now()}`)).toBe(false);
  });
});
