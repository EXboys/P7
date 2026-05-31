#!/usr/bin/env bun
import "./llm-env.ts";
import { resolve } from "path";
import { loadConfig, saveConfig } from "./config.ts";
import { scanProject } from "./scanner.ts";
import { generatePlan } from "./planner.ts";
import { executePlan, loadLatestPlan } from "./executor.ts";
import { runDaily } from "./daily.ts";
import { runDiscoveryDaily } from "./discovery-daily.ts";
import {
  runDiscovery,
  loadSnapshot,
  listSnapshots,
  deriveThemesFromSignals,
} from "./tech-discovery.ts";
import { selectGoal } from "./goal-selector.ts";
import { decideApproval, getApprovalRecord, listPendingApprovals } from "./approval.ts";
import { extractLastJsonBlock, repairJson } from "./json-utils.ts";
import { listPlanStates } from "./state.ts";
import { runPipelineCheck, pipelineReady } from "./pipeline-check.ts";
import { runPrReviewSweep } from "./vcs/pr-reviewer.ts";

const [, , cmd, projectArg, ...rest] = process.argv;

function projectPath(): string {
  if (!projectArg) {
    console.error("Usage: bun run src/index.ts <cmd> <project-path> [options]");
    process.exit(1);
  }
  return resolve(projectArg);
}

