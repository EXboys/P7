import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scaffoldMissingPlanFiles } from "../src/executor-scaffold.ts";
import {
  emptyToolTrace,
  ingestSdkMessageForToolTrace,
  formatToolTraceSummary,
} from "../src/sdk-tool-log.ts";

describe("scaffoldMissingPlanFiles", () => {
  test("creates missing plan files with stub content", () => {
    const root = join(tmpdir(), `p7-scaffold-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const plan = {
        title: "Add fixtures",
        changes: [
          {
            file: "tests/fixtures/foo.ts",
            description: "fixture data",
            estimated_lines: 10,
          },
        ],
      };
      const created = scaffoldMissingPlanFiles(root, plan as never);
      expect(created).toEqual(["tests/fixtures/foo.ts"]);
      const full = join(root, "tests/fixtures/foo.ts");
      expect(existsSync(full)).toBe(true);
      expect(readFileSync(full, "utf-8")).toContain("Scaffold for plan");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips files that already exist", () => {
    const root = join(tmpdir(), `p7-scaffold-skip-${Date.now()}`);
    const existing = join(root, "src/existing.ts");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(existing, "keep", "utf-8");
    try {
      const plan = {
        title: "Edit only",
        changes: [{ file: "src/existing.ts", description: "noop", estimated_lines: 1 }],
      };
      expect(scaffoldMissingPlanFiles(root, plan as never)).toEqual([]);
      expect(readFileSync(existing, "utf-8")).toBe("keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sdk tool trace", () => {
  test("records assistant tool_use calls", () => {
    const trace = emptyToolTrace();
    ingestSdkMessageForToolTrace(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "tests/a.ts" } },
            { type: "tool_use", name: "Read", input: { file_path: "package.json" } },
          ],
        },
      },
      trace,
    );
    expect(trace.writeEditCalls).toBe(1);
    expect(trace.readOnlyCalls).toBe(1);
    expect(trace.lines.some((l) => l.includes("Write tests/a.ts"))).toBe(true);
  });

  test("records permission_denied system messages", () => {
    const trace = emptyToolTrace();
    ingestSdkMessageForToolTrace(
      {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Write",
        decision_reason: "File not in plan",
      },
      trace,
    );
    expect(trace.denied).toBe(1);
    expect(trace.lines[0]).toContain("deny Write");
  });

  test("formatToolTraceSummary summarizes counts", () => {
    const trace = emptyToolTrace();
    trace.writeEditCalls = 2;
    trace.readOnlyCalls = 5;
    expect(formatToolTraceSummary(trace, 1)).toContain("write/edit=2");
    expect(formatToolTraceSummary(trace, 1)).toContain("pass 2");
  });
});
