import { z } from "zod";
import type { SdkTokenUsage } from "./sdk-cost.ts";

export const PlanSchema = z.object({
  /** English — commit / PR / Issue title on GitHub */
  title: z.string().min(1).max(120),
  /** Chinese — admin console display */
  title_zh: z.string().min(1).max(80).optional(),
  /** English — GitHub PR / Issue body */
  motivation: z.string().min(1),
  /** Chinese — admin console display */
  motivation_zh: z.string().min(1).optional(),
  complexity: z.enum(["simple", "medium", "complex"]).optional(),
  changes: z
    .array(
      z.object({
        file: z.string().min(1),
        /** English — GitHub PR body */
        description: z.string().min(1),
        /** Chinese — admin console display */
        description_zh: z.string().min(1).optional(),
        estimated_lines: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(20),
  /** English — GitHub PR body */
  risks: z.array(z.string()),
  /** Chinese — admin console display */
  risks_zh: z.array(z.string()).optional(),
  validation: z.string().min(1),
  estimated_diff_lines: z.number().int().nonnegative().max(1000),
  critique_notes: z.array(z.string()).optional(),
  baseCommit: z.string().optional(),
});

export type Plan = z.infer<typeof PlanSchema>;

export const GoalSelectionSchema = z.object({
  today_goal: z.string().min(1),
  reasoning: z.string().min(1),
  alternatives: z.array(z.string()).optional(),
});

export type GoalSelection = z.infer<typeof GoalSelectionSchema>;

export interface GitCommit {
  hash: string;
  date: string;
  subject: string;
}

export interface ProjectScan {
  path: string;
  scannedAt: string;
  techStack: {
    languages: string[];
    packageManagers: string[];
    frameworks: string[];
    manifests: string[];
  };
  git: {
    branch: string;
    remoteUrl: string | null;
    recentCommits: GitCommit[];
    uncommittedChanges: number;
  } | null;
  todos: {
    file: string;
    line: number;
    kind: "TODO" | "FIXME" | "HACK" | "XXX";
    text: string;
  }[];
  fileSummary: {
    totalFiles: number;
    byExtension: Record<string, number>;
    topLevelEntries: string[];
  };
  readme: string | null;
}

export interface ExecutionResult {
  ok: boolean;
  branch?: string;
  commitSha?: string;
  reviewUrl?: string;
  /** Sandbox preview URL pointing to the dashboard server serving worktree content */
  previewUrl?: string;
  prUrl?: string;
  issueUrl?: string;
  mergeStatus?: "not_requested" | "queued" | "merged" | "failed" | "skipped";
  accountResults?: VcsAccountPublishResult[];
  costUsd?: number;
  tokenUsage?: SdkTokenUsage;
  durationSec?: number;
  error?: string;
  worktreePath?: string;
}

export interface ApprovalRecord {
  planId: string;
  projectPath: string;
  status: "pending" | "approved" | "rejected";
  plan: Plan;
  goal: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface PlanRecord {
  planId: string;
  projectPath: string;
  goal: string;
  plan: Plan;
  createdAt: string;
}

export type PlanStateStatus =
  | "planned"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "pushed"
  | "pr_opened"
  | "merged"
  | "failed";

export interface PlanState {
  planId: string;
  projectPath: string;
  goal: string;
  title: string;
  status: PlanStateStatus;
  createdAt: string;
  updatedAt: string;
  branch?: string;
  commitSha?: string;
  reviewUrl?: string;
  prUrl?: string;
  issueUrl?: string;
  mergeStatus?: ExecutionResult["mergeStatus"];
  accountResults?: VcsAccountPublishResult[];
  costUsd?: number;
  tokenUsage?: SdkTokenUsage;
  error?: string;
  findings?: string;
  diffCriticFindings?: string;
}

export interface VcsAccountPublishResult {
  accountId: string;
  ok: boolean;
  branch?: string;
  prUrl?: string;
  issueUrl?: string;
  mergeStatus?: ExecutionResult["mergeStatus"];
  warning?: string;
}

export interface TechSignal {
  source: "hn" | "github";
  title: string;
  url: string;
  score?: number;
  tags: string[];
  summary?: string;
}

export interface TechDiscoverySnapshot {
  date: string;
  fetchedAt: string;
  signals: TechSignal[];
  themes: string[];
  summary: string;
}

export interface DiscoveryDailyResult {
  date: string;
  snapshotPath: string;
  signalCount: number;
  themes: string[];
  roadmapRefreshed: boolean;
  planId?: string;
  goal?: string;
  phase: string;
  error?: string;
}

export type DcSeverity = "info" | "warning" | "blocker";

export interface DiffCriticFinding {
  dimension: string;
  severity: DcSeverity;
  message: string;
  prefix?: string;
  file?: string;
  line?: number;
  code?: string;
}

/* ── Gradual type-check config types ── */

/**
 * Re-exported from `gradual-typecheck-config.ts` for convenience.
 * Protocol: ordered rules with glob patterns and per-flag strict-mode overrides.
 * First-match-wins semantics; empty rules = fall back to tsconfig defaults.
 */
export type { GradualTypeCheckRule, GradualTypeCheckConfig, TscStrictFlag } from "./gradual-typecheck-config.ts";

/* ── Type coverage dashboard types ── */

/**
 * Per-file resolved type-check strictness information for dashboard display.
 * `matchedRule` is the glob pattern of the matched GradualTypeCheckRule,
 * or `null` if no rule matched (tsconfig defaults apply).
 * `resolvedFlags` maps each strict-mode flag to its effective boolean value
 * for this file based on the matched rule's overrides.
 */
export interface TypeCoverageFileEntry {
  filePath: string;
  matchedRule: string | null;
  resolvedFlags: Record<string, boolean>;
}

/**
 * Aggregated type coverage statistics across all scanned source files.
 *
 * - strictFiles: count of files whose matched rule has all flags set to `true`
 * - partialFiles: count of files whose matched rule has a mix of `true`/`false`
 * - defaultFiles: count of files matching no rule (tsconfig defaults apply)
 * - perFlagCounts: how many files have each flag enabled (value === true)
 */
export interface TypeCoverageStats {
  totalFiles: number;
  strictFiles: number;
  partialFiles: number;
  defaultFiles: number;
  perFlagCounts: Record<string, number>;
}

/**
 * Type coverage report combining config-derived strictness with optional
 * typecheck execution error data. `source` identifies the data origin.
 */
export interface TypeCoverageReport {
  source: "config" | "execution" | "merged";
  stats: TypeCoverageStats;
  files: TypeCoverageFileEntry[];
  /** Per-file type error counts from tsc execution output */
  perFileErrors?: Record<string, number>;
  /** Total number of type errors across all files */
  totalErrors?: number;
}
