# P7 稳定性说明

## 系统为什么会「看起来挂了」

常见不是进程死了，而是下面几类**静默阻塞**：

| 现象 | 常见根因 |
|------|----------|
| 「管道停滞 · 将自动恢复」一直不变 | 恢复 job 失败（LLM/API/PR 门禁），但 UI 以前不显示错误 |
| 调度器不再生成 Plan | 今日 `discover-daily` 已成功一次 + 恢复失败 → 被 `daily_exists` 误跳过（已修） |
| execute 不跑 | OPEN PR 冲突门禁、或无 approved Plan |
| 任务秒失败 | `ANTHROPIC_BASE_URL` 域名不在白名单（已自动并入当前代理域名） |

## 已内置的稳定性机制

- **调度前预检**：LLM 凭证、API 域名、OPEN PR 门禁，失败写入 audit / 横幅「阻塞」
- **管道恢复优先**：Roadmap 空队列时，`recoverStall` 优先于「今日已 daily」
- **失败可重试**：失败的 discover 不计入「今日已完成」；恢复失败 3 分钟内退避
- **诚实 UI**：恢复失败显示真实错误，不再写「约 2 分钟一定好」
- **队列上限**：`max_pending_plans` 在 `generatePlan` 入口强制
- **熔断**：连续失败 `max_consecutive_failures` 后暂停 loop

## 推荐配置（控制台 / `.p7/config.json`）

```json
{
  "allowed_api_domains": ["api.anthropic.com", "api.deepseek.com"],
  "max_pending_plans": 5,
  "max_consecutive_failures": 3,
  "execution_timeout_minutes": 45,
  "vcs": {
    "block_new_work_only_conflicting": true,
    "merge_conflict_wait_minutes": 90
  },
  "discovery": {
    "auto_recover_stall": true
  }
}
```

## 工作台（overview）对 failed 的处理

打开 `/project/<alias>/overview` 时会自动：

1. **校正假「执行中」**：Plan 为 `executing` 但队列无 execute job → 标为 `failed` 并提示可重试  
2. **清扫过期 approved**：重试耗尽 / Roadmap 已完成 / 目标过期 → 自动 abandon  
3. **「失败与恢复」面板**：列出失败 Plan + 失败任务，带原因分类与按钮（重试执行 / 重试发现 / 日志 / 放弃）  
4. **指标卡「失败待处理」**：失败项数量一目了然  

重试前若环境预检未通过，面板会提示先修「环境检查」。

## 运维检查清单

1. 控制台活动条是否出现 **「阻塞：…」** → 按提示修（API、gh、PR）
2. **任务队列** 最近 `discover-daily` / `execute` 是 `failed` 还是 `running`
3. `curl http://127.0.0.1:8765/` 是否 302（服务活着）
4. 改 `server/` / `src/` 后**必须重启** 8765 进程

## 仍可能不稳定的情况

- 代理/API 限流或欠费 → 需换 key 或降频
- 单 Plan 执行超过 `execution_timeout_minutes` → worker 会杀进程
- 语义级 merge 冲突 → Agent 可能合错，需人工 merge
