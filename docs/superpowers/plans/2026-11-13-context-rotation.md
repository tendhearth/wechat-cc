# 主人对话上下文轮换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Only root writes this worktree; other agents read and review.

**Goal:** 各主人对话后端在安全轮间按体检预算轮换，当场记账后才能离开旧段。
**Architecture:** app 中共享策略，daemon 注入记忆/预算/持久状态；SessionManager 管统一观测和安全释放；provider 仅报历史占用。
**Tech Stack:** TypeScript / Bun / Vitest / SQLite / atomic JSON.
**Spec:** ../specs/2026-11-13-context-rotation-design.md

## Global Constraints

只改本工作区；不碰真实 daemon、生产库或凭据；不改 recall/topics 检索和工作台/终端；旧历史不删；测试只增不减；主 Mac verify 先负载门禁；不 push。

## Review Focus

- App 消息落库在 dispatch 之后，当场抽取必须下一 macrotask。
- 水位不能跳 backlog，多个抽取入口不能互相回退。
- 单轮多步累计 usage 不能当上下文长度。
- 冷启动/轮换失败/重启不能丢接续或旧 API records。
- 陪伴可见全文保留，但不得重新灌入主人模型历史。

### Task 1: 共享策略与接续
- [x] 写 context-rotation.test.ts：三种后端超预算换段、busy/审批拒换、账未齐不换、6轮及在办行、原文延续、默认与实测。
- [x] 跑测试见红；实现 app/context-rotation.ts、domain/context-continuation.ts，接 session-manager 和 solo/types。
- [x] 跑定向测试见绿。

### Task 2: 抽取与生产接线
- [x] 写 bounded extraction / post-delivery / rate limit / nightly success 的离线测试，跑红。
- [x] extractor 增加小窗口及同库/chat 串行；daemon/bootstrap/wire-context-rotation.ts 注入来源过滤、持续水位、原子状态与活动摘要；接 bootstrap/checkup late/health。
- [x] 跑定向测试见绿。

### Task 3: 陪伴与 API 历史、CLI
- [x] 写 tick 隔离、API 保留与真实 OpenAI 会话上限、health/CLI 展示测试，跑红。
- [x] tick 短 alias 前后 forget；API 只增加观测/不清旧档；status 解析显示状态。
- [x] 定向绿后只读代理审查并修正确认问题。
- [x] 主 Mac 负载门禁后 bun run verify：全绿，退出码 0。
- [x] 写红绿/限制报告，提交带 Codex trailer，不 push。

## 执行记录

- 共享策略、三后端 coordinator/manager、API 原始历史保留、小窗口抽取先见红后绿；初轮 49 项通过。
- 只读评审发现并以红/绿修复：失败轮边界、排队输入精确排除、同 ts 尾窗/整组、短 alias 状态污染、普通下一轮陪伴行、换 provider 接续绕行。
- 补充原生工具大小未知的保守预留、长回答保留主人原话、夜间成功立即轮换；专项 51 项通过。未新增 skip/skipIf。
- 两处旧断言随明确的新合同增强：API 历史从删除改为保留；陪伴 App 外发断言增加 speech:companion 来源。没有删除测试。
- 根 typecheck 与 depcheck 已经定向检查；最终按主 Mac 负载门禁执行 bun run verify，结果及提交号见指定 scratchpad 报告。

- 最终整份只读评审的两项 Important：原生续接失败回退未报标志、小窗口取旧前缀漏新决定，均补离线红/绿修复；未知续接也保守带块。夜间测试改用真实 topic-sleep 链路，无新增内部 mock。
- 首轮 verify 中既有 `src/cli/codex-version-cache.test.ts` 的离线版本探针用例失败；隔离重跑恢复 4/4，未修改其源码/时限。最终 verify 再次全量覆盖牵连集。

## 最终验证

2026-11-13，等待 CivilizationVII 退出且 load<8 后，同一门禁命令执行 `bun run verify`，退出码 0。根/手机网页/中继/App typecheck、depcheck、牵连测试 6028、App 单测 1421、全部守卫 866、真实形状沙盒 26、中继单测 69 全绿。runner 原有 skip 未更改；新增测试无 skip/skipIf。最终日志 `/tmp/cc-rotation-verify-final.log`。最终报告位于本任务指定 scratchpad 的 `codex-rotation-report.md`。
