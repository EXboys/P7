import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { p7ProjectDir, projectDataDirForRead } from "./p7-paths.ts";
import { TSC_STRICT_FLAGS } from "./gradual-typecheck-config.ts";

/* ── Gradual type-check config schema ── */

const tscStrictFlagValues = Object.keys(TSC_STRICT_FLAGS) as [string, ...string[]];
const TscStrictFlagEnum = z.enum(tscStrictFlagValues);

/**
 * Zod schema for a single gradual type-check rule.
 * Declares a glob pattern with strict-flag overrides (first-match-wins).
 */
export const GradualTypeCheckRuleSchema = z.object({
  pattern: z.string().min(1),
  flags: z.record(TscStrictFlagEnum, z.boolean()).optional().default({}),
});

export type GradualTypeCheckRule = z.infer<typeof GradualTypeCheckRuleSchema>;

/** Predefined strictness levels for progressive milestones. */
export const StrictnessLevelEnum = z.enum(["loose", "moderate", "strict", "full"]);
export type StrictnessLevel = z.infer<typeof StrictnessLevelEnum>;

/**
 * Zod schema for a single strictness target milestone.
 * Declares a glob pattern with target level, optional per-flag overrides,
 * and optional milestone/note annotations.
 */
export const TypeStrictnessTargetSchema = z.object({
  pattern: z.string().min(1),
  targetLevel: StrictnessLevelEnum,
  targetFlags: z.record(TscStrictFlagEnum, z.boolean()).optional(),
  milestone: z.string().optional(),
  note: z.string().optional(),
});

export type TypeStrictnessTarget = z.infer<typeof TypeStrictnessTargetSchema>;

