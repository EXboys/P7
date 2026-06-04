import { readFileSync } from "fs";
import { join } from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { applyAllLlmEnv, buildSdkEnv } from "./llm-env.ts";
import { loadConfig } from "./config.ts";
import { renderTemplate } from "./prompt-template.ts";
import { writeSdkCost } from "./state.ts";
import { addSdkCost, emptySdkCost, parseUsage, type SdkCostSummary, type SdkTokenUsage } from "./sdk-cost.ts";
import {
  emptyToolTrace,
  ingestSdkMessageForToolTrace,
  type SdkToolTraceSummary,
} from "./sdk-tool-log.ts";

export type { SdkCostSummary, SdkTokenUsage, SdkToolTraceSummary };

export type ModelRole = "default" | "planner" | "executor" | "selector";

export function resolveModel(role: ModelRole): string | undefined {
  const roleEnv: Record<ModelRole, string | undefined> = {
    default: process.env.P7_MODEL,
    planner: process.env.P7_PLANNER_MODEL,
    executor: process.env.P7_EXECUTOR_MODEL,
    selector: process.env.P7_SELECTOR_MODEL,
  };
  return roleEnv[role] ?? process.env.ANTHROPIC_MODEL;
}

export function readPrompt(name: string): string {
  const path = join(import.meta.dir, "..", "prompts", name);
  return readFileSync(path, "utf-8");
}

/**
 * 读取 prompt 模板文件并渲染变量。
 * vars 为 undefined 时返回原始内容（向后兼容）；
 * 传入 vars 对象时，会对其中的 {{key}} 和 {{$if key}} 进行渲染。
 */
export function renderPrompt(name: string, vars?: Record<string, unknown>): string {
  const content = readPrompt(name);
  if (!vars) return content;
  return renderTemplate(content, vars);
}

let personaCache: string | null | undefined;

export function readPersona(): string | null {
  if (personaCache !== undefined) return personaCache;
  if (process.env.P7_PERSONA === "off") {
    personaCache = null;
    return personaCache;
  }
  const name = process.env.P7_PERSONA || "persona-p7.md";
  try {
    personaCache = readPrompt(name);
  } catch {
    personaCache = null;
  }
  return personaCache;
}

function composeSystemPrompt(systemPrompt: string, vars?: Record<string, unknown>): string {
  let base = systemPrompt;
  try {
    const coreCtx = readPrompt("core-context.md");
    base = `${vars ? renderTemplate(coreCtx, vars) : coreCtx}\n\n---\n\n${base}`;
  } catch {
    /* optional */
  }
  const persona = readPersona();
  if (persona) {
    return `${vars ? renderTemplate(persona, vars) : persona}\n\n---\n\n${base}`;
  }
  return base;
}

import { apiHostnameFromBaseUrl, resolveAllowedApiDomains } from "./api-domain.ts";

export { apiHostnameFromBaseUrl, resolveAllowedApiDomains } from "./api-domain.ts";

/**
 * Validate that ANTHROPIC_BASE_URL (if set) resolves to an allowed API domain.
 * Whitelist = project config + current ANTHROPIC_BASE_URL hostname.
 */
export function validateApiDomain(projectPath?: string): void {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl) return;

  const hostname = apiHostnameFromBaseUrl(baseUrl);
  if (!hostname) {
    throw new Error(`Invalid ANTHROPIC_BASE_URL: "${baseUrl}". Cannot parse hostname.`);
  }

  let configured: string[];
  if (projectPath) {
    try {
      configured = loadConfig(projectPath).allowed_api_domains;
    } catch {
      configured = ["api.anthropic.com"];
    }
  } else {
    configured = ["api.anthropic.com"];
  }

  const allowedDomains = resolveAllowedApiDomains(configured, baseUrl);
  if (!allowedDomains.includes(hostname)) {
    throw new Error(
      `API domain "${hostname}" is not in the allowed list: [${allowedDomains.join(", ")}]. ` +
      `Add "${hostname}" to allowed_api_domains in your project config.`,
    );
  }
}

