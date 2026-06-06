import type { ServerConfig } from "./config.ts";
import type { ProjectActivity } from "./project-activity.ts";
import { getProjectActivity } from "./project-activity.ts";
import type { PlanDetailView } from "../src/plan-detail.ts";
import {
  planDisplayChangeDescription,
  planDisplayMotivation,
  planDisplayRisks,
  planDisplayTitle,
} from "../src/plan-i18n.ts";
import type { PipelineCheckItem } from "../src/pipeline-check.ts";
import { pipelineReady } from "../src/pipeline-check.ts";
import type { SdkTokenUsage } from "../src/sdk-cost.ts";

export const DASHBOARD_STYLE = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&display=swap');
:root{
  --bg:#0a0c10;--surface:#12151b;--surface2:#181c24;--line:#232933;
  --fg:#eceff4;--mut:#8891a0;--accent:#6b9fff;--accent-2:#8b7cf8;
  --accent-soft:rgba(107,159,255,.14);--ok:#3dd68c;--warn:#e5b567;--err:#f07178;
  --sidebar-w:228px;--radius:10px;--elev:0 1px 0 rgba(255,255,255,.04),0 8px 24px rgba(0,0,0,.28);
}
*{box-sizing:border-box}
body{margin:0;font-family:"DM Sans",-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.app-shell{display:flex;min-height:100vh}
.sidebar{width:var(--sidebar-w);flex-shrink:0;background:var(--surface);border-right:1px solid var(--line);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow:hidden}
.sidebar-head{padding:16px 14px 14px;border-bottom:1px solid var(--line)}
.sidebar-brand{display:flex;align-items:center;gap:10px;margin-bottom:14px;text-decoration:none;color:var(--fg)}
.sidebar-brand:hover{text-decoration:none;opacity:.92}
.sidebar-brand .mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;flex-shrink:0}
.sidebar-brand .text{min-width:0}
.sidebar-brand .name{display:block;font-size:14px;font-weight:700;letter-spacing:-.02em;line-height:1.2}
.sidebar-brand .tag{display:block;font-size:10px;color:var(--mut);margin-top:2px}
.proj-field label{display:block;font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--mut);margin:0 0 6px 2px}
.proj-switch-wrap{position:relative}
.proj-switch-wrap::after{content:"";pointer-events:none;position:absolute;right:12px;top:50%;margin-top:-2px;border:4px solid transparent;border-top:5px solid var(--mut)}
.proj-switch{width:100%;appearance:none;background:var(--bg);border:1px solid var(--line);color:var(--fg);border-radius:var(--radius);padding:9px 30px 9px 11px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;transition:border-color .15s}
.proj-switch:hover{border-color:rgba(107,159,255,.4)}
.proj-switch:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.sidebar-scroll{flex:1;overflow-y:auto;padding:12px 10px;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.sidebar-scroll::-webkit-scrollbar{width:4px}
.sidebar-scroll::-webkit-scrollbar-thumb{background:var(--line);border-radius:99px}
.nav-group{margin-bottom:14px}
.nav-group-title{padding:0 10px 8px;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
.nav-list{display:flex;flex-direction:column;gap:2px}
.nav-item{position:relative;display:flex;align-items:center;gap:10px;padding:8px 11px;border-radius:9px;font-size:13px;font-weight:500;color:var(--mut);text-decoration:none;transition:color .12s,background .12s}
.nav-item:hover{color:var(--fg);background:var(--surface2);text-decoration:none}
.nav-item.active,.nav-item.active-parent{color:var(--fg);font-weight:600;background:var(--accent-soft)}
.nav-item.active::before,.nav-item.active-parent::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:20px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,var(--accent),var(--accent-2))}
.nav-ico{width:18px;height:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;opacity:.75}
.nav-item.active .nav-ico,.nav-item.active-parent .nav-ico{opacity:1}
.nav-ico svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.nav-item .nav-label{flex:1}
.nav-sub{margin:2px 0 6px 28px;padding-left:10px;border-left:1px solid var(--line);display:flex;flex-direction:column;gap:1px}
.nav-sub .nav-item{padding:6px 10px;font-size:12px;gap:0}
.nav-sub .nav-item::before{display:none}
.nav-sub .nav-item.active{color:var(--accent);background:transparent;font-weight:600}
.nav-sub .nav-ico{display:none}
.sidebar-foot{padding:12px 10px 16px;border-top:1px solid var(--line)}
.sidebar-foot .nav-group-title{padding-top:0}
.sidebar-foot .nav-item{font-size:12px;padding:7px 10px}
.sidebar-activity{margin:10px 0 0;padding:8px 10px;border-radius:8px;font-size:11px;line-height:1.35;border:1px solid var(--line);background:var(--surface2)}
.sidebar-activity.running{border-color:rgba(107,159,255,.4);color:var(--accent)}
.sidebar-activity.failed{border-color:rgba(240,113,120,.35);color:var(--err)}
.sidebar-activity.idle{color:var(--mut)}
.sidebar-activity.idle-warn{border-color:rgba(229,181,103,.35);color:var(--warn)}
.sidebar-activity strong{font-weight:600;display:block;margin-bottom:2px;font-size:11px}
.activity-strip{display:flex;align-items:center;gap:12px;padding:10px 14px;margin-bottom:16px;border-radius:var(--radius);border:1px solid var(--line);background:var(--surface2);font-size:13px}
.activity-strip.running{border-color:rgba(107,159,255,.45);background:rgba(107,159,255,.08)}
.activity-strip.failed{border-color:rgba(240,113,120,.4);background:rgba(240,113,120,.06)}
.activity-strip.idle{color:var(--mut)}
.activity-strip.idle-warn{border-color:rgba(229,181,103,.4);background:rgba(229,181,103,.08);color:var(--warn)}
.activity-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--mut)}
.activity-strip.running .activity-dot{background:var(--accent);box-shadow:0 0 0 3px rgba(107,159,255,.25);animation:p7pulse 1.4s ease infinite}
.activity-strip.failed .activity-dot{background:var(--err)}
.activity-strip.idle .activity-dot{background:var(--ok)}
.activity-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.activity-main strong{font-size:13px;font-weight:600}
.activity-main .muted{font-size:12px;color:var(--mut);word-break:break-word}
@keyframes p7pulse{0%,100%{opacity:1}50%{opacity:.45}}
.main-col{flex:1;min-width:0;display:flex;flex-direction:column;min-height:100vh;background:var(--bg);background-image:radial-gradient(ellipse 80% 50% at 50% -20%,rgba(107,159,255,.08),transparent 55%)}
.content-head{padding:24px 28px 0;display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
.content-head h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.02em}
.content-head .desc{margin:6px 0 0;color:var(--mut);font-size:13px;max-width:560px;line-height:1.45}
.content-head .path{font-family:ui-monospace,monospace;font-size:11px;color:var(--mut);margin-top:8px;opacity:.8}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.content-body{padding:18px 28px 44px;max-width:1080px;width:100%;min-width:0;overflow-x:hidden}
.subnav{display:flex;gap:4px;margin-bottom:20px;padding:4px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);width:fit-content}
.subnav a{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;color:var(--mut);text-decoration:none}
.subnav a:hover{color:var(--fg);text-decoration:none}
.subnav a.active{background:var(--surface2);color:var(--fg)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:24px}
.metric{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--elev)}
.metric .n{font-size:28px;font-weight:700;letter-spacing:-.02em;line-height:1}
.metric .l{margin-top:6px;color:var(--mut);font-size:12px;font-weight:500}
.metric.warn{border-color:rgba(227,179,65,.35)}
.metric.alert{border-color:rgba(244,112,103,.35)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin-bottom:16px;box-shadow:var(--elev)}
.panel h2{margin:0 0 12px;font-size:15px;font-weight:600}
.blockers{display:flex;flex-direction:column;gap:10px}
.blocker{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;background:var(--surface2);border-radius:10px;border:1px solid var(--line)}
.blocker.fail{border-color:rgba(244,112,103,.4)}
.blocker .icon{font-size:18px;line-height:1}
.blocker .body{flex:1;min-width:0}
.blocker .body strong{display:block;font-size:13px;margin-bottom:2px}
.blocker .body span{font-size:12px;color:var(--mut)}
table{width:100%;border-collapse:collapse;font-size:13px}
table thead th{text-align:left;padding:10px 12px;color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--line)}
table tbody td{padding:12px;border-bottom:1px solid var(--line)}
table tbody tr:last-child td{border-bottom:none}
table tbody tr:hover td{background:rgba(255,255,255,.02)}
.tbl-wrap{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin-bottom:20px;box-shadow:var(--elev)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:linear-gradient(180deg,#7aabff,var(--accent));color:#fff;border:none;border-radius:var(--radius);padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;font-family:inherit;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.btn:hover{text-decoration:none;filter:brightness(1.06)}
.btn.ghost{background:var(--surface2);border:1px solid var(--line);color:var(--fg);box-shadow:none}
.btn.ghost:hover{background:var(--surface);border-color:rgba(107,159,255,.35)}
.btn.ok{background:var(--ok);color:#0a0f0d}
.btn.err{background:var(--err)}
.btn.sm{padding:6px 12px;font-size:12px;border-radius:8px}
form.inline{display:inline}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid var(--line)}
.badge.ok{color:var(--ok);background:rgba(62,207,142,.1);border-color:rgba(62,207,142,.3)}
.badge.run{color:var(--accent);background:rgba(91,141,239,.12);border-color:rgba(91,141,239,.35)}
.badge.fail{color:var(--err);background:rgba(244,112,103,.1);border-color:rgba(244,112,103,.35)}
.badge.idle{color:var(--mut)}
.badge.warn{color:var(--warn);background:rgba(227,179,65,.1);border-color:rgba(227,179,65,.35)}
input,select,textarea{background:var(--bg);border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:10px 12px;font-size:13px;width:100%;font-family:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(91,141,239,.2)}
label{display:block;margin:14px 0 6px;color:var(--mut);font-size:12px;font-weight:500}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:16px;overflow:auto;font-size:12px;line-height:1.55;max-height:min(60vh,520px);margin:0}
.muted{color:var(--mut);font-size:13px}
.audit-toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:16px;padding:16px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--elev)}
.audit-toolbar label{margin:0 0 6px;font-size:11px}
.audit-toolbar .field{min-width:140px;flex:1}
.audit-toolbar .field.narrow{max-width:120px;flex:0 1 120px}
.audit-event{font-family:ui-monospace,monospace;font-size:12px;font-weight:600}
.audit-detail{font-size:12px;color:var(--mut);line-height:1.45;word-break:break-word}
.audit-detail code{font-size:11px;color:var(--fg)}
.audit-detail summary{cursor:pointer;color:var(--accent);font-size:11px;user-select:none}
.audit-detail pre{margin:8px 0 0;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:8px;font-size:11px;max-height:160px;overflow:auto}
.pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;padding:12px 16px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}
.pager-info{font-size:13px;color:var(--mut)}
.pager-links{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pager-links .btn.disabled{opacity:.45;pointer-events:none}
.pager-num{min-width:36px;padding:6px 10px;font-size:12px;font-weight:600;text-align:center}
.pager-num.active{background:var(--accent);color:#fff;border-radius:8px}
.audit-meta{font-size:12px;color:var(--mut);margin-bottom:14px}
.flash{background:rgba(91,141,239,.12);border:1px solid rgba(91,141,239,.35);color:var(--fg);padding:12px 16px;border-radius:var(--radius);margin-bottom:18px;font-size:13px}
.flash.ok{background:rgba(62,207,142,.12);border-color:rgba(62,207,142,.45)}
.busy-banner{position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;justify-content:center;gap:12px;padding:14px 20px;background:rgba(12,16,28,.95);border-bottom:1px solid rgba(91,141,239,.5);color:var(--fg);font-size:14px;transform:translateY(-100%);transition:transform .2s;pointer-events:none}
.busy-banner.show{transform:translateY(0)}
.busy-spinner{width:18px;height:18px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:p7spin .8s linear infinite;flex-shrink:0}
@keyframes p7spin{to{transform:rotate(360deg)}}
.gh-form{display:flex;flex-direction:column;gap:18px}
.gh-status{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.gh-stat{background:var(--surface2);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px}
.gh-stat .k{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin-bottom:6px}
.gh-stat .v{font-size:13px;font-weight:500;line-height:1.4;word-break:break-all}
.gh-stat.ok{border-color:rgba(62,207,142,.35)}
.gh-stat.fail{border-color:rgba(244,112,103,.4)}
.gh-section{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--elev)}
.gh-section>h3{margin:0 0 14px;font-size:14px;font-weight:600}
.gh-section>p.section-hint{margin:-8px 0 14px;font-size:12px;color:var(--mut)}
.mode-cards{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:640px){.mode-cards{grid-template-columns:1fr}}
.mode-card{position:relative;display:block;padding:16px 16px 16px 44px;border:2px solid var(--line);border-radius:var(--radius);cursor:pointer;transition:border-color .15s,background .15s}
.mode-card:hover{border-color:var(--mut)}
.mode-card:has(input:checked){border-color:var(--accent);background:rgba(91,141,239,.1)}
.mode-card input{position:absolute;left:16px;top:18px;accent-color:var(--accent);width:16px;height:16px}
.mode-card .mode-title{display:block;font-weight:600;font-size:14px;margin-bottom:4px}
.mode-card .mode-desc{display:block;font-size:12px;color:var(--mut);line-height:1.4}
.gh-accounts-section{border-color:rgba(91,141,239,.35)}
.gh-add-box{padding:16px;border:2px solid var(--accent);border-radius:var(--radius);background:rgba(91,141,239,.08)}
.gh-add-title{font-size:15px;font-weight:700;margin:0 0 14px;color:var(--fg)}
.gh-add-box .row{margin-bottom:12px}
.gh-add-box .row:last-of-type{margin-bottom:8px}
.vcs-mode-wrap .vcs-multi-only{display:none;flex-direction:column;gap:16px;margin-top:16px}
.vcs-mode-wrap:has(input[name="vcs_mode"][value="custom"]:checked) .vcs-multi-only{display:flex}
.vcs-mode-wrap:has(input[name="vcs_mode"][value="custom"]:checked) .vcs-single-only{display:none}
.gh-single-note{margin-top:16px;padding:14px 16px;border-radius:var(--radius);border:1px solid var(--line);background:var(--surface2);font-size:13px;line-height:1.5}
.gh-single-note p{margin:0}
.gh-review-merge-box{margin-bottom:4px;padding:16px;border:2px solid rgba(62,207,142,.45);border-radius:var(--radius);background:rgba(62,207,142,.06)}
.gh-review-merge-box h4{margin:0 0 8px;font-size:14px;font-weight:700}
.gh-review-merge-box .row{margin-bottom:0}
.gh-advanced{margin-top:4px;padding-top:16px;border-top:1px solid var(--line)}
.gh-advanced summary{cursor:pointer;font-size:13px;font-weight:500;color:var(--mut);list-style:none;padding:4px 0}
.gh-advanced summary::-webkit-details-marker{display:none}
.roadmap-history{overflow:hidden;max-width:100%}
.roadmap-history summary::-webkit-details-marker{display:none}
.roadmap-history summary::before{content:"▸ ";color:var(--mut);font-size:12px}
.roadmap-history[open] summary::before{content:"▾ "}
.roadmap-backup-item{width:100%;min-width:0;max-width:100%;margin:0;border:1px solid var(--line);border-radius:8px;background:var(--surface2);overflow:hidden}
.roadmap-backup-item summary{cursor:pointer;list-style:none;padding:10px 12px;display:flex;align-items:flex-start;flex-wrap:wrap;gap:8px;min-width:0}
.roadmap-backup-item summary::-webkit-details-marker{display:none}
.roadmap-backup-item summary code{word-break:break-all;font-size:11px}
.roadmap-backup-item[open] summary{border-bottom:1px solid var(--line)}
.roadmap-body,.roadmap-backup-body{margin:0;padding:12px 14px;max-width:100%;max-height:min(42vh,360px);overflow:auto;font-size:12px;line-height:1.5;background:var(--bg);border:1px solid var(--line);border-radius:8px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.roadmap-backup-body{border:none;border-radius:0;max-height:min(38vh,320px)}
.roadmap-preview{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;max-width:100%}
.roadmap-preview li{width:100%;min-width:0;display:block;font-size:13px;line-height:1.4}
.roadmap-preview .dot{width:6px;height:6px;border-radius:50%;background:var(--accent);margin-top:7px;flex-shrink:0}
.gh-advanced[open] summary{color:var(--fg);margin-bottom:14px}
.toggle-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.toggle-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;background:var(--surface2);border:1px solid var(--line);border-radius:10px}
.toggle-item span{font-size:13px;font-weight:500}
.toggle-item select{max-width:88px;width:auto;padding:6px 10px}
.gh-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:12px 16px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);position:sticky;bottom:12px}
.gh-footer .hint{font-size:12px;color:var(--mut);max-width:360px}
.host-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.host-pill{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;background:var(--surface2);border:1px solid var(--line);border-radius:999px;font-size:12px}
.empty{padding:32px;text-align:center;color:var(--mut)}
.regen-panel{margin-bottom:18px}
.regen-panel textarea{resize:vertical;min-height:64px}
.check-row{display:flex!important;align-items:center;gap:8px;margin:12px 0 0!important;color:var(--fg)!important;font-size:13px!important;font-weight:400!important}
.check-row input{width:auto;margin:0}
.content-body:has(.plan-detail-page){max-width:1120px}
.plan-detail-page{display:flex;flex-direction:column;gap:20px;padding-bottom:8px}
.plan-crumb{font-size:12px;color:var(--mut);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.plan-crumb a{color:var(--mut);text-decoration:none}
.plan-crumb a:hover{color:var(--accent);text-decoration:none}
.plan-crumb span{opacity:.45}
.plan-hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px 24px;padding:22px 24px;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--elev)}
@media(max-width:720px){.plan-hero{grid-template-columns:1fr}}
.plan-hero-top{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:10px}
.plan-id{font-family:ui-monospace,monospace;font-size:11px;color:var(--mut);padding:4px 10px;background:var(--bg);border:1px solid var(--line);border-radius:999px}
.plan-hero-title{margin:0;font-size:clamp(18px,2.4vw,22px);font-weight:700;letter-spacing:-.03em;line-height:1.35}
.plan-hero-goal{margin:14px 0 0;font-size:13px;color:var(--mut);line-height:1.65}
.plan-hero-goal-label{display:block;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin-bottom:6px}
.plan-goal-text{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.plan-hero-aside{display:flex;flex-direction:column;align-items:flex-end;gap:12px;min-width:120px}
@media(max-width:720px){.plan-hero-aside{align-items:flex-start}}
.plan-stat-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid var(--line);grid-column:1/-1}
.plan-stat{display:inline-flex;align-items:baseline;gap:6px;padding:8px 12px;background:var(--surface2);border:1px solid var(--line);border-radius:9px;font-size:12px;color:var(--mut)}
.plan-stat b{font-size:15px;font-weight:700;color:var(--fg);font-variant-numeric:tabular-nums}
.plan-stat.warn b{color:var(--warn)}
.plan-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:20px;align-items:start}
@media(max-width:960px){.plan-detail-grid{grid-template-columns:1fr}}
.plan-main{display:flex;flex-direction:column;gap:16px}
.plan-aside{display:flex;flex-direction:column;gap:14px;position:sticky;top:16px}
@media(max-width:960px){.plan-aside{position:static}}
.plan-section{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px 20px;box-shadow:var(--elev)}
.plan-section h2{margin:0 0 14px;font-size:14px;font-weight:600;letter-spacing:-.01em}
.plan-motivation{margin:0;font-size:13px;line-height:1.7;color:var(--fg)}
.plan-empty-state{padding:24px 16px;text-align:center;color:var(--mut);font-size:13px;line-height:1.55}
.plan-empty-state p{margin:0 0 12px}
.change-list{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}
.change-item{padding:14px 16px;background:var(--surface2);border:1px solid var(--line);border-radius:10px}
.change-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}
.change-path{font-size:12px;line-height:1.45;color:var(--accent);word-break:break-word}
.change-lines{flex-shrink:0;font-size:11px;font-weight:600;color:var(--mut);padding:3px 8px;background:var(--bg);border:1px solid var(--line);border-radius:6px;font-variant-numeric:tabular-nums}
.change-desc{margin:0;font-size:12px;line-height:1.55;color:var(--mut)}
.risk-pills{display:flex;flex-wrap:wrap;gap:8px}
.risk-pill{padding:6px 12px;font-size:12px;border-radius:8px;background:rgba(240,113,120,.08);border:1px solid rgba(240,113,120,.25);color:var(--fg);line-height:1.35}
.risk-none{color:var(--mut);font-size:13px;margin:0}
.meta-tiles{display:flex;flex-direction:column;gap:8px}
.meta-tile{display:flex;flex-direction:column;gap:4px;padding:12px 14px;background:var(--surface2);border:1px solid var(--line);border-radius:10px;text-decoration:none;color:inherit;transition:border-color .12s,background .12s}
a.meta-tile:hover{border-color:rgba(107,159,255,.4);background:rgba(107,159,255,.06);text-decoration:none}
.meta-k{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
.meta-v{font-size:13px;font-weight:500;line-height:1.4;word-break:break-word}
.meta-v code{font-size:12px}
.meta-plain{padding:12px 14px;background:var(--surface2);border:1px solid var(--line);border-radius:10px}
.meta-plain .meta-v{margin-top:4px}
.plan-timeline{display:grid;gap:8px;margin:0}
.plan-timeline-row{display:flex;justify-content:space-between;gap:12px;font-size:12px}
.plan-timeline-row dt{color:var(--mut);margin:0}
.plan-timeline-row dd{margin:0;color:var(--fg);font-variant-numeric:tabular-nums}
.plan-pending-banner{padding:10px 14px;border-radius:9px;background:rgba(229,181,103,.12);border:1px solid rgba(229,181,103,.35);font-size:12px;line-height:1.45;text-align:center;max-width:220px}
@media(max-width:720px){.plan-pending-banner{max-width:none;text-align:left}}
.plan-actions-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:14px 18px;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--elev);position:sticky;bottom:12px;z-index:2}
.plan-actions-bar .actions-spacer{flex:1;min-width:12px}
.plan-section.error-panel{border-color:rgba(244,112,103,.4);background:rgba(244,112,103,.06)}
.plan-section.error-panel h2{color:var(--err)}
.plan-section.error-panel pre{margin:0;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--fg)}
.critique-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.critique-list li{padding:10px 12px;background:var(--surface2);border-radius:8px;font-size:13px;line-height:1.5;color:var(--mut)}
.account-list{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12px}
.badge.warn{color:var(--warn);background:rgba(227,179,65,.12);border-color:rgba(227,179,65,.35)}
.overview-page{display:flex;flex-direction:column;gap:18px}
.overview-themes{margin:0 0 4px}
.overview-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:800px){.overview-grid{grid-template-columns:1fr}}
.flash.warn-banner{background:rgba(229,181,103,.1);border-color:rgba(229,181,103,.4);display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.flash.warn-banner strong{color:var(--fg)}
.checks-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.check-row{display:flex;gap:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:13px;line-height:1.45}
.check-row.ok{border-color:rgba(62,207,142,.35);background:rgba(62,207,142,.06)}
.check-row.fail{border-color:rgba(244,112,103,.35);background:rgba(244,112,103,.06)}
.check-icon{width:18px;flex-shrink:0;font-weight:700;color:var(--mut)}
.check-row.ok .check-icon{color:var(--ok)}
.check-row.fail .check-icon{color:var(--err)}
.check-fix{margin-top:4px;font-size:11px;color:var(--mut)}
.health-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:14px}
.panel.next-step{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;border-color:rgba(107,159,255,.35);background:linear-gradient(135deg,rgba(107,159,255,.08),transparent)}
.panel.next-step .next-label{margin:0 0 2px;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
.panel.next-step .next-title{margin:0;font-size:15px;font-weight:600}
.panel.next-step .next-body{flex:1;min-width:160px}
.health-banner{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-radius:var(--radius);border:1px solid var(--line)}
.health-banner.ok{background:rgba(61,214,140,.08);border-color:rgba(61,214,140,.35)}
.health-banner.ok .health-icon{color:var(--ok)}
.health-banner.fail{background:rgba(240,113,120,.06);border-color:rgba(240,113,120,.35)}
.health-banner .health-icon{font-size:18px;font-weight:700;line-height:1;flex-shrink:0}
.health-banner strong{display:block;font-size:13px;margin-bottom:2px}
.health-banner span{font-size:12px;color:var(--mut)}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.panel-head h2{margin:0}
.panel-head a{font-size:12px;font-weight:600;text-decoration:none}
.recent-row td:last-child{max-width:140px}
.trends-page{display:flex;flex-direction:column;gap:18px}
.trends-hero .hero-meta{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;font-size:12px;color:var(--mut)}
.trends-hero .hero-meta span{display:flex;align-items:center;gap:6px}
.trends-hero .hero-summary{margin:0;font-size:14px;line-height:1.55;color:var(--fg)}
.theme-pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.theme-pill{padding:4px 10px;border-radius:999px;font-size:11px;font-weight:600;background:var(--accent-soft);color:var(--accent);border:1px solid rgba(107,159,255,.25)}
.trends-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:16px;align-items:start}
@media(max-width:900px){.trends-grid{grid-template-columns:1fr}}
.signal-list{display:flex;flex-direction:column;gap:8px;max-height:min(70vh,640px);overflow-y:auto;padding-right:4px}
.signal-card{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:start;padding:12px 14px;background:var(--surface2);border:1px solid var(--line);border-radius:var(--radius);text-decoration:none;color:inherit;transition:border-color .12s,background .12s}
.signal-card:hover{border-color:rgba(107,159,255,.35);background:rgba(107,159,255,.06);text-decoration:none}
.signal-card .signal-title{font-size:13px;font-weight:500;line-height:1.4;color:var(--fg)}
.signal-card .signal-score{font-size:12px;font-weight:700;color:var(--mut);font-variant-numeric:tabular-nums}
.badge.source{font-size:10px;padding:2px 8px;text-transform:uppercase;letter-spacing:.04em}
.badge.hn{color:#e8a54b;background:rgba(232,165,75,.12);border-color:rgba(232,165,75,.35)}
.badge.gh{color:#c4b5fd;background:rgba(196,181,253,.1);border-color:rgba(196,181,253,.35)}
.trends-empty{padding:28px 20px;text-align:center}
.trends-empty p{margin:0 0 14px;color:var(--mut)}
.trends-filter{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.trends-filter button{padding:5px 12px;font-size:12px;font-weight:600;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--mut);cursor:pointer;font-family:inherit}
.trends-filter button.active{background:var(--accent-soft);color:var(--fg);border-color:rgba(107,159,255,.4)}
@media(max-width:900px){
  .app-shell{flex-direction:column}
  .sidebar{width:100%;height:auto;max-height:none;position:relative}
  .content-head,.content-body{padding-left:16px;padding-right:16px}
}
.chart-wrap{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;margin-bottom:16px;box-shadow:var(--elev)}
.chart-wrap h3{margin:0 0 12px;font-size:14px;font-weight:600}
.chart-svg{width:100%;height:180px;display:block}
.chart-svg text{font-family:"DM Sans",-apple-system,system-ui,sans-serif;font-size:10px;fill:var(--mut)}
.chart-legend{display:flex;gap:16px;margin-bottom:10px;font-size:12px;flex-wrap:wrap}
.chart-legend-item{display:flex;align-items:center;gap:6px;color:var(--mut)}
.chart-legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.chart-empty{text-align:center;padding:32px 16px;color:var(--mut);font-size:13px}
`;

export type ProjectTab =
  | "overview"
  | "trends"
  | "plan"
  | "run"
  | "review"
  | "automation"
  | "vulnerabilities"
  | "settings";

export type SystemPage = "/jobs" | "/settings" | "/logs";

type NavIcon =
  | "overview"
  | "trends"
  | "plan"
  | "run"
  | "review"
  | "automation"
  | "vulnerabilities"
  | "settings"
  | "bind"
  | "jobs"
  | "logs";

const NAV_SVG: Record<NavIcon, string> = {
  overview:
    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  trends: '<svg viewBox="0 0 24 24"><path d="M4 19h16"/><path d="M7 17l3-6 3 4 4-9"/></svg>',
  plan: '<svg viewBox="0 0 24 24"><path d="M9 6h12M9 12h12M9 18h12"/><path d="M5 6h.01M5 12h.01M5 18h.01"/></svg>',
  run: '<svg viewBox="0 0 24 24"><polygon points="9,7 18,12 9,17" fill="currentColor" stroke="none"/></svg>',
  review:
    '<svg viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>',
  automation:
    '<svg viewBox="0 0 24 24"><path d="M4 13a8 8 0 0 1 14-5"/><path d="M18 4v4h-4"/><path d="M20 11a8 8 0 0 1-14 5"/><path d="M6 20v-4h4"/></svg>',
  vulnerabilities:
    '<svg viewBox="0 0 24 24"><path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.5"/><path d="M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4l1.4-1.4M17 7l1.4-1.4"/></svg>',
  bind: '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>',
  jobs: '<svg viewBox="0 0 24 24"><path d="M4 8h16M4 13h16M4 18h9"/></svg>',
  logs: '<svg viewBox="0 0 24 24"><path d="M9 7h12M9 12h12M9 17h12"/><path d="M5 7h.01M5 12h.01M5 17h.01"/></svg>',
};

function navIco(icon: NavIcon): string {
  return `<span class="nav-ico" aria-hidden="true">${NAV_SVG[icon]}</span>`;
}

function navLink(href: string, label: string, icon: NavIcon | null, cls: string): string {
  const ico = icon ? navIco(icon) : "";
  return `<a href="${href}" class="nav-item${cls}">${ico}<span class="nav-label">${esc(label)}</span></a>`;
}

const PIPELINE: {
  tab: ProjectTab;
  label: string;
  icon: NavIcon;
  subs?: { id: string; label: string }[];
}[] = [
  { tab: "overview", label: "工作台", icon: "overview" },
  { tab: "trends", label: "趋势", icon: "trends" },
  { tab: "plan", label: "规划", icon: "plan" },
  { tab: "run", label: "运行", icon: "run" },
  { tab: "review", label: "Review", icon: "review" },
  { tab: "automation", label: "健康", icon: "automation" },
  { tab: "vulnerabilities", label: "漏洞", icon: "vulnerabilities" },
  {
    tab: "settings",
    label: "设置",
    icon: "settings",
    subs: [
      { id: "github", label: "GitHub" },
      { id: "project", label: "策略" },
    ],
  },
];

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 系统设置页可见的模型下拉（原先 datalist 在部分浏览器里几乎看不到选项） */
export const MODEL_PRESET_OPTIONS: { value: string; label: string }[] = [
  { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro（质量，适合 Executor）" },
  { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash（省钱，适合 Planner/Selector）" },
  { value: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { value: "claude-haiku-4", label: "Claude Haiku 4" },
];

export function renderModelSelect(name: string, current?: string, emptyLabel = "— 同默认 —"): string {
  const cur = current ?? "";
  const inList = MODEL_PRESET_OPTIONS.some((o) => o.value === cur);
  const presetOpts = MODEL_PRESET_OPTIONS.map(
    (o) =>
      `<option value="${esc(o.value)}"${cur === o.value ? " selected" : ""}>${esc(o.label)}</option>`,
  ).join("");
  const extra =
    cur && !inList
      ? `<option value="${esc(cur)}" selected>${esc(cur)}（当前自定义）</option>`
      : "";
  const emptySelected = !cur ? " selected" : "";
  return `<select name="${esc(name)}"><option value=""${emptySelected}>${esc(emptyLabel)}</option>${extra}${presetOpts}</select>`;
}

export function renderPipelineChecksPanel(
  alias: string,
  items: PipelineCheckItem[],
): string {
  const ready = pipelineReady(items);
  const blockers = items.filter((i) => !i.ok);
  const banner = ready
    ? `<div class="health-banner ok"><span class="health-icon">✓</span><div><strong>核心环境就绪</strong><span>Git、鉴权、模型名已配置；建议完成模型连通检测后再跑 Roadmap。</span></div></div>`
    : `<div class="health-banner fail"><span class="health-icon">!</span><div><strong>${blockers.length} 项未通过</strong><span>${esc(blockers.map((b) => b.label).join("、"))}</span></div></div>`;

  const rows = items
    .map(
      (i) =>
        `<div class="check-row ${i.ok ? "ok" : "fail"}"><span class="check-icon">${i.ok ? "✓" : "!"}</span><div><strong>${esc(i.label)}</strong> — <span class="muted">${esc(i.detail)}</span>${i.fix && !i.ok ? `<div class="check-fix">${esc(i.fix)}</div>` : ""}</div></div>`,
    )
    .join("");

  return `${banner}<div class="checks-list">${rows}</div>
<div class="health-actions">
<a class="btn ghost sm" href="/project/${encodeURIComponent(alias)}/overview?refresh=1">刷新环境检查</a>
<form class="inline" method="post" action="/project/${encodeURIComponent(alias)}/llm-probe"><button type="submit" class="btn sm">检测模型请求</button></form>
<a class="btn ghost sm" href="/settings">系统设置</a>
</div>`;
}

export function overviewNextStep(opts: {
  blockers: { label: string }[];
  pending: number;
  hasSnapshot: boolean;
  signalCount: number;
  base: string;
  failureCount?: number;
}): string {
  let title: string;
  let href: string;
  let btn: string;
  if ((opts.failureCount ?? 0) > 0) {
    title = `${opts.failureCount} 项失败需处理（已自动校正僵尸状态）`;
    href = `${opts.base}/overview#stability`;
    btn = "查看失败";
  } else if (opts.blockers.length > 0) {
    title = `先解决环境项：${opts.blockers[0].label}`;
    href = `${opts.base}/overview#health`;
    btn = "查看检查";
  } else if (opts.pending > 0) {
    title = `${opts.pending} 个 Plan 等待你审批`;
    href = `${opts.base}/plan?section=plans`;
    btn = "去审批";
  } else if (!opts.hasSnapshot || opts.signalCount === 0) {
    title = "抓取今日技术趋势，作为 Roadmap 输入";
    href = `${opts.base}/trends`;
    btn = "打开趋势";
  } else {
    title = "基于雷达更新 Roadmap，或生成新 Plan";
    href = `${opts.base}/plan?section=roadmap`;
    btn = "打开规划";
  }
  return `<div class="panel next-step"><div class="next-body"><p class="next-label">建议下一步</p><p class="next-title">${esc(title)}</p></div><a class="btn" href="${href}">${esc(btn)}</a></div>`;
}

