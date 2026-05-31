import type { JobKind, JobRow } from "./types.ts";

/**
 * Runtime-agnostic job store. Uses bun:sqlite when running under Bun,
 * otherwise falls back to a JSON-file store so the admin dashboard and
 * CLI work under plain Node (tsx).
 */

export interface JobStore {
  enqueueJob(opts: {
    kind: JobKind;
    payload: unknown;
    projectAlias: string;
    ownerUserId?: string;
  }): JobRow;
  getJob(id: string): JobRow | null;
  claimNextJob(excludeAliases?: string[]): JobRow | null;
  finishJob(id: string, status: "done" | "failed", result?: unknown, error?: string): void;
  updateJobProgress(id: string, progress: string): void;
  reclaimOrphanedRunningJobs(): JobRow[];
  reclaimStaleJobs(maxRunMs: number): JobRow[];
  listJobsForProject(alias: string, limit?: number): JobRow[];
  listAllJobs(limit?: number): JobRow[];
  countTodayJobs(): number;
  lastConsecutiveFailures(alias: string, n: number): number;
  hasPendingDailyToday(alias: string): boolean;
  hasActiveJob(alias: string): boolean;
  hasActiveExecuteJob(alias: string): boolean;
  hasProjectMutexInFlight(alias: string, exceptKind?: JobKind): boolean;
  hasPrReviewInFlight(alias: string): boolean;
  getLastPrReviewJob(alias: string): JobRow | null;
  hasRecentPrReviewJob(alias: string, intervalMinutes: number): boolean;
  sumTodayJobCostUsd(alias: string): number;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

const impl: JobStore = isBun
  ? ((await import("./db.ts")) as unknown as JobStore)
  : ((await import("./json-store.ts")) as unknown as JobStore);

export const enqueueJob = impl.enqueueJob;
export const getJob = impl.getJob;
export const claimNextJob = impl.claimNextJob;
export const finishJob = impl.finishJob;
export const updateJobProgress = impl.updateJobProgress;
export const reclaimOrphanedRunningJobs = impl.reclaimOrphanedRunningJobs;
export const reclaimStaleJobs = impl.reclaimStaleJobs;
export const listJobsForProject = impl.listJobsForProject;
export const listAllJobs = impl.listAllJobs ?? (() => []);
export const countTodayJobs = impl.countTodayJobs;
export const lastConsecutiveFailures = impl.lastConsecutiveFailures;
export const hasPendingDailyToday = impl.hasPendingDailyToday;
export const hasActiveJob = impl.hasActiveJob;
export const hasActiveExecuteJob =
  impl.hasActiveExecuteJob ?? ((_alias: string) => false);
export const hasProjectMutexInFlight =
  impl.hasProjectMutexInFlight ?? ((_alias: string) => false);
export const hasPrReviewInFlight =
  impl.hasPrReviewInFlight ?? ((_alias: string) => false);
export const getLastPrReviewJob =
  impl.getLastPrReviewJob ?? ((_alias: string) => null);
export const hasRecentPrReviewJob =
  impl.hasRecentPrReviewJob ?? ((_alias: string, _intervalMinutes: number) => false);
export const sumTodayJobCostUsd = impl.sumTodayJobCostUsd ?? (() => 0);
