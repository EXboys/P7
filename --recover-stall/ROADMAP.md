# Roadmap
## Active
Feature: AI 代码审查幻觉防御收尾与验证 (started 2026-05-31)
- [x] 构造覆盖虚构 npm 包导入、不存在 API 调用、错误类型签名的 diff fixture 测试集
- [x] 在 diff-critic 中新增幻觉检测专用维度并接入 PlanState review 阻断逻辑
- [x] 运行 fixture 测试集验证幻觉捕获率 ≥80%，未达标则迭代 prompt 并重测
- [ ] 将阻断结果写入 diff-critic findings，阻止幻觉类 PR 自动合并
- [ ] 新增 Matplotlib Incident 类隐蔽逻辑缺陷的 fixture 用例，扩展幻觉检测维度覆盖 AI 生成代码的非显式错误

Feature: 依赖完整性校验门禁 (started 2026-06-01)
- [ ] 在 executor 预检阶段集成 npm/yarn lockfile 完整性校验（lockfile vs package.json 一致性 + 已篡改包检测）
- [ ] 在 diff-critic 中新增依赖审查维度：检测 diff 中虚构/未声明 npm 包导入与恶意版本引用
- [ ] 将依赖校验阻断结果写入 PlanState review 门禁，自动拦截未通过依赖完整性检查的 PR 合并

## Backlog
- AI 插件安全审计规则沉淀——提取 ChatGPT for Google Sheets 数据外泄事件防护模式，转化为 diff-critic 数据外流审查维度
- HTTP 请求级可观测性增强——在 executor SDK 调用层注入请求耗时与状态码埋点，输出至 PlanState 可观测仪表板
- plan-critic 结构化升级——参照 diff-critic 的结构化输出方案，改为 FINDINGS + OK 格式，与 PlanState 持久层对接
- 构建门禁扩展——支持 ESLint/Prettier 格式一致性检查接入 executor 预检阶段

## Done
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
- 新增 5 条覆盖幻觉检测盲区的 diff fixture 边缘用例（虚构 npm 包、不存在 API、错误类型签名）
- 新增幻觉捕获率集成测试，阈值 ≥80%，接入 CI 门禁
```
