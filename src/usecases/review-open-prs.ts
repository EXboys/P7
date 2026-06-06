import { loadConfig } from "../config.ts";
import { runPrReviewSweep } from "../vcs/pr-reviewer.ts";

export async function reviewOpenPrsUseCase(projectPath: string) {
  return runPrReviewSweep(projectPath, loadConfig(projectPath));
}
