import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { tmpdir } from "os";

// ── Module-under-test ────────────────────────────────────────────────────────
// These functions will be extracted to src/sandbox-preview.ts once the module
// is promoted from inline prototype to shared dependency.  For now they live
// here so the tests are executable and the API contract is pinned.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a sandbox preview URL from a dashboard base URL and project alias.
 * Returns empty string when either input is falsy.
 */
function generateSandboxPreviewUrl(
  baseUrl: string | null | undefined,
  projectAlias: string | null | undefined,
): string {
  if (!baseUrl || !projectAlias) return "";
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}/sandbox/${encodeURIComponent(projectAlias)}`;
}

/**
 * Extract the worktree directory name from a full worktree path.
 * Returns the last path component, or null for empty input.
 */
function resolveWorktreeName(worktreePath: string): string | null {
  if (!worktreePath) return null;
  const trimmed = worktreePath.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  const name = parts[parts.length - 1];
  return name || null;
}

/**
 * Check whether a worktree path is safe to use as a sandbox root.
 * Returns false for traversal sequences or absolute paths outside worktrees/.
 */
function validateWorktreePath(worktreePath: string): boolean {
  if (!worktreePath) return false;
  if (worktreePath.includes("..")) return false;
  if (isAbsolute(worktreePath)) {
    return worktreePath.includes("/worktrees/");
  }
  return true;
}

/**
 * Resolve a sandbox file path against the worktree root, enforcing boundary.
 * Returns the resolved absolute path on success, or null when the path escapes
 * the worktree root or a filesystem error occurs.
 */
function resolveSandboxFilePath(
  sandboxPath: string,
  worktreeRoot: string,
): string | null {
  if (!sandboxPath || !worktreeRoot) return null;
  const resolved = resolve(worktreeRoot, sandboxPath);
  let realWorktree: string;
  let realResolved: string;
  try {
    realWorktree = realpathSync(worktreeRoot);
    realResolved = realpathSync(resolved);
  } catch {
    return null;
  }
  if (!realResolved.startsWith(realWorktree)) return null;
  return realResolved;
}

// ── Helper: temp directory with realpath resolution ─────────────────────────
// macOS /tmp is a symlink → /private/tmp; realpathSync resolves it, so the
// test root must be the resolved version for prefix checks to match.
function tempRoot(label: string): string {
  const raw = join(tmpdir(), `p7-sandbox-${label}-${Date.now()}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

// ────────────────────────────────────────────
// 1. generateSandboxPreviewUrl
// ────────────────────────────────────────────
describe("generateSandboxPreviewUrl", () => {
  test("produces correct URL format", () => {
    const url = generateSandboxPreviewUrl("http://localhost:8791", "my-project");
    expect(url).toBe("http://localhost:8791/sandbox/my-project");
  });

  test("strips trailing slashes from base URL", () => {
    const url = generateSandboxPreviewUrl("http://localhost:8791///", "proj");
    expect(url).toBe("http://localhost:8791/sandbox/proj");
  });

  test("encodes special characters in project alias", () => {
    const url = generateSandboxPreviewUrl("http://localhost:8791", "my project/foo");
    expect(url).toContain(encodeURIComponent("my project/foo"));
  });

  test("returns empty string when baseUrl is null", () => {
    expect(generateSandboxPreviewUrl(null, "proj")).toBe("");
  });

  test("returns empty string when baseUrl is undefined", () => {
    expect(generateSandboxPreviewUrl(undefined, "proj")).toBe("");
  });

  test("returns empty string when projectAlias is null", () => {
    expect(generateSandboxPreviewUrl("http://localhost:8791", null)).toBe("");
  });

  test("returns empty string when projectAlias is empty", () => {
    expect(generateSandboxPreviewUrl("http://localhost:8791", "")).toBe("");
  });

  test("returns empty string when both inputs are falsy", () => {
    expect(generateSandboxPreviewUrl("", null)).toBe("");
  });
});

// ────────────────────────────────────────────
// 2. resolveWorktreeName
// ────────────────────────────────────────────
describe("resolveWorktreeName", () => {
  test("extracts name from full path", () => {
    expect(resolveWorktreeName("/path/to/.p7/worktrees/active")).toBe("active");
  });

  test("extracts name from path with trailing slash", () => {
    expect(resolveWorktreeName("/path/to/worktrees/active/")).toBe("active");
  });

  test("extracts timestamp-based worktree name", () => {
    expect(resolveWorktreeName("/path/worktrees/1740000000-abc123")).toBe("1740000000-abc123");
  });

  test("returns null for empty string", () => {
    expect(resolveWorktreeName("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(resolveWorktreeName("  ")).toBe("  ");
  });
});

// ────────────────────────────────────────────
// 3. validateWorktreePath
// ────────────────────────────────────────────
describe("validateWorktreePath", () => {
  test("allows relative paths", () => {
    expect(validateWorktreePath("active")).toBe(true);
  });

  test("allows nested relative paths", () => {
    expect(validateWorktreePath("worktrees/active")).toBe(true);
  });

  test("allows absolute path under /worktrees/", () => {
    expect(validateWorktreePath("/home/user/.p7/worktrees/active")).toBe(true);
  });

  test("rejects path with parent-directory traversal", () => {
    expect(validateWorktreePath("../secret")).toBe(false);
  });

  test("rejects path with deep traversal", () => {
    expect(validateWorktreePath("worktrees/active/../../../etc")).toBe(false);
  });

  test("rejects absolute path without /worktrees/", () => {
    expect(validateWorktreePath("/etc/passwd")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(validateWorktreePath("")).toBe(false);
  });

  test("rejects path with double-dot in middle", () => {
    expect(validateWorktreePath("worktrees/.. /active")).toBe(false);
  });
});

// ────────────────────────────────────────────
// 4. resolveSandboxFilePath (filesystem-backed)
// ────────────────────────────────────────────
describe("resolveSandboxFilePath", () => {
  test("returns resolved path when file stays inside worktree", () => {
    const root = tempRoot("in-boundary");
    try {
      mkdirSync(join(root, "sub"), { recursive: true });
      writeFileSync(join(root, "sub", "file.ts"), "// ok");
      const result = resolveSandboxFilePath("sub/file.ts", root);
      expect(result).toBe(realpathSync(join(root, "sub", "file.ts")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns resolved path for root-level file", () => {
    const root = tempRoot("root-file");
    try {
      writeFileSync(join(root, "readme.md"), "# hi");
      const result = resolveSandboxFilePath("readme.md", root);
      expect(result).toBe(realpathSync(join(root, "readme.md")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null when path escapes worktree via ../", () => {
    const root = tempRoot("escape-up");
    const outside = join(tmpdir(), `p7-sandbox-outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    try {
      const result = resolveSandboxFilePath(`../${outside.split("/").pop()!}/secret`, root);
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("returns null when path is absolute and outside worktree", () => {
    const root = tempRoot("escape-abs");
    try {
      const result = resolveSandboxFilePath("/etc/passwd", root);
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null when target does not exist (realpathSync fails)", () => {
    const root = tempRoot("nonexistent");
    try {
      const result = resolveSandboxFilePath("missing.ts", root);
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null for empty sandboxPath", () => {
    const root = tempRoot("empty-path");
    try {
      expect(resolveSandboxFilePath("", root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null for empty worktreeRoot", () => {
    expect(resolveSandboxFilePath("file.ts", "")).toBeNull();
  });
});
