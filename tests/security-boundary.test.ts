import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildPreToolHook } from "../src/executor.ts";
import { validateApiDomain } from "../src/sdk.ts";

// ── Helper: create a temp worktree root path resolved through realpathSync ──
// macOS /tmp is a symlink → /private/tmp; isPathWithinWorktree calls realpathSync
// internally, so we must provide a root that matches the real (resolved) path.
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
) {
  const hook = buildPreToolHook(new Set(allowedFiles), cwd, onDeny);
  return hook.PreToolUse[0].hooks[0];
}

// ──────────────────────────────────────────────
// 1. Filesystem whitelist — Read / Write / Edit / Bash
// ──────────────────────────────────────────────
describe("buildPreToolHook — filesystem whitelist", () => {
  test("Read: allows files inside worktree", async () => {
    const root = tempRoot("wt-read-allow");
    try {
      writeFileSync(join(root, "readme.md"), "# test");
      const h = buildHandler([], root);
      const r = await h({ tool_name: "Read", tool_input: { file_path: "readme.md" } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Read: denies files outside worktree via ../ traversal", async () => {
    const root = tempRoot("wt-read-deny");
    const outsideRaw = join(tmpdir(), `p7-outside-${Date.now()}`);
    mkdirSync(outsideRaw, { recursive: true });
    writeFileSync(join(outsideRaw, "secret.txt"), "data");
    const outsideName = outsideRaw.split("/").pop()!;
    try {
      const h = buildHandler([], root);
      const r = await h({
        tool_name: "Read",
        tool_input: { file_path: `../${outsideName}/secret.txt` },
      });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/outside worktree/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outsideRaw, { recursive: true, force: true });
    }
  });

  test("Write: allows files listed in plan", async () => {
    const root = tempRoot("wt-write-allow");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const h = buildHandler(["src/newfile.ts"], root);
      const r = await h({ tool_name: "Write", tool_input: { file_path: "src/newfile.ts" } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Write: denies files not in plan", async () => {
    const root = tempRoot("wt-write-deny");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const h = buildHandler(["src/allowed.ts"], root);
      const r = await h({ tool_name: "Write", tool_input: { file_path: "src/rogue.ts" } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/not in plan/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Write: denies files outside worktree boundary", async () => {
    const root = tempRoot("wt-write-boundary");
    try {
      const h = buildHandler(["../outside.ts"], root);
      const r = await h({ tool_name: "Write", tool_input: { file_path: "../outside.ts" } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/outside worktree/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Edit: allows files listed in plan", async () => {
    const root = tempRoot("wt-edit-allow");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "existing.ts"), "// existing");
      const h = buildHandler(["src/existing.ts"], root);
      const r = await h({ tool_name: "Edit", tool_input: { file_path: "src/existing.ts" } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Edit: denies files not in plan", async () => {
    const root = tempRoot("wt-edit-deny");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "existing.ts"), "// existing");
      const h = buildHandler(["src/allowed.ts"], root);
      const r = await h({ tool_name: "Edit", tool_input: { file_path: "src/existing.ts" } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/not in plan/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: allows safe commands", async () => {
    const root = tempRoot("wt-bash-safe");
    try {
      const h = buildHandler([], root);
      const r = await h({ tool_name: "Bash", tool_input: { command: "ls -la" } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: denies dangerous git write operations", async () => {
    const root = tempRoot("wt-bash-git");
    try {
      const h = buildHandler([], root);
      const r = await h({ tool_name: "Bash", tool_input: { command: "git add ." } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/executor bash may run/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: denies rm -rf", async () => {
    const root = tempRoot("wt-bash-rm");
    try {
      const h = buildHandler([], root);
      const r = await h({ tool_name: "Bash", tool_input: { command: "rm -rf node_modules" } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: denies ../ path traversal", async () => {
    const root = tempRoot("wt-bash-pt");
    try {
      const h = buildHandler([], root);
      const r = await h({ tool_name: "Bash", tool_input: { command: "cat ../secret.txt" } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/path traversal/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: denies home directory access", async () => {
    const root = tempRoot("wt-bash-home");
    try {
      const h = buildHandler([], root);
      const r = await h({ tool_name: "Bash", tool_input: { command: "ls ~/.ssh" } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/path traversal/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bash: denies access to sensitive system paths", async () => {
    const root = tempRoot("wt-bash-etc");
    try {
      const h = buildHandler([], root);
      const r = await h({ tool_name: "Bash", tool_input: { command: "cat /etc/passwd" } });
      expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/path traversal/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────
// 2. Network exfiltration prevention — validateApiDomain
// ──────────────────────────────────────────────
describe("validateApiDomain", () => {
  test("allows default domain when ANTHROPIC_BASE_URL is unset", () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      expect(() => validateApiDomain()).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prev;
    }
  });

  test("allows configured allowed domain (api.anthropic.com)", () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    try {
      expect(() => validateApiDomain()).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prev;
    }
  });

  test("allows ANTHROPIC_BASE_URL hostname even if absent from config whitelist", () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
    try {
      expect(() => validateApiDomain()).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prev;
    }
  });

  test("throws for unparseable URL value", () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = ":::";
    try {
      expect(() => validateApiDomain()).toThrow(/invalid/i);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prev;
    }
  });
});

// ──────────────────────────────────────────────
// 3. onDeny callback integration
// ──────────────────────────────────────────────
describe("buildPreToolHook — onDeny callback", () => {
  test("calls onDeny with deny reason when tool is blocked", async () => {
    const root = tempRoot("onDeny-called");
    const reasons: string[] = [];
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const h = buildHandler(["src/allowed.ts"], root, (r) => reasons.push(r));
      await h({ tool_name: "Write", tool_input: { file_path: "src/rogue.ts" } });
      expect(reasons.length).toBe(1);
      expect(reasons[0]).toMatch(/not in plan/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not call onDeny when tool is allowed", async () => {
    const root = tempRoot("onDeny-silent");
    const reasons: string[] = [];
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const h = buildHandler(["src/ok.ts"], root, (r) => reasons.push(r));
      await h({ tool_name: "Write", tool_input: { file_path: "src/ok.ts" } });
      expect(reasons.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("onDeny reason includes tool name prefix", async () => {
    const root = tempRoot("onDeny-prefix");
    const reasons: string[] = [];
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const h = buildHandler(["src/ok.ts"], root, (r) => reasons.push(r));
      await h({ tool_name: "Edit", tool_input: { file_path: "src/rogue.ts" } });
      expect(reasons.length).toBe(1);
      expect(reasons[0]).toMatch(/^Edit:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
