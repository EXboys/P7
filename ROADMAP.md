# Roadmap
## Active
Feature: AI 代码审查幻觉防御 (started 2026-05-31)
- [ ] 重写 diff-critic 系统提示词，从「通用审查 4 项」扩展为 6 维度——逻辑/安全/边界/资源/幻觉引用/范围外文件，新增「幻觉引用」维度要求逐条验证导入路径、API 名称、类型引用是否在项目依赖或标准库中真实存在
- [ ] 增强 diff-critic.ts 输出解析，废弃单一正则 `OK: true/false`，改为结构化解析：提取 FINDINGS 列表并按严重级别（blocker/warning/info）分类，blocker 命中幻觉或安全问题时强制 OK: false
- [ ] 编写幻觉检测 fixture 测试集——构造包含虚构 npm 包导入、不存在的 Node API、错误类型签名的 diff snippet，验证 diff-critic 能否捕获至少 80% 的已知幻觉模式
- [ ] 将 diff-critic 结果写入 PlanState 的 review 字段，失败时在 auto_merge 路径阻断 PR 合并，并将幻觉类发现沉淀到 agent-memory 的 lessons

Feature: 构建系统质量门禁 (started 2026-05-31)
- [ ] 在 executor 执行流程中插入 pre-check 阶段——执行 `tsc --noEmit` 类型检查与 Biome lint（如已配置），失败时拒绝进入文件修改步骤，错误信息写入 PlanState
- [ ] 将 pre-check 结果格式化为结构化 JSON（文件/行号/错误码/严重级别），作为 diff-critic 的上下文输入，避免 AI 审查时对已存在的类型错误重复报告
- [ ] 为构建门禁编写降级策略——当 tsc/Biome 不可用时（未安装、版本不兼容），自动 fallback 到项目已有的 test_command（若配置），确保门禁不成为阻断点

## Backlog
- Openrsync 代码审计模式研究——提取 OpenBSD 团队在 rsync 重实现中使用的安全检查清单（内存安全、边界条件、协议合规），沉淀为 diff-critic 的安全维度增强 prompt 模板
- AI 成本可观测性仪表板——在 discovery-daily 与 executor 中加入 token 用量与成本估算指标，输出到 PlanState，支持成本上限熔断
- plan-critic 结构化升级——参照 diff-critic 的结构化输出方案，将 plan-critic 的输出从自由文本改为 FINDINGS + OK 结构化格式

## Done
- P7 自主开发管线初始化（discovery → Roadmap → Plan → PR 全链路）
- 基础 diff-critic 实现（regex OK: true/false 判定）
- 基础 plan-critic 实现（4 维审查）
