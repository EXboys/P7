import { readPrompt, runSdkQuery } from "./sdk.ts";
import { addSdkCost, emptySdkCost, type SdkCostSummary } from "./sdk-cost.ts";
import type { DiffCriticFinding, DcSeverity } from "./types.ts";

/* ── AI 生成代码特征维度声明 ── */

/** 已知 AI 生成代码退化维度列表。新增维度时只需在此追加，正则自动跟随。 */
export const AI_CODE_DIMENSIONS = [
  "过度抽象",
  "模板重复",
  "不合理嵌套",
  "幻觉检测",
  "安全越狱",
] as const;

export type AiCodeDimension = (typeof AI_CODE_DIMENSIONS)[number];

/** 疑似前缀（不确定时的降级标注） */
const SUSPICIOUS_PREFIXES = ["疑似AI特征", "疑似越狱模式"];

/** 构建行级正则：匹配 `- [severity] AI 生成代码特征-{维度}: {消息}` 或疑似前缀行 */
const FINDING_LINE_RE = new RegExp(
  `^\\s*-\\s*\\[(info|warning|blocker)\\]\\s*` +
    `(AI\\s生成代码特征-(?:${AI_CODE_DIMENSIONS.join("|")})` +
    `|${SUSPICIOUS_PREFIXES.join("|")}):\\s*(.+)$`,
  "i",
);

/** 降级正则：仅匹配 `- [severity]` 前缀，兜底捕获未知维度 */
const FALLBACK_SEVERITY_RE = /^\s*-\s*\[(info|warning|blocker)\]\s*(.+)$/i;

/**
 * 将 LLM 返回的 findings 文本解析为结构化 DiffCriticFinding 数组。
 * 优先匹配规范格式（含 AI 生成代码特征前缀），不匹配时走降级 regex 兜底。
 */
export function parseFindings(text: string): DiffCriticFinding[] {
  const findings: DiffCriticFinding[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(FINDING_LINE_RE);
    if (m) {
      const severity = m[1].toLowerCase() as DcSeverity;
      const prefix = m[2];
      const message = m[3].trim();
      // 从 "AI 生成代码特征-{dimension}" 中提取 dimension；疑似类直接用前缀
      const dimension = prefix.startsWith("AI 生成代码特征-")
        ? prefix.slice("AI 生成代码特征-".length)
        : prefix;
      findings.push({ dimension, severity, message, prefix });
      continue;
    }
    // 降级兜底：只要行内包含 [severity] 就捕获剩余文本
    const f = line.match(FALLBACK_SEVERITY_RE);
    if (f) {
      findings.push({
        dimension: "other",
        severity: f[1].toLowerCase() as DcSeverity,
        message: f[2].trim(),
      });
    }
  }
  return findings;
}

export async function reviewDiff(
  projectPath: string,
  diffStat: string,
  planSummary: string,
): Promise<{ ok: boolean; findings: string; structuredFindings: DiffCriticFinding[]; cost?: SdkCostSummary }> {
  try {
    const system = readPrompt("diff-critic.md");
    const { text, costUsd, usage } = await runSdkQuery({
      prompt: `## 计划摘要\n${planSummary}\n\n## git diff --stat\n\`\`\`\n${diffStat}\n\`\`\`\n\n请审查。`,
      cwd: projectPath,
      systemPrompt: system,
      role: "default",
      allowedTools: ["Read", "Grep"],
    });
    const m = text.match(/OK:\s*(true|false)/i);
    const ok = !m || m[1].toLowerCase() === "true";
    const cost = addSdkCost(emptySdkCost(), { costUsd, usage });
    return { ok, findings: text, structuredFindings: parseFindings(text), cost };
  } catch {
    return { ok: true, findings: "diff-critic fallthrough (error)", structuredFindings: [] };
  }
}
