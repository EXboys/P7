import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LEGACY_HOME = ".dev-agent";
const P7_HOME = ".p7";

/** 本机 P7 目录（读写均使用） */
export function p7HomeDir(): string {
  return join(homedir(), P7_HOME);
}

export function legacyHomeDir(): string {
  return join(homedir(), LEGACY_HOME);
}

/** 仓库内 P7 目录（读写均使用） */
export function p7ProjectDir(projectPath: string): string {
  return join(projectPath, P7_HOME);
}

export function legacyProjectDir(projectPath: string): string {
  return join(projectPath, LEGACY_HOME);
}

/** @deprecated 使用 p7HomeDir */
export function resolveP7HomeDir(): string {
  return p7HomeDir();
}

/** @deprecated 使用 p7ProjectDir */
export function resolveProjectDataDir(projectPath: string): string {
  return p7ProjectDir(projectPath);
}

function dirHasEntries(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** 读取仓库数据：优先 `.p7`，仅存在旧目录时回退 `.dev-agent` */
export function projectDataDirForRead(projectPath: string): string {
  const p7 = p7ProjectDir(projectPath);
  const leg = legacyProjectDir(projectPath);
  if (dirHasEntries(p7)) return p7;
  if (dirHasEntries(leg)) return leg;
  return p7;
}

/** 读取本机文件：优先 `~/.p7/…`，否则 `~/.dev-agent/…` */
export function homePathForRead(...parts: string[]): string {
  const p = join(p7HomeDir(), ...parts);
  const l = join(legacyHomeDir(), ...parts);
  if (existsSync(p)) return p;
  if (existsSync(l)) return l;
  return p;
}

export function projectSubpathForRead(projectPath: string, ...parts: string[]): string {
  return join(projectDataDirForRead(projectPath), ...parts);
}

export function projectSubpathForWrite(projectPath: string, ...parts: string[]): string {
  return join(p7ProjectDir(projectPath), ...parts);
}
