import { z } from "zod";
import type { SdkTokenUsage } from "./sdk-cost.ts";

export const PlanSchema = z.object({
  title: z.string().min(1).max(120),
  motivation: z.string().min(1),
  complexity: z.enum(["simple", "medium", "complex"]).optional(),
  changes: z
    .array(
      z.object({
        file: z.string().min(1),
        description: z.string().min(1),
        estimated_lines: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(5),
  risks: z.array(z.string()),
  validation: z.string().min(1),
  estimated_diff_lines: z.number().int().nonnegative().max(200),
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
