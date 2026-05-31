import { readPrompt, runSdkQuery } from "./sdk.ts";
import { addSdkCost, emptySdkCost, type SdkCostSummary } from "./sdk-cost.ts";

export async function reviewDiff(
  projectPath: string,
  diffStat: string,
  planSummary: string,
): Promise<{ ok: boolean; findings: string; cost?: SdkCostSummary }> {
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
    return { ok, findings: text, cost };
  } catch {
    return { ok: true, findings: "diff-critic fallthrough (error)" };
  }
}
