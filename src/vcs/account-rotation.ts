import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { p7ProjectDir } from "../p7-paths.ts";
import type { DevAgentConfig } from "../config.ts";

type GitHubAccount = DevAgentConfig["vcs"]["accounts"][number];

type RotationState = { nextIndex: number };

const ROTATION_FILE = "vcs-account-rotation.json";

function rotationPath(projectPath: string): string {
  return join(p7ProjectDir(projectPath), ROTATION_FILE);
}

function readRotationState(projectPath: string): RotationState {
  const path = rotationPath(projectPath);
  if (!existsSync(path)) return { nextIndex: 0 };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as RotationState;
    const nextIndex = Number(raw.nextIndex);
    return { nextIndex: Number.isFinite(nextIndex) && nextIndex >= 0 ? nextIndex : 0 };
  } catch {
    return { nextIndex: 0 };
  }
}

function writeRotationState(projectPath: string, state: RotationState): void {
  const dir = p7ProjectDir(projectPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ROTATION_FILE), JSON.stringify(state, null, 2));
}

/** 轮询起点：从 nextIndex 开始依次尝试各账号。 */
export function orderedAccountsRoundRobin(
  accounts: GitHubAccount[],
  projectPath: string,
): { order: GitHubAccount[]; startIndex: number } {
  if (accounts.length === 0) return { order: [], startIndex: 0 };
  const { nextIndex } = readRotationState(projectPath);
  const startIndex = nextIndex % accounts.length;
  const order: GitHubAccount[] = [];
  for (let i = 0; i < accounts.length; i++) {
    order.push(accounts[(startIndex + i) % accounts.length]!);
  }
  return { order, startIndex };
}

/** 成功开 PR 后推进轮询指针，下次从下一个账号开始。 */
export function advanceAccountRotation(
  projectPath: string,
  usedAccountId: string,
  accounts: GitHubAccount[],
): void {
  if (accounts.length <= 1) return;
  const idx = accounts.findIndex((a) => a.id === usedAccountId);
  if (idx < 0) return;
  writeRotationState(projectPath, { nextIndex: (idx + 1) % accounts.length });
}

export function peekNextAccountId(
  accounts: GitHubAccount[],
  projectPath: string,
): string | null {
  if (accounts.length === 0) return null;
  const { nextIndex } = readRotationState(projectPath);
  return accounts[nextIndex % accounts.length]?.id ?? null;
}

/** 测试用：重置轮询状态 */
export function resetAccountRotation(projectPath: string): void {
  writeRotationState(projectPath, { nextIndex: 0 });
}
