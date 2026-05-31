import type { ServerConfig } from "./config.ts";
import type { PlanDetailView } from "../src/plan-detail.ts";
import type { PipelineCheckItem } from "../src/pipeline-check.ts";
import { pipelineReady } from "../src/pipeline-check.ts";

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
.main-col{flex:1;min-width:0;display:flex;flex-direction:column;min-height:100vh;background:var(--bg);background-image:radial-gradient(ellipse 80% 50% at 50% -20%,rgba(107,159,255,.08),transparent 55%)}
.content-head{padding:24px 28px 0;display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
.content-head h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.02em}
.content-head .desc{margin:6px 0 0;color:var(--mut);font-size:13px;max-width:560px;line-height:1.45}
.content-head .path{font-family:ui-monospace,monospace;font-size:11px;color:var(--mut);margin-top:8px;opacity:.8}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.content-body{padding:18px 28px 44px;max-width:1080px;width:100%}
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
.gh-advanced{margin-top:4px;padding-top:16px;border-top:1px solid var(--line)}
.gh-advanced summary{cursor:pointer;font-size:13px;font-weight:500;color:var(--mut);list-style:none;padding:4px 0}
.gh-advanced summary::-webkit-details-marker{display:none}
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
.plan-detail-page{display:flex;flex-direction:column;gap:18px}
.plan-crumb{font-size:12px;color:var(--mut);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.plan-crumb a{color:var(--mut);text-decoration:none}
.plan-crumb a:hover{color:var(--accent);text-decoration:none}
.plan-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap;padding:20px 22px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--elev)}
.plan-hero-main{flex:1;min-width:200px}
.plan-id{font-family:ui-monospace,monospace;font-size:11px;color:var(--mut);letter-spacing:.02em}
.plan-hero-title{margin:8px 0 0;font-size:20px;font-weight:700;letter-spacing:-.02em;line-height:1.3}
.plan-hero-goal{margin:12px 0 0;font-size:13px;color:var(--mut);line-height:1.55;max-width:640px}
.plan-hero-goal strong{color:var(--fg);font-weight:600}
.plan-hero-aside{display:flex;flex-direction:column;align-items:flex-end;gap:10px}
.plan-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,300px);gap:16px;align-items:start}
@media(max-width:900px){.plan-detail-grid{grid-template-columns:1fr}}
.plan-motivation{margin:0;padding:14px 16px 14px 18px;border-left:3px solid var(--accent);background:var(--surface2);border-radius:0 var(--radius) var(--radius) 0;font-size:13px;line-height:1.6;color:var(--fg)}
.plan-empty-state{padding:28px 20px;text-align:center;color:var(--mut);font-size:13px;line-height:1.55}
.plan-empty-state p{margin:0 0 12px}
.changes-table tbody td:first-child{width:36%;vertical-align:top}
.changes-table code{font-size:12px;word-break:break-all}
.changes-lines{text-align:right;color:var(--mut);font-variant-numeric:tabular-nums;white-space:nowrap}
.risk-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.risk-pill{padding:5px 11px;font-size:12px;border-radius:999px;background:rgba(244,112,103,.1);border:1px solid rgba(244,112,103,.28);color:var(--fg)}
.risk-none{color:var(--mut);font-size:13px}
.delivery-dl{margin:0}
.delivery-dl dt{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:14px 0 0}
.delivery-dl dt:first-child{margin-top:0}
.delivery-dl dd{margin:5px 0 0;font-size:13px;line-height:1.45;word-break:break-word}
.delivery-dl dd code{font-size:12px}
.delivery-link{display:inline-flex;align-items:center;gap:6px;font-weight:500}
.plan-timeline{font-size:12px;color:var(--mut);line-height:1.6}
.plan-pending-banner{width:100%;padding:12px 14px;border-radius:var(--radius);background:rgba(229,181,103,.1);border:1px solid rgba(229,181,103,.35);font-size:13px;text-align:right}
.plan-actions-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:16px 18px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--elev)}
.plan-actions-bar .actions-spacer{flex:1;min-width:8px}
.panel.error-panel{border-color:rgba(244,112,103,.4);background:rgba(244,112,103,.06)}
.panel.error-panel h2{color:var(--err)}
.critique-list{margin:8px 0 0;padding-left:18px;color:var(--mut);font-size:13px}
.critique-list li{margin:4px 0}
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
.roadmap-preview{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.roadmap-preview li{display:flex;align-items:flex-start;gap:10px;font-size:13px;line-height:1.4}
.roadmap-preview .dot{width:6px;height:6px;border-radius:50%;background:var(--accent);margin-top:7px;flex-shrink:0}
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
`;

export type ProjectTab = "overview" | "trends" | "plan" | "run" | "settings";

export type SystemPage = "/jobs" | "/settings" | "/logs";

type NavIcon = "overview" | "trends" | "plan" | "run" | "settings" | "bind" | "jobs" | "logs";

const NAV_SVG: Record<NavIcon, string> = {
  overview:
    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  trends: '<svg viewBox="0 0 24 24"><path d="M4 19h16"/><path d="M7 17l3-6 3 4 4-9"/></svg>',
  plan: '<svg viewBox="0 0 24 24"><path d="M9 6h12M9 12h12M9 18h12"/><path d="M5 6h.01M5 12h.01M5 18h.01"/></svg>',
  run: '<svg viewBox="0 0 24 24"><polygon points="9,7 18,12 9,17" fill="currentColor" stroke="none"/></svg>',
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
  {
    tab: "plan",
    label: "规划",
    icon: "plan",
    subs: [
      { id: "roadmap", label: "Roadmap" },
      { id: "plans", label: "Plan 审批" },
    ],
  },
  { tab: "run", label: "运行", icon: "run" },
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
}): string {
  let title: string;
  let href: string;
  let btn: string;
  if (opts.blockers.length > 0) {
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

function formatPlanTime(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function complexityLabel(c?: string): string {
  if (c === "simple") return "简单";
  if (c === "medium") return "中等";
  if (c === "complex") return "复杂";
  return "—";
}

function mergeStatusLabel(s?: string): string {
  if (s === "merged") return "已合并";
  if (s === "queued") return "排队中";
  if (s === "failed") return "失败";
  if (s === "skipped") return "已跳过";
  if (s === "not_requested") return "未请求";
  return s ? s : "—";
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

export function renderPlanDetailPage(alias: string, detail: PlanDetailView): string {
  const base = `/project/${encodeURIComponent(alias)}`;
  const planId = detail.planId;
  const st = detail.state;
  const p = detail.plan;
  const title = st?.title ?? p?.title ?? `Plan ${planId}`;

  const metrics = p
    ? `<div class="cards">
${metricCard(p.changes.length, "涉及文件")}
${metricCard(p.estimated_diff_lines, "估算行数", p.estimated_diff_lines > 120 ? "warn" : undefined)}
${metricCard(complexityLabel(p.complexity), "复杂度")}
${metricCard(p.validation, "验证方式")}
</div>`
    : "";

  let changesBlock = "";
  if (p && p.changes.length > 0) {
    const rows = p.changes
      .map(
        (ch) =>
          `<tr><td><code>${esc(ch.file)}</code><div class="muted" style="font-size:12px;margin-top:4px">${esc(ch.description)}</div></td><td class="changes-lines">${esc(String(ch.estimated_lines))} 行</td></tr>`,
      )
      .join("");
    changesBlock = `<div class="panel"><h2>变更清单</h2>
<div class="tbl-wrap" style="margin:0"><table class="changes-table"><thead><tr><th>文件</th><th style="text-align:right">规模</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  } else if (!p) {
    changesBlock = `<div class="panel"><h2>变更清单</h2>
<div class="plan-empty-state">
<p>该 Plan 未保留详细变更列表（常见于示例数据或早期记录）。</p>
<a class="btn ghost sm" href="${base}/run">在「运行与交付」查看分支与 PR</a>
</div></div>`;
  }

  const motivationBlock = p?.motivation
    ? `<div class="panel"><h2>动机</h2><p class="plan-motivation">${esc(p.motivation)}</p></div>`
    : "";

  const risksBlock = p
    ? `<div class="panel"><h2>风险</h2>${
        p.risks.length > 0
          ? `<div class="risk-pills">${p.risks.map((r) => `<span class="risk-pill">${esc(r)}</span>`).join("")}</div>`
          : `<p class="risk-none">未标注风险</p>`
      }</div>`
    : "";

  const critiqueBlock =
    p?.critique_notes && p.critique_notes.length > 0
      ? `<div class="panel"><h2>评审备注</h2><ul class="critique-list">${p.critique_notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`
      : "";

  const deliveryItems: string[] = [];
  if (st?.branch) {
    deliveryItems.push(`<dt>分支</dt><dd><code>${esc(st.branch)}</code></dd>`);
  }
  if (st?.commitSha) {
    deliveryItems.push(`<dt>提交</dt><dd><code>${esc(st.commitSha)}</code></dd>`);
  }
  if (st?.prUrl) {
    deliveryItems.push(
      `<dt>Pull Request</dt><dd><a class="delivery-link" href="${esc(st.prUrl)}" target="_blank" rel="noopener">${esc(shortLinkLabel(st.prUrl, "pr"))} ↗</a></dd>`,
    );
  }
  if (st?.issueUrl) {
    deliveryItems.push(
      `<dt>Issue</dt><dd><a class="delivery-link" href="${esc(st.issueUrl)}" target="_blank" rel="noopener">${esc(shortLinkLabel(st.issueUrl, "issue"))} ↗</a></dd>`,
    );
  }
  if (st?.reviewUrl) {
    deliveryItems.push(
      `<dt>Review</dt><dd><a class="delivery-link" href="${esc(st.reviewUrl)}" target="_blank" rel="noopener">${esc(shortLinkLabel(st.reviewUrl, "review"))} ↗</a></dd>`,
    );
  }
  if (st?.mergeStatus) {
    deliveryItems.push(`<dt>合并状态</dt><dd>${esc(mergeStatusLabel(st.mergeStatus))}</dd>`);
  }
  if (st?.accountResults && st.accountResults.length > 0) {
    const accRows = st.accountResults
      .map((a) => {
        const link = a.prUrl
          ? `<a href="${esc(a.prUrl)}" target="_blank" rel="noopener">${esc(shortLinkLabel(a.prUrl, "pr"))}</a>`
          : "—";
        return `<li><strong>${esc(a.accountId)}</strong> · ${a.ok ? "成功" : "失败"} · ${link}</li>`;
      })
      .join("");
    deliveryItems.push(`<dt>多账号发布</dt><dd><ul style="margin:6px 0 0;padding-left:16px;font-size:12px">${accRows}</ul></dd>`);
  }

  const deliveryPanel =
    deliveryItems.length > 0
      ? `<div class="panel"><h2>交付</h2><dl class="delivery-dl">${deliveryItems.join("")}</dl></div>`
      : `<div class="panel"><h2>交付</h2><p class="muted" style="margin:0;font-size:13px">尚无分支、提交或 PR 信息。</p></div>`;

  const timelinePanel = `<div class="panel"><h2>时间线</h2>
<div class="plan-timeline">
<p>创建：${esc(formatPlanTime(st?.createdAt))}</p>
<p>更新：${esc(formatPlanTime(st?.updatedAt))}</p>
</div></div>`;

  const errorPanel = st?.error
    ? `<div class="panel error-panel"><h2>错误</h2><pre style="margin:0;border:none;background:transparent;padding:0;max-height:none">${esc(st.error)}</pre></div>`
    : "";

  const pendingBanner = detail.canApprove
    ? `<div class="plan-pending-banner">待你确认范围与风险后再批准执行</div>`
    : "";

  const retryAction = detail.canRetryExecute
    ? `<form class="inline" method="post" action="/trigger/retry-execute"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(planId)}"/><button class="btn ok">重试执行</button></form>`
    : st?.prUrl && st?.error
      ? `<span class="muted" style="font-size:13px">已有 PR，无需重试执行</span>`
      : "";

  const actions = detail.canApprove
    ? `<form class="inline" method="post" action="/approve"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(planId)}"/><button class="btn ok">批准并执行</button></form>
<form class="inline" method="post" action="/approve-only"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(planId)}"/><button class="btn ghost">仅批准</button></form>
<form class="inline" method="post" action="/reject"><input type="hidden" name="alias" value="${esc(alias)}"/><input type="hidden" name="planId" value="${esc(planId)}"/><button class="btn err">拒绝</button></form>`
    : retryAction;

  return `<div class="plan-detail-page">
<nav class="plan-crumb"><a href="${base}/plan?section=plans">← Plan 审批</a><span>/</span><span>${esc(planId)}</span></nav>

<header class="plan-hero">
<div class="plan-hero-main">
<span class="plan-id">${esc(planId)}</span>
<h2 class="plan-hero-title">${esc(title)}</h2>
<p class="plan-hero-goal"><strong>目标</strong> — ${esc(detail.goal)}</p>
</div>
<div class="plan-hero-aside">
${planStatusBadge(detail.status)}
${pendingBanner}
</div>
</header>

${metrics}

<div class="plan-detail-grid">
<div class="plan-main">
${motivationBlock}
${changesBlock}
${risksBlock}
${critiqueBlock}
${errorPanel}
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
<a class="btn ghost sm" href="${base}/run">运行与交付</a>
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
  },
): string {
  const aliases = cfg ? Object.keys(cfg.project_aliases) : [];
  const projectAlias = opts.activeProject ?? aliases[0];

  const head = `<div class="sidebar-head">
