import type { JobKind } from "./types.ts";

/** 占用主仓库工作区或 Git：彼此互斥，pr-review 全程阻塞其它项 */
export const PROJECT_MUTEX_KINDS: readonly JobKind[] = [
  "execute",
  "pr-review",
  "discover-daily",
  "daily",
] as const;

export function isProjectMutexKind(kind: JobKind): boolean {
  return (PROJECT_MUTEX_KINDS as readonly string[]).includes(kind);
}

function mutexRunning(kinds: Set<JobKind>): boolean {
  for (const k of PROJECT_MUTEX_KINDS) {
    if (kinds.has(k)) return true;
  }
  return false;
}

/** Worker claim：同项目互斥任务不能并行 */
export function jobBlockedByRunning(
  _alias: string,
  kind: JobKind,
  running: Map<string, Set<JobKind>>,
): boolean {
  const kinds = running.get(_alias);
  if (!kinds || kinds.size === 0) return false;

  if (isProjectMutexKind(kind)) {
    return mutexRunning(kinds);
  }

  // 其它任务类型：互斥组在跑时也不启动（避免写 .p7 / 根目录文件）
  if (mutexRunning(kinds)) return true;
  return kinds.has(kind);
}
