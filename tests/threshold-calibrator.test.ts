import { describe, expect, test } from "bun:test";
import type { CalibrationDataset, DcSeverity } from "../src/types.ts";
import { searchOptimalCutoffs } from "../src/threshold-calibrator.ts";

/* ── Helpers ── */

function finding(
  severity: DcSeverity,
  confidence: number,
): CalibrationDataset["samples"][number]["labels"][number]["finding"] {
  return { dimension: "漏洞发现", severity, message: `test [confidence:${confidence}]`, confidence };
}

function label(
  planId: string,
  severity: DcSeverity,
  confidence: number,
  label: "tp" | "fp",
): CalibrationDataset["samples"][number]["labels"][number] {
  return { planId, finding: finding(severity, confidence), label, planStatus: "failed" };
}

function makeDataset(
  samples: CalibrationDataset["samples"],
): CalibrationDataset {
  const tp = samples.reduce((s, sm) => s + sm.labels.filter(l => l.label === "tp").length, 0);
  const fp = samples.reduce((s, sm) => s + sm.labels.filter(l => l.label === "fp").length, 0);
  const ul = samples.reduce((s, sm) => s + sm.labels.filter(l => l.label === "unlabeled").length, 0);
  return { samples, labelCounts: { truePositive: tp, falsePositive: fp, unlabeled: ul }, generatedAt: "" };
}

/* ── Tests ── */

describe("threshold-calibrator", () => {
  test("empty dataset returns default cutoffs with zero counts", () => {
    const ds = makeDataset([]);
    const r = searchOptimalCutoffs(ds);

    expect(r.blocker.cutoff).toBe(0.7);
    expect(r.blocker.totalLabeled).toBe(0);
    expect(r.blocker.f1).toBe(0);
    expect(r.warning.cutoff).toBe(0.5);
    expect(r.warning.totalLabeled).toBe(0);
    expect(r.info.cutoff).toBe(0.3);
    expect(r.info.totalLabeled).toBe(0);
    expect(r.totalSamplesUsed).toBe(0);
  });

  test("perfect separation finds ideal cutoff for blocker", () => {
    const ds = makeDataset([{
      planId: "p1",
      status: "failed" as const,
      totalFindings: 6,
      labels: [
        label("p1", "blocker", 0.95, "tp"),
        label("p1", "blocker", 0.92, "tp"),
        label("p1", "blocker", 0.90, "tp"),
        label("p1", "blocker", 0.30, "fp"),
        label("p1", "blocker", 0.25, "fp"),
        label("p1", "blocker", 0.20, "fp"),
      ],
    }]);

    const r = searchOptimalCutoffs(ds);

    // Optimal cutoff at 0.35 (first grid point separating FP max 0.30 from TP min 0.90)
    expect(r.blocker.cutoff).toBe(0.35);
    expect(r.blocker.f1).toBe(1);
    expect(r.blocker.precision).toBe(1);
    expect(r.blocker.recall).toBe(1);
    expect(r.blocker.truePositives).toBe(3);
    expect(r.blocker.falsePositives).toBe(0);
    expect(r.totalSamplesUsed).toBe(6);
  });

  test("all three severities computed independently with distinct optimal cutoffs", () => {
    const ds = makeDataset([
      {
        planId: "p-b", status: "failed" as const, totalFindings: 6,
        labels: [
          label("p-b", "blocker", 0.95, "tp"), label("p-b", "blocker", 0.92, "tp"),
          label("p-b", "blocker", 0.90, "tp"), label("p-b", "blocker", 0.30, "fp"),
          label("p-b", "blocker", 0.25, "fp"), label("p-b", "blocker", 0.20, "fp"),
        ],
      },
      {
        planId: "p-w", status: "failed" as const, totalFindings: 6,
        labels: [
          label("p-w", "warning", 0.85, "tp"), label("p-w", "warning", 0.80, "tp"),
          label("p-w", "warning", 0.78, "tp"), label("p-w", "warning", 0.50, "fp"),
          label("p-w", "warning", 0.45, "fp"), label("p-w", "warning", 0.40, "fp"),
        ],
      },
      {
        planId: "p-i", status: "failed" as const, totalFindings: 6,
        labels: [
          label("p-i", "info", 0.70, "tp"), label("p-i", "info", 0.60, "tp"),
          label("p-i", "info", 0.58, "tp"), label("p-i", "info", 0.40, "fp"),
          label("p-i", "info", 0.35, "fp"), label("p-i", "info", 0.30, "fp"),
        ],
      },
    ]);

    const r = searchOptimalCutoffs(ds);

    // Blocker: FP max 0.30, TP min 0.90 → ideal at 0.35
    expect(r.blocker.cutoff).toBe(0.35);
    expect(r.blocker.f1).toBe(1);
    // Warning: FP max 0.50, TP min 0.78 → ideal at 0.55
    expect(r.warning.cutoff).toBe(0.55);
    expect(r.warning.f1).toBe(1);
    // Info: FP max 0.40, TP min 0.58 → ideal at 0.45
    expect(r.info.cutoff).toBe(0.45);
    expect(r.info.f1).toBe(1);

    expect(r.totalSamplesUsed).toBe(18);
  });

  test("below minPositiveSamples returns default fallback", () => {
    const ds = makeDataset([{
      planId: "p1", status: "failed" as const, totalFindings: 2,
      labels: [
        label("p1", "blocker", 0.95, "tp"),
        label("p1", "blocker", 0.30, "fp"),
      ],
    }]);

    // minPositiveSamples=3, but only 2 labeled → fallback to default
    const r = searchOptimalCutoffs(ds, { minPositiveSamples: 3 });

    expect(r.blocker.cutoff).toBe(0.7);
    expect(r.blocker.totalLabeled).toBe(2);
    expect(r.blocker.f1).toBe(0);
    expect(r.totalSamplesUsed).toBe(0);
  });

  test("extreme distributions: all-TP (F1=1) and all-FP (defaults)", () => {
    // All-TP: 3 TP, no FP → F1=1.0 at cutoff 0.0 (all predictions positive)
    const allTp = makeDataset([{
      planId: "tp-only", status: "failed" as const, totalFindings: 3,
      labels: [
        label("tp-only", "blocker", 0.95, "tp"),
        label("tp-only", "blocker", 0.90, "tp"),
        label("tp-only", "blocker", 0.85, "tp"),
      ],
    }]);
    const r1 = searchOptimalCutoffs(allTp);
    expect(r1.blocker.f1).toBe(1);
    expect(r1.blocker.precision).toBe(1);
    expect(r1.blocker.recall).toBe(1);
    expect(r1.totalSamplesUsed).toBe(3);

    // All-FP: 3 FP, no TP → falls back to defaults (tpCount === 0)
    const allFp = makeDataset([{
      planId: "fp-only", status: "merged" as const, totalFindings: 3,
      labels: [
        label("fp-only", "blocker", 0.95, "fp"),
        label("fp-only", "blocker", 0.90, "fp"),
        label("fp-only", "blocker", 0.85, "fp"),
      ],
    }]);
    const r2 = searchOptimalCutoffs(allFp);
    expect(r2.blocker.cutoff).toBe(0.7);
    expect(r2.blocker.totalLabeled).toBe(3);
    expect(r2.blocker.f1).toBe(0);
    expect(r2.totalSamplesUsed).toBe(0);
  });
});
