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
