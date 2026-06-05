import type { DiffCriticFinding } from "./types.ts";
import type { GemmaSliceFinding, GemmaClient, GemmaSliceMeta } from "./gemma-bridge.ts";
import { parseGemmaOutput } from "./gemma-bridge.ts";
import { reviewDiff } from "./diff-critic.ts";

/* ── Dimension normalization (Gemma bilingual ↔ critic Chinese) ── */

const DIM_MAP: Record<string, string> = {
  "过度抽象": "过度抽象",
  "模板重复": "模板重复",
  "不合理嵌套": "不合理嵌套",
  "幻觉检测": "幻觉检测",
  "安全越狱": "安全越狱",
  "类型退化": "类型退化",
  "漏洞发现": "漏洞发现",
  "over-abstraction": "过度抽象",
  "template duplication": "模板重复",
  "unreasonable nesting": "不合理嵌套",
  "hallucination detection": "幻觉检测",
  "security jailbreak": "安全越狱",
  "type regression": "类型退化",
};

const CJK_RE = /[一-鿿]+/g;
const EN_STOP = new Set([
  "the", "this", "that", "with", "from", "using", "should", "would",
  "could", "have", "been", "being", "such",
]);

/** Normalize a dimension name from Gemma bilingual output to critic Chinese. */
export function normalizeDim(raw: string): string {
  const trimmed = raw.trim();
  // Bilingual: "中文 English" → extract Chinese part
  const en = trimmed.match(/^(.+?)\s+[A-Z]/);
  if (en) {
    const cn = en[1].trim();
    if (DIM_MAP[cn]) return DIM_MAP[cn];
  }
  return DIM_MAP[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Extract meaningful keywords from a finding message.
 *
 * CJK text uses character bigrams (no natural word boundaries).
 * Non-CJK text uses word-level splitting by whitespace/punctuation.
 */
export function extractKeywords(msg: string): string[] {
  const out: string[] = [];
  // CJK segments → character bigrams
  const cjk = CJK_RE;
  cjk.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = cjk.exec(msg)) !== null; ) {
    const seg = m[0];
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
  }
  // Non-CJK → word-level split with stop word filter
  const rest = msg.replace(CJK_RE, " ").trim().toLowerCase();
  if (rest) {
    for (const w of rest.split(/[\s,，.。;：()\[\]\-_/\\#@!?]+/)) {
      if (w.length >= 2 && !EN_STOP.has(w)) out.push(w);
    }
  }
  return out;
}

/** Match two findings from different sources by dimension + keyword overlap. */
export function findingsMatch(
  a: { dimension: string; message: string },
  b: { dimension: string; message: string },
): boolean {
  const aDim = normalizeDim(a.dimension);
  const bDim = normalizeDim(b.dimension);
  if (aDim !== bDim) return false;
  const aKw = extractKeywords(a.message);
  const bKw = extractKeywords(b.message);
  if (!aKw.length || !bKw.length) return false;
  const overlap = aKw.filter((k) => bKw.includes(k));
  return overlap.length >= Math.min(aKw.length, bKw.length) * 0.3;
}

/* ── Agreement metrics ── */

export interface PerDimMetrics {
  tp: number; fp: number; fn: number;
  precision: number; recall: number; f1: number;
  fpr: number; fnr: number;
}

export interface GemmaCriticAgreement {
  overall: PerDimMetrics;
  perDimension: Record<string, PerDimMetrics>;
}

function calc(s: { tp: number; fp: number; fn: number }): PerDimMetrics {
  const precision = s.tp + s.fp > 0 ? s.tp / (s.tp + s.fp) : 0;
  const recall = s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : 0;
  const denomP = precision + recall;
  return {
    ...s,
    precision,
    recall,
    f1: denomP > 0 ? 2 * precision * recall / denomP : 0,
    fpr: s.tp + s.fp > 0 ? s.fp / (s.tp + s.fp) : 0,
    fnr: s.tp + s.fn > 0 ? s.fn / (s.tp + s.fn) : 0,
  };
}

/**
 * Compute precision, recall, F1, FPR, FNR comparing Gemma findings against
 * critic findings. Greedy matching: each Gemma finding is paired with the first
 * unmatched critic finding that matches by dimension + keyword overlap.
 */
export function computeGemmaCriticAgreement(
  gemmaFindings: GemmaSliceFinding[],
  criticFindings: DiffCriticFinding[],
): GemmaCriticAgreement {
  const used = new Set<number>();
  const dim = new Map<string, { tp: number; fp: number; fn: number }>();
  let matched = 0;

  for (const g of gemmaFindings) {
    const gd = normalizeDim(g.dimension);
    let found = false;
    for (let j = 0; j < criticFindings.length; j++) {
      if (used.has(j)) continue;
      if (findingsMatch(g, criticFindings[j])) {
        used.add(j);
        found = true;
        break;
      }
    }
    const s = dim.get(gd) ?? { tp: 0, fp: 0, fn: 0 };
    if (found) { matched++; s.tp++; } else { s.fp++; }
    dim.set(gd, s);
  }

  for (let j = 0; j < criticFindings.length; j++) {
    if (used.has(j)) continue;
    const cd = normalizeDim(criticFindings[j].dimension);
    const s = dim.get(cd) ?? { tp: 0, fp: 0, fn: 0 };
    s.fn++;
    dim.set(cd, s);
  }

  const overall = calc({
    tp: matched,
    fp: gemmaFindings.length - matched,
    fn: criticFindings.length - used.size,
  });

  return {
    overall,
    perDimension: Object.fromEntries(
      [...dim.entries()].map(([d, s]) => [d, calc(s)]),
    ),
  };
}

/* ── Integration orchestrator (env-gated — requires Ollama + Claude API) ── */

export interface FixtureEvalResult {
  fixtureId: string;
  agreement: GemmaCriticAgreement;
  gemmaFindings: GemmaSliceFinding[];
  criticFindings: DiffCriticFinding[];
  error?: string;
}

/**
 * Run Gemma + critic evaluation on each fixture and return alignment metrics.
 *
 * Environment-gated: only runs when `P7_RUN_GEMMA_EVAL=true`.
 * Requires a live Ollama instance with gemma4:12b for GemmaClient,
 * and Claude API credentials for reviewDiff.
 */
export async function evaluateFixturesWithGemma(
  fixtures: Array<{ id: string; diffStat: string; description: string }>,
  projectPath: string,
  gemmaClient: GemmaClient,
): Promise<FixtureEvalResult[]> {
  const results: FixtureEvalResult[] = [];

  for (const fx of fixtures) {
    try {
      const out = await gemmaClient.generate(fx.diffStat);
      const meta: GemmaSliceMeta = {
        sliceIndex: 0,
        totalSlices: 1,
        charsInSlice: fx.diffStat.length,
      };
      const gemmaFindings = parseGemmaOutput(out.text, meta);
      const critic = await reviewDiff(projectPath, fx.diffStat, fx.description);
      const agreement = computeGemmaCriticAgreement(
        gemmaFindings,
        critic.structuredFindings,
      );
      results.push({
        fixtureId: fx.id,
        agreement,
        gemmaFindings,
        criticFindings: critic.structuredFindings,
      });
    } catch (e) {
      results.push({
        fixtureId: fx.id,
        agreement: computeGemmaCriticAgreement([], []),
        gemmaFindings: [],
        criticFindings: [],
        error: String(e),
      });
    }
  }

  return results;
}
