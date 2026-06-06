import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { JobKind, JobRow, JobStatus, StepState } from "./types.ts";
import { jobBlockedByRunning, PROJECT_MUTEX_KINDS } from "./project-mutex.ts";

export { jobBlockedByRunning } from "./project-mutex.ts";
import { resolveP7HomeDir } from "../../src/p7-paths.ts";
import {
  countCompletedFullDailyToday,
  filterActiveDailyToday,
  filterCompletedFullDailyToday,
} from "../../src/daily-schedule.ts";

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
    // Enable WAL mode for concurrent read/write access
    db.run("PRAGMA journal_mode=WAL");
    // Migration: add step_states column to existing databases
    try {
      db.run("ALTER TABLE jobs ADD COLUMN step_states TEXT");
    } catch {
      // column already exists, ignore
    }
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

function runningKindsByAlias(d: Database): Map<string, Set<JobKind>> {
  const rows = d
    .query("SELECT project_alias, kind FROM jobs WHERE status = 'running'")
    .all() as { project_alias: string; kind: JobKind }[];
  const map = new Map<string, Set<JobKind>>();
  for (const r of rows) {
    let s = map.get(r.project_alias);
    if (!s) {
      s = new Set();
      map.set(r.project_alias, s);
    }
    s.add(r.kind);
  }
  return map;
}

export function claimNextJob(excludeAliases: string[] = []): JobRow | null {
  const d = getDb();
  const running = runningKindsByAlias(d);
  for (const a of excludeAliases) {
    let s = running.get(a);
    if (!s) {
      s = new Set();
      running.set(a, s);
    }
    s.add("execute");
  }

  const pending = d
    .query("SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as JobRow[];

  for (const job of pending) {
    if (jobBlockedByRunning(job.project_alias, job.kind, running)) continue;
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
    `UPDATE jobs SET status = ?, finished_at = ?, result_json = ?, error = ?, progress = NULL WHERE id = ?`,
    [status, new Date().toISOString(), result ? JSON.stringify(result) : null, error ?? null, id],
  );
}

export function updateJobProgress(id: string, progress: string): void {
  getDb().run(`UPDATE jobs SET progress = ? WHERE id = ?`, [progress.slice(0, 200), id]);
}

/** 服务重启后：所有仍为 running 的任务不可能还在跑，一律标失败 */
export function reclaimOrphanedRunningJobs(): JobRow[] {
  const d = getDb();
  const orphans = d.query("SELECT * FROM jobs WHERE status = 'running'").all() as JobRow[];
  for (const job of orphans) {
    finishJob(job.id, "failed", null, "服务重启或 Worker 中断，请重新入队");
  }
  return orphans;
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

export function listAllJobsUnbounded(): JobRow[] {
  return getDb()
    .query("SELECT * FROM jobs ORDER BY created_at DESC")
    .all() as JobRow[];
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

export function hasActiveDailyJob(alias: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const prefix = `${day}%`;
  const rows = getDb()
    .query(
      `SELECT * FROM jobs WHERE project_alias = ? AND kind IN ('daily', 'discover-daily') AND created_at LIKE ?`,
    )
    .all(alias, prefix) as JobRow[];
  return filterActiveDailyToday(rows);
}

export function hasCompletedFullDailyToday(alias: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const prefix = `${day}%`;
  const rows = getDb()
    .query(
      `SELECT * FROM jobs WHERE project_alias = ? AND kind IN ('daily', 'discover-daily') AND created_at LIKE ? AND status = 'done'`,
    )
    .all(alias, prefix) as JobRow[];
  return filterCompletedFullDailyToday(rows);
}

export function countCompletedFullDailyTodayForAlias(alias: string): number {
  const day = new Date().toISOString().slice(0, 10);
  const prefix = `${day}%`;
  const rows = getDb()
    .query(
      `SELECT * FROM jobs WHERE project_alias = ? AND kind IN ('daily', 'discover-daily') AND created_at LIKE ? AND status = 'done'`,
    )
    .all(alias, prefix) as JobRow[];
  return countCompletedFullDailyToday(rows);
}

export { countCompletedFullDailyTodayForAlias as countCompletedFullDailyToday };

/** @deprecated */
export function hasPendingDailyToday(alias: string): boolean {
  return hasActiveDailyJob(alias) || hasCompletedFullDailyToday(alias);
}

export function sumTodayJobCostUsd(alias: string): number {
  return sumJobCostInRange(alias, `${new Date().toISOString().slice(0, 10)}%`).total;
}

export function sumMonthJobCostUsd(alias: string): { total: number; jobs: number } {
  return sumJobCostInRange(alias, `${new Date().toISOString().slice(0, 7)}%`);
}

function sumJobCostInRange(alias: string, createdPrefix: string): { total: number; jobs: number } {
  const rows = getDb()
    .query(
      `SELECT result_json FROM jobs WHERE project_alias = ? AND created_at LIKE ? AND status = 'done'`,
    )
    .all(alias, createdPrefix) as { result_json: string | null }[];
  let total = 0;
  let jobs = 0;
  for (const row of rows) {
    const cost = parseResultCostUsd(row.result_json);
    if (cost == null) continue;
    total += cost;
    jobs += 1;
  }
  return { total, jobs };
}

function parseResultCostUsd(resultJson: string | null): number | null {
  if (!resultJson) return null;
  try {
    const r = JSON.parse(resultJson) as { costUsd?: number; result?: { costUsd?: number } };
    if (typeof r.costUsd === "number") return r.costUsd;
    if (typeof r.result?.costUsd === "number") return r.result.costUsd;
  } catch {
    /* ignore */
  }
  return null;
}

export function hasActiveJob(alias: string): boolean {
  const row = getDb()
    .query(
      `SELECT COUNT(*) as c FROM jobs WHERE project_alias = ? AND status IN ('pending', 'running')`,
    )
    .get(alias) as { c: number };
  return row.c > 0;
}

/**
 * 单步 upsert：读取当前 step_states JSON 数组，按 step_name 匹配并更新或追加，
 * 然后写回。相比 updateJobStepStates()，调用方无需自行维护完整数组。
 *
 * 注意：仅在 P7_JOB_ID 环境变量存在时生效（由 Worker 进程注入）。
 * 用户直接 CLI 运行时（如 bun run src/index.ts execute ./project）无 jobId，
 * 此函数不会被调用 —— 这是设计妥协而非 bug。
 */
export async function updateJobStepState(
  id: string,
  step: StepState,
): Promise<void> {
  const d = getDb();
  // 读取当前 step_states
  const row = d
    .query("SELECT step_states FROM jobs WHERE id = ?")
    .get(id) as { step_states: string | null } | null;
  if (!row) return; // job 不存在，静默跳过

  let steps: StepState[] = [];
  if (row.step_states) {
    try {
      steps = JSON.parse(row.step_states) as StepState[];
      if (!Array.isArray(steps)) steps = [];
    } catch {
      steps = []; // 损坏的 JSON，重置为空数组
    }
  }

  // 按 step_name 查找并更新，未找到则追加
  const idx = steps.findIndex((s) => s.step_name === step.step_name);
  if (idx >= 0) {
    steps[idx] = step;
  } else {
    steps.push(step);
  }

  // Retry up to 3 times on SQLITE_BUSY (WAL mode concurrent write contention)
  const json = JSON.stringify(steps);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      d.run("UPDATE jobs SET step_states = ? WHERE id = ?", [json, id]);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("SQLITE_BUSY") && attempt < 2) {
        await Bun.sleep(10 + Math.random() * 20);
        continue;
      }
      throw e;
    }
  }
}

