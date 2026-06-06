import { existsSync } from "fs";
import { relative } from "path";
import type { PipelineCheckItem } from "../../src/pipeline-check.ts";
import type { PlanState, TechDiscoverySnapshot } from "../../src/types.ts";
import type { DevAgentConfig } from "../../src/config.ts";
import { loadRoadmap } from "../../src/roadmap.ts";
import { computeTypeSafetyMetrics, type TypeSafetyMetrics } from "../../src/gradual-typecheck-config.ts";
import {
  esc,
  metricCard,
  overviewNextStep,
  renderPipelineChecksPanel,
  statusBadge,
} from "../dashboard-ui.ts";
import { collectProjectFiles, tsconfigNoImplicitAnyDefault } from "./project-files.ts";

export function computeOverviewTypeSafetyMetrics(
  projectPath: string,
  dc: DevAgentConfig,
): TypeSafetyMetrics {
  const sourceFiles = collectProjectFiles(projectPath);
  if (sourceFiles.length === 0) {
    return { strictFiles: 0, anyEscapePaths: 0, coveragePercent: 0, totalFiles: 0 };
  }
  const relFiles = sourceFiles.map((f) => relative(projectPath, f));
  return computeTypeSafetyMetrics(relFiles, {
    ...(dc.gradual_type_checking ?? { rules: [] }),
    tsconfigDefaults: {
      noImplicitAny: tsconfigNoImplicitAnyDefault(projectPath),
    },
  });
}

export function renderOverviewBody(opts: {
  alias: string;
  base: string;
  projectPath: string;
  checks: PipelineCheckItem[];
  blockers: { label: string }[];
  pending: number;
  states: PlanState[];
  snapshot: TechDiscoverySnapshot | null;
  metrics: TypeSafetyMetrics;
}): string {
  const snap = opts.snapshot;
  const executing = opts.states.filter((s) => s.status === "executing").length;
  const prCount = opts.states.filter((s) => s.prUrl).length;
  const signalCount = snap?.signals.length ?? 0;
  const healthHtml = opts.checks.length
    ? renderPipelineChecksPanel(opts.alias, opts.checks)
    : `<p class="muted">项目路径不可用</p>`;

  const roadmap = existsSync(opts.projectPath) ? loadRoadmap(opts.projectPath) : null;
  const roadmapHtml = roadmap?.active.length
    ? `<div class="panel"><div class="panel-head"><h2>Roadmap 进行中</h2><a href="${opts.base}/plan?section=roadmap">查看全部</a></div>
<ul class="roadmap-preview">${roadmap.active
        .slice(0, 4)
        .map((s) => `<li><span class="dot"></span><span>${esc(s.text)}</span></li>`)
        .join("")}</ul></div>`
    : `<div class="panel"><div class="panel-head"><h2>Roadmap</h2><a href="${opts.base}/plan?section=roadmap">去生成</a></div>
<p class="muted" style="margin:0">尚无 Active 项。先抓取趋势，再 AI 刷新 Roadmap。</p></div>`;

  const recentRows = opts.states
    .slice(0, 10)
    .map(
      (s) =>
        `<tr><td><a href="${opts.base}/plans/${encodeURIComponent(s.planId)}">${esc(s.title || s.planId)}</a></td><td>${statusBadge(s.status)}</td><td class="muted recent-row">${esc(new Date(s.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</td></tr>`,
    )
    .join("");

  const recentHtml = `<div class="panel"><div class="panel-head"><h2>最近动态</h2><a href="${opts.base}/run">执行记录</a></div>
<p class="muted" style="margin:0 0 10px;font-size:12px">成功、失败和进行中状态按更新时间倒序混排；失败详情可到运行页查看。</p>
<div class="tbl-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>更新</th></tr></thead><tbody>${recentRows || `<tr><td colspan="3" class="empty">暂无记录，从趋势或一键发现开始</td></tr>`}</tbody></table></div></div>`;

  const pendingBanner =
    opts.pending > 0
      ? `<div class="flash warn-banner"><strong>${opts.pending} 个 Plan 待审批</strong> — 请先在侧栏进入「规划 → Plan 审批」确认后再执行。<a class="btn sm" style="margin-left:12px" href="${opts.base}/plan?section=plans">去审批</a></div>`
      : "";

  const themes =
    snap?.themes?.length
      ? `<p class="muted overview-themes">今日主题：<strong>${esc(snap.themes.join(" · "))}</strong></p>`
      : "";

  const nextStep = overviewNextStep({
    blockers: opts.blockers,
    pending: opts.pending,
    hasSnapshot: Boolean(snap),
    signalCount,
    base: opts.base,
  });

  return `<div class="overview-page">
${pendingBanner}
${nextStep}
${themes}
<div class="cards">${metricCard(signalCount, "今日信号", signalCount ? undefined : "warn")}${metricCard(opts.pending, "待审批", opts.pending ? "warn" : undefined)}${metricCard(executing, "执行中", executing ? "warn" : undefined)}${metricCard(prCount, "已开 PR")}${metricCard(opts.metrics.strictFiles, "严格文件")}${metricCard(opts.metrics.anyEscapePaths, "any 逃逸", opts.metrics.anyEscapePaths > 0 ? "warn" : undefined)}${metricCard(opts.metrics.coveragePercent + "%", "覆盖率")}</div>
<div class="overview-grid">${roadmapHtml}${recentHtml}</div>
<div class="panel" id="health" style="margin-bottom:0"><h2 style="margin-bottom:10px">环境检查</h2>${healthHtml}</div>
</div>`;
}
