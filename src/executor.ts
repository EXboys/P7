import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { devAgentDir } from "./config.ts";
import type { DevAgentConfig } from "./config.ts";
import { reviewDiff } from "./diff-critic.ts";
import { appendLesson } from "./agent-memory.ts";
import { markRoadmapStepDone } from "./roadmap.ts";
import { refreshRoadmapIfExhausted } from "./roadmap-refresh.ts";
import { readPrompt, runSdkQuery } from "./sdk.ts";
import { loadLatestPlanRecord, recordFailedPlan } from "./planner.ts";
import { transitionPlanState } from "./state.ts";
import type { ExecutionResult, Plan } from "./types.ts";
import { publishToVcs } from "./vcs/index.ts";
import { runPrReviewAndMerge } from "./vcs/pr-lifecycle.ts";
import { checkPrWorkGate } from "./vcs/pr-work-gate.ts";
import { ghInstalled, gitRemoteOrigin } from "./gh-status.ts";
import {
  createWorktree,
  getHeadCommit,
  removeWorktree,
  resetWorktree,
  resolveExecutionBaseCommit,
  type WorktreeInfo,
} from "./worktree.ts";
import { withExponentialBackoff } from "./retry.ts";
import type { StepState } from "../server/queue/types.ts";
import { updateJobStepState } from "../server/queue/db.ts";

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new TextDecoder().decode(proc.stdout).trim();
  const err = new TextDecoder().decode(proc.stderr).trim();
  return { ok: proc.exitCode === 0, out: out || err };
}

function deriveMaxTurns(plan: Plan): number {
  const fromLines = Math.ceil(plan.estimated_diff_lines / 3);
  const fromFiles = plan.changes.length * 5;
  return Math.min(Math.max(fromLines + fromFiles + 10, 30), 60);
}

function scaleLimits(plan: Plan): { maxFiles: number; maxDiffLines: number } {
  const c = plan.complexity ?? "medium";
  if (c === "simple") return { maxFiles: 2, maxDiffLines: 200 };
  if (c === "complex") return { maxFiles: 5, maxDiffLines: 400 };
  return { maxFiles: 4, maxDiffLines: 300 };
}

function buildPreToolHook(allowedFiles: Set<string>) {
  const dangerousBash = /\b(git\s+(add|commit|push|reset|checkout|clean|merge|rebase)|rm\s+-|mv\s+|cp\s+|chmod\s+|chown\s+|sed\s+-i|perl\s+-pi|dd\s+|truncate\s+)/i;
  return {
    PreToolUse: [
      {
        matcher: "Write|Edit|Bash",
        hooks: [
          async (input: {
            tool_name: string;
            tool_input: { file_path?: string; path?: string; command?: string };
          }) => {
            if (input.tool_name === "Bash") {
              const command = input.tool_input?.command ?? "";
              if (dangerousBash.test(command)) {
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason:
                      "Executor Bash may run inspection/tests only; host handles file mutation and git operations",
                  },
                };
              }
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "allow" as const,
                },
              };
            }
            const path = input.tool_input?.file_path ?? input.tool_input?.path;
            if (!path) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: "Missing file path in tool input",
                },
              };
            }
            const normalized = path.replace(/^\.\//, "");
            const allowed = [...allowedFiles].some(
              (f) => normalized === f || normalized.endsWith(f),
            );
            if (!allowed) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: `File not in plan: ${normalized}`,
                },
              };
            }
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "allow" as const,
              },
            };
          },
        ],
      },
    ],
  };
}

