import { hasLlmAuth, mergeLlmEnv } from "./llm-env.ts";
import { loadCachedLlmProbeForEnv, saveLlmProbeCache } from "./llm-probe-cache.ts";

export type LlmProbeResult = {
  ok: boolean;
  detail: string;
  latencyMs?: number;
  model?: string;
  endpoint?: string;
};

function messagesEndpoint(baseUrl: string): string {
  const base = (baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
  if (base.endsWith("/anthropic")) return `${base}/v1/messages`;
  if (base.endsWith("/v1")) return `${base}/messages`;
  return `${base}/v1/messages`;
}

/** 向 Anthropic 兼容网关发最小请求，验证 Token / Base URL / 模型是否可用 */
export async function probeLlmConnection(
  env: Record<string, string> = mergeLlmEnv(),
): Promise<LlmProbeResult> {
  if (!hasLlmAuth(env)) {
    return { ok: false, detail: "未配置 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY" };
  }

  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
  const model =
    env.ANTHROPIC_MODEL ||
    env.P7_MODEL ||
    env.P7_PLANNER_MODEL ||
    "deepseek-v4-flash";
  const endpoint = messagesEndpoint(env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");

  const start = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": token,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "reply with ok" }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const latencyMs = Date.now() - start;
    const body = await res.text();

    if (res.ok) {
      const result: LlmProbeResult = {
        ok: true,
        detail: `模型 ${model} 请求成功（${latencyMs}ms）`,
        latencyMs,
        model,
        endpoint,
      };
      saveLlmProbeCache(env, result);
      return result;
    }

    let hint = body.slice(0, 240);
    if (res.status === 401) hint = "鉴权失败，请检查 API Key / Token 是否正确";
    else if (res.status === 404) hint = "接口 404，请检查 Base URL 是否为 Anthropic 兼容地址";
    else if (res.status === 400 && /model/i.test(body)) hint = `模型名可能无效：${model}`;

    return {
      ok: false,
      detail: `HTTP ${res.status} — ${hint}`,
      latencyMs,
      model,
      endpoint,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      detail: msg.includes("Timeout") ? "请求超时（30s），请检查网络或 Base URL" : msg,
      model,
      endpoint,
    };
  }
}
