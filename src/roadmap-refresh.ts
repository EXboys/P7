import { existsSync, readFileSync, writeFileSync } from "fs";
import { backupRoadmap, loadRoadmap, roadmapPath } from "./roadmap.ts";
import { readPrompt, runSdkQuery } from "./sdk.ts";
import { formatDiscoveryForPrompt, loadSnapshot } from "./tech-discovery.ts";
import type { DevAgentConfig } from "./config.ts";
import type { ProjectScan } from "./types.ts";

function withUserInstructions(prompt: string, userInstructions?: string): string {
  const extra = userInstructions?.trim();
  if (!extra) return prompt;
  return `${prompt}\n\n## 用户补充要求（优先遵守）\n${extra}`;
}

export async function refreshRoadmap(
  projectPath: string,
  scan: ProjectScan,
  cfg: DevAgentConfig,
  userInstructions?: string,
): Promise<boolean> {
  const path = roadmapPath(projectPath);
  const oldContent = existsSync(path) ? readFileSync(path, "utf-8") : "";

  backupRoadmap(projectPath);

  const rm = loadRoadmap(projectPath);
  const prompt = withUserInstructions(`根据北极星目标与项目现状，生成新的 ROADMAP.md。

北极星：${cfg.initial_goal}

已完成 Active 步骤：${rm?.active.filter((s) => s.done).map((s) => s.text).join("; ") || "无"}

格式要求：
# Roadmap
## Active
Feature: <名称> (started ${new Date().toISOString().slice(0, 10)})
- [ ] 步骤1
## Backlog
- 条目
## Done
- 已完成特性

只输出 Markdown，不要 JSON。`, userInstructions);

  const { text } = await runSdkQuery({
    prompt,
    cwd: projectPath,
    systemPrompt: readPrompt("roadmap-refresh-radar.md"),
    role: "planner",
    allowedTools: ["Read", "Glob", "Grep"],
  });

  const md = text.includes("# Roadmap") ? text.slice(text.indexOf("# Roadmap")) : text;
  if (md.trim() === oldContent.trim()) return false;

  writeFileSync(path, md.trim() + "\n");
  return true;
}

export async function refreshRoadmapFromRadar(
  projectPath: string,
  scan: ProjectScan,
  cfg: DevAgentConfig,
  themes: string[],
  userInstructions?: string,
): Promise<boolean> {
  const path = roadmapPath(projectPath);
  const oldContent = existsSync(path) ? readFileSync(path, "utf-8") : "";
  backupRoadmap(projectPath);

  const rm = loadRoadmap(projectPath);
  const radar = formatDiscoveryForPrompt(loadSnapshot(projectPath));
  const prompt = withUserInstructions(`根据北极星、项目现状与今日技术雷达，生成新的 ROADMAP.md。

北极星：${cfg.initial_goal}

今日雷达主题：${themes.join("、")}

技术雷达：
${radar}

近期提交：${scan.git?.recentCommits.slice(0, 5).map((c) => c.subject).join("; ") ?? "无"}

已完成 Active 步骤：${rm?.active.filter((s) => s.done).map((s) => s.text).join("; ") || "无"}

格式要求：
# Roadmap
## Active
Feature: <名称> (started ${new Date().toISOString().slice(0, 10)})
- [ ] 步骤1
## Backlog
- 条目
## Done
- 已完成特性

只输出 Markdown，不要 JSON。`, userInstructions);

  const { text } = await runSdkQuery({
    prompt,
    cwd: projectPath,
    systemPrompt: readPrompt("roadmap-refresh-radar.md"),
    role: "planner",
    allowedTools: ["Read", "Glob", "Grep"],
  });

  const md = text.includes("# Roadmap") ? text.slice(text.indexOf("# Roadmap")) : text;
  if (md.trim() === oldContent.trim()) return false;

  writeFileSync(path, md.trim() + "\n");
  return true;
}

/** 控制台：可选用户说明 + 是否纳入今日雷达 */
export async function refreshRoadmapForDashboard(
  projectPath: string,
  scan: ProjectScan,
  cfg: DevAgentConfig,
  opts: { userInstructions?: string; useRadar?: boolean },
): Promise<boolean> {
  const snap = loadSnapshot(projectPath);
  const useRadar = opts.useRadar !== false && Boolean(snap?.themes.length);
  if (useRadar && snap) {
    return refreshRoadmapFromRadar(
      projectPath,
      scan,
      cfg,
      snap.themes,
      opts.userInstructions,
    );
  }
  return refreshRoadmap(projectPath, scan, cfg, opts.userInstructions);
}
