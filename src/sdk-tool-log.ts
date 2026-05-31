import { appendFileSync } from "fs";
import { join } from "path";
import { resolveP7HomeDir } from "./p7-paths.ts";

export type SdkToolTraceSummary = {
  lines: string[];
  writeEditCalls: number;
  readOnlyCalls: number;
  denied: number;
  toolErrors: number;
};

export function emptyToolTrace(): SdkToolTraceSummary {
  return {
    lines: [],
    writeEditCalls: 0,
    readOnlyCalls: 0,
    denied: 0,
    toolErrors: 0,
  };
}

export function appendExecuteToolLog(line: string): void {
  const jobId = process.env.P7_JOB_ID;
  if (!jobId) return;
  const logPath = join(resolveP7HomeDir(), "job-logs", `${jobId}.log`);
  appendFileSync(logPath, `[tool] ${new Date().toISOString()} ${line}\n`);
}

function pushTrace(trace: SdkToolTraceSummary, line: string): void {
  trace.lines.push(line);
  appendExecuteToolLog(line);
}

function isReadOnlyTool(name: string): boolean {
  return name === "Read" || name === "Glob" || name === "Grep";
}

function isWriteTool(name: string): boolean {
  return name === "Write" || name === "Edit";
}

function toolPathFromInput(input: Record<string, unknown>): string {
  const p = input.file_path ?? input.path;
  return typeof p === "string" ? p : "";
}

/** 从 SDK 流式消息中提取 tool 轨迹（供 executor 诊断空跑）。 */
export function ingestSdkMessageForToolTrace(
  message: unknown,
  trace: SdkToolTraceSummary,
): void {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  const m = message as Record<string, unknown>;

  if (m.type === "assistant" && "message" in m) {
    const content = (m.message as { content?: unknown[] }).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object" || !("type" in block)) continue;
      const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
      if (b.type !== "tool_use" || !b.name) continue;
      const path = toolPathFromInput(b.input ?? {});
      const suffix = path ? ` ${path}` : "";
      pushTrace(trace, `call ${b.name}${suffix}`);
      if (isWriteTool(b.name)) trace.writeEditCalls++;
      else if (isReadOnlyTool(b.name)) trace.readOnlyCalls++;
    }
    return;
  }

  if (m.type === "system" && m.subtype === "permission_denied") {
    const name = String(m.tool_name ?? "tool");
    const reason = String(m.decision_reason ?? m.message ?? "denied");
    trace.denied++;
    pushTrace(trace, `deny ${name}: ${reason.slice(0, 200)}`);
    return;
  }

  if (m.type === "user" && "tool_use_result" in m) {
    const result = m.tool_use_result;
    if (result && typeof result === "object" && "is_error" in result && result.is_error) {
      trace.toolErrors++;
      const errText =
        "content" in result && typeof result.content === "string"
          ? result.content
          : JSON.stringify(result).slice(0, 160);
      pushTrace(trace, `error tool_result: ${errText}`);
    }
  }
}

export function formatToolTraceSummary(trace: SdkToolTraceSummary, pass: number): string {
  return (
    `pass ${pass + 1} tools: write/edit=${trace.writeEditCalls} read=${trace.readOnlyCalls} ` +
    `denied=${trace.denied} errors=${trace.toolErrors}`
  );
}
