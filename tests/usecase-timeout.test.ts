import { describe, expect, test } from "bun:test";
import { awaitWithJobDeadline, jobTimeoutMessage } from "../server/queue/usecase-timeout.ts";
import { normalizeJobError } from "../server/job-error.ts";

describe("awaitWithJobDeadline", () => {
  test("completes before deadline", async () => {
    const v = await awaitWithJobDeadline(async () => 42, 500);
    expect(v).toBe(42);
  });

  test("aborts signal and rejects on timeout", async () => {
    let captured: AbortSignal | undefined;
    const work = awaitWithJobDeadline(async ({ signal }) => {
      captured = signal;
      await new Promise<void>(() => {});
    }, 25);
    await expect(work).rejects.toThrow(jobTimeoutMessage(25));
    expect(captured?.aborted).toBe(true);
  });

  test("timeout message normalizes like subprocess exit 143", () => {
    const msg = normalizeJobError(jobTimeoutMessage(35 * 60 * 1000), 143);
    expect(msg).toMatch(/超时被终止/);
  });
});
