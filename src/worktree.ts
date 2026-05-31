import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { p7ProjectDir } from "./p7-paths.ts";
import type { DevAgentConfig } from "./config.ts";

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCommit: string;
}

const REUSED_WORKTREE_DIR = "active";

function git(projectPath: string, args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(["git", "-C", projectPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new TextDecoder().decode(proc.stdout).trim();
  const err = new TextDecoder().decode(proc.stderr).trim();
  return { ok: proc.exitCode === 0, out: out || err };
}

export function getHeadCommit(projectPath: string): string {
  const { ok, out } = git(projectPath, ["rev-parse", "HEAD"]);
  if (!ok) throw new Error(`git rev-parse HEAD failed: ${out}`);
  return out;
}

/** PR 合并目标分支，默认 main */
export function defaultBaseBranch(cfg: DevAgentConfig): string {
  return cfg.vcs.base_branch?.trim() || "main";
}

/** 固定工作分支；未配置则每次 Plan 新建 ephemeral 分支 */
export function resolveWorkBranch(cfg: DevAgentConfig): string | null {
  const b = cfg.vcs.work_branch?.trim();
  return b || null;
}

/**
 * 执行前对齐远程基线：fetch 后用 origin/<base> 作为 worktree 起点，减少 PR 冲突。
 * fetch 失败时回退 plan.baseCommit 或当前 HEAD。
 */
export function resolveExecutionBaseCommit(
  projectPath: string,
  cfg: DevAgentConfig,
  planBaseCommit?: string,
): { commit: string; source: string; synced: boolean } {
  const baseBranch = defaultBaseBranch(cfg);
  const fetch = git(projectPath, ["fetch", "origin", baseBranch]);
  if (!fetch.ok) {
    const fallback = planBaseCommit ?? getHeadCommit(projectPath);
    return { commit: fallback, source: "local (fetch failed)", synced: false };
  }
  const remoteRef = `origin/${baseBranch}`;
  const remote = git(projectPath, ["rev-parse", remoteRef]);
  if (!remote.ok) {
    const fallback = planBaseCommit ?? getHeadCommit(projectPath);
    return { commit: fallback, source: "local (no remote ref)", synced: false };
  }
  return { commit: remote.out, source: remoteRef, synced: true };
}

/** 工作台检查：本地 HEAD 是否与 origin 基线分支一致 */
export function gitSyncWithOrigin(
  projectPath: string,
  cfg: DevAgentConfig,
): { ok: boolean; detail: string } {
  const baseBranch = defaultBaseBranch(cfg);
  const fetch = git(projectPath, ["fetch", "origin", baseBranch]);
  if (!fetch.ok) {
    return { ok: false, detail: `无法 fetch origin/${baseBranch}` };
  }
  const remoteRef = `origin/${baseBranch}`;
  const remoteSha = git(projectPath, ["rev-parse", remoteRef]);
  if (!remoteSha.ok) {
    return { ok: false, detail: `无 ${remoteRef}` };
  }
  const head = git(projectPath, ["rev-parse", "HEAD"]);
  if (!head.ok) return { ok: false, detail: "无法读取 HEAD" };
  if (head.out === remoteSha.out) {
    return { ok: true, detail: `已与 ${remoteRef} 一致 (${head.out.slice(0, 7)})` };
  }
  const behind = git(projectPath, ["rev-list", "--count", `HEAD..${remoteRef}`]);
  const ahead = git(projectPath, ["rev-list", "--count", `${remoteRef}..HEAD`]);
  const b = behind.ok ? Number(behind.out) || 0 : 0;
  const a = ahead.ok ? Number(ahead.out) || 0 : 0;
  return {
    ok: b === 0,
    detail:
      b > 0
        ? `落后 ${remoteRef} ${b} 提交（执行时会基于远程基线开分支，建议 merge 前先 pull）`
        : `领先 ${remoteRef} ${a} 提交，本地 ${head.out.slice(0, 7)}`,
  };
}

function branchCheckedOutInMainRepo(projectPath: string, branch: string): boolean {
  const head = git(projectPath, ["symbolic-ref", "--short", "HEAD"]);
  return head.ok && head.out === branch;
}

function removeWorktreeAtPath(projectPath: string, wtPath: string): void {
  if (!existsSync(wtPath)) return;
  git(projectPath, ["worktree", "remove", "--force", wtPath]);
}

/** 复用固定分支：每次执行前重置到基线 commit，worktree 目录固定为 .p7/worktrees/active */
function createReusedWorktree(
  projectPath: string,
  baseCommit: string,
  branch: string,
): WorktreeInfo {
  const wtRoot = join(p7ProjectDir(projectPath), "worktrees");
  const wtPath = join(wtRoot, REUSED_WORKTREE_DIR);
  if (!existsSync(wtRoot)) mkdirSync(wtRoot, { recursive: true });

  git(projectPath, ["worktree", "prune"]);
  removeWorktreeAtPath(projectPath, wtPath);

  if (branchCheckedOutInMainRepo(projectPath, branch)) {
    throw new Error(
      `工作分支 ${branch} 正被主仓库 checkout，请先切换到 main 等其它分支再执行 Plan`,
    );
  }

  const branchExists = git(projectPath, ["show-ref", "--verify", `refs/heads/${branch}`]).ok;

  if (branchExists) {
    const reset = git(projectPath, ["branch", "-f", branch, baseCommit]);
    if (!reset.ok) {
      throw new Error(`无法将工作分支 ${branch} 重置到基线: ${reset.out}`);
    }
    const add = git(projectPath, ["worktree", "add", "--force", wtPath, branch]);
    if (!add.ok) throw new Error(`worktree add (复用分支) 失败: ${add.out}`);
  } else {
    const add = git(projectPath, ["worktree", "add", "-b", branch, wtPath, baseCommit]);
    if (!add.ok) throw new Error(`worktree add 失败: ${add.out}`);
  }

  return { path: wtPath, branch, baseCommit };
}

export function createWorktree(
  projectPath: string,
  baseCommit: string,
  cfg?: DevAgentConfig,
): WorktreeInfo {
  const workBranch = cfg ? resolveWorkBranch(cfg) : null;
  if (workBranch) {
    return createReusedWorktree(projectPath, baseCommit, workBranch);
  }

  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const branch = `p7/${ts}-${rand}`;
  const wtRoot = join(p7ProjectDir(projectPath), "worktrees");
  if (!existsSync(wtRoot)) mkdirSync(wtRoot, { recursive: true });
  const wtPath = join(wtRoot, `${ts}-${rand}`);

  const add = git(projectPath, ["worktree", "add", "-b", branch, wtPath, baseCommit]);
  if (!add.ok) throw new Error(`worktree add failed: ${add.out}`);

  return { path: wtPath, branch, baseCommit };
}

export function removeWorktree(
  projectPath: string,
  info: WorktreeInfo,
  force = false,
  opts?: { keepBranch?: boolean },
): void {
  git(projectPath, ["worktree", "remove", info.path, ...(force ? ["--force"] : [])]);
  if (!opts?.keepBranch) {
    git(projectPath, ["branch", "-D", info.branch]);
  }
}

export function listWorktrees(projectPath: string): string[] {
  const dir = join(p7ProjectDir(projectPath), "worktrees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

export function resetWorktree(wtPath: string): void {
  git(wtPath, ["checkout", "."]);
  git(wtPath, ["clean", "-fd"]);
}
