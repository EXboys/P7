import { existsSync, readFileSync, writeFileSync } from "fs";
import {
  isRoadmapExhausted,
  latestRoadmapBackupPath,
  loadRoadmap,
  parseRoadmap,
  recommendRoadmapGoal,
  roadmapPath,
  backupRoadmap,
} from "./roadmap.ts";
import {
  getApprovalRecord,
  processAutoApprovals,
  savePendingApproval,
} from "./approval.ts";
import { generatePlan } from "./planner.ts";
import { readPrompt, runSdkQuery } from "./sdk.ts";
import {
  deriveThemesFromSignals,
  formatDiscoveryForPrompt,
  loadSnapshot,
} from "./tech-discovery.ts";
import { appendLesson } from "./agent-memory.ts";
import { writeFallbackRoadmap } from "./roadmap-template.ts";
import { hasLlmAuth } from "./llm-env.ts";
import { scanProject } from "./scanner.ts";
import type { DevAgentConfig } from "./config.ts";
import type { ProjectScan } from "./types.ts";

export type RoadmapRefreshResult = {
  exhausted: boolean;
  refreshed: boolean;
  backupPath?: string;
  planId?: string;
  goal?: string;
};

/** 从 LLM 输出中提取可解析的 ROADMAP.md；拒绝摘要/无 Active 步骤的无效内容 */
export function extractValidRoadmapMarkdown(
  text: string,
  opts: { requireUncheckedActive?: boolean } = {},
): string | null {
  if (!text.includes("# Roadmap")) return null;
  const md = text.slice(text.indexOf("# Roadmap"));
  if (!/^##\s+Active/im.test(md)) return null;
  const parsed = parseRoadmap(md);
  if (parsed.active.length === 0) return null;
  if (opts.requireUncheckedActive && parsed.active.every((s) => s.done)) return null;
  return md.trim();
}

/** LLM 无效时：将 Backlog 前 2 条升为新 Active Feature（每条约 3 个拆分步骤） */
export function refreshRoadmapFromBacklog(projectPath: string): boolean {
  const rm = loadRoadmap(projectPath);
  if (!rm || rm.backlog.length === 0) return false;

  const path = roadmapPath(projectPath);
  const oldContent = existsSync(path) ? readFileSync(path, "utf-8") : "";
  backupRoadmap(projectPath);

  const today = new Date().toISOString().slice(0, 10);
  const promote = rm.backlog.slice(0, 2);
  const newBacklog = rm.backlog.slice(2);

  const featureTitle = (item: string) =>
    item.split("——")[0]?.split("—")[0]?.trim().slice(0, 72) || item.slice(0, 72);

  const stepLines = (item: string): string[] => {
    const title = featureTitle(item);
    return [
      `- [ ] 梳理「${title}」现状与仓库落点，列出需改动的文件与接口`,
      `- [ ] 实现「${title}」核心逻辑并通过 typecheck`,
      `- [ ] 补充测试或文档，并在 ROADMAP 勾选本 Feature 首步`,
    ];
  };

  const activeBlocks = promote
    .map((item) => {
      const lines = stepLines(item);
      return `Feature: ${featureTitle(item)} (started ${today})\n${lines.join("\n")}`;
    })
    .join("\n\n");

  const doneFromActive = rm.active
    .filter((s) => s.done)
    .map((s) => `- ${s.feature}：${s.text}`)
    .slice(-8);
  const doneItems = [...rm.done.map((d) => `- ${d}`), ...doneFromActive].join("\n");
  const backlogItems = newBacklog.map((b) => `- ${b}`).join("\n") || "- （待定）";

  const md = `# Roadmap
## Active
${activeBlocks}

## Backlog
${backlogItems}

## Done
${doneItems}
`;

  if (md.trim() === oldContent.trim()) return false;
  writeFileSync(path, md.trim() + "\n");
  return true;
}

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
  writeOpts?: { requireUncheckedActive?: boolean },
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

只输出 Markdown，从 # Roadmap 开始，不要 JSON，不要写变更摘要。`, userInstructions);

  const { text } = await runSdkQuery({
    prompt,
    cwd: projectPath,
    systemPrompt: readPrompt("roadmap-refresh-radar.md"),
    role: "planner",
    allowedTools: ["Read", "Glob", "Grep"],
  });

  const md = extractValidRoadmapMarkdown(text, writeOpts);
  if (!md || md.trim() === oldContent.trim()) return false;

  writeFileSync(path, md + "\n");
  return true;
}

export async function refreshRoadmapFromRadar(
  projectPath: string,
  scan: ProjectScan,
  cfg: DevAgentConfig,
  themes: string[],
  userInstructions?: string,
  writeOpts?: { requireUncheckedActive?: boolean },
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

只输出 Markdown，从 # Roadmap 开始，不要 JSON，不要写变更摘要。`, userInstructions);

  const { text } = await runSdkQuery({
    prompt,
    cwd: projectPath,
    systemPrompt: readPrompt("roadmap-refresh-radar.md"),
    role: "planner",
    allowedTools: ["Read", "Glob", "Grep"],
  });

  const md = extractValidRoadmapMarkdown(text, writeOpts);
  if (!md || md.trim() === oldContent.trim()) return false;

  writeFileSync(path, md + "\n");
  return true;
}

