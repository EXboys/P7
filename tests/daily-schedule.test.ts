import { describe, expect, test } from "bun:test";
import {
  filterActiveDailyToday,
  filterCompletedFullDailyToday,
  isRecoverStallPayload,
} from "../src/daily-schedule.ts";
import type { JobRow } from "../server/queue/types.ts";

function job(partial: Partial<JobRow> & Pick<JobRow, "payload" | "status" | "kind">): JobRow {
  const day = new Date().toISOString().slice(0, 10);
  return {
    id: "1",
    project_alias: "p7",
    created_at: `${day}T12:00:00.000Z`,
    started_at: null,
    finished_at: null,
    progress: null,
    error: null,
    result_json: null,
    owner_user_id: null,
    ...partial,
  };
}

describe("daily schedule", () => {
  test("recoverStall payload detection", () => {
    expect(isRecoverStallPayload('{"recoverStall":true}')).toBe(true);
    expect(isRecoverStallPayload('{"planOnly":true}')).toBe(false);
  });

  test("recoverStall done does not count as full daily done", () => {
    const jobs = [
      job({
        kind: "discover-daily",
        status: "done",
        payload: JSON.stringify({ recoverStall: true }),
      }),
    ];
    expect(filterCompletedFullDailyToday(jobs)).toBe(false);
  });

  test("normal discover done blocks full daily", () => {
    const jobs = [
      job({
        kind: "discover-daily",
        status: "done",
        payload: JSON.stringify({ planOnly: true }),
      }),
    ];
    expect(filterCompletedFullDailyToday(jobs)).toBe(true);
  });

  test("failed discover does not block", () => {
    const jobs = [
      job({
        kind: "discover-daily",
        status: "failed",
        payload: JSON.stringify({ recoverStall: true }),
      }),
    ];
    expect(filterCompletedFullDailyToday(jobs)).toBe(false);
    expect(filterActiveDailyToday(jobs)).toBe(false);
  });
});
