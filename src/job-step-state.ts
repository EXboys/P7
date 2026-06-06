import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { resolveP7HomeDir } from "./p7-paths.ts";
import type { StepState } from "./execution/step-reporter.ts";

let jobsDb: Database | null = null;

function jobsDbPath(): string {
  return join(resolveP7HomeDir(), "jobs.db");
}

function getJobsDb(): Database {
  if (!jobsDb) {
    const dir = resolveP7HomeDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    jobsDb = new Database(jobsDbPath());
    jobsDb.run(`CREATE TABLE IF NOT EXISTS jobs (
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
    jobsDb.run("PRAGMA journal_mode=WAL");
    try {
      jobsDb.run("ALTER TABLE jobs ADD COLUMN step_states TEXT");
    } catch {
      /* column already exists */
    }
  }
  return jobsDb;
}

export async function updateJobStepState(id: string, step: StepState): Promise<void> {
  const db = getJobsDb();
  const row = db
    .query("SELECT step_states FROM jobs WHERE id = ?")
    .get(id) as { step_states: string | null } | null;
  if (!row) return;

  let steps: StepState[] = [];
  if (row.step_states) {
    try {
      const parsed = JSON.parse(row.step_states) as StepState[];
      steps = Array.isArray(parsed) ? parsed : [];
    } catch {
      steps = [];
    }
  }

  const idx = steps.findIndex((s) => s.step_name === step.step_name);
  if (idx >= 0) steps[idx] = step;
  else steps.push(step);

  const json = JSON.stringify(steps);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      db.run("UPDATE jobs SET step_states = ? WHERE id = ?", [json, id]);
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
