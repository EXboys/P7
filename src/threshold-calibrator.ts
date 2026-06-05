import type { CalibrationDataset, DcSeverity } from "./types.ts";

// ── Exported types ──

/** A single severity level's calibrated threshold with performance metrics. */
export interface SeverityThreshold {
  severity: DcSeverity;
  cutoff: number;
  f1: number;
  precision: number;
  recall: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  totalLabeled: number;
}

/** Aggregated calibrated thresholds for all severity levels. */
export interface CalibratedThresholds {
  blocker: SeverityThreshold;
  warning: SeverityThreshold;
  info: SeverityThreshold;
  generatedAt: string;
  totalSamplesUsed: number;
}

// ── Default fallback cutoffs (used when labeled data is insufficient) ──

const DEFAULT_CUTOFFS: Record<DcSeverity, number> = {
  blocker: 0.7,
  warning: 0.5,
  info: 0.3,
};

// ── Helpers ──

function f1Score(precision: number, recall: number): number {
  if (precision === 0 && recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

interface LabeledPoint {
  confidence: number;
  label: "tp" | "fp";
}

/**
 * Grid search over [0, 1.0] for the cutoff that maximizes F1.
 * Ties broken by first-encountered (lowest cutoff achieving max F1 wins).
 */
function searchSeverity(
  points: LabeledPoint[],
  gridStep: number,
  severity: DcSeverity,
): SeverityThreshold {
  const steps = Math.round(1.0 / gridStep);
  let best: SeverityThreshold | null = null;

  for (let i = 0; i <= steps; i++) {
    const cutoff = Math.min(Math.round(i * gridStep * 1_000) / 1_000, 1.0);
    let tp = 0, fp = 0, fn = 0, tn = 0;

    for (const p of points) {
      if (p.confidence >= cutoff) {
        if (p.label === "tp") tp++;
        else fp++;
      } else {
        if (p.label === "tp") fn++;
        else tn++;
      }
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = f1Score(precision, recall);

    if (!best || f1 > best.f1) {
      best = {
        severity,
        cutoff,
        f1,
        precision,
        recall,
        truePositives: tp,
        falsePositives: fp,
        falseNegatives: fn,
        trueNegatives: tn,
        totalLabeled: points.length,
      };
    }
  }

  return best!;
}

// ── Main export ──

/**
 * Run grid search per severity level to find optimal confidence cutoffs.
 *
 * For each DcSeverity level, extracts tp/fp-labeled findings with confidence
 * scores from the dataset, searches [0, 1] by `gridStep`, and returns the
 * cutoff that maximizes F1 score.
 *
 * Falls back to hardcoded defaults for any severity level with fewer labeled
 * points than `minPositiveSamples` or zero true-positive labels.
 *
 * @param dataset - Calibration dataset with labeled findings
 * @param options.gridStep - Search step size (default 0.05)
 * @param options.minPositiveSamples - Minimum labeled pts to grid-search (default 3)
 * @param options.severityDefaults - Override fallback cutoffs per severity
 */
export function searchOptimalCutoffs(
  dataset: CalibrationDataset,
  options?: {
    gridStep?: number;
    minPositiveSamples?: number;
    severityDefaults?: Partial<Record<DcSeverity, number>>;
  },
): CalibratedThresholds {
  const gridStep = options?.gridStep ?? 0.05;
  const minPos = options?.minPositiveSamples ?? 3;
  const defaults = { ...DEFAULT_CUTOFFS, ...options?.severityDefaults };

  // Group tp/fp-labeled findings with confidence scores by severity
  const bySeverity: Record<DcSeverity, LabeledPoint[]> = {
    blocker: [],
    warning: [],
    info: [],
  };

  for (const sample of dataset.samples) {
    for (const lbl of sample.labels) {
      if (lbl.label === "unlabeled") continue;
      const c = lbl.finding.confidence;
      if (c === undefined || c === null) continue;
      bySeverity[lbl.finding.severity].push({ confidence: c, label: lbl.label });
    }
  }

  let samplesUsed = 0;
  const out: Record<string, SeverityThreshold> = {};
  const severities: DcSeverity[] = ["blocker", "warning", "info"];

  for (const sev of severities) {
    const pts = bySeverity[sev];
    const tpCount = pts.filter(p => p.label === "tp").length;

    if (pts.length < minPos || tpCount === 0) {
      // Insufficient labeled data → return default cutoff with zero metrics
      out[sev] = {
        severity: sev,
        cutoff: defaults[sev],
        f1: 0,
        precision: 0,
        recall: 0,
        truePositives: 0,
        falsePositives: 0,
        falseNegatives: 0,
        trueNegatives: 0,
        totalLabeled: pts.length,
      };
    } else {
      out[sev] = searchSeverity(pts, gridStep, sev);
      samplesUsed += pts.length;
    }
  }

  return {
    blocker: out.blocker,
    warning: out.warning,
    info: out.info,
    generatedAt: new Date().toISOString(),
    totalSamplesUsed: samplesUsed,
  };
}
