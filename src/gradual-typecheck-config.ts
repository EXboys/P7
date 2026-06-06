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

  /** Ordered set of strictness targets for progressive milestones. First match wins; undefined when no targets declared. */
  targets?: TypeStrictnessTarget[];

  /** Effective tsconfig defaults used when no gradual rule overrides a flag. */
  tsconfigDefaults?: Partial<Record<TscStrictFlag, boolean>>;
}

/* ── Strictness level presets ── */

/**
 * Predefined strictness levels for progressive type-check milestones.
 * Each level is a superset of the previous.
 */
export type StrictnessLevel = 'loose' | 'moderate' | 'strict' | 'full';

/**
 * Predefined flag sets for each `StrictnessLevel`.
 * - `loose`: no flags enforced (tsconfig defaults only)
 * - `moderate`: core safety flags
 * - `strict`: TypeScript `--strict` preset (8 flags)
 * - `full`: all 15 known strict-mode flags
 */
export const STRICTNESS_LEVELS = {
  loose: {},
  moderate: {
    noImplicitAny: true,
    noImplicitThis: true,
    strictNullChecks: true,
    strictBindCallApply: true,
  },
  strict: {
    alwaysStrict: true,
    noImplicitAny: true,
    noImplicitThis: true,
    strictBindCallApply: true,
    strictFunctionTypes: true,
    strictNullChecks: true,
    strictPropertyInitialization: true,
    useUnknownInCatchVariables: true,
  },
  full: {
    alwaysStrict: true,
    noImplicitAny: true,
    noImplicitThis: true,
    strictBindCallApply: true,
    strictFunctionTypes: true,
    strictNullChecks: true,
    strictPropertyInitialization: true,
    useUnknownInCatchVariables: true,
    exactOptionalPropertyTypes: true,
    noFallthroughCasesInSwitch: true,
    noImplicitReturns: true,
    noUncheckedIndexedAccess: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noPropertyAccessFromIndexSignature: true,
  },
} as const satisfies Record<StrictnessLevel, Partial<Record<TscStrictFlag, boolean>>>;

/* ── Strictness target declaration ── */

/**
 * A strictness milestone target for a set of files matched by a glob pattern.
 *
 * Declares a target `StrictnessLevel` (and optional per-flag overrides)
 * that the matched files should achieve by a given milestone.
 */
export interface TypeStrictnessTarget {
  /** Glob pattern matching source paths to target (e.g. `src/new/**.ts`). */
  pattern: string;
  /** Predefined strictness level milestone to achieve. */
  targetLevel: StrictnessLevel;
  /**
   * Optional per-flag overrides for the target level.
   * When specified, these flags take precedence over the level preset,
   * enabling custom strictness configurations for legacy-adapted targets.
   */
  targetFlags?: Partial<Record<TscStrictFlag, boolean>>;
  /** Optional milestone label (e.g. `'Q3 2026'`, `'v2.0'`). */
  milestone?: string;
  /** Optional human-readable annotation. */
  note?: string;
}

/* ── Rule resolver ── */

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

export function defaultNoImplicitAnyEnabled(config: GradualTypeCheckConfig): boolean {
  return config.tsconfigDefaults?.noImplicitAny === true;
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
      // No rule matched — file inherits tsconfig defaults.
      if (!defaultNoImplicitAnyEnabled(config)) {
        anyEscapePaths++;
      }
      continue;
    }

    matchedFiles++;

    // Strict: all explicitly-set flags are enabled
    const flagValues = Object.values(rule.flags);
    if (flagValues.length > 0 && flagValues.every(Boolean)) {
      strictFiles++;
    }

    // Any-escape: effective noImplicitAny is disabled after applying rule overrides.
    const noImplicitAny = rule.flags.noImplicitAny ?? defaultNoImplicitAnyEnabled(config);
    if (noImplicitAny !== true) {
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

/* ── Strictness target resolvers ── */

/**
 * Resolve the first matching `TypeStrictnessTarget` for a source file path.
 *
 * Returns `null` when `config.targets` is undefined/empty, or when no
 * target's glob pattern matches `filePath`.
 */
export function resolveStrictnessTarget(
  filePath: string,
  config: GradualTypeCheckConfig,
): TypeStrictnessTarget | null {
  if (!config.targets) return null;
  for (const target of config.targets) {
    if (new Glob(target.pattern).match(filePath)) {
      return target;
    }
  }
  return null;
}

/**
 * Determine the highest `StrictnessLevel` achieved by a set of resolved flags.
 *
 * Checks levels from highest (`full`) to lowest (`loose`) and returns the
 * first whose entire flag set is satisfied. Falls back to `loose` when
 * no level's flags are fully met.
 */
export function resolveAchievedLevel(
  resolvedFlags: Partial<Record<TscStrictFlag, boolean>>,
): StrictnessLevel {
  const levels: StrictnessLevel[] = ['full', 'strict', 'moderate', 'loose'];
  for (const level of levels) {
    const required = STRICTNESS_LEVELS[level];
    const allMet = Object.keys(required).every(
      (flag) => resolvedFlags[flag as TscStrictFlag] === true,
    );
    if (allMet) return level;
  }
  return 'loose';
}

/**
 * Result of comparing achieved strictness against a target milestone.
 */
export interface StrictnessGap {
  /** The target level declared in the milestone. */
  targetLevel: StrictnessLevel;
  /** Level actually achieved by the current configuration. */
  achievedLevel: StrictnessLevel;
  /** Whether the target is fully met. */
  isMet: boolean;
  /** Flags not yet enabled to reach the target. Empty when `isMet` is true. */
  missingFlags: Partial<Record<TscStrictFlag, boolean>>;
}

/**
 * Compute the strictness gap between resolved flags and a target.
 *
 * Merges `STRICTNESS_LEVELS[target.targetLevel]` with optional
 * `target.targetFlags` to determine the effective target flag set,
 * then compares against `resolvedFlags` to identify missing flags.
 */
export function computeStrictnessGap(
  resolvedFlags: Partial<Record<TscStrictFlag, boolean>>,
  target: TypeStrictnessTarget,
): StrictnessGap {
  const achievedLevel = resolveAchievedLevel(resolvedFlags);

  // Merge level preset with per-target overrides
  const effectiveTarget: Record<string, boolean> = {
    ...STRICTNESS_LEVELS[target.targetLevel],
  };
  if (target.targetFlags) {
    for (const [flag, val] of Object.entries(target.targetFlags)) {
      if (val !== undefined) effectiveTarget[flag] = val;
    }
  }

  const missingFlags: Partial<Record<TscStrictFlag, boolean>> = {};
  for (const [flag, val] of Object.entries(effectiveTarget)) {
    if (resolvedFlags[flag as TscStrictFlag] !== val) {
      missingFlags[flag as TscStrictFlag] = val;
    }
  }

  return {
    targetLevel: target.targetLevel,
    achievedLevel,
    isMet: Object.keys(missingFlags).length === 0,
    missingFlags,
  };
}

