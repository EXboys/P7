import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { homePathForRead, p7HomeDir } from "./p7-paths.ts";

const SERVER_PATH = homePathForRead("server.json");
const SECRETS_PATH = homePathForRead("secrets.json");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const DOTENV_CANDIDATES = [join(p7HomeDir(), ".env"), join(homedir(), ".hermes", ".env")];

function loadDotEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (k && v) out[k] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

function loadDotEnvLayers(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const path of DOTENV_CANDIDATES) {
    for (const [k, v] of Object.entries(loadDotEnvFile(path))) {
      if (!merged[k]) merged[k] = v;
    }
  }
  return merged;
}

function readJsonEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    if (typeof raw.env === "object" && raw.env) {
      for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
        if (typeof v === "string" && v) out[k] = v;
      }
    }
    if (typeof raw.anthropic_auth_token === "string" && raw.anthropic_auth_token) {
      out.ANTHROPIC_AUTH_TOKEN = raw.anthropic_auth_token;
    }
    if (typeof raw.anthropic_api_key === "string" && raw.anthropic_api_key) {
      out.ANTHROPIC_API_KEY = raw.anthropic_api_key;
    }
    if (typeof raw.anthropic_base_url === "string" && raw.anthropic_base_url) {
      out.ANTHROPIC_BASE_URL = raw.anthropic_base_url;
    }
    return out;
  } catch {
    return {};
  }
}

/** Gateway + model fields from ~/.p7/server.json */
export function loadServerAuthEnv(): Record<string, string> {
  if (!existsSync(SERVER_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(SERVER_PATH, "utf-8")) as Record<string, unknown>;
    const env: Record<string, string> = {};
    if (typeof raw.anthropic_api_key === "string" && raw.anthropic_api_key) {
      env.ANTHROPIC_API_KEY = raw.anthropic_api_key;
    }
    if (typeof raw.anthropic_auth_token === "string" && raw.anthropic_auth_token) {
      env.ANTHROPIC_AUTH_TOKEN = raw.anthropic_auth_token;
    }
    if (typeof raw.anthropic_base_url === "string" && raw.anthropic_base_url) {
      env.ANTHROPIC_BASE_URL = raw.anthropic_base_url;
    }
    const m = raw.claude_models as Record<string, string> | undefined;
    if (m?.default) {
      env.ANTHROPIC_MODEL = m.default;
      env.P7_MODEL = m.default;
    }
    if (m?.planner) env.P7_PLANNER_MODEL = m.planner;
    if (m?.executor) env.P7_EXECUTOR_MODEL = m.executor;
    if (m?.selector) env.P7_SELECTOR_MODEL = m.selector;
    if (m?.subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = m.subagent;
    return env;
  } catch {
    return {};
  }
}

export function loadClaudeSettingsEnv(): Record<string, string> {
  return readJsonEnv(CLAUDE_SETTINGS);
}

function loadSecretsEnv(): Record<string, string> {
  return readJsonEnv(SECRETS_PATH);
}

/** Map common provider env vars to Anthropic-compatible names for the SDK. */
function aliasProviderKeys(env: Record<string, string>): void {
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    const ds = process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY;
    if (ds) env.ANTHROPIC_AUTH_TOKEN = ds;
  }
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    const oai = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;
    if (oai) env.ANTHROPIC_API_KEY = oai;
  }
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    const mai = process.env.MAI_CODE_API_KEY || env.MAI_CODE_API_KEY;
    if (mai) env.ANTHROPIC_API_KEY = mai;
  }
}

/**
 * Merge server.json, ~/.claude/settings.json, secrets.json into one env map.
 * Later sources do not override non-empty values already set in `base`.
 */
export function mergeLlmEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string" && v) merged[k] = v;
  }
  const layers = [
    loadDotEnvLayers(),
    loadClaudeSettingsEnv(),
    loadServerAuthEnv(),
    loadSecretsEnv(),
  ];
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (!merged[k]) merged[k] = v;
    }
  }
  aliasProviderKeys(merged);
  return merged;
}

export function hasLlmAuth(env: Record<string, string> = mergeLlmEnv()): boolean {
  return Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY);
}

export function llmAuthErrorMessage(): string {
  return [
    "未配置 LLM 鉴权，无法 AI 生成 Roadmap/Plan。",
    "任选其一：",
    "1) ~/.p7/server.json 增加 \"anthropic_auth_token\": \"sk-...\"",
    "2) ~/.p7/secrets.json 的 env.ANTHROPIC_AUTH_TOKEN",
    "3) ~/.claude/settings.json 的 env.ANTHROPIC_AUTH_TOKEN",
    "4) ~/.hermes/.env 或 ~/.p7/.env 中的 DEEPSEEK_API_KEY",
    "5) 环境变量 DEEPSEEK_API_KEY 或 ANTHROPIC_AUTH_TOKEN",
    "保存后重启 P7 控制台，或在「系统设置」填写网关与 Token。",
  ].join("\n");
}

export function assertLlmAuth(): void {
  if (!hasLlmAuth()) throw new Error(llmAuthErrorMessage());
}

/** Apply merged gateway env to the current process (fills empty keys only). */
export function applyAllLlmEnv(): void {
  const merged = mergeLlmEnv();
  for (const [k, v] of Object.entries(merged)) {
    if (process.env[k] === undefined || process.env[k] === "") {
      process.env[k] = v;
    }
  }
}

/**
 * Full env for Claude Agent SDK subprocess.
 * SDK `options.env` replaces the child environment — must spread process.env.
 */
export function buildSdkEnv(): Record<string, string> {
  return mergeLlmEnv(process.env as Record<string, string | undefined>);
}

applyAllLlmEnv();
