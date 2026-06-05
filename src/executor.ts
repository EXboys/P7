import { existsSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { devAgentDir } from "./config.ts";
import type { DevAgentConfig } from "./config.ts";
import { reviewDiff } from "./diff-critic.ts";
import { reviewDiffWithRouting } from "./evaluator-middleware.ts";
import { appendLesson } from "./agent-memory.ts";
import { markRoadmapStepDone } from "./roadmap.ts";
import { refreshRoadmapIfExhausted } from "./roadmap-refresh.ts";
import { readPrompt, runSdkQuery } from "./sdk.ts";
import { loadLatestPlanRecord, recordFailedPlan } from "./planner.ts";
import {
  formatExecuteRetryPromptBlock,
  loadPreviousExecuteFailureContext,
} from "./execute-retry-context.ts";
import { abandonStuckApprovedPlan } from "./approval.ts";
import { getGoalCostSum, transitionPlanState, updatePlanDiffCriticFindings, recordBackpressureEvent } from "./state.ts";
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
  resolveWorkBranch,
  type WorktreeInfo,
} from "./worktree.ts";
import { executorSemaphore, withExponentialBackoff } from "./retry.ts";
import type { StepState } from "../server/queue/types.ts";
import { updateJobStepState } from "../server/queue/db.ts";
import { addSdkCost, emptySdkCost } from "./sdk-cost.ts";
import { planDisplayTitle, planPublishTitle, planRoadmapHint } from "./plan-i18n.ts";
import { scaffoldMissingPlanFiles } from "./executor-scaffold.ts";
import {
  appendExecuteToolLog,
  emptyToolTrace,
  formatToolTraceSummary,
} from "./sdk-tool-log.ts";

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
  if (c === "simple") return { maxFiles: 3, maxDiffLines: 300 };
  if (c === "complex") return { maxFiles: 8, maxDiffLines: 800 };
  return { maxFiles: 5, maxDiffLines: 500 };
}

