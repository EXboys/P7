import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readRoadmapBackup, roadmapBackupPath } from "../src/roadmap.ts";

describe("roadmap backup read", () => {
  test("reads backup by filename", () => {
    const dir = join(tmpdir(), `p7-backup-read-${Date.now()}`);
    const hist = join(dir, ".p7", "roadmap-history");
    mkdirSync(hist, { recursive: true });
    writeFileSync(join(hist, "ROADMAP-1234567890.md"), "# Roadmap\n## Active\n- [ ] step");
    expect(readRoadmapBackup(dir, "ROADMAP-1234567890.md")).toContain("# Roadmap");
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects path traversal filenames", () => {
    const dir = join(tmpdir(), `p7-backup-safe-${Date.now()}`);
    expect(roadmapBackupPath(dir, "../ROADMAP.md")).toBeNull();
    expect(readRoadmapBackup(dir, "evil.md")).toBeNull();
  });
});
