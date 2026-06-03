import type { DevAgentConfig } from "../config.ts";
import type { Plan } from "../types.ts";
import { planDisplayTitle } from "../plan-i18n.ts";

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

/** 未合并（冲突）文件列表 */
export function listUnmergedFiles(projectPath: string): string[] {
  const r = git(projectPath, ["diff", "--name-only", "--diff-filter=U"]);
  if (!r.ok || !r.out) return [];
  return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function deriveConflictMaxTurns(
  conflictFileCount: number,
  vcs: DevAgentConfig["vcs"],
): number {
  const cap = vcs.merge_conflict_max_turns ?? 100;
  const n = Math.max(conflictFileCount, 1);
  const scaled = 30 + n * 15;
  return Math.min(Math.max(scaled, 50), cap);
}

const MAX_FILE_SNIPPETS = 20;
const SNIPPET_LINES = 300;

function fileConflictSnippet(projectPath: string, file: string): string {
  const diff = git(projectPath, ["diff", "--", file]);
  const text = diff.out || "";
  if (!text) return "(无 diff 输出)";
  const lines = text.split("\n");
  if (lines.length <= SNIPPET_LINES) return text;
  return `${lines.slice(0, SNIPPET_LINES).join("\n")}\n…（已截断，共 ${lines.length} 行）`;
}

export function buildConflictResolvePrompt(opts: {
  projectPath: string;
  baseBranch: string;
  plan: Plan;
  statusPorcelain: string;
  pass: number;
  maxPasses: number;
  remainingFiles?: string[];
}): string {
  const files =
    opts.remainingFiles && opts.remainingFiles.length > 0
      ? opts.remainingFiles
      : listUnmergedFiles(opts.projectPath);
  const fileSection =
    files.length === 0
      ? "（git 未列出 UU 文件，请根据 status 自行定位）"
      : files
          .slice(0, MAX_FILE_SNIPPETS)
          .map((f, i) => `### ${i + 1}. ${f}\n\`\`\`diff\n${fileConflictSnippet(opts.projectPath, f)}\n\`\`\``)
          .join("\n\n") +
        (files.length > MAX_FILE_SNIPPETS
          ? `\n\n…另有 ${files.length - MAX_FILE_SNIPPETS} 个冲突文件，请用 Read/Grep 查看。`
          : "");

  const passHint =
    opts.maxPasses > 1
      ? `\n本轮为第 ${opts.pass}/${opts.maxPasses} 次 Agent 修复；若文件多，先处理列表中前几个，再运行 git status 确认。`
      : "";

  return [
    `解决当前仓库与 \`${opts.baseBranch}\` 的合并冲突，保留双方合理改动。`,
    `Plan：${planDisplayTitle(opts.plan)}`,
    `冲突文件数：${files.length || "未知"}`,
    passHint,
    "",
    "## git status --porcelain",
    opts.statusPorcelain || "(空)",
    "",
    "## 冲突文件与 diff 片段",
    fileSection,
    "",
    "完成后运行 `git diff --check` 确认无 <<<<<<< 标记。",
  ].join("\n");
}

export function mergeConflictWaitMinutes(
  vcs: DevAgentConfig["vcs"],
  conflicting: boolean,
): number {
  if (conflicting) {
    if (vcs.merge_conflict_wait_minutes != null) return vcs.merge_conflict_wait_minutes;
    return Math.max(vcs.merge_wait_minutes ?? 20, 90);
  }
  return Math.min(vcs.merge_wait_minutes ?? 20, 15);
}
