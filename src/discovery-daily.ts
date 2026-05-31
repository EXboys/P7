import { loadConfig } from "./config.ts";
import { scanProject } from "./scanner.ts";
import { generatePlan } from "./planner.ts";
import { refreshRoadmapFromRadar } from "./roadmap-refresh.ts";
import { writeFallbackRoadmap } from "./roadmap-template.ts";
import { assertLlmAuth, hasLlmAuth } from "./llm-env.ts";
import {
  processAutoApprovals,
  savePendingApproval,
  getApprovalRecord,
} from "./approval.ts";
import { appendLesson } from "./agent-memory.ts";
import { recommendRoadmapGoal } from "./roadmap.ts";
import {
  runDiscovery,
  loadSnapshot,
  discoverySnapshotFile,
  deriveThemesFromSignals,
} from "./tech-discovery.ts";
import type { DiscoveryDailyResult } from "./types.ts";
import { notifyPlanReady } from "./notify/sender.ts";
import { resolveNotifyConfig } from "./notify/env.ts";
import { checkPrWorkGate } from "./vcs/pr-work-gate.ts";
import { ghInstalled, gitRemoteOrigin } from "./gh-status.ts";

export async function runDiscoveryDaily(
  projectPath: string,
  opts: { planOnly?: boolean; skipDiscovery?: boolean; projectAlias?: string; recoverStall?: boolean } = {},
): Promise<DiscoveryDailyResult> {
  const cfg = loadConfig(projectPath);
  const gate =
    ghInstalled() && gitRemoteOrigin(projectPath)
      ? checkPrWorkGate(projectPath, cfg)
      : { blocked: false, prs: [], reason: "no_gh" };
  if (gate.blocked) {
    return {
      date: new Date().toISOString().slice(0, 10),
      snapshotPath: "",
      signalCount: 0,
      themes: [],
      roadmapRefreshed: false,
      phase: "blocked_open_prs",
      goal: gate.reason,
    };
  }

  const date = new Date().toISOString().slice(0, 10);

  if (opts.recoverStall) {
    assertLlmAuth();
    const scan = await scanProject(projectPath);
    const goal = recommendRoadmapGoal(projectPath) ?? cfg.initial_goal;
    const planRecord = await generatePlan(projectPath, scan, goal);
    const planId = planRecord.planId;
    if (!getApprovalRecord(projectPath, planId)) {
      savePendingApproval(projectPath, planRecord);
    }
    const batch = processAutoApprovals(projectPath, cfg, { planIds: [planId] });
    let phase = batch.approved.includes(planId) ? "approved" : "awaiting_approval";
    if (phase === "awaiting_approval") {
      const notify = resolveNotifyConfig(opts.projectAlias);
      if (notify) await notifyPlanReady(notify, planRecord.plan, goal, planId);
    }
    await appendLesson(
      projectPath,
      `pipeline:recover-stall plan=${planId} goal="${goal.slice(0, 60)}" phase=${phase}`,
    );
    return {
      date,
      snapshotPath: "",
      signalCount: 0,
      themes: [],
      roadmapRefreshed: false,
      planId,
      goal,
      phase: phase === "approved" ? "recovery_approved" : "recovery_awaiting_approval",
    };
  }

  let snapPath = "";
  let signalCount = 0;
  let themes: string[] = [];

  if (!opts.skipDiscovery && cfg.discovery.enabled) {
    const snap = await runDiscovery(projectPath, cfg, { useLlmThemes: true });
    snapPath = discoverySnapshotFile(projectPath, snap.date);
    signalCount = snap.signals.length;
    themes = snap.themes;
    await appendLesson(
      projectPath,
      `radar:ok hn+github ${signalCount} signals, themes: ${themes.join("; ")}`,
    );
  } else {
    const existing = loadSnapshot(projectPath, date);
    if (existing) {
      snapPath = discoverySnapshotFile(projectPath, date);
      signalCount = existing.signals.length;
      themes = existing.themes;
    }
  }

  const snapLoaded = loadSnapshot(projectPath, date);
  const signals = snapLoaded?.signals ?? [];
  if (snapLoaded && themes.length === 0) {
    themes = deriveThemesFromSignals(signals, cfg.discovery.theme_count);
  }

  let roadmapRefreshed = false;
  if (cfg.discovery.auto_refresh_roadmap && signals.length > 0) {
    const scan = await scanProject(projectPath);
    const themeInput = themes.length > 0 ? themes : deriveThemesFromSignals(signals, cfg.discovery.theme_count);
    const allowTemplate = cfg.discovery.allow_template_fallback === true;
    if (!allowTemplate) assertLlmAuth();
    try {
      roadmapRefreshed = await refreshRoadmapFromRadar(projectPath, scan, cfg, themeInput);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!allowTemplate || !hasLlmAuth()) throw e;
      roadmapRefreshed = writeFallbackRoadmap(projectPath, {
        signals,
        northStar: cfg.initial_goal,
        themes: themeInput,
      });
      await appendLesson(projectPath, `roadmap:fallback template (${msg.slice(0, 80)})`);
    }
    if (!roadmapRefreshed && allowTemplate) {
      roadmapRefreshed = writeFallbackRoadmap(projectPath, {
        signals,
        northStar: cfg.initial_goal,
        themes: themeInput,
      });
    }
    await appendLesson(
      projectPath,
      roadmapRefreshed ? `roadmap:refreshed` : `roadmap:refresh skipped`,
    );
  }

  let planId: string | undefined;
  let goal: string | undefined;
  let phase = roadmapRefreshed ? "roadmap_refreshed" : "discovery_only";

  const shouldPlan = cfg.discovery.auto_plan_after_refresh && roadmapRefreshed;

  if (shouldPlan) {
    const scan = await scanProject(projectPath);
    goal = recommendRoadmapGoal(projectPath) ?? themes[0] ?? cfg.initial_goal;
    const planRecord = await generatePlan(projectPath, scan, goal);
    planId = planRecord.planId;
    if (!getApprovalRecord(projectPath, planId)) {
      savePendingApproval(projectPath, planRecord);
    }
    const notify = resolveNotifyConfig(opts.projectAlias);
    const batch = processAutoApprovals(projectPath, cfg, { planIds: [planId] });
    if (batch.approved.includes(planId)) {
      phase = "approved";
    } else {
      phase = "awaiting_approval";
      if (notify && goal) await notifyPlanReady(notify, planRecord.plan, goal, planId);
    }
  }

  return {
    date,
    snapshotPath: snapPath,
    signalCount,
    themes,
    roadmapRefreshed,
    planId,
    goal,
    phase,
  };
}
