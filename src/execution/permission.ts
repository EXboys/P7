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

function hasBashPathTraversal(
  command: string,
  worktreeRoot: string,
  extraAllowedBashPrefixes?: string[],
): boolean {
  if (/(?:^|\s+)(\.\.\/)/.test(command)) {
    if (extraAllowedBashPrefixes && extraAllowedBashPrefixes.length > 0) {
      const extraMatch = command.match(/\.\.[\/\w.\-]+/) || command.match(/\.\.\/?/);
      if (extraMatch) {
        const fullPath = resolve(worktreeRoot, extraMatch[0]);
        const isAllowed = extraAllowedBashPrefixes.some((prefix) => {
          const resolvedPrefix = resolve(prefix);
          const normalizedPrefix = resolvedPrefix.endsWith("/") ? resolvedPrefix : resolvedPrefix + "/";
          return fullPath === resolvedPrefix || fullPath.startsWith(normalizedPrefix);
        });
        if (isAllowed) return false;
      }
    }
    return true;
  }
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

/**
 * The set of base commands permitted for the executor Bash tool.
 *
 * Only commands in this set may execute; all others (curl, wget, python,
 * awk, xargs, ssh, etc.) are denied before the secondary dangerous-command
 * and path-traversal gates are checked.
 *
 * Commands that can execute arbitrary code (node -e, bun -e, etc.) are
 * intentionally included because the primary risk vector is network
 * exfiltration / file mutation — which the file-permission hook and
 * worktree boundary already mitigate. Agents need these for build and
 * test commands.
 */
export const DEFAULT_BASH_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  // — File & directory inspection —
  "ls", "find",
  // — File content reading —
  "cat", "head", "tail", "nl",
  // — Content search —
  "grep", "egrep", "fgrep", "rg", "ag",
  // — File metadata —
  "stat", "file", "du", "df", "wc",
  // — Text processing (read-only; -i/-I etc. blocked by dangerousBash regex) —
  "sort", "uniq", "cut", "tr", "fold", "paste", "join", "expand", "unexpand", "fmt",
  "diff", "comm", "cmp",
  // — Path utilities —
  "realpath", "readlink", "basename", "dirname",
  // — Process / identity —
  "which", "command", "type", "hash", "getconf",
  "whoami", "id", "uname", "hostname", "arch", "nproc",
  // — Output & printing —
  "echo", "printf", "pwd", "date", "env", "printenv",
  "true", "false", "yes",
  // — Build & run —
  "bun", "bunx", "node", "npm", "npx", "pnpm",
  "tsc", "eslint", "prettier", "biome",
  // — Binary inspection —
  "od", "xxd", "hexdump", "strings",
  // — Conditionals —
  "test", "[",
  // — Process supervision (safe wrapper, no mutation) —
  "timeout",
]);

/**
 * Extract the base command name from a Bash command string.
 *
 * Handles:
 * - Simple commands:  `ls -la`              → "ls"
 * - Path-qualified:   `/usr/bin/ls -la`     → "ls"
 * - Quoted commands:  `"my tool" --arg`     → "my tool"
 * - Env var prefix:   `FOO=bar VAR=val cmd` → "cmd"
 *
 * Returns the empty string when the command is empty or whitespace-only.
 */
export function getBashBaseCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";

  // Strip leading environment variable assignments (e.g., FOO=bar VAR=val cmd)
  const envAssignRe = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
  let rest = trimmed.replace(envAssignRe, "").trim();
  if (!rest) return "";

  // Get the first whitespace-delimited token
  const firstToken = rest.split(/\s+/)[0];
  if (!firstToken) return "";

  // Strip surrounding quotes
  const unquoted = firstToken.replace(/^(["'`])(.*)\1$/, "$2");

  // Extract basename for path-qualified commands
  const lastSlash = unquoted.lastIndexOf("/");
  return lastSlash >= 0 ? unquoted.slice(lastSlash + 1) : unquoted;
}

export function buildPreToolHook(
  allowedFiles: Set<string>,
  cwd: string,
  onDeny?: (reason: string) => void,
  extraReadPaths?: string[],
  extraProjectPaths?: string[],
) {
  const resolvedExtraReadPaths = (extraReadPaths ?? []).map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  });
  const resolvedExtraProjectPaths = (extraProjectPaths ?? []).map((p) => {
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

              // 1. Positive allowlist gate — reject unknown commands before any secondary check
              const baseCommand = getBashBaseCommand(command);
              if (!baseCommand) {
                return deny("Bash command is empty or whitespace only");
              }
              if (!DEFAULT_BASH_COMMAND_ALLOWLIST.has(baseCommand)) {
                return deny(
                  `Command '${baseCommand}' is not on the executor Bash allowlist. ` +
                    `Only inspection, build, and test commands are permitted.`,
                );
              }

              // 2. Negative gate — block dangerous patterns within whitelisted commands
              if (dangerousBash.test(command)) {
                return deny(
                  "Executor Bash may run inspection/tests only; host handles file mutation and git operations",
                );
              }

              // 3. Path traversal gate — block fs boundary escapes.
              //    Strip the base command token before checking so that
              //    path-qualified commands (/usr/bin/ls) are not flagged as
              //    sensitive-path access — only their arguments are checked.
              const cmdPrefix = command.match(/^\S+/)?.[0] ?? "";
              const restCommand = cmdPrefix ? command.slice(cmdPrefix.length) : command;
              if (hasBashPathTraversal(restCommand, cwd, resolvedExtraProjectPaths)) {
                return deny("Path traversal detected in Bash command — filesystem boundary enforced");
              }

              return allow();
            }

            const path = input.tool_input?.file_path ?? input.tool_input?.path;
            if (!path) return deny("Missing file path in tool input");
            if (!isPathWithinWorktree(path, cwd)) {
              const allExtraPaths = [...resolvedExtraReadPaths, ...resolvedExtraProjectPaths];
              if (allExtraPaths.length > 0) {
                const absPath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
                const withinExtra = allExtraPaths.some(
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
