#!/usr/bin/env bun
/**
 * Lightweight pre-check rule engine operating on `git diff --stat` output.
 *
 * Runs 5 deterministic file-level rules in <1ms per file before any LLM
 * evaluation call:
 *
 *   1. generated_file   — files in known generated output paths
 *   2. minified_asset   — .min.js, .min.css and similar minified bundles
 *   3. oversized_file   — single-file changes exceeding a size threshold
 *   4. vendor_change    — modifications in vendor/ or node_modules/ dirs
 *   5. lockfile_only    — all non-vendor changes are lockfile updates
 *
 * High-certainty blocker findings (generated_file, minified_asset) trigger
 * an immediate short-circuit in the evaluator middleware, saving LLM cost.
 * Medium-certainty findings (oversized_file, vendor_change, lockfile_only)
 * are advisory and pass through to the downstream evaluator.
 *
 * Step 3 of 4 for Token Efficiency Optimization:
 *   1. Diff-stat parsing            (this module)
 *   2. Rule-based pre-check         (this module)
 *   3. Evaluator middleware wiring  (src/evaluator-middleware.ts)
 *   4. Integration tests
 *
 * See also:
 *   - src/pre-check.ts — content-level pre-check (complementary, runs after)
 *   - src/evaluator-middleware.ts — orchestrator that calls both
 */

/* ──────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────── */

/** A single finding produced by one deterministic stat-level rule. */
export interface PrecheckFinding {
  /** Rule identifier: one of "generated_file", "minified_asset", "oversized_file", "vendor_change", "lockfile_only". */
  rule: string;
  /** Blocker findings halt the pipeline; warnings are advisory. */
  severity: "blocker" | "warning";
  /** High-certainty findings trigger immediate short-circuit. */
  certainty: "high" | "medium" | "low";
  /** Human-readable summary of the finding. */
  message: string;
  /** Optional contextual detail (e.g. list of violating files). */
  detail?: string;
}

/** Aggregate result from a full stat-level pre-check run. */
export interface PrecheckResult {
  /** true when no blocker findings exist (warnings alone do not fail). */
  ok: boolean;
  /** Convenience flag: true when at least one blocker finding has high certainty — signals middleware to short-circuit. */
  hasHighCertaintyBlocker: boolean;
  /** All findings from every triggered rule, in evaluation order. */
  findings: PrecheckFinding[];
  /** Wall-clock time spent in the pre-check (milliseconds, rounded). */
  latencyMs: number;
}

/** Optional configuration for the pre-check engine. */
export interface PrecheckOptions {
  /** Single-file change threshold (lines) above which oversized_file fires. Default: 500. */
  oversizedFileThreshold?: number;
}

/* ── Internal: parsed diff stat entry ── */

interface DiffStatEntry {
  filePath: string;
  linesChanged: number;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Constants — pattern lists for rule detection
 * ──────────────────────────────────────────────────────────────────────────── */

/** Path prefixes that indicate generated/build output directories. */
const GENERATED_FILE_PREFIXES: string[] = [
  "dist/", "build/", ".next/", "out/", "gen/", "generated/",
  ".cache/", "coverage/", ".nyc_output/", ".parcel-cache/",
  ".svelte-kit/", ".astro/",
];

/** File suffixes that indicate minified or bundled assets. */
const MINIFIED_FILE_SUFFIXES: string[] = [
  ".min.js", ".min.css", ".min.mjs",
];

/** Path prefixes that indicate vendor or third-party dependency directories. */
const VENDOR_DIR_PREFIXES: string[] = [
  "vendor/", "node_modules/", "third_party/", "third-party/",
  ".pnp/", ".yarn/cache/", ".yarn/berry/",
];

/** Exact filenames recognized as lockfiles. */
const LOCKFILES: Set<string> = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-lock.yml",
  "bun.lock", "bun.lockb", "Gemfile.lock", "Cargo.lock",
  "poetry.lock", "composer.lock", "go.sum",
]);

const DEFAULT_OVERSIZED_THRESHOLD = 500;

/* ──────────────────────────────────────────────────────────────────────────────
 * Diff stat parser
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Parse `git diff --stat` output into structured file entries.
 *
 * Each line in the stat output represents one file with format:
 * ```
 *   path/to/file.ext | 42 ++++++++++++++++++++++-----------
 * ```
 *
 * Binary files (indicated by `Bin X -> Y bytes`) are parsed as having 0
 * linesChanged. The trailing summary line (e.g. "3 files changed, 15
 * insertions(+)...") is automatically skipped.
 *
 * @param diffStat — Raw output from `git diff --stat` (or `--stat=200`).
 * @returns Array of parsed entries; empty array for empty or malformed input.
 */
