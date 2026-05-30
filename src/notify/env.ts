import type { NotifyConfig } from "./sender.ts";

export function resolveNotifyConfig(projectAlias?: string): NotifyConfig | undefined {
  const base = process.env.DASHBOARD_BASE_URL ?? process.env.P7_DASHBOARD_URL;
  const webhook = process.env.DINGTALK_WEBHOOK;
  if (!webhook && !base) return undefined;
  return {
    dashboardBaseUrl: base,
    dingtalk: webhook
      ? { webhook, secret: process.env.DINGTALK_SECRET }
      : undefined,
    projectAlias: projectAlias ?? process.env.P7_PROJECT_ALIAS,
  };
}