<a href="/" class="sidebar-brand"><span class="mark">P7</span><span class="text"><span class="name">P7</span><span class="tag">发现 → PR</span></span></a>
${cfg && aliases.length > 0 && projectAlias ? projectSwitcher(cfg, projectAlias) : ""}
</div>`;

  const scroll = `<div class="sidebar-scroll">
${cfg && projectAlias ? projectNav(projectAlias, opts.projectTab, opts.section) : cfg && !aliases.length ? `<p class="muted" style="padding:8px 10px;font-size:12px">请先绑定项目</p>` : ""}
</div>`;

  return `${head}${scroll}<div class="sidebar-foot">${systemNav(opts.systemPage)}</div>`;
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
}): string {
  const headToolbar = opts.toolbar ? `<div class="toolbar">${opts.toolbar}</div>` : "";
  const pathLine = opts.projectPath
    ? `<div class="path">${esc(opts.projectPath)}</div>`
    : "";

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${opts.project ? `${esc(opts.project.alias)} · ` : ""}${esc(opts.title)}</title>
<style>${DASHBOARD_STYLE}</style></head><body>
<div class="app-shell">
<aside class="sidebar">${renderSidebar(opts.cfg, {
  activeProject: opts.activeProject ?? opts.project?.alias,
  projectTab: opts.project?.tab,
  section: opts.project?.section,
  systemPage: opts.systemPage,
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
  return layout({
    ...opts,
    activeProject: alias,
    project: { alias, tab, section: opts.section },
    cfg,
    projectPath: proj.path,
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
        `<tr><td>${esc(h.date)}</td><td>${h.signals.length}</td><td>${h.themes.length ? esc(h.themes.slice(0, 3).join("、")) : "—"}</td><td class="muted">${esc(h.summary.slice(0, 80))}${h.summary.length > 80 ? "…" : ""}</td></tr>`,
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
