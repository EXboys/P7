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

  const patterns = [
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
    if (m) return m[0].replace(/\s+/g, " ").trim().slice(0, 420);
  }

  const lines = blob
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 8 && !SOURCE_LINE.test(l) && !l.includes("this.baseURL=X.baseURL"));
  const tail = lines.slice(-4).join(" · ").slice(0, 420);
  if (tail) return tail;
  return exitCode ? `exit ${exitCode}` : "未知错误";
}
