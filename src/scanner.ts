import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, extname, basename } from "path";
import type { GitCommit, ProjectScan } from "./types.ts";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  "venv",
  "__pycache__",
  "coverage",
  ".p7",
  ".dev-agent",
  ".turbo",
  ".cache",
]);

const MANIFEST_MAP: Record<string, { langs: string[]; pm?: string; fw?: string }> = {
  "package.json": { langs: ["typescript", "javascript"], pm: "npm" },
  "bun.lockb": { langs: ["typescript", "javascript"], pm: "bun" },
  "pnpm-lock.yaml": { langs: ["typescript", "javascript"], pm: "pnpm" },
  "requirements.txt": { langs: ["python"], pm: "pip" },
  "pyproject.toml": { langs: ["python"], pm: "pip" },
  "go.mod": { langs: ["go"], pm: "go" },
  "Cargo.toml": { langs: ["rust"], pm: "cargo" },
  "pom.xml": { langs: ["java"], pm: "maven" },
  "build.gradle": { langs: ["kotlin", "java"], pm: "gradle" },
};

function runGit(projectPath: string, args: string[]): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", projectPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    return new TextDecoder().decode(proc.stdout).trim();
  } catch {
    return null;
  }
}

function walkFiles(
  dir: string,
  root: string,
  acc: { path: string; ext: string }[],
): void {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walkFiles(full, root, acc);
      else if (st.isFile()) acc.push({ path: full, ext: extname(name).toLowerCase() || "(none)" });
    } catch {
      /* skip unreadable */
    }
  }
}

function scanTodos(projectPath: string): ProjectScan["todos"] {
  const proc = Bun.spawnSync(
    [
      "grep",
      "-rn",
      "-E",
      "(TODO|FIXME|HACK|XXX)",
      "--include=*.ts",
      "--include=*.tsx",
      "--include=*.js",
      "--include=*.jsx",
      "--include=*.py",
      "--include=*.go",
      "--include=*.rs",
      "--include=*.md",
      projectPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) return [];
  const lines = new TextDecoder().decode(proc.stdout).split("\n").filter(Boolean);
  const todos: ProjectScan["todos"] = [];
  for (const line of lines.slice(0, 200)) {
    const m = line.match(/^([^:]+):(\d+):.*\b(TODO|FIXME|HACK|XXX)\b:?\s*(.*)$/i);
    if (!m) continue;
    const rel = m[1].replace(projectPath, "").replace(/^\//, "");
    todos.push({
      file: rel,
      line: Number(m[2]),
      kind: m[3].toUpperCase() as "TODO" | "FIXME" | "HACK" | "XXX",
      text: m[4].trim().slice(0, 200),
    });
  }
  return todos;
}

export async function scanProject(projectPath: string): Promise<ProjectScan> {
  const resolved = join(projectPath);
  const manifests: string[] = [];
  const languages = new Set<string>();
  const packageManagers = new Set<string>();
  const frameworks = new Set<string>();

  for (const [file, meta] of Object.entries(MANIFEST_MAP)) {
    if (existsSync(join(resolved, file))) {
      manifests.push(file);
      meta.langs.forEach((l) => languages.add(l));
      if (meta.pm) packageManagers.add(meta.pm);
      if (meta.fw) frameworks.add(meta.fw);
    }
  }

  if (existsSync(join(resolved, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(resolved, "package.json"), "utf-8"));
      if (pkg.dependencies?.next || pkg.devDependencies?.next) frameworks.add("next");
      if (pkg.dependencies?.react) frameworks.add("react");
      if (pkg.dependencies?.vue) frameworks.add("vue");
      if (pkg.dependencies?.hono) frameworks.add("hono");
    } catch {
      /* ignore */
    }
  }

  const files: { path: string; ext: string }[] = [];
  walkFiles(resolved, resolved, files);
  const byExtension: Record<string, number> = {};
  for (const f of files) byExtension[f.ext] = (byExtension[f.ext] ?? 0) + 1;

  const topLevelEntries = readdirSync(resolved).filter((n) => !n.startsWith("."));

  let git: ProjectScan["git"] = null;
  if (runGit(resolved, ["rev-parse", "--is-inside-work-tree"]) === "true") {
    const branch = runGit(resolved, ["branch", "--show-current"]) ?? "HEAD";
    const remoteUrl = runGit(resolved, ["remote", "get-url", "origin"]);
    const logRaw = runGit(resolved, ["log", "-15", "--format=%H|%aI|%s"]);
    const recentCommits: GitCommit[] = [];
    if (logRaw) {
      for (const line of logRaw.split("\n")) {
        const [hash, date, ...rest] = line.split("|");
        recentCommits.push({ hash: hash.slice(0, 7), date, subject: rest.join("|") });
      }
    }
    const status = runGit(resolved, ["status", "--porcelain"]);
    git = {
      branch,
      remoteUrl,
      recentCommits,
      uncommittedChanges: status ? status.split("\n").filter(Boolean).length : 0,
    };
  }

  let readme: string | null = null;
  const readmePath = join(resolved, "README.md");
  if (existsSync(readmePath)) {
    readme = readFileSync(readmePath, "utf-8").slice(0, 500);
  }

  return {
    path: resolved,
    scannedAt: new Date().toISOString(),
    techStack: {
      languages: [...languages],
      packageManagers: [...packageManagers],
      frameworks: [...frameworks],
      manifests,
    },
    git,
    todos: scanTodos(resolved),
    fileSummary: {
      totalFiles: files.length,
      byExtension,
      topLevelEntries,
    },
    readme,
  };
}