export function parseDiffStat(diffStat: string): DiffStatEntry[] {
  const entries: DiffStatEntry[] = [];
  const summaryRe = /files?\s+changed/i;

  for (const raw of diffStat.split("\n")) {
    const line = raw.trimEnd();
    if (!line || summaryRe.test(line)) continue;

    // Split on the last "|" to separate path from stat data.
    // This handles paths that may contain spaces but not literal pipes.
    const pipeIdx = line.lastIndexOf("|");
    if (pipeIdx === -1) continue;

    const filePath = line.slice(0, pipeIdx).trim();
    const rest = line.slice(pipeIdx + 1).trim();

    // Binary files: "Bin X -> Y bytes" — treat as 0 lines changed.
    if (/^Bin\b/i.test(rest)) {
      entries.push({ filePath, linesChanged: 0 });
      continue;
    }

    // Normal files: extract the numeric count before any +/- bars.
    const numMatch = rest.match(/^\s*(\d+)/);
    if (!numMatch) continue;

    entries.push({
      filePath,
      linesChanged: parseInt(numMatch[1], 10),
    });
  }

  return entries;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

function isGeneratedFile(filePath: string): boolean {
  return GENERATED_FILE_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function isMinifiedAsset(filePath: string): boolean {
  return MINIFIED_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function isVendorFile(filePath: string): boolean {
  return VENDOR_DIR_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function isLockfile(filePath: string): boolean {
  return LOCKFILES.has(filePath);
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Rules
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Rule 1 — generated_file: detect changes in known generated output paths.
 *
 * Files under dist/, build/, .next/, and similar directories should not be
 * modified by hand. Modifications here are almost always unintended (stale
 * build output checked in, or CI artifact pollution).
 *
 * Certainty: high — path prefix matching is unambiguous.
 */
function ruleGeneratedFile(entries: DiffStatEntry[]): PrecheckFinding[] {
  const violations = entries.filter((e) => isGeneratedFile(e.filePath));
  if (violations.length === 0) return [];

  return [{
    rule: "generated_file",
    severity: "blocker",
    certainty: "high",
    message: "Diff modifies generated/build output files",
    detail: violations.map((e) => e.filePath).join(", "),
  }];
}

/**
 * Rule 2 — minified_asset: detect changes to minified/bundled assets.
 *
 * .min.js, .min.css, and similar minified files are build artifacts that
 * should not be manually edited. Unintended modifications are common when
 * developers run build steps and accidentally include the output.
 *
 * Certainty: high — the file extension is a strong, unambiguous signal.
 */
function ruleMinifiedAsset(entries: DiffStatEntry[]): PrecheckFinding[] {
  const violations = entries.filter((e) => isMinifiedAsset(e.filePath));
  if (violations.length === 0) return [];

  return [{
    rule: "minified_asset",
    severity: "blocker",
    certainty: "high",
    message: "Diff modifies minified/bundled assets",
    detail: violations.map((e) => e.filePath).join(", "),
  }];
}

/**
 * Rule 3 — oversized_file: detect files with unusually large change sets.
 *
 * A single file changing more than `threshold` lines may indicate a
 * generated file not caught by prefix matching, a bad merge, or an
 * overly large refactor that should be split.
 *
 * Certainty: medium — large changes are sometimes legitimate (e.g.
 * auto-generated API clients, test fixtures).
 */
function ruleOversizedFile(
  entries: DiffStatEntry[],
  threshold: number,
): PrecheckFinding[] {
  const violations = entries.filter((e) => e.linesChanged > threshold);
  if (violations.length === 0) return [];

  const details = violations.map(
    (e) => `${e.filePath} (${e.linesChanged} lines)`,
  );
  return [{
    rule: "oversized_file",
    severity: "warning",
    certainty: "medium",
    message: `File(s) exceed ${threshold}-line single-file change threshold`,
    detail: details.join("; "),
  }];
}

/**
 * Rule 4 — vendor_change: detect modifications in vendor dependency dirs.
 *
 * Changes in node_modules/, vendor/, third_party/, or similar directories
 * are unusual in normal development diffs. They may indicate accidental
 * dependency modifications or CI artifact pollution.
 *
 * Certainty: medium — legitimate vendor patches exist (e.g. security
 * hotfixes applied directly to node_modules for testing).
 */
function ruleVendorChange(entries: DiffStatEntry[]): PrecheckFinding[] {
  const violations = entries.filter((e) => isVendorFile(e.filePath));
  if (violations.length === 0) return [];

  return [{
    rule: "vendor_change",
    severity: "blocker",
    certainty: "medium",
    message: "Diff modifies vendor/third-party dependency files",
    detail: violations.map((e) => e.filePath).join(", "),
  }];
}

/**
 * Rule 5 — lockfile_only: detect when only lockfiles are changed.
 *
 * A diff that touches only lockfiles (and no other source/tracked files)
 * is unusual — the lockfile should not change without corresponding
 * manifest changes. Common causes: accidental package install, stale
 * lockfile regeneration, or environment-specific lockfile drift.
 *
 * Certainty: medium — legitimate lockfile-only updates exist (e.g.
 * Dependabot PRs, or deduplication runs).
 */
function ruleLockfileOnly(entries: DiffStatEntry[]): PrecheckFinding[] {
  // Consider only non-vendor, non-generated files
  const tracked = entries.filter(
    (e) => !isVendorFile(e.filePath) && !isGeneratedFile(e.filePath),
  );
  if (tracked.length === 0) return [];

  const nonLockfiles = tracked.filter((e) => !isLockfile(e.filePath));
  if (nonLockfiles.length > 0) return [];

  const lockfiles = tracked.filter((e) => isLockfile(e.filePath));
  if (lockfiles.length === 0) return [];

  return [{
    rule: "lockfile_only",
    severity: "warning",
    certainty: "medium",
    message: "Diff changes only lockfile(s) without corresponding manifest changes",
    detail: lockfiles.map((e) => e.filePath).join(", "),
  }];
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Orchestrator — runPrecheck
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Run all 5 file-level pre-check rules against `git diff --stat` output.
 *
 * Evaluation order:
 *  1. generated_file   (high certainty)  → blocker
 *  2. minified_asset   (high certainty)  → blocker
 *  3. oversized_file   (medium certainty) → warning
 *  4. vendor_change    (medium certainty) → blocker
 *  5. lockfile_only    (medium certainty) → warning
 *
 * The result's `ok` is `true` only when no blocker findings exist.
 * `hasHighCertaintyBlocker` is a convenience flag for the evaluator
 * middleware to decide whether to short-circuit the LLM call.
 *
 * This is designed to be called BEFORE the content-level pre-check
 * (`runPreCheck` from `pre-check.ts`) and BEFORE complexity classification,
 * so obvious violations are caught at zero cost.
 *
 * @param diffStat — Raw output from `git diff --stat` (or `--stat=200`).
 * @param options — Optional threshold overrides.
 * @returns PrecheckResult with aggregated findings and latency telemetry.
 */
export function runPrecheck(
  diffStat: string,
  options: PrecheckOptions = {},
): PrecheckResult {
  const t0 = performance.now();
  const threshold = options.oversizedFileThreshold ?? DEFAULT_OVERSIZED_THRESHOLD;
  const findings: PrecheckFinding[] = [];

  const entries = parseDiffStat(diffStat);
  if (entries.length === 0) {
    return {
      ok: true,
      hasHighCertaintyBlocker: false,
      findings: [],
      latencyMs: Math.round(performance.now() - t0),
    };
  }

  // Rule 1: generated file changes
  findings.push(...ruleGeneratedFile(entries));

  // Rule 2: minified asset changes
  findings.push(...ruleMinifiedAsset(entries));

  // Rule 3: oversized file changes
  findings.push(...ruleOversizedFile(entries, threshold));

  // Rule 4: vendor directory changes
  findings.push(...ruleVendorChange(entries));

  // Rule 5: lockfile-only changes
  findings.push(...ruleLockfileOnly(entries));

  const hasHighCertaintyBlocker = findings.some(
    (f) => f.severity === "blocker" && f.certainty === "high",
  );

  return {
    ok: !findings.some((f) => f.severity === "blocker"),
    hasHighCertaintyBlocker,
    findings,
    latencyMs: Math.round(performance.now() - t0),
  };
}
