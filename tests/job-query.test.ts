import { describe, expect, test } from "bun:test";
import { paginateJobRows } from "../server/job-query.ts";
import type { JobRow } from "../server/queue/types.ts";

function job(id: string, created: string, alias = "p7"): JobRow {
  return {
    id,
    kind: "execute",
    payload: "{}",
    status: "done",
    project_alias: alias,
    owner_user_id: null,
    created_at: created,
    started_at: null,
    finished_at: null,
    progress: null,
    result_json: null,
    error: null,
  };
}

describe("job-query", () => {
  test("defaults to 20 per page newest first", () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      job(`j${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );
    const p1 = paginateJobRows(rows, { page: 1 });
    expect(p1.perPage).toBe(20);
    expect(p1.total).toBe(25);
    expect(p1.totalPages).toBe(2);
    expect(p1.jobs.length).toBe(20);
    expect(p1.jobs[0]?.id).toBe("j24");
  });

  test("filters by alias and status", () => {
    const rows = [
      { ...job("a", "1"), status: "failed" as const },
      { ...job("b", "2"), project_alias: "other" },
    ];
    const r = paginateJobRows(rows, { alias: "p7", status: "failed" });
    expect(r.total).toBe(1);
    expect(r.jobs[0]?.id).toBe("a");
  });
});
