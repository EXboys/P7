# Roadmap
## Active
Feature: Elixir v1.20 渐进类型门禁代码质量验证 (started 2026-06-04)
- [x] 提取 Elixir v1.20 渐进类型核心设计模式（按文件粒度启用、逐步严格化、非全有全无）并产出对比分析笔记 (commit: c9a66ae)
- [x] 定义 diff-critic 渐进类型检查配置协议，按文件/目录粒度声明 tsc 严格模式开关 (commit: 77ab045)
- [x] 实现 GradualTypeChecker 审查器，复用 executor typecheck 步骤的结构化 JSON 输出 (commit: e323fb8)
- [x] 编写渐进类型检查 fixture 用例（正例：增量严格化 diff；负例：类型逃逸/any 退化 diff） (commit: e16ddcb)
- [ ] 集成测试渐进类型检查门禁，验证正负例阻断逻辑正确性

Feature: 自托管开发沙箱预览与 executor 安全边界收敛 (started 2026-06-04)
- [ ] 将 `.p7/discovery/` 等发现路径纳入 executor 工作树边界白名单，修补外路径权限拒绝故障
- [ ] 实现自托管开发沙箱预览 URL 生成模块，支持从 executor 状态直接打开本地预览
- [ ] 编写集成测试覆盖沙箱预览安全域隔离（防止预览 URL 泄露 host 文件系统）
- [ ] 新增 executor 路径边界审计命令 `p7 audit boundaries`，扫描所有配置路径是否在授权范围内

## Backlog
- Gemma 4 12B 轻量代码模型本地评估集成（依赖：executor 边界收敛完成后可安全拉取模型并注册端点）
- AI Agent 工具成本治理基线——接入 Uber $1500/月定价基准，实现成本标签分层归因（按模型/plan/阶段）与熔断阈值
- Hyper agentic development 动态 agent 编排对 pipeline 收敛效率的改进潜力评估
- plan-critic 结构化升级——参照 diff-critic 结构化输出方案改为 FINDINGS + OK 格式，与 PlanState 持久层对接

## Done
- 安全边界集成——文件系统路径边界、API 域名白名单、PlanState 权限违规阻断、executor 工具钩子路径校验（PRs #49–#53）
- 仪表板恢复机制修复 & 分页优化（PR #53）
- 在 diff-critic 中新增幻觉检测专用维度并接入 PlanState review 阻断逻辑
- 分析 executor pipeline 各环节的背压缺口——识别无界队列、无限重试、同步阻塞等 10 个反压缺失点，输出可操作治理路线
- P7 自主开发管线初始化（discovery → Roadmap → Plan → PR 全链路）
- 基础 diff-critic 实现（regex OK: true/false 判定）
- 基础 plan-critic 实现（4 维审查）
- PlanState SQLite 持久化层（含 JSON → SQLite 自动迁移、WAL 模式、busy-retry、计划重试恢复）
- executor 类型检查预检阶段（runTypecheck：tsc --noEmit / bun typecheck / npm run typecheck 自动探测）
- executor 指数退避重试与 $execution_cost_limit 成本熔断
- 仪表板健康检查与 failed→approved 执行恢复机制
- 重写 diff-critic 提示词：4 项→6 维度，嵌入 EY Canada 幻觉防御 canonical case
- 为 Prompt 模板体系引入变量插值与条件渲染机制
- 为 executor 执行轨迹实现 SQLite step_states 持久化
- Roadmap 执行耗尽后自动备份并生成新版
- PR 自动 review、门禁与 Review 控制台
- 调度器优先入队已批准 Plan 的 execute
- 优化 Plan 详情页排版与信息层级
- Pandoc 声明式模板驱动的文档质量工程——分析 Pandoc 模板设计模式，新增 diff-critic「文档一致性」维度，开发文档-代码自动比对工具，比对结果接入 PlanState review 阻断
- Zig 构建系统重做启发下的构建门禁可复现性升级——类型检查结果结构化 JSON 格式化，多工具链自动探测与降级，构建检查摘要写入 PlanState
```
