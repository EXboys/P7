import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { legacyProjectDir, p7ProjectDir, projectDataDirForRead } from "./p7-paths.ts";
import type { PlanState, PlanStateStatus, VcsAccountPublishResult } from "./types.ts";
import type { SdkTokenUsage } from "./sdk-cost.ts";

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

/** PlanState 可能携带背压事件（本地扩展，不入侵 types.ts 的接口定义） */
type PlanStateWithBp = PlanState & { backpressureEvents?: BackpressureEvent[] };

const STATUS_VALUES: PlanStateStatus[] = [
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

const dbCache = new Map<string, Database>();

export function dbPath(projectPath: string): string {
  return join(p7ProjectDir(projectPath), "state.db");
}

function stateJsonPath(projectPath: string): string {
  return join(projectDataDirForRead(projectPath), "state.json");
}

function rowToPlanState(row: Record<string, unknown>): PlanState {
  const accountRaw = row.account_results as string | null | undefined;
  let accountResults: VcsAccountPublishResult[] | undefined;
  if (accountRaw) {
    try {
      accountResults = JSON.parse(accountRaw) as VcsAccountPublishResult[];
    } catch {
      accountResults = undefined;
    }
  }
  const state: PlanState = {
    planId: String(row.plan_id),
    projectPath: String(row.project_path),
    goal: String(row.goal),
    title: String(row.title),
    status: row.status as PlanStateStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  if (row.branch) state.branch = String(row.branch);
  if (row.commit_sha) state.commitSha = String(row.commit_sha);
  if (row.review_url) state.reviewUrl = String(row.review_url);
  if (row.pr_url) state.prUrl = String(row.pr_url);
  if (row.issue_url) state.issueUrl = String(row.issue_url);
  if (row.merge_status) {
    state.mergeStatus = row.merge_status as PlanState["mergeStatus"];
  }
  if (accountResults?.length) state.accountResults = accountResults;
  if (row.error) state.error = String(row.error);
  if (row.findings) state.findings = String(row.findings);
  if (row.diff_critic_findings) state.diffCriticFindings = String(row.diff_critic_findings);
  if (row.cost_usd != null && row.cost_usd !== "") {
    const cost = Number(row.cost_usd);
    if (Number.isFinite(cost)) state.costUsd = cost;
  }
  const tokenRaw = row.token_usage as string | null | undefined;
  if (tokenRaw) {
    try {
      state.tokenUsage = JSON.parse(tokenRaw) as PlanState["tokenUsage"];
    } catch {
      /* ignore */
    }
  }
  const bpRaw = row.backpressure_events as string | null | undefined;
  if (bpRaw) {
    try {
      (state as PlanStateWithBp).backpressureEvents = JSON.parse(bpRaw) as BackpressureEvent[];
    } catch {
      /* ignore */
    }
  }
  return state;
}

function planStateBinds(state: PlanState): Record<string, string | null> {
  return {
    $plan_id: state.planId,
    $project_path: state.projectPath,
    $goal: state.goal,
    $title: state.title,
    $status: state.status,
    $created_at: state.createdAt,
    $updated_at: state.updatedAt,
    $branch: state.branch ?? null,
    $commit_sha: state.commitSha ?? null,
    $review_url: state.reviewUrl ?? null,
    $pr_url: state.prUrl ?? null,
    $issue_url: state.issueUrl ?? null,
    $merge_status: state.mergeStatus ?? null,
    $account_results: state.accountResults?.length
      ? JSON.stringify(state.accountResults)
      : null,
    $cost_usd: state.costUsd != null ? String(state.costUsd) : null,
    $token_usage: state.tokenUsage ? JSON.stringify(state.tokenUsage) : null,
    $findings: state.findings ?? null,
    $diff_critic_findings: state.diffCriticFindings ?? null,
    $backpressure_events: (state as PlanStateWithBp).backpressureEvents?.length
      ? JSON.stringify((state as PlanStateWithBp).backpressureEvents)
      : null,
    $error: state.error ?? null,
  };
}

function withBusyRetry<T>(fn: () => T): T {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("SQLITE_BUSY") && attempt < 2) {
        Bun.sleepSync(50);
        continue;
      }
      throw e;
    }
  }
  throw new Error("withBusyRetry: unreachable");
}

