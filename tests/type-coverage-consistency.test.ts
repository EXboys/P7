import { describe, expect, test } from "bun:test";
import {
  buildTypeCoverageFromConfig,
  summarizeTypeCoverage,
  computeTypeSafetyMetrics,
  TSC_STRICT_FLAGS,
} from "../src/gradual-typecheck-config.ts";
import type { GradualTypeCheckConfig } from "../src/gradual-typecheck-config.ts";
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
});
