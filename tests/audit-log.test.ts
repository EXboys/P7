import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { queryAuditLogs } from "../server/audit-log.ts";

describe("audit-log", () => {
  test("paginates newest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "p7-audit-"));
    const logPath = join(dir, "server.log");
    const lines = Array.from({ length: 15 }, (_, i) =>
      JSON.stringify({ at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, event: `e${i}`, alias: "p7" }),
    );
    writeFileSync(logPath, lines.join("\n") + "\n");

    const p1 = queryAuditLogs(logPath, { page: 1, perPage: 10 });
    expect(p1.total).toBe(15);
    expect(p1.totalPages).toBe(2);
    expect(p1.entries.length).toBe(10);
    expect(p1.entries[0]?.event).toBe("e14");

    const p2 = queryAuditLogs(logPath, { page: 2, perPage: 10 });
    expect(p2.entries.length).toBe(5);
    expect(p2.entries[0]?.event).toBe("e4");
  });

  test("filters by event and alias", () => {
    const dir = mkdtempSync(join(tmpdir(), "p7-audit-"));
    const logPath = join(dir, "server.log");
    writeFileSync(
      logPath,
      [
        JSON.stringify({ at: "1", event: "job.done", alias: "p7" }),
        JSON.stringify({ at: "2", event: "job.failed", alias: "p7" }),
        JSON.stringify({ at: "3", event: "job.done", alias: "other" }),
      ].join("\n") + "\n",
    );
    const r = queryAuditLogs(logPath, { event: "job.done", alias: "p7" });
    expect(r.total).toBe(1);
    expect(r.entries[0]?.event).toBe("job.done");
  });
});
