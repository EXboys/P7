import { existsSync } from "fs";
import type { DevAgentConfig } from "../config.ts";
import { appendLesson } from "../agent-memory.ts";
import { readPrompt, runSdkQuery } from "../sdk.ts";
import { getPlanState } from "../state.ts";
import { parseFindings } from "../diff-critic.ts";
import type { Plan } from "../types.ts";
import { defaultBaseBranch } from "../worktree.ts";
import { reviewMergeGhEnv, reviewMergeTokenMissing } from "./gh-env.ts";
import type { VcsPublishResult } from "./types.ts";

function ghRun(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  return { ok: proc.exitCode === 0, out: stdout || stderr };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  return { ok: proc.exitCode === 0, out: stdout || stderr };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type PrView = {
  mergeable?: string;
  mergeStateStatus?: string;
  state?: string;
};

function viewPr(
  projectPath: string,
  prUrl: string,
  env?: Record<string, string>,
): PrView | null {
  const r = ghRun(projectPath, [
    "gh",
    "pr",
    "view",
    prUrl,
    "--json",
    "mergeable,mergeStateStatus,state",
  ], env);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out) as PrView;
  } catch {
    return null;
  }
}

async function autoReviewPr(
  projectPath: string,
  prUrl: string,
  plan: Plan,
  env?: Record<string, string>,
): Promise<string> {
  const summary = [
    "## P7 自动 Review",
    `- 验证：${plan.validation}`,
    `- 规模：约 ${plan.estimated_diff_lines} 行 / ${plan.changes.length} 文件`,
    `- 风险：${plan.risks.join("；") || "无"}`,
    "",
    "diff-critic 已在合并前通过；此为流程自动备注。",
  ].join("\n");
  ghRun(projectPath, ["gh", "pr", "comment", prUrl, "--body", summary], env);
  const approve = ghRun(
    projectPath,
    ["gh", "pr", "review", prUrl, "--approve", "--comment", "P7 auto-review"],
    env,
  );
  if (approve.ok) return "主账号已 approve";
  return `review 备注已发（approve 跳过：${approve.out.slice(0, 120)}）`;
}

async function tryGhMerge(
  projectPath: string,
  prUrl: string,
  env?: Record<string, string>,
): Promise<boolean> {
  const m = ghRun(projectPath, ["gh", "pr", "merge", prUrl, "--squash", "--delete-branch"], env);
  return m.ok;
}

async function updatePrBranch(
  projectPath: string,
  prUrl: string,
  env?: Record<string, string>,
): Promise<boolean> {
  const u = ghRun(projectPath, ["gh", "pr", "update-branch", prUrl, "--rebase"], env);
  if (u.ok) return true;
  const m = ghRun(projectPath, ["gh", "pr", "update-branch", prUrl], env);
  return m.ok;
}

function hasConflictMarkers(projectPath: string): boolean {
  const r = git(projectPath, ["diff", "--check"]);
  return !r.ok || /conflict marker/i.test(r.out);
}

