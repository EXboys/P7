export interface StepState {
  step_name: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  finished_at?: string;
  error?: string;
}

export type JobKind =
  | "daily"
  | "discover-daily"
  | "pr-review"
  | "plan"
  | "execute"
  | "quickfix"
  | "initialize";

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface JobRow {
  id: string;
  kind: JobKind;
  payload: string;
  status: JobStatus;
  project_alias: string;
  owner_user_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: string | null;
  result_json: string | null;
  error: string | null;
  step_states?: string;
}

export interface DailyJobPayload {
  projectPath: string;
  goal?: string;
  planOnly?: boolean;
}

export interface ExecuteJobPayload {
  projectPath: string;
  planId: string;
}

export interface PrReviewJobPayload {
  projectPath: string;
}

export type JobPayload = DailyJobPayload | ExecuteJobPayload | PrReviewJobPayload;
