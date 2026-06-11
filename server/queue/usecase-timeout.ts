/** direct-usecase 与 subprocess exit 143 对齐的超时语义 */

export const JOB_TIMEOUT_EXIT = 143;

export function jobTimeoutMessage(timeoutMs: number): string {
  const min = Math.round(timeoutMs / 60000);
  return `超时 ${min} 分钟，终止 usecase`;
}

export type JobDeadlineContext = {
  signal: AbortSignal;
};

/**
 * 在 deadline 内运行 usecase；超时 abort 并 reject（消息含「终止」供 normalizeJobError 识别）。
 */
export async function awaitWithJobDeadline<T>(
  work: (ctx: JobDeadlineContext) => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      onTimeout?.();
      reject(new Error(jobTimeoutMessage(timeoutMs)));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work({ signal: ac.signal }), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
