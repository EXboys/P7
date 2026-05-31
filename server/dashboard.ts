import { Hono } from "hono";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ServerConfig } from "./config.ts";
import { saveServerConfig, writeClaudeSettings } from "./config.ts";
import { listJobsForProject, listAllJobs, enqueueJob } from "./queue/store.ts";
import { audit } from "./audit.ts";
import { listPlanStates, preparePlanExecuteRetry } from "../src/state.ts";
import { loadSnapshot, listSnapshots } from "../src/tech-discovery.ts";
import { listPendingApprovals, decideApproval } from "../src/approval.ts";
import { getPlanDetailView } from "../src/plan-detail.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import { scanProject } from "../src/scanner.ts";
import { refreshRoadmapForDashboard } from "../src/roadmap-refresh.ts";
import { generatePlan } from "../src/planner.ts";
import { recommendRoadmapGoal } from "../src/roadmap.ts";
import { getApprovalRecord, savePendingApproval } from "../src/approval.ts";
import { assertLlmAuth } from "../src/llm-env.ts";
import { readJobLog } from "./queue/worker.ts";
import { getJob } from "./queue/store.ts";
import { applyLlmProbeResult, pipelineReady, runPipelineCheck } from "../src/pipeline-check.ts";
import { probeLlmConnection } from "../src/llm-probe.ts";
import { applyAllLlmEnv, hasLlmAuth, mergeLlmEnv } from "../src/llm-env.ts";
import { loadRoadmap } from "../src/roadmap.ts";
import { resolveP7HomeDir } from "../src/p7-paths.ts";
import type { DevAgentConfig } from "../src/config.ts";
import {
  checkGhAuth,
  collectGhAuthChecks,
  ghInstalled,
  gitRemoteOrigin,
} from "../src/gh-status.ts";
import {
  esc,
  firstProjectAlias,
  layout,
  metricCard,
  overviewNextStep,
  planToolbar,
  renderPlanRoadmapRegenForm,
  renderPlanGenerateForm,
  renderPlanDetailPage,
  renderPipelineChecksPanel,
  projectShell,
  discoverToolbar,
  renderTrendsPage,
  resolveProject,
  statusBadge,
  workbenchToolbar,
  type ProjectTab,
} from "./dashboard-ui.ts";

