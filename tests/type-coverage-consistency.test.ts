import { describe, expect, test } from "bun:test";
import {
  buildTypeCoverageFromConfig,
  summarizeTypeCoverage,
  computeTypeSafetyMetrics,
  TSC_STRICT_FLAGS,
  resolveStrictnessTarget,
  resolveAchievedLevel,
  computeStrictnessGap,
  STRICTNESS_LEVELS,
} from "../src/gradual-typecheck-config.ts";
import type {
  GradualTypeCheckConfig,
  TypeStrictnessTarget,
} from "../src/gradual-typecheck-config.ts";
import type { TypeCoverageReport } from "../src/types.ts";

/* ── Inline config fixtures ── */

const strictRule = {
  pattern: "src/new/**/*.ts",
  flags: {
    [TSC_STRICT_FLAGS.noImplicitAny]: true,
    [TSC_STRICT_FLAGS.strictNullChecks]: true,
    [TSC_STRICT_FLAGS.strictFunctionTypes]: true,
    [TSC_STRICT_FLAGS.alwaysStrict]: true,
  },
};

const partialRule = {
  pattern: "src/migration/**/*.ts",
  flags: {
    [TSC_STRICT_FLAGS.noImplicitAny]: true,
    [TSC_STRICT_FLAGS.strictNullChecks]: false,
  },
};

const multiRuleConfig: GradualTypeCheckConfig = {
  rules: [strictRule, partialRule],
};

const projectFiles = [
  "src/new/module.ts",
  "src/migration/helper.ts",
  "src/legacy/old-file.ts",
];

/* ── buildTypeCoverageFromConfig ── */

describe("buildTypeCoverageFromConfig", () => {
  test("returns correct report structure with per-file drill-down", () => {
    const report: TypeCoverageReport = buildTypeCoverageFromConfig(
      multiRuleConfig,
      projectFiles,
    );

    // Top-level structure
    expect(report.source).toBe("config");
    expect(report.stats.totalFiles).toBe(3);
    expect(report.files).toHaveLength(3);

    // File 0: matched strictRule → drill-down to its pattern
    expect(report.files[0].filePath).toBe("src/new/module.ts");
    expect(report.files[0].matchedRule).toBe("src/new/**/*.ts");
    expect(report.files[0].resolvedFlags.noImplicitAny).toBe(true);
    expect(report.files[0].resolvedFlags.strictNullChecks).toBe(true);
    expect(report.files[0].resolvedFlags.strictFunctionTypes).toBe(true);

    // File 1: matched partialRule → drill-down to its pattern
    expect(report.files[1].filePath).toBe("src/migration/helper.ts");
    expect(report.files[1].matchedRule).toBe("src/migration/**/*.ts");
    expect(report.files[1].resolvedFlags.noImplicitAny).toBe(true);
    expect(report.files[1].resolvedFlags.strictNullChecks).toBe(false);

    // File 2: no match → matchedRule is null, empty resolved flags
    expect(report.files[2].filePath).toBe("src/legacy/old-file.ts");
    expect(report.files[2].matchedRule).toBeNull();
    expect(report.files[2].resolvedFlags).toEqual({});

    // Aggregated stats
    expect(report.stats.strictFiles).toBe(1);
    expect(report.stats.partialFiles).toBe(1);
    expect(report.stats.defaultFiles).toBe(1);
    // noImplicitAny is true in both matched rules → count 2
    expect(report.stats.perFlagCounts.noImplicitAny).toBe(2);
    // strictNullChecks is true only in strictRule → count 1
    expect(report.stats.perFlagCounts.strictNullChecks).toBe(1);
    // strictFunctionTypes is true only in strictRule → count 1
    expect(report.stats.perFlagCounts.strictFunctionTypes).toBe(1);
    // alwaysStrict is true only in strictRule → count 1
    expect(report.stats.perFlagCounts.alwaysStrict).toBe(1);
  });

  test("first-match-wins when multiple rules match same file", () => {
    const overlappingConfig: GradualTypeCheckConfig = {
      rules: [
        { pattern: "src/**/*.ts", flags: { noImplicitAny: true } },
        { pattern: "src/new/**/*.ts", flags: { noImplicitAny: false } },
      ],
    };
    const report = buildTypeCoverageFromConfig(overlappingConfig, [
      "src/new/module.ts",
    ]);

    // First rule wins: noImplicitAny = true
    expect(report.files[0].matchedRule).toBe("src/**/*.ts");
    expect(report.files[0].resolvedFlags.noImplicitAny).toBe(true);
    expect(report.stats.strictFiles).toBe(1);
  });

  test("empty config produces all default files", () => {
    const emptyConfig: GradualTypeCheckConfig = { rules: [] };
    const report = buildTypeCoverageFromConfig(emptyConfig, projectFiles);

    expect(report.stats.totalFiles).toBe(3);
    expect(report.stats.strictFiles).toBe(0);
    expect(report.stats.partialFiles).toBe(0);
    expect(report.stats.defaultFiles).toBe(3);
    expect(report.files.every((f) => f.matchedRule === null)).toBe(true);
  });

  test("empty file list returns empty report", () => {
    const report = buildTypeCoverageFromConfig(multiRuleConfig, []);

    expect(report.stats.totalFiles).toBe(0);
    expect(report.files).toHaveLength(0);
  });
});

