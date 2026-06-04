import { Glob } from "bun";
import type { TypeCoverageFileEntry, TypeCoverageReport } from "./types.ts";

/* ── TypeScript strict-mode flag registry ── */

/**
 * Known strict-mode flags mapped to their tsconfig property names.
 * Serves as both a runtime reference and the source of the `TscStrictFlag` union.
 */
export const TSC_STRICT_FLAGS = {
  alwaysStrict: "alwaysStrict",
  noImplicitAny: "noImplicitAny",
  noImplicitThis: "noImplicitThis",
  strictBindCallApply: "strictBindCallApply",
  strictFunctionTypes: "strictFunctionTypes",
  strictNullChecks: "strictNullChecks",
  strictPropertyInitialization: "strictPropertyInitialization",
  useUnknownInCatchVariables: "useUnknownInCatchVariables",
  exactOptionalPropertyTypes: "exactOptionalPropertyTypes",
  noFallthroughCasesInSwitch: "noFallthroughCasesInSwitch",
  noImplicitReturns: "noImplicitReturns",
  noUncheckedIndexedAccess: "noUncheckedIndexedAccess",
  noUnusedLocals: "noUnusedLocals",
  noUnusedParameters: "noUnusedParameters",
  noPropertyAccessFromIndexSignature: "noPropertyAccessFromIndexSignature",
} as const satisfies Record<string, string>;

/** Union of all known TypeScript strict-mode flag names. */
export type TscStrictFlag = keyof typeof TSC_STRICT_FLAGS;

/* ── Gradual type-check configuration types ── */

/**
 * A single rule mapping a glob pattern to strict-flag overrides.
 * Flags not present in `flags` inherit the tsconfig default.
 */
export interface GradualTypeCheckRule {
  /** Glob pattern matching source paths (e.g. `src/legacy/**.ts`). */
  pattern: string;
  /**
   * Per-flag overrides. `true` enables a flag, `false` disables it.
   * Omitted flags inherit the tsconfig default.
   */
  flags: Partial<Record<TscStrictFlag, boolean>>;
}

/** Ordered set of rules. First match wins; empty array = use tsconfig defaults. */
export interface GradualTypeCheckConfig {
  rules: GradualTypeCheckRule[];
}

/* ── Resolver ── */

/**
 * Resolve the first matching `GradualTypeCheckRule` for a source file path.
 *
 * Rules in `config` are evaluated in declaration order. Returns the first
 * rule whose glob pattern matches `filePath`, or `null` if none match
 * (caller should fall back to tsconfig defaults).
 */
export function resolveTypeCheckStrictness(
  filePath: string,
  config: GradualTypeCheckConfig,
): GradualTypeCheckRule | null {
  for (const rule of config.rules) {
    if (new Glob(rule.pattern).match(filePath)) {
      return rule;
    }
  }
  return null;
}

/* ── Type coverage builder ── */

/**
 * Build a `TypeCoverageReport` from a `GradualTypeCheckConfig` and a list of
 * project source file paths.
 *
 * Scans each file path through `resolveTypeCheckStrictness`, collects per-file
 * resolved flags, and aggregates statistics (strict/partial/default counts,
 * per-flag enablement counts). Pure function — no side effects, testable.
 *
 * @param config - The gradual type-check configuration with ordered rules.
 * @param projectFiles - List of source file paths (relative or absolute) to evaluate.
 * @returns A `TypeCoverageReport` with `source="config"`.
 */
export function buildTypeCoverageFromConfig(
  config: GradualTypeCheckConfig,
  projectFiles: string[],
): TypeCoverageReport {
  const files: TypeCoverageFileEntry[] = [];
  const perFlagCounts: Record<string, number> = {};
  let strictFiles = 0;
  let partialFiles = 0;
  let defaultFiles = 0;

  for (const filePath of projectFiles) {
    const rule = resolveTypeCheckStrictness(filePath, config);

    if (rule === null) {
      files.push({ filePath, matchedRule: null, resolvedFlags: {} });
      defaultFiles++;
      continue;
    }

    // Collect only explicitly-set flags from the matched rule.
    const resolvedFlags: Record<string, boolean> = {};
    for (const [key, val] of Object.entries(rule.flags)) {
      if (val !== undefined) resolvedFlags[key] = val;
    }

    const flagValues = Object.values(resolvedFlags);
    const allTrue = flagValues.length > 0 && flagValues.every(Boolean);
    const hasFalse = flagValues.some((v) => !v);

    files.push({
      filePath,
      matchedRule: rule.pattern,
      resolvedFlags,
    });

    if (allTrue) {
      strictFiles++;
    } else if (hasFalse) {
      partialFiles++;
    } else {
      // Rule matched but no flags explicitly set — treat as default-like.
      defaultFiles++;
    }

    // Accumulate per-flag enablement counts.
    for (const [flag, enabled] of Object.entries(resolvedFlags)) {
      if (enabled) {
        perFlagCounts[flag] = (perFlagCounts[flag] ?? 0) + 1;
      }
    }
  }

  return {
    source: "config",
    stats: {
      totalFiles: projectFiles.length,
      strictFiles,
      partialFiles,
      defaultFiles,
      perFlagCounts,
    },
    files,
  };
}