function applyVcsConfigFromBody(
  dc: DevAgentConfig,
  body: Record<string, string>,
): string | null {
  if (body.vcs_mode === "default_gh") {
    dc.vcs.accounts = [];
  } else if (body.vcs_mode === "custom") {
    const accRaw = String(body.vcs_accounts_json ?? "").trim();
    if (accRaw) {
      try {
        dc.vcs.accounts = JSON.parse(accRaw) as typeof dc.vcs.accounts;
      } catch {
        return "VCS JSON 格式错误";
      }
    }
    const addId = String(body.add_account_id ?? "").trim();
    if (addId) {
      const entry = {
        id: addId,
        provider: "github" as const,
        auth_type: (body.add_account_auth_type === "token_env" ? "token_env" : "gh") as
          | "gh"
          | "token_env",
        gh_host: String(body.add_account_gh_host ?? "github.com").trim() || "github.com",
        token_env: String(body.add_account_token_env ?? "").trim() || undefined,
      };
      const idx = dc.vcs.accounts.findIndex((a) => a.id === addId);
      if (idx >= 0) dc.vcs.accounts[idx] = { ...dc.vcs.accounts[idx], ...entry };
      else dc.vcs.accounts.push(entry);
    }
  }
  const bb = String(body.vcs_base_branch ?? "").trim();
  dc.vcs.base_branch = bb || undefined;
  const labelsRaw = String(body.vcs_labels ?? "").trim();
  if (labelsRaw) {
    dc.vcs.labels = labelsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (body.vcs_auto_merge !== undefined) dc.vcs.auto_merge = body.vcs_auto_merge === "1";
  if (body.vcs_create_pr !== undefined) dc.vcs.create_pr = body.vcs_create_pr === "1";
  if (body.vcs_create_issue !== undefined) dc.vcs.create_issue = body.vcs_create_issue === "1";
  return null;
}

function renderGithubConfigPanel(
  projectPath: string,
  dc: DevAgentConfig,
  formAction: string,
): string {
  const remote = gitRemoteOrigin(projectPath);
  const defaultGh = dc.vcs.accounts.length === 0;
  const checks = collectGhAuthChecks(projectPath, dc.vcs.accounts);
  const ghOk = ghInstalled();
  const authOk = checks.every((c) => c.ok);
  const hostPills = checks
    .map((a) => {
      const cls = a.ok ? "ok" : "fail";
      return `<span class="host-pill"><span class="badge ${cls}">${esc(a.hostname)}</span><span class="muted">${esc(a.login ?? a.detail.slice(0, 24))}</span></span>`;
    })
    .join("");
  const accountRows = dc.vcs.accounts
    .map(
      (a) =>
        `<tr><td><code>${esc(a.id)}</code></td><td>${esc(a.auth_type)}</td><td>${esc(a.gh_host)}</td><td class="muted">${esc(a.token_env ?? "—")}</td></tr>`,
    )
    .join("");
  const yesNo = (on: boolean) =>
    `<option value="1" ${on ? "selected" : ""}>开启</option><option value="0" ${!on ? "selected" : ""}>关闭</option>`;

  return `<form method="post" action="${esc(formAction)}" class="gh-form" id="github">
<div class="gh-status">
<div class="gh-stat ${ghOk ? "ok" : "fail"}"><div class="k">GitHub CLI</div><div class="v">${ghOk ? "gh 已安装" : "未安装 · brew install gh"}</div></div>
<div class="gh-stat ${remote ? "ok" : "fail"}"><div class="k">仓库 origin</div><div class="v">${remote ? esc(remote) : "未配置 remote"}</div></div>
<div class="gh-stat ${authOk ? "ok" : "fail"}"><div class="k">登录状态</div><div class="v">${authOk ? "已就绪" : "需 gh auth login"}</div></div>
</div>
${hostPills ? `<div class="host-pills">${hostPills}</div>` : ""}

<div class="gh-section">
<h3>用哪个 GitHub 账号发 PR？</h3>
<p class="section-hint">执行器 push 代码后用 gh 创建 PR。不填多账号时，自动用本机默认登录。</p>
<div class="mode-cards">
<label class="mode-card">
<input type="radio" name="vcs_mode" value="default_gh" ${defaultGh ? "checked" : ""}/>
<span class="mode-title">本机 gh 默认账号</span>
<span class="mode-desc">推荐。终端执行 gh auth login 一次即可。</span>
</label>
<label class="mode-card">
<input type="radio" name="vcs_mode" value="custom" ${!defaultGh ? "checked" : ""}/>
<span class="mode-title">自定义多账号</span>
<span class="mode-desc">组织机器人、PAT 环境变量等多身份推送。</span>
</label>
</div>
<div id="vcs-custom" class="gh-advanced-wrap" style="${defaultGh ? "display:none" : ""}">
<details class="gh-advanced" ${!defaultGh ? "open" : ""}>
<summary>多账号配置（${dc.vcs.accounts.length} 个）</summary>
${accountRows ? `<div class="tbl-wrap" style="margin-bottom:14px"><table><thead><tr><th>ID</th><th>鉴权</th><th>Host</th><th>Token 变量</th></tr></thead><tbody>${accountRows}</tbody></table></div>` : `<p class="muted">暂无账号，可在下方添加。</p>`}
<div class="row">
<div><label>账号 ID</label><input name="add_account_id" placeholder="org-bot"/></div>
<div><label>鉴权</label><select name="add_account_auth_type"><option value="gh">gh 登录</option><option value="token_env">PAT 环境变量</option></select></div>
</div>
<div class="row">
<div><label>Host</label><input name="add_account_gh_host" value="github.com"/></div>
<div><label>Token 环境变量</label><input name="add_account_token_env" placeholder="GH_TOKEN_ORG"/></div>
</div>
<label>JSON（高级编辑）</label>
<textarea name="vcs_accounts_json" rows="4" style="font-family:ui-monospace,monospace;font-size:12px">${esc(JSON.stringify(dc.vcs.accounts, null, 2))}</textarea>
</details>
</div>
</div>

<div class="gh-section">
<h3>交付行为</h3>
<p class="section-hint">Plan 执行成功并 push 分支后的自动化动作。</p>
<div class="row" style="margin-bottom:12px">
<div><label>合并到分支</label><input name="vcs_base_branch" value="${esc(dc.vcs.base_branch ?? "")}" placeholder="main（留空用默认）"/></div>
<div><label>PR 标签</label><input name="vcs_labels" value="${esc(dc.vcs.labels.join(", "))}" placeholder="p7"/></div>
</div>
<div class="toggle-grid">
<div class="toggle-item"><span>创建 Pull Request</span><select name="vcs_create_pr">${yesNo(dc.vcs.create_pr)}</select></div>
<div class="toggle-item"><span>创建 Issue</span><select name="vcs_create_issue">${yesNo(dc.vcs.create_issue)}</select></div>
<div class="toggle-item"><span>自动合并 PR</span><select name="vcs_auto_merge">${yesNo(dc.vcs.auto_merge)}</select></div>
</div>
</div>

<div class="gh-footer">
<span class="hint">保存后写入项目 <code>.p7/config.json</code>，下次执行 Plan 时生效。</span>
<button type="submit" class="btn ok">保存 GitHub 设置</button>
</div>
<script>
(function(){
  const radios=document.querySelectorAll('input[name="vcs_mode"]');
  const box=document.getElementById('vcs-custom');
  function sync(){
    const custom=[...radios].find(r=>r.value==='custom'&&r.checked);
    if(box)box.style.display=custom?'block':'none';
    document.querySelectorAll('.mode-card').forEach(card=>{
      const inp=card.querySelector('input[type=radio]');
      if(inp)card.style.borderColor=inp.checked?'var(--accent)':'';
    });
  }
  radios.forEach(r=>r.addEventListener('change',sync));
  sync();
})();
</script>
</form>`;
}

export function createDashboard(
  getCfg: () => ServerConfig,
  setCfg: (c: ServerConfig) => void,
): Hono {
  const app = new Hono();

  function legacyRedirectUrl(alias: string, legacy: string, flash?: string): string {
    const sectionMap: Record<string, string> = {
      roadmap: "roadmap",
      plans: "plans",
      github: "github",
      config: "project",
    };
    if (legacy === "runs" || legacy === "delivery") {
      return `/project/${encodeURIComponent(alias)}/run${flash ? `?flash=${encodeURIComponent(flash)}` : ""}`;
    }
    const section = sectionMap[legacy] ?? "roadmap";
    const base = `/project/${encodeURIComponent(alias)}/${legacy === "github" || legacy === "config" ? "settings" : "plan"}`;
    return `${base}?section=${section}${flash ? `&flash=${encodeURIComponent(flash)}` : ""}`;
  }

  app.get("/", (c) => {
    const cfg = getCfg();
    const first = firstProjectAlias(cfg);
    if (!first) {
      return c.redirect("/settings?flash=请先绑定项目");
    }
    const flash = c.req.query("flash");
    const q = flash ? `?flash=${encodeURIComponent(flash)}` : "";
    return c.redirect(`/project/${encodeURIComponent(first)}/overview${q}`);
  });

  app.get("/project/:alias", (c) => {
    const alias = c.req.param("alias");
    const q = c.req.query("tab");
    if (q === "github") {
      return c.redirect(`/project/${encodeURIComponent(alias)}/github`);
    }
    return c.redirect(`/project/${encodeURIComponent(alias)}/overview`);
  });

  app.get("/github", (c) => {
    const cfg = getCfg();
    const aliases = Object.keys(cfg.project_aliases);
    if (aliases.length === 0) return c.redirect("/settings?flash=请先绑定项目");
    if (aliases.length === 1) {
      return c.redirect(`/project/${encodeURIComponent(aliases[0])}/settings?section=github`);
    }
    const links = aliases
      .map(
        (a) =>
          `<li><a class="btn" href="/project/${encodeURIComponent(a)}/settings?section=github">${esc(a)} → GitHub 设置</a></li>`,
      )
      .join("");
    return c.html(
      layout({
        title: "选择项目",
        body: `<p class="muted">左侧点项目进入，或在下方选择 GitHub 设置：</p><ul style="list-style:none;padding:0;display:flex;flex-direction:column;gap:10px">${links}</ul>`,
        cfg,
        systemPage: "/settings",
      }),
    );
  });

  app.get("/project/:alias/overview", async (c) => {
    const cfg = getCfg();
    const alias = c.req.param("alias");
    const proj = resolveProject(cfg, alias);
    if (!proj) return c.text("not found", 404);
    const flash = c.req.query("flash");
    const base = `/project/${encodeURIComponent(alias)}`;
    let checks = existsSync(proj.path) ? runPipelineCheck(proj.path) : [];
    if (c.req.query("probe") === "1") {
      applyAllLlmEnv();
      const probe = await probeLlmConnection();
      checks = applyLlmProbeResult(checks, probe);
    }
    const blockers = checks.filter((x) => !x.ok);
    const pending = existsSync(proj.path) ? listPendingApprovals(proj.path).length : 0;
    const states = existsSync(proj.path) ? listPlanStates(proj.path, 8) : [];
    const snap = existsSync(proj.path) ? loadSnapshot(proj.path) : null;
    const executing = states.filter((s) => s.status === "executing").length;
    const prCount = states.filter((s) => s.prUrl).length;
    const signalCount = snap?.signals.length ?? 0;

    const healthHtml = checks.length
      ? renderPipelineChecksPanel(alias, checks)
      : `<p class="muted">项目路径不可用</p>`;

    const roadmap = existsSync(proj.path) ? loadRoadmap(proj.path) : null;
    const roadmapHtml = roadmap?.active.length
      ? `<div class="panel"><div class="panel-head"><h2>Roadmap 进行中</h2><a href="${base}/plan?section=roadmap">查看全部</a></div>
<ul class="roadmap-preview">${roadmap.active
          .slice(0, 4)
          .map((s) => `<li><span class="dot"></span><span>${esc(s.text)}</span></li>`)
          .join("")}</ul></div>`
      : `<div class="panel"><div class="panel-head"><h2>Roadmap</h2><a href="${base}/plan?section=roadmap">去生成</a></div>
<p class="muted" style="margin:0">尚无 Active 项。先抓取趋势，再 AI 刷新 Roadmap。</p></div>`;

    const recentRows = states
      .slice(0, 6)
      .map(
        (s) =>
          `<tr><td><a href="${base}/plans/${encodeURIComponent(s.planId)}">${esc(s.title || s.planId)}</a></td><td>${statusBadge(s.status)}</td><td class="muted recent-row">${esc(new Date(s.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</td></tr>`,
      )
      .join("");

    const recentHtml = `<div class="panel"><div class="panel-head"><h2>最近动态</h2><a href="${base}/run">执行记录</a></div>
<div class="tbl-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>更新</th></tr></thead><tbody>${recentRows || `<tr><td colspan="3" class="empty">暂无记录，从趋势或一键发现开始</td></tr>`}</tbody></table></div></div>`;

    const pendingBanner =
      pending > 0
        ? `<div class="flash warn-banner"><strong>${pending} 个 Plan 待审批</strong> — 请先在侧栏进入「规划 → Plan 审批」确认后再执行。<a class="btn sm" style="margin-left:12px" href="${base}/plan?section=plans">去审批</a></div>`
        : "";

    const themes =
      snap?.themes?.length
        ? `<p class="muted overview-themes">今日主题：<strong>${esc(snap.themes.join(" · "))}</strong></p>`
        : "";

    const nextStep = overviewNextStep({
      blockers,
      pending,
      hasSnapshot: Boolean(snap),
      signalCount,
      base,
    });

    const body = `<div class="overview-page">
${pendingBanner}
${nextStep}
${themes}
<div class="cards">${metricCard(signalCount, "今日信号", signalCount ? undefined : "warn")}${metricCard(pending, "待审批", pending ? "warn" : undefined)}${metricCard(executing, "执行中", executing ? "warn" : undefined)}${metricCard(prCount, "已开 PR")}</div>
<div class="overview-grid">${roadmapHtml}${recentHtml}</div>
<div class="panel" id="health" style="margin-bottom:0"><h2 style="margin-bottom:10px">环境检查</h2>${healthHtml}</div>
</div>`;

    const html = projectShell(cfg, alias, "overview", {
      title: "工作台",
      description: "项目总览与状态；切换步骤请用左侧菜单。",
      flash,
      toolbar: workbenchToolbar(alias),
      pipelineDone: pending > 0 ? 3 : snap ? 2 : 1,
      body,
    });
    return c.html(html ?? "not found", html ? 200 : 404);
  });

  app.get("/project/:alias/trends", (c) => {
    const cfg = getCfg();
    const alias = c.req.param("alias");
    const proj = resolveProject(cfg, alias);
    if (!proj) return c.text("not found", 404);
    const flash = c.req.query("flash");
    const snap = existsSync(proj.path) ? loadSnapshot(proj.path) : null;
    const history = existsSync(proj.path) ? listSnapshots(proj.path, 8) : [];
    const body = renderTrendsPage({ alias, snap, history });
    const html = projectShell(cfg, alias, "trends", {
      title: "趋势",
      description: "HN + GitHub 技术雷达；主题将用于 AI 刷新 Roadmap。",
      body,
      flash,
      toolbar: discoverToolbar(alias),
      pipelineDone: 2,
    });
    return c.html(html ?? "not found", html ? 200 : 404);
  });

  app.get("/project/:alias/plan", (c) => {
    const cfg = getCfg();
    const alias = c.req.param("alias");
    const proj = resolveProject(cfg, alias);
    if (!proj) return c.text("not found", 404);
    const flash = c.req.query("flash");
    const section = c.req.query("section") === "plans" ? "plans" : "roadmap";
    let body = "";
    if (section === "roadmap") {
      const snap = loadSnapshot(proj.path);
      const hasRadar = Boolean(snap?.themes.length);
      const roadmap = existsSync(join(proj.path, "ROADMAP.md"))
        ? `<pre>${esc(readFileSync(join(proj.path, "ROADMAP.md"), "utf-8"))}</pre>`
        : `<div class="empty">尚无 ROADMAP.md，填写下方说明后点「重新生成」，或先跑「发现 → Roadmap」</div>`;
      body = `${renderPlanRoadmapRegenForm(alias, hasRadar)}<div class="panel">${roadmap}</div>`;
    } else {
      const dc = loadConfig(proj.path);
      const suggestedGoal =
        (existsSync(proj.path) ? recommendRoadmapGoal(proj.path) : null) ?? dc.initial_goal;
      const pending = existsSync(proj.path) ? listPendingApprovals(proj.path) : [];
      const states = existsSync(proj.path) ? listPlanStates(proj.path, 30) : [];
      const approvalRows = pending
        .map(
          (a) => `<tr>
<td><a href="/project/${encodeURIComponent(alias)}/plans/${encodeURIComponent(a.planId)}">${esc(a.planId)}</a></td>
<td>${esc(a.plan.title)}</td>
<td>${esc(String(a.plan.estimated_diff_lines))} 行</td>
<td>
<form class="inline" method="post" action="/approve"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(a.planId)}"/><button class="btn ok sm">批准并执行</button></form>
<form class="inline" method="post" action="/reject"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(a.planId)}"/><button class="btn err sm">拒绝</button></form>
</td></tr>`,
        )
        .join("");
      const planned = states
        .filter((s) => !pending.some((p) => p.planId === s.planId))
        .slice(0, 15)
        .map(
          (s) =>
            `<tr><td><a href="/project/${encodeURIComponent(alias)}/plans/${encodeURIComponent(s.planId)}">${esc(s.planId)}</a></td><td>${statusBadge(s.status)}</td><td>${esc(s.title)}</td></tr>`,
        )
        .join("");
      body = `${renderPlanGenerateForm(alias, suggestedGoal)}<div class="tbl-wrap"><table><thead><tr><th>Plan</th><th>标题</th><th>规模</th><th></th></tr></thead><tbody>${approvalRows || `<tr><td colspan="4" class="empty">暂无待审批</td></tr>`}</tbody></table></div>
<h2 style="margin-top:24px">历史 Plan</h2>
<div class="tbl-wrap"><table><thead><tr><th>ID</th><th>状态</th><th>标题</th></tr></thead><tbody>${planned || `<tr><td colspan="3" class="empty">无</td></tr>`}</tbody></table></div>`;
    }
    const html = projectShell(cfg, alias, "plan", {
      title: "规划",
      description: "Roadmap 定方向，Plan 定本次改什么，你审批后才执行。",
      body,
      flash,
      toolbar: planToolbar(alias, section),
      pipelineDone: 3,
      section,
    });
    return c.html(html ?? "not found", html ? 200 : 404);
  });

  app.get("/project/:alias/run", (c) => {
    const cfg = getCfg();
    const alias = c.req.param("alias");
    const proj = resolveProject(cfg, alias);
    if (!proj) return c.text("not found", 404);
    const flash = c.req.query("flash");
    const states = existsSync(proj.path) ? listPlanStates(proj.path, 40) : [];
    const runRows = states
      .filter((s) => ["executing", "pushed", "failed", "approved", "pr_opened", "merged"].includes(s.status))
      .map(
        (s) => `<tr>
<td><a href="/project/${encodeURIComponent(alias)}/plans/${encodeURIComponent(s.planId)}">${esc(s.planId)}</a></td>
<td>${statusBadge(s.status)}</td><td>${esc(s.title)}</td>
<td>${s.branch ? `<code>${esc(s.branch)}</code>` : "—"}</td>
<td class="muted">${esc((s.error ?? "").slice(0, 60))}</td></tr>`,
      )
      .join("");
    const delivered = states.filter((s) => s.prUrl || s.issueUrl);
    const prRows = delivered
      .map((s) => {
        const links = [s.prUrl ? `<a href="${esc(s.prUrl)}" target="_blank">PR</a>` : ""].filter(Boolean).join(" ");
        return `<tr><td>${esc(s.planId)}</td><td>${statusBadge(s.status)}</td><td>${links || "—"}</td><td>${esc(s.mergeStatus ?? "—")}</td></tr>`;
      })
      .join("");
    const jobs = listJobsForProject(alias, 15)
      .map(
        (j) =>
          `<tr><td><a href="/jobs/${encodeURIComponent(j.id)}/log">${esc(j.id.slice(0, 12))}…</a></td><td>${esc(j.kind)}</td><td>${statusBadge(j.status)}</td></tr>`,
      )
      .join("");
    const body = `
<div class="panel"><h2>执行记录</h2>
<div class="tbl-wrap"><table><thead><tr><th>Plan</th><th>状态</th><th>标题</th><th>分支</th><th>错误</th></tr></thead><tbody>${runRows || `<tr><td colspan="5" class="empty">暂无</td></tr>`}</tbody></table></div></div>
<div class="panel"><h2>PR / 交付</h2>
<div class="tbl-wrap"><table><thead><tr><th>Plan</th><th>状态</th><th>链接</th><th>合并</th></tr></thead><tbody>${prRows || `<tr><td colspan="4" class="empty">尚无 PR</td></tr>`}</tbody></table></div></div>
<div class="panel"><h2>后台任务</h2><p class="muted">需 <code>bun run server/index.ts</code> 才有 Worker 消费队列。</p>
<div class="tbl-wrap"><table><thead><tr><th>任务</th><th>类型</th><th>状态</th></tr></thead><tbody>${jobs || `<tr><td colspan="3" class="empty">暂无</td></tr>`}</tbody></table></div></div>`;
    const html = projectShell(cfg, alias, "run", {
      title: "运行与交付",
      description: "执行进度、队列任务、已创建的 PR。",
      body,
      flash,
      pipelineDone: 4,
    });
    return c.html(html ?? "not found", html ? 200 : 404);
  });

  app.get("/project/:alias/settings", (c) => {
    const cfg = getCfg();
    const alias = c.req.param("alias");
    const proj = resolveProject(cfg, alias);
    if (!proj) return c.text("not found", 404);
    const flash = c.req.query("flash");
    const section = c.req.query("section") === "project" ? "project" : "github";
    const dc = existsSync(proj.path) ? loadConfig(proj.path) : null;
    if (!dc) return c.text("not found", 404);
    let body = "";
    if (section === "github") {
      body = renderGithubConfigPanel(proj.path, dc, `/project/${encodeURIComponent(alias)}/github`);
    } else {
      body = `<form method="post" action="/project/${encodeURIComponent(alias)}/config" class="panel">
<label>北极星目标</label>
<textarea name="initial_goal" rows="2">${esc(dc.initial_goal)}</textarea>
<div class="row">
<div><label>趋势抓取</label><select name="discovery_enabled"><option value="1" ${dc.discovery.enabled ? "selected" : ""}>开</option><option value="0" ${!dc.discovery.enabled ? "selected" : ""}>关</option></select></div>
<div><label>批准后自动执行</label><select name="auto_execute_after_approve"><option value="1" ${dc.discovery.auto_execute_after_approve !== false ? "selected" : ""}>是</option><option value="0" ${dc.discovery.auto_execute_after_approve === false ? "selected" : ""}>否</option></select></div>
</div>
<div class="row">
<div><label>自动审批</label><select name="auto_approve_enabled"><option value="1" ${dc.auto_approve.enabled ? "selected" : ""}>开</option><option value="0" ${!dc.auto_approve.enabled ? "selected" : ""}>关</option></select></div>
<div><label>diff 行上限</label><input name="diff_lines_max" type="number" value="${esc(String(dc.auto_approve.diff_lines_max))}"/></div>
</div>
<input type="hidden" name="auto_select_goal" value="${dc.auto_select_goal ? "1" : "0"}"/>
<input type="hidden" name="loop_planning" value="${dc.loop_planning ? "1" : "0"}"/>
<input type="hidden" name="hn_limit" value="${esc(String(dc.discovery.hn_limit))}"/>
<input type="hidden" name="auto_refresh_roadmap" value="${dc.discovery.auto_refresh_roadmap ? "1" : "0"}"/>
<input type="hidden" name="auto_plan_after_refresh" value="${dc.discovery.auto_plan_after_refresh ? "1" : "0"}"/>
<button type="submit" class="btn" style="margin-top:14px">保存</button>
</form>`;
    }
    const html = projectShell(cfg, alias, "settings", {
      title: section === "github" ? "GitHub 交付" : "项目策略",
      description:
        section === "github"
          ? "配置 push、开 PR 用的 GitHub 账号与交付规则。"
          : "北极星、自动审批与发现链路开关。",
      body,
      flash,
      pipelineDone: 5,
      section,
    });
    return c.html(html ?? "not found", html ? 200 : 404);
  });

  app.get("/project/:alias/roadmap", (c) =>
    c.redirect(legacyRedirectUrl(c.req.param("alias"), "roadmap", c.req.query("flash"))),
  );

  app.get("/project/:alias/plans/:planId", (c) => {
    const cfg = getCfg();
    const alias = c.req.param("alias");
    const planId = c.req.param("planId");
    const proj = resolveProject(cfg, alias);
    if (!proj) return c.text("not found", 404);
    const detail = getPlanDetailView(proj.path, planId);
    if (!detail) return c.text("plan not found", 404);

    const st = detail.state;
    const body = renderPlanDetailPage(alias, detail);
    const html = projectShell(cfg, alias, "plan", {
      title: st?.title ?? detail.plan?.title ?? `Plan ${planId}`,
      description: detail.canApprove
        ? "确认变更范围与风险后批准。"
        : "Plan 详情、交付链路与审批操作。",
      body,
      pipelineDone: 3,
      section: "plans",
      flash: c.req.query("flash"),
    });
    return c.html(html ?? "not found", html ? 200 : 404);
  });

  app.get("/project/:alias/plans", (c) =>
    c.redirect(legacyRedirectUrl(c.req.param("alias"), "plans", c.req.query("flash"))),
  );

  app.get("/project/:alias/runs", (c) =>
    c.redirect(legacyRedirectUrl(c.req.param("alias"), "runs", c.req.query("flash"))),
  );

  app.get("/project/:alias/delivery", (c) =>
    c.redirect(legacyRedirectUrl(c.req.param("alias"), "delivery", c.req.query("flash"))),
  );

  app.get("/project/:alias/github", (c) =>
    c.redirect(legacyRedirectUrl(c.req.param("alias"), "github", c.req.query("flash"))),
  );

  app.post("/project/:alias/github", async (c) => {
    const alias = c.req.param("alias");
    const proj = resolveProject(getCfg(), alias);
    if (!proj) return c.text("not found", 404);
    const body = (await c.req.parseBody()) as Record<string, string>;
    const dc = loadConfig(proj.path);
    const err = applyVcsConfigFromBody(dc, body);
    if (err) {
      return c.redirect(
        `/project/${encodeURIComponent(alias)}/settings?section=github&flash=${encodeURIComponent(err)}`,
      );
    }
    saveConfig(proj.path, dc);
    audit("project.github.save", { alias });
    return c.redirect(
      `/project/${encodeURIComponent(alias)}/settings?section=github&flash=${encodeURIComponent("已保存 GitHub 设置")}`,
    );
  });

  app.get("/project/:alias/config", (c) =>
    c.redirect(legacyRedirectUrl(c.req.param("alias"), "config", c.req.query("flash"))),
  );

  app.post("/project/:alias/config", async (c) => {
    const cfg = getCfg();
    const alias = c.req.param("alias");
    const proj = resolveProject(cfg, alias);
    if (!proj) return c.text("not found", 404);
    const body = (await c.req.parseBody()) as Record<string, string>;
    const dc = loadConfig(proj.path);
    dc.initial_goal = String(body.initial_goal ?? dc.initial_goal).trim() || dc.initial_goal;
    dc.auto_select_goal = body.auto_select_goal === "1";
    dc.loop_planning = body.loop_planning === "1";
    dc.discovery.enabled = body.discovery_enabled === "1";
    dc.discovery.hn_limit = Number(body.hn_limit) || dc.discovery.hn_limit;
    dc.discovery.auto_refresh_roadmap = body.auto_refresh_roadmap === "1";
    dc.discovery.auto_plan_after_refresh = body.auto_plan_after_refresh === "1";
    dc.discovery.auto_execute_after_approve = body.auto_execute_after_approve === "1";
    dc.auto_approve.enabled = body.auto_approve_enabled === "1";
    dc.auto_approve.diff_lines_max = Number(body.diff_lines_max) || dc.auto_approve.diff_lines_max;
    const tc = String(body.test_command ?? "").trim();
    dc.test_command = tc || undefined;
    dc.execution_cost_limit = Number(body.execution_cost_limit) || dc.execution_cost_limit;
    saveConfig(proj.path, dc);
    audit("project.config.save", { alias });
    return c.redirect(
      `/project/${encodeURIComponent(alias)}/settings?section=project&flash=${encodeURIComponent("已保存项目配置")}`,
    );
  });

  // ---- Legacy redirects ----
  app.get("/trends", (c) => {
    const cfg = getCfg();
    const alias = c.req.query("alias") ?? Object.keys(cfg.project_aliases)[0];
    if (!alias) return c.redirect("/");
    const q = new URL(c.req.url).search;
    return c.redirect(`/project/${encodeURIComponent(alias)}/trends${q.replace(/^\?/, "?")}`);
  });
  app.get("/radar", (c) => c.redirect(`/trends${new URL(c.req.url).search}`));
  app.get("/approvals", (c) => {
    const cfg = getCfg();
    const alias = Object.keys(cfg.project_aliases)[0];
    if (!alias) return c.redirect("/");
    return c.redirect(`/project/${encodeURIComponent(alias)}/plan?section=plans`);
  });

  // ---- Global jobs ----
  app.get("/jobs/:id/log", (c) => {
    const cfg = getCfg();
    const id = c.req.param("id");
    const job = getJob(id);
    const tail = readJobLog(id) || "(无日志)";
    return c.html(
      layout({
        title: `任务日志 ${id}`,
        body: `<p class="muted">${job ? `${esc(job.kind)} · ${esc(job.project_alias)} · ${statusBadge(job.status)}` : "未知任务"}</p><pre>${esc(tail)}</pre><p><a href="/jobs">← 任务列表</a></p>`,
        systemPage: "/jobs",
        activeProject: job?.project_alias,
        cfg,
      }),
    );
  });

  app.get("/jobs", (c) => {
    const cfg = getCfg();
    const rows = listAllJobs(200)
      .map(
        (j) =>
          `<tr><td><a href="/jobs/${encodeURIComponent(j.id)}/log">${esc(j.id)}</a></td><td><a href="/project/${encodeURIComponent(j.project_alias)}/run">${esc(j.project_alias)}</a></td><td>${esc(j.kind)}</td><td>${statusBadge(j.status)}</td><td class="muted">${esc(j.created_at)}</td><td class="muted">${esc((j.error ?? "").slice(0, 80))}</td></tr>`,
      )
      .join("");
    return c.html(
      layout({
        title: "任务队列",
        body: `<table><tr><th>ID</th><th>项目</th><th>类型</th><th>状态</th><th>创建</th><th>错误</th></tr>${rows || `<tr><td colspan="6" class="muted">暂无</td></tr>`}</table>`,
        systemPage: "/jobs",
        cfg,
      }),
    );
  });

  app.post("/trigger/discover-daily", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const alias = String(body.alias ?? "");
    const cfg = getCfg();
    const path = cfg.project_aliases[alias];
    if (!path) return c.text("unknown alias", 400);
    enqueueJob({
      kind: "discover-daily",
      payload: { projectPath: path, planOnly: true },
      projectAlias: alias,
    });
    audit("dashboard.trigger", { alias, kind: "discover-daily" });
    return c.redirect(
      `/project/${encodeURIComponent(alias)}/trends?flash=${encodeURIComponent("已入队：趋势 → Roadmap → Plan")}`,
    );
  });

  app.post("/trigger/daily", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const alias = String(body.alias ?? "");
    const cfg = getCfg();
    const path = cfg.project_aliases[alias];
    if (!path) return c.text("unknown alias", 400);
    enqueueJob({
      kind: "daily",
      payload: { projectPath: path, planOnly: Boolean(body.plan_only) },
      projectAlias: alias,
    });
    audit("dashboard.trigger", { alias, kind: "daily" });
    return c.redirect(
      `/project/${encodeURIComponent(alias)}/run?flash=${encodeURIComponent("已入队 daily 任务")}`,
    );
  });

  app.post("/approve-only", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const cfg = getCfg();
    const alias = String(body.alias ?? "");
    const path = String(cfg.project_aliases[alias] ?? "");
    if (!path) return c.text("unknown alias", 400);
    decideApproval(path, String(body.planId), "approved", "dashboard");
    audit("dashboard.approve_only", { alias, planId: body.planId });
    return c.redirect(`/project/${encodeURIComponent(alias)}/plan?section=plans&flash=approved`);
  });

  app.post("/project/:alias/llm-probe", async (c) => {
    const alias = c.req.param("alias");
    const proj = resolveProject(getCfg(), alias);
    if (!proj) return c.text("not found", 404);
    applyAllLlmEnv();
    if (!hasLlmAuth()) {
      return c.redirect(
        `/project/${encodeURIComponent(alias)}/overview?flash=${encodeURIComponent("未配置模型 Key，请先在系统设置填写")}`,
      );
    }
    const probe = await probeLlmConnection();
    audit("dashboard.llm_probe", { alias, ok: probe.ok });
    const flash = probe.ok ? `✓ ${probe.detail}` : `✗ ${probe.detail}`;
    return c.redirect(
      `/project/${encodeURIComponent(alias)}/overview?probe=1&flash=${encodeURIComponent(flash.slice(0, 220))}`,
    );
  });

  app.get("/project/:alias/pipeline-check", async (c) => {
    const alias = c.req.param("alias");
    const proj = resolveProject(getCfg(), alias);
    if (!proj) return c.text("not found", 404);
    const items = runPipelineCheck(proj.path);
    if (c.req.query("probe") === "1" && hasLlmAuth(mergeLlmEnv())) {
      applyAllLlmEnv();
      const probe = await probeLlmConnection();
      return c.json({ ready: pipelineReady(applyLlmProbeResult(items, probe)), items: applyLlmProbeResult(items, probe), probe });
    }
    return c.json({ ready: pipelineReady(items), items });
  });

  app.post("/trigger/roadmap-refresh", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const alias = String(body.alias ?? "");
    const cfg = getCfg();
    const proj = resolveProject(cfg, alias);
    if (!proj) return c.text("unknown alias", 400);
    const planUrl = `/project/${encodeURIComponent(alias)}/plan?section=roadmap`;
    try {
      assertLlmAuth();
      const dc = loadConfig(proj.path);
      const scan = await scanProject(proj.path);
      const userInstructions = String(body.user_instructions ?? "").trim() || undefined;
      const useRadar = body.use_radar === "1";
      const ok = await refreshRoadmapForDashboard(proj.path, scan, dc, {
        userInstructions,
        useRadar,
      });
      audit("dashboard.roadmap_refresh", { alias, useRadar, hasInstructions: Boolean(userInstructions) });
      return c.redirect(
        `${planUrl}&flash=${encodeURIComponent(ok ? "Roadmap 已重新生成" : "内容未变化（与上一版相同）")}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.redirect(`${planUrl}&flash=${encodeURIComponent(msg.slice(0, 200))}`);
    }
  });

  app.post("/trigger/plan-generate", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const alias = String(body.alias ?? "");
    const cfg = getCfg();
    const proj = resolveProject(cfg, alias);
    if (!proj) return c.text("unknown alias", 400);
    const plansUrl = `/project/${encodeURIComponent(alias)}/plan?section=plans`;
    try {
      assertLlmAuth();
      const dc = loadConfig(proj.path);
      const goalBase =
        String(body.goal ?? "").trim() ||
        recommendRoadmapGoal(proj.path) ||
        dc.initial_goal;
      const notes = String(body.user_instructions ?? "").trim();
      const goal = notes ? `${goalBase}\n\n补充说明：${notes}` : goalBase;
      const scan = await scanProject(proj.path);
      const planRecord = await generatePlan(proj.path, scan, goal);
      if (!getApprovalRecord(proj.path, planRecord.planId)) {
        savePendingApproval(proj.path, planRecord);
      }
      audit("dashboard.plan_generate", { alias, planId: planRecord.planId });
      return c.redirect(
        `${plansUrl}&flash=${encodeURIComponent(`已生成 Plan ${planRecord.planId}，请审批`)}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.redirect(`${plansUrl}&flash=${encodeURIComponent(msg.slice(0, 200))}`);
    }
  });

  app.post("/approve", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const cfg = getCfg();
    const alias = String(body.alias ?? "");
    const path = String(cfg.project_aliases[alias] ?? "");
    if (!path) return c.text("unknown alias", 400);
    decideApproval(path, String(body.planId), "approved", "dashboard");
    enqueueJob({
      kind: "execute",
      payload: { projectPath: path, planId: String(body.planId) },
      projectAlias: alias,
    });
    audit("dashboard.approve", { alias, planId: body.planId });
    return c.redirect(`/project/${encodeURIComponent(alias)}/run?flash=${encodeURIComponent("已批准并入队执行")}`);
  });

  app.post("/trigger/retry-execute", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const cfg = getCfg();
    const alias = String(body.alias ?? "");
    const planId = String(body.planId ?? "");
    const proj = resolveProject(cfg, alias);
    if (!proj) return c.text("unknown alias", 400);
    const detailUrl = `/project/${encodeURIComponent(alias)}/plans/${encodeURIComponent(planId)}`;
    const prepared = preparePlanExecuteRetry(proj.path, planId);
    if (!prepared) {
      return c.redirect(
        `${detailUrl}?flash=${encodeURIComponent("无法重试：需为执行失败且尚无 PR")}`,
      );
    }
    enqueueJob({
      kind: "execute",
      payload: { projectPath: proj.path, planId },
      projectAlias: alias,
    });
    audit("dashboard.retry_execute", { alias, planId });
    return c.redirect(
      `/project/${encodeURIComponent(alias)}/run?flash=${encodeURIComponent(`Plan ${planId} 已重新入队执行`)}`,
    );
  });

  app.post("/reject", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const cfg = getCfg();
    const alias = String(body.alias ?? "");
    const path = String(cfg.project_aliases[alias] ?? "");
    if (!path) return c.text("unknown alias", 400);
    decideApproval(path, String(body.planId), "rejected", "dashboard");
    return c.redirect(`/project/${encodeURIComponent(alias)}/plan?section=plans`);
  });

  // ---- Settings (global) ----
  app.get("/settings", (c) => {
    const cfg = getCfg();
    const flash = c.req.query("flash");
    const aliasRows = Object.entries(cfg.project_aliases)
      .map(
        ([a, p]) => `<tr><td><a href="/project/${encodeURIComponent(a)}/overview">${esc(a)}</a></td><td class="muted"><code>${esc(String(p))}</code></td>
<td><a class="btn" href="/project/${encodeURIComponent(a)}/settings?section=github">GitHub</a></td>
<td><form class="inline" method="post" action="/settings/project/remove"><input type="hidden" name="alias" value="${esc(a)}"/><button class="btn err">移除</button></form></td></tr>`,
      )
      .join("");
    const m = cfg.claude_models ?? {};
    const settingsBody = `
<div class="panel">
<h2 style="margin-top:0">模型 / 网关 (全局)</h2>
<p class="muted" style="margin-top:0">Anthropic 兼容网关，作用于所有项目的 Agent 调用。保存 Key 只更新本节，<strong>不会</strong>添加项目。</p>
<form id="settings-models" method="post" action="/settings/models">
<datalist id="model-list">
<option value="deepseek-v4-pro"></option>
<option value="deepseek-v4-flash"></option>
<option value="claude-sonnet-4"></option>
<option value="claude-haiku-4"></option>
</datalist>
<div class="row">
<div><label>供应商预设</label><select name="model_gateway_preset">
<option value="deepseek" ${cfg.model_gateway_preset === "deepseek" ? "selected" : ""}>DeepSeek</option>
<option value="anthropic" ${cfg.model_gateway_preset === "anthropic" ? "selected" : ""}>Anthropic</option>
<option value="evotown" ${cfg.model_gateway_preset === "evotown" ? "selected" : ""}>Evotown</option>
<option value="custom" ${cfg.model_gateway_preset === "custom" ? "selected" : ""}>自定义</option>
</select></div>
<div><label>默认模型</label><input list="model-list" name="default" value="${esc(m.default ?? "")}"/></div>
</div>
<div class="row">
<div><label>Planner</label><input list="model-list" name="planner" value="${esc(m.planner ?? "")}"/></div>
<div><label>Executor</label><input list="model-list" name="executor" value="${esc(m.executor ?? "")}"/></div>
</div>
<div class="row">
<div><label>Selector</label><input list="model-list" name="selector" value="${esc(m.selector ?? "")}"/></div>
<div><label>Subagent</label><input list="model-list" name="subagent" value="${esc(m.subagent ?? "")}"/></div>
</div>
<label>Base URL</label><input name="anthropic_base_url" value="${esc(cfg.anthropic_base_url ?? "")}"/>
<div class="row">
<div><label>Auth Token</label><input name="anthropic_auth_token" type="password" autocomplete="new-password" placeholder="留空不修改"/></div>
<div><label>API Key</label><input name="anthropic_api_key" type="password" autocomplete="new-password" placeholder="留空不修改"/></div>
</div>
<button type="submit" class="btn" style="margin-top:12px">保存模型与 Key</button></form>
<form method="post" action="/settings/write-claude-settings" style="margin-top:10px">
<button type="submit" class="btn ghost">写入 ~/.claude/settings.json</button></form>
<p class="muted" style="margin:14px 0 0;font-size:12px">保存后请到 <a href="/project/${esc(Object.keys(cfg.project_aliases)[0] ?? "p7")}/overview#health">工作台 → 环境检查</a>，点「检测模型请求」验证 Key 与模型是否可用。</p>
</div>

<div class="panel">
<h2 style="margin-top:0">项目绑定</h2>
<p class="muted">绑定本地仓库路径；与上方模型 Key 无关。误点「添加项目」才会新增绑定。</p>
<table><tr><th>别名</th><th>路径</th><th>GitHub</th><th></th></tr>${aliasRows || `<tr><td colspan="4" class="muted">暂无</td></tr>`}</table>
<form id="settings-project-add" method="post" action="/settings/project/add" style="margin-top:14px">
<div class="row"><div><label>别名</label><input name="alias" placeholder="P7" autocomplete="off" required/></div>
<div><label>本地绝对路径</label><input name="path" placeholder="/Users/you/code/myapp" autocomplete="off" required/></div></div>
<button type="submit" class="btn ghost" style="margin-top:12px">添加项目（非保存 Key）</button></form>
</div>

<div class="panel">
<h2 style="margin-top:0">调度与并发</h2>
<form method="post" action="/settings/scheduler">
<div class="row">
<div><label>调度器</label><select name="scheduler_enabled"><option value="1" ${cfg.scheduler_enabled ? "selected" : ""}>开启</option><option value="0" ${!cfg.scheduler_enabled ? "selected" : ""}>关闭</option></select></div>
<div><label>最大并发项目数</label><input name="max_concurrent_projects" type="number" value="${esc(String(cfg.max_concurrent_projects))}"/></div>
</div>
<div class="row">
<div><label>每日成本上限 (USD)</label><input name="daily_cost_cap_usd" type="number" step="0.01" value="${esc(String(cfg.daily_cost_cap_usd))}"/></div>
<div><label>端口</label><input name="port" type="number" value="${esc(String(cfg.port))}"/></div>
</div>
<button type="submit" class="btn" style="margin-top:12px">保存调度设置</button></form>
</div>

<div class="panel">
<h2 style="margin-top:0">人设 (全局)</h2>
<form method="post" action="/settings/persona">
<div class="row">
<div><label>开关</label><select name="persona_enabled"><option value="1" ${cfg.persona_enabled ? "selected" : ""}>开</option><option value="0" ${!cfg.persona_enabled ? "selected" : ""}>关</option></select></div>
<div><label>文件</label><input name="persona_file" value="${esc(cfg.persona_file)}"/></div>
</div>
<button class="btn" style="margin-top:12px">保存</button></form>
</div>

<div class="panel">
<h2 style="margin-top:0">钉钉 (全局)</h2>
<form method="post" action="/settings/dingtalk">
<label>Webhook</label><input name="webhook" value="${esc(cfg.dingtalk?.webhook ?? "")}"/>
<label>Secret</label><input name="robot_secret" type="password" placeholder="留空不修改"/>
<button class="btn" style="margin-top:12px">保存</button></form>
</div>`;
    return c.html(
      layout({ title: "系统设置", body: settingsBody, flash, systemPage: "/settings", cfg }),
    );
  });

  app.post("/settings/project/add", async (c) => {
    const cfg = getCfg();
    const body = (await c.req.parseBody()) as Record<string, string>;
    const alias = String(body.alias ?? "").trim();
    const path = String(body.path ?? "").trim();
    if (!alias || !path) return c.redirect("/settings?flash=别名和路径必填");
    cfg.project_aliases = { ...cfg.project_aliases, [alias]: path };
    setCfg(cfg);
    saveServerConfig(cfg);
    return c.redirect(`/project/${encodeURIComponent(alias)}/overview?flash=${encodeURIComponent(`已添加 ${alias}`)}`);
  });

  app.post("/settings/project/remove", async (c) => {
    const cfg = getCfg();
    const body = (await c.req.parseBody()) as Record<string, string>;
    const alias = String(body.alias ?? "");
    const next = { ...cfg.project_aliases };
    delete next[alias];
    cfg.project_aliases = next;
    setCfg(cfg);
    saveServerConfig(cfg);
    return c.redirect("/settings?flash=已移除");
  });

  app.post("/settings/scheduler", async (c) => {
    const cfg = getCfg();
    const body = (await c.req.parseBody()) as Record<string, string>;
    cfg.scheduler_enabled = body.scheduler_enabled === "1";
    cfg.max_concurrent_projects = Number(body.max_concurrent_projects) || cfg.max_concurrent_projects;
    cfg.daily_cost_cap_usd = Number(body.daily_cost_cap_usd) || cfg.daily_cost_cap_usd;
    cfg.port = Number(body.port) || cfg.port;
    setCfg(cfg);
    saveServerConfig(cfg);
    return c.redirect("/settings?flash=已保存");
  });

  app.post("/settings/models", async (c) => {
    const cfg = getCfg();
    const body = (await c.req.parseBody()) as Record<string, string>;
    cfg.model_gateway_preset = String(body.model_gateway_preset || "custom");
    cfg.claude_models = {
      default: String(body.default || "") || undefined,
      planner: String(body.planner || "") || undefined,
      executor: String(body.executor || "") || undefined,
      selector: String(body.selector || "") || undefined,
      subagent: String(body.subagent || "") || undefined,
    };
    if (body.anthropic_base_url) cfg.anthropic_base_url = String(body.anthropic_base_url);
    if (body.anthropic_api_key) cfg.anthropic_api_key = String(body.anthropic_api_key);
    if (body.anthropic_auth_token) cfg.anthropic_auth_token = String(body.anthropic_auth_token);
    setCfg(cfg);
    saveServerConfig(cfg);
    writeClaudeSettings(cfg);
    const { applyAllLlmEnv } = await import("../src/llm-env.ts");
    applyAllLlmEnv();
    return c.redirect("/settings?flash=已保存并同步 Claude settings");
  });

  app.post("/settings/persona", async (c) => {
    const cfg = getCfg();
    const body = (await c.req.parseBody()) as Record<string, string>;
    cfg.persona_enabled = body.persona_enabled === "1";
    if (body.persona_file) cfg.persona_file = String(body.persona_file).trim();
    setCfg(cfg);
    saveServerConfig(cfg);
    return c.redirect("/settings?flash=已保存");
  });

  app.post("/settings/dingtalk", async (c) => {
    const cfg = getCfg();
    const body = (await c.req.parseBody()) as Record<string, string>;
    const webhook = String(body.webhook ?? "").trim();
    if (webhook) {
      cfg.dingtalk = {
        webhook,
        robot_secret: body.robot_secret ? String(body.robot_secret) : cfg.dingtalk?.robot_secret,
      };
    }
    setCfg(cfg);
    saveServerConfig(cfg);
    return c.redirect("/settings?flash=已保存");
  });

  app.post("/settings/write-claude-settings", (c) => {
    const path = writeClaudeSettings(getCfg());
    return c.redirect(`/settings?flash=${encodeURIComponent(`已写入 ${path}`)}`);
  });

  app.get("/logs", (c) => {
    const cfg = getCfg();
    const logPath = join(resolveP7HomeDir(), "server.log");
    const tail = existsSync(logPath)
      ? readFileSync(logPath, "utf-8").split("\n").slice(-300).join("\n")
      : "(empty)";
    return c.html(
      layout({ title: "审计日志", body: `<pre>${esc(tail)}</pre>`, systemPage: "/logs", cfg }),
    );
  });

  app.get("/healthz", async (c) => {
    applyAllLlmEnv();
    const env = mergeLlmEnv();
    const body: Record<string, unknown> = {
      ok: true,
      ts: new Date().toISOString(),
      llm: {
        configured: hasLlmAuth(env),
        baseUrl: env.ANTHROPIC_BASE_URL || null,
        model: env.ANTHROPIC_MODEL || env.P7_MODEL || null,
      },
    };
    if (c.req.query("probe") === "1" && hasLlmAuth(env)) {
      const probe = await probeLlmConnection(env);
      body.ok = probe.ok;
      body.llm = { ...(body.llm as object), probe };
      return c.json(body, probe.ok ? 200 : 503);
    }
    return c.json(body);
  });

  return app;
}