export function renderOverviewStabilityPanel(
  alias: string,
  base: string,
  pass: {
    reconciled: string[];
    abandoned: string[];
    failures: Array<{
      kind: string;
      id: string;
      title: string;
      error: string;
      updatedAt: string;
      retryable: boolean;
      retryHint: string;
      actions: string[];
      planId?: string;
    }>;
    preflightBlocking: boolean;
  },
): string {
  const notes: string[] = [];
  if (pass.reconciled.length > 0) {
    notes.push(`已将 ${pass.reconciled.length} 个假「执行中」标为失败，可重试`);
  }
  if (pass.abandoned.length > 0) {
    notes.push(`已清理 ${pass.abandoned.length} 个过期 approved Plan`);
  }
  const noteHtml = notes.length
    ? `<p class="muted" style="margin:0 0 10px;font-size:12px">${esc(notes.join("；"))}</p>`
    : "";

  if (pass.failures.length === 0 && !pass.preflightBlocking) {
    return `<div class="panel" id="stability"><div class="panel-head"><h2>稳定性</h2></div>
<p class="muted" style="margin:0">无失败 Plan / 任务；环境预检通过。</p>${noteHtml}</div>`;
  }

  const rows = pass.failures
    .map((f) => {
      const btns = f.actions
        .map((a) => {
          if (a === "retry_execute" && f.planId) {
            return `<form class="inline" method="post" action="/trigger/retry-execute"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(f.planId)}"/><button type="submit" class="btn sm">重试执行</button></form>`;
          }
          if (a === "retry_discover") {
            return `<form class="inline" method="post" action="/trigger/retry-discover"><input type="hidden" name="alias" value="${esc(alias)}"/><button type="submit" class="btn sm">重试发现</button></form>`;
          }
          if (a === "view_job") {
            return `<a class="btn sm ghost" href="/jobs/${encodeURIComponent(f.id)}/log">日志</a>`;
          }
          if (a === "view_plan" && f.planId) {
            return `<a class="btn sm ghost" href="${base}/plans/${encodeURIComponent(f.planId)}">Plan</a>`;
          }
          if (a === "reject" && f.planId) {
            return `<form class="inline" method="post" action="/reject" onsubmit="return confirm('放弃该 Plan？')"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(f.planId)}"/><button type="submit" class="btn sm ghost">放弃</button></form>`;
          }
          return "";
        })
        .filter(Boolean)
        .join(" ");
      const when = formatDateTime(f.updatedAt);
      return `<tr>
<td>${esc(f.title)}</td>
<td>${f.kind === "plan" ? planStatusBadge("failed") : jobStatusBadge("failed")}</td>
<td class="muted" style="max-width:280px;font-size:12px">${esc(f.error)}</td>
<td class="muted" style="font-size:12px">${esc(f.retryHint)}</td>
<td class="muted">${esc(when)}</td>
<td class="act">${btns}</td>
</tr>`;
    })
    .join("");

  const preflightWarn = pass.preflightBlocking
    ? `<div class="flash warn-banner" style="margin-bottom:10px"><strong>环境未就绪</strong> — 重试前请先修复下方「环境检查」中的阻塞项。</div>`
    : "";

  return `<div class="panel" id="stability"><div class="panel-head"><h2>失败与恢复</h2><a class="btn sm ghost" href="${base}/run?status=failed">全部失败任务</a></div>
${preflightWarn}${noteHtml}
<div class="tbl-wrap"><table><thead><tr><th>项</th><th>状态</th><th>原因</th><th>建议</th><th>时间</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="empty">无记录</td></tr>`}</tbody></table></div>
<p class="muted" style="margin:10px 0 0;font-size:12px">调度器对已批准 Plan 最多自动重试 3 次（间隔 2 分钟）。配置/API 类错误需先修环境再点重试。</p>
</div>`;
}

export function metricCard(value: number | string, label: string, tone?: "warn" | "alert"): string {
  const cls = tone ? ` metric ${tone}` : " metric";
  return `<div class="${cls.trim()}"><div class="n">${esc(String(value))}</div><div class="l">${esc(label)}</div></div>`;
}

export function statusBadge(status: string): string {
  const cls =
    status === "done" || status === "merged" || status === "pr_opened" || status === "approved"
      ? "ok"
      : status === "running" || status === "executing" || status === "pushed"
        ? "run"
        : status === "failed" || status === "rejected"
          ? "fail"
          : "idle";
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

export const JOB_KIND_LABELS: Record<string, string> = {
  "discover-daily": "趋势 → Roadmap",
  daily: "每日流水线",
  execute: "执行 Plan",
  "pr-review": "PR 复查",
  plan: "生成 Plan",
  quickfix: "快速修复",
  initialize: "初始化",
};

export function jobKindLabel(kind: string): string {
  return JOB_KIND_LABELS[kind] ?? kind;
}

const JOB_STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  pending: { label: "排队中", cls: "warn" },
  running: { label: "运行中", cls: "run" },
  done: { label: "已完成", cls: "ok" },
  failed: { label: "失败", cls: "fail" },
};

export function jobStatusBadge(status: string): string {
  const m = JOB_STATUS_LABELS[status];
  if (m) return `<span class="badge ${m.cls}">${esc(m.label)}</span>`;
  return statusBadge(status);
}

export function renderJobLogPage(
  job: {
    id: string;
    kind: string;
    status: string;
    project_alias: string;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    error: string | null;
    progress: string | null;
  } | null,
  logTail: string,
): string {
  if (!job) {
    return `<p class="muted">未知任务</p><pre>${esc(logTail)}</pre>`;
  }
  const active = job.status === "pending" || job.status === "running";
  const progressLine = job.progress
    ? `<p style="margin:8px 0 0"><strong>进度</strong> — ${esc(job.progress)}</p>`
    : "";
  const times = [
    job.created_at ? `创建 ${esc(new Date(job.created_at).toLocaleString("zh-CN"))}` : "",
    job.started_at ? `开始 ${esc(new Date(job.started_at).toLocaleString("zh-CN"))}` : "",
    job.finished_at ? `结束 ${esc(new Date(job.finished_at).toLocaleString("zh-CN"))}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const hint = active
    ? `<div class="flash" style="margin-bottom:14px">任务<strong>${job.status === "pending" ? "排队中" : "运行中"}</strong>：下方日志会<strong>实时追加</strong>（每 5 秒自动刷新本页）。若超过 2 分钟仍无任何新行，可能已僵死，请重启控制台后重新入队。</div>`
    : job.error
      ? `<div class="flash">${esc(job.error)}</div>`
      : "";
  const refresh = active ? `<meta http-equiv="refresh" content="5"/>` : "";
  return `${refresh}<div class="panel" style="margin-bottom:14px">
<p style="margin:0 0 8px"><strong>${esc(job.kind)}</strong> · 项目 <strong>${esc(job.project_alias)}</strong> · ${jobStatusBadge(job.status)}</p>
<p class="muted" style="margin:0;font-size:12px">${times || "—"}</p>
${progressLine}
</div>${hint}<pre>${esc(logTail || "(尚无输出，刚启动或仍在排队)")}</pre>`;
}

