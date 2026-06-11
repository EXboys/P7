# Apache Burr vs P7 Executor: Stateful Orchestration & Retry/Compensation Pattern Comparison

> **分析日期**: 2026-06-11
> **Burr 版本参考**: Apache Burr (Incubating) ~0.18.x (基于 apache.org 在线文档)
> **P7 基线**: `src/executor.ts` @ `da4661f`（含 backpressure-analysis.md / hyper-agentic-pipeline-patterns.md）
> **用途**: 本笔记对比 Apache Burr 有状态编排和重试补偿治理模式与 P7 现有 executor 架构，为 hyper-agentic pipeline 下一阶段设计提供输入。

---

## 目录

1. [Apache Burr 核心概念与有状态编排模型](#1-apache-burr-核心概念与有状态编排模型)
2. [八维度模式对比](#2-八维度模式对比)
3. [差距分析：Burr → P7 模式映射](#3-差距分析burr--p7-模式映射)
4. [三阶段 Hyper-Agentic 推广建议](#4-三阶段-hyper-agentic-推广建议)
5. [Executor 源码位置参考表](#5-executor-源码位置参考表)
6. [总结与下一步](#6-总结与下一步)

---

## 1. Apache Burr 核心概念与有状态编排模型

### 1.1 核心抽象

Apache Burr 的核心是将应用程序建模为**显式状态机**（explicit state machine），所有决策路径、状态转换和副作用都通过声明式 API 定义，而非隐式在代码中。

| 概念 | Burr | P7 Executor |
|------|------|-------------|
| **执行单元** | `Action`（函数式或类式） | `executePlan()` 单一大函数（~480 行） |
| **状态模型** | `State`（不可变，函数式更新） | 隐式状态（文件系统 + PlanState SQLite + SDK cost 累加） |
| **转换/路由** | `Transition`（条件 + `when/expr/default`） | 硬编码线性步序（10 步 `→` 链） |
| **图结构** | DAG（支持条件分支、并行） | 严格线性管道 |
| **持久化** | `StatePersister`（SQLite, Postgres, S3 等） | `PlanState` + `writeStepState`（无自动恢复） |
| **可观测性** | `Tracker`（UI `/burr` 实时跟踪） | `writeStepState` + 日志（无 UI） |
| **生命周期钩子** | `Hook`（pre/post run step） | 仅有 `writeStepState` 事件记录 |

### 1.2 状态机驱动编排模型

Burr 的工作流定义是一个**显式图**：

```python
app = (
    ApplicationBuilder()
    .with_actions(human_input=human_input, ai_response=ai_response)
    .with_transitions(
        ("human_input", "ai_response"),
        ("ai_response", "human_input", ~expr("'exit' in question")),
        ("ai_response", "terminal", expr("'exit' in question")),
    )
    .with_state(chat_history=[])
    .with_entrypoint("human_input")
    .build()
)
```

对比 P7 的隐式线性管道：

```typescript
// executor.ts:341-553 — 严格 10 步线性序列
worktree_create → sdk_execution → diff_check → typecheck → test → diff_critic → git_commit_push → vcs_publish → review_merge
```

**关键差异**:

- Burr 的转换是**声明式条件驱动**的——开发者声明"当 X 条件成立时执行 Y"，框架负责路由。
- P7 的步序是**命令式线性硬编码**的——每步按固定顺序执行，无运行时路由决策。
- Burr 的 State 是**不可变快照**——每步输入是上步的 subset，输出 merge 回全局。P7 的 PlanState 是**可变持久化**——各步直接修改 SQLite 或文件系统，无显式状态边界。

### 1.3 Action 的数据流契约

Burr 的 Action 声明 `reads` 和 `writes`，框架自动做 state subset/merge：

```
current_state = ...
read_state = current_state.subset(action.reads)  # 只读需要的 key
result = action.run(read_state)
write_state = current_state.subset(action.writes)  # 只写声明写的 key
new_state = current_state.merge(action.update(result, write_state))
```

这个契约保证了**可组合性**和**依赖追踪**——框架知道每步读写哪些数据，可以优化执行顺序、检测冲突、支持并行。

P7 缺乏等价契约：每步函数的参数和副作用都是隐式的，需要通过代码阅读来推断依赖关系。

---

## 2. 八维度模式对比

### 2.1 重试分层 (Retry Layering)

| 维度 | Apache Burr | P7 Executor |
|------|-------------|-------------|
| **重试实现** | 应用层 via Action 内部 try/catch + 自定义条件 transition [assumption] | `withExponentialBackoff` 两层嵌套（`executor.ts:315` + `sdk.ts:109`） |
| **重试策略** | 无限重试 via 自环 transition，可选 max 限制（planned: `error(Exception, max=3)`） | 指数退避：max 3 次，初始 5s，翻倍至 60s |
| **重试粒度** | Action 级别（整个 action 重做） | `runOnce()` 全量重试（内外两层共 9 次发送） |
| **幂等性** | Action 负责自身幂等（State 不可变保证自然幂等） | `resetWorktree()` 回滚到基线，但 VCS 操作不幂等 |
| **重试隔离** | 每个 Action 可独立声明重试策略 [assumption] | 全局 `execution_retry` 配置，所有 pass 共享 |

**P7 差距**: 嵌套重试放大（2.5）是已知问题。Burr 的计划功能 `error(Exception, max=N)` 允许在 Transition 层面声明重试策略，比 P7 的 `withExponentialBackoff` 包裹更声明式和灵活。

### 2.2 补偿 (Compensation)

| 维度 | Apache Burr | P7 Executor |
|------|-------------|-------------|
| **补偿机制** | 无原生补偿事务。Hooks 提供 post-run step 回调可用于补偿逻辑 [assumption] | `resetWorktree()` 全量回滚 + `removeWorktree()` 清理 |
| **补偿粒度** | Hook 级别（action 级别后回调） | 全局（整个 Plan 失败则丢弃 worktree） |
| **部分补偿** | 可通过 Hooks 为每个 action 注册补偿 [assumption] | 不支持——失败后所有 worktree 改动都被丢弃 |
| **补偿声明** | 无声明式补偿 API | 无——补偿是隐式的（`catch → resetWorktree → throw`） |

**P7 差距**: Burr 没有原生 Saga 补偿模式，但其 Hooks API 提供了在 Action 后执行清理逻辑的扩展点。P7 当前是"全丢"策略——一旦失败，整个 worktree 被清除。对于部分成功的复杂 Plan（如已推送 PR 但后续步骤失败），缺少声明式补偿处理器。

### 2.3 断路器 (Circuit Breaker)

| 维度 | Apache Burr | P7 Executor |
|------|-------------|-------------|
| **断路器实现** | 无原生断路器。可通过 transition 条件 + 状态追踪模拟 [assumption] | 配置存在（`max_consecutive_failures: 3`）但代码未实现（backpressure 2.7） |
| **熔断状态** | 不适用 | 仅概念：`config.ts:134` 定义，`executor.ts` 未读取 |
| **冷却期** | 不适用 | 未实现 |
| **半开恢复** | 不适用 | 未实现 |

**P7 差距**: `max_consecutive_failures` 配置存在已数个 commit，但 executor.ts 中没有任何读取逻辑。Burr 没有断路器的直接等价物，但其 State 驱动的条件路由允许开发者"自建"熔断逻辑——将失败计数存入 State，在 Transition 条件中检查。

### 2.4 状态持久化 (State Persistence)

| 维度 | Apache Burr | P7 Executor |
|------|-------------|-------------|
| **持久化方式** | 可插拔 `StatePersister`（SQLite, Postgres, S3, Local 等） | `PlanState`（SQLite） + `writeStepState`（文件） |
| **持久化时机** | 每 Action 执行后自动写入 | 仅步骤边界（start/complete/fail）写入 |
| **状态恢复** | `initialize_from()` + `fork_from_app_id()`——可从任意历史序列恢复 | `loadLatestPlanRecord()` 仅读最新 Plan，无历史状态快照恢复 |
| **状态分叉** | `fork_from_app_id` + `fork_from_sequence_id`——支持从历史任意点分叉 | 无等价功能（`preparePlanExecuteRetry` 仅重试当前 Plan） |
| **状态版本** | Immutable State（Linked List 式差量，planned） | `StepState`（独立记录，无版本链） |

**P7 差距**: Burr 的状态持久化是**一等公民**——应用可以安全停机并在任何时间点恢复。P7 的 `PlanState` 更偏向"执行日志"而非"可恢复状态快照"。Burr 的 `fork_from_app_id` 功能是调试的强力工具——允许从历史执行的任意序列 ID 分叉出新执行。

### 2.5 条件分支 (Conditional Branching)

| 维度 | Apache Burr | P7 Executor |
|------|-------------|-------------|
| **分支声明** | `Transition(from, to, condition)`——条件在 State 上求值 | 无——线性硬编码步序 |
| **条件能力** | `when(foo="bar")`, `expr("epochs>100")`, `default`, Django 风格比较操作符 | `if (stats.files > 0) break` 仅限 SDK pass 早退 |
| **运行时条件** | State 驱动——任何 State 中存储的值都可作为分支条件 | 无——分支点硬编码在 executor.ts:341 的序列中 |
| **异常分支** | `error(Exception)` 转换——planned 功能，异常驱动分支 | 所有异常走同一个 catch（executor.ts:579） |

**P7 差距**: Burr 的核心能力——**显式条件路由**——正是 hyper-agentic 模式中 `ConditionalStep` (HAP §2) 的目标。P7 当前 `maxAgentPasses` 早退（executor.ts:341）是唯一的分支点，且非声明式。Burr 的 `when()` 和 `expr()` 原语比 HAP 提议的 `ConditionalStep` 接口更通用（state 驱动 vs plan-time 静态 route map）。

### 2.6 动态重排 (Dynamic Reordering)

| 维度 | Apache Burr | P7 Executor |
|------|-------------|-------------|
| **重排能力** | 重排通过 State 驱动 + Transition 隐式完成（但 DAG 拓扑固定） | 无——步序固定为线性 |
| **运行时优先级** | 条件求值顺序决定路由——第一个匹配的 Transition 被选中 | 不适用 |
| **步骤跳过** | 通过条件 transition 可以跳过 Action（需声明条件） | `maxAgentPasses` 早退 (`stats.files > 0 break`) |
| **动态插入** | 可通过 State 驱动的路由选择不同 Action 序列 | 无 |

**P7 差距**: Burr 不直接支持 HAP §4 提议的 `DynamicPipeline` 重排（运行时根据 cost/signal 排序步骤）。但 Burr 的 **条件 Transition** 加上 Action 的**有条件执行**（`node.condition` 非概念，但可模拟）实现了等价效果：通过 State 中的运行时信息（cost、diff size、失败计数）决定下一步走向。

### 2.7 错误分类 (Error Classification)

| 维度 | Apache Burr | P7 Executor |
|------|-------------|-------------|
| **错误分类模型** | 异常驱动——Python 异常类型自然分类 [assumption] | `FailureKind` 枚举（`failure-classifier.ts:1-16`） |
| **分类粒度** | 按 Exception type 区分（如 `APIException` vs `ValueError`） | 按错误字符串正则匹配（`classifyFailure()` 15 种） |
| **重试可导** | Exception 类型→Transition 条件映射 | `FailureClassification.retryable` 布尔标记 |
| **自动修复** | 可通过 error transition 路由到修复 Action [assumption] | `autoRepair` 布尔标记（但 executor 未实现） |
| **硬停止** | `hardStop` 等价：未处理异常→程序终止 | `hardStop: boolean`（auth、cost、plan_scope） |

**P7 差距**: Burr 的 planned `error(Exception)` transition 比 P7 的 `classifyFailure()` 更**声明式**——异常类型直接映射到 Transition 路由。P7 的分类通过字符串匹配（`failure-classifier.ts:27-71`）实现，维护性差、运行时开销大。P7 的 `autoRepair` 和 `hardStop` 标签存在但 executor 未消费——与 `max_consecutive_failures` 的缺口一致。

### 2.8 可观测性 (Observability)

| 维度 | Apache Burr | P7 Executor |
|------|-------------|-------------|
| **跟踪 UI** | `burr` CLI 启动本地 UI（端口 7241），实时查看状态机执行历史 | 无——仅有文件和日志跟踪 |
| **跟踪数据模型** | Project → Application (`app_id`) → Step (`sequence_id`) | PlanState (`planId`) → Step (`step_name`, `status`) |
| **内部 trace** | `@trace()` 装饰器 + `__tracer` 上下文管理器——Action 内部任意层级 | 无——仅有 `appendExecuteToolLog()` 文本日志 |
| **OpenTelemetry 集成** | 原生支持——`use_otel_tracing` 标志 + `OpenTelemetryBridge` hook | 无 |
| **状态快照** | 每步骤开始/结束 Snapshot（State + 输入 + 输出） | `writeStepState` 仅记录状态和时间戳，不记录输入/输出 |
| **重试可见性** | 重试作为 Action 的内部逻辑——不单独记录 | `recordBackpressureEvent` 记录重试事件 |

**P7 差距**: Burr 的可观测性是最强差异点之一。P7 虽然实现了 `writeStepState` 和 `recordBackpressureEvent`，但**缺乏集中式 UI**、**内部 Action trace** 和 **OpenTelemetry** 集成。Burr 的 `@trace()` 装饰器允许开发者零侵入地观察任意函数的调用链。

---

## 3. 差距分析：Burr → P7 模式映射

### 3.1 与背压缺口分析映射

以 `docs/backpressure-analysis.md` 的 10 个缺口为框架，评估 Burr 模式能否填补：

| # | 缺口 | Burr 模式 | 填补可能 | 说明 |
|---|------|-----------|----------|------|
| 2.1 | Plan 队列无界 | Burr 无等价队列——`Application` 本身无队列 | ❌ | Burr 面向单次执行，不处理跨应用编排。P7 需要独立设计队列背压 |
| 2.2 | 调度器缺速率限制 | Burr 无调度器——手动调用 `.step()` | ❌ | 不适用 |
| 2.3 | Agent 执行无超时 | Burr `timeoutMs` per node（`PipelineEngine` style）已实现 | ✅ | 可借鉴 Burr 的 node-level timeout 模式 |
| 2.4 | 全量重试浪费 | Burr Action 级别重试（更细粒度） | ✅ | 将重试从 `runOnce()` 级下放到 step/action 级 |
| 2.5 | 嵌套重试放大 | Burr 无嵌套——Transition 重试在 Action 外部一层 | ✅ | 消除嵌套：单层 Transition 级别重试 |
| 2.6 | 成本熔断滞后 | Burr 无原生成本跟踪——假设在 Action 内部处理 | ⚠️ partial | 需在 Executor/State 层（非 Action 层）实现 |
| 2.7 | 连续失败断路器未实现 | Burr `error(Exception, max=N)` Transition 等价 | ✅ | 用 State 驱动断路器实现 |
| 2.8 | Git/VCS 无超时 | Burr 原生 timeout 每 node | ✅ | node-level timeout + AbortSignal |
| 2.9 | 背压数据不可观测 | Burr `@trace()` + `log_attribute()` 可替代 | ✅ | 用观察点代替背压指标收集 |
| 2.10 | 审批积压无控制 | 不适用（Burr 无审批概念） | ❌ | 需独立设计 |

**结论**: Burr 模式可填补 6/10 缺口，2/10 partial，2/10 不适用。

### 3.2 与 Hyper-Agentic Pipeline Patterns 映射

以 `docs/hyper-agentic-pipeline-patterns.md` 的三种模式为框架：

| 模式 | Burr 等价 | 映射分析 | 推荐程度 |
|------|-----------|----------|----------|
| **ConditionalStep** (HAP §2) | `Transition` + `when()/expr()` | Burr 的 Transition 原语比 HAP `ConditionalStep` 更通用——它支持任意 State 条件，而非仅限于 step 返回值。Burr 的 first-match-wins 求值语义与 HAP `branches` 映射一致 | ★★★ 直接采用 |
| **ParallelStep** (HAP §3) | `MapStates/MapActions/MapActionsAndStates` | Burr 的原生 map-reduce API 比 HAP 提议的 `substeps` 更丰富——支持 map-over-states、map-over-actions、全笛卡尔积。HAP 的 `all/any/race/quorum` 策略在 Burr 中没有直接等价，需自定义 reduce | ★★☆ 参考，需定制 |
| **DynamicPipeline** (HAP §4) | State 驱动 Transition（隐式动态选择） | Burr 不直接支持运行时 cost/signal 排序，但通过 State 驱动路由 + 条件 Transition 可模拟等价行为：将 `stepScore` 存入 State，在 Transition 条件中选择优先级最高的下一 Action | ★☆☆ 概念层借鉴 |

**结论**: Burr 的 Transition 模型天然覆盖 HAP 的 ConditionalStep。P7 的 `PipelineEngine`（`src/pipeline-engine.ts`）已实现 DAG 拓扑排序和 fan-out，与 Burr 的并行模型同构。

---

## 4. 三阶段 Hyper-Agentic 推广建议

基于 Burr 模式的分析，对 HAP §6 的三阶段 Roadmap 提出 Burr 启发的改进建议：

### Phase 1: 补偿处理器（追加到 ConditionalStep 实现之后）

**HAP 原文**: 实现 `ConditionalStep` + `maxAgentPasses` early-exit

**Burr 启发改进**:

1. **引入补偿声明**：在 Step 模型中添加可选 `compensate: (ctx) => Promise<void>` 回调
2. **补偿注册表**：每个可逆操作（worktree_create、git_push、PR_merge）注册补偿函数
3. **自动补偿链**：Pipeline 失败时，按逆序自动执行已成功步骤的补偿
4. **部分补偿策略**：对于已推送到 VCS 的步骤，补偿应为"创建回滚 PR"而非"删除分支"

```typescript
// Burr-Inspired Compensation Schema
interface CompensableStep extends ConditionalStep {
  /** 补偿处理器：在 Pipeline 失败时逆序调用 */
  compensate?: (ctx: PipelineContext, error: Error) => Promise<void>;
  /** 补偿策略：full（全量撤销）/ partial（仅修复关键副作用） */
  compensationStrategy?: "full" | "partial";
}
```

### Phase 2: 状态机驱动分支（替换 ParallelStep 的部分设计）

**HAP 原文**: 实现 `ParallelStep` fan-out（typecheck + test + critic 并行）

**Burr 启发改革**:

1. **引入 State 容器**：将 `PipelineContext` 升级为不可变 State（Burr State API 风格）
2. **声明式依赖**：每步声明 `reads` 和 `writes`，框架自动计算并行可行性
3. **State 快照**：每步完成后自动持久化 State，支持"从失败点恢复"
4. **条件 Transition**：用 HAP `ConditionalStep` 的 `branches` + State 值替代硬编码步序

```typescript
// Burr-Inspired Step Declaration
interface StatefulStep {
  name: string;
  reads: string[];               // 从 Context 中读取的 key
  writes: string[];              // 写入 Context 的 key
  execute(ctx: StateContext): Promise<StateContext>;
  transitions: Array<{
    target: string;
    condition: (ctx: StateContext) => boolean;  // 对应 Burr when()/expr()
  }>;
  timeoutMs?: number;
}
```

### Phase 3: 断路器集成（补充 DynamicPipeline 的成本感知调度）

**HAP 原文**: 实现 `DynamicPipeline` + cost-aware reordering

**Burr 启发集成**:

1. **断路器作为 State 变量**：将连续失败计数和熔断状态存入 `PipelineContext`
2. **Transition 前置检查**：每次 Transition 前检查熔断状态——熔断打开时直接跳转到"冷却 Action"
3. **冷却 Action**：独立的 `cooldown` Action，执行 `Bun.sleep(冷却期)` + 半开状态重置
4. **Cost-aware 优先**：将 `cumulativeCost/costLimit` 比值写入 State，Transition 条件中使用它选择下一步

```typescript
// Burr-Inspired Circuit Breaker via State
interface CircuitBreakerState {
  consecutiveFailures: number;
  lastFailureAt: number | null;
  trippedAt: number | null;
}

// Transition condition: 断路器打开则跳过执行
const circuitBreakerOpen = (ctx: StateContext) => {
  const cb = ctx.state.circuitBreaker;
  if (!cb.trippedAt) return false;
  const elapsed = Date.now() - cb.trippedAt;
  return elapsed < 30 * 60 * 1000; // 30 分钟冷却
};
```

### Burr 核心模式借用清单

| Burr 模式 | 借用到 P7 的收益 | 适配难度 | 优先级 |
|-----------|-----------------|----------|--------|
| `State` immutable + `reads/writes` 契约 | 显式依赖→自动并行检测 | 🔴 大（需要重构 Context） | Phase 2 |
| Transition `when/expr/default` | 声明式分支→替换硬编码 if/else | 🟢 小（新增条件求值器） | Phase 1 |
| `Hook` 生命周期 | 透明可观测→替换手动 writeStepState | 🟢 小（新增 hook 注册表） | Phase 1 |
| `@trace()` 装饰器 | 零侵入内部 trace→调试效率提升 | 🟡 中（需要实现 Tracer 接口） | Phase 2 |
| `initialize_from()` 状态恢复 | "停电恢复"→Plan 可中断续做 | 🔴 大（需要 State 快照+版本链） | Phase 3 |
| `error(Exception, max=N)` | 声明式重试→替换 withExponentialBackoff | 🟡 中（需要 Transition 重试引擎） | Phase 2 |

---

## 5. Executor 源码位置参考表

| 文件 | 路径 | 关键行 | 说明 |
|------|------|--------|------|
| **executor.ts** | `src/executor.ts` | 1-625 | 主执行管线：`executePlan()` (L144-618) |
| *SDK pass 循环* | `src/executor.ts` | 263-350 | `for pass=0; pass<maxAgentPasses` 循环 |
| *Diff 检查* | `src/executor.ts` | 380-412 | 文件数/行数门禁 |
| *Typecheck* | `src/executor.ts` | 415-420 | `runTypecheck` 调用 |
| *Test* | `src/executor.ts` | 423-436 | `cfg.test_command` 执行 |
| *Diff Critic* | `src/executor.ts` | 439-484 | `reviewDiffWithRouting` 调用 |
| *Git Push* | `src/executor.ts` | 486-498 | `commitWorktreeChanges` + `git push` |
| *VCS Publish* | `src/executor.ts` | 508-552 | PR 创建 + Auto Merge |
| **retry.ts** | `src/retry.ts` | 1-79 | `withExponentialBackoff` 实现 |
| *Semaphore* | `src/retry.ts` | 5-36 | `executorSemaphore`（并发 2） |
| *重试判断* | `src/retry.ts` | 37-49 | `isRetryableError()`（HTTP 429/5xx/网络） |
| **failure-classifier.ts** | `src/failure-classifier.ts` | 1-72 | `FailureKind` 枚举 + `classifyFailure()` |
| **pipeline-engine.ts** | `src/pipeline-engine.ts` | 1-190 | DAG 编排引擎：`validateDag` + `topologicalSort` + `PipelineEngine.execute` |
| *DAG 验证* | `src/pipeline-engine.ts` | 49-76 | 唯一 ID + 入口不变式 + 循环检测 |
| *拓扑排序* | `src/pipeline-engine.ts` | 78-106 | Kahn 算法 → 分层（同层并行候选） |
| *执行引擎* | `src/pipeline-engine.ts` | 122-189 | 层内 `Promise.all` + 有条件的 skip |
| **config.ts** | `src/config.ts` | 1-390 | `DevAgentConfigSchema`（配置 schema） |
| *重试配置* | `src/config.ts` | 249-263 | `execution_retry`（max_retries/delays/concurrency） |
| *断路器配置* | `src/config.ts` | 248 | `max_consecutive_failures: 3` |
| *成本上限* | `src/config.ts` | 60-61 | `execution_cost_limit` + `goal_cost_limit` |
| *超时配置* | `src/config.ts` | 62 | `execution_timeout_minutes: 35` |
| **pipeline-dsl.ts** | `src/pipeline-dsl.ts` | - | `PipelineDagDefinition` 类型 |
| **state.ts** | `src/state.ts` | - | `PlanState` + 转换函数 |
| **retry 重试** | `src/state.ts` | - | `preparePlanExecuteRetry` |

> **注意**: 上述行号以 `da4661f` 为基准。后续提交可能改变行号。

---

## 6. 总结与下一步

### 核心发现

1. **Burr 最值得借鉴的模式**是其**显式 State + Transition 模型**。这套模型天然解决了 P7 的六个背压缺口（2.3-2.9），并且是 HAP ConditionalStep 的通用超集。

2. **P7 的 PipelineEngine (pipeline-engine.ts) 已实现 DAG 编排**——这是一个被低估的资产。`topologicalSort` 的 Kahn 分层算法（L78-106）与 Burr 的并行执行模式同构，但未被 executor.ts 消费。将 `PipelineEngine` 整合到 executor 主循环中，是 Phase 2 的最短路径。

3. **最大差距在可观测性**。Burr 的 UI + `@trace()` + OpenTelemetry 集成是 P7 不具备的能力。即使不实现完整 UI，引入 `@trace()` 风格的装饰器（零侵入 Action 内部 trace）也能显著提升调试效率。

4. **断路器、补偿处理器和重试声明**是 Burr 覆盖较少但 P7 急需的领域。`max_consecutive_failures` 的代码实现（backpressure 2.7）应优先于 Burr 模式采纳。

### 推荐执行顺序

```
Phase 1a: 实现 max_consecutive_failures 断路器（2.7）——配置已存在，仅需代码。
Phase 1b: 引入 Hook 生命周期———替换 writeStepState 为可插拔 hook 链。
Phase 1c: 在 Step 模型中添加 ConditionalStep（branches + condition）——直接映射 Burr Transition。

Phase 2a: 将 PipelineEngine 整合到 executor 主线——利用现有 DAG 引擎。
Phase 2b: 引入 StateContext + reads/writes 契约——显式依赖声明。
Phase 2c: 添加编译器处理器（CompensableStep）——按逆序自动补偿。

Phase 3a: 断路器 State 化——集成到 StateContext 的 Transition 条件中。
Phase 3b: 状态快照 + initialize_from——支持 Plan 中断恢复。
Phase 3c: Cost-aware reordering——评估 ROI 后决定是否实现。
```

> **[translation gap]** Burr 是 Python-native，P7 是 TypeScript/Bun。Burr 的 `State` 不可变性和 `Action` 契约部分依赖 Python 的 `Mapping` 协议。TypeScript 等价实现可以依赖 `Readonly<State>` 和 zustand/immer 风格的状态更新。
>
> **[assumption]** Burr 的 `error(Exception, max=N)` transition 位于 Planned Capabilities 中，尚未实现。本文档的映射分析基于其 API 设计方向，Phase 2 实施前应重新检查 Burr 的最新版本。
>
> **[needs verification]** Burr 的补偿事务模式不在其文档中显式存在。Hooks 的 `post_run_step` 回调是本文推断的最接近补偿扩展点，需验证社区实现。
>
> **文档快照时间戳**: 2026-06-11。Burr 是活跃的 Apache Incubating 项目，API 可能变更。Phase 2 实现前应同步最新版本。

---

*本文档基于 apache.org 在线文档（2026-06-11 快照）和 P7 代码库 @ da4661f 生成。*
