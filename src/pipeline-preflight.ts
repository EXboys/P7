import { existsSync } from "fs";
import { loadConfig } from "./config.ts";
import { validateApiDomain } from "./sdk.ts";
import { hasLlmAuth } from "./llm-env.ts";
import { ghInstalled, gitRemoteOrigin } from "./gh-status.ts";
import { checkPrWorkGate } from "./vcs/pr-work-gate.ts";

export type PipelinePreflightIssue = {
  code: string;
  message: string;
  /** 是否阻止自动生成 Plan */
  blocking: boolean;
};

export type PipelinePreflightResult = {
  ok: boolean;
  issues: PipelinePreflightIssue[];
};

/** 调度 / discover / recover 前统一检查，避免静默失败 */
export function runPipelinePreflight(
  projectPath: string,
  opts: { requireLlm?: boolean } = {},
): PipelinePreflightResult {
  const issues: PipelinePreflightIssue[] = [];
  const requireLlm = opts.requireLlm !== false;

  if (!existsSync(projectPath)) {
    issues.push({
      code: "no_project_path",
      message: "项目路径不存在",
      blocking: true,
    });
    return { ok: false, issues };
  }

  try {
    loadConfig(projectPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    issues.push({ code: "bad_config", message: `配置无效：${msg}`, blocking: true });
  }

  if (requireLlm) {
    if (!hasLlmAuth()) {
      issues.push({
        code: "no_llm_auth",
        message: "未配置 LLM（ANTHROPIC_AUTH_TOKEN 或 ~/.claude/settings.json）",
        blocking: true,
      });
    }
    try {
      validateApiDomain(projectPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({ code: "api_domain", message: msg, blocking: true });
    }
  }

  try {
    const cfg = loadConfig(projectPath);
    if (ghInstalled() && gitRemoteOrigin(projectPath)) {
      const gate = checkPrWorkGate(projectPath, cfg);
      if (gate.blocked) {
        issues.push({
          code: "open_prs",
          message: gate.reason,
          blocking: true,
        });
      }
    }
  } catch {
    /* gate optional */
  }

  return { ok: issues.every((i) => !i.blocking), issues };
}

export function formatPreflightIssues(issues: PipelinePreflightIssue[]): string {
  return issues
    .filter((i) => i.blocking)
    .map((i) => i.message)
    .join("；");
}