async function autoPlanAfterRefresh(
  projectPath: string,
  cfg: DevAgentConfig,
  themes: string[],
): Promise<{ planId?: string; goal?: string }> {
  if (!cfg.discovery.auto_plan_after_refresh) return {};
  const goal = recommendRoadmapGoal(projectPath) ?? themes[0] ?? cfg.initial_goal;
  const scan = await scanProject(projectPath);
  const planRecord = await generatePlan(projectPath, scan, goal);
  if (!getApprovalRecord(projectPath, planRecord.planId)) {
    savePendingApproval(projectPath, planRecord);
  }
  processAutoApprovals(projectPath, cfg, { planIds: [planRecord.planId] });
  return { planId: planRecord.planId, goal };
}

/**
 * Active 步骤全部完成后：备份当前 ROADMAP.md，再生成新一版。
 * @param force — 执行器路径为 true，不受 discovery.auto_refresh_roadmap 关闭影响
 */
export async function refreshRoadmapIfExhausted(
  projectPath: string,
  cfg: DevAgentConfig,
  opts: { force?: boolean; autoPlan?: boolean } = {},
): Promise<RoadmapRefreshResult> {
  if (!isRoadmapExhausted(projectPath)) {
    return { exhausted: false, refreshed: false };
  }
  if (!opts.force && !cfg.discovery.auto_refresh_roadmap) {
    return { exhausted: true, refreshed: false };
  }

  const scan = await scanProject(projectPath);
  const snap = loadSnapshot(projectPath);
  const themes =
    snap?.themes?.length
      ? snap.themes
      : snap?.signals?.length
        ? deriveThemesFromSignals(snap.signals, cfg.discovery.theme_count)
        : [];

  const allowTemplate = cfg.discovery.allow_template_fallback === true;
  let refreshed = false;

  const requireUnchecked = true;
  const writeOpts = { requireUncheckedActive: requireUnchecked };
  try {
    if (themes.length > 0) {
      refreshed = await refreshRoadmapFromRadar(projectPath, scan, cfg, themes, undefined, writeOpts);
    } else {
      refreshed = await refreshRoadmap(projectPath, scan, cfg, undefined, writeOpts);
    }
    if (!refreshed && hasLlmAuth()) {
      const path = roadmapPath(projectPath);
      const oldContent = existsSync(path) ? readFileSync(path, "utf-8") : "";
      const retryPrompt = withUserInstructions(
        `上一版输出无效（缺少 # Roadmap 或未含 Active 未完成步骤）。请严格按格式重新生成完整 ROADMAP.md。

北极星：${cfg.initial_goal}
已完成 Active 步骤：${loadRoadmap(projectPath)?.active.filter((s) => s.done).map((s) => s.text).join("; ") || "无"}

格式要求：
# Roadmap
## Active
Feature: <名称> (started ${new Date().toISOString().slice(0, 10)})
- [ ] 步骤1
## Backlog
- 条目
## Done
- 已完成特性

只输出 Markdown，从 # Roadmap 开始，不要写变更摘要。`,
      );
      const { text } = await runSdkQuery({
        prompt: retryPrompt,
        cwd: projectPath,
        systemPrompt: readPrompt("roadmap-refresh-radar.md"),
        role: "planner",
        allowedTools: ["Read", "Glob", "Grep"],
      });
      const md = extractValidRoadmapMarkdown(text, { requireUncheckedActive: requireUnchecked });
      if (md && md.trim() !== oldContent.trim()) {
        writeFileSync(path, md + "\n");
        refreshed = true;
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!allowTemplate || !hasLlmAuth()) throw e;
    if (!snap?.signals?.length) throw e;
    refreshed = writeFallbackRoadmap(projectPath, {
      signals: snap.signals,
      northStar: cfg.initial_goal,
      themes,
    });
    await appendLesson(projectPath, `roadmap:exhausted-fallback (${msg.slice(0, 80)})`);
  }

  if (!refreshed && allowTemplate && snap?.signals?.length) {
    refreshed = writeFallbackRoadmap(projectPath, {
      signals: snap.signals,
      northStar: cfg.initial_goal,
      themes,
    });
  }

  if (!refreshed) {
    refreshed = refreshRoadmapFromBacklog(projectPath);
    if (refreshed) {
      await appendLesson(projectPath, "roadmap:exhausted-backlog-promote (LLM 输出无效，Backlog 升 Active)");
    }
  }

  const backupPath = latestRoadmapBackupPath(projectPath);
  if (refreshed) {
    await appendLesson(projectPath, "roadmap:exhausted-refreshed (备份已写入 roadmap-history)");
  } else if (backupPath) {
    await appendLesson(projectPath, "roadmap:exhausted-backup-only (生成内容与旧版相同，已备份)");
  }

  let planId: string | undefined;
  let goal: string | undefined;
  if (refreshed && opts.autoPlan) {
    const planned = await autoPlanAfterRefresh(projectPath, cfg, themes);
    planId = planned.planId;
    goal = planned.goal;
  }

  return { exhausted: true, refreshed, backupPath: backupPath || undefined, planId, goal };
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
