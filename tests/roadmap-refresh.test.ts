import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { extractValidRoadmapMarkdown, refreshRoadmapFromBacklog } from "../src/roadmap-refresh.ts";
import { recommendRoadmapGoal } from "../src/roadmap.ts";

describe("extractValidRoadmapMarkdown", () => {
  test("rejects summary without # Roadmap", () => {
    const summary = `新 ROADMAP.md 已就绪，等待写入授权。以下是变更摘要：
## 变更说明
- foo`;
    expect(extractValidRoadmapMarkdown(summary)).toBeNull();
  });

  test("accepts valid roadmap with unchecked steps", () => {
    const md = `# Roadmap
## Active
Feature: Test (started 2026-05-31)
- [ ] do something
## Backlog
- later
## Done
- old work`;
    expect(extractValidRoadmapMarkdown(md)).toContain("# Roadmap");
  });

  test("rejects roadmap with only completed active steps when required", () => {
    const md = `# Roadmap
## Active
Feature: Test (started 2026-05-31)
- [x] already done
## Backlog
- later
## Done
- old work`;
    expect(extractValidRoadmapMarkdown(md, { requireUncheckedActive: true })).toBeNull();
  });

  test("extracts markdown after preamble", () => {
    const text = `说明文字\n\n# Roadmap\n## Active\nFeature: X (started 2026-05-31)\n- [ ] step\n## Backlog\n- b\n## Done\n- d`;
    const out = extractValidRoadmapMarkdown(text);
    expect(out?.startsWith("# Roadmap")).toBe(true);
  });
});

describe("refreshRoadmapFromBacklog", () => {
  test("promotes backlog items to active unchecked steps", () => {
    const dir = join(tmpdir(), `p7-roadmap-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ROADMAP.md"),
      `# Roadmap
## Active
Feature: Old (started 2026-05-30)
- [x] done step
## Backlog
- Feature A work
- Feature B work
## Done
- prior
`,
    );
    expect(refreshRoadmapFromBacklog(dir)).toBe(true);
    expect(recommendRoadmapGoal(dir)).toContain("Feature A");
    rmSync(dir, { recursive: true, force: true });
  });
});
