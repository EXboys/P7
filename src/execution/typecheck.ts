import { existsSync, readFileSync } from "fs";
import { join } from "path";

function commandExists(name: string): boolean {
  const proc = Bun.spawnSync(["sh", "-c", `command -v ${name}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0;
}

export interface TypecheckOutput {
  ok: boolean;
  out: string;
  totalErrors: number;
  perFileErrors: Record<string, number>;
}

const TSC_ERROR_RE = /^([^(]+)\(\d+,\s*\d+\):\s+error TS\d+:/gm;

export function parseTypecheckErrors(out: string): {
  perFileErrors: Record<string, number>;
  totalErrors: number;
} {
  const perFileErrors: Record<string, number> = {};
  let match: RegExpExecArray | null;
  TSC_ERROR_RE.lastIndex = 0;
  while ((match = TSC_ERROR_RE.exec(out)) !== null) {
    const filePath = match[1];
    perFileErrors[filePath] = (perFileErrors[filePath] ?? 0) + 1;
  }
  const totalErrors = Object.values(perFileErrors).reduce((sum, c) => sum + c, 0);
  return { perFileErrors, totalErrors };
}

export async function runTypecheck(wtPath: string): Promise<TypecheckOutput> {
  if (existsSync(join(wtPath, "package.json"))) {
    const pkg = JSON.parse(readFileSync(join(wtPath, "package.json"), "utf-8"));
    if (pkg.scripts?.typecheck) {
      const runner = existsSync(join(wtPath, "bun.lockb")) && commandExists("bun")
        ? ["bun", "run", "typecheck"]
        : existsSync(join(wtPath, "pnpm-lock.yaml")) && commandExists("pnpm")
          ? ["pnpm", "run", "typecheck"]
          : ["npm", "run", "typecheck"];
      const proc = Bun.spawnSync(runner, { cwd: wtPath, stdout: "pipe", stderr: "pipe" });
      const out =
        new TextDecoder().decode(proc.stdout) +
        "\n" +
        new TextDecoder().decode(proc.stderr);
      const { perFileErrors, totalErrors } = parseTypecheckErrors(out);
      return { ok: proc.exitCode === 0, out, perFileErrors, totalErrors };
    }
  }
  const runner = commandExists("bunx") ? ["bunx", "tsc", "--noEmit"] : ["npx", "tsc", "--noEmit"];
  const proc = Bun.spawnSync(runner, { cwd: wtPath, stdout: "pipe", stderr: "pipe" });
  const out =
    new TextDecoder().decode(proc.stdout) +
    "\n" +
    new TextDecoder().decode(proc.stderr);
  const { perFileErrors, totalErrors } = parseTypecheckErrors(out);
  return { ok: proc.exitCode === 0, out, perFileErrors, totalErrors };
}