function commandExists(name: string): boolean {
  const proc = Bun.spawnSync(["sh", "-c", `command -v ${name}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0;
}

async function runTypecheck(wtPath: string): Promise<{ ok: boolean; out: string }> {
  if (existsSync(join(wtPath, "package.json"))) {
    const pkg = JSON.parse(readFileSync(join(wtPath, "package.json"), "utf-8"));
    if (pkg.scripts?.typecheck) {
      const runner = existsSync(join(wtPath, "bun.lockb")) && commandExists("bun")
        ? ["bun", "run", "typecheck"]
        : existsSync(join(wtPath, "pnpm-lock.yaml")) && commandExists("pnpm")
          ? ["pnpm", "run", "typecheck"]
          : ["npm", "run", "typecheck"];
      const proc = Bun.spawnSync(runner, { cwd: wtPath, stdout: "pipe", stderr: "pipe" });
      return {
        ok: proc.exitCode === 0,
        out:
          new TextDecoder().decode(proc.stdout) +
          "\n" +
          new TextDecoder().decode(proc.stderr),
      };
    }
  }
  const runner = commandExists("bunx") ? ["bunx", "tsc", "--noEmit"] : ["npx", "tsc", "--noEmit"];
  const proc = Bun.spawnSync(runner, { cwd: wtPath, stdout: "pipe", stderr: "pipe" });
  return {
    ok: proc.exitCode === 0,
    out:
      new TextDecoder().decode(proc.stdout) +
      "\n" +
      new TextDecoder().decode(proc.stderr),
  };
}

function diffStatsAgainstBase(wtPath: string, baseCommit: string): { files: number; lines: number } {
  const raw = git(wtPath, ["diff", baseCommit, "--numstat"]);
  if (!raw.ok || !raw.out.trim()) return { files: 0, lines: 0 };
  let files = 0;
  let lines = 0;
  for (const row of raw.out.split("\n").filter(Boolean)) {
    const parts = row.split("\t");
    if (parts.length < 3) continue;
    const adds = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const dels = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    if (adds + dels > 0) files++;
    lines += adds + dels;
  }
  return { files, lines };
}

function hasUncommittedChanges(wtPath: string): boolean {
  const st = git(wtPath, ["status", "--porcelain"]);
  return st.ok && st.out.length > 0;
}

function commitsAheadOf(wtPath: string, baseCommit: string): number {
  const r = git(wtPath, ["rev-list", "--count", `${baseCommit}..HEAD`]);
  return r.ok ? Number(r.out) || 0 : 0;
}

function commitWorktreeChanges(
  wt: WorktreeInfo,
  baseCommit: string,
  planTitle: string,
): { sha: string; reused: boolean } {
  if (hasUncommittedChanges(wt.path)) {
    git(wt.path, ["add", "-A"]);
    const commit = git(wt.path, ["commit", "-m", planTitle]);
    if (!commit.ok) {
      const clean = /nothing to commit|working tree clean/i.test(commit.out);
      if (clean && commitsAheadOf(wt.path, baseCommit) > 0) {
        return {
          sha: git(wt.path, ["rev-parse", "HEAD"]).out.slice(0, 7),
          reused: true,
        };
      }
      throw new Error(`commit failed: ${commit.out}`);
    }
    return { sha: git(wt.path, ["rev-parse", "HEAD"]).out.slice(0, 7), reused: false };
  }
  if (commitsAheadOf(wt.path, baseCommit) > 0) {
    return { sha: git(wt.path, ["rev-parse", "HEAD"]).out.slice(0, 7), reused: true };
  }
  throw new Error(
    "executor produced no file changes (working tree clean and no commits ahead of base)",
  );
}

export async function executePlan(
  projectPath: string,
  plan: Plan & { planId?: string; goal?: string },
  cfg: DevAgentConfig,
  scanRemote: string | null,
): Promise<ExecutionResult> {
  const base = resolveExecutionBaseCommit(projectPath, cfg, plan.baseCommit);
  const baseCommit = base.commit;
  const planId = plan.planId;
  const allowedFiles = new Set(plan.changes.map((c) => c.file));
  const limits = scaleLimits(plan);
  const start = Date.now();
  let wt: WorktreeInfo | null = null;

  // ── Step state tracking (persisted to jobs.db for resumability) ──
  const jobId = process.env.P7_JOB_ID;
  const stepStartTimes = new Map<string, string>();

  /**
   * 写入单步状态快照到 jobs.db 的 step_states 列。
   * 无 jobId 时静默跳过 —— 用户直接 CLI 运行 executor 时 P7_JOB_ID 未设置，
   * 这是设计妥协而非 bug。
   */
  const writeStepState = (step: StepState) => {
    if (!jobId) return;
    if (step.status === "running") {
      stepStartTimes.set(step.step_name, step.started_at);
    } else if (!step.started_at) {
      step.started_at = stepStartTimes.get(step.step_name) ?? "";
    }
    updateJobStepState(jobId, step).catch(() => {});
  };
  // ────────────────────────────────────────────────────────────────

  try {
    if (
      scanRemote?.includes("github.com") &&
      ghInstalled() &&
      gitRemoteOrigin(projectPath) &&
      checkPrWorkGate(projectPath, cfg).blocked
    ) {
      throw new Error(checkPrWorkGate(projectPath, cfg).reason);
    }
    if (planId) transitionPlanState(projectPath, planId, "executing");
    await appendLesson(
      projectPath,
      `execute:base ${base.source} @ ${baseCommit.slice(0, 7)}${base.synced ? "" : " (未同步远程)"}`,
    );
    const wtStart = new Date().toISOString();
    writeStepState({ step_name: "worktree_create", status: "running", started_at: wtStart });
    wt = createWorktree(projectPath, baseCommit);
    writeStepState({ step_name: "worktree_create", status: "completed", started_at: wtStart, finished_at: new Date().toISOString() });
    const system = readPrompt("executor-system.md");
    const planText = JSON.stringify(plan, null, 2);
    const maxTurns = deriveMaxTurns(plan);

    const maxAgentPasses = 2;
    let stats = { files: 0, lines: 0 };
    let diffStatOut = "";

    const sdkStart = new Date().toISOString();
    writeStepState({ step_name: "sdk_execution", status: "running", started_at: sdkStart });

    for (let pass = 0; pass < maxAgentPasses; pass++) {
      const retryHint =
        pass > 0
          ? "\n\n【重要】上一轮未产生任何文件变更。你必须用 Edit/Write 修改计划中列出的每个文件，禁止空跑。"
          : "";

      const runOnce = async () => {
        const result = await runSdkQuery({
          prompt: `在 worktree 中执行以下计划：\n\`\`\`json\n${planText}\n\`\`\`${retryHint}`,
          cwd: wt!.path,
          systemPrompt: system,
          role: "executor",
          allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
          hooks: buildPreToolHook(allowedFiles) as never,
          maxTurns,
        });
        if (typeof result.costUsd === "number" && result.costUsd > cfg.execution_cost_limit) {
          throw new Error(
            `execution cost exceeded limit: ${result.costUsd} > ${cfg.execution_cost_limit}`,
          );
        }
      };

      await withExponentialBackoff(async () => {
        try {
          await runOnce();
        } catch (e) {
          resetWorktree(wt!.path);
          throw e;
        }
      });

      const diffStat = git(wt.path, ["diff", baseCommit, "--stat"]);
      if (!diffStat.ok) throw new Error(`git diff failed: ${diffStat.out}`);
      diffStatOut = diffStat.out;
      stats = diffStatsAgainstBase(wt.path, baseCommit);
      if (stats.files > 0) break;
      if (pass < maxAgentPasses - 1) {
        await appendLesson(
          projectPath,
          `execute:retry pass ${pass + 2} — no diff vs ${baseCommit.slice(0, 7)}`,
        );
        resetWorktree(wt!.path);
      }
    }

    if (stats.files === 0) {
      throw new Error(
        "executor produced no file changes after 2 attempts; use console「重试执行」or fix plan scope",
      );
    }

    writeStepState({ step_name: "sdk_execution", status: "completed", started_at: sdkStart, finished_at: new Date().toISOString() });

    const diffStart = new Date().toISOString();
    writeStepState({ step_name: "diff_check", status: "running", started_at: diffStart });
    const maxFiles = Math.min(limits.maxFiles, cfg.diff_critic.max_files_ceiling);
    const maxDiffLines = Math.min(
      Math.max(
        Math.ceil(plan.estimated_diff_lines * cfg.diff_critic.max_diff_multiplier),
        limits.maxDiffLines,
      ),
      cfg.diff_critic.max_diff_ceiling,
    );
    if (stats.files > maxFiles) {
      throw new Error(`Too many files changed: ${stats.files} > ${maxFiles}`);
    }
    if (stats.lines > maxDiffLines) {
      throw new Error(`Diff too large: ${stats.lines} lines > ${maxDiffLines}`);
    }
    writeStepState({ step_name: "diff_check", status: "completed", started_at: diffStart, finished_at: new Date().toISOString() });

    const tcStart = new Date().toISOString();
    writeStepState({ step_name: "typecheck", status: "running", started_at: tcStart });
    const tc = await runTypecheck(wt.path);
    if (!tc.ok) throw new Error(`typecheck failed: ${tc.out.slice(0, 500)}`);
    writeStepState({ step_name: "typecheck", status: "completed", started_at: tcStart, finished_at: new Date().toISOString() });

    const testStart = new Date().toISOString();
    writeStepState({ step_name: "test", status: "running", started_at: testStart });
    if (cfg.test_command) {
      const testProc = Bun.spawnSync(["sh", "-c", cfg.test_command], {
        cwd: wt.path,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (testProc.exitCode !== 0) {
        throw new Error(`test failed: ${new TextDecoder().decode(testProc.stderr).slice(0, 500)}`);
      }
    }
    writeStepState({ step_name: "test", status: "completed", started_at: testStart, finished_at: new Date().toISOString() });

    const criticStart = new Date().toISOString();
    writeStepState({ step_name: "diff_critic", status: "running", started_at: criticStart });
    const critic = await reviewDiff(wt.path, diffStatOut, plan.title);
    if (!critic.ok) {
      throw new Error(`diff-critic blocked: ${critic.findings.slice(0, 300)}`);
    }
    writeStepState({ step_name: "diff_critic", status: "completed", started_at: criticStart, finished_at: new Date().toISOString() });

    const gitStart = new Date().toISOString();
    writeStepState({ step_name: "git_commit_push", status: "running", started_at: gitStart });
    const { sha } = commitWorktreeChanges(wt, baseCommit, plan.title);

    const push = git(wt.path, ["push", "-u", "origin", wt.branch]);
    if (!push.ok) {
      const fallback = git(wt.path, ["push", "origin", `HEAD:${wt.branch}`]);
      if (!fallback.ok) throw new Error(`push failed: ${push.out}; fallback: ${fallback.out}`);
    }
    writeStepState({ step_name: "git_commit_push", status: "completed", started_at: gitStart, finished_at: new Date().toISOString() });

    const branch = wt.branch;
    if (planId) {
      transitionPlanState(projectPath, planId, "pushed", {
        branch,
        commitSha: sha,
      });
    }
    const vcsStart = new Date().toISOString();
    writeStepState({ step_name: "vcs_publish", status: "running", started_at: vcsStart });
    const vcs = await publishToVcs({
      projectPath: wt.path,
      remoteUrl: scanRemote,
      branch,
      commitSha: sha,
      plan,
      config: cfg,
    });

    let mergeStatus = vcs.mergeStatus;
    let lifecycleDetail: string | undefined;
    if (
      vcs.prUrl &&
      (cfg.vcs.auto_merge || cfg.vcs.auto_review !== false) &&
      scanRemote?.includes("github.com")
    ) {
      const lifecycle = await runPrReviewAndMerge({
        projectPath,
        prUrl: vcs.prUrl,
        branch,
        plan,
        config: cfg,
      });
      mergeStatus = lifecycle.mergeStatus;
      lifecycleDetail = lifecycle.detail;
    }

    if (planId) {
      const status = mergeStatus === "merged" ? "merged" : vcs.prUrl ? "pr_opened" : "pushed";
      transitionPlanState(projectPath, planId, status, {
        branch,
        commitSha: sha,
        reviewUrl: vcs.reviewUrl,
        prUrl: vcs.prUrl,
        issueUrl: vcs.issueUrl,
        mergeStatus,
        accountResults: vcs.accountResults,
        error: mergeStatus === "failed" ? lifecycleDetail : undefined,
      });
    }
    writeStepState({ step_name: "vcs_publish", status: "completed", started_at: vcsStart, finished_at: new Date().toISOString() });
    await markRoadmapStepDone(projectPath, plan.title, sha);
    await refreshRoadmapIfExhausted(projectPath, cfg, { force: true });

    const durationSec = Math.round((Date.now() - start) / 1000);
    await appendLesson(
      projectPath,
      `execute:ok "${plan.title}" -> ${branch} / ${durationSec}s${vcs.prUrl ? ` / ${vcs.prUrl}` : ""}`,
    );

    removeWorktree(projectPath, wt, true);
    wt = null;

    return {
      ok: true,
      branch,
      commitSha: sha,
      reviewUrl: vcs.reviewUrl,
      prUrl: vcs.prUrl,
      issueUrl: vcs.issueUrl,
      mergeStatus,
      accountResults: vcs.accountResults,
      durationSec,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    recordFailedPlan(projectPath, plan, err);
    if (planId) transitionPlanState(projectPath, planId, "failed", { error: err });
    await appendLesson(projectPath, `execute:failed "${plan.title}" x ${err.slice(0, 120)}`);
    // Mark any running steps as failed so no step stays in "running" forever
    if (jobId) {
      const now = new Date().toISOString();
      for (const [stepName, startedAt] of stepStartTimes) {
        writeStepState({
          step_name: stepName,
          status: "failed",
          started_at: startedAt,
          finished_at: now,
          error: err.slice(0, 500),
        });
      }
    }
    return {
      ok: false,
      error: err,
      worktreePath: wt?.path,
      durationSec: Math.round((Date.now() - start) / 1000),
    };
  } finally {
    if (wt) {
      try {
        removeWorktree(projectPath, wt, false);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

export function loadLatestPlan(projectPath: string): (Plan & { planId: string; goal: string }) | null {
  const record = loadLatestPlanRecord(projectPath);
  if (!record) return null;
  return { ...record.plan, planId: record.planId, goal: record.goal };
}
