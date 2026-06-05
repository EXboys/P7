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
  return { planId, finding: finding(severity, confidence), label, planStatus: "failed" as const };
}

function makeDataset(
  samples: CalibrationDataset["samples"],
): CalibrationDataset {
  const tp = samples.reduce((s, sm) => s + sm.labels.filter(l => l.label === "tp").length, 0);
  const fp = samples.reduce((s, sm) => s + sm.labels.filter(l => l.label === "fp").length, 0);
  const ul = samples.reduce((s, sm) => s + sm.labels.filter(l => l.label === "unlabeled").length, 0);
  return { samples, labelCounts: { truePositive: tp, falsePositive: fp, unlabeled: ul }, generatedAt: "" };
}

interface EvaluationMetrics {
  recall: number;
  fpr: number;
  f1: number;
  precision: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  total: number;
}

/**
 * Evaluate a single severity cutoff against labeled data in the dataset.
 * Returns recall, FPR, F1, precision and the confusion matrix counts.
 */
function evaluateThreshold(
  dataset: CalibrationDataset,
  severity: DcSeverity,
  cutoff: number,
): EvaluationMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0;

  for (const sample of dataset.samples) {
    for (const lbl of sample.labels) {
      if (lbl.label === "unlabeled") continue;
      if (lbl.finding.severity !== severity) continue;
      const c = lbl.finding.confidence;
      if (c === undefined || c === null) continue;

      if (c >= cutoff) {
        if (lbl.label === "tp") tp++;
        else fp++;
      } else {
        if (lbl.label === "tp") fn++;
        else tn++;
      }
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
  const f1 = precision === 0 && recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);

  return {
    recall,
    fpr,
    f1,
    precision,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    total: tp + fp + fn + tn,
  };
}

/* ── Synthetic data constructors ── */

/**
 * Training dataset designed so grid search (gridStep=0.05) produces calibrated
 * cutoffs distinct from defaults:
 *   blocker ~0.60 (default 0.70)
 *   warning ~0.60 (default 0.50)
 *   info   ~0.40 (default 0.30)
 *
 * For each severity level, TP confidences are all higher than FP confidences,
 * with a clean separation margin so the optimal cutoff lands at a specific grid
 * point between the highest FP and the lowest TP.
 */
function makeTrainDataset(): CalibrationDataset {
  return makeDataset([
    {
      planId: "train-blocker",
      status: "failed" as const,
      totalFindings: 11,
      labels: [
        // TPs at high confidence: [0.95 … 0.75]
        label("train-blocker", "blocker", 0.95, "tp"),
        label("train-blocker", "blocker", 0.90, "tp"),
        label("train-blocker", "blocker", 0.85, "tp"),
        label("train-blocker", "blocker", 0.80, "tp"),
        label("train-blocker", "blocker", 0.75, "tp"),
        // FPs at low confidence: [0.55 … 0.30]
        label("train-blocker", "blocker", 0.55, "fp"),
        label("train-blocker", "blocker", 0.50, "fp"),
        label("train-blocker", "blocker", 0.45, "fp"),
        label("train-blocker", "blocker", 0.40, "fp"),
        label("train-blocker", "blocker", 0.35, "fp"),
        label("train-blocker", "blocker", 0.30, "fp"),
      ],
    },
    {
      planId: "train-warning",
      status: "failed" as const,
      totalFindings: 9,
      labels: [
        // TPs: [0.90 … 0.70]
        label("train-warning", "warning", 0.90, "tp"),
        label("train-warning", "warning", 0.85, "tp"),
        label("train-warning", "warning", 0.80, "tp"),
        label("train-warning", "warning", 0.75, "tp"),
        label("train-warning", "warning", 0.70, "tp"),
        // FPs: [0.55 … 0.40]
        label("train-warning", "warning", 0.55, "fp"),
        label("train-warning", "warning", 0.50, "fp"),
        label("train-warning", "warning", 0.45, "fp"),
        label("train-warning", "warning", 0.40, "fp"),
      ],
    },
    {
      planId: "train-info",
      status: "failed" as const,
      totalFindings: 9,
      labels: [
        // TPs: [0.70 … 0.50]
        label("train-info", "info", 0.70, "tp"),
        label("train-info", "info", 0.65, "tp"),
        label("train-info", "info", 0.60, "tp"),
        label("train-info", "info", 0.55, "tp"),
        label("train-info", "info", 0.50, "tp"),
        // FPs: [0.35 … 0.25]
        label("train-info", "info", 0.35, "fp"),
        label("train-info", "info", 0.32, "fp"),
        label("train-info", "info", 0.28, "fp"),
        label("train-info", "info", 0.25, "fp"),
      ],
    },
  ]);
}

