/** 从 ANTHROPIC_BASE_URL 解析 hostname；解析失败返回 null */
export function apiHostnameFromBaseUrl(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    try {
      return new URL(`https://${baseUrl}`).hostname;
    } catch {
      return null;
    }
  }
}

/** 配置白名单 + 控制台已配置的 ANTHROPIC_BASE_URL（避免 DeepSeek 等代理被误拦） */
export function resolveAllowedApiDomains(
  configured: string[],
  baseUrl = process.env.ANTHROPIC_BASE_URL,
): string[] {
  const out = [...configured];
  if (!baseUrl) return out;
  const hostname = apiHostnameFromBaseUrl(baseUrl);
  if (!hostname) {
    throw new Error(`Invalid ANTHROPIC_BASE_URL: "${baseUrl}". Cannot parse hostname.`);
  }
  if (!out.includes(hostname)) out.push(hostname);
  return out;
}
