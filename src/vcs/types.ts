import type { DevAgentConfig } from "../config.ts";
import type { Plan, VcsAccountPublishResult } from "../types.ts";

export interface VcsPublishInput {
  projectPath: string;
  remoteUrl: string | null;
  branch: string;
  commitSha: string;
  plan: Plan;
  config: DevAgentConfig;
}

export interface VcsPublishResult {
  reviewUrl?: string;
  prUrl?: string;
  issueUrl?: string;
  mergeStatus?:
    | "not_requested"
    | "queued"
    | "merged"
    | "failed"
    | "skipped"
    | "pending_checks"
    | "behind"
    | "merge_blocked"
    | "closed";
  accountResults?: VcsAccountPublishResult[];
  warning?: string;
}

export interface VcsProvider {
  canHandle(remoteUrl: string | null): boolean;
  publish(input: VcsPublishInput): Promise<VcsPublishResult>;
}
