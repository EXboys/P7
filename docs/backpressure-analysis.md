# Executor Pipeline 背压缺口分析

> **分析基准**: `23d16625573f36690239fb9c11fc733388ea1644`
> **分析日期**: 2026-06-01
> **用途**: 本文件枚举 `src/executor.ts` 主执行管线中所有缺失背压机制的环节，为后续限流/退避/断路器/可观测性改造提供输入。每个缺口标注严重度、代码位置、当前行为与推荐治理方案。

---

## 1. Pipeline 数据流全景

简化调用链（只展示背压相关路径）：

```
[planner.ts] generatePlan()
  → savePlanRecord() + savePendingApproval()
  → [队列调度器] → executePlan()
     ├─ 1.  PR Work Gate — 检查 PR 数
     ├─ 2.  创建 Worktree  — git worktree add
     ├─ 3.  Agent Pass 循环 (max 2 轮)
     │      └─ runSdkQuery() ← withExponentialBackoff (外层)
     │           └─ SDK query ← withExponentialBackoff (内层)
     ├─ 4.  Diff Check     — 文件/行数验证
     ├─ 5.  Typecheck      — tsc --noEmit
     ├─ 6.  Test           — cfg.test_command
     ├─ 7.  Diff Critic    — AI 审查
     ├─ 8.  Git Commit+Push
     ├─ 9.  VCS Publish    — 开 PR
     └─ 10. PR Review+Merge — 轮询等待合并
```

每个方框都可能成为压力源（无界队列、无限重试、同步阻塞、缺少熔断）。

---

## 2. 逐环节分析

### 2.1 Plan 队列（Planner → Executor）

| 属性 | 值 |
|------|-----|
| **文件** | `src/planner.ts` `generatePlan()` |
| **严重度** | 🔶 中 |
| **类型** | 无界队列 |

**当前行为**:

`generatePlan()` 每次将 Plan 直接写入磁盘（`savePlanRecord`）+ 写入 SQLite PlanState（`upsertPlanState`）+ 加入审批表（`savePendingApproval`）。系统对积压 Plan 数**没有任何限制**：`config.ts:133` 定义了 `max_pending_plans: 5`，但没有任何代码读取或强制执行该值。

Planner 和 Executor 之间通过文件系统耦合——没有内存队列、没有背压信号。当审批速度 < 生成速度时，Plan 无限积压。

**建议**:
1. 在 `generatePlan()` 入口检查 `listPlanStates()` 中 `status IN ('planned','pending_approval','approved')` 的计数是否 ≥ `max_pending_plans`，超过则拒绝新 Plan
2. 将持久化机制改为有界通道，写入前先检查积压水位

---

### 2.2 调度器 Tick（Pipeline Stall 检测）

| 属性 | 值 |
|------|-----|
| **文件** | `src/pipeline-stall.ts` |
| **严重度** | 🟢 低 |
| **类型** | 缺速率限制 |

**当前行为**:

`detectPipelineStall()` 每次被调用都会扫描 Roadmap + 审批表 + PlanState。`hasRecentPipelineRecovery()` 使用 30 分钟冷却窗口防止重复入队恢复任务，但：
- 冷却只防同一项目的重复 recovery，不防跨项目调度器频繁 tick
- 没有请求速率限制——调度器 tick 频率由外部定时器决定，未被显式限流

**建议**:
1. 为调度器 tick 添加最小间隔（如 60 秒），防止高频空转
2. 将 stall 检测结果缓存 TTL 30 秒，避免重复扫描

---

### 2.3 Agent Pass 循环——无界执行时间

| 属性 | 值 |
|------|-----|
| **文件** | `src/executor.ts:324-389` |
| **严重度** | 🔴 高 |
| **类型** | 无界循环/缺超时熔断 |

**当前行为**:

Agent pass 循环 (`for pass = 0; pass < maxAgentPasses; pass++`) 对**每个 pass 的 wall-clock 执行时间没有约束**。`deriveMaxTurns()` 根据 Plan 估算行数和文件数推算 `maxTurns`（30-60），但 `maxTurns` 是 SDK 内部的消息轮次限制，不等于执行时间上限。

