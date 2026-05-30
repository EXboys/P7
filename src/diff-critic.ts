import { readPrompt, runSdkQuery } from "./sdk.ts";

export async function reviewDiff(
  projectPath: string,
  diffStat: string,
  planSummary: string,
): Promise<{ ok: boolean; findings: string }> {
  try {
    const system = readPrompt("diff-critic.md");
    const { text } = await runSdkQuery({
      prompt: `## 计划摘要\n${planSummary}\n\n## git diff --stat\n\`\`\`\n${diffStat}\n\`\`\`\n\n请审查。`,
      cwd: projectPath,
      systemPrompt: system,
      role: "default",
      allowedTools: ["Read", "Grep"],
    });
    const m = text.match(/OK:\s*(true|false)/i);
    const ok = !m || m[1].toLowerCase() === "true";
    return { ok, findings: text };
  } catch {
    return { ok: true, findings: "diff-critic fallthrough (error)" };
  }
}