/**
 * Hold-out test dataset where calibrated thresholds strictly beat defaults:
 *   - Blocker: TPs exist at confidence 0.62-0.65 (between calibrated 0.60 and
 *     default 0.70) → calibrated catches them, default misses → recall improves.
 *   - All FPs are below the calibrated thresholds → FPR does not regress.
 *   - Result: calibrated F1 ≥ default F1 for every severity, with strictly
 *     higher blocker recall.
 */
function makeTestDataset(): CalibrationDataset {
  return makeDataset([
    {
      planId: "test-blocker",
      status: "failed" as const,
      totalFindings: 10,
      labels: [
        label("test-blocker", "blocker", 0.95, "tp"),
        label("test-blocker", "blocker", 0.85, "tp"),
        label("test-blocker", "blocker", 0.75, "tp"),
        // These two TPs are caught only by the lower calibrated cutoff (0.60):
        label("test-blocker", "blocker", 0.65, "tp"),
        label("test-blocker", "blocker", 0.62, "tp"),
        // All FPs remain below calibrated cutoff:
        label("test-blocker", "blocker", 0.55, "fp"),
        label("test-blocker", "blocker", 0.50, "fp"),
        label("test-blocker", "blocker", 0.45, "fp"),
        label("test-blocker", "blocker", 0.40, "fp"),
        label("test-blocker", "blocker", 0.35, "fp"),
      ],
    },
    {
      planId: "test-warning",
      status: "failed" as const,
      totalFindings: 9,
      labels: [
        label("test-warning", "warning", 0.90, "tp"),
        label("test-warning", "warning", 0.85, "tp"),
        label("test-warning", "warning", 0.80, "tp"),
        label("test-warning", "warning", 0.75, "tp"),
        label("test-warning", "warning", 0.65, "tp"),
        // FPs sit below default cutoff but calibrated (0.60) filters more:
        label("test-warning", "warning", 0.55, "fp"),
        label("test-warning", "warning", 0.45, "fp"),
        label("test-warning", "warning", 0.40, "fp"),
        label("test-warning", "warning", 0.35, "fp"),
      ],
    },
    {
      planId: "test-info",
      status: "failed" as const,
      totalFindings: 8,
      labels: [
        label("test-info", "info", 0.70, "tp"),
        label("test-info", "info", 0.60, "tp"),
        label("test-info", "info", 0.50, "tp"),
        label("test-info", "info", 0.45, "tp"),
        // FPs that default (0.30) incorrectly flags but calibrated (0.40) correctly excludes:
        label("test-info", "info", 0.38, "fp"),
        label("test-info", "info", 0.32, "fp"),
        // FPs below both thresholds:
        label("test-info", "info", 0.28, "fp"),
        label("test-info", "info", 0.22, "fp"),
      ],
    },
  ]);
}

/* ── Tests ── */

