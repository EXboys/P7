import { describe, expect, test } from "bun:test";
import {
  deriveConflictMaxTurns,
  mergeConflictWaitMinutes,
} from "../src/vcs/merge-conflict.ts";
import type { DevAgentConfig } from "../src/config.ts";

const baseVcs: DevAgentConfig["vcs"] = {
  enabled: true,
  provider: "auto",
  create_issue: false,
  create_pr: true,
  auto_merge: false,
  auto_review: true,
  merge_resolve_conflicts: true,
  merge_wait_minutes: 20,
  merge_conflict_max_turns: 100,
  merge_conflict_passes: 3,
  review_open_prs: true,
  pr_review_interval_minutes: 15,
  pr_review_fast_interval_minutes: 8,
  pr_review_only_p7_label: false,
  block_new_work_until_prs_clear: true,
  block_new_work_only_conflicting: true,
  reviewers: [],
  labels: ["p7"],
  account_pick_mode: "round_robin",
  account_failover: true,
  review_merge_auth_type: "gh",
  review_merge_gh_host: "github.com",
  accounts: [],
};

describe("deriveConflictMaxTurns", () => {
  test("scales with file count up to cap", () => {
    expect(deriveConflictMaxTurns(1, baseVcs)).toBe(50);
    expect(deriveConflictMaxTurns(3, baseVcs)).toBe(75);
    expect(deriveConflictMaxTurns(10, baseVcs)).toBe(100);
  });

  test("respects lower custom cap", () => {
    expect(deriveConflictMaxTurns(5, { ...baseVcs, merge_conflict_max_turns: 55 })).toBe(55);
  });
});

describe("mergeConflictWaitMinutes", () => {
  test("conflicting PR uses long wait", () => {
    expect(mergeConflictWaitMinutes(baseVcs, true)).toBe(90);
    expect(mergeConflictWaitMinutes({ ...baseVcs, merge_conflict_wait_minutes: 120 }, true)).toBe(
      120,
    );
  });

  test("clean PR keeps modest pr-review cap", () => {
    expect(mergeConflictWaitMinutes(baseVcs, false)).toBe(15);
  });
});
