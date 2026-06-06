import type { DevAgentConfig } from "./config.ts";

export function isUnlimitedLimit(value: number): boolean {
  return value === 0;
}

export function formatLimit(value: number, unit = ""): string {
  return isUnlimitedLimit(value) ? "不限制" : `${value}${unit}`;
}

export function effectiveAutoApproveLimits(cfg: DevAgentConfig): {
  filesMax: number | null;
  linesMax: number | null;
  risksMax: number | null;
} {
  const filesUnlimited =
    cfg.auto_approve.files_max === 0 || cfg.diff_critic.max_files_ceiling === 0;
  const linesUnlimited =
    cfg.auto_approve.diff_lines_max === 0 || cfg.diff_critic.max_diff_ceiling === 0;
  return {
    filesMax: filesUnlimited
      ? null
      : Math.max(cfg.auto_approve.files_max, cfg.diff_critic.max_files_ceiling),
    linesMax: linesUnlimited
      ? null
      : Math.max(cfg.auto_approve.diff_lines_max, cfg.diff_critic.max_diff_ceiling),
    risksMax: cfg.auto_approve.risks_max === 0 ? null : cfg.auto_approve.risks_max,
  };
}

export function effectiveNoImplicitAnyDefault(opts: {
  strict?: boolean;
  noImplicitAny?: boolean;
}): boolean {
  return opts.noImplicitAny ?? opts.strict ?? false;
}
