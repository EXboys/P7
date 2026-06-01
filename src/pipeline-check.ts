import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadConfig, configPath } from "./config.ts";
import { gitSyncWithOrigin } from "./worktree.ts";
import { homePathForRead } from "./p7-paths.ts";
import { loadSnapshot } from "./tech-discovery.ts";
import { hasLlmAuth, mergeLlmEnv } from "./llm-env.ts";
import { loadCachedLlmProbeForEnv } from "./llm-probe-cache.ts";
import type { LlmProbeResult } from "./llm-probe.ts";

export interface PipelineCheckItem {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
}

export type PipelineCheckOptions = {
  /** 是否执行 git fetch / gh auth 等网络或慢速检查；页面刷新默认 false，执行任务或显式刷新时为 true */
  remote?: boolean;
};

export function runPipelineCheck(
  projectPath: string,
  opts: PipelineCheckOptions = {},
): PipelineCheckItem[] {
  const checkRemote = opts.remote !== false;
  const items: PipelineCheckItem[] = [];
  const cfg = existsSync(configPath(projectPath)) ? loadConfig(projectPath) : null;

  const gitDir = join(projectPath, ".git");
  items.push({
    id: "git",
    ok: existsSync(gitDir),
    label: "Git 仓库",
    detail: existsSync(gitDir) ? "已初始化" : "未初始化 — 无法 worktree / push / PR",
    fix: "cd 项目 && git init && git remote add origin <url>",
  });

  let remote = "";
  if (existsSync(gitDir)) {
    try {
      const proc = Bun.spawnSync(["git", "-C", projectPath, "remote", "get-url", "origin"], {
        stdout: "pipe",
      });
      remote = proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout).trim() : "";
    } catch {
      remote = "";
    }
  }
  items.push({
    id: "remote",
    ok: Boolean(remote),
    label: "Git remote (origin)",
    detail: remote || "未配置 origin",
    fix: "git remote add origin https://github.com/org/repo.git",
  });

  if (cfg && existsSync(gitDir) && checkRemote) {
    const sync = gitSyncWithOrigin(projectPath, cfg);
    items.push({
      id: "git_sync",
      ok: sync.ok,
      label: "与 PR 基线分支同步",
      detail: sync.detail,
      fix: `git fetch origin && git checkout ${cfg.vcs.base_branch || "main"} && git pull origin ${cfg.vcs.base_branch || "main"}`,
    });
  } else if (cfg && existsSync(gitDir) && !checkRemote) {
    items.push({
      id: "git_sync",
      ok: true,
      label: "与 PR 基线分支同步",
      detail: "打开页面时跳过；执行任务前会自动 fetch 远程基线",
    });
  }

  const gh = Bun.spawnSync(["sh", "-c", "command -v gh"], { stdout: "pipe" });
  const ghOk = gh.exitCode === 0;
  items.push({
    id: "gh",
    ok: ghOk,
    label: "GitHub CLI (gh)",
    detail: ghOk ? "已安装" : "未安装",
    fix: "brew install gh && gh auth login",
  });

  if (ghOk && checkRemote) {
    const auth = Bun.spawnSync(["gh", "auth", "status"], { cwd: projectPath, stdout: "pipe" });
    items.push({
      id: "gh_auth",
      ok: auth.exitCode === 0,
      label: "gh 已登录",
      detail: auth.exitCode === 0 ? "OK" : new TextDecoder().decode(auth.stderr).slice(0, 120),
      fix: "gh auth login",
    });
  } else if (ghOk) {
    items.push({
      id: "gh_auth",
      ok: true,
      label: "gh 已登录",
      detail: "打开页面时跳过；执行任务前会自动验证",
    });
  }

  const merged = mergeLlmEnv();
  const token = merged.ANTHROPIC_AUTH_TOKEN || merged.ANTHROPIC_API_KEY;
  const base = merged.ANTHROPIC_BASE_URL || "(未设置)";
  items.push({
    id: "llm_auth",
    ok: hasLlmAuth(merged),
    label: "模型网关鉴权",
    detail: token ? `Base: ${base}` : `缺少 ANTHROPIC_AUTH_TOKEN/API_KEY（Base: ${base}）`,
    fix: "系统设置 → 模型/网关 → API Key，保存后重启控制台",
  });

  const modelName =
    merged.ANTHROPIC_MODEL || merged.P7_MODEL || merged.P7_PLANNER_MODEL || "";
  items.push({
    id: "llm_model",
    ok: Boolean(modelName),
    label: "默认模型名",
    detail: modelName || "未配置 — Roadmap/Plan 可能无法调用",
    fix: "系统设置 → 模型/网关 → 默认模型（如 deepseek-v4-pro）",
  });

  items.push({
    id: "llm_ping",
    ok: hasLlmAuth(merged) && Boolean(modelName),
    label: "模型连通性（实测）",
    detail:
      hasLlmAuth(merged) && modelName
        ? "配置就绪；点「检测模型请求」验证，通过后按 Key 缓存"
        : "请先配置鉴权与模型名",
    fix: hasLlmAuth(merged) ? "工作台 → 环境检查 → 检测模型请求" : undefined,
  });

  const cachedProbe = loadCachedLlmProbeForEnv(merged);
  if (cachedProbe) {
    return applyLlmProbeResult(items, cachedProbe);
  }

  const snap = loadSnapshot(projectPath);
  items.push({
    id: "radar",
    ok: Boolean(snap?.signals.length),
    label: "今日技术雷达",
    detail: snap ? `${snap.signals.length} 条信号` : "无快照",
    fix: "bun run src/index.ts discover <project>",
  });

  const roadmapPath = join(projectPath, "ROADMAP.md");
  items.push({
    id: "roadmap",
    ok: existsSync(roadmapPath),
    label: "ROADMAP.md",
    detail: existsSync(roadmapPath) ? "已存在" : "不存在 — 需 LLM 刷新或模板生成",
    fix: "bun run src/index.ts discover-daily <project> 或控制台「趋势→Roadmap」",
  });

  items.push({
    id: "project_config",
    ok: Boolean(cfg),
    label: "项目 .p7/config.json",
    detail: cfg ? "已加载" : "缺失 — 使用默认策略",
    fix: "在项目根目录初始化 .p7/config.json",
  });

  if (cfg) {
    const acc = cfg.vcs.accounts;
    items.push({
      id: "vcs_accounts",
      ok: acc.length > 0 || ghOk,
      label: "VCS 账号",
      detail:
        acc.length > 0
          ? `已配置 ${acc.length} 个: ${acc.map((a) => a.id).join(", ")} · ${cfg.vcs.account_pick_mode ?? "round_robin"}${cfg.vcs.account_failover !== false ? " + failover" : ""}`
          : "accounts[] 为空 — 将回退本机 gh 默认账号 default-gh",
      fix: "项目 → 设置 → GitHub 交付，或 /project/<别名>/settings?section=github",
    });
    items.push({
      id: "auto_exec",
      ok: cfg.discovery.auto_execute_after_approve !== false,
      label: "自动执行（批准后）",
      detail: cfg.discovery.auto_execute_after_approve ? "开启" : "关闭（仅规划不跑 execute）",
      fix: "项目配置 → 开启「批准后自动执行」",
    });
  }

  const serverPath = homePathForRead("server.json");
  items.push({
    id: "server_config",
    ok: existsSync(serverPath),
    label: "控制台配置",
    detail: existsSync(serverPath) ? serverPath : "缺少 ~/.p7/server.json",
    fix: "首次访问 /settings 会自动创建，或手动配置 project_aliases",
  });

  items.push({
    id: "worker",
    ok: existsSync(serverPath),
    label: "任务队列 Worker",
    detail: existsSync(serverPath)
      ? "须用 bun run server/index.ts（或 bun run start）启动，才会消费 discover/execute 队列"
      : "先配置 server.json 并启动完整服务",
    fix: "cd p7 源码 && PORT=8765 bun run server/index.ts",
  });

  return items;
}

export function applyLlmProbeResult(
  items: PipelineCheckItem[],
  probe: LlmProbeResult,
): PipelineCheckItem[] {
  return items.map((i) =>
    i.id === "llm_ping"
      ? {
          ...i,
          ok: probe.ok,
          detail: probe.detail,
          fix: probe.ok ? undefined : "系统设置 → 模型/网关；确认 Base URL / Key / 模型名后重试",
        }
      : i,
  );
}

export function pipelineReady(items: PipelineCheckItem[]): boolean {
  const required = ["git", "remote", "llm_auth", "llm_model"];
  const core = required.every((id) => items.find((i) => i.id === id)?.ok);
  const ping = items.find((i) => i.id === "llm_ping");
  if (!ping) return core;
  if (/尚未检测|配置就绪|Key\/模型未变/.test(ping.detail)) {
    return core && ping.ok !== false;
  }
  return core && ping.ok !== false;
}
