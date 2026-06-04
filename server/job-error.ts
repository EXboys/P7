/** 从子进程 stderr / 日志尾部提取可读错误，避免 Bun 把 SDK 压缩代码塞进 job.error */

const SOURCE_LINE = /^\d+\s+\|/;

export function normalizeJobError(text: string, exitCode: number): string {
  const blob = text.trim();
  if (!blob) {
    return exitCode === 143
      ? "任务被终止（exit 143，多为超时或服务重启）"
      : `exit ${exitCode}`;
  }

  if (exitCode === 143 || /超时.*终止|终止进程/.test(blob)) {
    return `任务超时被终止（exit ${exitCode}）。生成 Plan 若常超时，请在项目设置增大「执行超时（分钟）」或检查 API/网络。`;
  }

  // executor / SDK 常把真正的失败原因塞进 JSON 结果的 "error" 字段，
  // 例如 {"ok":false,"error":"Diff too large: 249 lines > 200", ...}
  const jsonErr = blob.match(/"error"\s*:\s*"((?:[^"\\]|\\.){3,})"/i);
  if (jsonErr) {
    const decoded = jsonErr[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
    return humanizeKnownError(decoded).slice(0, 420);
  }

  const patterns = [
    /Diff too large:[^\n"]+/i,
    /Too many files[^\n"]+/i,
    /ZodError:\s*\[[\s\S]*?\]/i,
    /Too big:[^\n]+/i,
    /API Error:[^\n]+/i,
    /Unable to connect[^\n]*/i,
    /FailedToOpenSocket[^\n]*/i,
    /not in the allowed list[^\n]*/i,
    /Claude Code returned an error[^\n]*/i,
    /Permission violations[^\n]*/i,
    /error:\s*[^\n]+/i,
  ];
  for (const re of patterns) {
    const m = blob.match(re);
    if (m) return humanizeKnownError(m[0].replace(/\s+/g, " ").trim()).slice(0, 420);
  }

  // 过滤掉 token 用量统计 / 进度心跳 / 进程结束标记等噪声行，
  // 避免在没有明确错误文本时把 cacheReadInputTokens 之类当成“错误”显示。
  const NOISE =
    /^[\{\}\[\],]*$|inputTokens|outputTokens|cacheReadInputTokens|cacheCreationInputTokens|durationSec|costUsd|worktreePath|tokenUsage|"ok"\s*:|仍在执行|进程结束|进度|^\d+s…?$/i;
  const lines = blob
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 8 &&
        !SOURCE_LINE.test(l) &&
        !l.includes("this.baseURL=X.baseURL") &&
        !NOISE.test(l),
    );
  const tail = lines.slice(-4).join(" · ").slice(0, 420);
  if (tail) return tail;
  return exitCode ? `执行进程异常退出（exit ${exitCode}），未捕获到明确错误，通常为瞬时故障，可重试。` : "未知错误";
}

function humanizeKnownError(msg: string): string {
  if (/ZodError|Too big/i.test(msg) && /estimated_diff_lines/i.test(msg)) {
    return "Plan 校验失败：estimated_diff_lines 超出旧上限。请升级到放宽 schema 的版本后重试生成 Plan。";
  }
  if (/Diff too large/i.test(msg)) {
    return `${msg}（实际改动超过 diff 上限）。已放宽上限至 1000 行；若仍超限，请让 Plan 拆分得更小，或调大项目设置「diff_critic.max_diff_ceiling」。`;
  }
  if (/Too many files/i.test(msg)) {
    return `${msg}（改动文件数超限）。请拆分 Plan，或调大「diff_critic.max_files_ceiling」。`;
  }
  return msg;
}
