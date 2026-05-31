import type { ServerConfig } from "./config.ts";
import { lastConsecutiveFailures, sumTodayJobCostUsd } from "./queue/store.ts";
import { countPendingPlans } from "../src/approval.ts";
import { loadConfig } from "../src/config.ts";
import { checkPrWorkGate } from "../src/vcs/pr-work-gate.ts";
import { ghInstalled, gitRemoteOrigin } from "../src/gh-status.ts";

const COOLDOWN_MS = 30 * 60 * 1000;
const lastStopAt = new Map<string, number>();

export interface LoopDecision {
  continue: boolean;
  reason?: string;
}

export function maybeContinueLoop(
  cfg: ServerConfig,
  alias: string,
  projectPath: string,
  _lastResult?: unknown,
): LoopDecision {
  let dc;
  try {
    dc = loadConfig(projectPath);
  } catch {
    return { continue: false, reason: "no_project_config" };
  }

  if (!dc.loop_planning) {
    return { continue: false, reason: "loop_planning_off" };
  }

  if (
    ghInstalled() &&
    gitRemoteOrigin(projectPath) &&
    checkPrWorkGate(projectPath, dc).blocked
  ) {
    return { continue: false, reason: "open_prs_block" };
  }

  const maxFailures = dc.max_consecutive_failures;
  const failures = lastConsecutiveFailures(alias, maxFailures);
  if (failures >= maxFailures) {
    const stopped = lastStopAt.get(alias) ?? Date.now();
    lastStopAt.set(alias, stopped);
    if (Date.now() - stopped < COOLDOWN_MS) {
      return { continue: false, reason: "circuit_breaker" };
    }
    lastStopAt.delete(alias);
  }

  const pending = countPendingPlans(projectPath);
  if (pending > dc.max_pending_plans) {
    return { continue: false, reason: "max_pending_plans" };
  }

  const spent = sumTodayJobCostUsd(alias);
  if (spent >= cfg.daily_cost_cap_usd) {
    return { continue: false, reason: "daily_cost_cap" };
  }

  return { continue: true };
}
