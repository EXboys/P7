import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { legacyProjectDir, p7ProjectDir, projectDataDirForRead } from "./p7-paths.ts";
import type { PlanState, PlanStateStatus, VcsAccountPublishResult, ConvergenceMetrics } from "./types.ts";
import type { SdkTokenUsage } from "./sdk-cost.ts";

/** 按 goal 维度归因的成本明细 */
export interface GoalCostBreakdown {
  goal: string;
  totalCostUsd: number;
  planCount: number;
}

/** 成本汇总：今日总额、本月总额、查询次数、按 goal 归因 */
export interface CostSummary {
  todayTotalUsd: number;
  monthTotalUsd: number;
  todayQueryCount: number;
  byGoal: GoalCostBreakdown[];
}

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
  if (row.plan_critic_findings) state.planCriticFindings = String(row.plan_critic_findings);
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
    $plan_critic_findings: state.planCriticFindings ?? null,
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
  try {
    db.run("ALTER TABLE plan_states ADD COLUMN plan_critic_findings TEXT");
  } catch {
    /* exists */
  }

  /* convergence_snapshots table: time-series storage for RuleEntropy / FPR drift / coverage stability metrics */
  db.run(`
    CREATE TABLE IF NOT EXISTS convergence_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      plan_id TEXT,
      metrics TEXT NOT NULL,
      iteration_round INTEGER,
      computed_at TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_convergence_snapshots_project_time
    ON convergence_snapshots(project_path, computed_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_convergence_snapshots_project_iteration
    ON convergence_snapshots(project_path, iteration_round DESC)`);

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
  try {
    db.run("ALTER TABLE sdk_costs ADD COLUMN goal TEXT");
  } catch {
    /* exists */
  }
  try {
    db.run("ALTER TABLE sdk_costs ADD COLUMN step_name TEXT");
  } catch {
    /* exists */
  }

  /* evaluator_route_stats table: records every routing decision for observability and cost tracking */
  db.run(`
    CREATE TABLE IF NOT EXISTS evaluator_route_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_point TEXT NOT NULL,
      tier TEXT NOT NULL,
      urgency TEXT NOT NULL,
      selected_evaluator TEXT NOT NULL,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      actual_cost_usd REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_eval_route_created ON evaluator_route_stats(created_at DESC)`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_eval_route_evaluator ON evaluator_route_stats(selected_evaluator)`,
  );

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
      account_results, cost_usd, token_usage, findings, diff_critic_findings, backpressure_events, plan_critic_findings, error
    ) VALUES (
      $plan_id, $project_path, $goal, $title, $status, $created_at, $updated_at,
      $branch, $commit_sha, $review_url, $pr_url, $issue_url, $merge_status,
      $account_results, $cost_usd, $token_usage, $findings, $diff_critic_findings, $backpressure_events, $plan_critic_findings, $error
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
      plan_critic_findings = COALESCE(excluded.plan_critic_findings, plan_states.plan_critic_findings),
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
        plan_critic_findings = $plan_critic_findings,
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

export function listPlanStates(projectPath: string, limit = 50, offset = 0): PlanState[] {
  const db = initDb(projectPath);
  const rows = db
    .query(
      `SELECT * FROM plan_states ORDER BY updated_at DESC LIMIT $limit OFFSET $offset`,
    )
    .all({ $limit: limit, $offset: offset }) as Record<string, unknown>[];
  return rows.map(rowToPlanState);
}

export function countPlanStates(projectPath: string): number {
  const db = initDb(projectPath);
  const row = db.query(`SELECT COUNT(*) AS c FROM plan_states`).get() as { c: number } | undefined;
  return row?.c ?? 0;
}

function statusFilterSql(statuses: PlanStateStatus[]): string {
  const allowed = statuses.filter((s) => STATUS_VALUES.includes(s));
  if (allowed.length === 0) return "1 = 0";
  return `status IN (${allowed.map((s) => `'${s}'`).join(", ")})`;
}

export function countPlanStatesByStatuses(
  projectPath: string,
  statuses: PlanStateStatus[],
): number {
  const db = initDb(projectPath);
  const row = db
    .query(`SELECT COUNT(*) AS c FROM plan_states WHERE ${statusFilterSql(statuses)}`)
    .get() as { c: number } | undefined;
  return row?.c ?? 0;
}

export function listPlanStatesByStatuses(
  projectPath: string,
  statuses: PlanStateStatus[],
  limit = 50,
  offset = 0,
): PlanState[] {
  const db = initDb(projectPath);
  const rows = db
    .query(
      `SELECT * FROM plan_states
       WHERE ${statusFilterSql(statuses)}
       ORDER BY updated_at DESC
       LIMIT $limit OFFSET $offset`,
    )
    .all({ $limit: limit, $offset: offset }) as Record<string, unknown>[];
  return rows.map(rowToPlanState);
}

export function countPlanStatesWithPr(projectPath: string): number {
  const db = initDb(projectPath);
  const row = db
    .query(`SELECT COUNT(*) AS c FROM plan_states WHERE pr_url IS NOT NULL AND pr_url != ''`)
    .get() as { c: number } | undefined;
  return row?.c ?? 0;
}

export function listPlanStatesWithPr(
  projectPath: string,
  limit = 50,
  offset = 0,
): PlanState[] {
  const db = initDb(projectPath);
  const rows = db
    .query(
      `SELECT * FROM plan_states
       WHERE pr_url IS NOT NULL AND pr_url != ''
       ORDER BY updated_at DESC
       LIMIT $limit OFFSET $offset`,
    )
    .all({ $limit: limit, $offset: offset }) as Record<string, unknown>[];
  return rows.map(rowToPlanState);
}

export function countPlanStatesWithDelivery(projectPath: string): number {
  const db = initDb(projectPath);
  const row = db
    .query(
      `SELECT COUNT(*) AS c FROM plan_states
       WHERE (pr_url IS NOT NULL AND pr_url != '')
          OR (issue_url IS NOT NULL AND issue_url != '')`,
    )
    .get() as { c: number } | undefined;
  return row?.c ?? 0;
}

export function listPlanStatesWithDelivery(
  projectPath: string,
  limit = 50,
  offset = 0,
): PlanState[] {
  const db = initDb(projectPath);
  const rows = db
    .query(
      `SELECT * FROM plan_states
       WHERE (pr_url IS NOT NULL AND pr_url != '')
          OR (issue_url IS NOT NULL AND issue_url != '')
       ORDER BY updated_at DESC
       LIMIT $limit OFFSET $offset`,
    )
    .all({ $limit: limit, $offset: offset }) as Record<string, unknown>[];
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
  params: { planId?: string; role: string; model?: string; costUsd: number; usage?: SdkTokenUsage; goal?: string; stepName?: string },
): void {
  const db = initDb(projectPath);
  const stmt = db.prepare(`
    INSERT INTO sdk_costs (plan_id, role, model, cost_usd, created_at, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, goal, step_name)
    VALUES ($plan_id, $role, $model, $cost_usd, $created_at, $input_tokens, $output_tokens, $cache_read_input_tokens, $cache_creation_input_tokens, $goal, $step_name)
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
      $goal: params.goal ?? null,
      $step_name: params.stepName ?? null,
    });
  });
}

