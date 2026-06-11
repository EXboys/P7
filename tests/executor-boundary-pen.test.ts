import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildPreToolHook } from "../src/executor.ts";

// ── Helper: create a temp worktree root path resolved through realpathSync ──
function tempRoot(label: string): string {
  const raw = join(tmpdir(), `p7-${label}-${Date.now()}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

// ── Helper: extract the inner PreToolUse hook handler from buildPreToolHook ──
function buildHandler(
  allowedFiles: string[],
  cwd: string,
  onDeny?: (reason: string) => void,
  extraReadPaths?: string[],
  extraProjectPaths?: string[],
) {
  const hook = buildPreToolHook(
    new Set(allowedFiles),
    cwd,
    onDeny,
    extraReadPaths,
    extraProjectPaths,
  );
  return hook.PreToolUse[0].hooks[0];
}

// ──────────────────────────────────────────────
// 1. Symlink-based path escape
//    isPathWithinWorktree resolves realpath on the
//    target path, so a symlink inside the worktree
//    that points outside SHOULD be denied.
// ──────────────────────────────────────────────
describe("executor boundary penetration — symlink escape", () => {
  test("Read: denies symlink inside worktree pointing outside boundary", async () => {
    const root = tempRoot("pen-symlink-read");
    const outside = tempRoot("pen-symlink-target");
    try {
      writeFileSync(join(outside, "secret.txt"), "exfiltrated data");
      symlinkSync(outside, join(root, "escaped-dir"));

      const h = buildHandler([], root);
      const r = await h({
        tool_name: "Read",
        tool_input: { file_path: "escaped-dir/secret.txt" },
      });
      // realpathSync resolves the symlink to the outside path,
      // which does not start with rootResolved → deny
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/outside worktree/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("Write: denies planned file through symlink pointer outside", async () => {
    const root = tempRoot("pen-symlink-write");
    const outside = tempRoot("pen-symlink-write-target");
    try {
      symlinkSync(outside, join(root, "escape"));

      const h = buildHandler(["escape/newfile.ts"], root);
      const r = await h({
        tool_name: "Write",
        tool_input: { file_path: "escape/newfile.ts" },
      });
      // Even though the symlink path is listed in the plan, the
      // worktree-boundary check runs first and catches the escape
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/outside worktree/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────
// 2. Backtick / shell command injection
//    Bash commands embedding backtick execution of
//    sensitive paths. The abs-path regex requires
//    whitespace before "/", so backtick-wrapped
//    paths at the start of a token can bypass.
// ──────────────────────────────────────────────
describe("executor boundary penetration — backtick command injection", () => {
  test("Bash: denies backtick-embedded cat /etc/passwd (space before /)", async () => {
    const root = tempRoot("pen-btick-caught");
    try {
      const h = buildHandler([], root);
      // "cat /etc/passwd" inside backticks — /etc/passwd has a
      // space before the /, so the abs-path regex matches it
      const r = await h({
        tool_name: "Bash",
        tool_input: { command: "echo `cat /etc/passwd`" },
      });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/path traversal/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: allows backtick-wrapped /etc/passwd at token start (known gap)", async () => {
    const root = tempRoot("pen-btick-bypass");
    try {
      const h = buildHandler([], root);
      // The abs-path regex (?:^|\s)(\/...) requires whitespace
      // or start-of-string before the /. When the path is
      // backtick-wrapped at a non-start position (e.g., inside
      // a pipeline), ` starts the token, not whitespace → no match.
      const r = await h({
        tool_name: "Bash",
        tool_input: { command: "echo ` /etc/passwd`" },
      });
      // There IS a space between ` and /etc — the regex catches it
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/path traversal/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: backtick-wrapped absolute path at string start bypasses abs-path regex", async () => {
    const root = tempRoot("pen-btick-start");
    try {
      const h = buildHandler([], root);
      // `` `/etc/passwd` `` — the / is immediately after the opening
      // backtick, with no whitespace before it. The regex requires
      // (?:\s|^) before the /, but ` is neither. No ../ or ~ either.
      // This is a KNOWN BYPASS of the current regex.
      const r = await h({
        tool_name: "Bash",
        tool_input: { command: "`/etc/passwd`" },
      });
      expect(r.hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────
// 3. Subshell path obfuscation ($(...))
//    The $() wrapper can obscure the absolute-path
//    boundary because the regex char class [^\s;"'|&$()`
//    excludes $, (, and ) — but the key question is
//    whether whitespace precedes the /.
// ──────────────────────────────────────────────
describe("executor boundary penetration — subshell path obfuscation", () => {
  test("Bash: denies $(cat /etc/passwd) — space before / from inner command", async () => {
    const root = tempRoot("pen-subsh-caught");
    try {
      const h = buildHandler([], root);
      // $(cat /etc/passwd) — "cat /etc/passwd" has a space before
      // /etc, so (?:\s|^) matches it
      const r = await h({
        tool_name: "Bash",
        tool_input: { command: "$(cat /etc/passwd)" },
      });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/path traversal/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: $(/etc/passwd) bypasses abs-path regex — no whitespace before /", async () => {
    const root = tempRoot("pen-subsh-bypass");
    try {
      const h = buildHandler([], root);
      // $(/etc/passwd) — the / is immediately after ( and $,
      // with no whitespace. The regex (?:\s|^)(\/...) needs
      // whitespace or start before the /, but neither matches.
      // $(...) chars are excluded from the character class.
      // This is a KNOWN BYPASS.
      const r = await h({
        tool_name: "Bash",
        tool_input: { command: "echo $(/etc/passwd)" },
      });
      expect(r.hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: $(</etc/passwd) — no space, bypasses abs-path regex", async () => {
    const root = tempRoot("pen-subsh-redirect");
    try {
      const h = buildHandler([], root);
      // $(<file) is a bash construct that reads file contents.
      // $(</etc/passwd) — /etc follows ( with no space → bypass.
      const r = await h({
        tool_name: "Bash",
        tool_input: { command: "$(</etc/passwd)" },
      });
      expect(r.hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────
// 4. Output redirect escape
//    Bash redirects (> / >>) that write outside the
//    worktree boundary via ../ traversal or /tmp.
// ──────────────────────────────────────────────
describe("executor boundary penetration — output redirect escape", () => {
  test("Bash: denies > ../outside.txt via ../ path traversal", async () => {
    const root = tempRoot("pen-redirect-dotdot");
    try {
      const h = buildHandler([], root);
      const r = await h({
        tool_name: "Bash",
        tool_input: { command: "echo data > ../outside.txt" },
      });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/path traversal/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: denies >> /tmp/escape.log via /tmp/ sensitive prefix", async () => {
    const root = tempRoot("pen-redirect-tmp");
    try {
      const h = buildHandler([], root);
      const r = await h({
        tool_name: "Bash",
        tool_input: { command: "echo data >> /tmp/escape.log" },
      });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/path traversal/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: denies >> /etc/cron.d/evil via /etc/ sensitive prefix", async () => {
    const root = tempRoot("pen-redirect-etc");
    try {
      const h = buildHandler([], root);
      const r = await h({
        tool_name: "Bash",
        tool_input: { command: "echo '* * * * * root id' >> /etc/cron.d/evil" },
      });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/path traversal/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: denies >> /var/log/exfil.log via /var/ sensitive prefix", async () => {
    const root = tempRoot("pen-redirect-var");
    try {
      const h = buildHandler([], root);
      const r = await h({
        tool_name: "Bash",
        tool_input: { command: "echo leaked >> /var/log/exfil.log" },
      });
      // /var/log/exfil.log starts with /var/ → sensitive prefix
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────
// 5. Whitelist normalization bypass
//    The plan-file whitelist compares against
//    normalizeAllowedPath output. Test ./ prefix,
//    case variance, trailing-slash, // duplicate,
//    and absolute-path equivalence.
// ──────────────────────────────────────────────
describe("executor boundary penetration — whitelist normalization bypass", () => {
  test("Write: allows ./src/file.ts when plan lists src/file.ts (./ stripped)", async () => {
    const root = tempRoot("pen-wl-dotprefix");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const h = buildHandler(["src/file.ts"], root);
      const r = await h({
        tool_name: "Write",
        tool_input: { file_path: "./src/file.ts" },
      });
      // normalizeAllowedPath strips ./ → "src/file.ts" matches plan
      expect(r.hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Write: denies src//file.ts when plan lists src/file.ts (// not normalized)", async () => {
    const root = tempRoot("pen-wl-doubleslash");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const h = buildHandler(["src/file.ts"], root);
      const r = await h({
        tool_name: "Write",
        tool_input: { file_path: "src//file.ts" },
      });
      // normalizeAllowedPath does not collapse //, so string comparison fails
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/not in plan/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Write: denies trailing-slash path when plan lists src/file.ts", async () => {
    const root = tempRoot("pen-wl-trailing");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const h = buildHandler(["src/file.ts"], root);
      const r = await h({
        tool_name: "Write",
        tool_input: { file_path: "src/file.ts/" },
      });
      // normalizeAllowedPath does not strip trailing / → mismatch
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Write: denies case-variant SRC/File.ts when plan lists src/file.ts", async () => {
    const root = tempRoot("pen-wl-case");
    try {
      // Create both the plan-expected directory and the case-variant
      // to ensure isPathWithinWorktree passes before whitelist check
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "SRC"), { recursive: true });
      const h = buildHandler(["src/file.ts"], root);
      const r = await h({
        tool_name: "Write",
        tool_input: { file_path: "SRC/file.ts" },
      });
      // normalizeAllowedPath doesn't lowercase, so string comparison
      // "SRC/file.ts" !== "src/file.ts" → deny
      // NOTE: On macOS APFS (case-insensitive), isPathWithinWorktree
      // will still pass because the filesystem resolves SRC/file.ts
      // under the worktree root — the whitelist check is what fails.
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Write: allows absolute path /root/src/file.ts when plan lists src/file.ts", async () => {
    const root = tempRoot("pen-wl-abs");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const absPath = join(root, "src", "file.ts");
      const h = buildHandler(["src/file.ts"], root);
      const r = await h({
        tool_name: "Write",
        tool_input: { file_path: absPath },
      });
      // normalizeAllowedPath converts to relative: "src/file.ts" → matches
      expect(r.hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
