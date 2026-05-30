# Roadmap

## Active
Feature: 执行阶段可靠性加固（基于 SQLite 持久化队列）(started 2026-05-30)
> 北极星对齐：信号 #4「SQLite is all you need for durable workflows」— 执行可靠性直接决定代码质量交付的确定性。当前 executor 依赖内存状态 + JSON 文件，中断后无法恢复，存在重复执行或遗漏变更的风险。
- [ ] 将 PlanState 存储从 JSON 文件迁移到 SQLite（bun:sqlite），支持事务性状态流转与并发安全
- [ ] 在 executor 中实现步骤级 checkpoint：每完成一个 plan change 后写入 SQLite，记录文件路径与变更摘要
- [ ] 实现 executor 启动时 crash recovery：检测 stuck 状态的 plan，从最后 checkpoint 恢复继续执行
- [ ] 为 state.ts 添加 plan 执行日志表（plan_execution_log），记录每次状态变更的时间线与触发原因

Feature: Diff 审查精准度提升 (started 2026-05-30)
> 北极星对齐：信号 #14「On Rendering Diffs」— diff-critic 是代码质量守门员，当前仅做正则匹配 OK: true/false，审查维度模糊、误报率高，直接影响交付效率。
- [ ] 重构 prompts/diff-critic.md：显式拆分逻辑正确性、安全性、范围合规、类型安全四个审查维度，每维度输出独立判定
- [ ] 实现 diff-critic 结构化输出解析（JSON Schema），替代当前正则匹配 OK: true/false 的脆弱解析逻辑
- [ ] 为 diff-critic.ts 的 tolerated_files 配置添加 glob 模式支持，替换当前未生效的精确匹配

## Backlog
- 追踪 MCP 协议演进动态，评估 Agent SDK 依赖升级至最新稳定版的风险与收益
- 将 AI 代码审查最佳实践沉淀到 prompts/diff-critic.md，补充典型误报/漏报案例作为 Few-shot
- agent-memory 经验库（CLAUDE.md Lessons learned）支持按关键词检索，当前仅追加最近 50 条且无检索能力
- 引入 executor 执行耗时与失败率监控面板，对齐北极星「可维护性」目标

## Done
- （待执行器完成 Active 步骤后写入）

---

### 规划 reasoning

**Feature 选择依据**：从 4 个雷达主题中优选了 2 个直接可落地的方向放入 Active：

| 雷达信号 | 选择 | 理由 |
|---------|------|------|
| #4 SQLite 持久化工作流 | ✅ Active | 雷达摘要明确标注"最值得跟进"，直接加固 executor 可靠性，对齐北极星质量目标。项目已有 state.ts + retry.ts 基础设施，迁移成本可控 |
| #14 Diff 渲染优化 | ✅ Active | 低成本高收益 Quick Win。diff-critic.ts 当前仅 22 行，prompt 也只有 18 行 — 改动面积极小，收益明确 |
| #6 AI 代码质量保障 | 🔜 Backlog | 与 #14 有交集但更偏方法论层面，先做完 #14 的基础设施再引入最佳实践沉淀 |
| #13 MCP 协议演进 | 🔜 Backlog | 外部依赖跟踪，不阻塞当前迭代，作为持续观测项进入 Backlog |

**步骤粒度**：每个步骤均控制在 1 天内可完成、对应一个 Plan（≤5 文件、≤200 行 diff）。SQLite 迁移拆分为存储层 → checkpoint → recovery → 日志四步渐进式交付，避免大爆炸重构。