function normalizeAllowedPath(path: string, cwd: string): string {
  const cwdNorm = resolve(cwd);
  if (isAbsolute(path)) {
    const rel = relative(cwdNorm, resolve(path));
    return rel === "" ? "" : rel.replace(/\\/g, "/");
  }
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

/**
 * Check if a file path resolves within the worktree boundary.
 * For non-existent paths (e.g., new files to write), resolves the parent
 * directory instead to determine boundary membership.
 */
function isPathWithinWorktree(filePath: string, worktreeRoot: string): boolean {
  let rootResolved: string;
  try {
    rootResolved = realpathSync(worktreeRoot);
  } catch {
    return false;
  }

  const absPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(rootResolved, filePath);
  let resolvedPath: string | undefined;
  try {
    resolvedPath = realpathSync(absPath);
  } catch {
    // Path doesn't exist yet — walk up to the nearest existing parent.
    let parent = dirname(absPath);
    while (parent && parent !== dirname(parent)) {
      try {
        resolvedPath = realpathSync(parent);
        break;
      } catch {
        parent = dirname(parent);
      }
    }
    if (!resolvedPath!) return false;
  }
  const root = rootResolved.endsWith("/") ? rootResolved : rootResolved + "/";
  return resolvedPath === rootResolved || resolvedPath.startsWith(root);
}

/**
 * Detect path traversal attempts in Bash commands —
 * blocks access to parent directories, home dir, and sensitive system paths.
 */
function hasBashPathTraversal(command: string, worktreeRoot: string): boolean {
  // Directory traversal above worktree via ..
  if (/(?:^|\s+)(\.\.\/)/.test(command)) return true;

  // Home directory reference
  if (/(?:^|\s+)(~)(?:\/|\s+|$)/.test(command)) return true;
  if (/\$HOME\b/.test(command)) return true;

  // Sensitive absolute system paths not within worktree
  const sensitivePrefixes = [
    "/etc/", "/usr/", "/bin/", "/sbin/", "/var/", "/dev/",
    "/proc/", "/sys/", "/boot/", "/opt/", "/root/", "/tmp/",
  ];
  const absPaths = command.match(/(?:\s|^)(\/[^\s;"'|&$()`]+)/g);
  if (absPaths) {
    for (const ap of absPaths) {
      const p = ap.trim();
      if (p.length < 2 || p === "/" || p.startsWith(worktreeRoot)) continue;
      if (sensitivePrefixes.some((prefix) => p.startsWith(prefix))) return true;
    }
  }
  return false;
}

export function buildPreToolHook(
  allowedFiles: Set<string>,
  cwd: string,
  onDeny?: (reason: string) => void,
  extraReadPaths?: string[],
) {
  // Resolve extra read paths to canonical absolute dirs at creation time.
  // If a path doesn't exist yet, fall back to resolve() for prefix matching.
  const resolvedExtraReadPaths = (extraReadPaths ?? []).map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  });
  const dangerousBash = /\b(git\s+(add|commit|push|reset|checkout|clean|merge|rebase)|rm\s+-|mv\s+|cp\s+|chmod\s+|chown\s+|sed\s+-i|perl\s+-pi|dd\s+|truncate\s+)/i;
  return {
    PreToolUse: [
      {
        matcher: "Read|Write|Edit|Bash",
        hooks: [
          async (input: {
            tool_name: string;
            tool_input: { file_path?: string; path?: string; command?: string };
          }) => {
            const deny = (reason: string) => {
              onDeny?.(`${input.tool_name}: ${reason}`);
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: reason,
                },
              };
            };
            const allow = () => ({
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "allow" as const,
              },
            });

            if (input.tool_name === "Bash") {
              const command = input.tool_input?.command ?? "";
              if (dangerousBash.test(command)) {
                return deny(
                  "Executor Bash may run inspection/tests only; host handles file mutation and git operations",
                );
              }
              if (hasBashPathTraversal(command, cwd)) {
                return deny("Path traversal detected in Bash command — filesystem boundary enforced");
              }
              return allow();
            }

            const path = input.tool_input?.file_path ?? input.tool_input?.path;
            if (!path) {
              return deny("Missing file path in tool input");
            }

            // Filesystem boundary check (Read/Write/Edit)
            if (!isPathWithinWorktree(path, cwd)) {
              // Before denying, check if this is a Read operation within extraReadPaths
              if (input.tool_name === "Read" && resolvedExtraReadPaths.length > 0) {
                const absPath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
                const withinExtra = resolvedExtraReadPaths.some(
                  (ep) => absPath === ep || absPath.startsWith(ep.endsWith("/") ? ep : ep + "/"),
                );
                if (withinExtra) return allow();
              }
              return deny(`File path outside worktree boundary: ${path}`);
            }

            // Read is allowed for any project file (no plan-file restriction)
            if (input.tool_name === "Read") {
              return allow();
            }

            // Write/Edit: restrict to plan-allowed files
            const normalized = normalizeAllowedPath(path, cwd);
            const allowed = [...allowedFiles].some(
              (f) => normalized === f || normalized.endsWith(`/${f}`) || normalized.endsWith(f),
            );
            if (!allowed) {
              return deny(`File not in plan: ${normalized}`);
            }
            return allow();
          },
        ],
      },
    ],
  };
}

export function fatalExecutorPermissionViolations(deniedOps: string[]): string[] {
  return deniedOps.filter((r) => /^(Write|Edit): .*outside worktree boundary/i.test(r));
}