const PLAN_STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  pending: { label: "待审批", cls: "warn" },
  pending_approval: { label: "待审批", cls: "warn" },
  planned: { label: "已规划", cls: "idle" },
  approved: { label: "已批准", cls: "ok" },
  rejected: { label: "已拒绝", cls: "fail" },
  executing: { label: "执行中", cls: "run" },
  pushed: { label: "已推送", cls: "run" },
  pr_opened: { label: "PR 已开", cls: "ok" },
  merged: { label: "已合并", cls: "ok" },
  failed: { label: "失败", cls: "fail" },
};

export function planStatusBadge(status: string): string {
  const m = PLAN_STATUS_LABELS[status];
  if (m) return `<span class="badge ${m.cls}">${esc(m.label)}</span>`;
  return statusBadge(status);
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function formatUsd(amount?: number | null): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatTokenUsage(usage?: SdkTokenUsage | null): string {
  if (!usage) return "—";
  const total =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens;
  if (total <= 0) return "—";
  return `${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out`;
}

export function parseJobResultCost(resultJson: string | null | undefined): {
  costUsd?: number;
  tokenUsage?: SdkTokenUsage;
} {
  if (!resultJson) return {};
  try {
    const r = JSON.parse(resultJson) as {
      costUsd?: number;
      tokenUsage?: SdkTokenUsage;
      result?: { costUsd?: number; tokenUsage?: SdkTokenUsage };
    };
    if (typeof r.costUsd === "number") {
      return { costUsd: r.costUsd, tokenUsage: r.tokenUsage };
    }
    if (typeof r.result?.costUsd === "number") {
      return { costUsd: r.result.costUsd, tokenUsage: r.result.tokenUsage };
    }
  } catch {
    /* ignore */
  }
  return {};
}

/** 开始 → 结束（运行中则用当前时间） */
export function formatJobDuration(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  active: boolean,
): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return "—";
  const end = finishedAt
    ? new Date(finishedAt).getTime()
    : active
      ? Date.now()
      : start;
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function parseJobPlanId(payload: string): string | undefined {
  try {
    return (JSON.parse(payload) as { planId?: string }).planId;
  } catch {
    return undefined;
  }
}

function formatRetryEta(retryAtMs: number | null): string {
  if (!retryAtMs) return "稍后";
  const sec = Math.max(0, Math.ceil((retryAtMs - Date.now()) / 1000));
  if (sec < 60) return `${sec} 秒`;
  return `${Math.ceil(sec / 60)} 分钟`;
}

function formatCooldownMs(ms: number): string {
  if (ms <= 0) return "";
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  return `${Math.ceil(sec / 60)} 分钟`;
}

function stallRecoveryEtaLabel(
  recoveryCooldownMs: number,
  schedulerIntervalMinutes: number,
  lastRecoveryError: string | null,
): string {
  if (lastRecoveryError) {
    const short = lastRecoveryError.replace(/\s+/g, " ").slice(0, 160);
    return `自动恢复失败：${short}`;
  }
  if (recoveryCooldownMs > 0) {
    return `恢复冷却中，约 ${formatCooldownMs(recoveryCooldownMs)} 后可生成 Plan`;
  }
  return `调度器将在约 ${schedulerIntervalMinutes} 分钟内尝试生成 Plan`;
}

export function renderSidebarActivity(activity: ProjectActivity | null): string {
  if (!activity) return "";
  const { activeJob, failedPlan } = activity;
  if (activeJob) {
    const label = jobKindLabel(activeJob.kind);
    const state = activeJob.status === "pending" ? "排队" : "运行中";
    return `<div class="sidebar-activity running"><strong>${esc(label)}</strong>${esc(state)}${activeJob.progress ? ` · ${esc(activeJob.progress.slice(0, 40))}` : ""}</div>`;
  }
  if (failedPlan) {
    const hint = failedPlan.canRetryNow
      ? "等待自动重试"
      : failedPlan.attemptsUsed >= failedPlan.maxAttempts
        ? "需手动重试"
        : `${formatRetryEta(failedPlan.retryAtMs)} 后重试`;
    return `<div class="sidebar-activity failed"><strong>Plan 失败</strong>${esc(hint)}</div>`;
  }
  if (!activity.schedulerEnabled) {
    return `<div class="sidebar-activity idle">调度器已关闭</div>`;
  }
  if (activity.pipelineStall) {
    const eta = stallRecoveryEtaLabel(
      activity.pipelineStall.recoveryCooldownMs,
      activity.schedulerIntervalMinutes,
      activity.pipelineStall.lastRecoveryError,
    );
    return `<div class="sidebar-activity idle-warn"><strong>管道停滞</strong>${esc(eta)}</div>`;
  }
  return `<div class="sidebar-activity idle">系统空闲</div>`;
}

export function renderActivityStrip(alias: string, activity: ProjectActivity | null): string {
  if (!activity) return "";
  const { activeJob, failedPlan, schedulerEnabled, schedulerIntervalMinutes } = activity;
  const intervalLabel = `${schedulerIntervalMinutes} 分钟`;

  if (activeJob) {
    const planId = parseJobPlanId(activeJob.payload);
    const duration = formatJobDuration(
      activeJob.started_at,
      activeJob.finished_at,
      activeJob.status === "running",
    );
    const label = jobKindLabel(activeJob.kind);
    const progress = activeJob.progress ? ` · ${activeJob.progress}` : "";
    const runLink =
      activeJob.kind === "execute"
        ? `/project/${encodeURIComponent(alias)}/run`
        : `/jobs/${encodeURIComponent(activeJob.id)}/log`;
    return `<div class="activity-strip running">
<span class="activity-dot" aria-hidden="true"></span>
<div class="activity-main">
<strong>${esc(label)} · ${activeJob.status === "pending" ? "排队中" : esc(duration)}</strong>
<span class="muted">${planId ? `Plan ${esc(planId)}` : esc(activeJob.id)}${esc(progress)}</span>
</div>
<a class="btn sm" href="${runLink}">查看进度</a>
</div>`;
  }

  if (failedPlan) {
    const retryHint = failedPlan.canRetryNow
      ? `调度器将在约 ${intervalLabel} 内自动重试`
      : failedPlan.attemptsUsed >= failedPlan.maxAttempts
        ? `已自动重试 ${failedPlan.attemptsUsed} 次，请在 Plan 详情点「重试执行」或换 Plan`
        : `约 ${formatRetryEta(failedPlan.retryAtMs)} 后自动重试（${failedPlan.attemptsUsed}/${failedPlan.maxAttempts}）`;
    return `<div class="activity-strip failed">
<span class="activity-dot" aria-hidden="true"></span>
<div class="activity-main">
<strong>Plan 执行失败 · 仍已批准</strong>
<span class="muted">${esc(failedPlan.title.slice(0, 80))}</span>
<span class="muted">${esc(failedPlan.error.slice(0, 120))}</span>
<span class="muted">${esc(retryHint)}</span>
</div>
<a class="btn sm ghost" href="/project/${encodeURIComponent(alias)}/plans/${encodeURIComponent(failedPlan.planId)}">Plan 详情</a>
<a class="btn sm" href="/project/${encodeURIComponent(alias)}/run">运行页</a>
</div>`;
  }

  if (!schedulerEnabled) {
    return `<div class="activity-strip idle-warn"><span class="activity-dot warn"></span><div class="activity-main"><strong>调度器已关闭</strong><span class="muted">不会自动 discover / execute</span></div></div>`;
  }

  if (activity.pipelineStall) {
    const goal = activity.pipelineStall.suggestedGoal?.slice(0, 72) ?? "下一 Roadmap 步骤";
    const eta = stallRecoveryEtaLabel(
      activity.pipelineStall.recoveryCooldownMs,
      schedulerIntervalMinutes,
      activity.pipelineStall.lastRecoveryError,
    );
    const title = activity.pipelineStall.lastRecoveryError
      ? "管道停滞 · 自动恢复失败"
      : activity.pipelineStall.blockers.length > 0
        ? "管道停滞 · 等待条件"
        : "管道停滞 · 将自动恢复";
    const blockers =
      activity.pipelineStall.blockers.length > 0
        ? `<span class="muted">阻塞：${esc(activity.pipelineStall.blockers.join("；"))}</span>`
        : "";
    return `<div class="activity-strip idle-warn"><span class="activity-dot warn"></span><div class="activity-main"><strong>${title}</strong><span class="muted">Roadmap 尚有 ${activity.pipelineStall.unfinishedSteps} 项未完成；下一目标「${esc(goal)}」；${esc(eta)}</span>${blockers}</div><a class="btn sm ghost" href="/project/${encodeURIComponent(alias)}/plan">规划</a></div>`;
  }

  return `<div class="activity-strip idle"><span class="activity-dot ok"></span><div class="activity-main"><strong>系统空闲</strong><span class="muted">调度器每 ${esc(intervalLabel)} 巡检；无 OPEN PR 阻塞且无运行中任务时自动启动</span></div><a class="btn sm ghost" href="/jobs">任务队列</a></div>`;
}

function formatPlanTime(iso?: string): string {
  return formatDateTime(iso);
}

function complexityLabel(c?: string): string {
  if (c === "simple") return "简单";
  if (c === "medium") return "中等";
  if (c === "complex") return "复杂";
  return "—";
}

export function mergeStatusLabel(s?: string): string {
  if (s === "merged") return "已合并";
  if (s === "queued") return "排队中";
  if (s === "failed") return "失败";
  if (s === "skipped") return "已跳过";
  if (s === "not_requested") return "未请求";
  return s ? s : "—";
}

export function prMergeableBadge(mergeable: string, mergeStateStatus: string): string {
  if (mergeable === "MERGEABLE" && mergeStateStatus === "CLEAN") {
    return `<span class="badge ok">可合并</span>`;
  }
  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
    return `<span class="badge fail">冲突</span>`;
  }
  if (mergeStateStatus === "BEHIND") {
    return `<span class="badge warn">落后 base</span>`;
  }
  return `<span class="badge idle">${esc(mergeable || mergeStateStatus || "—")}</span>`;
}

