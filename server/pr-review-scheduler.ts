import type { ServerConfig } from "./config.ts";
import { audit } from "./audit.ts";
import {
  enqueueJob,
  getLastPrReviewJob,
  hasPrReviewInFlight,
  hasProjectMutexInFlight,
} from "./queue/store.ts";
import { shouldSchedulePrReview } from "./queue/pr-review-policy.ts";
import { loadConfig } from "../src/config.ts";

const TICK_MS = 3 * 60 * 1000;

const prReviewDeps = {
  hasPrReviewInFlight,
  hasOtherProjectMutexInFlight: (alias: string) =>
    hasProjectMutexInFlight(alias, "pr-review"),
  getLastPrReviewJob,
};

export function startPrReviewScheduler(cfg: ServerConfig): () => void {
  const tick = () => {
    for (const [alias, projectPath] of Object.entries(cfg.project_aliases)) {
      let dc;
      try {
        dc = loadConfig(String(projectPath));
      } catch {
        continue;
      }
      const decision = shouldSchedulePrReview(String(projectPath), alias, dc, prReviewDeps);
      if (!decision.enqueue) {
        audit("pr_review.skipped", {
          alias,
          reason: decision.reason,
          openPrs: decision.openPrs,
        });
        continue;
      }

      enqueueJob({
        kind: "pr-review",
        payload: { projectPath: String(projectPath) },
        projectAlias: alias,
      });
      audit("pr_review.enqueued", {
        alias,
        reason: decision.reason,
        openPrs: decision.openPrs,
      });
    }
  };

  tick();
  const id = setInterval(tick, TICK_MS);
  return () => clearInterval(id);
}
