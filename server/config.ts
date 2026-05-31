import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { homePathForRead, p7HomeDir } from "../src/p7-paths.ts";

export const ServerConfigSchema = z.object({
  dingtalk: z
    .object({
      webhook: z.string().url(),
      robot_secret: z.string().optional(),
    })
    .optional(),
  allowed_user_ids: z.array(z.string()).default([]),
  project_aliases: z.record(z.string(), z.string()).default({}),
  port: z.number().int().default(8443),
  bind_host: z.string().default("127.0.0.1"),
  cli_entry: z.string().default(""),
  bun_bin: z.string().default("bun"),
  scheduler_enabled: z.boolean().default(true),
  /** 无 OPEN PR 阻塞且无运行中任务时，调度器巡检间隔（分钟） */
  scheduler_interval_minutes: z.number().min(1).max(30).default(2),
  daily_cost_cap_usd: z.number().default(1000),
  max_concurrent_projects: z.number().int().default(2),
  persona_enabled: z.boolean().default(true),
  persona_file: z.string().default("persona-p7.md"),
  model_gateway_preset: z.string().default("deepseek"),
  claude_models: z
    .object({
      default: z.string().optional(),
      planner: z.string().optional(),
      executor: z.string().optional(),
      selector: z.string().optional(),
      subagent: z.string().optional(),
    })
    .optional(),
  anthropic_api_key: z.string().optional(),
  anthropic_auth_token: z.string().optional(),
  anthropic_base_url: z.string().optional(),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function serverConfigDir(): string {
  return p7HomeDir();
}

export function serverConfigPath(): string {
  return join(p7HomeDir(), "server.json");
}

export function loadServerConfig(): ServerConfig {
  const path = homePathForRead("server.json");
  if (!existsSync(path)) {
    const defaults: ServerConfig = {
      allowed_user_ids: [],
      project_aliases: {},
      port: 8443,
      bind_host: "127.0.0.1",
      cli_entry: join(import.meta.dir, "..", "src", "index.ts"),
      bun_bin: "bun",
      scheduler_enabled: true,
      scheduler_interval_minutes: 2,
      daily_cost_cap_usd: 1000,
      max_concurrent_projects: 2,
      persona_enabled: true,
      persona_file: "persona-p7.md",
      model_gateway_preset: "deepseek",
    };
    saveServerConfig(defaults);
    return defaults;
  }
  return ServerConfigSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

export function saveServerConfig(cfg: ServerConfig): void {
  const dir = serverConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(serverConfigPath(), JSON.stringify(cfg, null, 2));
}

export function dashboardBaseUrl(cfg: ServerConfig): string {
  const host = cfg.bind_host === "0.0.0.0" ? "127.0.0.1" : cfg.bind_host;
  return `http://${host}:${cfg.port}`;
}

export function modelEnvs(cfg: ServerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.anthropic_api_key) env.ANTHROPIC_API_KEY = cfg.anthropic_api_key;
  if (cfg.anthropic_auth_token) env.ANTHROPIC_AUTH_TOKEN = cfg.anthropic_auth_token;
  if (cfg.anthropic_base_url) env.ANTHROPIC_BASE_URL = cfg.anthropic_base_url;
  const m = cfg.claude_models;
  if (m?.default) {
    env.P7_MODEL = m.default;
    env.ANTHROPIC_MODEL = m.default;
  }
  if (m?.planner) env.P7_PLANNER_MODEL = m.planner;
  if (m?.executor) env.P7_EXECUTOR_MODEL = m.executor;
  if (m?.selector) env.P7_SELECTOR_MODEL = m.selector;
  if (m?.subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = m.subagent;
  env.P7_PERSONA = cfg.persona_enabled ? cfg.persona_file : "off";
  return env;
}

/** Serialize the gateway settings into a ~/.claude/settings.json env block. */
export function buildClaudeSettings(cfg: ServerConfig): { env: Record<string, string> } {
  const env: Record<string, string> = {};
  if (cfg.anthropic_base_url) env.ANTHROPIC_BASE_URL = cfg.anthropic_base_url;
  if (cfg.anthropic_auth_token) env.ANTHROPIC_AUTH_TOKEN = cfg.anthropic_auth_token;
  if (cfg.anthropic_api_key) env.ANTHROPIC_API_KEY = cfg.anthropic_api_key;
  const m = cfg.claude_models;
  if (m?.default) {
    env.ANTHROPIC_MODEL = m.default;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = m.default;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = m.default;
  }
  const haiku = m?.subagent ?? m?.selector;
  if (haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
  if (m?.subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = m.subagent;
  return { env };
}

export function writeClaudeSettings(cfg: ServerConfig): string {
  const path = join(homedir(), ".claude", "settings.json");
  const dir = join(homedir(), ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      existing = {};
    }
  }
  const next = {
    ...existing,
    env: { ...(existing.env as Record<string, string> | undefined), ...buildClaudeSettings(cfg).env },
  };
  writeFileSync(path, JSON.stringify(next, null, 2));
  return path;
}
