import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parsePlanCriticFindings, tryParseCriticJson } from "../src/planner.ts";
import {
  closeDb,
  getPlanCriticFindings,
  initDb,
  updatePlanCriticFindings,
  upsertPlanState,
} from "../src/state.ts";

/* ── Helpers ── */

/** Build simulated planner+critic response with two fenced JSON blocks. */
function twoBlock(
  critic: unknown,
  plan: unknown = { title: "t", changes: [] },
  prefix = "",
): string {
  const c = "```json\n" + JSON.stringify(critic) + "\n```";
  const p = "```json\n" + JSON.stringify(plan) + "\n```";
  return prefix + c + "\n" + p;
}

/* ─────────────────────────────────────────────────────
 * Group 1-3: parsePlanCriticFindings
 * ───────────────────────────────────────────────────── */

describe("parsePlanCriticFindings", () => {
  // Group 1: valid structured JSON
  test("parses valid JSON with all severity levels", () => {
    const r = parsePlanCriticFindings(
      twoBlock({
        ok: false,
        summary: "Issues",
        findings: [
          { severity: "blocker", category: "scope", target: "a.ts", description: "Too broad", recommendation: "Narrow" },
          { severity: "warning", category: "risk", target: "plan", description: "Uncertain", recommendation: "Add" },
          { severity: "info", category: "style", target: "plan", description: "Minor", recommendation: "" },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(3);
    expect(r.findings.map((f) => f.severity)).toEqual(["blocker", "warning", "info"]);
    expect(r.summary).toBe("Issues");
  });

  test("handles empty findings", () => {
    const r = parsePlanCriticFindings(twoBlock({ ok: true, summary: "OK", findings: [] }));
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  test("code field is optional", () => {
    const r = parsePlanCriticFindings(
      twoBlock({
        ok: true,
        summary: "",
        findings: [
          { severity: "info", category: "c", target: "t", description: "d", recommendation: "", code: "x.ts:42" },
        ],
      }),
    );
    expect(r.findings[0].code).toBe("x.ts:42");
  });

  // Group 2: malformed / missing-field fallback
  test("falls back to regex when JSON has no ok field", () => {
    const r = parsePlanCriticFindings(
      "```json\n{\"summary\":\"x\"}\n```\n```json\n{\"title\":\"t\"}\n```\nOK: false",
    );
    expect(r.ok).toBe(false);
  });

  test("falls back to regex when critic JSON is unparsable", () => {
    const r = parsePlanCriticFindings(
      "```json\n{invalid}\n```\n```json\n{\"title\":\"t\"}\n```\nOK: true",
    );
    expect(r.ok).toBe(true);
  });

  test("falls back to regex-default (ok=true) when no OK: marker either", () => {
    const r = parsePlanCriticFindings("Just plain text without any marker");
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  // Group 3: extraction strategies
  test("falls through to regex fallback when only one fenced block", () => {
    // Only one fenced block → method 1 fails; method 2 extracts it as plan, removes it,
    // then finds nothing in the remainder → regex fallback (default ok=true).
    const r = parsePlanCriticFindings(
      "prefix\n```json\n{\"ok\":false,\"summary\":\"x\",\"findings\":[]}\n```\nsuffix\nOK: false",
    );
    expect(r.ok).toBe(false);
  });

  test("method 2 recovers when second-to-last block is not valid JSON", () => {
    // Three blocks: middle one is not JSON, so method 1 fails. Method 2 strips the last block and re-parses.
    const r = parsePlanCriticFindings([
      "```json",
      JSON.stringify({ ok: true, summary: "y", findings: [] }),
      "```",
      "```json",
      "not json content",
      "```",
      "```json",
      JSON.stringify({ title: "t" }),
      "```",
    ].join("\n"));
    expect(r.ok).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────
 * Group 4: tryParseCriticJson severity coercion
 * ───────────────────────────────────────────────────── */

describe("tryParseCriticJson", () => {
  /** Helper: build finding with overrides. JSON drops undefined keys. */
  function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { severity: "info", category: "c", target: "t", description: "d", recommendation: "r", ...overrides };
  }

  function json(ok: boolean, findings: unknown[], summary = "") {
    return tryParseCriticJson(JSON.stringify({ ok, summary, findings }));
  }

  test("preserves blocker / warning / info", () => {
    for (const sev of ["blocker", "warning", "info"]) {
      expect(json(true, [finding({ severity: sev })])!.findings[0].severity).toBe(sev);
    }
  });

  test("coerces unknown severity to info", () => {
    expect(json(true, [finding({ severity: "critical" })])!.findings[0].severity).toBe("info");
  });

  test("coerces uppercase via toLowerCase (BLOCKER→blocker)", () => {
    expect(json(true, [finding({ severity: "BLOCKER" })])!.findings[0].severity).toBe("blocker");
  });

  test("defaults missing severity/category/target/recommendation", () => {
    // Pass only description – JSON.stringify drops undefined keys
    const r = json(true, [{ description: "d" }]);
    expect(r!.findings[0].severity).toBe("info");
    expect(r!.findings[0].category).toBe("other");
    expect(r!.findings[0].target).toBe("plan");
    expect(r!.findings[0].recommendation).toBe("");
    expect(r!.findings[0].code).toBeUndefined();
  });

  test("returns null for non-object input", () => {
    expect(tryParseCriticJson('"str"')).toBeNull();
    expect(tryParseCriticJson("42")).toBeNull();
    expect(tryParseCriticJson("not-json")).toBeNull();
  });

  test("returns null when ok is not boolean", () => {
    expect(tryParseCriticJson(JSON.stringify({ ok: "yes", summary: "", findings: [] }))).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────
 * Group 5: persistence round-trip
 * ───────────────────────────────────────────────────── */

describe("updatePlanCriticFindings + getPlanCriticFindings", () => {
  let root: string;

  // Setup once for the group
  afterAll(() => {
    if (root) {
      closeDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes and reads findings via SQLite", () => {
    root = mkdtempSync(join(tmpdir(), "p7-critic-"));
    mkdirSync(join(root, ".p7"), { recursive: true });
    initDb(root);
    upsertPlanState(root, {
      planId: "ct-1",
      projectPath: root,
      goal: "g",
      title: "Critic Test",
      status: "planned",
      createdAt: new Date().toISOString(),
    });
    const findings = JSON.stringify([{ severity: "blocker", category: "s", target: "x", description: "d", recommendation: "r" }]);
    updatePlanCriticFindings(root, "ct-1", findings);
    expect(getPlanCriticFindings(root, "ct-1")).toBe(findings);
  });

  test("returns null for unknown planId", () => {
    expect(getPlanCriticFindings(root, "nonexistent")).toBeNull();
  });

  test("overwrites on consecutive writes", () => {
    const first = JSON.stringify([{ severity: "info", category: "c", target: "t", description: "a", recommendation: "" }]);
    const second = JSON.stringify([{ severity: "warning", category: "c", target: "t", description: "b", recommendation: "" }]);
    updatePlanCriticFindings(root, "ct-1", first);
    updatePlanCriticFindings(root, "ct-1", second);
    expect(getPlanCriticFindings(root, "ct-1")).toBe(second);
  });

  test("survives DB close / reopen", () => {
    closeDb(root);
    const read = getPlanCriticFindings(root, "ct-1");
    expect(read).not.toBeNull();
    const parsed = JSON.parse(read!);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed[0].severity).toBe("warning");
  });
});