/* ── Coverage summary (dashboard helpers) ── */

/**
 * Computed percentage-based summary derived from a `TypeCoverageReport`.
 *
 * Used by the dashboard to render metric cards, sparklines, and progress
 * indicators. All percentages are 0–100 integers (rounded).
 */
export interface TypeCoverageSummary {
  totalFiles: number;
  /** Percentage of files covered by any rule (strict + partial). */
  coveredPct: number;
  /** Percentage of files with full strict mode (all flags true). */
  strictPct: number;
  /** Percentage of files with partial strict mode (mixed flags). */
  partialPct: number;
  /** Percentage of files falling back to tsconfig defaults. */
  defaultPct: number;
  breakouts: {
    /** Per-flag percentage of files that have this flag enabled. */
    byFlag: Record<string, number>;
  };
}

/**
 * Compute a percentage-based `TypeCoverageSummary` from a `TypeCoverageReport`.
 *
 * Pure function — no side effects. Handles the zero-total-files edge case
 * by returning zero for all percentages.
 *
 * @param report - A `TypeCoverageReport` returned by `buildTypeCoverageFromConfig`.
 * @returns A `TypeCoverageSummary` with 0–100 integer percentages.
 */
export function summarizeTypeCoverage(
  report: TypeCoverageReport,
): TypeCoverageSummary {
  const { totalFiles, strictFiles, partialFiles, defaultFiles, perFlagCounts } =
    report.stats;

  if (totalFiles === 0) {
    return {
      totalFiles: 0,
      coveredPct: 0,
      strictPct: 0,
      partialPct: 0,
      defaultPct: 0,
      breakouts: { byFlag: {} },
    };
  }

  const pct = (n: number) => Math.round((n / totalFiles) * 100);

  const byFlag: Record<string, number> = {};
  for (const [flag, count] of Object.entries(perFlagCounts)) {
    byFlag[flag] = pct(count);
  }

  return {
    totalFiles,
    coveredPct: pct(strictFiles + partialFiles),
    strictPct: pct(strictFiles),
    partialPct: pct(partialFiles),
    defaultPct: pct(defaultFiles),
    breakouts: { byFlag },
  };
}

/* ── Type safety metrics (dashboard overview) ── */

/**
 * Aggregate metrics for the dashboard overview cards.
 *
 * - `strictFiles`: files whose matched rule explicitly enables all strict flags.
 * - `anyEscapePaths`: files where `noImplicitAny` is NOT explicitly enabled
 *   (falls back to tsconfig default, potentially allowing implicit `any`).
 * - `coveragePercent`: percentage of files matched by any rule (0–100 integer).
 * - `totalFiles`: total source files evaluated.
 */
export interface TypeSafetyMetrics {
  strictFiles: number;
  anyEscapePaths: number;
  coveragePercent: number;
  totalFiles: number;
}

/**
 * Compute `TypeSafetyMetrics` from a `GradualTypeCheckConfig` and a list of
 * project source file paths.
 *
 * Pure function — no side effects, testable.
 *
 * @param filePaths - List of source file paths (relative or absolute) to evaluate.
 * @param config - The gradual type-check configuration with ordered rules.
 * @returns A `TypeSafetyMetrics` summary.
 */
export function computeTypeSafetyMetrics(
  filePaths: string[],
  config: GradualTypeCheckConfig,
): TypeSafetyMetrics {
  let strictFiles = 0;
  let anyEscapePaths = 0;
  let matchedFiles = 0;

  for (const filePath of filePaths) {
    const rule = resolveTypeCheckStrictness(filePath, config);

    if (rule === null) {
      // No rule matched — file inherits tsconfig defaults; count as any-escape
      anyEscapePaths++;
      continue;
    }

    matchedFiles++;

    // Strict: all explicitly-set flags are enabled
    const flagValues = Object.values(rule.flags);
    if (flagValues.length > 0 && flagValues.every(Boolean)) {
      strictFiles++;
    }

    // Any-escape: noImplicitAny not explicitly enabled
    if (rule.flags.noImplicitAny !== true) {
      anyEscapePaths++;
    }
  }

  const totalFiles = filePaths.length;
  const coveragePercent = totalFiles > 0
    ? Math.round((matchedFiles / totalFiles) * 100)
    : 0;

  return {
    strictFiles,
    anyEscapePaths,
    coveragePercent,
    totalFiles,
  };
}