export function renderReviewPage(opts: {
  alias: string;
  dc: {
    vcs: {
      review_open_prs?: boolean;
      pr_review_interval_minutes?: number;
      pr_review_fast_interval_minutes?: number;
      pr_review_only_p7_label?: boolean;
      auto_review?: boolean;
      auto_merge?: boolean;
      merge_resolve_conflicts?: boolean;
      labels: string[];
    };
  };
  openPrs: Array<{
    number: number;
    url: string;
    title: string;
    headRefName: string;
    labels: string[];
    mergeable: string;
    mergeStateStatus: string;
  }>;
  planPrRows: Array<{
    planId: string;
    title: string;
    status: string;
    prUrl?: string;
    mergeStatus?: string;
    branch?: string;
    error?: string;
  }>;
  planPrPage: number;
  planPrPageSize: number;
  planPrTotal: number;
  refreshGh?: boolean;
  reviewJobs: Array<{
    id: string;
    kind: string;
    status: string;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    progress: string | null;
    error: string | null;
  }>;
  reviewJobPage: number;
  reviewJobPageSize: number;
  reviewJobTotal: number;
  ghReady: boolean;
  prListLive?: boolean;
  workGate?: { blocked: boolean; reason: string };
}): string {
  const v = opts.dc.vcs;
  const schedOn = v.review_open_prs !== false;
  const base = `/project/${encodeURIComponent(opts.alias)}`;
  const configLine = [
    schedOn
      ? `自动复查：有 OPEN PR 每 ${v.pr_review_fast_interval_minutes ?? 8} 分钟，否则每 ${v.pr_review_interval_minutes ?? 15} 分钟`
      : "定时复查：关闭",
    v.auto_review !== false ? "自动 comment/approve" : "仅手动 review",
    v.auto_merge ? "自动合并" : "不自动合并",
    v.merge_resolve_conflicts !== false ? "冲突自动修复" : "冲突不自动修",
    v.pr_review_only_p7_label !== false ? `仅标签 ${v.labels[0] ?? "p7"}` : "全部 OPEN PR",
  ].join(" · ");

  const openRows = opts.openPrs
    .map(
      (pr) =>
        `<tr>
<td><a href="${esc(pr.url)}" target="_blank">#${pr.number}</a></td>
<td>${esc(pr.title)}</td>
<td><code>${esc(pr.headRefName)}</code></td>
<td class="muted">${esc(pr.labels.join(", ") || "—")}</td>
<td>${prMergeableBadge(pr.mergeable, pr.mergeStateStatus)}</td>
<td><a class="btn ghost sm" href="${esc(pr.url)}" target="_blank">GitHub</a></td>
</tr>`,
    )
    .join("");

  const planRows = opts.planPrRows
    .map(
      (s) =>
        `<tr>
<td><a href="${base}/plans/${encodeURIComponent(s.planId)}">${esc(s.planId)}</a></td>
<td>${statusBadge(s.status)}</td>
<td>${esc(s.title)}</td>
<td>${s.prUrl ? `<a href="${esc(s.prUrl)}" target="_blank">PR</a>` : "—"}</td>
<td>${esc(mergeStatusLabel(s.mergeStatus))}</td>
<td class="muted">${esc((s.error ?? "").slice(0, 48))}</td>
</tr>`,
    )
    .join("");

  const planPrTotalPages = Math.max(1, Math.ceil(opts.planPrTotal / opts.planPrPageSize));
  const planPrPage = Math.min(Math.max(1, opts.planPrPage), planPrTotalPages);
  const planPrStart = opts.planPrTotal === 0 ? 0 : (planPrPage - 1) * opts.planPrPageSize + 1;
  const planPrEnd = Math.min(opts.planPrTotal, planPrPage * opts.planPrPageSize);
  const pageHref = (page: number) =>
    `${base}/review?${[
      opts.refreshGh ? "refresh=1" : "",
      `prPage=${page}`,
    ].filter(Boolean).join("&")}`;
  const planPrPager =
    opts.planPrTotal > opts.planPrPageSize
      ? `<div class="pager" style="display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:10px">
<span class="muted">第 ${planPrStart}-${planPrEnd} 条 / 共 ${opts.planPrTotal} 条</span>
${planPrPage > 1 ? `<a class="btn ghost sm" href="${pageHref(planPrPage - 1)}">上一页</a>` : `<button class="btn ghost sm" disabled>上一页</button>`}
<span class="muted">${planPrPage} / ${planPrTotalPages}</span>
${planPrPage < planPrTotalPages ? `<a class="btn ghost sm" href="${pageHref(planPrPage + 1)}">下一页</a>` : `<button class="btn ghost sm" disabled>下一页</button>`}
</div>`
      : opts.planPrTotal > 0
        ? `<p class="muted" style="text-align:right;margin:10px 0 0">共 ${opts.planPrTotal} 条</p>`
        : "";

  const jobRows = opts.reviewJobs
    .map(
      (j) =>
        `<tr>
<td><a href="/jobs/${encodeURIComponent(j.id)}/log">${esc(j.id.slice(0, 12))}…</a></td>
<td>${esc(jobKindLabel(j.kind))}</td>
<td>${jobStatusBadge(j.status)}</td>
<td class="muted">${esc(j.progress ?? "—")}</td>
<td class="muted">${esc(new Date(j.created_at).toLocaleString("zh-CN"))}</td>
</tr>`,
    )
    .join("");
  const reviewJobTotalPages = Math.max(1, Math.ceil(opts.reviewJobTotal / opts.reviewJobPageSize));
  const reviewJobPage = Math.min(Math.max(1, opts.reviewJobPage), reviewJobTotalPages);
  const reviewJobPageHref = (page: number) =>
    `${base}/review?${[
      opts.refreshGh ? "refresh=1" : "",
      opts.planPrPage > 1 ? `prPage=${opts.planPrPage}` : "",
      `reviewJobPage=${page}`,
    ].filter(Boolean).join("&")}`;
  const reviewJobPager =
    opts.reviewJobTotal > opts.reviewJobPageSize
      ? `<div class="pager" style="display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:10px">
<span class="muted">共 ${opts.reviewJobTotal} 条 · 第 ${reviewJobPage} / ${reviewJobTotalPages} 页</span>
${reviewJobPage > 1 ? `<a class="btn ghost sm" href="${reviewJobPageHref(reviewJobPage - 1)}">上一页</a>` : `<span class="btn ghost sm disabled">上一页</span>`}
${reviewJobPage < reviewJobTotalPages ? `<a class="btn ghost sm" href="${reviewJobPageHref(reviewJobPage + 1)}">下一页</a>` : `<span class="btn ghost sm disabled">下一页</span>`}
</div>`
      : opts.reviewJobTotal > 0
        ? `<p class="muted" style="text-align:right;margin:10px 0 0">共 ${opts.reviewJobTotal} 条</p>`
        : "";

  const ghWarn = opts.ghReady
    ? ""
    : `<div class="flash warn-banner">未检测到可用的 <code>gh</code> 登录，Review 无法执行。请先在 <a href="${base}/settings?section=github">GitHub 设置</a> 完成配置。</div>`;

  const gateBanner =
    opts.workGate?.blocked
      ? `<div class="flash warn-banner"><strong>新任务已暂停</strong> — ${esc(opts.workGate.reason)}。请先点「立即复查 OPEN PR」或到 GitHub 合并/解决冲突，再开 Roadmap / 执行。</div>`
      : "";

  return `${ghWarn}${gateBanner}
<div class="health-banner ${schedOn ? "ok" : "fail"}"><span class="health-icon">${schedOn ? "✓" : "!"}</span><div><strong>历史 PR 复查</strong><span>${esc(configLine)}</span></div></div>
<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0">
<form class="inline p7-busy-form" data-busy-msg="已入队 PR 复查…" method="post" action="/trigger/pr-review"><input type="hidden" name="alias" value="${esc(opts.alias)}"/><button type="submit" class="btn" ${opts.ghReady ? "" : "disabled"}>立即复查 OPEN PR</button></form>
<a class="btn ghost" href="${base}/review?refresh=1">刷新 PR 列表</a>
<a class="btn ghost" href="${base}/settings?section=github">调整 Review / 合并策略</a>
</div>
<div class="panel"><h2>GitHub 上的 OPEN PR</h2>
<p class="muted">${opts.prListLive ? "来自 <code>gh pr list</code>；复查任务会对每个 PR 自动 review，并在开启自动合并时尝试合并、修复冲突。" : "打开页面时不调用 GitHub。点「刷新 PR 列表」获取最新 OPEN PR；执行任务时会自动拉取。"}</p>
<div class="tbl-wrap"><table><thead><tr><th>PR</th><th>标题</th><th>分支</th><th>标签</th><th>合并状态</th><th></th></tr></thead><tbody>${openRows || `<tr><td colspan="6" class="empty">${opts.prListLive ? "暂无 OPEN PR" : "未刷新 — 点上方「刷新 PR 列表」"}</td></tr>`}</tbody></table></div></div>
<div class="panel"><h2>Plan 关联的 PR</h2>
<div class="tbl-wrap"><table><thead><tr><th>Plan</th><th>状态</th><th>标题</th><th>链接</th><th>合并</th><th>备注</th></tr></thead><tbody>${planRows || `<tr><td colspan="6" class="empty">尚无关联 PR</td></tr>`}</tbody></table></div>${planPrPager}</div>
<div class="panel"><h2>Review 任务</h2>
<p class="muted"><code>pr-review</code> 运行期间，同项目的 Roadmap（discover-daily）与 Plan 执行会排队等待，避免与修冲突抢仓库。</p>
<div class="tbl-wrap"><table><thead><tr><th>任务</th><th>类型</th><th>状态</th><th>进度</th><th>创建</th></tr></thead><tbody>${jobRows || `<tr><td colspan="5" class="empty">暂无 Review 任务</td></tr>`}</tbody></table></div>${reviewJobPager}</div>`;
}

