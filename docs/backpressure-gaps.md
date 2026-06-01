# Executor Pipeline 背压缺口分析

> 分析基准：`97ddf13`（2026-06-01）  
> 全量分析见 `docs/backpressure-analysis.md`（296 行，含 Fixture 数据），本文档为可提交的精简版本。

---

## 缺口清单

### ① Plan 队列无界 — 高

- **位置**：`server/queue/store.ts:enqueueJob`（SQLite `jobs` 表），`server/scheduler.ts:runSchedulerTick`（调度器入队入口）
- **当前行为**：调度器每 2 分钟轮询一次，只要 `!hasActiveExecuteJob` 就入队新的 execute 任务。SQLite `jobs` 表无行数上限，`SELECT * FROM jobs WHERE status = 'pending'` 返回全部积压。
- **后果**：当 Plan 审批速度超过执行速度时，队列无限膨胀，积压 Plan 永不过期、无淘汰策略。
- **建议**：① 在 `enqueueJob` 前检查 `COUNT(pending)` ≤ N（如 `max_pending_plans`）；② 新增 TTL 列，积压超过 24h 的 Plan 自动标记 `stale` 并告警。

### ② 调度器缺限速 — 高

- **位置**：`server/scheduler.ts:36-61`，`server/queue/db.ts:claimNextJob`
- **当前行为**：`claimNextJob` 按 `created_at ASC` 全量扫描 pending 任务，每 tick 只出队一个任务。但 `scheduler.ts` 每次 tick 可对多个 project alias 各自入队，无 per-project 入队速率限制（RPS 控制）。Worker 侧 `max_concurrent_projects` 只控制同时在跑的项目数，不控制单个项目的入队节奏。
- **后果**：突发批量审批 → 一秒内涌入 N 个 execute → Worker 逐个消费但队列瞬时膨胀。
- **建议**：① 在 `enqueueJob` 侧加入 `per-project` 入队间隔（如 30s 内最多 1 个 execute）；② 调度器 tick 内对同一 alias 最多入队 1 个 execute。

### ③ Agent 执行无超时 — 高

- **位置**：`src/executor.ts:344-354`（`runSdkQuery` 调用），`src/sdk.ts`（SDK 封装层）
- **当前行为**：`runSdkQuery` 只通过 `maxTurns`（30-60 轮）约束 LLM agent 行为，没有 wall-clock 超时。LLM 卡在思考循环或工具调用无限重试时，整个 `executePlan` 阻塞。唯一的兜底超时在 `server/queue/worker.ts:142-147`（`jobTimeoutMs`，默认 35 分钟），但这是进程级超时，不是 agent 调用级。
- **后果**：一次 agent 调用可能 hang 35 分钟才被进程超时杀死，浪费全部 35 分钟的配额和 token 成本。
- **建议**：① 在 `runSdkQuery` 层添加 `AbortSignal` 超时（建议初始 10 分钟，可配置）；② `maxTurns` 达到阈值时主动返回而非继续等待 LLM 输出。

### ④ 全量重试浪费 — 中

- **位置**：`src/executor.ts:324-389`（`maxAgentPasses = 2` 循环）
- **当前行为**：当 pass 0 产生 0 diff（空跑），pass 1 从头启动完整 agent 会话，重新调用 `runSdkQuery` 并携带全部 context。两次调用的差异只是 prompt 后缀多了一行 `retryHint`。无增量恢复机制。
- **后果**：一次空跑浪费一次完整 LLM 调用（~50 轮对话 + 几万 token），成本翻倍。
- **建议**：① pass 1 时应复用前次会话的快照而非重新启动；② 空跑后先检查 `scaffoldMissingPlanFiles` 结果再决定是否需要完全重跑。

### ⑤ 嵌套重试放大 — 中

- **位置**：`src/executor.ts:363-369`（`withExponentialBackoff` 包裹 `runOnce`）
- **当前行为**：`withExponentialBackoff`（最多 3 + 1 = 4 次重试）内嵌在 `maxAgentPasses`（2 轮）循环内。若 pass 0 每次触发退避重试，可能产生 `2 × 4 = 8` 次 agent 调用；最坏情况每个退避都超时后 pass 1 又执行同样的退避序列。
- **后果**：设计预期外的调用次数放大，成本激增且延迟延长。
- **建议**：① 将 `withExponentialBackoff` 移至 `maxAgentPasses` 循环外层，或合并为单一重试策略；② 设定所有 pass 的全局调用次数上限。

### ⑥ 成本熔断滞后 — 中

- **位置**：`src/executor.ts:356-360`
- **当前行为**：`sdkCost.costUsd > cfg.execution_cost_limit` 检查在每次 `runSdkQuery` 返回后执行，而非在调用过程中实时检测。熔断只能阻止下一次调用，不能中断当前正在进行的调用。`execution_cost_limit` 默认 5 USD。
- **后果**：当前调用可能已经超限（一次大模型调用就能消耗 3-5 USD），熔断仅能防止下一次，损失已发生。
- **建议**：① 在 SDK 封装层添加 mid-flight 预算检查（每轮对话后累计 cost，超限即 abort）；② 支持 pre-flight 估算，为每次 `runSdkQuery` 调用预留预算。

