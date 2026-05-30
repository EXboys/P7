import { writeFileSync, existsSync, readFileSync } from "fs";
import { backupRoadmap, roadmapPath } from "./roadmap.ts";
import type { TechSignal } from "./types.ts";

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 3)}...`;
}

function usableSignals(signals: TechSignal[]): TechSignal[] {
  return signals.filter(
    (s) =>
      s.title.length >= 15 &&
      !/unavailable|failed:/i.test(s.title) &&
      s.url.length > 0,
  );
}

function stepFromSignal(s: TechSignal): string {
  const src = s.source === "hn" ? "HN" : "GitHub";
  return `- [ ] 对照北极星评估热点「${truncate(s.title, 96)}」是否值得在本仓库落地（${src}）`;
}

/** 无 LLM 时：用热点**标题**写 Roadmap，不用词频垃圾主题 */
export function writeFallbackRoadmap(
  projectPath: string,
  opts: {
    signals: TechSignal[];
    northStar: string;
    themes?: string[];
  },
): boolean {
  const picked = usableSignals(opts.signals)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 8);
  if (picked.length === 0) return false;

  const path = roadmapPath(projectPath);
  const today = new Date().toISOString().slice(0, 10);
  const top = picked[0];
  const featureTitle = truncate(top.title, 72);
  const activeSteps = picked.slice(0, 4).map(stepFromSignal);
  const backlog = picked.slice(4, 7).map((s) => `- ${truncate(s.title, 90)}`);

  const md = `# Roadmap

## Active
Feature: ${featureTitle} (started ${today})
> 北极星对齐：${truncate(opts.northStar, 120)}
> 说明：本 Roadmap 由今日技术雷达**热点标题**自动生成（未调用 LLM）。配置 ANTHROPIC_AUTH_TOKEN 后可生成中文可执行步骤。

${activeSteps.join("\n")}

## Backlog
${backlog.join("\n") || `- 继续消化今日雷达其余条目`}

## Done
- （由执行器在步骤完成后写入）

`;

  if (existsSync(path)) {
    const old = readFileSync(path, "utf-8");
    if (old.trim() === md.trim()) return false;
    backupRoadmap(projectPath);
  }
  writeFileSync(path, md);
  return true;
}