describe("calibration A/B test", () => {
  test("empty train dataset falls back to defaults with zero metrics", () => {
    const train = makeDataset([]);
    const calibrated = searchOptimalCutoffs(train);

    expect(calibrated.blocker.cutoff).toBe(0.7);
    expect(calibrated.blocker.totalLabeled).toBe(0);
    expect(calibrated.blocker.f1).toBe(0);
    expect(calibrated.warning.cutoff).toBe(0.5);
    expect(calibrated.warning.totalLabeled).toBe(0);
    expect(calibrated.info.cutoff).toBe(0.3);
    expect(calibrated.info.totalLabeled).toBe(0);
    expect(calibrated.totalSamplesUsed).toBe(0);
  });

  test("calibrated thresholds match expected distinct-from-default cutoffs on training data", () => {
    const train = makeTrainDataset();
    const calibrated = searchOptimalCutoffs(train);

    // Block er: TPs [0.75-0.95] vs FPs [0.30-0.55] → first max-F1 cutoff = 0.60
    expect(calibrated.blocker.cutoff).toBe(0.60);
    expect(calibrated.blocker.f1).toBe(1);
    expect(calibrated.blocker.precision).toBe(1);
    expect(calibrated.blocker.recall).toBe(1);

    // Warning: TPs [0.70-0.90] vs FPs [0.40-0.55] → first max-F1 cutoff = 0.60
    expect(calibrated.warning.cutoff).toBe(0.60);
    expect(calibrated.warning.f1).toBe(1);

    // Info: TPs [0.50-0.70] vs FPs [0.25-0.35] → first max-F1 cutoff = 0.40
    expect(calibrated.info.cutoff).toBe(0.40);
    expect(calibrated.info.f1).toBe(1);

    // All 11+9+9 = 29 labeled points used for grid search
    expect(calibrated.totalSamplesUsed).toBe(29);
  });

  test("calibrated thresholds improve blocker recall without FPR regression on hold-out test set", () => {
    const train = makeTrainDataset();
    const test = makeTestDataset();
    const calibrated = searchOptimalCutoffs(train);

    const DEFAULT_BLOCKER = 0.7;
    const DEFAULT_WARNING = 0.5;
    const DEFAULT_INFO = 0.3;

    // ── Blocker: calibrated should strictly beat default on recall ──
    const calBlocker = evaluateThreshold(test, "blocker", calibrated.blocker.cutoff);
    const defBlocker = evaluateThreshold(test, "blocker", DEFAULT_BLOCKER);

    // 5 TPs at [0.95, 0.85, 0.75, 0.65, 0.62]; default (0.70) catches 3, calibrated (0.60) catches 5
    expect(calBlocker.recall).toBeGreaterThan(defBlocker.recall);
    expect(calBlocker.fpr).toBeLessThanOrEqual(defBlocker.fpr);
    expect(calBlocker.f1).toBeGreaterThanOrEqual(defBlocker.f1);

    // ── Warning ──
    const calWarning = evaluateThreshold(test, "warning", calibrated.warning.cutoff);
    const defWarning = evaluateThreshold(test, "warning", DEFAULT_WARNING);

    expect(calWarning.recall).toBeGreaterThanOrEqual(defWarning.recall);
    expect(calWarning.fpr).toBeLessThanOrEqual(defWarning.fpr);
    expect(calWarning.f1).toBeGreaterThanOrEqual(defWarning.f1);

    // ── Info ──
    const calInfo = evaluateThreshold(test, "info", calibrated.info.cutoff);
    const defInfo = evaluateThreshold(test, "info", DEFAULT_INFO);

    expect(calInfo.recall).toBeGreaterThanOrEqual(defInfo.recall);
    expect(calInfo.fpr).toBeLessThanOrEqual(defInfo.fpr);
    expect(calInfo.f1).toBeGreaterThanOrEqual(defInfo.f1);
  });

  test("train dataset below minPositiveSamples falls back to defaults", () => {
    const smallTrain = makeDataset([
      {
        planId: "small",
        status: "failed" as const,
        totalFindings: 2,
        labels: [
          label("small", "blocker", 0.95, "tp"),
          label("small", "blocker", 0.30, "fp"),
        ],
      },
    ]);

    const calibrated = searchOptimalCutoffs(smallTrain, { minPositiveSamples: 3 });

    // Only 2 labeled points → below minPositiveSamples=3 → default fallback
    expect(calibrated.blocker.cutoff).toBe(0.7);
    expect(calibrated.blocker.totalLabeled).toBe(2);
    expect(calibrated.blocker.f1).toBe(0);
    expect(calibrated.warning.cutoff).toBe(0.5);
    expect(calibrated.info.cutoff).toBe(0.3);
    expect(calibrated.totalSamplesUsed).toBe(0);
  });
});
