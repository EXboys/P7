import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { p7HomeDir } from "./p7-paths.ts";
import type { LlmProbeResult } from "./llm-probe.ts";

export type LlmProbeCacheEntry = {
  fingerprint: string;
  ok: boolean;
  detail: string;
  probedAt: string;
  model?: string;
  latencyMs?: number;
};

function cachePath(): string {
  return join(p7HomeDir(), "llm-probe-cache.json");
}

/** 同一 Base URL + 模型 + Key 尾缀视为同一套网关配置 */
export function llmConfigFingerprint(env: Record<string, string>): string {
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
  const base = (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const model =
    env.ANTHROPIC_MODEL || env.P7_MODEL || env.P7_PLANNER_MODEL || "";
  const tail = token.length >= 8 ? token.slice(-8) : token;
  return createHash("sha256").update(`${base}|${model}|${tail}`).digest("hex").slice(0, 16);
}

export function loadLlmProbeCache(): LlmProbeCacheEntry | null {
  const p = cachePath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as LlmProbeCacheEntry;
    if (!raw.fingerprint || !raw.probedAt) return null;
    return raw;
  } catch {
    return null;
  }
}

export function loadCachedLlmProbeForEnv(env: Record<string, string>): LlmProbeResult | null {
  const cached = loadLlmProbeCache();
  if (!cached?.ok) return null;
  if (cached.fingerprint !== llmConfigFingerprint(env)) return null;
  const when = new Date(cached.probedAt).toLocaleString("zh-CN", { hour12: false });
  return {
    ok: true,
    detail: `${cached.detail}（${when} 检测，Key/模型未变）`,
    model: cached.model,
    latencyMs: cached.latencyMs,
  };
}

export function saveLlmProbeCache(env: Record<string, string>, probe: LlmProbeResult): void {
  if (!probe.ok) return;
  const dir = p7HomeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const entry: LlmProbeCacheEntry = {
    fingerprint: llmConfigFingerprint(env),
    ok: true,
    detail: probe.detail,
    probedAt: new Date().toISOString(),
    model: probe.model,
    latencyMs: probe.latencyMs,
  };
  writeFileSync(cachePath(), JSON.stringify(entry, null, 2));
}

export function clearLlmProbeCache(): void {
  const p = cachePath();
  if (existsSync(p)) writeFileSync(p, "{}");
}
