export type {
  JobKind,
  JobRow,
  JobStatus,
  StepState,
} from "../../src/job-types.ts";

export interface DailyJobPayload {
  projectPath: string;
  goal?: string;
  planOnly?: boolean;
  /** 跳过 HN/GitHub 抓取，仅从 Roadmap 生成 Plan（管道停滞恢复） */
  recoverStall?: boolean;
}

export interface ExecuteJobPayload {
  projectPath: string;
  planId: string;
}

export interface PrReviewJobPayload {
  projectPath: string;
}

export type JobPayload = DailyJobPayload | ExecuteJobPayload | PrReviewJobPayload;
