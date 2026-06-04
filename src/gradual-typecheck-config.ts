import { Glob } from "bun";

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