/* ── summarizeTypeCoverage ── */

describe("summarizeTypeCoverage", () => {
  test("computes correct percentages for mixed config", () => {
    const report = buildTypeCoverageFromConfig(multiRuleConfig, projectFiles);
    const summary = summarizeTypeCoverage(report);

    expect(summary.totalFiles).toBe(3);
    // covered = strict(1) + partial(1) = 2 → round(2/3 * 100) = 67
    expect(summary.coveredPct).toBe(67);
    expect(summary.strictPct).toBe(33);
    expect(summary.partialPct).toBe(33);
    expect(summary.defaultPct).toBe(33);
    // noImplicitAny enabled in 2 out of 3 files
    expect(summary.breakouts.byFlag.noImplicitAny).toBe(67);
  });

  test("returns zeros for empty report", () => {
    const emptyReport = buildTypeCoverageFromConfig(multiRuleConfig, []);
    const summary = summarizeTypeCoverage(emptyReport);

    expect(summary.totalFiles).toBe(0);
    expect(summary.coveredPct).toBe(0);
    expect(summary.strictPct).toBe(0);
    expect(summary.partialPct).toBe(0);
    expect(summary.defaultPct).toBe(0);
    expect(summary.breakouts.byFlag).toEqual({});
  });

  test("all-default config yields 0% covered and 100% default", () => {
    const emptyConfig: GradualTypeCheckConfig = { rules: [] };
    const report = buildTypeCoverageFromConfig(emptyConfig, projectFiles);
    const summary = summarizeTypeCoverage(report);

    expect(summary.totalFiles).toBe(3);
    expect(summary.coveredPct).toBe(0);
    expect(summary.defaultPct).toBe(100);
  });
});

/* ── computeTypeSafetyMetrics ── */

describe("computeTypeSafetyMetrics", () => {
  test("returns correct metrics for mixed config", () => {
    const metrics = computeTypeSafetyMetrics(projectFiles, multiRuleConfig);

    expect(metrics.totalFiles).toBe(3);
    expect(metrics.strictFiles).toBe(1); // only src/new/module.ts
    // any escape: src/legacy/old-file.ts (no rule match, noImplicitAny inherits default)
    // src/migration/helper.ts sets noImplicitAny:true explicitly, so it's safe
    expect(metrics.anyEscapePaths).toBe(1);
    expect(metrics.coveragePercent).toBe(67); // 2/3 matched by rules
  });

  test("returns zeros for empty file list", () => {
    const metrics = computeTypeSafetyMetrics([], multiRuleConfig);

    expect(metrics.totalFiles).toBe(0);
    expect(metrics.strictFiles).toBe(0);
    expect(metrics.anyEscapePaths).toBe(0);
    expect(metrics.coveragePercent).toBe(0);
  });

  test("all files are any-escape when no rules match", () => {
    const unmatchedFiles = ["other/config.ts", "docs/readme.md"];
    const metrics = computeTypeSafetyMetrics(unmatchedFiles, multiRuleConfig);

    expect(metrics.totalFiles).toBe(2);
    expect(metrics.strictFiles).toBe(0);
    expect(metrics.anyEscapePaths).toBe(2);
    expect(metrics.coveragePercent).toBe(0);
  });

  test("unmatched files inherit safe noImplicitAny from tsconfig defaults", () => {
    const unmatchedFiles = ["other/config.ts", "docs/readme.md"];
    const metrics = computeTypeSafetyMetrics(unmatchedFiles, {
      ...multiRuleConfig,
      tsconfigDefaults: { noImplicitAny: true },
    });

    expect(metrics.totalFiles).toBe(2);
    expect(metrics.anyEscapePaths).toBe(0);
    expect(metrics.coveragePercent).toBe(0);
  });
});