function shortLinkLabel(url: string, kind: "pr" | "issue" | "review"): string {
  if (kind === "pr") {
    const m = url.match(/pull\/(\d+)/i);
    if (m) return `PR #${m[1]}`;
  }
  if (kind === "issue") {
    const m = url.match(/issues\/(\d+)/i);
    if (m) return `Issue #${m[1]}`;
  }
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.slice(0, 40) + (u.pathname.length > 40 ? "…" : "");
  } catch {
    return url.length > 48 ? `${url.slice(0, 48)}…` : url;
  }
}

function planStatChip(
  value: string | number,
  label: string,
  tone?: "warn",
): string {
  return `<span class="plan-stat${tone ? ` ${tone}` : ""}"><b>${esc(String(value))}</b> ${esc(label)}</span>`;
}

function renderMetaTile(label: string, valueHtml: string, href?: string): string {
  const inner = `<span class="meta-k">${esc(label)}</span><span class="meta-v">${valueHtml}</span>`;
  return href
    ? `<a class="meta-tile" href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>`
    : `<div class="meta-plain">${inner}</div>`;
}

export function renderPlanDetailPage(alias: string, detail: PlanDetailView): string {
  const base = `/project/${encodeURIComponent(alias)}`;
  const planId = detail.planId;
  const st = detail.state;
  const p = detail.plan;
  const title = st?.title ?? (p ? planDisplayTitle(p) : undefined) ?? `Plan ${planId}`;

  const statRow = p
    ? `<div class="plan-stat-row">
${planStatChip(p.changes.length, "文件")}
${planStatChip(p.estimated_diff_lines, "估算行数", p.estimated_diff_lines > 120 ? "warn" : undefined)}
${planStatChip(complexityLabel(p.complexity), "复杂度")}
${planStatChip(p.validation, "验证")}
</div>`
    : "";

  let changesBlock = "";
  if (p && p.changes.length > 0) {
    const items = p.changes
      .map(
        (ch) =>
          `<li class="change-item"><div class="change-head"><code class="change-path">${esc(ch.file)}</code><span class="change-lines">${esc(String(ch.estimated_lines))} 行</span></div><p class="change-desc">${esc(planDisplayChangeDescription(ch))}</p></li>`,
      )
      .join("");
    changesBlock = `<section class="plan-section"><h2>变更清单 <span class="muted" style="font-weight:500;font-size:12px">共 ${p.changes.length} 项</span></h2><ul class="change-list">${items}</ul></section>`;
  } else if (!p) {
    changesBlock = `<section class="plan-section"><h2>变更清单</h2><div class="plan-empty-state"><p>该 Plan 未保留详细变更列表。</p><a class="btn ghost sm" href="${base}/review">查看 Review / PR</a></div></section>`;
  }

  const motivationBlock = p?.motivation
    ? `<section class="plan-section"><h2>动机</h2><p class="plan-motivation">${esc(planDisplayMotivation(p))}</p></section>`
    : "";

  const displayRisks = p ? planDisplayRisks(p) : [];
  const risksBlock = p
    ? `<section class="plan-section"><h2>风险 ${
        displayRisks.length > 0 ? `<span class="muted" style="font-weight:500;font-size:12px">${displayRisks.length} 条</span>` : ""
      }</h2>${
        displayRisks.length > 0
          ? `<div class="risk-pills">${displayRisks.map((r) => `<span class="risk-pill">${esc(r)}</span>`).join("")}</div>`
          : `<p class="risk-none">未标注风险</p>`
      }</section>`
    : "";

  const critiqueBlock =
    p?.critique_notes && p.critique_notes.length > 0
      ? `<section class="plan-section"><h2>评审备注</h2><ul class="critique-list">${p.critique_notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></section>`
      : "";

  const metaTiles: string[] = [];
  if (st?.branch) {
    metaTiles.push(renderMetaTile("分支", `<code>${esc(st.branch)}</code>`));
  }
  if (st?.commitSha) {
    metaTiles.push(renderMetaTile("提交", `<code>${esc(st.commitSha)}</code>`));
  }
  if (st?.prUrl) {
    metaTiles.push(
      renderMetaTile(
        "Pull Request",
        `${esc(shortLinkLabel(st.prUrl, "pr"))} ↗`,
        st.prUrl,
      ),
    );
  }
  if (st?.issueUrl) {
    metaTiles.push(
      renderMetaTile(
        "Issue",
        `${esc(shortLinkLabel(st.issueUrl, "issue"))} ↗`,
        st.issueUrl,
      ),
    );
  }
  if (st?.reviewUrl) {
    metaTiles.push(
      renderMetaTile(
        "Compare",
        `${esc(shortLinkLabel(st.reviewUrl, "review"))} ↗`,
        st.reviewUrl,
      ),
    );
  }
  if (st?.mergeStatus) {
    metaTiles.push(
      renderMetaTile("合并", esc(mergeStatusLabel(st.mergeStatus))),
    );
  }

  const deliveryPanel =
    metaTiles.length > 0
      ? `<section class="plan-section"><h2>交付</h2><div class="meta-tiles">${metaTiles.join("")}</div>${
          st?.accountResults && st.accountResults.length > 0
            ? `<ul class="account-list">${st.accountResults
                .map((a) => {
                  const link = a.prUrl
                    ? `<a href="${esc(a.prUrl)}" target="_blank" rel="noopener">${esc(shortLinkLabel(a.prUrl, "pr"))}</a>`
                    : "—";
                  return `<li><strong>${esc(a.accountId)}</strong> · ${a.ok ? "成功" : "失败"} · ${link}</li>`;
                })
                .join("")}</ul>`
            : ""
        }</section>`
      : `<section class="plan-section"><h2>交付</h2><p class="muted" style="margin:0;font-size:13px">尚无分支、提交或 PR。</p></section>`;

  const timelinePanel = `<section class="plan-section"><h2>时间线</h2>
<dl class="plan-timeline">
<div class="plan-timeline-row"><dt>创建</dt><dd>${esc(formatPlanTime(st?.createdAt))}</dd></div>
<div class="plan-timeline-row"><dt>更新</dt><dd>${esc(formatPlanTime(st?.updatedAt))}</dd></div>
</dl></section>`;

  const errorPanel = st?.error
    ? `<section class="plan-section error-panel"><h2>错误</h2><pre>${esc(st.error)}</pre></section>`
    : "";

  const bpEvents = (st as unknown as Record<string, unknown>)?.backpressureEvents as
    | Array<{ type: string; timestamp: string; detail: string }>
    | undefined;
  let backpressurePanel: string;
  if (bpEvents && bpEvents.length > 0) {
    const cards = bpEvents
      .map(
        (ev) =>
          `<div class="blocker" style="margin-bottom:8px">
<div style="display:flex;align-items:flex-start;gap:10px;width:100%">
<span class="badge ${ev.type === "cost_limit_hit" ? "fail" : ev.type === "degradation" ? "warn" : "run"}" style="flex-shrink:0;margin-top:2px">${esc(ev.type)}</span>
<div style="flex:1;min-width:0">
<div style="font-size:12px;color:var(--mut);margin-bottom:2px">${esc(formatDateTime(ev.timestamp))}</div>
<div style="font-size:13px;line-height:1.45">${esc(ev.detail.slice(0, 280))}</div>
</div>
</div>
</div>`,
      )
      .join("");
    backpressurePanel = `<section class="plan-section"><h2>背压事件 <span class="muted" style="font-weight:500;font-size:12px">${bpEvents.length} 条</span></h2>${cards}</section>`;
  } else {
    backpressurePanel = `<section class="plan-section"><h2>背压事件</h2><p class="muted" style="margin:0;font-size:13px">该 Plan 尚无背压事件记录。</p></section>`;
  }

  const pendingBanner = detail.canApprove
    ? `<div class="plan-pending-banner">待确认范围与风险后再批准</div>`
    : "";

  const retryAction = detail.canRetryExecute
    ? `<form class="inline" method="post" action="/trigger/retry-execute"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(planId)}"/><button class="btn ok">重试执行</button></form>`
    : st?.prUrl && st?.error
      ? `<span class="muted" style="font-size:13px">已有 PR，无需重试</span>`
      : "";

  const actions = detail.canApprove
    ? `<form class="inline" method="post" action="/approve"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(planId)}"/><button class="btn ok">批准并执行</button></form>
<form class="inline" method="post" action="/approve-only"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(planId)}"/><button class="btn ghost">仅批准</button></form>
<form class="inline" method="post" action="/reject"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(planId)}"/><button class="btn err">拒绝</button></form>`
    : retryAction;

  return `<div class="plan-detail-page">
<nav class="plan-crumb"><a href="${base}/plan?section=plans">← Plan 审批</a><span>/</span><span class="plan-id" style="border:none;padding:0;background:transparent">${esc(planId)}</span></nav>

<header class="plan-hero">
<div>
<div class="plan-hero-top">${planStatusBadge(detail.status)}</div>
<h2 class="plan-hero-title">${esc(title)}</h2>
<div class="plan-hero-goal">
<span class="plan-hero-goal-label">目标</span>
<span class="plan-goal-text" title="${esc(detail.goal)}">${esc(detail.goal)}</span>
</div>
${statRow}
</div>
<div class="plan-hero-aside">${pendingBanner}</div>
</header>

<div class="plan-detail-grid">
<div class="plan-main">
${motivationBlock}
${changesBlock}
${risksBlock}
${critiqueBlock}
${errorPanel}
${backpressurePanel}
</div>
<aside class="plan-aside">
${deliveryPanel}
${timelinePanel}
</aside>
</div>

<div class="plan-actions-bar">
${actions}
<span class="actions-spacer"></span>
<a class="btn ghost sm" href="${base}/plan?section=plans">返回列表</a>
<a class="btn ghost sm" href="${base}/run">运行</a>
<a class="btn ghost sm" href="${base}/review">Review</a>
</div>
</div>`;
}