export async function updateJobStepStates(id: string, steps: StepState[]): Promise<void> {
  const json = JSON.stringify(steps);
  const d = getDb();
  // Retry up to 3 times on SQLITE_BUSY (WAL mode concurrent write contention)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      d.run("UPDATE jobs SET step_states = ? WHERE id = ?", [json, id]);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("SQLITE_BUSY") && attempt < 2) {
        await Bun.sleep(10 + Math.random() * 20);
        continue;
      }
      throw e;
    }
  }
}

export function hasActiveExecuteJob(alias: string): boolean {
  const row = getDb()
    .query(
      `SELECT COUNT(*) as c FROM jobs WHERE project_alias = ? AND kind = 'execute' AND status IN ('pending', 'running')`,
    )
    .get(alias) as { c: number };
  return row.c > 0;
}

/** 同项目是否有其它互斥任务（不含 pr-review 自身时可传 excludeKind） */
export function hasProjectMutexInFlight(
  alias: string,
  exceptKind?: JobKind,
): boolean {
  const kinds = exceptKind
    ? PROJECT_MUTEX_KINDS.filter((k) => k !== exceptKind)
    : [...PROJECT_MUTEX_KINDS];
  if (kinds.length === 0) return false;
  const inList = kinds.map(() => "?").join(", ");
  const row = getDb()
    .query(
      `SELECT COUNT(*) as c FROM jobs WHERE project_alias = ? AND kind IN (${inList}) AND status IN ('pending', 'running')`,
    )
    .get(alias, ...kinds) as { c: number };
  return row.c > 0;
}

export function hasPrReviewInFlight(alias: string): boolean {
  const row = getDb()
    .query(
      `SELECT COUNT(*) as c FROM jobs WHERE project_alias = ? AND kind = 'pr-review' AND status IN ('pending', 'running')`,
    )
    .get(alias) as { c: number };
  return row.c > 0;
}

export function getLastPrReviewJob(alias: string): JobRow | null {
  return (
    (getDb()
      .query(
        `SELECT * FROM jobs WHERE project_alias = ? AND kind = 'pr-review' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(alias) as JobRow | null) ?? null
  );
}

/** @deprecated 使用 shouldSchedulePrReview */
export function hasRecentPrReviewJob(alias: string, intervalMinutes: number): boolean {
  const since = new Date(Date.now() - intervalMinutes * 60 * 1000).toISOString();
  const active = getDb()
    .query(
      `SELECT COUNT(*) as c FROM jobs WHERE project_alias = ? AND kind = 'pr-review' AND status IN ('pending', 'running')`,
    )
    .get(alias) as { c: number };
  if (active.c > 0) return true;
  const done = getDb()
    .query(
      `SELECT COUNT(*) as c FROM jobs WHERE project_alias = ? AND kind = 'pr-review' AND status = 'done' AND created_at >= ?`,
    )
    .get(alias, since) as { c: number };
  return done.c > 0;
}