export const DevAgentConfigSchema = z.object({
  initial_goal: z.string().min(1),
  auto_select_goal: z.boolean().default(false),
  loop_planning: z.boolean().default(true),
  allow_to_main: z.boolean().default(false),
  auto_approve: z
    .object({
      enabled: z.boolean().default(true),
      diff_lines_max: z.number().int().nonnegative().default(300),
      files_max: z.number().int().nonnegative().default(5),
      risks_max: z.number().int().nonnegative().default(5),
    })
    .default({
      enabled: true,
      diff_lines_max: 300,
      files_max: 5,
      risks_max: 5,
    }),
  execution_cost_limit: z.number().min(0.5).default(5),
  goal_cost_limit: z.number().min(0.5).default(5),
  execution_timeout_minutes: z.number().min(1).default(35),
  test_command: z.string().optional(),
  diff_critic: z
    .object({
      tolerated_files: z.array(z.string()).default([]),
      max_diff_multiplier: z.number().default(1.5),
      max_diff_ceiling: z.number().int().nonnegative().default(1000),
      max_files_ceiling: z.number().int().nonnegative().default(8),
      diff_filter: z
        .object({
          enabled: z.boolean().default(true),
          strip_format_noise: z.boolean().default(true),
          strip_comment_only: z.boolean().default(true),
          strip_boilerplate: z.boolean().default(true),
          max_hunk_lines: z.number().int().nonnegative().default(200),
        })
        .default({
          enabled: true,
          strip_format_noise: true,
          strip_comment_only: true,
          strip_boilerplate: true,
          max_hunk_lines: 200,
        }),
      pre_check: z
        .object({
          enabled: z.boolean().default(true),
          block_on_scope_violation: z.boolean().default(true),
          block_on_size_anomaly: z.boolean().default(true),
          block_on_security_red_flag: z.boolean().default(true),
          block_on_unsafe_eval: z.boolean().default(true),
          block_on_shell_injection: z.boolean().default(true),
          block_on_prompt_injection_risk: z.boolean().default(true),
          block_on_unsafe_exec: z.boolean().default(true),
          block_on_unsafe_inner_html: z.boolean().default(true),
        })
        .default({
          enabled: true,
          block_on_scope_violation: true,
          block_on_size_anomaly: true,
          block_on_security_red_flag: true,
          block_on_unsafe_eval: true,
          block_on_shell_injection: true,
          block_on_prompt_injection_risk: true,
          block_on_unsafe_exec: true,
          block_on_unsafe_inner_html: true,
        }),
    })
    .default({
      tolerated_files: [],
      max_diff_multiplier: 1.5,
      max_diff_ceiling: 1000,
      max_files_ceiling: 8,
      diff_filter: {
        enabled: true,
        strip_format_noise: true,
        strip_comment_only: true,
        strip_boilerplate: true,
        max_hunk_lines: 200,
      },
      pre_check: {
        enabled: true,
        block_on_scope_violation: true,
        block_on_size_anomaly: true,
        block_on_security_red_flag: true,
        block_on_unsafe_eval: true,
        block_on_shell_injection: true,
        block_on_prompt_injection_risk: true,
        block_on_unsafe_exec: true,
        block_on_unsafe_inner_html: true,
      },
    }),
  vcs: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.enum(["auto", "github", "none"]).default("auto"),
      create_issue: z.boolean().default(false),
      create_pr: z.boolean().default(true),
      auto_merge: z.boolean().default(false),
      auto_review: z.boolean().default(true),
      merge_resolve_conflicts: z.boolean().default(true),
      merge_wait_minutes: z.number().int().positive().default(20),
      /** 冲突修复 Agent 最大轮次（默认 100，与 executor 同量级偏宽松） */
      merge_conflict_max_turns: z.number().int().positive().default(100),
      /** 单轮 merge 内 Agent 重试次数 */
      merge_conflict_passes: z.number().int().positive().default(3),
      /** 修冲突时的等待上限（分钟）；默认可跑满 90 分钟 */
      merge_conflict_wait_minutes: z.number().int().positive().optional(),
      review_open_prs: z.boolean().default(true),
      pr_review_interval_minutes: z.number().int().positive().default(15),
      pr_review_fast_interval_minutes: z.number().int().positive().default(8),
      pr_review_only_p7_label: z.boolean().default(false),
      block_new_work_until_prs_clear: z.boolean().default(true),
      block_new_work_only_conflicting: z.boolean().default(true),
      base_branch: z.string().optional(),
      /** 固定工作分支；设置后每次 Plan 复用该分支，不再新建 p7/时间戳 分支 */
      work_branch: z.string().optional(),
      reviewers: z.array(z.string()).default([]),
      labels: z.array(z.string()).default(["p7"]),
      /** round_robin：每次只选一个账号开 1 个 PR；all：每个账号各开 PR（旧行为） */
      account_pick_mode: z.enum(["round_robin", "all"]).default("round_robin"),
      /** 轮询模式下当前账号失败时尝试下一个 */
      account_failover: z.boolean().default(true),
      /** Review / approve / squash merge 专用主账号（与开 PR 的 accounts 分离） */
      review_merge_auth_type: z.enum(["gh", "token_env"]).default("gh"),
      review_merge_token_env: z.string().optional(),
      review_merge_gh_host: z.string().default("github.com"),
      accounts: z
        .array(
          z.object({
            id: z.string().min(1),
            provider: z.literal("github").default("github"),
            auth_type: z.enum(["gh", "token_env"]).default("gh"),
            token_env: z.string().optional(),
            gh_host: z.string().default("github.com"),
            create_issue: z.boolean().optional(),
            create_pr: z.boolean().optional(),
            auto_merge: z.boolean().optional(),
            reviewers: z.array(z.string()).optional(),
            labels: z.array(z.string()).optional(),
          }),
        )
        .default([]),
    })
    .default({
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
    }),
  discovery: z
    .object({
      enabled: z.boolean().default(true),
      hn_limit: z.number().int().positive().default(25),
      github_limit: z.number().int().positive().default(15),
      theme_count: z.number().int().positive().default(5),
      auto_refresh_roadmap: z.boolean().default(true),
      auto_plan_after_refresh: z.boolean().default(true),
      auto_execute_after_approve: z.boolean().default(true),
      allow_template_fallback: z.boolean().default(false),
      /** Roadmap 有未完成步骤且无待执行 Plan 时，调度器自动从 Roadmap 生成 Plan */
      auto_recover_stall: z.boolean().default(true),
      /** 每日完整 discover 次数上限；0 表示不按天限制，适合无人值守连续循环 */
      daily_run_limit: z.number().int().nonnegative().default(0),
    })
    .default({
      enabled: true,
      hn_limit: 25,
      github_limit: 15,
      theme_count: 5,
      auto_refresh_roadmap: true,
      auto_plan_after_refresh: true,
      auto_execute_after_approve: true,
      allow_template_fallback: false,
      auto_recover_stall: true,
      daily_run_limit: 0,
    }),
  allowed_api_domains: z.array(z.string()).default(["api.anthropic.com"]),
  max_pending_plans: z.number().int().positive().default(5),
  max_consecutive_failures: z.number().int().positive().default(3),
  execution_retry: z
    .object({
      max_retries: z.number().int().nonnegative().default(3),
      initial_delay_ms: z.number().int().positive().default(5000),
      max_delay_ms: z.number().int().positive().default(60000),
      pass_retry_delay_ms: z.number().int().positive().default(10000),
      max_concurrency: z.number().int().positive().default(2),
    })
    .default({
      max_retries: 3,
      initial_delay_ms: 5000,
      max_delay_ms: 60000,
      pass_retry_delay_ms: 10000,
      max_concurrency: 2,
    }),
  gradual_type_checking: z
    .object({
      rules: z.array(GradualTypeCheckRuleSchema).default([]),
    targets: z.array(TypeStrictnessTargetSchema).optional(),
    })
    .default({ rules: [], targets: undefined }),
});