export async function runSdkQuery(opts: {
  prompt: string;
  cwd: string;
  systemPrompt: string;
  role?: ModelRole;
  allowedTools?: string[];
  agents?: Record<string, { description: string; prompt: string; tools?: string[] }>;
  hooks?: Parameters<typeof query>[0]["options"] extends { hooks?: infer H } ? H : never;
  maxTurns?: number;
  timeoutMs?: number;
  planId?: string;
  projectPath?: string;
  goal?: string;
  toolTrace?: SdkToolTraceSummary;
}): Promise<{ text: string; costUsd?: number; usage?: SdkTokenUsage; toolTrace?: SdkToolTraceSummary }> {
  applyAllLlmEnv();
  validateApiDomain(opts.projectPath);
  const model = resolveModel(opts.role ?? "default");
  const options: Record<string, unknown> = {
    cwd: opts.cwd,
    systemPrompt: composeSystemPrompt(opts.systemPrompt),
    permissionMode: "default",
    settingSources: ["user", "project"],
    env: buildSdkEnv(),
    maxTurns: opts.maxTurns ?? 30,
  };
  if (model) options.model = model;
  if (opts.allowedTools) options.allowedTools = opts.allowedTools;
  if (opts.agents) options.agents = opts.agents;
  if (opts.hooks) options.hooks = opts.hooks;

  let text = "";
  let costUsd: number | undefined;
  let usage = parseUsage(undefined);
  const toolTrace = opts.toolTrace ?? emptyToolTrace();

  const timeoutMs = opts.timeoutMs ?? defaultSdkTimeoutMs(opts.role ?? "default");
  await withExponentialBackoff(async () => {
    text = "";
    const started = Date.now();
    for await (const message of withTimeout(
      query({ prompt: opts.prompt, options: options as never }),
      timeoutMs,
      `Claude SDK ${opts.role ?? "default"} timed out after ${Math.round(timeoutMs / 60000)}m`,
    )) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `Claude SDK ${opts.role ?? "default"} timed out after ${Math.round(timeoutMs / 60000)}m`,
        );
      }
      ingestSdkMessageForToolTrace(message, toolTrace);
      if ("type" in message && message.type === "assistant" && "message" in message) {
        const content = (message as { message: { content: unknown[] } }).message.content;
        for (const block of content) {
          if (typeof block === "object" && block && "type" in block && block.type === "text") {
            text += String((block as { text?: string }).text ?? "");
          }
        }
      }
      if ("type" in message && message.type === "result" && "result" in message) {
        const r = message as {
          result?: string;
          total_cost_usd?: number;
          usage?: unknown;
          modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>;
        };
        if (r.result) text = r.result;
        if (typeof r.total_cost_usd === "number") costUsd = r.total_cost_usd;
        if (r.usage) usage = parseUsage(r.usage);
        else if (r.modelUsage) {
          const merged = emptySdkCost();
          for (const m of Object.values(r.modelUsage)) {
            merged.usage = addSdkCost(merged, {
              costUsd: m.costUSD,
              usage: {
                inputTokens: m.inputTokens ?? 0,
                outputTokens: m.outputTokens ?? 0,
                cacheReadInputTokens: m.cacheReadInputTokens ?? 0,
                cacheCreationInputTokens: m.cacheCreationInputTokens ?? 0,
              },
            }).usage;
          }
          usage = merged.usage;
        }
      }
    }
  });

  if (costUsd !== undefined && costUsd > 0 && opts.projectPath) {
    writeSdkCost(opts.projectPath, {
      planId: opts.planId,
      role: opts.role ?? "default",
      model,
      costUsd,
      usage,
      goal: opts.goal,
    });
  }

  return { text, costUsd, usage, toolTrace };
}

async function withExponentialBackoff<T>(fn: () => Promise<T>): Promise<T> {
  const { withExponentialBackoff: retry } = await import("./retry.ts");
  return retry(fn);
}

function defaultSdkTimeoutMs(role: ModelRole): number {
  if (role === "planner" || role === "selector") return 15 * 60 * 1000;
  if (role === "executor") return 30 * 60 * 1000;
  return 20 * 60 * 1000;
}

async function* withTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  message: string,
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (result.done) return;
    yield result.value;
  }
}

/** @deprecated use applyAllLlmEnv from llm-env.ts */
export function applyClaudeSettingsEnv(): void {
  applyAllLlmEnv();
}

export { loadClaudeSettingsEnv } from "./llm-env.ts";
