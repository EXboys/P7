import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { resolveP7HomeDir } from "../../src/p7-paths.ts";
import type { ServerConfig } from "../config.ts";
import { modelEnvs, loadServerConfig, dashboardBaseUrl } from "../config.ts";
import { audit } from "../audit.ts";
import { maybeContinueLoop } from "../loop-policy.ts";
import {
  claimNextJob,
  enqueueJob,
  finishJob,
  reclaimStaleJobs,
} from "./store.ts";
import type { DailyJobPayload, ExecuteJobPayload, JobPayload } from "./types.ts";
import { loadClaudeSettingsEnv } from "../../src/sdk.ts";
import { loadConfig } from "../../src/config.ts";
import { getApprovalRecord } from "../../src/approval.ts";

const MAX_RUN_MS = 40 * 60 * 1000;

function jobLogPath(id: string): string {
  const dir = join(resolveP7HomeDir(), "job-logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${id}.log`);
}

function mergeEnv(cfg: ServerConfig, projectAlias?: string): Record<string, string> {
  const base = dashboardBaseUrl(cfg);
  const env: Record<string, string> = {
    ...process.env,
    ...loadClaudeSettingsEnv(),
    ...modelEnvs(cfg),
    ...(base ? { DASHBOARD_BASE_URL: base, P7_DASHBOARD_URL: base } : {}),
    ...(projectAlias ? { P7_PROJECT_ALIAS: projectAlias } : {}),
  };
  if (cfg.dingtalk?.webhook) {
    env.DINGTALK_WEBHOOK = cfg.dingtalk.webhook;
    if (cfg.dingtalk.robot_secret) env.DINGTALK_SECRET = cfg.dingtalk.robot_secret;
  }
  return env;
}

function jobTimeoutMs(projectPath: string, cfg: ServerConfig): number {
  try {
    const dc = loadConfig(projectPath);
    return Math.max(dc.execution_timeout_minutes, 10) * 60 * 1000;
  } catch {
    return 35 * 60 * 1000;
  }
}

async function runJob(
  cfg: ServerConfig,
  jobId: string,
  kind: string,
  projectPath: string,
  payload: JobPayload,
  projectAlias: string,
): Promise<unknown> {
  const cli = cfg.cli_entry || join(import.meta.dir, "../../src/index.ts");
  const args = [cfg.bun_bin, "run", cli];

  if (kind === "execute") {
    const p = payload as ExecuteJobPayload;
    args.push("execute", projectPath, "--plan-id", p.planId);
  } else if (kind === "discover-daily") {
    args.push("discover-daily", projectPath);
    const d = payload as DailyJobPayload;
    if (d.planOnly) args.push("--plan-only");
  } else {
    args.push("daily", "run", projectPath);
    const d = payload as DailyJobPayload;
    if (d.goal) args.push("--goal", d.goal);
    if (d.planOnly) args.push("--plan-only");
  }

  const proc = Bun.spawn(args, {
    cwd: join(import.meta.dir, "../.."),
    env: mergeEnv(cfg, projectAlias),
    stdout: "pipe",
    stderr: "pipe",
  });

  const logPath = jobLogPath(jobId);
  const timeoutMs = jobTimeoutMs(projectPath, cfg);
  const timeout = setTimeout(() => proc.kill(), timeoutMs);

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  appendFileSync(logPath, stdout + "\n" + stderr);

  if (code !== 0) throw new Error(stderr.slice(0, 800) || `exit ${code}`);
  try {
    const lines = stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return { raw: stdout.slice(-2000) };
  }
}

function maybeEnqueueExecuteAfterDiscover(
  cfg: ServerConfig,
  alias: string,
  projectPath: string,
  result: unknown,
  planOnly?: boolean,
): void {
  if (planOnly) return;
  const r = result as { planId?: string; phase?: string } | null;
  if (!r?.planId) return;
  const approval = getApprovalRecord(projectPath, r.planId);
  if (approval?.status !== "approved") return;
  if (r.phase !== "approved" && r.phase !== "planned") return;
  enqueueJob({
    kind: "execute",
    payload: { projectPath, planId: r.planId },
    projectAlias: alias,
  });
  audit("job.auto_execute", { alias, planId: r.planId });
}

export function startWorker(cfg: ServerConfig): () => void {
  const reclaimed = reclaimStaleJobs(MAX_RUN_MS);
  for (const job of reclaimed) {
    const payload = JSON.parse(job.payload) as JobPayload;
    const path = String(cfg.project_aliases[job.project_alias] ?? (payload as DailyJobPayload).projectPath);
    if (path && job.kind !== "execute") {
      const decision = maybeContinueLoop(cfg, job.project_alias, path);
        if (decision.continue) {
          let planOnly = true;
          try {
            const dc = loadConfig(path);
            planOnly = !dc.discovery.auto_execute_after_approve;
          } catch {
            /* keep planOnly */
          }
          enqueueJob({
            kind: "discover-daily",
            payload: { projectPath: path, planOnly },
            projectAlias: job.project_alias,
          });
        }
    }
    audit("job.reclaimed", { id: job.id, alias: job.project_alias });
  }

  const running = new Set<string>();
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      const busy = [...running];
      if (busy.length >= cfg.max_concurrent_projects) {
        await Bun.sleep(2000);
        continue;
      }

      const job = claimNextJob(busy);
      if (!job) {
        await Bun.sleep(2000);
        continue;
      }

      running.add(job.project_alias);
      audit("job.started", { id: job.id, alias: job.project_alias, kind: job.kind });

      try {
        const payload = JSON.parse(job.payload) as JobPayload;
        const projectPath = String(
          cfg.project_aliases[job.project_alias] ??
            (payload as DailyJobPayload).projectPath ??
            (payload as ExecuteJobPayload).projectPath,
        );
        const result = await runJob(cfg, job.id, job.kind, projectPath, payload, job.project_alias);
        finishJob(job.id, "done", result);
        audit("job.done", { id: job.id, kind: job.kind });

        if (job.kind === "discover-daily") {
          maybeEnqueueExecuteAfterDiscover(
            cfg,
            job.project_alias,
            projectPath,
            result,
            (payload as DailyJobPayload).planOnly,
          );
        }

        if (job.kind === "daily" || job.kind === "discover-daily") {
          const decision = maybeContinueLoop(cfg, job.project_alias, projectPath, result);
          if (decision.continue) {
            const dc = loadConfig(projectPath);
            const nextKind = dc.loop_planning ? "discover-daily" : "daily";
            const planOnly =
              nextKind === "discover-daily" && !dc.discovery.auto_execute_after_approve;
            enqueueJob({
              kind: nextKind,
              payload: { projectPath, planOnly },
              projectAlias: job.project_alias,
            });
            audit("loop.continued", { alias: job.project_alias, nextKind });
          } else {
            audit("loop.stopped", { alias: job.project_alias, reason: decision.reason });
          }
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        finishJob(job.id, "failed", null, err);
        audit("job.failed", { id: job.id, error: err });
      } finally {
        running.delete(job.project_alias);
      }
    }
  };

  void loop();
  return () => {
    stopped = true;
  };
}

export function bootWorker(): () => void {
  return startWorker(loadServerConfig());
}

export function readJobLog(id: string): string {
  const path = jobLogPath(id);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}
