import { loadConfig } from "../config.ts";
import { runPrReviewSweep } from "../vcs/pr-reviewer.ts";

export type ReviewOpenPrsOpts = {
  signal?: AbortSignal;
  onPhase?: (phase: string) => void;
};

export async function reviewOpenPrsUseCase(projectPath: string, opts: ReviewOpenPrsOpts = {}) {
  return runPrReviewSweep(projectPath, loadConfig(projectPath), opts);
}
