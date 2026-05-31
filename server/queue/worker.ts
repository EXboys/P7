import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "fs";
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
  hasPrReviewInFlight,
  updateJobProgress,
  reclaimOrphanedRunningJobs,
  reclaimStaleJobs,
} from "./store.ts";
import type { DailyJobPayload, ExecuteJobPayload, JobKind, JobPayload } from "./types.ts";
import { loadClaudeSettingsEnv } from "../../src/sdk.ts";
import { loadConfig } from "../../src/config.ts";
import { getApprovalRecord } from "../../src/approval.ts";
import { checkPrWorkGate } from "../../src/vcs/pr-work-gate.ts";
import { ghInstalled, gitRemoteOrigin } from "../../src/gh-status.ts";

const MAX_RUN_MS = 40 * 60 * 1000;
const STALE_RECLAIM_MS = 20 * 60 * 1000;

function jobLogPath(id: string): string {
  const dir = join(resolveP7HomeDir(), "job-logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${id}.log`);
}

function mergeEnv(cfg: ServerConfig, projectAlias?: string, jobId?: string): Record<string, string> {
  const base = dashboardBaseUrl(cfg);
  const env: Record<string, string> = {
    ...process.env,
    ...loadClaudeSettingsEnv(),
    ...modelEnvs(cfg),
    ...(base ? { DASHBOARD_BASE_URL: base, P7_DASHBOARD_URL: base } : {}),
    ...(projectAlias ? { P7_PROJECT_ALIAS: projectAlias } : {}),
    ...(jobId ? { P7_JOB_ID: jobId } : {}),
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

function logLine(logPath: string, msg: string): void {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
}

async function pumpStream(
  stream: ReadableStream<Uint8Array> | null,
  logPath: string,
  jobId: string,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let all = "";
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    all += chunk;
    appendFileSync(logPath, chunk);
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.includes('"phase"')) {
        try {
          const j = JSON.parse(t) as { phase?: string };
          if (j.phase) updateJobProgress(jobId, j.phase);
        } catch {
          updateJobProgress(jobId, t.slice(0, 120));
        }
      }
    }
  }
  return all;
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
    // P7_JOB_ID 由 mergeEnv 注入子进程 env，使 executor.ts 能通过
    // process.env.P7_JOB_ID 关联队列 job 记录，写入 step_states 执行轨迹
  } else if (kind === "discover-daily") {
    args.push("discover-daily", projectPath);
    const d = payload as DailyJobPayload;
    if (d.planOnly) args.push("--plan-only");
    if (d.recoverStall) args.push("--recover-stall");
  } else if (kind === "pr-review") {
    args.push("pr-review", projectPath);
  } else {
    args.push("daily", "run", projectPath);
    const d = payload as DailyJobPayload;
    if (d.goal) args.push("--goal", d.goal);
    if (d.planOnly) args.push("--plan-only");
  }

  const logPath = jobLogPath(jobId);
  writeFileSync(
    logPath,
    `[${new Date().toISOString()}] 开始 ${kind}\n命令: ${args.join(" ")}\n项目: ${projectPath}\n\n`,
  );
  updateJobProgress(jobId, "已启动子进程");

  const proc = Bun.spawn(args, {
    cwd: join(import.meta.dir, "../.."),
    env: mergeEnv(cfg, projectAlias, jobId),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = jobTimeoutMs(projectPath, cfg);
  const started = Date.now();
  const timeout = setTimeout(() => {
    logLine(logPath, `超时 ${Math.round(timeoutMs / 60000)} 分钟，终止进程`);
    proc.kill();
  }, timeoutMs);

  const progressIv = setInterval(() => {
    const sec = Math.round((Date.now() - started) / 1000);
    updateJobProgress(jobId, `运行中 ${sec}s…`);
  }, 5000);

  const heartbeatIv = setInterval(() => {
    logLine(logPath, `仍在执行（已 ${Math.round((Date.now() - started) / 1000)}s）…`);
  }, 15000);

  let stdout = "";
  let stderr = "";
  let code = 1;
  try {
    [stdout, stderr, code] = await Promise.all([
      pumpStream(proc.stdout, logPath, jobId),
      pumpStream(proc.stderr, logPath, jobId),
      proc.exited,
    ]);
    logLine(logPath, `进程结束 exit=${code}`);
  } finally {
    clearTimeout(timeout);
    clearInterval(progressIv);
    clearInterval(heartbeatIv);
  }

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
  recoverStall?: boolean,
): void {
  if (planOnly && !recoverStall) return;
  const r = result as { planId?: string; phase?: string } | null;
  if (!r?.planId) return;
  const approval = getApprovalRecord(projectPath, r.planId);
  if (approval?.status !== "approved") return;
  if (
    r.phase !== "approved" &&
    r.phase !== "planned" &&
    r.phase !== "recovery_approved"
  ) {
    return;
  }
  try {
    const dc = loadConfig(projectPath);
    if (
      ghInstalled() &&
      gitRemoteOrigin(projectPath) &&
      checkPrWorkGate(projectPath, dc).blocked
    ) {
      audit("job.auto_execute_skipped", { alias, planId: r.planId, reason: "open_prs_block" });
      return;
    }
  } catch {
    /* ignore */
  }
  enqueueJob({
    kind: "execute",
    payload: { projectPath, planId: r.planId },
    projectAlias: alias,
  });
  audit("job.auto_execute", { alias, planId: r.planId });
}

export function startWorker(cfg: ServerConfig): () => void {
  for (const job of reclaimOrphanedRunningJobs()) {
    audit("job.reclaimed_orphan", { id: job.id, alias: job.project_alias });
  }
  const reclaimed = reclaimStaleJobs(STALE_RECLAIM_MS);
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

  const runningKinds = new Map<string, Set<JobKind>>();
  let stopped = false;

  function trackStart(alias: string, kind: JobKind): void {
    let s = runningKinds.get(alias);
    if (!s) {
      s = new Set();
      runningKinds.set(alias, s);
    }
    s.add(kind);
  }

  function trackEnd(alias: string, kind: JobKind): void {
    const s = runningKinds.get(alias);
    if (!s) return;
    s.delete(kind);
    if (s.size === 0) runningKinds.delete(alias);
  }

  let tick = 0;
  const loop = async () => {
    while (!stopped) {
      tick++;
      if (tick % 30 === 0) {
        for (const job of reclaimStaleJobs(STALE_RECLAIM_MS)) {
          audit("job.reclaimed_stale", { id: job.id, alias: job.project_alias });
        }
      }
      if (runningKinds.size >= cfg.max_concurrent_projects) {
        await Bun.sleep(2000);
        continue;
      }

      const job = claimNextJob();
      if (!job) {
        await Bun.sleep(2000);
        continue;
      }

      trackStart(job.project_alias, job.kind);
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

        if (job.kind === "execute") {
          try {
            const dc = loadConfig(projectPath);
            if (
              dc.vcs.enabled &&
              dc.vcs.review_open_prs !== false &&
              !hasPrReviewInFlight(job.project_alias)
            ) {
              enqueueJob({
                kind: "pr-review",
                payload: { projectPath },
                projectAlias: job.project_alias,
              });
              audit("pr_review.enqueued_after_execute", { alias: job.project_alias });
            }
          } catch {
            /* ignore */
          }
        }

        if (job.kind === "discover-daily") {
          const dailyPayload = payload as DailyJobPayload;
          maybeEnqueueExecuteAfterDiscover(
            cfg,
            job.project_alias,
            projectPath,
            result,
            dailyPayload.planOnly,
            dailyPayload.recoverStall,
          );
        }

        const recoverStall = (payload as DailyJobPayload).recoverStall;
        if ((job.kind === "daily" || job.kind === "discover-daily") && !recoverStall) {
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
        trackEnd(job.project_alias, job.kind);
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
