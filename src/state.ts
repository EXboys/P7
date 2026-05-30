import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { p7ProjectDir, projectDataDirForRead } from "./p7-paths.ts";
import type { PlanState, PlanStateStatus } from "./types.ts";

function stateReadPath(projectPath: string): string {
  return join(projectDataDirForRead(projectPath), "state.json");
}

function stateWritePath(projectPath: string): string {
  return join(p7ProjectDir(projectPath), "state.json");
}

function loadAll(projectPath: string): PlanState[] {
  const path = stateReadPath(projectPath);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(raw) ? (raw as PlanState[]) : [];
  } catch {
    return [];
  }
}

function saveAll(projectPath: string, states: PlanState[]): void {
  const dir = p7ProjectDir(projectPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateWritePath(projectPath), JSON.stringify(states, null, 2));
}

export function upsertPlanState(
  projectPath: string,
  next: Omit<PlanState, "updatedAt"> & { updatedAt?: string },
): PlanState {
  const states = loadAll(projectPath);
  const idx = states.findIndex((s) => s.planId === next.planId);
  const updated: PlanState = {
    ...(idx >= 0 ? states[idx] : {}),
    ...next,
    updatedAt: next.updatedAt ?? new Date().toISOString(),
  };
  if (idx >= 0) states[idx] = updated;
  else states.push(updated);
  saveAll(projectPath, states);
  return updated;
}

export function transitionPlanState(
  projectPath: string,
  planId: string,
  status: PlanStateStatus,
  patch: Partial<Omit<PlanState, "planId" | "projectPath" | "status" | "updatedAt">> = {},
): PlanState | null {
  const existing = getPlanState(projectPath, planId);
  if (!existing) return null;
  return upsertPlanState(projectPath, {
    ...existing,
    ...patch,
    status,
  });
}

export function getPlanState(projectPath: string, planId: string): PlanState | null {
  return loadAll(projectPath).find((s) => s.planId === planId) ?? null;
}

export function listPlanStates(projectPath: string, limit = 50): PlanState[] {
  return loadAll(projectPath)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}
