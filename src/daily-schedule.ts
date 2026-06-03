import type { JobRow } from "../server/queue/types.ts";

export function isRecoverStallPayload(payload: string): boolean {
  try {
    return !!(JSON.parse(payload) as { recoverStall?: boolean }).recoverStall;
  } catch {
    return false;
  }
}

export function isDailyKind(kind: string): boolean {
  return kind === "daily" || kind === "discover-daily";
}

export function jobCreatedToday(createdAt: string): boolean {
  return createdAt.startsWith(new Date().toISOString().slice(0, 10));
}

/** 今日是否有 pending/running 的 daily / discover-daily */
export function filterActiveDailyToday(jobs: JobRow[]): boolean {
  return jobs.some(
    (j) =>
      isDailyKind(j.kind) &&
      jobCreatedToday(j.created_at) &&
      (j.status === "pending" || j.status === "running"),
  );
}

/** 今日是否已完成「常规」discover（不含 recoverStall） */
export function filterCompletedFullDailyToday(jobs: JobRow[]): boolean {
  return jobs.some(
    (j) =>
      isDailyKind(j.kind) &&
      jobCreatedToday(j.created_at) &&
      j.status === "done" &&
      !isRecoverStallPayload(j.payload),
  );
}
