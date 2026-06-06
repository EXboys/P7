import { describe, expect, test } from "bun:test";
import { classifyFailure } from "../src/failure-classifier.ts";

describe("classifyFailure", () => {
  test("classifies typecheck and test failures as auto-repairable", () => {
    expect(classifyFailure("typecheck failed: src/a.ts(1,1): error TS2322").kind).toBe("typecheck");
    expect(classifyFailure("test failed: expected 1 to be 2").autoRepair).toBe(true);
  });

  test("classifies write boundary permission as hard stop", () => {
    const result = classifyFailure(
      "Permission violations (fatal):\n- Write: File path outside worktree boundary: /tmp/x",
    );
    expect(result.kind).toBe("permission");
    expect(result.hardStop).toBe(true);
  });

  test("classifies diff size as soft auto-repair signal", () => {
    const result = classifyFailure("Diff too large: 1200 lines > 1000");
    expect(result.kind).toBe("diff_size");
    expect(result.autoRepair).toBe(true);
  });
});
