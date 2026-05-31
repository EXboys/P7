import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { p7ProjectDir, projectDataDirForRead } from "./p7-paths.ts";

export const DevAgentConfigSchema = z.object({
  initial_goal: z.string().min(1),
  auto_select_goal: z.boolean().default(false),
  loop_planning: z.boolean().default(true),
  allow_to_main: z.boolean().default(false),
  auto_approve: z
    .object({
      enabled: z.boolean().default(true),
      diff_lines_max: z.number().int().positive().default(300),
      files_max: z.number().int().positive().default(5),
      risks_max: z.number().int().nonnegative().default(5),
    })
    .default({
      enabled: true,
      diff_lines_max: 300,
      files_max: 5,
      risks_max: 5,
    }),
  execution_cost_limit: z.number().min(0.5).default(5),
  execution_timeout_minutes: z.number().min(1).default(35),
  test_command: z.string().optional(),
  diff_critic: z
    .object({
      tolerated_files: z.array(z.string()).default([]),
      max_diff_multiplier: z.number().default(1.5),
      max_diff_ceiling: z.number().int().default(300),
      max_files_ceiling: z.number().int().default(5),
    })
    .default({
      tolerated_files: [],
      max_diff_multiplier: 1.5,
      max_diff_ceiling: 300,
      max_files_ceiling: 5,
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
      review_open_prs: z.boolean().default(true),
      pr_review_interval_minutes: z.number().int().positive().default(15),
      pr_review_fast_interval_minutes: z.number().int().positive().default(8),
      pr_review_only_p7_label: z.boolean().default(false),
      block_new_work_until_prs_clear: z.boolean().default(true),
      block_new_work_only_conflicting: z.boolean().default(true),
      base_branch: z.string().optional(),
      reviewers: z.array(z.string()).default([]),
      labels: z.array(z.string()).default(["p7"]),
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
      review_open_prs: true,
      pr_review_interval_minutes: 15,
      pr_review_fast_interval_minutes: 8,
      pr_review_only_p7_label: false,
      block_new_work_until_prs_clear: true,
      block_new_work_only_conflicting: true,
      reviewers: [],
      labels: ["p7"],
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
    }),
  max_pending_plans: z.number().int().positive().default(5),
  max_consecutive_failures: z.number().int().positive().default(3),
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
      },
      max_pending_plans: 5,
      max_consecutive_failures: 3,
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