export type DevAgentConfig = z.infer<typeof DevAgentConfigSchema>;

/** 读取仓库内数据根目录（兼容旧 `.dev-agent`） */
export function devAgentDir(projectPath: string): string {
  return projectDataDirForRead(projectPath);
}

export function configPath(projectPath: string): string {
  return join(projectDataDirForRead(projectPath), "config.json");
}

export function loadConfig(projectPath: string): DevAgentConfig {
  const path = configPath(projectPath);
  if (!existsSync(path)) {
    const defaults: DevAgentConfig = {
      initial_goal: "持续改进代码质量与可维护性",
      auto_select_goal: false,
      loop_planning: true,
      allow_to_main: false,
      auto_approve: {
        enabled: true,
        diff_lines_max: 300,
        files_max: 5,
        risks_max: 5,
      },
      execution_cost_limit: 5,
      goal_cost_limit: 5,
      execution_timeout_minutes: 35,
      diff_critic: {
        tolerated_files: [],
        max_diff_multiplier: 1.5,
        max_diff_ceiling: 1000,
        max_files_ceiling: 8,
        diff_filter: {
          enabled: true,
          strip_format_noise: true,
          strip_comment_only: true,
          strip_boilerplate: true,
          max_hunk_lines: 200,
        },
        pre_check: {
          enabled: true,
          block_on_scope_violation: true,
          block_on_size_anomaly: true,
          block_on_security_red_flag: true,
          block_on_unsafe_eval: true,
          block_on_shell_injection: true,
          block_on_prompt_injection_risk: true,
          block_on_unsafe_exec: true,
          block_on_unsafe_inner_html: true,
        },
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
        accounts: [],
        review_merge_auth_type: "gh",
        review_merge_gh_host: "github.com",
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
        daily_run_limit: 0,
      },
      allowed_api_domains: ["api.anthropic.com"],
      max_pending_plans: 5,
      max_consecutive_failures: 3,
      execution_retry: {
        max_retries: 3,
        initial_delay_ms: 5000,
        max_delay_ms: 60000,
        pass_retry_delay_ms: 10000,
        max_concurrency: 2,
      },
      gradual_type_checking: {
        rules: [],
      },
    };
    saveConfig(projectPath, defaults);
    return defaults;
  }
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return DevAgentConfigSchema.parse(raw);
}

export function saveConfig(projectPath: string, config: DevAgentConfig): void {
  const dir = p7ProjectDir(projectPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
}
