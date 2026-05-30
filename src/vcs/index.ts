import { reviewUrl } from "../platform.ts";
import { GitHubProvider } from "./github.ts";
import type { VcsPublishInput, VcsPublishResult, VcsProvider } from "./types.ts";

const providers: VcsProvider[] = [new GitHubProvider()];

export async function publishToVcs(input: VcsPublishInput): Promise<VcsPublishResult> {
  if (!input.config.vcs.enabled || input.config.vcs.provider === "none") {
    return {
      reviewUrl: reviewUrl(input.remoteUrl, input.branch),
      mergeStatus: "skipped",
    };
  }

  const provider = providers.find((p) => p.canHandle(input.remoteUrl));
  if (!provider) {
    return {
      reviewUrl: reviewUrl(input.remoteUrl, input.branch),
      mergeStatus: "skipped",
      warning: "No VCS provider matched remote URL",
    };
  }
  return provider.publish(input);
}
