export type FailureKind =
  | "preflight"
  | "auth"
  | "open_prs"
  | "permission"
  | "plan_scope"
  | "diff_size"
  | "typecheck"
  | "test"
  | "critic"
  | "push"
  | "timeout"
  | "network"
  | "cost"
  | "queue"
  | "unknown";

export interface FailureClassification {
  kind: FailureKind;
  retryable: boolean;
  autoRepair: boolean;
  hardStop: boolean;
  hint: string;
}

export function classifyFailure(error: string): FailureClassification {
  const e = error.toLowerCase();
  if (/api domain|allowed list|no_llm|llm|auth token|preflight/i.test(e)) {
    return { kind: "auth", retryable: false, autoRepair: false, hardStop: true, hint: "先修环境检查 / API 白名单 / LLM Key" };
  }
  if (/open pr|冲突|conflicting/i.test(e)) {
    return { kind: "open_prs", retryable: true, autoRepair: true, hardStop: false, hint: "先自动复查或合并 OPEN PR" };
  }
  if (/max_pending|queue depth/i.test(e)) {
    return { kind: "queue", retryable: true, autoRepair: false, hardStop: false, hint: "队列积压，等待调度器消化" };
  }
  if (/permission violations|outside worktree boundary/i.test(e)) {
    const writeBoundary = /(?:^|\n)-\s*(Write|Edit): .*outside worktree boundary/i.test(error);
    return writeBoundary
      ? { kind: "permission", retryable: false, autoRepair: false, hardStop: true, hint: "写入路径越过 worktree，需重新规划" }
      : { kind: "permission", retryable: true, autoRepair: true, hardStop: false, hint: "只读边界拦截可作为非致命信号重试" };
  }
  if (/file not in plan|plan scope|not in plan/i.test(e)) {
    return { kind: "plan_scope", retryable: false, autoRepair: false, hardStop: true, hint: "Plan 范围不完整，请重新生成更准确的 Plan" };
  }
  if (/diff too large|too many files/i.test(e)) {
    return { kind: "diff_size", retryable: true, autoRepair: true, hardStop: false, hint: "规模为软信号；无人值守模式可继续或拆分" };
  }
  if (/typecheck failed/i.test(e)) {
    return { kind: "typecheck", retryable: true, autoRepair: true, hardStop: false, hint: "可带类型错误上下文自动修复后重试" };
  }
  if (/test failed/i.test(e)) {
    return { kind: "test", retryable: true, autoRepair: true, hardStop: false, hint: "可带测试失败上下文自动修复后重试" };
  }
  if (/diff-critic blocked|critic/i.test(e)) {
    return { kind: "critic", retryable: true, autoRepair: true, hardStop: false, hint: "可按 critic findings 自动小补丁修复" };
  }
  if (/push failed|github|gh pr|merge failed/i.test(e)) {
    return { kind: "push", retryable: true, autoRepair: true, hardStop: false, hint: "可重试 GitHub / PR 生命周期操作" };
  }
  if (/execution cost exceeded|cost limit/i.test(e)) {
    return { kind: "cost", retryable: false, autoRepair: false, hardStop: true, hint: "成本达到上限，需调高预算或缩小目标" };
  }
  if (/exit 143|超时被终止|超时.*终止|timeout|timed out/i.test(e)) {
    return { kind: "timeout", retryable: true, autoRepair: true, hardStop: false, hint: "超时可自动重试或提高超时预算" };
  }
  if (/unable to connect|failedtoopensocket|econnreset|connection refused|rate limit/i.test(e)) {
    return { kind: "network", retryable: true, autoRepair: false, hardStop: false, hint: "网络/API 瞬时故障，可退避重试" };
  }
  return { kind: "unknown", retryable: true, autoRepair: true, hardStop: false, hint: "未知失败，可尝试带上下文重试" };
}