一个卡住的 agent pass（如 LLM 陷入循环、tool 调用持续失败）会阻塞整个 pipeline，直到 SDK 内部超时（通常长达数分钟）。`config.ts:25` 定义了 `execution_timeout_minutes: 35`，但 **没有任何代码读取或实施该值**。

**建议**:
1. 使用 `AbortController` 或 `Promise.race` 为每个 agent pass 设置 wall-clock 超时（读取 `execution_timeout_minutes` 配置）
2. 超时后不重试（或按配置决定），直接 fail 整个 plan
3. 在 pass 级别注入进度检查点——每 N 秒检查是否超时

---

### 2.4 Transport 重试——全量重试而非部分重试

| 属性 | 值 |
|------|-----|
| **文件** | `src/retry.ts` + `src/executor.ts:363-370` |
| **严重度** | 🔶 中 |
| **类型** | 重试粒度过粗 / 同步阻塞 |

**当前行为**:

`withExponentialBackoff` 最大 3 次重试，初始 5 秒，翻倍至最大 60 秒。重试时**整个 `runOnce()` 闭包重新执行**，意味着：
- 已消耗的 SDK token 和成本完全浪费
- 如果 `runSdkQuery` 的部分 tool 调用成功了但最终阶段失败，那些成功调用的产物（如写好的文件）被 `resetWorktree()` 丢弃
- `Bun.sleep(delay)` 是**同步阻塞**——在重试等待期间无法处理任何其他任务

**建议**:
1. 改为在 SDK query 层面重试（而非在 executor 层面包裹 `runOnce()`）— 内层 `src/sdk.ts:109` 已经包了一层，应该淘汰外层
2. 移除同步 `Bun.sleep`，改用 `setTimeout` 或事件驱动等待
3. 在 `runSdkQuery` 的 `withExponentialBackoff` 中添加最大重试时间窗口，融合 jitter 防止 thundering herd

---

### 2.5 嵌套重试——指数放大

| 属性 | 值 |
|------|-----|
| **文件** | `src/executor.ts:363`（外层）+ `src/sdk.ts:109`（内层） |
| **严重度** | 🔴 高 |
| **类型** | 重试放大器 |

**当前行为**:

`src/executor.ts` 在 `runOnce()` 外包裹了一层 `withExponentialBackoff`（3 次），`src/sdk.ts:runSdkQuery()` 内部又有一层 `withExponentialBackoff`（3 次）。当 API 调用连续失败时：

```
外层重试 ── 内层重试（3 次都失败）── 外层第 2 次 ── 内层又 3 次……
```

最坏情况下：3 × 3 = 9 次 SDK 调用尝试，而不是期望的 3 次。延迟叠加：外层初始 5s，内层初始 5s，可能最坏等待 (5+10+20+40+60) 外层 × (5+10+20+40+60) 内层 = 远超预期的等待时间。

**建议**:
1. **消除嵌套**：保留一层 `withExponentialBackoff`，放在 `src/sdk.ts:runSdkQuery()` 内部，移除 `src/executor.ts:363` 的外层包裹
2. 或者让内层的最大重试次数降低到 1（不做额外重试），所有重试策略集中在外层

---

### 2.6 成本熔断——后验而非实时

| 属性 | 值 |
|------|-----|
| **文件** | `src/executor.ts:356-359` |
| **严重度** | 🔴 高 |
| **类型** | 熔断滞后 |

**当前行为**:

每次 agent pass 结束后检查 `sdkCost.costUsd > cfg.execution_cost_limit`（默认 $5）。但成本只在 **pass 边界** 检查：一个单次 agent pass 内的 tool 调用可能累积远超 $5 的成本才被发现。

`runSdkQuery()` 内部没有实时成本流——`total_cost_usd` 在 query 完成后才返回，无法在每次 tool 调用后检查。

**建议**:
1. 在 `runSdkQuery()` 中接入成本流：SDK 每返回一次 `total_cost_usd` 就检查是否超限，超限时立即中断（抛出 `AbortError`）
2. 将 `execution_cost_limit` 引入 `sdk.ts` 作为参数，让 SDK 层自身支持熔断
3. 保险：在每一轮 tool 调用后检查累计成本，超过 `limit × 0.8` 时发出降级警告

