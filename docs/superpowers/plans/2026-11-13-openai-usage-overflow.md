# OpenAI 兼容 usage 与超长恢复修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. 主执行者独占指定 worktree 的写操作，代理只读核查与最终审查。

**Goal:** 让兼容网关提供真实流式用量，缺失时仍能轮换，并在上下文拒绝或重复 4xx 后恢复对话。

**Architecture:** 共用 APIModel 在真实序列化边界请求 usage、记录请求字节、对不支持参数的端点有界降级。错误集中分类，ContextRotation 持久化窗口证据及连续失败保险丝，coordinator 保持一次超长恢复重试。

**Tech Stack:** TypeScript、AI SDK、Vitest、隔离临时 SQLite/JSON。

**Spec:** `docs/superpowers/specs/2026-11-13-context-rotation-design.md`，本次任务授权的修订以设计稿追加说明为准。

## Global Constraints

- 仅 `openai-usage-overflow` / `wt-usage-overflow`，不 push、不部署、不调用真实 API。
- 不操作真机 daemon、生产库、已安装 App、UI 或生产配置。
- 只在 load < 8 时串行执行相关单文件 Vitest；typecheck 可跑，verify 留给 CI。
- 不输出环境变量或凭据；不删除、放松已有测试。

## Review Focus

- 参数降级只适用于明确拒绝 stream_options/include_usage 的 400/422，其他错误和已开始的输出不重发。
- 请求大小来自真正发出的 UTF-8 JSON，包括 system/tools；只在 OpenAI 通道缺 usage 时按 /3 估量。
- 超长文案仅在错误通道分类；limit 与 requested 独立解析，缺数字仍恢复。
- 保险丝只针对同会话连续同样 4xx 且请求未缩小，成功、不同错误或新段复位。
- 重试仍失败只交付一次失败通知，重试带接续且请求确实缩小。

### Task 1: 传输观测及兼容降级

**Files:** `src/adapters/executors/openai/api-model.ts`、传输辅助文件、`openai-session.ts`、`api-model-usage.test.ts`。

- [x] 写序列化 usage / 实际字节 / 参数拒绝一次降级 / 端点隔离 / generate 路径测试并观察红。
- [x] 共用传输开启 includeUsage，记录实际请求字节，按端点记住参数不兼容；跑同一文件观察绿。

### Task 2: 超长识别、窗口与恢复保险丝

**Files:** `src/lib/provider-error-code.ts`、`src/app/context-rotation.ts`、`session-manager.ts`、`coordinator/solo.ts`、窗口持久化及 wiring。

- [x] 以真实 LiteLLM 文案及常见上游文案补错误夹具、窗口隔离、真实 APIModel + provider + manager + coordinator 请求缩小回归，观察红。
- [x] 实现错误分类和 limit/requested 解析、窗口实测上界、OpenAI /3 估量及两轮 4xx 下一轮换段，观察绿。
- [x] 正常回复相同措辞、原生未知不换、成功/缩小/错误变化复位、恢复再失败均有回归。

### Task 3: 模型入口与评估模型

**Files:** `src/daemon/internal-api/routes-daemon-control.ts`、`src/daemon/bootstrap/providers.ts` 及对应测试。

- [x] 显式/默认 OpenAI 无数字模型与热切主模型后 cheapEval 模型回退测试先红。
- [x] 保留原生入口校验，OpenAI 放开；评估现取 openaiEvalModel 或主模型；单文件绿。

### Task 4: 交付

- [x] 更新设计稿，运行受影响单文件及 typecheck、diff 检查，独立只读审查。
- [x] 报告记录红绿、限制与 verify 留 CI；Co-Authored-By: Codex 提交，不 push。
