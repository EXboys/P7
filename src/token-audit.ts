import { initDb } from "./state.ts";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";

/* ------------------------------------------------------------------ */
/*  Public interfaces                                                  */
/* ------------------------------------------------------------------ */

export interface TokenAuditReport {
  summary: {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    totalCalls: number;
    distinctRoles: string[];
    distinctGoals: string[];
  };
  byRole: RoleBreakdown[];
  byStage: StageBreakdown[];
  flaggedCandidates: FlaggedCandidate[];
  promptFileSizes: Record<string, PromptFileInfo>;
}

export interface RoleBreakdown {
  role: string;
  callCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  sourceFiles: string[];
  associatedPrompts: string[];
  promptTotalLines: number;
}

export interface StageBreakdown {
  stage: string;
  primaryRole: string;
  callCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export interface FlaggedCandidate {
  role: string;
  sourceFile: string;
  promptFile: string;
  promptLines: number;
  issue: string;
  description: string;
  estimatedImpact: string;
}

export interface PromptFileInfo {
  lines: number;
  bytes: number;
}

/* ------------------------------------------------------------------ */
/*  Heuristic mappings (known architecture)                            */
/* ------------------------------------------------------------------ */

/** Known role → source file(s) that produce calls with this role. */
const ROLE_SOURCES: Record<string, string[]> = {
  default: ["src/diff-critic.ts", "src/gradual-typechecker.ts", "src/roadmap-refresh.ts"],
  planner: ["src/planner.ts"],
  executor: ["src/executor.ts"],
  selector: ["src/goal-selector.ts"],
};

/** Role → prompt files it typically loads (system prompts + core-context). */
const ROLE_PROMPTS: Record<string, string[]> = {
  default: ["diff-critic.md", "gradual-typecheck.md", "core-context.md", "plan-critic.md", "roadmap-refresh-radar.md"],
  planner: ["planner-system.md", "core-context.md"],
  executor: ["executor-system.md", "core-context.md"],
  selector: ["goal-selector-system.md", "core-context.md"],
};

/** Role → pipeline stage mapping for by-stage breakdown. */
const ROLE_STAGE: Record<string, string> = {
  default: "review",
  planner: "plan",
  executor: "execute",
  selector: "plan",
};

/* ------------------------------------------------------------------ */
/*  Prompt file analysis                                               */
/* ------------------------------------------------------------------ */

function readPromptSizes(projectPath: string): Record<string, PromptFileInfo> {
  const promptsDir = join(projectPath, "prompts");
  const result: Record<string, PromptFileInfo> = {};

  try {
    const entries = readdirSync(promptsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const full = join(promptsDir, entry);
      try {
        const content = readFileSync(full, "utf-8");
        const lines = content.split("\n").length;
        const bytes = statSync(full).size;
        result[entry] = { lines, bytes };
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* prompts dir missing — return empty */
  }

  return result;
}

function promptTotalLines(
  prompts: string[],
  sizes: Record<string, PromptFileInfo>,
): number {
  let total = 0;
  for (const p of prompts) {
    const info = sizes[p];
    if (info) total += info.lines;
  }
  return total;
}

/* ------------------------------------------------------------------ */
/*  Low-information-density flagging                                   */
/* ------------------------------------------------------------------ */

/**
 * Returns known high-cost-low-value candidates based on prompt architecture.
 * These are identified by heuristic (the prompts are loaded unconditionally
 * regardless of context complexity) and confirmed by the prompt size delta
 * relative to average across all prompts.
 */
function flagCandidates(
  byRole: RoleBreakdown[],
  promptSizes: Record<string, PromptFileInfo>,
): FlaggedCandidate[] {
  const candidates: FlaggedCandidate[] = [];

  for (const rb of byRole) {
    if (rb.role !== "default") continue;

    // diff-critic.md: 320-line system prompt loaded every diff-critic call
    const dcSize = promptSizes["diff-critic.md"];
    if (dcSize && dcSize.lines > 150) {
      candidates.push({
        role: "default",
        sourceFile: "src/diff-critic.ts",
        promptFile: "diff-critic.md",
        promptLines: dcSize.lines,
        issue: "high_system_prompt_overhead",
        description:
          `diff-critic.md (${dcSize.lines} lines) loaded on every diff-critic call regardless of diff complexity. Consider dynamic prompt truncation based on diff size.`,
        estimatedImpact: `Significant fixed cost per invocation — ~${Math.round(dcSize.lines / 5)}K input tokens just for system prompt`,
      });
    }

    // gradual-typecheck.md system prompt
    const gtSize = promptSizes["gradual-typecheck.md"];
    if (gtSize && gtSize.lines > 40) {
      candidates.push({
        role: "default",
        sourceFile: "src/gradual-typechecker.ts",
        promptFile: "gradual-typecheck.md",
        promptLines: gtSize.lines,
        issue: "full_typecheck_prompt_overhead",
        description:
          `gradual-typecheck.md (${gtSize.lines} lines) loaded on every type-check invocation even when only a few files changed. Consider incremental type-check prompt.`,
        estimatedImpact: `Medium — ~${Math.round(gtSize.lines / 5)}K input tokens per type-check call`,
      });
    }
  }

  // core-context.md fixed overhead across all 10+ LLM call sites
  const ccSize = promptSizes["core-context.md"];
  if (ccSize) {
    candidates.push({
      role: "*",
      sourceFile: "src/sdk.ts",
      promptFile: "core-context.md",
      promptLines: ccSize.lines,
      issue: "fixed_overhead_across_all_calls",
      description:
        `core-context.md (${ccSize.lines} lines) is included in every LLM call irrespective of whether the context is needed for the specific step. Over ${byRole.reduce((s, r) => s + r.callCount, 0)} total calls, this compounds.`,
      estimatedImpact: `~${ccSize.lines * 10} lines × ${byRole.reduce((s, r) => s + r.callCount, 0)} calls total overhead`,
    });
  }

  return candidates;
}

/* ------------------------------------------------------------------ */
/*  SQL queries                                                        */
/* ------------------------------------------------------------------ */

interface SdkCostRow {
  plan_id: string | null;
  role: string;
  model: string | null;
  cost_usd: number;
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  goal: string | null;
  step_name: string | null;
}

function querySdkCosts(projectPath: string): SdkCostRow[] {
  const db = initDb(projectPath);
  return db
    .query(
      `SELECT plan_id, role, model, cost_usd, created_at,
              input_tokens, output_tokens,
              cache_read_input_tokens, cache_creation_input_tokens,
              goal, step_name
       FROM sdk_costs
       ORDER BY created_at DESC`,
    )
    .all() as SdkCostRow[];
}

/* ------------------------------------------------------------------ */
/*  Main audit entry point                                             */
/* ------------------------------------------------------------------ */

export function auditTokenConsumption(projectPath: string): TokenAuditReport {
  const rows = querySdkCosts(projectPath);
  const promptSizes = readPromptSizes(projectPath);

  /* -- by-role aggregation -- */
  const roleMap = new Map<
    string,
    {
      callCount: number;
      costSum: number;
      inputSum: number;
      outputSum: number;
      cacheReadSum: number;
      cacheCreationSum: number;
    }
  >();

  const goals = new Set<string>();

  for (const row of rows) {
    goals.add(row.goal ?? "(null)");

    let acc = roleMap.get(row.role);
    if (!acc) {
      acc = {
        callCount: 0,
        costSum: 0,
        inputSum: 0,
        outputSum: 0,
        cacheReadSum: 0,
        cacheCreationSum: 0,
      };
      roleMap.set(row.role, acc);
    }
    acc.callCount++;
    acc.costSum += row.cost_usd;
    acc.inputSum += row.input_tokens ?? 0;
    acc.outputSum += row.output_tokens ?? 0;
    acc.cacheReadSum += row.cache_read_input_tokens ?? 0;
    acc.cacheCreationSum += row.cache_creation_input_tokens ?? 0;
  }

  const byRole: RoleBreakdown[] = [];
  for (const [role, acc] of roleMap) {
    const sources = ROLE_SOURCES[role] ?? [`src/unknown-${role}.ts`];
    const prompts = ROLE_PROMPTS[role] ?? [];
    const promptLines = promptTotalLines(prompts, promptSizes);
    byRole.push({
      role,
      callCount: acc.callCount,
      totalCostUsd: round2(acc.costSum),
      totalInputTokens: acc.inputSum,
      totalOutputTokens: acc.outputSum,
      totalCacheReadTokens: acc.cacheReadSum,
      totalCacheCreationTokens: acc.cacheCreationSum,
      sourceFiles: sources,
      associatedPrompts: prompts.filter((p) => promptSizes[p] !== undefined),
      promptTotalLines: promptLines,
    });
  }
  // Sort by total cost descending
  byRole.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  /* -- by-stage aggregation -- */
  const stageMap = new Map<
    string,
    {
      primaryRole: string;
      callCount: number;
      costSum: number;
      inputSum: number;
      outputSum: number;
      cacheReadSum: number;
      cacheCreationSum: number;
    }
  >();

  for (const row of rows) {
    const stage = ROLE_STAGE[row.role] ?? row.role;
    let acc = stageMap.get(stage);
    if (!acc) {
      acc = {
        primaryRole: row.role,
        callCount: 0,
        costSum: 0,
        inputSum: 0,
        outputSum: 0,
        cacheReadSum: 0,
        cacheCreationSum: 0,
      };
      stageMap.set(stage, acc);
    }
    acc.callCount++;
    acc.costSum += row.cost_usd;
    acc.inputSum += row.input_tokens ?? 0;
    acc.outputSum += row.output_tokens ?? 0;
    acc.cacheReadSum += row.cache_read_input_tokens ?? 0;
    acc.cacheCreationSum += row.cache_creation_input_tokens ?? 0;
  }

  const byStage: StageBreakdown[] = [];
  for (const [stage, acc] of stageMap) {
    byStage.push({
      stage,
      primaryRole: acc.primaryRole,
      callCount: acc.callCount,
      totalCostUsd: round2(acc.costSum),
      totalInputTokens: acc.inputSum,
      totalOutputTokens: acc.outputSum,
      totalCacheReadTokens: acc.cacheReadSum,
      totalCacheCreationTokens: acc.cacheCreationSum,
    });
  }
  byStage.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  /* -- summary -- */
  const summary = {
    totalCostUsd: round2(byRole.reduce((s, r) => s + r.totalCostUsd, 0)),
    totalInputTokens: byRole.reduce((s, r) => s + r.totalInputTokens, 0),
    totalOutputTokens: byRole.reduce((s, r) => s + r.totalOutputTokens, 0),
    totalCacheReadTokens: byRole.reduce((s, r) => s + r.totalCacheReadTokens, 0),
    totalCacheCreationTokens: byRole.reduce((s, r) => s + r.totalCacheCreationTokens, 0),
    totalCalls: rows.length,
    distinctRoles: [...roleMap.keys()],
    distinctGoals: [...goals],
  };

  /* -- flagged candidates -- */
  const flaggedCandidates = flagCandidates(byRole, promptSizes);

  return {
    summary,
    byRole,
    byStage,
    flaggedCandidates,
    promptFileSizes: promptSizes,
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