---

### 2.7 连续失败断路器——配置存在但未实现

| 属性 | 值 |
|------|-----|
| **文件** | `src/config.ts:134`（仅定义）|
| **严重度** | 🔴 高 |
| **类型** | 断路器缺失 |

**当前行为**:

`DevAgentConfigSchema` 定义了 `max_consecutive_failures: 3`，但 **executor.ts 中没有任何读取逻辑**。系统不会记录连续失败次数，也不会在达到阈值时熔断后续执行。

失败记录确实被写入 `src/planner.ts:recordFailedPlan()` 和 PlanState 的 `error` 字段，但没有聚合分析逻辑来判断"连续失败"。

**建议**:
1. 在 `executePlan()` 入口处查询最近 N 条 PlanState 中 `status='failed'` 的记录，若连续失败 ≥ `max_consecutive_failures`，直接拒绝执行并返回 `CircuitBreakerOpen` 错误
2. 熔断后设置冷却期（如 30 分钟），冷却期后自动半开
3. 在 PlanState 中增加 `circuitBreakerTripped` 字段用于追溯

---

### 2.8 工作区/VCS 操作——无超时

| 属性 | 值 |
|------|-----|
| **文件** | `src/worktree.ts` + `src/executor.ts:486-494` |
| **严重度** | 🔶 中 |
| **类型** | 同步阻塞 / 缺超时 |

**当前行为**:

`src/worktree.ts:resolveExecutionBaseCommit()` 中的 `git fetch origin`、`src/executor.ts:486-494` 中的 `git push` 都是 `Bun.spawnSync` 同步调用且**没有超时**。如果网络有问题或远程 git 服务器无响应，整个 pipeline 挂起。

`src/vcs/pr-lifecycle.ts:227` 的 PR merge 等待循环虽然有时限（`merge_wait_minutes`），但使用 `Bun.sleep(8000)` 同步阻塞轮询，期间无法处理其他任务。

**建议**:
1. 所有 `git fetch` / `git push` 调用添加 `timeout` 参数（如 60 秒），超时后走降级路径
2. PR merge 等待轮询改用异步 `setTimeout` + `AbortSignal` 模式
3. 在 worktree 创建前先测试 remote 可达性（`git ls-remote` 带超时）

---

### 2.9 背压事件记录缺失——不可观测

| 属性 | 值 |
|------|-----|
| **文件** | `src/executor.ts:256-272`（step_states）|
| **严重度** | 🟢 低（信息性）|
| **类型** | 可观测性缺口 |

**当前行为**:

`writeStepState()` 记录了步骤状态（running/completed/failed）但**不记录任何背压相关指标**：
- 当前队列积压深度
- 重试次数（retry_count）
- 当前退避延迟
- 熔断状态
- 累计等待时间

**建议**:
1. 扩展 `StepState` 类型（定义在 `server/queue/types.ts`），添加 `retry_count`、`backoff_delay_ms`、`queue_depth` 等字段
2. 在每次重试/等待时更新这些指标
3. 在 executor 顶层暴露一个可查询的背压状态端点（如 `GET /backpressure`）

---

### 2.10 审批积压——无准入控制

| 属性 | 值 |
|------|-----|
| **文件** | `src/approval.ts` |
| **严重度** | 🟢 低 |
| **类型** | 队列管理 |

**当前行为**:

`processAutoApprovals()` 根据配置自动批准 Plan，但**不检查已有多少 Plan 在执行队列中**。`auto_approve.diff_lines_max` / `files_max` / `risks_max` 只做静态审批检查，不做动态流量控制。

**建议**:
1. 在 `processAutoApprovals()` 中添加积压检查：如果队列中已有 N 个 `approved` / `executing` Plan，暂缓自动审批
2. 引入审批优先级：根据复杂度（simple/medium/complex）决定是否允许排到队列前面

---

## 3. 缺口汇总表

