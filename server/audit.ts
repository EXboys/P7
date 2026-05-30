import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { resolveP7HomeDir } from "../src/p7-paths.ts";

export function audit(event: string, detail?: Record<string, unknown>): void {
  const dir = resolveP7HomeDir();
  const LOG_PATH = join(dir, "server.log");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...detail,
  });
  appendFileSync(LOG_PATH, line + "\n");
}
