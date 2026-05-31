import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Plan } from "./types.ts";

/** 第 2 轮重试前为 Plan 中尚不存在的文件创建占位，便于 Agent 用 Edit 填充。 */
export function scaffoldMissingPlanFiles(worktreePath: string, plan: Plan): string[] {
  const created: string[] = [];
  for (const change of plan.changes) {
    const full = join(worktreePath, change.file);
    if (existsSync(full)) continue;
    mkdirSync(dirname(full), { recursive: true });
    const stub = [
      `/** Scaffold for plan: ${plan.title} */`,
      `/** ${change.description.slice(0, 200)} */`,
      "export {};",
      "",
    ].join("\n");
    writeFileSync(full, stub, "utf-8");
    created.push(change.file);
  }
  return created;
}