/* ── Target config fixtures ── */

const targetConfig: GradualTypeCheckConfig = {
  rules: [],
  targets: [
    {
      pattern: "src/new/**/*.ts",
      targetLevel: "full",
      milestone: "Q3 2026",
      note: "New code must be fully strict",
    },
    {
      pattern: "src/migration/**/*.ts",
      targetLevel: "strict",
      milestone: "Q2 2026",
    },
    {
      pattern: "src/**/*.ts",
      targetLevel: "moderate",
      note: "All source code baseline",
    },
  ],
};

const targetFilePaths = [
  "src/new/module.ts",
  "src/migration/helper.ts",
  "src/legacy/old-file.ts",
  "other/config.ts",
];

/* ── resolveStrictnessTarget ── */

describe("resolveStrictnessTarget", () => {
  test("first-match-wins when multiple targets match", () => {
    // src/new/module.ts matches both 'src/new/**/*.ts' (index 0) and 'src/**/*.ts' (index 2)
    const result = resolveStrictnessTarget("src/new/module.ts", targetConfig);

    expect(result).not.toBeNull();
    expect(result!.targetLevel).toBe("full");
    expect(result!.pattern).toBe("src/new/**/*.ts");
    expect(result!.milestone).toBe("Q3 2026");
    expect(result!.note).toBe("New code must be fully strict");
  });

  test("returns second target when first does not match", () => {
    const result = resolveStrictnessTarget(
      "src/migration/helper.ts",
      targetConfig,
    );

    expect(result).not.toBeNull();
    expect(result!.targetLevel).toBe("strict");
    expect(result!.pattern).toBe("src/migration/**/*.ts");
    expect(result!.milestone).toBe("Q2 2026");
  });

  test("returns last fallback target for broader match", () => {
    const result = resolveStrictnessTarget(
      "src/legacy/old-file.ts",
      targetConfig,
    );

    expect(result).not.toBeNull();
    expect(result!.targetLevel).toBe("moderate");
    expect(result!.pattern).toBe("src/**/*.ts");
  });

  test("returns null when targets is undefined", () => {
    const configWithoutTargets: GradualTypeCheckConfig = { rules: [] };
    expect(
      resolveStrictnessTarget("src/new/module.ts", configWithoutTargets),
    ).toBeNull();
  });

  test("returns null when targets is empty array", () => {
    const configEmptyTargets: GradualTypeCheckConfig = {
      rules: [],
      targets: [],
    };
    expect(
      resolveStrictnessTarget("src/new/module.ts", configEmptyTargets),
    ).toBeNull();
  });

  test("returns null when no target matches the file path", () => {
    expect(
      resolveStrictnessTarget("other/config.ts", targetConfig),
    ).toBeNull();
  });
});

/* ── resolveAchievedLevel ── */

describe("resolveAchievedLevel", () => {
  test("returns 'full' when all 15 full-level flags are enabled", () => {
    const fullFlags: Record<string, boolean> = {};
    for (const key of Object.keys(STRICTNESS_LEVELS.full)) {
      fullFlags[key] = true;
    }
    expect(resolveAchievedLevel(fullFlags)).toBe("full");
  });

  test("returns 'strict' when only strict-level flags are enabled (not full)", () => {
    const strictOnlyFlags: Record<string, boolean> = {};
    for (const key of Object.keys(STRICTNESS_LEVELS.strict)) {
      strictOnlyFlags[key] = true;
    }
    // Has all strict flags but none of the additional full-level flags
    expect(resolveAchievedLevel(strictOnlyFlags)).toBe("strict");
  });

  test("returns 'moderate' when only moderate-level flags are enabled", () => {
    const moderateFlags: Record<string, boolean> = {};
    for (const key of Object.keys(STRICTNESS_LEVELS.moderate)) {
      moderateFlags[key] = true;
    }
    expect(resolveAchievedLevel(moderateFlags)).toBe("moderate");
  });

  test("returns 'loose' when no strict-mode flags are enabled", () => {
    expect(resolveAchievedLevel({})).toBe("loose");
  });

  test("returns 'loose' when flags are insufficient for moderate", () => {
    // Only one of four moderate flags enabled → not enough for moderate
    expect(resolveAchievedLevel({ noImplicitAny: true })).toBe("loose");
  });
});

