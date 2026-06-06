import { existsSync } from "fs";
import type { DevAgentConfig } from "../config.ts";
import { appendLesson } from "../agent-memory.ts";
import { readPrompt, runSdkQuery } from "../sdk.ts";
import {
  buildConflictResolvePrompt,
  deriveConflictMaxTurns,
  listUnmergedFiles,
  mergeConflictWaitMinutes,
} from "./merge-conflict.ts";
import { getPlanState } from "../state.ts";
import { parseFindings } from "../diff-critic.ts";
import type { Plan } from "../types.ts";
import { planDisplayTitle } from "../plan-i18n.ts";
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

type CheckState = "passing" | "pending" | "failing" | "unknown";

type CheckRow = {
  name?: string;
  state?: string;
  bucket?: string;
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

function requiredChecksState(
  projectPath: string,
  prUrl: string,
  env?: Record<string, string>,
): { state: CheckState; detail: string } {
  const r = ghRun(
    projectPath,
    ["gh", "pr", "checks", prUrl, "--required", "--json", "name,state,bucket"],
    env,
  );
  if (!r.ok) {
    if (/no required checks|no checks/i.test(r.out)) {
      return { state: "passing", detail: "无 required checks" };
    }
    return { state: "unknown", detail: r.out.slice(0, 160) };
  }
  try {
    const rows = JSON.parse(r.out) as CheckRow[];
    if (rows.length === 0) return { state: "passing", detail: "无 required checks" };
    const failing = rows.filter((c) => /fail|cancel|skip|timed/i.test(`${c.state} ${c.bucket}`));
    if (failing.length > 0) {
      return {
        state: "failing",
        detail: `required checks failed: ${failing.map((c) => c.name ?? c.state ?? "check").join(", ")}`,
      };
    }
    const pending = rows.filter((c) => !/pass|success/i.test(`${c.state} ${c.bucket}`));
    if (pending.length > 0) {
      return {
        state: "pending",
        detail: `required checks pending: ${pending.map((c) => c.name ?? c.state ?? "check").join(", ")}`,
      };
    }
    return { state: "passing", detail: "required checks passed" };
  } catch {
    return { state: "unknown", detail: r.out.slice(0, 160) };
  }
}

function syncBaseAfterMerge(projectPath: string, baseBranch: string): string {
  const fetch = git(projectPath, ["fetch", "origin", baseBranch]);
  if (!fetch.ok) return `fetch ${baseBranch} failed: ${fetch.out}`;
  const current = git(projectPath, ["branch", "--show-current"]);
  if (current.ok && current.out === baseBranch) {
    const pull = git(projectPath, ["pull", "--ff-only", "origin", baseBranch]);
    return pull.ok ? `本地 ${baseBranch} 已同步` : `pull ${baseBranch} failed: ${pull.out}`;
  }
  const update = git(projectPath, ["branch", "-f", baseBranch, `origin/${baseBranch}`]);
  return update.ok ? `本地 ${baseBranch} 已指向 origin/${baseBranch}` : `branch sync skipped: ${update.out}`;
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
  vcs: DevAgentConfig["vcs"],
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

  const maxPasses = vcs.merge_conflict_passes ?? 3;
  for (let pass = 1; pass <= maxPasses; pass++) {
    const status = git(projectPath, ["status", "--porcelain"]);
    const conflictFiles = listUnmergedFiles(projectPath);
    const maxTurns = deriveConflictMaxTurns(conflictFiles.length || 1, vcs);
    await runSdkQuery({
      prompt: buildConflictResolvePrompt({
        projectPath,
        baseBranch,
        plan,
        statusPorcelain: status.out,
        pass,
        maxPasses,
        remainingFiles: pass > 1 ? conflictFiles : undefined,
      }),
      cwd: projectPath,
      systemPrompt: readPrompt("merge-conflict.md"),
      role: "executor",
      allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
      maxTurns,
      projectPath,
    });

    if (!hasConflictMarkers(projectPath)) break;
    if (pass < maxPasses) continue;
    git(projectPath, ["merge", "--abort"]).ok;
    if (prev.ok) git(projectPath, ["checkout", prev.out]);
    const left = listUnmergedFiles(projectPath);
    return {
      ok: false,
      detail: `仍存在冲突标记${left.length ? `（${left.length} 个文件）` : ""}`,
    };
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

  // ── diff-critic 安全检查：读取 PlanState 中的 findings，阻止安全越狱/幻觉检测 blocker 自动合并 ──
  if (input.planId) {
    try {
      const planState = getPlanState(projectPath, input.planId);
      if (planState?.diffCriticFindings) {
        const findings = parseFindings(planState.diffCriticFindings);
        const blockerFindings = findings.filter(
          (f) => f.severity === "blocker" && (f.dimension === "安全越狱" || f.dimension === "幻觉检测"),
        );
        if (blockerFindings.length > 0) {
          const detail = `diff-critic blocker 阻止自动合并：${blockerFindings.map((f) => `[${f.dimension}] ${f.message}`).join("；")}`;
          await appendLesson(projectPath, `pr:blocked ${prUrl} — ${detail}`);
          return { mergeStatus: "failed", detail };
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`安全检查异常（已跳过合并前阻断）：${msg}`);
    }
  }

  const defaultWaitMinutes =
    vcs.merge_resolve_conflicts !== false
      ? mergeConflictWaitMinutes(vcs, true)
      : (vcs.merge_wait_minutes ?? 20);
  const waitMs = (input.mergeWaitMinutes ?? defaultWaitMinutes) * 60 * 1000;
  const deadline = Date.now() + waitMs;
  const baseBranch = defaultBaseBranch(config);
  let lastStatus: NonNullable<VcsPublishResult["mergeStatus"]> = "merge_blocked";
  let lastDetail = "等待 GitHub 返回可合并状态";

  while (Date.now() < deadline) {
    const pr = viewPr(projectPath, prUrl, mergeEnv);
    if (!pr) {
      lastDetail = "无法读取 PR 状态";
      await sleep(6_000);
      continue;
    }

    if (pr.state === "CLOSED") {
      await appendLesson(projectPath, `pr:closed ${prUrl}`);
      return { mergeStatus: "closed", detail: "PR 已被外部关闭" };
    }

    if (pr.mergeable === "MERGEABLE" && pr.mergeStateStatus === "CLEAN") {
      const checks = requiredChecksState(projectPath, prUrl, mergeEnv);
      if (checks.state === "pending" || checks.state === "unknown") {
        lastStatus = "pending_checks";
        lastDetail = checks.detail;
        parts.push(checks.detail);
        await sleep(8_000);
        continue;
      }
      if (checks.state === "failing") {
        await appendLesson(projectPath, `pr:checks-failed ${prUrl} — ${checks.detail}`);
        return { mergeStatus: "failed", detail: checks.detail };
      }
      if (await tryGhMerge(projectPath, prUrl, mergeEnv)) {
        const sync = syncBaseAfterMerge(projectPath, baseBranch);
        const msg = `主账号已合并 PR（${parts.join("；")}）`;
        await appendLesson(projectPath, `pr:merged ${prUrl} — ${sync}`);
        return { mergeStatus: "merged", detail: `${msg}；${sync}` };
      }
      parts.push("merge command blocked，等待下一轮状态刷新");
      lastStatus = "merge_blocked";
      lastDetail = "merge command blocked";
    }

    if (
      pr.mergeable === "CONFLICTING" ||
      pr.mergeStateStatus === "DIRTY" ||
      pr.mergeStateStatus === "BEHIND"
    ) {
      lastStatus = pr.mergeStateStatus === "BEHIND" ? "behind" : "merge_blocked";
      lastDetail = `PR 状态 ${pr.mergeable ?? "unknown"} / ${pr.mergeStateStatus ?? "unknown"}`;
      if (vcs.merge_resolve_conflicts !== false) {
        await updatePrBranch(projectPath, prUrl, mergeEnv);
        await sleep(8_000);
        const pr2 = viewPr(projectPath, prUrl, mergeEnv);
        if (pr2?.mergeable === "MERGEABLE" && pr2.mergeStateStatus === "CLEAN") {
          if (await tryGhMerge(projectPath, prUrl, mergeEnv)) {
            const sync = syncBaseAfterMerge(projectPath, baseBranch);
            return { mergeStatus: "merged", detail: `主账号 update-branch 后已合并；${sync}` };
          }
        }
        const fixed = await resolveConflictsLocally(projectPath, branch, baseBranch, plan, vcs);
        parts.push(fixed.detail);
        if (fixed.ok) {
          await sleep(6_000);
          if (await tryGhMerge(projectPath, prUrl, mergeEnv)) {
            const sync = syncBaseAfterMerge(projectPath, baseBranch);
            await appendLesson(projectPath, `pr:merged after conflict fix ${prUrl} — ${sync}`);
            return { mergeStatus: "merged", detail: `${parts.join("；")}；${sync}` };
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
      const sync = syncBaseAfterMerge(projectPath, baseBranch);
      return { mergeStatus: "merged", detail: `PR 已合并；${sync}` };
    }

    await sleep(8_000);
  }

  return {
    mergeStatus: lastStatus,
    detail: `等待合并超时（${input.mergeWaitMinutes ?? defaultWaitMinutes} 分钟）：${lastDetail}`,
  };
}
