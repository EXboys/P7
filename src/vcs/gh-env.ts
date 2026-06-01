import type { DevAgentConfig } from "../config.ts";

export type GhAuthSpec = {
  auth_type: "gh" | "token_env";
  token_env?: string;
  gh_host?: string;
};

/** PAT 环境变量 → gh 子进程 env；gh 登录模式返回 undefined（沿用 process.env） */
export function ghEnvForAuth(spec: GhAuthSpec): Record<string, string> | undefined {
  if (spec.auth_type !== "token_env") return undefined;
  const tokenEnv = spec.token_env?.trim();
  if (!tokenEnv) return undefined;
  const token = process.env[tokenEnv];
  if (!token) return undefined;
  return {
    GH_TOKEN: token,
    GH_HOST: spec.gh_host?.trim() || "github.com",
  };
}

/** Review / approve / merge 专用主账号 gh 环境 */
export function reviewMergeGhEnv(vcs: DevAgentConfig["vcs"]): Record<string, string> | undefined {
  return ghEnvForAuth({
    auth_type: vcs.review_merge_auth_type ?? "gh",
    token_env: vcs.review_merge_token_env,
    gh_host: vcs.review_merge_gh_host,
  });
}

export function reviewMergeTokenMissing(vcs: DevAgentConfig["vcs"]): string | null {
  if ((vcs.review_merge_auth_type ?? "gh") !== "token_env") return null;
  const name = vcs.review_merge_token_env?.trim();
  if (!name) return "未配置 review_merge_token_env";
  if (!process.env[name]) return `环境变量 ${name} 未设置（Review/Merge 主账号 PAT）`;
  return null;
}
