import { describe, expect, test } from "bun:test";
import { ghEnvForAuth, reviewMergeGhEnv, reviewMergeTokenMissing } from "../src/vcs/gh-env.ts";
import type { DevAgentConfig } from "../src/config.ts";

describe("gh-env", () => {
  test("token_env resolves GH_TOKEN from named env var", () => {
    process.env.GH_TOKEN_TEST = "ghp_secret";
    expect(
      ghEnvForAuth({ auth_type: "token_env", token_env: "GH_TOKEN_TEST", gh_host: "github.com" }),
    ).toEqual({ GH_TOKEN: "ghp_secret", GH_HOST: "github.com" });
    delete process.env.GH_TOKEN_TEST;
  });

  test("gh mode returns undefined env overlay", () => {
    expect(ghEnvForAuth({ auth_type: "gh" })).toBeUndefined();
  });

  test("reviewMergeTokenMissing when PAT unset", () => {
    const vcs = {
      review_merge_auth_type: "token_env" as const,
      review_merge_token_env: "GH_TOKEN_MAIN",
      review_merge_gh_host: "github.com",
    } as DevAgentConfig["vcs"];
    expect(reviewMergeTokenMissing(vcs)).toMatch(/GH_TOKEN_MAIN/);
    process.env.GH_TOKEN_MAIN = "x";
    expect(reviewMergeTokenMissing(vcs)).toBeNull();
    delete process.env.GH_TOKEN_MAIN;
  });

  test("reviewMergeGhEnv uses vcs review_merge fields", () => {
    process.env.GH_TOKEN_MAIN = "ghp_main";
    const vcs = {
      review_merge_auth_type: "token_env" as const,
      review_merge_token_env: "GH_TOKEN_MAIN",
      review_merge_gh_host: "github.com",
    } as DevAgentConfig["vcs"];
    expect(reviewMergeGhEnv(vcs)?.GH_TOKEN).toBe("ghp_main");
    delete process.env.GH_TOKEN_MAIN;
  });
});