function migrateFromJsonIfNeeded(db: Database, projectPath: string): void {
  const count = Number(
    (db.query("SELECT COUNT(*) AS c FROM plan_states").get() as { c: number }).c,
  );
  if (count > 0) return;

  const candidates = [
    join(p7ProjectDir(projectPath), "state.json"),
    join(legacyProjectDir(projectPath), "state.json"),
    stateJsonPath(projectPath),
  ];
  let raw: PlanState[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (Array.isArray(parsed) && parsed.length > 0) {
        raw = parsed as PlanState[];
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (raw.length === 0) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO plan_states (
      plan_id, project_path, goal, title, status, created_at, updated_at,
      branch, commit_sha, review_url, pr_url, issue_url, merge_status,
      account_results, error
    ) VALUES (
      $plan_id, $project_path, $goal, $title, $status, $created_at, $updated_at,
      $branch, $commit_sha, $review_url, $pr_url, $issue_url, $merge_status,
      $account_results, $error
    )
  `);

  const runMigration = db.transaction((states: PlanState[]) => {
    for (const s of states) {
      if (!s.planId || !STATUS_VALUES.includes(s.status)) continue;
      insert.run(planStateBinds(s));
    }
  });
  runMigration(raw);
}

export function initDb(projectPath: string): Database {
  const cached = dbCache.get(projectPath);
  if (cached) return cached;

  const dir = p7ProjectDir(projectPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath(projectPath));
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  const statusList = STATUS_VALUES.map((s) => `'${s}'`).join(", ");
  db.run(`
    CREATE TABLE IF NOT EXISTS plan_states (
      plan_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      goal TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (${statusList})),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      branch TEXT,
      commit_sha TEXT,
      review_url TEXT,
      pr_url TEXT,
      issue_url TEXT,
      merge_status TEXT,
      account_results TEXT,
      error TEXT
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_plan_states_updated ON plan_states(updated_at DESC)`,
  );
  try {
    db.run("ALTER TABLE plan_states ADD COLUMN cost_usd REAL");
  } catch {
    /* exists */
  }
  try {
    db.run("ALTER TABLE plan_states ADD COLUMN token_usage TEXT");
  } catch {
    /* exists */
  }
  try {
    db.run("ALTER TABLE plan_states ADD COLUMN findings TEXT");
  } catch {
    /* exists */
  }
  try {
    db.run("ALTER TABLE plan_states ADD COLUMN diff_critic_findings TEXT");
  } catch {
    /* exists */
  }
  try {
    db.run("ALTER TABLE plan_states ADD COLUMN backpressure_events TEXT");
  } catch {
    /* exists */
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS sdk_costs (
      plan_id TEXT,
      role TEXT NOT NULL,
      model TEXT,
      cost_usd REAL NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_sdk_costs_plan ON sdk_costs(plan_id)`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_sdk_costs_created ON sdk_costs(created_at DESC)`,
  );
  try {
    db.run("ALTER TABLE sdk_costs ADD COLUMN input_tokens INTEGER");
  } catch {
    /* exists */
  }
  try {
    db.run("ALTER TABLE sdk_costs ADD COLUMN output_tokens INTEGER");
  } catch {
    /* exists */
  }
  try {
    db.run("ALTER TABLE sdk_costs ADD COLUMN cache_read_input_tokens INTEGER");
  } catch {
    /* exists */
  }
  try {
    db.run("ALTER TABLE sdk_costs ADD COLUMN cache_creation_input_tokens INTEGER");
  } catch {
    /* exists */
  }

  migrateFromJsonIfNeeded(db, projectPath);
  dbCache.set(projectPath, db);
  return db;
}

export function closeDb(projectPath?: string): void {
  if (projectPath) {
    const db = dbCache.get(projectPath);
    if (db) {
      db.close();
      dbCache.delete(projectPath);
    }
    return;
  }
  for (const [key, db] of dbCache) {
    db.close();
    dbCache.delete(key);
  }
}

export function upsertPlanState(
  projectPath: string,
  next: Omit<PlanState, "updatedAt"> & { updatedAt?: string },
): PlanState {
  const db = initDb(projectPath);
  const existing = getPlanState(projectPath, next.planId);
  const updated: PlanState = {
    ...(existing ?? {}),
    ...next,
    planId: next.planId,
    projectPath: next.projectPath,
    goal: next.goal,
    title: next.title,
    status: next.status,
    createdAt: existing?.createdAt ?? next.createdAt ?? new Date().toISOString(),
    updatedAt: next.updatedAt ?? new Date().toISOString(),
  };
  if ("error" in next && next.error === undefined) delete updated.error;

  const stmt = db.prepare(`
    INSERT INTO plan_states (
      plan_id, project_path, goal, title, status, created_at, updated_at,
      branch, commit_sha, review_url, pr_url, issue_url, merge_status,
      account_results, cost_usd, token_usage, findings, diff_critic_findings, backpressure_events, error
    ) VALUES (
      $plan_id, $project_path, $goal, $title, $status, $created_at, $updated_at,
      $branch, $commit_sha, $review_url, $pr_url, $issue_url, $merge_status,
      $account_results, $cost_usd, $token_usage, $findings, $diff_critic_findings, $backpressure_events, $error
    )
    ON CONFLICT(plan_id) DO UPDATE SET
      project_path = excluded.project_path,
      goal = excluded.goal,
      title = excluded.title,
      status = excluded.status,
      updated_at = excluded.updated_at,
      branch = excluded.branch,
      commit_sha = excluded.commit_sha,
      review_url = excluded.review_url,
      pr_url = excluded.pr_url,
      issue_url = excluded.issue_url,
      merge_status = excluded.merge_status,
      account_results = excluded.account_results,
      cost_usd = COALESCE(excluded.cost_usd, plan_states.cost_usd),
      token_usage = COALESCE(excluded.token_usage, plan_states.token_usage),
      findings = COALESCE(excluded.findings, plan_states.findings),
      diff_critic_findings = COALESCE(excluded.diff_critic_findings, plan_states.diff_critic_findings),
      backpressure_events = COALESCE(excluded.backpressure_events, plan_states.backpressure_events),
      error = excluded.error
  `);

  return withBusyRetry(() => {
    const binds = planStateBinds(updated);
    if ("error" in next && next.error === undefined) binds.$error = null;
    stmt.run(binds);
    return updated;
  });
}

/** 失败后重新入队 execute：恢复为已批准并清空错误 */
export function preparePlanExecuteRetry(projectPath: string, planId: string): PlanState | null {
  const existing = getPlanState(projectPath, planId);
  if (!existing || existing.status !== "failed") return null;
  return upsertPlanState(projectPath, {
    ...existing,
    status: "approved",
    error: undefined,
    updatedAt: new Date().toISOString(),
  });
}

export function transitionPlanState(
  projectPath: string,
  planId: string,
  status: PlanStateStatus,
  patch: Partial<Omit<PlanState, "planId" | "projectPath" | "status" | "updatedAt">> = {},
): PlanState | null {
  const db = initDb(projectPath);
  const run = db.transaction(() => {
    const existing = getPlanState(projectPath, planId);
    if (!existing) return null;
    const updated: PlanState = {
      ...existing,
      ...patch,
      status,
      updatedAt: new Date().toISOString(),
    };
    const stmt = db.prepare(`
      UPDATE plan_states SET
        goal = $goal,
        title = $title,
        status = $status,
        updated_at = $updated_at,
        branch = $branch,
        commit_sha = $commit_sha,
        review_url = $review_url,
        pr_url = $pr_url,
        issue_url = $issue_url,
        merge_status = $merge_status,
        account_results = $account_results,
        findings = $findings,
        diff_critic_findings = $diff_critic_findings,
        error = $error
      WHERE plan_id = $plan_id
    `);
    stmt.run(planStateBinds(updated));
    return updated;
  });
  return withBusyRetry(() => run());
}

export function getPlanState(projectPath: string, planId: string): PlanState | null {
  const db = initDb(projectPath);
  const row = db
    .query(`SELECT * FROM plan_states WHERE plan_id = $plan_id`)
    .get({ $plan_id: planId }) as Record<string, unknown> | null;
  return row ? rowToPlanState(row) : null;
}

export function listPlanStates(projectPath: string, limit = 50): PlanState[] {
  const db = initDb(projectPath);
  const rows = db
    .query(
      `SELECT * FROM plan_states ORDER BY updated_at DESC LIMIT $limit`,
    )
    .all({ $limit: limit }) as Record<string, unknown>[];
  return rows.map(rowToPlanState);
}

/** 查询队列中待处理（planned / pending_approval / approved）的 Plan 数量 */
export function countQueuedPlans(projectPath: string): number {
  const db = initDb(projectPath);
  const row = db
    .query(
      `SELECT COUNT(*) AS c FROM plan_states WHERE status IN ('planned', 'pending_approval', 'approved')`,
    )
    .get() as { c: number } | undefined;
  return row?.c ?? 0;
}

export function writeSdkCost(
  projectPath: string,
  params: { planId?: string; role: string; model?: string; costUsd: number; usage?: SdkTokenUsage },
): void {
  const db = initDb(projectPath);
  const stmt = db.prepare(`
    INSERT INTO sdk_costs (plan_id, role, model, cost_usd, created_at, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
    VALUES ($plan_id, $role, $model, $cost_usd, $created_at, $input_tokens, $output_tokens, $cache_read_input_tokens, $cache_creation_input_tokens)
  `);
  withBusyRetry(() => {
    stmt.run({
      $plan_id: params.planId ?? null,
      $role: params.role,
      $model: params.model ?? null,
      $cost_usd: params.costUsd,
      $created_at: new Date().toISOString(),
      $input_tokens: params.usage?.inputTokens ?? null,
      $output_tokens: params.usage?.outputTokens ?? null,
      $cache_read_input_tokens: params.usage?.cacheReadInputTokens ?? null,
      $cache_creation_input_tokens: params.usage?.cacheCreationInputTokens ?? null,
    });
  });
}

/** 写入 diff-critic 检测结果到 plan_states.diff_critic_findings */
export function updatePlanDiffCriticFindings(
  projectPath: string,
  planId: string,
  findings: string,
): void {
  const db = initDb(projectPath);
  const stmt = db.prepare(
    `UPDATE plan_states SET diff_critic_findings = $diff_critic_findings, updated_at = $updated_at WHERE plan_id = $plan_id`,
  );
  withBusyRetry(() => {
    stmt.run({
      $plan_id: planId,
      $diff_critic_findings: findings,
      $updated_at: new Date().toISOString(),
    });
  });
}

/**
 * 在 PlanState 的 backpressure_events 数组中追加一条事件记录。
 * 当 planId 对应的行不存在时静默跳过（预期不会发生）。
 */
export function recordBackpressureEvent(
  projectPath: string,
  planId: string,
  event: Omit<BackpressureEvent, "timestamp">,
): void {
  const db = initDb(projectPath);
  withBusyRetry(() => {
    const row = db
      .query(`SELECT backpressure_events FROM plan_states WHERE plan_id = $plan_id`)
      .get({ $plan_id: planId }) as { backpressure_events: string | null } | undefined;
    if (!row) return; // no matching plan — skip silently

    const events: BackpressureEvent[] = [];
    if (row.backpressure_events) {
      try {
        const parsed = JSON.parse(row.backpressure_events);
        if (Array.isArray(parsed)) events.push(...parsed);
      } catch {
        /* ignore malformed JSON — start fresh */
      }
    }
    events.push({ ...event, timestamp: new Date().toISOString() });

    db.query(
      `UPDATE plan_states SET backpressure_events = $events, updated_at = $updated_at WHERE plan_id = $plan_id`,
    ).run({
      $events: JSON.stringify(events),
      $updated_at: new Date().toISOString(),
      $plan_id: planId,
    });
  });
}
