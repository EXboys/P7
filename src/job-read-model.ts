import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { resolveP7HomeDir } from "./p7-paths.ts";
import type { JobRow } from "./job-types.ts";

let db: Database | null = null;

function jobsDbPath(): string {
  return join(resolveP7HomeDir(), "jobs.db");
}

function getDb(): Database | null {
  const path = jobsDbPath();
  if (!existsSync(path)) return null;
  db ??= new Database(path);
  return db;
}

export function listJobsForProject(alias: string, limit = 50): JobRow[] {
  const d = getDb();
  if (!d) return [];
  return d
    .query("SELECT * FROM jobs WHERE project_alias = ? ORDER BY created_at DESC LIMIT ?")
    .all(alias, limit) as JobRow[];
}

export function readJobLog(id: string): string {
  const path = join(resolveP7HomeDir(), "job-logs", `${id}.log`);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}
