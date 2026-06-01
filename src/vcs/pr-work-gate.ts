import type { DevAgentConfig } from "../config.ts";
import { listOpenPullRequests, type OpenPr } from "./open-prs.ts";
import { reviewMergeGhEnv } from "./gh-env.ts";

function prNeedsResolution(pr: OpenPr): boolean {
  return (
    pr.mergeable === "CONFLICTING" ||
    pr.mergeStateStatus === "DIRTY" ||
    pr.mergeStateStatus === "BEHIND"
  );
}

function listCandidateOpenPrs(projectPath: string, vcs: DevAgentConfig["vcs"]): OpenPr[] {
  const ghEnv = reviewMergeGhEnv(vcs);
  const label =
    vcs.pr_review_only_p7_label !== false && vcs.labels.length > 0
      ? vcs.labels[0]
      : undefined;
  let prs = listOpenPullRequests(projectPath, { label, limit: 30, ghEnv });
  if (prs.length === 0 && label) {
    prs = listOpenPullRequests(projectPath, { limit: 30, ghEnv });
  }
  return prs;
}

export type PrWorkGateResult = {
  blocked: boolean;
  prs: OpenPr[];
  reason: string;
};

/** 是否应暂停 Roadmap / 新 Plan 执行（pr-review 除外） */
export function checkPrWorkGate(
  projectPath: string,
  cfg: DevAgentConfig,
): PrWorkGateResult {
  const vcs = cfg.vcs;
  if (!vcs.enabled || vcs.block_new_work_until_prs_clear === false) {
    return { blocked: false, prs: [], reason: "gate_off" };
  }

  const open = listCandidateOpenPrs(projectPath, vcs);
  if (open.length === 0) {
    return { blocked: false, prs: [], reason: "no_open_prs" };
  }

  const onlyConflict = vcs.block_new_work_only_conflicting !== false;
  const blocking = onlyConflict ? open.filter(prNeedsResolution) : open;

  if (blocking.length === 0) {
    return { blocked: false, prs: open, reason: "open_prs_mergeable" };
  }

  const nums = blocking.map((p) => `#${p.number}`).join(", ");
  const reason = onlyConflict
    ? `存在待解决冲突/落后的 OPEN PR：${nums}`
    : `存在 OPEN PR 未合并：${nums}`;

  return { blocked: true, prs: blocking, reason };
}
