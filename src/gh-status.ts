import type { DevAgentConfig } from "./config.ts";

export interface GhAuthStatus {
  hostname: string;
  ok: boolean;
  detail: string;
  login?: string;
}

function runGh(projectPath: string, args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(["gh", ...args], {
    cwd: projectPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  return { ok: proc.exitCode === 0, out: stdout || stderr };
}

export function ghInstalled(): boolean {
  const proc = Bun.spawnSync(["sh", "-c", "command -v gh"], { stdout: "pipe" });
  return proc.exitCode === 0;
}

export function checkGhAuth(projectPath: string, hostname = "github.com"): GhAuthStatus {
  if (!ghInstalled()) {
    return { hostname, ok: false, detail: "未安装 gh CLI（brew install gh）" };
  }
  const r = runGh(projectPath, ["auth", "status", "--hostname", hostname]);
  if (!r.ok) {
    return {
      hostname,
      ok: false,
      detail: r.out.slice(0, 240) || "未登录",
    };
  }
  const login =
    r.out.match(/Logged in to [^\s]+ account (\S+)/)?.[1] ??
    r.out.match(/✓ Logged in to \S+ as (\S+)/)?.[1];
  return {
    hostname,
    ok: true,
    detail: login ? `已登录：${login}` : "已登录",
    login,
  };
}

export function collectGhAuthChecks(
  projectPath: string,
  accounts: DevAgentConfig["vcs"]["accounts"],
): GhAuthStatus[] {
  const hosts = new Set<string>(["github.com"]);
  for (const a of accounts) hosts.add(a.gh_host || "github.com");
  return [...hosts].map((h) => checkGhAuth(projectPath, h));
}

export function gitRemoteOrigin(projectPath: string): string {
  const proc = Bun.spawnSync(["git", "-C", projectPath, "remote", "get-url", "origin"], {
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) return "";
  return new TextDecoder().decode(proc.stdout).trim();
}