/* ── computeStrictnessGap ── */

describe("computeStrictnessGap", () => {
  test("returns isMet=true and empty missingFlags when target is fully met", () => {
    const strictFlags: Record<string, boolean> = {};
    for (const key of Object.keys(STRICTNESS_LEVELS.strict)) {
      strictFlags[key] = true;
    }

    const target: TypeStrictnessTarget = {
      pattern: "src/**/*.ts",
      targetLevel: "strict",
    };

    const gap = computeStrictnessGap(strictFlags, target);

    expect(gap.targetLevel).toBe("strict");
    expect(gap.achievedLevel).toBe("strict");
    expect(gap.isMet).toBe(true);
    expect(gap.missingFlags).toEqual({});
  });

  test("returns isMet=false when achieved is below target and lists missing flags", () => {
    const moderateFlags: Record<string, boolean> = {};
    for (const key of Object.keys(STRICTNESS_LEVELS.moderate)) {
      moderateFlags[key] = true;
    }

    const target: TypeStrictnessTarget = {
      pattern: "src/**/*.ts",
      targetLevel: "strict",
    };

    const gap = computeStrictnessGap(moderateFlags, target);

    expect(gap.targetLevel).toBe("strict");
    expect(gap.achievedLevel).toBe("moderate");
    expect(gap.isMet).toBe(false);
    // Missing: alwaysStrict, strictFunctionTypes, strictPropertyInitialization, useUnknownInCatchVariables
    expect(Object.keys(gap.missingFlags).length).toBe(4);
    expect(gap.missingFlags.alwaysStrict).toBe(true);
    expect(gap.missingFlags.strictFunctionTypes).toBe(true);
    expect(gap.missingFlags.strictPropertyInitialization).toBe(true);
    expect(gap.missingFlags.useUnknownInCatchVariables).toBe(true);
  });

  test("returns isMet=false with all target flags missing when no flags match", () => {
    const target: TypeStrictnessTarget = {
      pattern: "src/**/*.ts",
      targetLevel: "moderate",
    };

    const gap = computeStrictnessGap({}, target);

    expect(gap.targetLevel).toBe("moderate");
    expect(gap.achievedLevel).toBe("loose");
    expect(gap.isMet).toBe(false);
    // All 4 moderate flags are missing
    expect(Object.keys(gap.missingFlags).length).toBe(4);
    expect(gap.missingFlags.noImplicitAny).toBe(true);
    expect(gap.missingFlags.noImplicitThis).toBe(true);
    expect(gap.missingFlags.strictNullChecks).toBe(true);
    expect(gap.missingFlags.strictBindCallApply).toBe(true);
  });

  test("respects per-target targetFlags that add requirements beyond level preset", () => {
    const flags: Record<string, boolean> = {};
    for (const key of Object.keys(STRICTNESS_LEVELS.moderate)) {
      flags[key] = true;
    }
    // Extra flags beyond the moderate preset that are required by this target
    flags.noUnusedLocals = true;

    const target: TypeStrictnessTarget = {
      pattern: "src/**/*.ts",
      targetLevel: "moderate",
      // Require noUnusedLocals on top of the moderate preset
      targetFlags: { noUnusedLocals: true },
    };

    const gap = computeStrictnessGap(flags, target);

    expect(gap.targetLevel).toBe("moderate");
    expect(gap.achievedLevel).toBe("moderate");
    // All moderate + noUnusedLocals are present → fully met
    expect(gap.isMet).toBe(true);
    expect(gap.missingFlags).toEqual({});
  });

  test("respects per-target targetFlags - detects missing extra flag", () => {
    const flags: Record<string, boolean> = {};
    for (const key of Object.keys(STRICTNESS_LEVELS.moderate)) {
      flags[key] = true;
    }
    // noUnusedLocals is NOT in flags

    const target: TypeStrictnessTarget = {
      pattern: "src/**/*.ts",
      targetLevel: "moderate",
      // Require noUnusedLocals and noUnusedParameters on top of moderate
      targetFlags: { noUnusedLocals: true, noUnusedParameters: true },
    };

    const gap = computeStrictnessGap(flags, target);

    expect(gap.targetLevel).toBe("moderate");
    expect(gap.achievedLevel).toBe("moderate");
    expect(gap.isMet).toBe(false);
    // Both extra flags are missing
    expect(gap.missingFlags.noUnusedLocals).toBe(true);
    expect(gap.missingFlags.noUnusedParameters).toBe(true);
  });
});