export function resolveProject(
  cfg: ServerConfig,
  alias: string,
): { alias: string; path: string } | null {
  const path = cfg.project_aliases[alias];
  if (!path) return null;
  return { alias, path: String(path) };
}

export function firstProjectAlias(cfg: ServerConfig): string | undefined {
  return Object.keys(cfg.project_aliases)[0];
}

function projectSwitcher(cfg: ServerConfig, current: string): string {
  const aliases = Object.keys(cfg.project_aliases);
  if (aliases.length === 0) {
    return `<a href="/settings" class="btn sm" style="width:100%;justify-content:center">系统设置</a>`;
  }
  const opts = aliases
    .map(
      (a) =>
        `<option value="${esc(a)}"${a === current ? " selected" : ""}>${esc(a)}</option>`,
    )
    .join("");
  return `<div class="proj-field"><label>项目</label><div class="proj-switch-wrap"><select class="proj-switch" aria-label="切换项目" onchange="if(this.value)location.href='/project/'+encodeURIComponent(this.value)+'/overview'">${opts}</select></div></div>`;
}

function projectNav(alias: string, activeTab?: ProjectTab, section?: string): string {
  const base = `/project/${encodeURIComponent(alias)}`;
  const items = PIPELINE.map((p) => {
    const href = `${base}/${p.tab}`;
    const isActive = activeTab ? p.tab === activeTab : false;
    const hasActiveSub = isActive && p.subs?.some((s) => s.id === section);
    let sub = "";
    if (p.subs?.length && isActive) {
      sub = `<div class="nav-sub">${p.subs
        .map((s) => {
          const subHref = `${base}/${p.tab}?section=${s.id}`;
          return `<a href="${subHref}" class="nav-item${section === s.id ? " active" : ""}"><span class="nav-label">${esc(s.label)}</span></a>`;
        })
        .join("")}</div>`;
    }
    const parentCls =
      isActive && !hasActiveSub && !section
        ? " active"
        : isActive
          ? " active-parent"
          : "";
    return `${navLink(href, p.label, p.icon, parentCls)}${sub}`;
  }).join("");
  return `<div class="nav-group"><div class="nav-group-title">菜单</div><div class="nav-list">${items}</div></div>`;
}

function systemNav(active?: SystemPage): string {
  const items: { href: SystemPage; label: string; icon: NavIcon }[] = [
    { href: "/settings", label: "系统设置", icon: "bind" },
    { href: "/jobs", label: "任务队列", icon: "jobs" },
    { href: "/logs", label: "审计日志", icon: "logs" },
  ];
  return `<div class="nav-group"><div class="nav-group-title">系统</div><div class="nav-list">${items.map((it) => navLink(it.href, it.label, it.icon, active === it.href ? " active" : "")).join("")}</div></div>`;
}

function renderSidebar(
  cfg: ServerConfig | undefined,
  opts: {
    activeProject?: string;
    projectTab?: ProjectTab;
    section?: string;
    systemPage?: SystemPage;
    activity?: ProjectActivity | null;
  },
): string {
  const aliases = cfg ? Object.keys(cfg.project_aliases) : [];
  const projectAlias = opts.activeProject ?? aliases[0];

  const head = `<div class="sidebar-head">
<a href="/" class="sidebar-brand"><span class="mark">P7</span><span class="text"><span class="name">P7</span><span class="tag">发现 → PR</span></span></a>
${cfg && aliases.length > 0 && projectAlias ? projectSwitcher(cfg, projectAlias) : ""}
${opts.activity ? renderSidebarActivity(opts.activity) : ""}
</div>`;

  const scroll = `<div class="sidebar-scroll">
${cfg && projectAlias ? projectNav(projectAlias, opts.projectTab, opts.section) : cfg && !aliases.length ? `<p class="muted" style="padding:8px 10px;font-size:12px">请先绑定项目</p>` : ""}
</div>`;

  return `${head}${scroll}<div class="sidebar-foot">${systemNav(opts.systemPage)}</div>`;
}

/** 内容区横向 Tab（规划 / 运行页等） */
export function pageTabs(
  alias: string,
  page: "plan" | "run",
  active: string,
): string {
  const base = `/project/${encodeURIComponent(alias)}/${page}`;
  const items =
    page === "plan"
      ? [
          { id: "roadmap", label: "Roadmap" },
          { id: "plans", label: "Plan 审批" },
        ]
      : page === "run"
        ? [
            { id: "executions", label: "执行记录" },
            { id: "delivery", label: "PR / 交付" },
            { id: "jobs", label: "后台任务" },
          ]
        : [];
  const aria =
    page === "plan" ? "规划页分类" : page === "run" ? "运行页分类" : "页面分类";
  return `<nav class="subnav" aria-label="${aria}">${items
    .map(
      (i) =>
        `<a href="${base}?section=${esc(i.id)}" class="${active === i.id ? "active" : ""}">${esc(i.label)}</a>`,
    )
    .join("")}</nav>`;
}

/** 子页面 Tab（规划/设置内）— 侧栏已有时可省略，保留给无侧栏场景 */
export function subnav(alias: string, section: "plan" | "settings", active: string): string {
  return "";
}

