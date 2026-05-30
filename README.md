# P7

**P7** 是一套面向真实 Git 仓库的自动化研发流水线：抓取技术趋势 → 维护 `ROADMAP.md` → 生成可审批的 Plan → 在独立 worktree 里改代码 → 跑验证 → 推送并开 PR。

底层使用 [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) 做规划与执行；模型可通过 Anthropic 兼容网关（如 DeepSeek）接入。

## 能做什么

| 阶段 | 说明 |
|------|------|
| 趋势 | 抓取 Hacker News / GitHub Trending，归纳主题 |
| 规划 | 刷新 Roadmap、按目标生成结构化 Plan（文件级变更清单） |
| 审批 | 控制台或 CLI 批准 / 拒绝；可配置小额自动批准 |
| 执行 | git worktree 隔离开发、类型检查 / 测试、diff 审查 |
| 交付 | `gh` 创建 PR，多账号时可各推独立分支 |

## 快速开始

```bash
bun install
cd /path/to/your/git-repo
bun run src/index.ts init-config . --goal "持续提升 API 稳定性"
bun run src/index.ts scan .
```

在控制台 [系统设置](http://127.0.0.1:8791/settings) 配置 LLM，或写入 `~/.p7/server.json` / `~/.claude/settings.json`。

### CLI

```bash
bun run src/index.ts scan <project>
bun run src/index.ts plan <project> --goal "本次要做的功能"
bun run src/index.ts execute <project> --plan-id <id>
bun run src/index.ts discover <project>
bun run src/index.ts discover-daily <project>
bun run src/index.ts pipeline check <project>
bun run src/index.ts states <project>
```

### Web 控制台

`~/.p7/server.json`：

```json
{
  "project_aliases": {
    "myapp": "/absolute/path/to/myapp"
  },
  "port": 8791
}
```

```bash
PORT=8791 bun run start:admin   # 仅控制台
PORT=8791 bun run start         # 控制台 + 调度 + Worker（自动化必选）
```

浏览器打开 `http://127.0.0.1:8791`。左侧：**工作台 / 趋势 / 规划 / 运行 / 设置**。

自动化要跑通：绑定路径为 **已 `git init` 且有 GitHub `origin` 的仓库**、本机 **`gh auth login`**、使用 **`bun run start`**。详见 [docs/PIPELINE.md](docs/PIPELINE.md)。

## 目录

| 路径 | 用途 |
|------|------|
| `src/` | CLI：扫描、规划、执行、发现、VCS |
| `server/` | 控制台、任务队列、调度、Worker |
| `prompts/` | 系统提示词 |
| 仓库 `.p7/` | 项目状态：配置、Plan、审批、雷达 |
| `~/.p7/` | 本机：控制台配置、任务库、日志 |

> **兼容**：若你之前用过旧版，本机 `~/.dev-agent/`、仓库内 `.dev-agent/` 仍会被**只读**识别；**新写入一律进 `.p7` / `~/.p7`**。无需手动迁移即可继续用，保存配置后会逐步落到新目录。

## 配置示例

绑定仓库的 `.p7/config.json`：

```json
{
  "initial_goal": "持续改进代码质量",
  "discovery": {
    "auto_refresh_roadmap": true,
    "auto_plan_after_refresh": true,
    "auto_execute_after_approve": true
  },
  "vcs": {
    "create_pr": true,
    "auto_merge": false,
    "labels": ["p7"]
  }
}
```

## 模型

环境变量：`P7_PLANNER_MODEL`、`P7_EXECUTOR_MODEL`、`P7_SELECTOR_MODEL`，以及 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`。控制台可一键写入 `~/.claude/settings.json`。

## 架构

```
discover → ROADMAP → Plan → 审批 → execute (worktree) → push → gh pr create
```

## 开发

```bash
bun test
bun run typecheck
```

源码目录若未初始化为 Git，无法在本仓库根目录演示 push/PR；请在 `server.json` 绑定业务仓库联调。