function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function main(): Promise<void> {
  switch (cmd) {
    case "scan": {
      const scan = await scanProject(projectPath());
      console.log(JSON.stringify(scan, null, 2));
      break;
    }
    case "plan": {
      const goal = flag("--goal") ?? loadConfig(projectPath()).initial_goal;
      const scan = await scanProject(projectPath());
      const record = await generatePlan(projectPath(), scan, goal);
      console.log(JSON.stringify(record, null, 2));
      break;
    }
    case "execute": {
      const p = projectPath();
      const cfg = loadConfig(p);
      const scan = await scanProject(p);
      const planId = flag("--plan-id");
      const approval = planId ? getApprovalRecord(p, planId) : null;
      if (planId && approval?.status !== "approved" && !rest.includes("--force")) {
        throw new Error(`Plan ${planId} is not approved; pass --force to execute anyway`);
      }
      const loaded = approval
        ? { ...approval.plan, planId: approval.planId, goal: approval.goal }
        : loadLatestPlan(p);
      if (!loaded) throw new Error("No plan found in .p7/plans");
      const result = await executePlan(p, loaded, cfg, scan.git?.remoteUrl ?? null);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case "goal": {
      const cfg = loadConfig(projectPath());
      const scan = await scanProject(projectPath());
      const sel = await selectGoal(projectPath(), scan, cfg);
      console.log(JSON.stringify(sel, null, 2));
      break;
    }
    case "daily": {
      if (rest[0] === "run") {
        const result = await runDaily(projectPath(), {
          goal: flag("--goal"),
          skipExecute: rest.includes("--plan-only"),
          skipDiscovery: rest.includes("--skip-discovery"),
        });
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error("Usage: daily run <project>");
        process.exit(1);
      }
      break;
    }
    case "discover": {
      const cfg = loadConfig(projectPath());
      const snap = await runDiscovery(projectPath(), cfg, {
        useLlmThemes: !rest.includes("--no-llm"),
      });
      console.log(JSON.stringify(snap, null, 2));
      break;
    }
    case "discover-daily": {
      const result = await runDiscoveryDaily(projectPath(), {
        planOnly: rest.includes("--plan-only"),
        skipDiscovery: rest.includes("--skip-fetch"),
        recoverStall: rest.includes("--recover-stall"),
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "pr-review": {
      const p = projectPath();
      const cfg = loadConfig(p);
      const result = await runPrReviewSweep(p, cfg);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case "pipeline": {
      if (projectArg === "check") {
        const p = rest[0];
        if (!p) {
          console.error("Usage: bun run src/index.ts pipeline check <project-path>");
          process.exit(1);
        }
        const items = runPipelineCheck(resolve(p));
        console.log(JSON.stringify({ ready: pipelineReady(items), items }, null, 2));
        process.exit(pipelineReady(items) ? 0 : 1);
      } else {
        console.error("Usage: bun run src/index.ts pipeline check <project-path>");
        process.exit(1);
      }
      break;
    }
    case "roadmap": {
      if (projectArg === "fix-template") {
        const p = rest[0];
        if (!p) {
          console.error("Usage: bun run src/index.ts roadmap fix-template <project-path>");
          process.exit(1);
        }
        const path = resolve(p);
        const cfg = loadConfig(path);
        const snap = loadSnapshot(path);
        if (!snap?.signals.length) {
          console.error("无雷达数据，先运行 discover");
          process.exit(1);
        }
        const { writeFallbackRoadmap } = await import("./roadmap-template.ts");
        const ok = writeFallbackRoadmap(path, {
          signals: snap.signals,
          northStar: cfg.initial_goal,
          themes: deriveThemesFromSignals(snap.signals, cfg.discovery.theme_count),
        });
        console.log(ok ? "ROADMAP.md rewritten from signal titles" : "unchanged");
        process.exit(ok ? 0 : 1);
      }
      console.error("Usage: roadmap fix-template <project-path>");
      process.exit(1);
      break;
    }
    case "radar": {
      const date = flag("--date");
      const snap = date ? loadSnapshot(projectPath(), date) : loadSnapshot(projectPath());
      if (!snap) {
        console.log(JSON.stringify({ snapshots: listSnapshots(projectPath()) }, null, 2));
      } else {
        console.log(JSON.stringify(snap, null, 2));
      }
      break;
    }
    case "approve": {
      const planId = flag("--plan-id");
      if (!planId) throw new Error("--plan-id required");
      const approval = decideApproval(projectPath(), planId, "approved");
      if (!approval) throw new Error(`Approval not found: ${planId}`);
      if (rest.includes("--execute")) {
        const p = projectPath();
        const cfg = loadConfig(p);
        const scan = await scanProject(p);
        const result = await executePlan(
          p,
          { ...approval.plan, planId: approval.planId, goal: approval.goal },
          cfg,
          scan.git?.remoteUrl ?? null,
        );
        console.log(JSON.stringify({ approved: planId, result }, null, 2));
        process.exit(result.ok ? 0 : 1);
      }
      console.log("approved", planId);
      break;
    }
    case "reject": {
      const planId = flag("--plan-id");
      if (!planId) throw new Error("--plan-id required");
      decideApproval(projectPath(), planId, "rejected");
      console.log("rejected", planId);
      break;
    }
    case "approvals": {
      console.log(JSON.stringify(listPendingApprovals(projectPath()), null, 2));
      break;
    }
    case "states": {
      console.log(JSON.stringify(listPlanStates(projectPath(), Number(flag("--limit") ?? 50)), null, 2));
      break;
    }
    case "init-config": {
      const cfg = loadConfig(projectPath());
      if (flag("--goal")) {
        cfg.initial_goal = flag("--goal")!;
        saveConfig(projectPath(), cfg);
      }
      console.log(JSON.stringify(cfg, null, 2));
      break;
    }
    case "test-repair-json": {
      const broken = '{"title": "添加对 "超时" 的处理", "ok": true}';
      const fixed = repairJson(broken);
      console.log(JSON.parse(fixed));
      break;
    }
    case "test-extract-json": {
      const sample = '说明\n```json\n{"title":"测试","motivation":"m","changes":[{"file":"a.ts","description":"d","estimated_lines":1}],"risks":[],"validation":"tsc","estimated_diff_lines":10}\n```';
      console.log(extractLastJsonBlock(sample));
      break;
    }
    default:
      console.log(`P7 CLI

Commands:
  scan <project>
  plan <project> [--goal "..."]
  execute <project> [--plan-id <id>] [--force]
  goal <project>
  daily run <project> [--goal "..."] [--plan-only] [--skip-discovery]
  discover <project> [--no-llm]
  discover-daily <project> [--plan-only] [--skip-fetch]
  pr-review <project>   # 扫描 OPEN PR，自动 review / 合并 / 修冲突
  pipeline check <project>
  roadmap fix-template <project>
  radar <project> [--date YYYY-MM-DD]
  approvals <project>
  states <project> [--limit 50]
  approve <project> --plan-id <id> [--execute]
  reject <project> --plan-id <id>
  init-config <project> [--goal "..."]
  test-repair-json
  test-extract-json
`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
