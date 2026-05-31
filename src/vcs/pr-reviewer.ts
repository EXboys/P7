import { existsSync } from "fs";
import type { DevAgentConfig } from "../config.ts";
import { getApprovalRecord } from "../approval.ts";
import { appendLesson } from "../agent-memory.ts";
import { loadPlanRecord } from "../planner.ts";
import { listPlanStates, transitionPlanState } from "../state.ts";
import type { Plan } from "../types.ts";
import { listOpenPullRequests, type OpenPr } from "./open-prs.ts";
import { runPrReviewAndMerge } from "./pr-lifecycle.ts";

export function stubPlanForPrReview(title: string): Plan {
  return {
    title: title.slice(0, 120) || "历史 PR 复查",
    motivation: "定时复查并合并历史 Pull Request",
    complexity: "medium",
    changes: [
      {
        file: "README.md",
        description: "历史 PR 定时复查（无预期代码改动）",
        estimated_lines: 0,
      },
    ],
    risks: [],
    validation: "gh pr view / merge 状态检查",
    estimated_diff_lines: 0,
  };
}

function resolvePlanForPr(projectPath: string, pr: OpenPr): { plan: Plan; planId?: string } {
  const states = listPlanStates(projectPath, 200);
  const st = states.find(
    (s) => s.prUrl === pr.url || (pr.headRefName && s.branch === pr.headRefName),
  );
  if (!st) return { plan: stubPlanForPrReview(pr.title) };

  const approval = getApprovalRecord(projectPath, st.planId);
  if (approval?.plan) return { plan: approval.plan, planId: st.planId };

  const record = loadPlanRecord(projectPath, st.planId);
  if (record?.plan) return { plan: record.plan, planId: st.planId };

  return { plan: stubPlanForPrReview(pr.title), planId: st.planId };
}

export type PrReviewItemResult = {
  prNumber: number;
  prUrl: string;
  branch: string;
  mergeStatus: string;
  detail: string;
  planId?: string;
};

export type PrReviewSweepResult = {
  ok: boolean;
  scanned: number;
  results: PrReviewItemResult[];
  error?: string;
};

/** 扫描仓库内 OPEN 的 PR，逐个自动 review；开启 auto_merge 时尝试合并并修复冲突 */
export async function runPrReviewSweep(
  projectPath: string,
  config: DevAgentConfig,
): Promise<PrReviewSweepResult> {
  const vcs = config.vcs;
  if (!vcs.enabled) {
    return { ok: true, scanned: 0, results: [], error: "VCS 未启用" };
  }
  if (!existsSync(projectPath)) {
    return { ok: false, scanned: 0, results: [], error: "项目路径不存在" };
  }
  if (vcs.review_open_prs === false) {
    return { ok: true, scanned: 0, results: [], error: "未开启历史 PR 定时复查" };
  }

  const label =
    vcs.pr_review_only_p7_label !== false && vcs.labels.length > 0
      ? vcs.labels[0]
      : undefined;
  let prs = listOpenPullRequests(projectPath, { label, limit: 20 });
  if (prs.length === 0 && label) {
    prs = listOpenPullRequests(projectPath, { limit: 20 });
  }
  const results: PrReviewItemResult[] = [];

  for (const pr of prs) {
    const { plan, planId } = resolvePlanForPr(projectPath, pr);
    const lifecycle = await runPrReviewAndMerge({
      projectPath,
      prUrl: pr.url,
      branch: pr.headRefName,
      plan,
      config,
      mergeWaitMinutes: Math.min(vcs.merge_wait_minutes ?? 20, 8),
    });

    if (planId) {
      const status = lifecycle.mergeStatus === "merged" ? "merged" : "pr_opened";
      transitionPlanState(projectPath, planId, status, {
        prUrl: pr.url,
        branch: pr.headRefName,
        mergeStatus: lifecycle.mergeStatus,
        error: lifecycle.mergeStatus === "failed" ? lifecycle.detail : undefined,
      });
    }

    results.push({
      prNumber: pr.number,
      prUrl: pr.url,
      branch: pr.headRefName,
      mergeStatus: lifecycle.mergeStatus,
      detail: lifecycle.detail,
      planId,
    });
    await appendLesson(
      projectPath,
      `pr-review:#${pr.number} ${lifecycle.mergeStatus} — ${lifecycle.detail.slice(0, 100)}`,
    );
  }

  return { ok: true, scanned: prs.length, results };
}
