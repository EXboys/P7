import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { devAgentDir } from "./config.ts";
import type { DevAgentConfig } from "./config.ts";
import { reviewDiff } from "./diff-critic.ts";
import { appendLesson } from "./agent-memory.ts";
import { markRoadmapStepDone } from "./roadmap.ts";
import { readPrompt, runSdkQuery } from "./sdk.ts";
import { loadLatestPlanRecord, recordFailedPlan } from "./planner.ts";
import { transitionPlanState } from "./state.ts";
import type { ExecutionResult, Plan } from "./types.ts";
import { publishToVcs } from "./vcs/index.ts";
import {
  createWorktree,
  getHeadCommit,
  removeWorktree,
  resetWorktree,
  type WorktreeInfo,
} from "./worktree.ts";
import { withExponentialBackoff } from "./retry.ts";
import type { StepState } from "../server/queue/types.ts";
import { updateJobStepStates } from "../server/queue/db.ts";

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

function diffStats(wtPath: string): { files: number; lines: number } {
  const raw = git(wtPath, ["diff", "--numstat"]);
  if (!raw.ok || !raw.out) return { files: 0, lines: 0 };
  let files = 0;
  let lines = 0;
  for (const row of raw.out.split("\n").filter(Boolean)) {
    const [adds, dels] = row.split("\t");
    files++;
    lines += (adds === "-" ? 0 : Number(adds)) + (dels === "-" ? 0 : Number(dels));
  }
  return { files, lines };
}

export async function executePlan(
  projectPath: string,
  plan: Plan & { planId?: string; goal?: string },
  cfg: DevAgentConfig,
  scanRemote: string | null,
): Promise<ExecutionResult> {
  const baseCommit = plan.baseCommit ?? getHeadCommit(projectPath);
  const planId = plan.planId;
  const allowedFiles = new Set(plan.changes.map((c) => c.file));
  const limits = scaleLimits(plan);
  const start = Date.now();
  let wt: WorktreeInfo | null = null;

  // ── Step state tracking (persisted to jobs.db for resumability) ──
  const jobId = process.env.P7_JOB_ID;
  const steps: StepState[] = [];

  const recordStepStart = (stepName: string) => {
    if (!jobId) return;
    const step: StepState = {
      step_name: stepName,
      status: "running",
      started_at: new Date().toISOString(),
    };
    steps.push(step);
    updateJobStepStates(jobId, [...steps]).catch(() => {});
  };

  const recordStepEnd = (stepName: string, error?: string) => {
    if (!jobId) return;
    const step = steps.find(
      (s) => s.step_name === stepName && s.status === "running",
    );
    if (step) {
      step.status = error ? "failed" : "completed";
      step.finished_at = new Date().toISOString();
      if (error) step.error = error;
    }
    updateJobStepStates(jobId, [...steps]).catch(() => {});
  };
  // ────────────────────────────────────────────────────────────────

  try {
    if (planId) transitionPlanState(projectPath, planId, "executing");
    recordStepStart("worktree.create");
    wt = createWorktree(projectPath, baseCommit);
    recordStepEnd("worktree.create");
    const system = readPrompt("executor-system.md");
    const planText = JSON.stringify(plan, null, 2);
    const maxTurns = deriveMaxTurns(plan);

    const runOnce = async () => {
      const result = await runSdkQuery({
        prompt: `在 worktree 中执行以下计划：\n\`\`\`json\n${planText}\n\`\`\``,
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

    recordStepStart("sdk.execute");
    await withExponentialBackoff(async () => {
      try {
        await runOnce();
      } catch (e) {
        resetWorktree(wt!.path);
        throw e;
      }
    });
    recordStepEnd("sdk.execute");

    recordStepStart("validate.diff");
    const diffStat = git(wt.path, ["diff", "--stat"]);
    if (!diffStat.ok) throw new Error(`git diff failed: ${diffStat.out}`);

    const stats = diffStats(wt.path);
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
    recordStepEnd("validate.diff");

    recordStepStart("validate.typecheck");
    const tc = await runTypecheck(wt.path);
    if (!tc.ok) throw new Error(`typecheck failed: ${tc.out.slice(0, 500)}`);
    recordStepEnd("validate.typecheck");

    recordStepStart("validate.test");
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
    recordStepEnd("validate.test");

    recordStepStart("review.diff");
    const critic = await reviewDiff(wt.path, diffStat.out, plan.title);
    if (!critic.ok) {
      throw new Error(`diff-critic blocked: ${critic.findings.slice(0, 300)}`);
    }
    recordStepEnd("review.diff");

    recordStepStart("git.commit");
    git(wt.path, ["add", "-A"]);
    const commit = git(wt.path, ["commit", "-m", plan.title]);
    if (!commit.ok) throw new Error(`commit failed: ${commit.out}`);
    const sha = git(wt.path, ["rev-parse", "HEAD"]).out.slice(0, 7);
    recordStepEnd("git.commit");

    recordStepStart("git.push");
    const push = git(wt.path, ["push", "-u", "origin", wt.branch]);
    if (!push.ok) {
      const fallback = git(wt.path, ["push", "origin", `HEAD:${wt.branch}`]);
      if (!fallback.ok) throw new Error(`push failed: ${push.out}; fallback: ${fallback.out}`);
    }
    recordStepEnd("git.push");

    const branch = wt.branch;
    if (planId) {
      transitionPlanState(projectPath, planId, "pushed", {
        branch,
        commitSha: sha,
      });
    }
    recordStepStart("vcs.publish");
    const vcs = await publishToVcs({
      projectPath: wt.path,
      remoteUrl: scanRemote,
      branch,
      commitSha: sha,
      plan,
      config: cfg,
    });
    if (planId) {
      const status = vcs.mergeStatus === "merged" ? "merged" : vcs.prUrl ? "pr_opened" : "pushed";
      transitionPlanState(projectPath, planId, status, {
        branch,
        commitSha: sha,
        reviewUrl: vcs.reviewUrl,
        prUrl: vcs.prUrl,
        issueUrl: vcs.issueUrl,
        mergeStatus: vcs.mergeStatus,
        accountResults: vcs.accountResults,
      });
    }
    recordStepEnd("vcs.publish");
    await markRoadmapStepDone(projectPath, plan.title, sha);

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
      mergeStatus: vcs.mergeStatus,
      accountResults: vcs.accountResults,
      durationSec,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    recordFailedPlan(projectPath, plan, err);
    if (planId) transitionPlanState(projectPath, planId, "failed", { error: err });
    await appendLesson(projectPath, `execute:failed "${plan.title}" x ${err.slice(0, 120)}`);
    // Mark any running steps as failed so no step stays in "running" forever
    for (const step of steps) {
      if (step.status === "running") {
        step.status = "failed";
        step.finished_at = new Date().toISOString();
        step.error = step.error ?? err.slice(0, 500);
      }
    }
    if (jobId) updateJobStepStates(jobId, [...steps]).catch(() => {});
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