function commandExists(name: string): boolean {
  const proc = Bun.spawnSync(["sh", "-c", `command -v ${name}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0;
}

/* ── Type-check execution types and parsers ── */

/**
 * Extended type-check result with parsed per-file error counts.
 * Backward compatible — existing callers accessing only `ok`/`out` continue to work.
 */
export interface TypecheckOutput {
  ok: boolean;
  out: string;
  /** Total number of type errors across all files. */
  totalErrors: number;
  /** Per-file error counts extracted from tsc output. */
  perFileErrors: Record<string, number>;
}

/** Regex matching standard tsc error lines: `<file>(<line>,<col>): error TS<code>: ...` */
const TSC_ERROR_RE = /^([^(]+)\(\d+,\s*\d+\):\s+error TS\d+:/gm;

/**
 * Parse tsc text output and extract per-file type error counts.
 * Handles the standard tsc error format (non-pretty mode).
 * Returns an empty report if no errors are found or the format doesn't match.
 *
 * @param out - Raw stdout/stderr text from a tsc invocation.
 */
export function parseTypecheckErrors(out: string): {
  perFileErrors: Record<string, number>;
  totalErrors: number;
} {
  const perFileErrors: Record<string, number> = {};
  let match: RegExpExecArray | null;
  TSC_ERROR_RE.lastIndex = 0;
  while ((match = TSC_ERROR_RE.exec(out)) !== null) {
    const filePath = match[1];
    perFileErrors[filePath] = (perFileErrors[filePath] ?? 0) + 1;
  }
  const totalErrors = Object.values(perFileErrors).reduce(
    (sum, c) => sum + c,
    0,
  );
  return { perFileErrors, totalErrors };
}

async function runTypecheck(wtPath: string): Promise<TypecheckOutput> {
  if (existsSync(join(wtPath, "package.json"))) {
    const pkg = JSON.parse(readFileSync(join(wtPath, "package.json"), "utf-8"));
    if (pkg.scripts?.typecheck) {
      const runner = existsSync(join(wtPath, "bun.lockb")) && commandExists("bun")
        ? ["bun", "run", "typecheck"]
        : existsSync(join(wtPath, "pnpm-lock.yaml")) && commandExists("pnpm")
          ? ["pnpm", "run", "typecheck"]
          : ["npm", "run", "typecheck"];
      const proc = Bun.spawnSync(runner, { cwd: wtPath, stdout: "pipe", stderr: "pipe" });
      const out =
        new TextDecoder().decode(proc.stdout) +
        "\n" +
        new TextDecoder().decode(proc.stderr);
      const { perFileErrors, totalErrors } = parseTypecheckErrors(out);
      return { ok: proc.exitCode === 0, out, perFileErrors, totalErrors };
    }
  }
  const runner = commandExists("bunx") ? ["bunx", "tsc", "--noEmit"] : ["npx", "tsc", "--noEmit"];
  const proc = Bun.spawnSync(runner, { cwd: wtPath, stdout: "pipe", stderr: "pipe" });
  const out =
    new TextDecoder().decode(proc.stdout) +
    "\n" +
    new TextDecoder().decode(proc.stderr);
  const { perFileErrors, totalErrors } = parseTypecheckErrors(out);
  return { ok: proc.exitCode === 0, out, perFileErrors, totalErrors };
}

export function diffStatsAgainstBase(wtPath: string, baseCommit: string): { files: number; lines: number } {
  const raw = git(wtPath, ["diff", baseCommit, "--numstat"]);
  let files = 0;
  let lines = 0;
  if (raw.ok && raw.out.trim()) {
    for (const row of raw.out.split("\n").filter(Boolean)) {
      const parts = row.split("\t");
      if (parts.length < 3) continue;
      const adds = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
      const dels = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
      if (adds + dels > 0) files++;
      lines += adds + dels;
    }
  }

  // New files are untracked until commit — git diff baseCommit does not include them.
  const untracked = git(wtPath, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.ok && untracked.out.trim()) {
    for (const rel of untracked.out.split("\n").filter(Boolean)) {
      files++;
      try {
        const content = readFileSync(join(wtPath, rel), "utf-8");
        lines += content.length === 0 ? 0 : content.split("\n").length;
      } catch {
        lines += 1;
      }
    }
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

  let sdkCost = emptySdkCost();

  await executorSemaphore.acquire();

  const deniedOps: string[] = [];
  let permissionFindings = "";

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

    // ── Pre-execution check: goal-level cost limit ──
    if (plan.goal && cfg.goal_cost_limit > 0) {
      const goalCost = getGoalCostSum(projectPath, plan.goal);
      if (goalCost >= cfg.goal_cost_limit) {
        recordBackpressureEvent(projectPath, planId ?? "", {
          type: "cost_limit_hit",
          detail: `Goal "${plan.goal}" cumulative cost $${goalCost.toFixed(2)} >= limit $${cfg.goal_cost_limit.toFixed(2)}`,
          limitUsd: cfg.goal_cost_limit,
          actualUsd: goalCost,
        });
        throw new Error(
          `Goal cost limit exceeded: $${goalCost.toFixed(2)} >= $${cfg.goal_cost_limit.toFixed(2)} for goal "${plan.goal}"`,
        );
      }
    }
    // ──────────────────────────────────────────────────

    await appendLesson(
      projectPath,
      `execute:base ${base.source} @ ${baseCommit.slice(0, 7)}${base.synced ? "" : " (未同步远程)"}`,
    );
    const workBranch = resolveWorkBranch(cfg);
    const wtStart = new Date().toISOString();
    writeStepState({ step_name: "worktree_create", status: "running", started_at: wtStart });
    wt = createWorktree(projectPath, baseCommit, cfg);
    writeStepState({ step_name: "worktree_create", status: "completed", started_at: wtStart, finished_at: new Date().toISOString() });

    // ── Sandbox preview URL ──
    const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL ?? process.env.P7_DASHBOARD_URL;
    const projectAlias = process.env.P7_PROJECT_ALIAS;
    const previewUrl = dashboardBaseUrl && projectAlias
      ? `${dashboardBaseUrl.replace(/\/+$/, "")}/sandbox/${encodeURIComponent(projectAlias)}`
      : "";
    if (previewUrl) {
      const spStart = new Date().toISOString();
      writeStepState({ step_name: "sandbox_preview", status: "completed", started_at: spStart, finished_at: spStart });
    }
    // ───────────────────────

    const system = readPrompt("executor-system.md");
    const planText = JSON.stringify(plan, null, 2);
    const maxTurns = deriveMaxTurns(plan);
    const priorFailure = planId
      ? loadPreviousExecuteFailureContext(
          projectPath,
          planId,
          planDisplayTitle(plan),
          process.env.P7_PROJECT_ALIAS,
          process.env.P7_JOB_ID,
        )
      : "";
    const priorFailureBlock = formatExecuteRetryPromptBlock(priorFailure);
    if (priorFailure) {
      await appendLesson(
        projectPath,
        `execute:retry-with-context plan=${planId} (${priorFailure.slice(0, 80)}…)`,
      );
    }

    const maxAgentPasses = 2;
    let stats = { files: 0, lines: 0 };
    let diffStatOut = "";

    const sdkStart = new Date().toISOString();
    writeStepState({ step_name: "sdk_execution", status: "running", started_at: sdkStart });
    let lastToolSummary = "";

    for (let pass = 0; pass < maxAgentPasses; pass++) {
      if (pass > 0) {
        const scaffolded = scaffoldMissingPlanFiles(wt.path, plan);
        if (scaffolded.length > 0) {
          await appendLesson(
            projectPath,
            `execute:scaffold pass${pass + 1} ${scaffolded.join(", ")}`,
          );
          appendExecuteToolLog(`scaffold created: ${scaffolded.join(", ")}`);
        }
      }

      const retryHint =
        pass > 0
          ? "\n\n【重要】上一轮未产生任何文件变更。占位文件已创建（若有）。你必须用 Edit/Write 修改计划中列出的每个文件，禁止空跑。"
          : "";

      const toolTrace = emptyToolTrace();
      const onDeny = (reason: string) => {
        deniedOps.push(reason);
        appendExecuteToolLog(`hook deny ${reason}`);
      };

      const runOnce = async () => {
        const result = await runSdkQuery({
          prompt: `在 worktree 中执行以下计划：\n\`\`\`json\n${planText}\n\`\`\`${priorFailureBlock}${retryHint}`,
          cwd: wt!.path,
          systemPrompt: system,
          role: "executor",
          allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
          hooks: buildPreToolHook(allowedFiles, wt!.path, onDeny, [join(projectPath, '.p7', 'discovery')]) as never,
          maxTurns,
          toolTrace,
          projectPath,
          planId,
          goal: plan.goal,
        });
        sdkCost = addSdkCost(sdkCost, result);
        if (sdkCost.costUsd > cfg.execution_cost_limit) {
          recordBackpressureEvent(projectPath, planId ?? "", {
            type: "cost_limit_hit",
            detail: `Cost limit $${cfg.execution_cost_limit.toFixed(2)} exceeded: $${sdkCost.costUsd.toFixed(4)}`,
            limitUsd: cfg.execution_cost_limit,
            actualUsd: sdkCost.costUsd,
          });
          throw new Error(
            `execution cost exceeded limit: ${sdkCost.costUsd} > ${cfg.execution_cost_limit}`,
          );
        }
      };

      await withExponentialBackoff(async () => {
        try {
          await runOnce();
        } catch (e) {
          recordBackpressureEvent(projectPath, planId ?? "", {
            type: "retry_backoff",
            detail: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
          });
          resetWorktree(wt!.path);
          throw e;
        }
      }, {
        maxRetries: cfg.execution_retry.max_retries,
        initialDelayMs: cfg.execution_retry.initial_delay_ms,
        maxDelayMs: cfg.execution_retry.max_delay_ms,
      });

      const toolSummary = formatToolTraceSummary(toolTrace, pass);
      lastToolSummary = toolSummary;
      appendExecuteToolLog(toolSummary);
      await appendLesson(projectPath, `execute:tools ${toolSummary}`);

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
        await Bun.sleep(cfg.execution_retry.pass_retry_delay_ms);
        resetWorktree(wt!.path);
      }
    }

    // ── Permission violations gate ──
    // 所有被拒操作都已被边界成功拦截、未真正执行。只有"试图写出 worktree 边界"
    // 这类真正危险的越界意图才让任务失败；agent 自检产生的 plan 外临时文件、
    // 只读路径穿越、被拦的 git/rm 命令属无害试探，不应因此把整个交付判失败——
    // 实际产出质量交由后续 stats.files / diff / typecheck / test 门禁把关。
    if (deniedOps.length > 0) {
      permissionFindings = `Permission notes during execution (blocked, non-fatal):\n${deniedOps.map((r) => `- ${r}`).join("\n")}`;
      const fatalOps = fatalExecutorPermissionViolations(deniedOps);
      if (fatalOps.length > 0) {
        const fatalMsg = `Permission violations (fatal) during execution:\n${fatalOps.map((r) => `- ${r}`).join("\n")}`;
        if (planId) {
          transitionPlanState(projectPath, planId, "failed", {
            error: fatalMsg,
          });
        }
        throw new Error(fatalMsg);
      }
    }

    if (stats.files === 0) {
      throw new Error(
        `executor produced no file changes after 2 attempts; ${lastToolSummary || "no tool summary"}; use console「重试执行」or fix plan scope`,
      );
    }

    writeStepState({ step_name: "sdk_execution", status: "completed", started_at: sdkStart, finished_at: new Date().toISOString() });

    const diffStart = new Date().toISOString();
    writeStepState({ step_name: "diff_check", status: "running", started_at: diffStart });
    const maxFiles = Math.min(
      Math.max(limits.maxFiles, plan.changes.length),
      Math.max(cfg.diff_critic.max_files_ceiling, 8),
    );
    // 天花板至少与 Plan schema 的 estimated_diff_lines 上限(1000)对齐，
    // 避免旧项目配置里的小 max_diff_ceiling(如 300) 把放宽后的大 Plan 压死。
    const ceiling = Math.max(cfg.diff_critic.max_diff_ceiling, 1000);
    const maxDiffLines = Math.min(
      Math.max(
        Math.ceil(plan.estimated_diff_lines * cfg.diff_critic.max_diff_multiplier),
        limits.maxDiffLines,
      ),
      ceiling,
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
    const critic = await reviewDiffWithRouting(wt.path, diffStatOut, plan.title, stats, plan);
    if (critic.cost) sdkCost = addSdkCost(sdkCost, critic.cost);

    if (!critic.ok) {
      // Extract dimension-level blocker/warning summary for actionable error
      const blockedDims = critic.findings
        .split("\n")
        .filter((l) => /\[(blocker|warning)\]/.test(l))
        .map((l) => l.trim())
        .slice(0, 5)
        .join("; ");
      const brief = blockedDims || critic.findings.slice(0, 300);

      // Persist complete findings to PlanState via transitionPlanState before blocking.
      // This ensures full findings are queryable via PlanState, not truncated in error field.
      if (planId) {
        try {
          updatePlanDiffCriticFindings(projectPath, planId, critic.findings);
          transitionPlanState(projectPath, planId, "failed", {
            error: brief,
            diffCriticFindings: critic.findings,
          });
        } catch {
          /* non-critical if persist fails */
        }
      }

      throw new Error(`diff-critic blocked: ${brief}`);
    }

    // Persist findings for non-blocking case via transitionPlanState (best-effort traceability)
    // 与阻断路径统一使用 transitionPlanState，使 findings 可被 Review 控制台和后继门禁逻辑消费
    if (planId) {
      try {
        updatePlanDiffCriticFindings(projectPath, planId, critic.findings);
        transitionPlanState(projectPath, planId, "executing", {
          diffCriticFindings: critic.findings,
        });
      } catch {
        /* non-critical if persist fails */
      }
    }
    writeStepState({ step_name: "diff_critic", status: "completed", started_at: criticStart, finished_at: new Date().toISOString() });

    const gitStart = new Date().toISOString();
    writeStepState({ step_name: "git_commit_push", status: "running", started_at: gitStart });
    const { sha } = commitWorktreeChanges(wt, baseCommit, planPublishTitle(plan));

    const pushArgs = workBranch
      ? ["push", "--force-with-lease", "-u", "origin", wt.branch]
      : ["push", "-u", "origin", wt.branch];
    const push = git(wt.path, pushArgs);
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
        planId: planId ?? undefined,
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
        costUsd: sdkCost.costUsd > 0 ? sdkCost.costUsd : undefined,
        tokenUsage: sdkCost.usage,
        error: mergeStatus === "failed" ? lifecycleDetail : undefined,
      });
    }
    writeStepState({ step_name: "vcs_publish", status: "completed", started_at: vcsStart, finished_at: new Date().toISOString() });
    await markRoadmapStepDone(projectPath, planRoadmapHint(plan, plan.goal), sha);
    await refreshRoadmapIfExhausted(projectPath, cfg, { force: true, autoPlan: true });

    const durationSec = Math.round((Date.now() - start) / 1000);
    await appendLesson(
      projectPath,
      `execute:ok "${planDisplayTitle(plan)}" -> ${branch} / ${durationSec}s${vcs.prUrl ? ` / ${vcs.prUrl}` : ""}`,
    );

    removeWorktree(projectPath, wt, true, { keepBranch: Boolean(workBranch) });
    wt = null;

    return {
      ok: true,
      previewUrl: previewUrl || undefined,
      branch,
      commitSha: sha,
      reviewUrl: vcs.reviewUrl,
      prUrl: vcs.prUrl,
      issueUrl: vcs.issueUrl,
      mergeStatus,
      accountResults: vcs.accountResults,
      costUsd: sdkCost.costUsd > 0 ? sdkCost.costUsd : undefined,
      tokenUsage: sdkCost.usage,
      durationSec,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    recordFailedPlan(projectPath, plan, err);
    if (planId) {
      transitionPlanState(projectPath, planId, "failed", {
        error: err,
        ...(permissionFindings ? { findings: permissionFindings } : {}),
        costUsd: sdkCost.costUsd > 0 ? sdkCost.costUsd : undefined,
        tokenUsage: sdkCost.usage,
      });
      abandonStuckApprovedPlan(projectPath, planId, {
        projectAlias: process.env.P7_PROJECT_ALIAS,
        goal: plan.goal,
        title: planDisplayTitle(plan),
      });
    }
    await appendLesson(projectPath, `execute:failed "${planDisplayTitle(plan)}" x ${err.slice(0, 120)}`);
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
      costUsd: sdkCost.costUsd > 0 ? sdkCost.costUsd : undefined,
      tokenUsage: sdkCost.usage,
      durationSec: Math.round((Date.now() - start) / 1000),
    };
  } finally {
    executorSemaphore.release();
    if (wt) {
      try {
        removeWorktree(projectPath, wt, false, {
          keepBranch: Boolean(resolveWorkBranch(cfg)),
        });
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
