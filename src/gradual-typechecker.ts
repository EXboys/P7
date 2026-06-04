import { readPrompt, runSdkQuery } from "./sdk.ts";
import { addSdkCost, emptySdkCost, type SdkCostSummary } from "./sdk-cost.ts";
import type { DiffCriticFinding, DcSeverity } from "./types.ts";

/** 渐进类型违规类别列表 */
const GRADUAL_TYPE_CATEGORIES = [
  "any逃逸",
  "类型抑制",
  "不安全断言",
  "类型变宽",
] as const;

/** 构建行级正则：匹配 `- [severity] 渐进类型-{类别}: {消息}` */
const FINDING_LINE_RE = new RegExp(
  `^\\s*-\\s*\\[(info|warning|blocker)\\]\\s*` +
    `渐进类型-(${GRADUAL_TYPE_CATEGORIES.join("|")}):\\s*(.+)$`,
  "i",
);

/** 降级正则：仅匹配 `- [severity]` 前缀，兜底捕获未知格式 */
const FALLBACK_SEVERITY_RE = /^\s*-\s*\[(info|warning|blocker)\]\s*(.+)$/i;

/**
 * 将 LLM 返回的 findings 文本解析为结构化 DiffCriticFinding 数组。
 * 优先匹配规范格式（含渐进类型前缀），不匹配时走降级 regex 兜底。
 */
export function parseGradualTypeFindings(text: string): DiffCriticFinding[] {
  const findings: DiffCriticFinding[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(FINDING_LINE_RE);
    if (m) {
      findings.push({
        dimension: `gradual-typecheck-${m[2]}`,
        severity: m[1].toLowerCase() as DcSeverity,
        message: m[3].trim(),
      });
      continue;
    }
    const f = line.match(FALLBACK_SEVERITY_RE);
    if (f) {
      findings.push({
        dimension: "gradual-typecheck",
        severity: f[1].toLowerCase() as DcSeverity,
        message: f[2].trim(),
      });
    }
  }
  return findings;
}

/**
 * 审查 diff 中的渐进类型违规。
 *
 * 读取 prompts/gradual-typecheck.md 作为系统提示，将 diffStat 插值到用户消息中，
 * 调用 runSdkQuery，提取 OK/FINDINGS 行，返回结构化结果。
 *
 * @param projectPath - 项目根目录路径
 * @param diffStat - git diff 文本内容
 * @returns 审查结果，包含 ok 判定、原始文本、结构化 findings 和成本信息
 */
export async function reviewGradualTypeCheck(
  projectPath: string,
  diffStat: string,
): Promise<{
  ok: boolean;
  findings: string;
  structuredFindings: DiffCriticFinding[];
  cost?: SdkCostSummary;
}> {
  try {
    const system = readPrompt("gradual-typecheck.md");
    const { text, costUsd, usage } = await runSdkQuery({
      prompt: `## Diff to review\n\n\`\`\`diff\n${diffStat}\n\`\`\`\n\n请审查上述 diff 中的渐进类型违规。`,
      cwd: projectPath,
      systemPrompt: system,
      role: "default",
      allowedTools: ["Read", "Grep"],
    });
    const m = text.match(/OK:\s*(true|false)/i);
    const ok = !m || m[1].toLowerCase() === "true";
    const cost = addSdkCost(emptySdkCost(), { costUsd, usage });
    return {
      ok,
      findings: text,
      structuredFindings: parseGradualTypeFindings(text),
      cost,
    };
  } catch {
    return {
      ok: true,
      findings: "gradual-typecheck fallthrough (error)",
      structuredFindings: [],
    };
  }
}
