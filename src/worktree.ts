import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { p7ProjectDir } from "./p7-paths.ts";

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCommit: string;
}

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

export function createWorktree(
  projectPath: string,
  baseCommit: string,
  branchPrefix = "p7",
): WorktreeInfo {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const branch = `${branchPrefix}/${ts}-${rand}`;
  const wtRoot = join(p7ProjectDir(projectPath), "worktrees");
  if (!existsSync(wtRoot)) mkdirSync(wtRoot, { recursive: true });
  const wtPath = join(wtRoot, `${ts}-${rand}`);

  const add = git(projectPath, ["worktree", "add", "-b", branch, wtPath, baseCommit]);
  if (!add.ok) throw new Error(`worktree add failed: ${add.out}`);

  return { path: wtPath, branch, baseCommit };
}

export function removeWorktree(projectPath: string, info: WorktreeInfo, force = false): void {
  git(projectPath, ["worktree", "remove", info.path, ...(force ? ["--force"] : [])]);
  try {
    git(projectPath, ["branch", "-D", info.branch]);
  } catch {
    /* branch may be checked out elsewhere */
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