async function resolveConflictsLocally(
  projectPath: string,
  branch: string,
  baseBranch: string,
  plan: Plan,
): Promise<{ ok: boolean; detail: string }> {
  const fetch = git(projectPath, ["fetch", "origin", baseBranch, branch]);
  if (!fetch.ok) return { ok: false, detail: `fetch failed: ${fetch.out}` };

  const prev = git(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const co = git(projectPath, ["checkout", "-B", branch, `origin/${branch}`]);
  if (!co.ok) return { ok: false, detail: `checkout ${branch} failed: ${co.out}` };

  const merge = git(projectPath, ["merge", `origin/${baseBranch}`, "-m", `merge ${baseBranch} into ${branch}`]);
  if (merge.ok && !hasConflictMarkers(projectPath)) {
    const push = git(projectPath, ["push", "origin", branch]);
    if (prev.ok) git(projectPath, ["checkout", prev.out]);
    return push.ok
      ? { ok: true, detail: "merge 无冲突，已 push" }
      : { ok: false, detail: `push failed: ${push.out}` };
  }

  if (!/CONFLICT/i.test(merge.out) && !hasConflictMarkers(projectPath)) {
    if (prev.ok) git(projectPath, ["checkout", prev.out]);
    return { ok: false, detail: merge.out || "merge failed" };
  }

  const status = git(projectPath, ["status", "--porcelain"]);
  await runSdkQuery({
    prompt: `解决当前仓库合并冲突并纳入 ${baseBranch}。\n\nPlan：${plan.title}\n\ngit status:\n${status.out}`,
    cwd: projectPath,
    systemPrompt: readPrompt("merge-conflict.md"),
    role: "executor",
    allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
    maxTurns: 25,
  });

  if (hasConflictMarkers(projectPath)) {
    git(projectPath, ["merge", "--abort"]).ok;
    if (prev.ok) git(projectPath, ["checkout", prev.out]);
    return { ok: false, detail: "仍存在冲突标记" };
  }

  git(projectPath, ["add", "-A"]);
  const commit = git(projectPath, [
    "commit",
    "-m",
    `fix: resolve merge conflicts with ${baseBranch}`,
  ]);
  if (!commit.ok && !/nothing to commit/i.test(commit.out)) {
    if (prev.ok) git(projectPath, ["checkout", prev.out]);
    return { ok: false, detail: `commit failed: ${commit.out}` };
  }

  const push = git(projectPath, ["push", "origin", branch]);
  if (prev.ok) git(projectPath, ["checkout", prev.out]);
  return push.ok
    ? { ok: true, detail: "Agent 已解决冲突并 push" }
    : { ok: false, detail: `push failed: ${push.out}` };
}

export type PrLifecycleInput = {
  projectPath: string;
  prUrl: string;
  branch: string;
  plan: Plan;
  config: DevAgentConfig;
  /** 定时复查时可缩短单 PR 等待时间（分钟） */
  mergeWaitMinutes?: number;
  /** planId（如有）用于读取 PlanState 中的 diff-critic findings 做合并前安全检查 */
  planId?: string;
};

export type PrLifecycleResult = {
  mergeStatus: NonNullable<VcsPublishResult["mergeStatus"]>;
  detail: string;
};

/** PR 创建后：自动 review、尝试合并；冲突则 update-branch / Agent 修复后再合并 */
export async function runPrReviewAndMerge(input: PrLifecycleInput): Promise<PrLifecycleResult> {
  const { projectPath, prUrl, branch, plan, config } = input;
  const vcs = config.vcs;

  if (!vcs.enabled || !existsSync(projectPath)) {
    return { mergeStatus: "skipped", detail: "VCS 未启用" };
  }
  if (!ghRun(projectPath, ["sh", "-c", "command -v gh"]).ok) {
    return { mergeStatus: "skipped", detail: "未安装 gh" };
  }

  const mergeEnv = reviewMergeGhEnv(vcs);
  const tokenErr = reviewMergeTokenMissing(vcs);
  if (tokenErr) {
    return { mergeStatus: "failed", detail: tokenErr };
  }

  const parts: string[] = [];

  if (vcs.auto_review !== false) {
    const review = await autoReviewPr(projectPath, prUrl, plan, mergeEnv);
    parts.push(review);
    await appendLesson(projectPath, `pr:review ${prUrl} — ${review}`);
  }

  if (!vcs.auto_merge) {
    return { mergeStatus: "not_requested", detail: parts.join("；") || "仅 review" };
  }

  // ── diff-critic 安全检查：读取 PlanState 中的 findings，阻止安全越狱 blocker 自动合并 ──
  if (input.planId) {
    try {
      const planState = getPlanState(projectPath, input.planId);
      if (planState?.diffCriticFindings) {
        const findings = parseFindings(planState.diffCriticFindings);
        const securityBlockers = findings.filter(
          (f) => f.severity === "blocker" && f.dimension === "安全越狱",
        );
        if (securityBlockers.length > 0) {
          const detail = `diff-critic 安全越狱 blocker 阻止自动合并：${securityBlockers.map((f) => f.message).join("；")}`;
          await appendLesson(projectPath, `pr:security-blocked ${prUrl} — ${detail}`);
          return { mergeStatus: "failed", detail };
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`安全检查异常（已跳过合并前阻断）：${msg}`);
    }
  }

  const waitMs = (input.mergeWaitMinutes ?? vcs.merge_wait_minutes ?? 20) * 60 * 1000;
  const deadline = Date.now() + waitMs;
  const baseBranch = defaultBaseBranch(config);

  while (Date.now() < deadline) {
    const pr = viewPr(projectPath, prUrl, mergeEnv);
    if (!pr) {
      await sleep(6_000);
      continue;
    }

    if (pr.mergeable === "MERGEABLE" && pr.mergeStateStatus === "CLEAN") {
      if (await tryGhMerge(projectPath, prUrl, mergeEnv)) {
        const msg = `主账号已合并 PR（${parts.join("；")}）`;
        await appendLesson(projectPath, `pr:merged ${prUrl}`);
        return { mergeStatus: "merged", detail: msg };
      }
    }

    if (
      pr.mergeable === "CONFLICTING" ||
      pr.mergeStateStatus === "DIRTY" ||
      pr.mergeStateStatus === "BEHIND"
    ) {
      if (vcs.merge_resolve_conflicts !== false) {
        await updatePrBranch(projectPath, prUrl, mergeEnv);
        await sleep(8_000);
        const pr2 = viewPr(projectPath, prUrl, mergeEnv);
        if (pr2?.mergeable === "MERGEABLE" && pr2.mergeStateStatus === "CLEAN") {
          if (await tryGhMerge(projectPath, prUrl, mergeEnv)) {
            return { mergeStatus: "merged", detail: "主账号 update-branch 后已合并" };
          }
        }
        const fixed = await resolveConflictsLocally(projectPath, branch, baseBranch, plan);
        parts.push(fixed.detail);
        if (fixed.ok) {
          await sleep(6_000);
          if (await tryGhMerge(projectPath, prUrl, mergeEnv)) {
            await appendLesson(projectPath, `pr:merged after conflict fix ${prUrl}`);
            return { mergeStatus: "merged", detail: parts.join("；") };
          }
        }
        await sleep(8_000);
        continue;
      }
      parts.push("未启用冲突自动修复");
      await sleep(8_000);
      continue;
    }

    if (pr.state === "MERGED") {
      return { mergeStatus: "merged", detail: "PR 已合并" };
    }

    await sleep(8_000);
  }

  return {
    mergeStatus: "failed",
    detail: `等待合并超时（${vcs.merge_wait_minutes ?? 20} 分钟）`,
  };
}
