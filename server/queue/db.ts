import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { JobKind, JobRow, JobStatus, StepState } from "./types.ts";
import { resolveP7HomeDir } from "../../src/p7-paths.ts";

function dbPath(): string {
  return join(resolveP7HomeDir(), "jobs.db");
}

let db: Database | null = null;

function getDb(): Database {
  if (!db) {
    const dir = resolveP7HomeDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new Database(dbPath());
    db.run(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      project_alias TEXT NOT NULL,
      owner_user_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      progress TEXT,
      result_json TEXT,
      error TEXT,
      step_states TEXT
    )`);
  }
  return db;
}

export function enqueueJob(opts: {
  kind: JobKind;
  payload: unknown;
  projectAlias: string;
  ownerUserId?: string;
}): JobRow {
  const d = getDb();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created_at = new Date().toISOString();
  d.run(
    `INSERT INTO jobs (id, kind, payload, status, project_alias, owner_user_id, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    [id, opts.kind, JSON.stringify(opts.payload), opts.projectAlias, opts.ownerUserId ?? null, created_at],
  );
  return getJob(id)!;
}

export function getJob(id: string): JobRow | null {
  const row = getDb().query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
  return row ?? null;
}

export function claimNextJob(excludeAliases: string[] = []): JobRow | null {
  const d = getDb();
  const running = d
    .query("SELECT project_alias FROM jobs WHERE status = 'running'")
    .all() as { project_alias: string }[];
  const busy = new Set([...running.map((r) => r.project_alias), ...excludeAliases]);

  const pending = d
    .query("SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as JobRow[];

  for (const job of pending) {
    if (busy.has(job.project_alias)) continue;
    d.run(
      `UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'`,
      [new Date().toISOString(), job.id],
    );
    return getJob(job.id);
  }
  return null;
}

export function finishJob(
  id: string,
  status: "done" | "failed",
  result?: unknown,
  error?: string,
): void {
  getDb().run(
    `UPDATE jobs SET status = ?, finished_at = ?, result_json = ?, error = ? WHERE id = ?`,
    [status, new Date().toISOString(), result ? JSON.stringify(result) : null, error ?? null, id],
  );
}

export function updateJobStepStates(planId: string, stepStates: StepState[]): void {
  getDb().run(
    `UPDATE jobs SET step_states = ? WHERE status = 'running' AND json_extract(payload, '$.planId') = ?`,
    [JSON.stringify(stepStates), planId],
  );
}

export function reclaimStaleJobs(maxRunMs: number): JobRow[] {
  const d = getDb();
  const cutoff = new Date(Date.now() - maxRunMs).toISOString();
  const stale = d
    .query("SELECT * FROM jobs WHERE status = 'running' AND started_at < ?")
    .all(cutoff) as JobRow[];
  for (const job of stale) {
    finishJob(job.id, "failed", null, "stale job reclaimed after restart");
  }
  return stale;
}

export function listJobsForProject(alias: string, limit = 50): JobRow[] {
  return getDb()
    .query("SELECT * FROM jobs WHERE project_alias = ? ORDER BY created_at DESC LIMIT ?")
    .all(alias, limit) as JobRow[];
}

export function listAllJobs(limit = 200): JobRow[] {
  return getDb()
    .query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as JobRow[];
}

export function countTodayJobs(): number {
  const day = new Date().toISOString().slice(0, 10);
  const row = getDb()
    .query("SELECT COUNT(*) as c FROM jobs WHERE created_at LIKE ?")
    .get(`${day}%`) as { c: number };
  return row.c;
}

export function lastConsecutiveFailures(alias: string, n: number): number {
  const rows = getDb()
    .query(
      "SELECT status FROM jobs WHERE project_alias = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(alias, n) as { status: JobStatus }[];
  let count = 0;
  for (const r of rows) {
    if (r.status === "failed") count++;
    else break;
  }
  return count;
}

/** Skip scheduler enqueue if a daily/discover job is active or already succeeded today. Failed jobs allow retry. */
export function hasPendingDailyToday(alias: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const prefix = `${day}%`;
  const active = getDb()
    .query(
      `SELECT COUNT(*) as c FROM jobs WHERE project_alias = ? AND kind IN ('daily', 'discover-daily') AND created_at LIKE ? AND status IN ('pending', 'running')`,
    )
    .get(alias, prefix) as { c: number };
  if (active.c > 0) return true;
  const done = getDb()
    .query(
      `SELECT COUNT(*) as c FROM jobs WHERE project_alias = ? AND kind IN ('daily', 'discover-daily') AND created_at LIKE ? AND status = 'done'`,
    )
    .get(alias, prefix) as { c: number };
  return done.c > 0;
}

export function sumTodayJobCostUsd(alias: string): number {
  const day = new Date().toISOString().slice(0, 10);
  const rows = getDb()
    .query(
      `SELECT result_json FROM jobs WHERE project_alias = ? AND created_at LIKE ? AND status = 'done'`,
    )
    .all(alias, `${day}%`) as { result_json: string | null }[];
  let sum = 0;
  for (const row of rows) {
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
  const row = getDb()
    .query(
      `SELECT COUNT(*) as c FROM jobs WHERE project_alias = ? AND status IN ('pending', 'running')`,
    )
    .get(alias) as { c: number };
  return row.c > 0;
}
