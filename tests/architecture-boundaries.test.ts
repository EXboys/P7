import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("architecture boundaries", () => {
  test("src modules do not import server modules", () => {
    const offenders = listTsFiles(join(process.cwd(), "src")).filter((file) => {
      const source = readFileSync(file, "utf-8");
      return /from\s+["'][^"']*server\//.test(source) || /import\(["'][^"']*server\//.test(source);
    });
    expect(offenders.map((f) => f.replace(`${process.cwd()}/`, ""))).toEqual([]);
  });
});
