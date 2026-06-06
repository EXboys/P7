import type { PlanStateStatus } from "./types.ts";

export const PLAN_STATE_STATUSES: PlanStateStatus[] = [
  "planned",
  "pending_approval",
  "approved",
  "rejected",
  "executing",
  "pushed",
  "pr_opened",
  "merged",
  "failed",
];

export type BackpressureEventType =
  | "degradation"
  | "retry_backoff"
  | "cost_limit_hit"
  | "execution_recovery";

export interface BackpressureEvent {
  type: BackpressureEventType;
  timestamp: string;
  detail: string;
  attempt?: number;
  delayMs?: number;
  limitUsd?: number;
  actualUsd?: number;
}
