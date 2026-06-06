# P7 自动化链路说明

## 链路顺序

```
趋势 (discover) → ROADMAP → Plan → 审批 → 执行 (worktree) → push → gh 开 PR
```

## 控制台信息架构

| 区域 | 内容 |
|------|------|
| 左侧 | 项目下拉 + 菜单（工作台 / 趋势 / 规划 / 运行 / 设置）+ 系统（系统设置、任务队列、日志） |
| 右侧顶栏 | 页面标题 + **本页操作按钮** |
| 工作台 | 指标、Roadmap 摘要、最近动态、环境检查 |

旧路径会自动重定向，例如 `/project/P7/roadmap` → `/project/P7/plan?section=roadmap`。

## 1. Roadmap 怎么生成？

| 方式 | 命令 / 操作 | 依赖 |
|------|-------------|------|
| 全自动 | `discover-daily` 或工作台「一键：发现 → Roadmap」 | 有雷达数据；默认必须 LLM 成功 |
| 带说明重生 | 规划 → Roadmap 表单填写补充要求 | 鉴权 |
| 模板兜底 | 仅当 `discovery.allow_template_fallback: true` | 无 Token 时质量较差 |

## 2. 任务怎么自动化执行？

必须同时满足：

1. **跑全栈服务**（带 Worker + 调度）：
   ```bash
   PORT=8791 bun run start
   ```
2. 项目配置 **`discovery.auto_execute_after_approve: true`**
3. 队列：`discover-daily` → 批准后入队 **`execute --plan-id`**
4. **不要**只开 `start:admin` — 它**不会**消费队列

调度器每 5 分钟对每个项目入队一次 `discover-daily`（当日无进行中/已成功任务时）。

## 3. 账号怎么绑定？

在 **项目 → 设置 → GitHub** 配置交付账号。

- **`auth_type: "gh"`**：本机 `gh auth login`
- **`token_env`**：从环境变量读 token（CI / 多账号）
- **`accounts: []`**：回退为本机默认 `gh`

## 4. 怎么提交 PR？

1. 绑定路径必须是 **git 仓库**，且有 **`origin` → github.com**
2. 安装并登录 **`gh`**
3. **`vcs.create_pr: true`**，建议 **`vcs.auto_merge: false`**

## 5. 预检

```bash
bun run src/index.ts pipeline check /path/to/your-real-repo
```

| 项 | 说明 |
|----|------|
| Git 仓库 | 必须已 `git init` |
| origin | 必须指向 GitHub（若要开 PR） |
| 模型鉴权 | Token 或兼容网关 |
| gh 登录 | 创建 PR 需要 |

在 `~/.p7/server.json` 的 `project_aliases` 里绑定**你的业务仓库**（若仅有旧版 `~/.dev-agent/server.json` 会自动读取）。

## 6. 推荐一次性跑通步骤

```bash
# 1. 鉴权（任选）
# ~/.p7/server.json → anthropic_auth_token
# 或 ~/.claude/settings.json env

# 2. 控制台 → 系统设置 → 绑定 git 项目

# 3. 预检
bun run src/index.ts pipeline check /path/to/repo

# 4. 全栈后台
PORT=8791 bun run start

# 5. 手动触发一整圈
bun run src/index.ts discover-daily /path/to/repo
```

## 7. 配置建议（生产更稳）

| 配置 | 建议 |
|------|------|
| `vcs.auto_merge` | `false` |
| `allow_to_main` | `false` |
| `discovery.allow_template_fallback` | `false` |
| `auto_approve` | 主仓库建议关，实验仓可开 |

## 8. 代码架构边界

P7 当前按四层维护：

- `src/usecases/`：应用编排入口，CLI、Worker、Dashboard 的核心动作应优先委托这里。
- `src/` 领域与基础设施：Plan、Executor、State、VCS、SDK、配置派生逻辑；不得 import `server/`。
- `server/`：HTTP Dashboard、Scheduler、Worker、队列存储与页面渲染。
- `server/dashboard-data/`：Dashboard 页面数据聚合与页面 body 组装，路由只负责参数、鉴权、响应。

架构护栏：

- `src/execution/step-reporter.ts` 负责执行步骤上报，Executor 不直接写 `server/queue/db.ts`。
- `src/job-read-model.ts` 提供 src 侧只读 job 查询，避免恢复/审批逻辑依赖 server 层。
- `tests/architecture-boundaries.test.ts` 会阻止 `src -> server` 反向 import。
