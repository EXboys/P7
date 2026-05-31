import type { DevAgentConfig } from "../../src/config.ts";
import { listOpenPullRequests } from "../../src/vcs/open-prs.ts";
import type { JobRow } from "./types.ts";

export type PrReviewQueueDeps = {
  hasPrReviewInFlight: (alias: string) => boolean;
  /** execute / discover-daily / daily 等在跑 */
  hasOtherProjectMutexInFlight: (alias: string) => boolean;
  getLastPrReviewJob: (alias: string) => JobRow | null;
};

function minutesSince(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 60_000;
}

function countOpenPrs(projectPath: string, dc: DevAgentConfig): number {
  const vcs = dc.vcs;
  const label =
    vcs.pr_review_only_p7_label !== false && vcs.labels.length > 0
      ? vcs.labels[0]
      : undefined;
  let prs = listOpenPullRequests(projectPath, { label, limit: 30 });
  if (prs.length === 0 && label) {
    prs = listOpenPullRequests(projectPath, { limit: 30 });
  }
  return prs.length;
}

/** 是否应为该项目入队 pr-review（与 Roadmap/execute 互斥，按 alias 隔离） */
export function shouldSchedulePrReview(
  projectPath: string,
  alias: string,
  dc: DevAgentConfig,
  deps: PrReviewQueueDeps,
): { enqueue: boolean; reason: string; openPrs: number } {
  const vcs = dc.vcs;
  if (!vcs.enabled || vcs.review_open_prs === false) {
    return { enqueue: false, reason: "disabled", openPrs: 0 };
  }
  if (deps.hasPrReviewInFlight(alias)) {
    return { enqueue: false, reason: "pr_review_in_flight", openPrs: 0 };
  }
  if (deps.hasOtherProjectMutexInFlight(alias)) {
    return { enqueue: false, reason: "project_mutex_busy", openPrs: 0 };
  }

  const openPrs = countOpenPrs(projectPath, dc);
  const last = deps.getLastPrReviewJob(alias);
  const normalMin = vcs.pr_review_interval_minutes ?? 15;
  const fastMin = vcs.pr_review_fast_interval_minutes ?? 8;

  if (!last) {
    return { enqueue: true, reason: "never_run", openPrs };
  }

  const ref = last.finished_at ?? last.created_at;
  const ago = minutesSince(ref);

  if (last.status === "failed") {
    return {
      enqueue: ago >= 5,
      reason: ago >= 5 ? "retry_after_fail" : "fail_cooldown",
      openPrs,
    };
  }

  if (openPrs > 0) {
    return {
      enqueue: ago >= fastMin,
      reason: ago >= fastMin ? "open_prs_fast" : "fast_cooldown",
      openPrs,
    };
  }

  return {
    enqueue: ago >= normalMin,
    reason: ago >= normalMin ? "interval" : "normal_cooldown",
    openPrs,
  };
}
