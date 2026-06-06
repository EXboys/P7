import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { projectSubpathForRead } from "./p7-paths.ts";
import { listJobsForProject, readJobLog } from "./job-read-model.ts";

const LOG_TAIL_CHARS = 3500;

type FailedPlanRecord = {
  planId?: string;
  title?: string;
  reason?: string;
  failedAt?: string;
};

function latestFailedPlanRecord(
  projectPath: string,
  planId: string,
  planTitle: string,
): FailedPlanRecord | null {
  const dir = projectSubpathForRead(projectPath, "failed-plans");
  if (!existsSync(dir)) return null;
  const matches: FailedPlanRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8")) as FailedPlanRecord;
      if (raw.planId === planId || raw.title === planTitle) matches.push(raw);
    } catch {
      /* ignore */
    }
  }
  matches.sort(
    (a, b) =>
      new Date(b.failedAt ?? 0).getTime() - new Date(a.failedAt ?? 0).getTime(),
  );
  return matches[0] ?? null;
}

function latestFailedExecuteJob(projectAlias: string, planId: string, excludeJobId?: string) {
  return listJobsForProject(projectAlias, 100).find((j) => {
    if (j.kind !== "execute" || j.status !== "failed") return false;
    if (excludeJobId && j.id === excludeJobId) return false;
    try {
      return (JSON.parse(j.payload) as { planId?: string }).planId === planId;
    } catch {
      return false;
    }
  });
}

/** 重试 execute 时：汇总上次失败原因与 job 日志末尾，供 executor prompt 使用 */
export function loadPreviousExecuteFailureContext(
  projectPath: string,
  planId: string,
  planTitle: string,
  projectAlias?: string,
  excludeJobId?: string,
): string {
  const parts: string[] = [];

  const archived = latestFailedPlanRecord(projectPath, planId, planTitle);
  if (archived?.reason) {
    const when = archived.failedAt?.replace("T", " ").slice(0, 19) ?? "未知时间";
    parts.push(`归档失败记录（${when}）：${archived.reason}`);
  }

  if (projectAlias) {
    const job = latestFailedExecuteJob(projectAlias, planId, excludeJobId);
    if (job?.error && !parts.some((p) => p.includes(job.error!))) {
      parts.push(`队列任务 ${job.id} 错误：${job.error}`);
    }
    if (job) {
      const log = readJobLog(job.id);
      const trimmed = log.trim();
      if (trimmed) {
        const tail =
          trimmed.length > LOG_TAIL_CHARS
            ? trimmed.slice(-LOG_TAIL_CHARS)
            : trimmed;
        parts.push(`上次 execute 日志（末尾 ${tail.length} 字符）：\n${tail}`);
      }
    }
  }

  if (parts.length === 0) return "";
  return parts.join("\n\n").slice(0, 6500);
}

export function formatExecuteRetryPromptBlock(failureContext: string): string {
  if (!failureContext.trim()) return "";
  return `\n\n【上次执行失败 — 请阅读并避免重复】\n${failureContext}\n\n你必须根据上述失败原因调整策略，确保本次产生 Plan 所列文件的实际代码变更。`;
}
