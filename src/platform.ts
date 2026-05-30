export function parseGitRemoteUrl(remote: string | null): {
  platform: "github" | "gitlab" | "unknown";
  owner?: string;
  repo?: string;
} {
  if (!remote) return { platform: "unknown" };
  const ssh = remote.match(/git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { platform: "github", owner: ssh[1], repo: ssh[2].replace(/\.git$/, "") };
  const https = remote.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) return { platform: "github", owner: https[1], repo: https[2].replace(/\.git$/, "") };
  const gl = remote.match(/gitlab\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (gl) return { platform: "gitlab", owner: gl[1], repo: gl[2].replace(/\.git$/, "") };
  return { platform: "unknown" };
}

export function reviewUrl(
  remoteUrl: string | null,
  branch: string,
): string | undefined {
  const { platform, owner, repo } = parseGitRemoteUrl(remoteUrl);
  if (platform === "github" && owner && repo) {
    return `https://github.com/${owner}/${repo}/compare/${branch}?expand=1`;
  }
  if (platform === "gitlab" && owner && repo) {
    return `https://gitlab.com/${owner}/${repo}/-/merge_requests/new?merge_request[source_branch]=${branch}`;
  }
  return undefined;
}
