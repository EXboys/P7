import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { JobKind, JobRow, JobStatus } from "./types.ts";
import { resolveP7HomeDir } from "../../src/p7-paths.ts";

/**
 * Node-safe job store backed by a JSON file. Mirrors the bun:sqlite store API
 * so the admin dashboard and CLI can run under plain Node (tsx) without bun.
 */

function storePath(): string {
  return join(resolveP7HomeDir(), "jobs.json");
}

function loadAll(): JobRow[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(raw) ? (raw as JobRow[]) : [];
  } catch {
    return [];
  }
}

function saveAll(rows: JobRow[]): void {
  const dir = resolveP7HomeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(storePath(), JSON.stringify(rows, null, 2));
}

export function enqueueJob(opts: {
  kind: JobKind;
  payload: unknown;
  projectAlias: string;
  ownerUserId?: string;
}): JobRow {
  const rows = loadAll();
  const row: JobRow = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: opts.kind,
    payload: JSON.stringify(opts.payload),
    status: "pending",
    project_alias: opts.projectAlias,
    owner_user_id: opts.ownerUserId ?? null,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    progress: null,
    result_json: null,
    error: null,
  };
  rows.push(row);
  saveAll(rows);
  return row;
}

export function getJob(id: string): JobRow | null {
  return loadAll().find((r) => r.id === id) ?? null;
}

export function claimNextJob(excludeAliases: string[] = []): JobRow | null {
  const rows = loadAll();
  const busy = new Set([
    ...rows.filter((r) => r.status === "running").map((r) => r.project_alias),
    ...excludeAliases,
  ]);
  const pending = rows
    .filter((r) => r.status === "pending")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const job of pending) {
    if (busy.has(job.project_alias)) continue;
    job.status = "running";
    job.started_at = new Date().toISOString();
    saveAll(rows);
    return job;
  }
  return null;
}

export function finishJob(
  id: string,
  status: "done" | "failed",
  result?: unknown,
  error?: string,
): void {
  const rows = loadAll();
  const job = rows.find((r) => r.id === id);
  if (!job) return;
  job.status = status;
  job.finished_at = new Date().toISOString();
  job.result_json = result ? JSON.stringify(result) : null;
  job.error = error ?? null;
  saveAll(rows);
}

export function reclaimStaleJobs(maxRunMs: number): JobRow[] {
  const rows = loadAll();
  const cutoff = Date.now() - maxRunMs;
  const stale = rows.filter(
    (r) => r.status === "running" && r.started_at && new Date(r.started_at).getTime() < cutoff,
  );
  for (const job of stale) {
    job.status = "failed";
    job.finished_at = new Date().toISOString();
    job.error = "stale job reclaimed after restart";
  }
  if (stale.length) saveAll(rows);
  return stale;
}

export function listJobsForProject(alias: string, limit = 50): JobRow[] {
  return loadAll()
    .filter((r) => r.project_alias === alias)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export function listAllJobs(limit = 200): JobRow[] {
  return loadAll()
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export function countTodayJobs(): number {
  const day = new Date().toISOString().slice(0, 10);
  return loadAll().filter((r) => r.created_at.startsWith(day)).length;
}

export function lastConsecutiveFailures(alias: string, n: number): number {
  const rows = loadAll()
    .filter((r) => r.project_alias === alias)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, n);
  let count = 0;
  for (const r of rows) {
    if (r.status === "failed") count++;
    else break;
  }
  return count;
}

export function hasPendingDailyToday(alias: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const daily = (r: JobRow) =>
    r.project_alias === alias &&
    (r.kind === "daily" || r.kind === "discover-daily") &&
    r.created_at.startsWith(day);
  if (loadAll().some((r) => daily(r) && (r.status === "pending" || r.status === "running"))) {
    return true;
  }
  return loadAll().some((r) => daily(r) && r.status === "done");
}

export function sumTodayJobCostUsd(alias: string): number {
  const day = new Date().toISOString().slice(0, 10);
  let sum = 0;
  for (const row of loadAll()) {
    if (row.project_alias !== alias || !row.created_at.startsWith(day) || row.status !== "done") {
      continue;
    }
    if (!row.result_json) continue;
    try {
      const r = JSON.parse(row.result_json) as { costUsd?: number };
      if (typeof r.costUsd === "number") sum += r.costUsd;
    } catch {
      /* ignore */
    }
  }
  return sum;
}

export function hasActiveJob(alias: string): boolean {
  return loadAll().some(
    (r) => r.project_alias === alias && (r.status === "pending" || r.status === "running"),
  );
}

export type { JobKind, JobRow, JobStatus };
