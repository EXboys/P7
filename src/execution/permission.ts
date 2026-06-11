import { realpathSync } from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";

function normalizeAllowedPath(path: string, cwd: string): string {
  const cwdNorm = resolve(cwd);
  if (isAbsolute(path)) {
    const rel = relative(cwdNorm, resolve(path));
    return rel === "" ? "" : rel.replace(/\\/g, "/");
  }
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

function isPathWithinWorktree(filePath: string, worktreeRoot: string): boolean {
  let rootResolved: string;
  try {
    rootResolved = realpathSync(worktreeRoot);
  } catch {
    return false;
  }
  const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(rootResolved, filePath);
  let resolvedPath: string | undefined;
  try {
    resolvedPath = realpathSync(absPath);
  } catch {
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

function hasBashPathTraversal(command: string, worktreeRoot: string): boolean {
  if (/(?:^|\s+)(\.\.\/)/.test(command)) return true;
  if (/(?:^|\s+)(~)(?:\/|\s+|$)/.test(command)) return true;
  if (/\$HOME\b/.test(command)) return true;
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
            if (!path) return deny("Missing file path in tool input");
            if (!isPathWithinWorktree(path, cwd)) {
              if (input.tool_name === "Read" && resolvedExtraReadPaths.length > 0) {
                const absPath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
                const withinExtra = resolvedExtraReadPaths.some(
                  (ep) => absPath === ep || absPath.startsWith(ep.endsWith("/") ? ep : ep + "/"),
                );
                if (withinExtra) return allow();
              }
              return deny(`File path outside worktree boundary: ${path}`);
            }
            if (input.tool_name === "Read") return allow();
            const normalized = normalizeAllowedPath(path, cwd);
            const allowed = [...allowedFiles].some(
              (f) => normalized === f || normalized.endsWith(`/${f}`) || normalized.endsWith(f),
            );
            if (!allowed) return deny(`File not in plan: ${normalized}`);
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