| # | 缺口 | 严重度 | 位置 | 影响 | 无界? | 可观测? |
|---|------|--------|------|------|-------|---------|
| 2.1 | Plan 队列无界 | 🔶 中 | `planner.ts:generatePlan` | Plan 无限积压，内存/磁盘膨胀 | ✅ | ❌ |
| 2.2 | 调度器缺速率限制 | 🟢 低 | `pipeline-stall.ts` | 高频空转，日志噪音 | ✅ | ❌ |
| 2.3 | Agent 执行无超时 | 🔴 高 | `executor.ts:324-389` | 卡住后 pipeline 长时间阻塞 | ✅ | ❌ |
| 2.4 | 全量重试浪费 | 🔶 中 | `retry.ts` + `executor.ts:363` | 成功调用产物丢弃，成本浪费 | ❌ | ❌ |
| 2.5 | 嵌套重试放大 | 🔴 高 | `executor.ts:363` + `sdk.ts:109` | 9 倍无效重试，延迟叠加 | ❌ | ❌ |
| 2.6 | 成本熔断滞后 | 🔴 高 | `executor.ts:356-359` | 超限后才检测，无法实时止损 | ❌ | ❌ |
| 2.7 | 连续失败断路器未实现 | 🔴 高 | `config.ts:134` | 配置存在但无代码执行，故障扩散 | ✅ | ❌ |
| 2.8 | Git/VCS 操作无超时 | 🔶 中 | `worktree.ts` / `executor.ts:486` | 网络故障时 pipeline 挂死 | ✅ | ❌ |
| 2.9 | 背压数据不可观测 | 🟢 低 | `executor.ts:256-272` | 运维无法判断压力来源 | ❌ | ❌ |
| 2.10 | 审批积压无控制 | 🟢 低 | `approval.ts` | 执行队列超出处理能力 | ✅ | ❌ |

**严重度分布**: 🔴 高 4 个 / 🔶 中 3 个 / 🟢 低 3 个

---

## 4. 建议治理顺序

直接映射到 ROADMAP 第 2–5 步（按 ROI 排序）：

### 第 1 优先（修复 2.5 + 2.3 + 2.7）— 🔴 高，低投入高回报
1. **消除嵌套重试**（2.5）：移除 `executor.ts:363` 的外层 `withExponentialBackoff`，只保留 `sdk.ts:109` 的内层
2. **Agent 执行超时**（2.3）：接入 `execution_timeout_minutes` 配置，用 `AbortController` 终止超时 pass
3. **连续失败断路器**（2.7）：读取 `max_consecutive_failures` 并在 `executePlan()` 入口实现熔断逻辑

### 第 2 优先（修复 2.6 + 2.8）— 中投入
4. **实时成本熔断**（2.6）：在 SDK 层接入增量成本流，tool 调用后即时检查
5. **Git/VCS 同步操作加超时**（2.8）：所有 `Bun.spawnSync` git 调用添加超时参数

### 第 3 优先（修复 2.1 + 2.4）— 中高投入
6. **Plan 队列限流**（2.1）：`generatePlan()` 入口检查积压计数
7. **部分重试**（2.4）：SDK query 层面重试而非全量 `runOnce()`

### 第 4 优先（修复 2.2 + 2.9 + 2.10）— 持续改进
8. **调度器速率限制**（2.2）+ **背压可观测**（2.9）+ **审批积压控制**（2.10）

---

## 5. 边界情况与风险

1. **并发执行**：当前系统设计为单 Plan 串行执行（调度器严格 1 个 active plan per project）。如果未来引入并发 Plan 执行，无界队列和并发冲突风险会扩大，背压方案必须包含并发度控制。
2. **重试 vs 幂等性**：当前重试策略假设 `resetWorktree()` 能使状态回滚到基线，但 `runSdkQuery` 可能已向 VCS 写入数据（PR comment、review 等），这些操作不幂等。
3. **熔断恢复**：`src/state.ts:preparePlanExecuteRetry()` 支持从 failed 恢复到 approved，但没有与断路器状态联动。熔断冷却期内，手动重试应该被阻止。
4. **本文件行号漂移**：上述代码行号以 `23d16625` 为基准；后续提交可能改变行号，建议 CI 集成行号验证。
