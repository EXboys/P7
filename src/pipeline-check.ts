import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadConfig, configPath } from "./config.ts";
import { homePathForRead } from "./p7-paths.ts";
import { loadSnapshot } from "./tech-discovery.ts";
import { hasLlmAuth, mergeLlmEnv } from "./llm-env.ts";

export interface PipelineCheckItem {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
}

export function runPipelineCheck(projectPath: string): PipelineCheckItem[] {
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

  const gh = Bun.spawnSync(["sh", "-c", "command -v gh"], { stdout: "pipe" });
  const ghOk = gh.exitCode === 0;
  items.push({
    id: "gh",
    ok: ghOk,
    label: "GitHub CLI (gh)",
    detail: ghOk ? "已安装" : "未安装",
    fix: "brew install gh && gh auth login",
  });

  if (ghOk) {
    const auth = Bun.spawnSync(["gh", "auth", "status"], { cwd: projectPath, stdout: "pipe" });
    items.push({
      id: "gh_auth",
      ok: auth.exitCode === 0,
      label: "gh 已登录",
      detail: auth.exitCode === 0 ? "OK" : new TextDecoder().decode(auth.stderr).slice(0, 120),
      fix: "gh auth login",
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
    fix: "在 server.json / ~/.claude/settings.json 填 Token，或确保 ~/.hermes/.env 有 DEEPSEEK_API_KEY",
  });

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

  if (cfg) {
    const acc = cfg.vcs.accounts;
    items.push({
      id: "vcs_accounts",
      ok: acc.length > 0 || ghOk,
      label: "VCS 账号",
      detail:
        acc.length > 0
          ? `已配置 ${acc.length} 个: ${acc.map((a) => a.id).join(", ")}`
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
    id: "worker",
    ok: true,
    label: "后台 Worker",
    detail: existsSync(serverPath)
      ? "需运行 bun run start（server/index.ts，不是仅 admin）才会消费队列、自动 execute"
      : "缺少 ~/.p7/server.json",
    fix: "bun run start",
  });

  return items;
}

export function pipelineReady(items: PipelineCheckItem[]): boolean {
  const required = ["git", "remote", "llm_auth"];
  return required.every((id) => items.find((i) => i.id === id)?.ok);
}