### ⑦ 连续失败断路器未实现 — 高

- **位置**：`server/loop-policy.ts:41-50`（仅作用于 daily loop 决策），`config.ts:max_consecutive_failures`
- **当前行为**：`max_consecutive_failures`（默认 3）只在 `loop-policy.ts` 中用于控制 `discover-daily` 循环是否继续。当连续失败达到阈值，`circuit_breaker` 会停止 daily loop 30 分钟。但 **execute pipeline 自身没有任何断路器**——失败→重试→再失败→继续重试，直到 `MAX_FAILED_EXECUTE_PER_PLAN = 3` 用尽。
- **后果**：系统遇到系统性故障（如 GitHub API 宕机、LLM 服务降级）时，所有 Plan 依次重试 3 次才放弃，故障扩散至全部项目，无全局断路器。
- **建议**：① 在 `executePlan` 入口添加全局断路器（检查 `lastConsecutiveFailures >= N` 直接阻止新执行）；② 断路器半开状态（cooldown 后试探一个执行）后可自动恢复。

### ⑧ Git/VCS 无超时 — 低

- **位置**：`src/executor.ts:41-49`（`git()` 辅助函数），`src/executor.ts:485-494`（`commitWorktreeChanges` 和 `push`）
- **当前行为**：`Bun.spawnSync(["git", ...])` 使用同步阻塞调用，无 timeout 参数。当网络不稳定或远程仓库响应慢时，git push 可能挂起数分钟才被操作系统 TCP 超时（通常 2-5 分钟）杀死。
- **后果**：git push 挂起 → 整个 `executePlan` 阻塞 → 进程级 `jobTimeoutMs` 兜底杀死整个执行，前序工作全部浪费。
- **建议**：① git 调用使用 `Bun.spawn`（异步）配合 Promise.race 超时；② push 操作设置合理的超时参数（如 curl 式 `--connect-timeout 30`）。

### ⑨ 背压不可观测 — 中

- **位置**：全局 — 所有队列、限速、熔断点均未暴露观测信号
- **当前行为**：① 队列深度无 Prometheus / 结构化日志输出；② 熔断事件仅在 `audit()` 中记录一行文本；③ 调度器跳过原因（`open_prs_block`、`active_job`、`daily_exists`）仅写入 audit 日志，无聚合视图；④ 单个步骤耗时无 `step_states` 外的汇总统计。
- **后果**：运维人员无法判断背压瓶颈在哪个环节——是队列积压？Agent 调用慢？Git push 卡？审批积压？排查只能逐条翻看 audit 日志。
- **建议**：① 在 `runSchedulerTick` 和 `claimNextJob` 出口输出关键水位指标（pending_count、running_duration_p95、queue_time）；② 仪表板新增背压面板，展示各环节的等待耗时与积压趋势。

### ⑩ 审批积压无控制 — 低

- **位置**：`src/approval.ts:listPendingApprovals`，`src/config.ts:max_pending_plans`
- **当前行为**：`max_pending_plans`（默认 5）只在 `loop-policy.ts:53` 用于控制 daily loop 是否继续。但 Plan 自身生成不受 `max_pending_plans` 限制——`planner.ts` 每轮 discovery 都可能生成新 Plan，累计 pending 审批。
- **后果**：`listPendingApprovals` 返回 ≥10 个未审批 Plan 时，用户需逐个人工审批，缺乏批量操作和过期淘汰。
- **建议**：① 在 `savePendingApproval` 前检查 `countPendingPlans >= max_pending_plans`，超限时拒绝新 Plan 并提示先处理积压；② 过期（超过 48h 未审批）的 Plan 自动标记 rejected。

---

## 缺口汇总

| #  | 缺口 | 严重度 | 影响面 | 治理优先级 |
|----|------|--------|--------|-----------|
| ① | Plan 队列无界 | 高 | 稳定+成本 | P0 |
| ③ | Agent 执行无超时 | 高 | 稳定+成本 | P0 |
| ⑦ | 连续失败断路器未实现 | 高 | 稳定 | P0 |
| ② | 调度器缺限速 | 高 | 稳定 | P1 |
| ⑤ | 嵌套重试放大 | 中 | 成本 | P1 |
| ⑥ | 成本熔断滞后 | 中 | 成本 | P2 |
| ④ | 全量重试浪费 | 中 | 成本 | P2 |
| ⑨ | 背压不可观测 | 中 | 可观测性 | P2 |
| ⑧ | Git/VCS 无超时 | 低 | 稳定 | P3 |
| ⑩ | 审批积压无控制 | 低 | 效率 | P3 |

### 治理路线建议

1. **P0（立即）**：Agent 执行加 wall-clock 超时（③）；全局断路器（⑦）；队列 enqueue 加硬上限（①）。
2. **P1（本周）**：调度器 per-project 限速（②）；合并嵌套重试为统一策略（⑤）。
3. **P2（本月）**：成本熔断改为 mid-flight 实时（⑥）；全量重试增量恢复（④）；关键水位仪表板（⑨）。
4. **P3（按需）**：Git 调用异步化加超时（⑧）；审批积压自动淘汰（⑩）。
