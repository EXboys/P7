import type { JobRow, StepState } from "../queue/types.ts";
import type { PlanState } from "../../src/types.ts";
import { classifyFailure } from "../../src/failure-classifier.ts";
import type { AuditEntry } from "../audit-log.ts";
import type { OpenPr } from "../../src/vcs/open-prs.ts";
import { esc, formatUsd, jobKindLabel, metricCard } from "../dashboard-ui.ts";

function parseStepStates(job: JobRow): StepState[] {
  if (!job.step_states) return [];
  try {
    const parsed = JSON.parse(job.step_states) as StepState[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function renderAutomationHealthPage(opts: {
  alias: string;
  dailyCapUsd: number;
  jobs: JobRow[];
  states: PlanState[];
  openPrBlocked: string | null;
  openPrs?: OpenPr[];
  auditEntries?: AuditEntry[];
  todayCostUsd: number;
  monthCost: { total: number; jobs: number };
}): string {
  const since = Date.now() - 24 * 3600 * 1000;
  const jobs24h = opts.jobs.filter((j) => new Date(j.created_at).getTime() >= since);
  const done = jobs24h.filter((j) => j.status === "done").length;
  const failed = jobs24h.filter((j) => j.status === "failed").length;
  const running = opts.jobs.filter((j) => j.status === "running" || j.status === "pending");
  const successRate = done + failed > 0 ? `${Math.round((done / (done + failed)) * 100)}%` : "无数据";
  const failedKinds = new Map<string, number>();
  const humanEvents: string[] = [];
  const jobTime = (job: JobRow) => new Date(job.finished_at ?? job.started_at ?? job.created_at).getTime();
  const recentJobs = [...opts.jobs].sort(
    (a, b) => jobTime(b) - jobTime(a),
  );
  const recentFailures = [];
  for (const job of recentJobs) {
    if (job.status !== "failed") break;
    recentFailures.push(job);
    if (recentFailures.length >= 5) break;
  }
  const consecutiveFailures = recentFailures.length;
  for (const job of jobs24h.filter((j) => j.status === "failed")) {
    const c = classifyFailure(job.error ?? "");
    failedKinds.set(c.kind, (failedKinds.get(c.kind) ?? 0) + 1);
    if (c.hardStop) humanEvents.push(`${jobKindLabel(job.kind)}：${c.hint}`);
  }
  if (consecutiveFailures >= 3) {
    const topKind = classifyFailure(recentFailures[0]?.error ?? "").kind;
    humanEvents.push(`连续失败 ${consecutiveFailures} 次：最近类型 ${topKind}`);
  }
  if (opts.openPrBlocked) humanEvents.push(`PR 阻塞：${opts.openPrBlocked}`);
  const pendingPrs = (opts.openPrs ?? []).filter((pr) =>
    /BLOCKED|DIRTY|UNKNOWN|UNSTABLE|BEHIND/i.test(`${pr.mergeable} ${pr.mergeStateStatus}`),
  );
  if (pendingPrs.length > 0) {
    humanEvents.push(`PR 待处理：${pendingPrs.length} 个未处于可合并状态`);
  }
  if (opts.todayCostUsd >= opts.dailyCapUsd * 0.8) {
    humanEvents.push(`成本接近日上限：${formatUsd(opts.todayCostUsd)} / ${formatUsd(opts.dailyCapUsd)}`);
  }
  const skipReasons = new Map<string, number>();
  for (const entry of opts.auditEntries ?? []) {
    if (!/skip|skipped|blocked/i.test(entry.event)) continue;
    const reason = String(entry.detail.reason ?? entry.detail.error ?? entry.event);
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
  }
  const skipRows = [...skipReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => `<tr><td>${esc(reason)}</td><td>${count}</td></tr>`)
    .join("");
  const prRows = (opts.openPrs ?? [])
    .slice(0, 10)
    .map(
      (pr) =>
        `<tr><td><a href="${esc(pr.url)}" target="_blank" rel="noreferrer">#${pr.number}</a></td><td>${esc(pr.title)}</td><td>${esc(pr.mergeStateStatus || pr.mergeable || "-")}</td></tr>`,
    )
    .join("");
  const pendingPlans = opts.states.filter((s) => s.status === "pending_approval").length;
  const failedPlans = opts.states.filter((s) => s.status === "failed").length;
  const nextAction = running[0]
    ? `等待 ${jobKindLabel(running[0].kind)} 完成`
    : opts.openPrBlocked
      ? "调度器会先复查/合并 OPEN PR"
      : pendingPlans > 0
        ? "自动审批或人工审批待处理 Plan"
        : failedPlans > 0
          ? "失败分类器会对可修复失败自动重试"
          : "可继续 discover / plan / execute 下一轮";

  const durations = new Map<string, { totalMs: number; count: number; failed: number }>();
  for (const job of jobs24h) {
    for (const step of parseStepStates(job)) {
      const started = new Date(step.started_at).getTime();
      const finished = step.finished_at ? new Date(step.finished_at).getTime() : NaN;
      if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) continue;
      const cur = durations.get(step.step_name) ?? { totalMs: 0, count: 0, failed: 0 };
      cur.totalMs += finished - started;
      cur.count++;
      if (step.status === "failed") cur.failed++;
      durations.set(step.step_name, cur);
    }
  }
  const durationRows = [...durations.entries()]
    .sort((a, b) => b[1].totalMs / b[1].count - a[1].totalMs / a[1].count)
    .slice(0, 10)
    .map(([step, v]) => `<tr><td>${esc(step)}</td><td>${Math.round(v.totalMs / v.count / 1000)}s</td><td>${v.count}</td><td>${v.failed}</td></tr>`)
    .join("");
  const failureRows = [...failedKinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `<tr><td>${esc(kind)}</td><td>${count}</td></tr>`)
    .join("");

  return `<div class="panel">
<div class="panel-head"><h2>自动化健康</h2><span class="muted">最近 24h</span></div>
<div class="health-banner ${humanEvents.length ? "fail" : "ok"}"><span class="health-icon">${humanEvents.length ? "!" : "✓"}</span><div><strong>${humanEvents.length ? "需要关注" : "无人值守链路健康"}</strong><span>${esc(nextAction)}</span></div></div>
<div class="cards">${metricCard(successRate, "24h 成功率")}${metricCard(done, "成功任务")}${metricCard(failed, "失败任务", failed ? "warn" : undefined)}${metricCard(running.length, "待执行/运行中", running.length ? "warn" : undefined)}${metricCard(formatUsd(opts.todayCostUsd), "今日成本")}</div>
</div>
<div class="overview-grid">
<div class="panel"><h2>当前阻塞项</h2>${humanEvents.length ? `<ul>${humanEvents.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : `<p class="muted">没有需要人工介入的阻塞项。</p>`}</div>
<div class="panel"><h2>成本与吞吐</h2><p class="muted">今日 ${formatUsd(opts.todayCostUsd)} / 日上限 ${formatUsd(opts.dailyCapUsd)}；本月 ${formatUsd(opts.monthCost.total)}，共 ${opts.monthCost.jobs} 个计费任务。</p><p class="muted">下一动作：${esc(nextAction)}</p></div>
</div>
<div class="overview-grid">
<div class="panel"><h2>失败类型</h2><div class="tbl-wrap"><table><thead><tr><th>类型</th><th>次数</th></tr></thead><tbody>${failureRows || `<tr><td colspan="2" class="empty">无失败</td></tr>`}</tbody></table></div></div>
<div class="panel"><h2>阶段耗时</h2><div class="tbl-wrap"><table><thead><tr><th>阶段</th><th>平均耗时</th><th>次数</th><th>失败</th></tr></thead><tbody>${durationRows || `<tr><td colspan="4" class="empty">暂无 step_states</td></tr>`}</tbody></table></div></div>
</div>
<div class="overview-grid">
<div class="panel"><h2>调度跳过原因</h2><div class="tbl-wrap"><table><thead><tr><th>原因</th><th>次数</th></tr></thead><tbody>${skipRows || `<tr><td colspan="2" class="empty">最近没有调度跳过记录</td></tr>`}</tbody></table></div></div>
<div class="panel"><h2>Open PR 状态</h2><div class="tbl-wrap"><table><thead><tr><th>PR</th><th>标题</th><th>合并状态</th></tr></thead><tbody>${prRows || `<tr><td colspan="3" class="empty">无 open PR</td></tr>`}</tbody></table></div></div>
</div>`;
}