export function layout(opts: {
  title: string;
  description?: string;
  body: string;
  flash?: string;
  activeProject?: string;
  systemPage?: SystemPage;
  project?: { alias: string; tab: ProjectTab; section?: string };
  cfg?: ServerConfig;
  projectPath?: string;
  toolbar?: string;
  pipelineDone?: number;
  activity?: ProjectActivity | null;
  autoRefresh?: boolean;
}): string {
  const headToolbar = opts.toolbar ? `<div class="toolbar">${opts.toolbar}</div>` : "";
  const pathLine = opts.projectPath
    ? `<div class="path">${esc(opts.projectPath)}</div>`
    : "";
  const activityAlias = opts.project?.alias ?? opts.activeProject;
  const activityStrip =
    activityAlias && opts.activity
      ? renderActivityStrip(activityAlias, opts.activity)
      : "";
  const refreshMeta = opts.autoRefresh ? `<meta http-equiv="refresh" content="8"/>` : "";

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
${refreshMeta}
<title>${opts.project ? `${esc(opts.project.alias)} · ` : ""}${esc(opts.title)}</title>
<style>${DASHBOARD_STYLE}</style></head><body>
<div class="app-shell">
<aside class="sidebar">${renderSidebar(opts.cfg, {
  activeProject: opts.activeProject ?? opts.project?.alias,
  projectTab: opts.project?.tab,
  section: opts.project?.section,
  systemPage: opts.systemPage,
  activity: opts.activity,
})}</aside>
<div class="main-col">
<div class="content-head">
<div>
<h1>${esc(opts.title)}</h1>
${opts.description ? `<p class="desc">${esc(opts.description)}</p>` : ""}
${pathLine}
</div>
${headToolbar}
</div>
<div class="content-body">
${activityStrip}
${opts.flash ? `<div class="flash${/已保存|成功|✓|响应正常|请求成功/.test(opts.flash) ? " ok" : ""}">${esc(opts.flash)}</div>` : ""}
${opts.body}
</div>
</div>
</div>
${DASHBOARD_BUSY_SCRIPT}
</body></html>`;
}

const DASHBOARD_BUSY_SCRIPT = `<script>
(function(){
  document.querySelectorAll("form.p7-busy-form").forEach(function(form){
    form.addEventListener("submit",function(){
      var msg=form.getAttribute("data-busy-msg")||"处理中，请稍候…";
      var el=document.getElementById("p7-busy-banner");
      if(!el){
        el=document.createElement("div");
        el.id="p7-busy-banner";
        el.className="busy-banner";
        el.innerHTML='<span class="busy-spinner"></span><span class="busy-text"></span>';
        document.body.appendChild(el);
      }
      var t=el.querySelector(".busy-text");
      if(t) t.textContent=msg;
      el.classList.add("show");
      form.querySelectorAll('button[type="submit"],input[type="submit"]').forEach(function(b){b.disabled=true;});
    });
  });
})();
</script>`;

export function projectShell(
  cfg: ServerConfig,
  alias: string,
  tab: ProjectTab,
  opts: {
    title: string;
    description?: string;
    body: string;
    flash?: string;
    toolbar?: string;
    pipelineDone?: number;
    section?: string;
  },
): string | null {
  const proj = resolveProject(cfg, alias);
  if (!proj) return null;
  const activity = getProjectActivity(
    alias,
    proj.path,
    cfg.scheduler_enabled !== false,
    cfg.scheduler_interval_minutes ?? 2,
  );
  const visibleActivity =
    tab === "overview" && activity.failedPlan
      ? { ...activity, failedPlan: null }
      : activity;
  return layout({
    ...opts,
    activeProject: alias,
    project: { alias, tab, section: opts.section },
    cfg,
    projectPath: proj.path,
    activity: visibleActivity,
    autoRefresh: visibleActivity.activeJob?.status === "running",
  });
}

export function workbenchToolbar(alias: string): string {
  return `<form class="inline" method="post" action="/project/${encodeURIComponent(alias)}/llm-probe"><button type="submit" class="btn ghost">检测模型</button></form>
<form class="inline p7-busy-form" data-busy-msg="已提交，正在跳转任务页…" method="post" action="/trigger/discover-daily"><input type="hidden" name="alias" value="${esc(alias)}"/><button type="submit" class="btn">一键：发现 → Roadmap</button></form>`;
}

export function planToolbar(alias: string, section: string): string {
  if (section === "roadmap") {
    return `<form class="inline p7-busy-form" data-busy-msg="已提交，正在入队…" method="post" action="/trigger/discover-daily"><input type="hidden" name="alias" value="${esc(alias)}"/><button type="submit" class="btn ghost">发现 → Roadmap</button></form>`;
  }
  return `<form class="inline" method="post" action="/trigger/discover-daily"><input type="hidden" name="alias" value="${esc(alias)}"/><button type="submit" class="btn ghost">趋势 → Roadmap</button></form>`;
}

/** Roadmap 区：用户补充说明 + 可选是否纳入今日雷达 */
export function renderPlanRoadmapRegenForm(alias: string, hasRadar: boolean): string {
  const radarHint = hasRadar
    ? "已勾选时会将今日技术雷达主题与信号纳入生成上下文。"
    : "今日尚无雷达数据；取消勾选后仅根据项目现状与北极星生成。";
  return `<div class="regen-panel panel">
<h3 style="margin:0 0 8px;font-size:14px">按你的说明重新生成 Roadmap</h3>
<p class="muted" style="margin:0 0 14px;font-size:12px">在下方填写补充要求（例如优先级、技术栈、本季度重点）。留空则与「AI 刷新」相同，仅按默认 prompt 生成。提交后需调用模型，通常约 30 秒～2 分钟，页顶会显示进度条。</p>
<form class="p7-busy-form" data-busy-msg="正在生成 Roadmap（调用模型中）…请勿关闭此页" method="post" action="/trigger/roadmap-refresh">
<input type="hidden" name="alias" value="${esc(alias)}"/>
<label for="roadmap-instructions">补充说明 / 自定义 prompt</label>
<textarea id="roadmap-instructions" name="user_instructions" rows="4" placeholder="例：优先落地可观测性；本迭代不做前端大改；对齐 ROADMAP 里 Phase 2…"></textarea>
<label class="check-row"><input type="checkbox" name="use_radar" value="1" ${hasRadar ? "checked" : ""}/> 纳入今日技术雷达</label>
<p class="muted" style="margin:8px 0 14px;font-size:11px">${esc(radarHint)}</p>
<button type="submit" class="btn">重新生成 Roadmap</button>
</form>
</div>`;
}

/** Plan 审批区：指定本次目标后生成 Plan */
export function renderPlanGenerateForm(alias: string, suggestedGoal: string): string {
  return `<div class="regen-panel panel">
<h3 style="margin:0 0 8px;font-size:14px">生成新 Plan</h3>
<p class="muted" style="margin:0 0 14px;font-size:12px">填写本次要实现的目标；可附加约束。生成后出现在下方待审批列表（需配置 LLM）。通常约 30 秒～2 分钟，页顶会显示进度。</p>
<form class="p7-busy-form" data-busy-msg="正在生成 Plan（调用模型中）…请勿关闭此页" method="post" action="/trigger/plan-generate">
<input type="hidden" name="alias" value="${esc(alias)}"/>
<label for="plan-goal">本次目标</label>
<textarea id="plan-goal" name="goal" rows="2" placeholder="例：为 API 增加请求超时与重试">${esc(suggestedGoal)}</textarea>
<label for="plan-notes">补充说明（可选）</label>
<textarea id="plan-notes" name="user_instructions" rows="2" placeholder="例：改动控制在 3 个文件内；必须带单元测试"></textarea>
<button type="submit" class="btn">生成 Plan</button>
</form>
</div>`;
}

export function discoverToolbar(alias: string): string {
  return `<form class="inline" method="post" action="/trigger/discover-daily"><input type="hidden" name="alias" value="${esc(alias)}"/><button class="btn">抓取今日雷达</button></form>
<a class="btn ghost" href="/project/${encodeURIComponent(alias)}/plan?section=roadmap">用趋势更新 Roadmap</a>`;
}

export type TrendSignal = {
  source: "hn" | "github";
  title: string;
  url: string;
  score?: number;
  tags?: string[];
};

export function renderTrendsPage(opts: {
  alias: string;
  snap: {
    date: string;
    fetchedAt: string;
    signals: TrendSignal[];
    themes: string[];
    summary: string;
  } | null;
  history: { date: string; signals: TrendSignal[]; themes: string[]; summary: string }[];
}): string {
  const base = `/project/${encodeURIComponent(opts.alias)}`;
  if (!opts.snap || opts.snap.signals.length === 0) {
    return `<div class="trends-page"><div class="panel trends-empty">
<p>今日尚未抓取技术雷达，或信号为空。</p>
<form class="inline" method="post" action="/trigger/discover-daily"><input type="hidden" name="alias" value="${esc(opts.alias)}"/><button type="submit" class="btn">抓取 HN + GitHub Trending</button></form>
</div></div>`;
  }

  const snap = opts.snap;
  const hn = snap.signals.filter((s) => s.source === "hn").length;
  const gh = snap.signals.filter((s) => s.source === "github").length;
  const fetched = new Date(snap.fetchedAt).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const themePills =
    snap.themes.length > 0
      ? `<div class="theme-pills">${snap.themes.map((t) => `<span class="theme-pill">${esc(t)}</span>`).join("")}</div>`
      : "";

  const signalCards = [...snap.signals]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((s) => {
      const srcCls = s.source === "hn" ? "hn" : "gh";
      const srcLabel = s.source === "hn" ? "HN" : "GitHub";
      const score = s.score != null ? esc(String(s.score)) : "—";
      const tags =
        s.tags && s.tags.length > 0
          ? `<span class="muted" style="font-size:11px;display:block;margin-top:4px">${esc(s.tags.slice(0, 6).join(" · "))}</span>`
          : "";
      return `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="signal-card" data-source="${esc(s.source)}">
<span class="badge source ${srcCls}">${srcLabel}</span>
<span><span class="signal-title">${esc(s.title)}</span>${tags}</span>
<span class="signal-score">${score}</span>
</a>`;
    })
    .join("");

  const histRows = opts.history
    .filter((h) => h.date !== snap.date)
    .slice(0, 7)
    .map(
      (h) =>
        `<tr><td>${esc(h.date)}</td><td>${(h.signals ?? []).length}</td><td>${(h.themes ?? []).length ? esc((h.themes ?? []).slice(0, 3).join("、")) : "—"}</td><td class="muted">${esc((h.summary ?? "").slice(0, 80))}${(h.summary ?? "").length > 80 ? "…" : ""}</td></tr>`,
    )
    .join("");

  return `<div class="trends-page">
<div class="panel trends-hero">
<div class="hero-meta"><span>日期 ${esc(snap.date)}</span><span>更新于 ${esc(fetched)}</span><span>${snap.signals.length} 条信号</span></div>
<p class="hero-summary">${esc(snap.summary)}</p>
${themePills}
</div>
<div class="cards">${metricCard(hn, "Hacker News")}${metricCard(gh, "GitHub Trending")}${metricCard(snap.themes.length, "提炼主题")}${metricCard(opts.history.length, "历史快照")}</div>
<div class="trends-grid">
<div class="panel">
<div class="panel-head"><h2>今日热点</h2><span class="muted" style="font-size:12px">按分数排序</span></div>
<div class="trends-filter" id="trend-filter">
<button type="button" class="active" data-filter="all">全部</button>
<button type="button" data-filter="hn">HN (${hn})</button>
<button type="button" data-filter="github">GitHub (${gh})</button>
</div>
<div class="signal-list" id="signal-list">${signalCards}</div>
</div>
<div class="panel">
<div class="panel-head"><h2>近 7 日</h2><a href="${base}/plan?section=roadmap">→ Roadmap</a></div>
<div class="tbl-wrap"><table><thead><tr><th>日期</th><th>信号</th><th>主题</th><th>摘要</th></tr></thead><tbody>${histRows || `<tr><td colspan="4" class="empty">暂无历史</td></tr>`}</tbody></table></div>
</div>
</div>
</div>
<script>
(function(){
  const bar=document.getElementById('trend-filter');
  const list=document.getElementById('signal-list');
  if(!bar||!list)return;
  bar.addEventListener('click',function(e){
    const btn=e.target.closest('button[data-filter]');
    if(!btn)return;
    bar.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const f=btn.getAttribute('data-filter');
    list.querySelectorAll('.signal-card').forEach(el=>{
      const s=el.getAttribute('data-source');
      el.style.display=(f==='all'||f===s)?'':'none';
    });
  });
})();
</script>`;
}

export interface SeverityTrendPoint {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  blocker: number;
  warning: number;
  info: number;
}

/**
 * Render an inline SVG severity trend line chart with 3 polylines (blocker / warning / info).
 * Y-axis auto-scales to the maximum value across all series.
 * Returns an empty-state div when `points` is empty.
 */
export function renderSeverityTrendChart(points: SeverityTrendPoint[]): string {
  if (points.length === 0) {
    return `<div class="chart-wrap"><h3>Severity 趋势</h3><div class="chart-empty">暂无趋势数据</div></div>`;
  }

  const W = 600;
  const H = 180;
  const PL = 36; // left padding for Y-axis labels
  const PR = 12;
  const PT = 10;
  const PB = 28; // bottom padding for X-axis date labels
  const CW = W - PL - PR;
  const CH = H - PT - PB;

  // Determine Y-axis max
  let maxVal = 0;
  for (const p of points) {
    maxVal = Math.max(maxVal, p.blocker, p.warning, p.info);
  }
  if (maxVal === 0) maxVal = 1;

  const scaleY = (v: number): number => PT + CH - (v / maxVal) * CH;
  const stepX = points.length > 1 ? CW / (points.length - 1) : CW / 2;
  const getX = (i: number): number => PL + i * stepX;

  const buildPoints = (sel: (p: SeverityTrendPoint) => number): string =>
    points.map((p, i) => `${getX(i)},${scaleY(sel(p))}`).join(" ");

  // Horizontal grid lines with Y-axis labels
  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = PT + CH - f * CH;
      const label = Math.round(f * maxVal);
      return `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="#232933" stroke-width="1"/><text x="${PL - 6}" y="${y + 3}" text-anchor="end">${label}</text>`;
    })
    .join("");

  // X-axis date labels (MM-DD)
  const dateLabels = points
    .map((p, i) => {
      const x = getX(i);
      const label = p.date.slice(5); // "MM-DD"
      const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
      return `<text x="${x}" y="${H - 6}" text-anchor="${anchor}">${label}</text>`;
    })
    .join("");

  // Legend items
  const series: { key: keyof SeverityTrendPoint; label: string; color: string }[] = [
    { key: "blocker", label: "Blocker", color: "#f07178" },
    { key: "warning", label: "Warning", color: "#e5b567" },
    { key: "info", label: "Info", color: "#6b9fff" },
  ];

  const legendHtml = series
    .map(
      (s) =>
        `<span class="chart-legend-item"><span class="chart-legend-dot" style="background:${s.color}"></span> ${s.label}</span>`,
    )
    .join("");

  const polylines = series
    .map(
      (s) =>
        `<polyline points="${buildPoints((p) => Number(p[s.key]))}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    )
    .join("");

  return `<div class="chart-wrap"><h3>Severity 趋势</h3><div class="chart-legend">${legendHtml}</div><svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${gridLines}${polylines}${dateLabels}</svg></div>`;
}

