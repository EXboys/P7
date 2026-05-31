import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { DevAgentConfig } from "./config.ts";
import { projectSubpathForRead } from "./p7-paths.ts";
import { bigramJaccard, extractLastJsonBlock } from "./json-utils.ts";
import { firstUnfinishedStep, recommendRoadmapGoal } from "./roadmap.ts";
import { refreshRoadmapIfExhausted } from "./roadmap-refresh.ts";
import { formatDiscoveryForPrompt, loadSnapshot } from "./tech-discovery.ts";
import { readPrompt, runSdkQuery } from "./sdk.ts";
import { GoalSelectionSchema, type GoalSelection, type ProjectScan } from "./types.ts";

function loadFailureTargets(projectPath: string): { goal: string; at: number }[] {
  const dir = projectSubpathForRead(projectPath, "failed-plans");
  if (!existsSync(dir)) return [];
  const out: { goal: string; at: number }[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      if (raw.title) out.push({ goal: raw.title, at: new Date(raw.failedAt ?? 0).getTime() });
    }
  } catch {
    /* ignore */
  }
  return out;
}

function shouldSkipStep(
  stepText: string,
  failures: { goal: string; at: number }[],
  completed: { goal: string; at: number }[],
): boolean {
  const now = Date.now();
  for (const f of failures) {
    if (now - f.at < 24 * 3600 * 1000 && bigramJaccard(stepText, f.goal) > 0.6) return true;
  }
  for (const c of completed) {
    if (now - c.at < 48 * 3600 * 1000 && bigramJaccard(stepText, c.goal) > 0.7) return true;
  }
  return false;
}

function missionRetry(goal: string): boolean {
  return goal.endsWith("?") || goal.endsWith("？");
}

export async function selectGoal(
  projectPath: string,
  scan: ProjectScan,
  cfg: DevAgentConfig,
): Promise<GoalSelection> {
  await refreshRoadmapIfExhausted(projectPath, cfg);

  const fast = recommendRoadmapGoal(projectPath);
  const failures = loadFailureTargets(projectPath);

  if (fast && !shouldSkipStep(fast, failures, [])) {
    return {
      today_goal: fast,
      reasoning: "ROADMAP Active 首条未完成步骤（快速路径）",
      alternatives: [],
    };
  }

  const claudeMd = existsSync(join(projectPath, ".claude", "CLAUDE.md"))
    ? readFileSync(join(projectPath, ".claude", "CLAUDE.md"), "utf-8").slice(-3000)
    : "";

  const radar = formatDiscoveryForPrompt(loadSnapshot(projectPath));

  const prompt = `北极星：${cfg.initial_goal}

今日技术雷达：
${radar}

近期提交：${scan.git?.recentCommits.slice(0, 5).map((c) => c.subject).join("; ") ?? "无"}

教训摘要：
${claudeMd}

ROADMAP 快速路径${fast ? `（已跳过或不可用：${fast}）` : "不可用"}

请选择今日目标 JSON。`;

  const run = async () => {
    const { text } = await runSdkQuery({
      prompt,
      cwd: projectPath,
      systemPrompt: readPrompt("goal-selector-system.md"),
      role: "selector",
      allowedTools: ["Read", "Glob", "Grep"],
    });
    return GoalSelectionSchema.parse(extractLastJsonBlock(text));
  };

  let sel = await run();
  if (missionRetry(sel.today_goal)) sel = await run();
  return sel;
}
