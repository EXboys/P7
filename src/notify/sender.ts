import { formatPlanCard, formatStatusMarkdown } from "./format.ts";
import { sendDingTalkActionCard, sendDingTalkMarkdown } from "./dingtalk.ts";
import type { Plan } from "../types.ts";

export interface NotifyConfig {
  dingtalk?: { webhook: string; secret?: string };
  dashboardBaseUrl?: string;
  projectAlias?: string;
}

export async function notifyPlanReady(
  cfg: NotifyConfig,
  plan: Plan,
  goal: string,
  planId: string,
): Promise<void> {
  if (!cfg.dingtalk?.webhook) return;
  const alias = cfg.projectAlias;
  const base = cfg.dashboardBaseUrl;
  const url = !base
    ? undefined
    : alias
      ? `${base}/project/${encodeURIComponent(alias)}/plans/${encodeURIComponent(planId)}`
      : `${base}/settings`;
  const text = formatPlanCard(plan, goal, url);
  if (url) {
    await sendDingTalkActionCard({
      webhook: cfg.dingtalk.webhook,
      secret: cfg.dingtalk.secret,
      title: `待审批: ${plan.title}`,
      text,
      singleTitle: "去审批",
      singleURL: url,
    });
  } else {
    await sendDingTalkMarkdown(cfg.dingtalk.webhook, cfg.dingtalk.secret, plan.title, text);
  }
}

export async function notifyExecutionResult(
  cfg: NotifyConfig,
  title: string,
  ok: boolean,
  detail: string,
): Promise<void> {
  if (!cfg.dingtalk?.webhook) return;
  await sendDingTalkMarkdown(
    cfg.dingtalk.webhook,
    cfg.dingtalk.secret,
    title,
    formatStatusMarkdown(title, ok, detail),
  );
}
