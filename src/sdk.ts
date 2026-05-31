import { readFileSync } from "fs";
import { join } from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { applyAllLlmEnv, buildSdkEnv } from "./llm-env.ts";
import { renderTemplate } from "./prompt-template.ts";

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

export async function runSdkQuery(opts: {
  prompt: string;
  cwd: string;
  systemPrompt: string;
  role?: ModelRole;
  allowedTools?: string[];
  agents?: Record<string, { description: string; prompt: string; tools?: string[] }>;
  hooks?: Parameters<typeof query>[0]["options"] extends { hooks?: infer H } ? H : never;
  maxTurns?: number;
}): Promise<{ text: string; costUsd?: number }> {
  applyAllLlmEnv();
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

  await withExponentialBackoff(async () => {
    text = "";
    for await (const message of query({ prompt: opts.prompt, options: options as never })) {
      if ("type" in message && message.type === "assistant" && "message" in message) {
        const content = (message as { message: { content: unknown[] } }).message.content;
        for (const block of content) {
          if (typeof block === "object" && block && "type" in block && block.type === "text") {
            text += String((block as { text?: string }).text ?? "");
          }
        }
      }
      if ("type" in message && message.type === "result" && "result" in message) {
        const r = message as { result?: string; total_cost_usd?: number };
        if (r.result) text = r.result;
        if (typeof r.total_cost_usd === "number") costUsd = r.total_cost_usd;
      }
    }
  });

  return { text, costUsd };
}

async function withExponentialBackoff<T>(fn: () => Promise<T>): Promise<T> {
  const { withExponentialBackoff: retry } = await import("./retry.ts");
  return retry(fn);
}

/** @deprecated use applyAllLlmEnv from llm-env.ts */
export function applyClaudeSettingsEnv(): void {
  applyAllLlmEnv();
}

export { loadClaudeSettingsEnv } from "./llm-env.ts";