/**
 * 查询指定 goal 下所有 plan（含所有状态）的累计成本。
 * 涵盖 failed / merged / pushed 等全部状态的记录，用于 goal 维度预算熔断判断。
 */
export function getGoalCostSum(projectPath: string, goal: string): number {
  const db = initDb(projectPath);
  const row = db
    .query(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM plan_states WHERE goal = $goal`)
    .get({ $goal: goal }) as { total: number } | undefined;
  return row?.total ?? 0;
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

/** 写入 plan-critic 检测结果到 plan_states.plan_critic_findings */
export function updatePlanCriticFindings(
  projectPath: string,
  planId: string,
  findings: string,
): void {
  const db = initDb(projectPath);
  const stmt = db.prepare(
    `UPDATE plan_states SET plan_critic_findings = $plan_critic_findings, updated_at = $updated_at WHERE plan_id = $plan_id`,
  );
  withBusyRetry(() => {
    stmt.run({
      $plan_id: planId,
      $plan_critic_findings: findings,
      $updated_at: new Date().toISOString(),
    });
  });
}

/** 读取 plan-critic 检测结果（JSON 字符串） */
export function getPlanCriticFindings(
  projectPath: string,
  planId: string,
): string | null {
  const db = initDb(projectPath);
  const row = db
    .query(`SELECT plan_critic_findings FROM plan_states WHERE plan_id = $plan_id`)
    .get({ $plan_id: planId }) as { plan_critic_findings: string | null } | undefined;
  return row?.plan_critic_findings ?? null;
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

/**
 * 列出所有 diff_critic_findings 非空的 PlanState 记录，按 updated_at 降序排列。
 * 用于模式提炼器从历史 diff-critic 评审记录中提取高频失败模式类别与判定边界线索。
 */
export function listPlansWithDiffCriticFindings(
  projectPath: string,
  limit = 50,
  offset = 0,
): PlanState[] {
  const db = initDb(projectPath);
  const rows = db
    .query(
      `SELECT * FROM plan_states
       WHERE diff_critic_findings IS NOT NULL AND diff_critic_findings != ''
       ORDER BY updated_at DESC
       LIMIT $limit OFFSET $offset`,
    )
    .all({ $limit: limit, $offset: offset }) as Record<string, unknown>[];
  return rows.map(rowToPlanState);
}

/** 查询今日/本月成本汇总，含按 goal 维度的归因 */
export function queryDailyCostSummary(projectPath: string): CostSummary {
  const db = initDb(projectPath);
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";

  const todayRow = db
    .query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS cnt FROM sdk_costs WHERE created_at >= $today`,
    )
    .get({ $today: today }) as { total: number; cnt: number } | undefined;

  const monthRow = db
    .query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM sdk_costs WHERE created_at >= $month_start`,
    )
    .get({ $month_start: monthStart }) as { total: number } | undefined;

  const byGoalRows = db
    .query(
      `SELECT goal, COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS cnt FROM plan_states WHERE cost_usd > 0 GROUP BY goal ORDER BY total DESC`,
    )
    .all() as { goal: string; total: number; cnt: number }[];

  return {
    todayTotalUsd: todayRow?.total ?? 0,
    monthTotalUsd: monthRow?.total ?? 0,
    todayQueryCount: todayRow?.cnt ?? 0,
    byGoal: byGoalRows.map((r) => ({
      goal: r.goal,
      totalCostUsd: r.total,
      planCount: r.cnt,
    })),
  };
}

/** Per-evaluator route stat, as written by writeEvalRouteStat. */
export interface EvalRouteStatWrite {
  routePoint: string;
  tier: string;
  urgency: string;
  selectedEvaluator: string;
  estimatedCostUsd: number;
  actualCostUsd: number;
  latencyMs: number;
}

/** Aggregated route stat for dashboard display. */
export interface EvalRouteStatsRow {
  selectedEvaluator: string;
  callCount: number;
  avgCostUsd: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

/**
 * Record a single evaluator routing decision to the evaluator_route_stats table.
 *
 * Called after every routed evaluation (diff-critic or plan-critic) to capture
 * tier, urgency, evaluator choice, cost estimates, actual cost, and measured
 * latency. This data powers the Run-page metric cards for observability and
 * cost tracking.
 */
export function writeEvalRouteStat(
  projectPath: string,
  stat: EvalRouteStatWrite,
): void {
  const db = initDb(projectPath);
  const stmt = db.prepare(`
    INSERT INTO evaluator_route_stats (route_point, tier, urgency, selected_evaluator, estimated_cost_usd, actual_cost_usd, latency_ms, created_at)
    VALUES ($route_point, $tier, $urgency, $selected_evaluator, $estimated_cost_usd, $actual_cost_usd, $latency_ms, $created_at)
  `);
  withBusyRetry(() => {
    stmt.run({
      $route_point: stat.routePoint,
      $tier: stat.tier,
      $urgency: stat.urgency,
      $selected_evaluator: stat.selectedEvaluator,
      $estimated_cost_usd: stat.estimatedCostUsd,
      $actual_cost_usd: stat.actualCostUsd,
      $latency_ms: stat.latencyMs,
      $created_at: new Date().toISOString(),
    });
  });
}

/**
 * Query aggregated evaluator route stats over a configurable lookback window.
 *
 * Returns per-evaluator call count, average cost, average latency, and
 * p50/p95 latency distribution. Latency percentiles are computed in JS
 * from the raw rows to avoid SQLite percentile-function availability issues.
 *
 * @param projectPath - Scoping project path
 * @param days - Lookback window in days (default 7)
 */
export function queryEvalRouteStats(
  projectPath: string,
  days = 7,
): EvalRouteStatsRow[] {
  const db = initDb(projectPath);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const rows = db
    .query(
      `SELECT selected_evaluator, actual_cost_usd, latency_ms
       FROM evaluator_route_stats
       WHERE created_at >= $since
       ORDER BY created_at DESC`,
    )
    .all({ $since: since }) as { selected_evaluator: string; actual_cost_usd: number; latency_ms: number }[];

  // Group by evaluator
  const groups = new Map<string, { costs: number[]; latencies: number[] }>();
  for (const r of rows) {
    let g = groups.get(r.selected_evaluator);
    if (!g) {
      g = { costs: [], latencies: [] };
      groups.set(r.selected_evaluator, g);
    }
    g.costs.push(r.actual_cost_usd);
    g.latencies.push(r.latency_ms);
  }

  const result: EvalRouteStatsRow[] = [];
  for (const [selectedEvaluator, g] of groups) {
    const callCount = g.costs.length;
    const avgCostUsd = g.costs.reduce((s, c) => s + c, 0) / callCount;
    const avgLatencyMs = g.latencies.reduce((s, l) => s + l, 0) / callCount;

    // p50/p95 from sorted latencies
    const sorted = [...g.latencies].sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);

    result.push({ selectedEvaluator, callCount, avgCostUsd, avgLatencyMs, p50LatencyMs: p50, p95LatencyMs: p95 });
  }

  // Sort by call count descending for display
  result.sort((a, b) => b.callCount - a.callCount);
  return result;
}

/** Compute the p-th percentile from a sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Persist a computed convergence snapshot to the convergence_snapshots table.
 *
 * Stores the full ConvergenceMetrics payload as a JSON TEXT column alongside
 * optional planId and iterationRound for time-series queryability.
 *
 * @param projectPath - Scoping project path
 * @param metrics - Computed ConvergenceMetrics to persist
 * @param planId - Optional plan ID to associate with this snapshot
 * @param iterationRound - Optional 0-based iteration round number
 */
export function recordConvergenceSnapshot(
  projectPath: string,
  metrics: ConvergenceMetrics,
  planId?: string,
  iterationRound?: number,
): void {
  const db = initDb(projectPath);
  const stmt = db.prepare(`
    INSERT INTO convergence_snapshots (project_path, plan_id, metrics, iteration_round, computed_at)
    VALUES ($project_path, $plan_id, $metrics, $iteration_round, $computed_at)
  `);
  withBusyRetry(() => {
    stmt.run({
      $project_path: projectPath,
      $plan_id: planId ?? null,
      $metrics: JSON.stringify(metrics),
      $iteration_round: iterationRound != null ? iterationRound : null,
      $computed_at: metrics.computedAt,
    });
  });
}

/**
 * Query convergence snapshots within a time window.
 *
 * Returns raw ConvergenceMetrics without planId/iterationRound metadata.
 * Consumers needing that context should extend the return type or join
 * on computedAt.
 *
 * @param projectPath - Scoping project path
 * @param opts - Query options with optional since, until, limit, offset
 * @returns Array of ConvergenceMetrics matching the time window
 */
export function listConvergenceSnapshots(
  projectPath: string,
  opts: { since?: string; until?: string; limit?: number; offset?: number } = {},
): ConvergenceMetrics[] {
  const db = initDb(projectPath);
  const conditions: string[] = ["project_path = $project_path"];
  const binds: Record<string, unknown> = { $project_path: projectPath };

  if (opts.since) {
    conditions.push("computed_at >= $since");
    binds.$since = opts.since;
  }
  if (opts.until) {
    conditions.push("computed_at <= $until");
    binds.$until = opts.until;
  }

  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  binds.$limit = limit;
  binds.$offset = offset;

  const sql = `SELECT metrics FROM convergence_snapshots
    WHERE ${conditions.join(" AND ")}
    ORDER BY computed_at DESC
    LIMIT $limit OFFSET $offset`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = db.query(sql).all(binds as any) as { metrics: string }[];
  return rows.map((r) => JSON.parse(r.metrics) as ConvergenceMetrics);
}

/**
 * Query convergence snapshots by iteration round range.
 *
 * @param projectPath - Scoping project path
 * @param roundMin - Minimum iteration round (inclusive, optional)
 * @param roundMax - Maximum iteration round (inclusive, optional)
 * @param limit - Max rows to return (default 50)
 * @param offset - Rows to skip (default 0)
 * @returns Array of ConvergenceMetrics matching the iteration range
 */
export function listConvergenceSnapshotsByIteration(
  projectPath: string,
  roundMin?: number,
  roundMax?: number,
  limit = 50,
  offset = 0,
): ConvergenceMetrics[] {
  const db = initDb(projectPath);
  const conditions: string[] = ["project_path = $project_path"];
  const binds: Record<string, unknown> = { $project_path: projectPath };

  if (roundMin != null) {
    conditions.push("iteration_round >= $round_min");
    binds.$round_min = roundMin;
  }
  if (roundMax != null) {
    conditions.push("iteration_round <= $round_max");
    binds.$round_max = roundMax;
  }

  binds.$limit = limit;
  binds.$offset = offset;

  const sql = `SELECT metrics FROM convergence_snapshots
    WHERE ${conditions.join(" AND ")}
    ORDER BY iteration_round DESC
    LIMIT $limit OFFSET $offset`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = db.query(sql).all(binds as any) as { metrics: string }[];
  return rows.map((r) => JSON.parse(r.metrics) as ConvergenceMetrics);
}
