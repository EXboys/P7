# Roadmap
## Active
Feature: AI 代码审查幻觉防御 (started 2026-05-31)
- [x] 重写 diff-critic 系统提示词，从「通用审查 4 项」扩展为 6 维度——逻辑正确性/安全漏洞/边界条件/资源泄漏/幻觉引用/范围外文件；在「幻觉引用」维度嵌入 EY Canada 报告虚构引用事件作为 canonical case，要求逐条验证导入路径、API 名称、类型引用在项目依赖（package.json）与标准库（Node/Bun）中真实存在 (commit: 0c715fa)
- [x] 增强 diff-critic.ts 输出解析，废弃单一 `OK: true/false` regex，改为结构化提取 FINDINGS 列表并按严重级别（blocker/warning/info）分类；blocker 命中幻觉引用或安全问题时强制 OK: false，写入 PlanState 的 review 字段供 auto_merge 路径消费 (commit: b5e3860)
- [ ] 编写幻觉检测 fixture 测试集——构造包含虚构 npm 包导入、不存在的 Node/Bun API、错误类型签名的 diff snippet，验证 diff-critic 能捕获 ≥80% 的已知幻觉模式，输出通过/失败统计
- [ ] 将 diff-critic 阻塞结果接入 PlanState 持久层——review 字段写入 state.db，失败时阻断 auto_merge 路径的 PR 合并，并将幻觉类发现通过 appendLesson 沉淀到 agent-memory 的 lessons

Feature: 构建系统可复现性门禁 (started 2026-05-31)
- [ ] 将 executor 现有的 `runTypecheck` 结果格式化为结构化 JSON（文件/行号/错误码/严重级别），作为 diff-critic 审查上下文注入——避免 AI 审查对已存在的类型错误重复报告，提升审查效率
- [ ] 编写构建门禁降级策略——当 tsc 不可用时（未安装、版本不兼容），自动 fallback 到 package.json 的 `typecheck` script → Bun typecheck → 跳过并记录 warn 日志；参照 Zig 构建系统重做的设计原则「声明式依赖解析 + 惰性求值」，优先保证构建检查可复现而非强制特定工具链
- [ ] 在 PlanState 中新增 `build_check` 字段（JSON），记录每次 executor 执行前的类型检查摘要（通过/失败/跳过/耗时/错误数），供仪表板健康检查面板消费

## Backlog
- Openrsync 安全审查模式沉淀——提取 OpenBSD 团队在 rsync 重实现中采用的安全检查清单（内存安全、边界条件、协议合规），转化为 diff-critic 安全维度的增强 prompt 模板
- AI 成本可观测性仪表板——在 discovery-daily 与 executor 中加入 token 用量与成本估算指标（OpenRouter $113M 融资印证 AI 基础设施成本已成为工程决策核心变量），输出到 PlanState，支持成本上限熔断与按 goal 维度的成本归因
- Pandoc Templates 文档一致性检查——将 Pandoc 声明式模板系统的思想引入项目文档规范：在 plan-critic 中增加文档一致性维度，检查 README/CHANGELOG/API doc 是否与代码实际行为一致
- plan-critic 结构化升级——参照 diff-critic 的结构化输出方案，将 plan-critic 的输出从自由文本改为 FINDINGS + OK 结构化格式，与 PlanState 持久层对接

## Done
- P7 自主开发管线初始化（discovery → Roadmap → Plan → PR 全链路）
- 基础 diff-critic 实现（regex OK: true/false 判定）
- 基础 plan-critic 实现（4 维审查）
- PlanState SQLite 持久化层（含 JSON → SQLite 自动迁移、WAL 模式、busy-retry、计划重试恢复）
- executor 类型检查预检阶段（runTypecheck：tsc --noEmit / bun typecheck / npm run typecheck 自动探测）
- executor 指数退避重试与 $execution_cost_limit 成本熔断
- 仪表板健康检查与 failed→approved 执行恢复机制
```

---

请批准写入，我将落盘到 `ROADMAP.md`。

**变更要点说明**（P7 级决策逻辑）：

| 维度 | 决策 |
|---|---|
| **Active 保留 2 Feature** | 幻觉防御 + 构建门禁，两者均直接服务北极星「代码质量与可维护性」 |
| **Done 新增 4 项** | `state.ts` SQLite 持久层、executor typecheck 预检、重试+熔断、仪表板恢复——均已落地于源码，不应继续滞留在 Active 或 Backlog |
| **Feature 1 步骤精简** | 原 4 步→4 步但聚焦度提升：提示词→解析器→fixture→持久化消费，形成完整闭环 |
| **Feature 2 步骤重定向** | typecheck 预检已在 executor 中实现（`runTypecheck`），步骤不再重复要求"插入 pre-check"，而是聚焦于**结构化输出 + 降级策略 + 状态持久化**三个未完成缺口 |
| **Backlog 雷达对齐** | 4 条 backlog 分别对应 Openrsync（安全）、OpenRouter（成本）、Pandoc Templates（文档一致性）、plan-critic 自身质量升级，全部可追溯到今日雷达主题 |
