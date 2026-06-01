/**
 * 信号量 —— 限制同一时刻的并发操作数。
 * acquire 在容量未满时立即返回，否则排队等待 release。
 */
export class Semaphore {
  private max: number;
  private count = 0;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.count = Math.max(0, this.count - 1);
    }
  }
}

/** 全局 executor 信号量，限制同时执行的 executePlan 实例数 */
export const executorSemaphore = new Semaphore(2);

export function isRetryableError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("500") ||
    msg.includes("network")
  );
}

/**
 * 指数退避重试。
 * @param opts.maxRetries - 最大重试次数（默认 3）
 * @param opts.initialDelayMs - 初始延迟 ms（默认 5000）
 * @param opts.maxDelayMs - 延迟上限 ms（默认 60000），每次翻倍后取 min(delay * 2, maxDelayMs)
 */
export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; initialDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const initialDelay = opts.initialDelayMs ?? 5000;
  const maxDelay = opts.maxDelayMs ?? 60000;
  let delay = initialDelay;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= maxRetries || !isRetryableError(e)) throw e;
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
  throw lastErr;
}