export function renderVulnerabilityPanel(opts: {
  alias: string;
  total: number;
  blockerCount: number;
  warningCount: number;
  infoCount: number;
  findings: Array<{
    planId: string;
    title: string;
    severity: "blocker" | "warning" | "info";
    dimension: string;
    message: string;
    file?: string;
    line?: number;
    code?: string;
  }>;
  trendChartHtml?: string;
  filterSeverity?: string;
}): string {
  const base = `/project/${encodeURIComponent(opts.alias)}`;
  const fs = opts.filterSeverity;
  const isFiltered = fs === "blocker" || fs === "warning" || fs === "info";

  const badge = (severity: "blocker" | "warning" | "info"): string => {
    const cls = severity === "blocker" ? "fail" : severity === "warning" ? "warn" : "idle";
    return `<span class="badge ${cls}">${severity}</span>`;
  };

  /** Render a clickable severity metric card linking to filtered view. */
  function severityCardLink(
    count: number,
    label: string,
    severity: "blocker" | "warning" | "info",
    tone?: "warn" | "alert",
  ): string {
    const href = `${base}/vulnerabilities?severity=${severity}`;
    const toneCls = tone ? ` ${tone}` : "";
    const activeStyle =
      isFiltered && fs === severity
        ? ' style="border-color:var(--accent);background:var(--accent-soft)"'
        : "";
    return `<a href="${href}" class="metric${toneCls}"${activeStyle}><div class="n">${esc(String(count))}</div><div class="l">${esc(label)}</div></a>`;
  }

  const filteredFindings = isFiltered
    ? opts.findings.filter((f) => f.severity === fs)
    : opts.findings;

  const emptyHtml =
    filteredFindings.length === 0
      ? `<div class="empty"><p>暂未发现漏洞。先执行 diff-critic 扫描。</p><a class="btn ghost sm" href="${base}/run">前往执行</a></div>`
      : "";

  // Show location columns (file / line / code) only in drill-down mode
  const showLocation = isFiltered;

  const rows = filteredFindings
    .map((f) => {
      const msgText = isFiltered ? f.message : f.message.slice(0, 120);
      const fileCell = showLocation
        ? `<td class="muted" style="max-width:180px;word-break:break-word;font-size:12px"><code>${esc(f.file ?? "—")}${f.line != null ? `:${f.line}` : ""}</code></td>`
        : "";
      const codeCell = showLocation
        ? `<td class="muted" style="max-width:200px;word-break:break-word;font-size:12px"><code>${esc(f.code ? f.code.slice(0, 80) : "—")}</code></td>`
        : "";
      return `<tr><td><a href="${base}/plans/${encodeURIComponent(f.planId)}">${esc(f.title)}</a></td>
<td>${badge(f.severity)}</td>
<td class="muted">${esc(f.dimension)}</td>${fileCell}${codeCell}
<td class="muted" style="max-width:320px;word-break:break-word">${esc(msgText)}</td></tr>`;
    })
    .join("");

  const headers = `<th>Plan</th><th>Severity</th><th>维度</th>${
    showLocation ? "<th>位置</th><th>代码</th>" : ""
  }<th>描述</th>`;

  const tableHtml =
    filteredFindings.length > 0
      ? `<div class="tbl-wrap"><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`
      : "";

  return `<div>
<div class="cards">
${metricCard(opts.total, "发现总数")}
${severityCardLink(opts.blockerCount, "Blocker", "blocker", opts.blockerCount > 0 ? "alert" : undefined)}
${severityCardLink(opts.warningCount, "Warning", "warning", opts.warningCount > 0 ? "warn" : undefined)}
${severityCardLink(opts.infoCount, "Info", "info")}
${isFiltered ? `<a href="${base}/vulnerabilities" class="btn ghost sm" style="align-self:center">显示全部</a>` : ""}
</div>
${opts.trendChartHtml || ""}
<div class="panel">
<div class="panel-head"><h2>最近发现</h2><span class="muted" style="font-size:12px">显示 ${filteredFindings.length} 条 / 共 ${opts.total} 条</span></div>
${emptyHtml || tableHtml}
</div>
</div>`;
}

function auditEventBadgeClass(event: string): string {
  if (/failed|error|parse_error|rejected/.test(event)) return "fail";
  if (/done|save|approve|merged|started|enqueued/.test(event)) return "ok";
  if (/skipped|cooldown|orphan|reclaimed/.test(event)) return "idle";
  return "run";
}

function auditDetailSummary(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  const pick = (k: string) => {
    const v = detail[k];
    if (v === undefined || v === null || v === "") return;
    parts.push(`<code>${esc(k)}</code>=${esc(String(v).slice(0, 120))}`);
  };
  for (const k of ["alias", "kind", "id", "planId", "reason", "error", "openPrs"]) pick(k);
  if (parts.length === 0) {
    const keys = Object.keys(detail);
    if (keys.length === 0) return "—";
    return keys
      .slice(0, 4)
      .map((k) => `<code>${esc(k)}</code>=${esc(String(detail[k]).slice(0, 48))}`)
      .join(" · ");
  }
  return parts.join(" · ");
}

function logsPageUrl(params: {
  page?: number;
  event?: string;
  alias?: string;
  q?: string;
  perPage?: number;
}): string {
  const sp = new URLSearchParams();
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  if (params.event) sp.set("event", params.event);
  if (params.alias) sp.set("alias", params.alias);
  if (params.q) sp.set("q", params.q);
  if (params.perPage && params.perPage !== 20) sp.set("per_page", String(params.perPage));
  const qs = sp.toString();
  return qs ? `/logs?${qs}` : "/logs";
}

function renderPagerBar(opts: {
  page: number;
  totalPages: number;
  total: number;
  hrefForPage: (page: number) => string;
  ariaLabel: string;
}): string {
  const { page, totalPages, total, hrefForPage, ariaLabel } = opts;
  const prev =
    page > 1
      ? `<a class="btn ghost sm" href="${esc(hrefForPage(page - 1))}">上一页</a>`
      : `<span class="btn ghost sm disabled">上一页</span>`;
  const next =
    page < totalPages
      ? `<a class="btn ghost sm" href="${esc(hrefForPage(page + 1))}">下一页</a>`
      : `<span class="btn ghost sm disabled">下一页</span>`;

  const window = 5;
  let start = Math.max(1, page - Math.floor(window / 2));
  const end = Math.min(totalPages, start + window - 1);
  start = Math.max(1, end - window + 1);
  const nums: string[] = [];
  for (let p = start; p <= end; p++) {
    nums.push(
      p === page
        ? `<span class="pager-num active">${p}</span>`
        : `<a class="pager-num btn ghost sm" href="${esc(hrefForPage(p))}">${p}</a>`,
    );
  }

  return `<nav class="pager" aria-label="${esc(ariaLabel)}">
<span class="pager-info">共 ${total} 条 · 第 ${page} / ${totalPages} 页</span>
<div class="pager-links">${prev}${nums.join("")}${next}</div>
</nav>`;
}

export function renderAuditLogPage(opts: {
  entries: Array<{ at: string; event: string; detail: Record<string, unknown> }>;
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
  logPath: string;
  eventFilter?: string;
  aliasFilter?: string;
  qFilter?: string;
}): string {
  const { entries, total, page, perPage, totalPages, logPath, eventFilter, aliasFilter, qFilter } =
    opts;
  const rows = entries
    .map((e) => {
      const when = e.at ? formatDateTime(e.at) : "—";
      const badge = auditEventBadgeClass(e.event);
      const detailJson = esc(JSON.stringify(e.detail, null, 2));
      return `<tr>
<td class="muted" style="white-space:nowrap">${esc(when)}</td>
<td><span class="badge ${badge} audit-event">${esc(e.event)}</span></td>
<td class="audit-detail">${auditDetailSummary(e.detail)}${
        Object.keys(e.detail).length > 0
          ? `<details style="margin-top:6px"><summary>完整 JSON</summary><pre>${detailJson}</pre></details>`
          : ""
      }</td>
</tr>`;
    })
    .join("");

  const filterForm = `<form class="audit-toolbar" method="get" action="/logs">
<div class="field"><label>事件</label><input name="event" value="${esc(eventFilter ?? "")}" placeholder="scheduler / job.done"/></div>
<div class="field narrow"><label>项目</label><input name="alias" value="${esc(aliasFilter ?? "")}" placeholder="p7"/></div>
<div class="field"><label>搜索</label><input name="q" value="${esc(qFilter ?? "")}" placeholder="关键词"/></div>
<input type="hidden" name="per_page" value="${perPage}"/>
<button type="submit" class="btn sm">筛选</button>
<a class="btn ghost sm" href="/logs">重置</a>
</form>`;

  const table = `<div class="tbl-wrap"><table><thead><tr><th style="width:160px">时间</th><th style="width:200px">事件</th><th>详情</th></tr></thead><tbody>${
    rows || `<tr><td colspan="3" class="empty">无匹配记录</td></tr>`
  }</tbody></table></div>`;

  return `${filterForm}
<p class="audit-meta">来源 <code>${esc(logPath)}</code> · 最新在前 · 每页 ${perPage} 条</p>
${table}
${renderPagerBar({
  page,
  totalPages,
  total,
  ariaLabel: "审计日志分页",
  hrefForPage: (p) => logsPageUrl({ page: p, event: eventFilter, alias: aliasFilter, q: qFilter, perPage }),
})}`;
}

function jobsPageUrl(params: {
  page?: number;
  alias?: string;
  status?: string;
  kind?: string;
  perPage?: number;
}): string {
  const sp = new URLSearchParams();
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  if (params.alias) sp.set("alias", params.alias);
  if (params.status) sp.set("status", params.status);
  if (params.kind) sp.set("kind", params.kind);
  if (params.perPage && params.perPage !== 20) sp.set("per_page", String(params.perPage));
  const qs = sp.toString();
  return qs ? `/jobs?${qs}` : "/jobs";
}

const JOB_KIND_OPTIONS = [
  "discover-daily",
  "daily",
  "execute",
  "pr-review",
  "plan",
  "quickfix",
  "initialize",
] as const;

const JOB_STATUS_OPTIONS = ["pending", "running", "done", "failed"] as const;

export function renderJobsPage(opts: {
  jobs: Array<{
    id: string;
    project_alias: string;
    kind: string;
    status: string;
    created_at: string;
    error: string | null;
  }>;
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
  aliasFilter?: string;
  statusFilter?: string;
  kindFilter?: string;
}): string {
  const { jobs, total, page, perPage, totalPages, aliasFilter, statusFilter, kindFilter } = opts;
  const kindOpts = JOB_KIND_OPTIONS.map(
    (k) =>
      `<option value="${k}"${kindFilter === k ? " selected" : ""}>${esc(jobKindLabel(k))}</option>`,
  ).join("");
  const statusOpts = JOB_STATUS_OPTIONS.map(
    (s) => `<option value="${s}"${statusFilter === s ? " selected" : ""}>${esc(s)}</option>`,
  ).join("");

  const rows = jobs
    .map(
      (j) =>
        `<tr>
<td><a href="/jobs/${encodeURIComponent(j.id)}/log"><code style="font-size:11px">${esc(j.id.slice(0, 14))}…</code></a></td>
<td><a href="/project/${encodeURIComponent(j.project_alias)}/run?section=jobs">${esc(j.project_alias)}</a></td>
<td>${esc(jobKindLabel(j.kind))}</td>
<td>${jobStatusBadge(j.status)}</td>
<td class="muted">${esc(formatDateTime(j.created_at))}</td>
<td class="muted">${esc((j.error ?? "").slice(0, 80)) || "—"}</td>
</tr>`,
    )
    .join("");

  const filterForm = `<form class="audit-toolbar" method="get" action="/jobs">
<div class="field narrow"><label>项目</label><input name="alias" value="${esc(aliasFilter ?? "")}" placeholder="p7"/></div>
<div class="field narrow"><label>状态</label><select name="status"><option value="">全部</option>${statusOpts}</select></div>
<div class="field"><label>类型</label><select name="kind"><option value="">全部</option>${kindOpts}</select></div>
<input type="hidden" name="per_page" value="${perPage}"/>
<button type="submit" class="btn sm">筛选</button>
<a class="btn ghost sm" href="/jobs">重置</a>
</form>`;

  const table = `<div class="tbl-wrap"><table><thead><tr><th>任务 ID</th><th>项目</th><th>类型</th><th>状态</th><th>创建时间</th><th>错误</th></tr></thead><tbody>${
    rows || `<tr><td colspan="6" class="empty">暂无任务</td></tr>`
  }</tbody></table></div>`;

  return `${filterForm}
<p class="audit-meta">最新在前 · 每页 ${perPage} 条 · 点击 ID 查看日志</p>
${table}
${renderPagerBar({
  page,
  totalPages,
  total,
  ariaLabel: "任务队列分页",
  hrefForPage: (p) =>
    jobsPageUrl({
      page: p,
      alias: aliasFilter,
      status: statusFilter,
      kind: kindFilter,
      perPage,
    }),
})}`;
}
