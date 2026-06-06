import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { effectiveNoImplicitAnyDefault } from "../../src/derived-config.ts";

export function tsconfigNoImplicitAnyDefault(projectPath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(projectPath, "tsconfig.json"), "utf-8")) as {
      compilerOptions?: { strict?: boolean; noImplicitAny?: boolean };
    };
    const opts = raw.compilerOptions ?? {};
    return effectiveNoImplicitAnyDefault(opts);
  } catch {
    return false;
  }
}

/** Recursively collect project source files for dashboard metrics. */
export function collectProjectFiles(dir: string, depth = 0): string[] {
  if (depth > 12 || !existsSync(dir)) return [];
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectProjectFiles(fullPath, depth + 1));
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        files.push(fullPath);
      }
    }
  } catch {
    /* permission denied or transient error — skip silently */
  }
  return files;
}
