# 免审执行者(agy / Cursor 进工作台)设计

日期:2026-09-17。状态:与主人定案,待实施计划。

## 背景

daemon 启动时已经自动发现并注册 agy(Antigravity CLI)与 Cursor(`cursor-agent` CLI),对话侧(微信 `/agy` `/cursor`、桌面「模型与后端」)可选;但工作台执行者列表只有 Claude / Codex / API。原因是工作台的能力契约要求 `permissions:'task'`——执行者必须能把每个工具调用交给 daemon 审批(权限卡、微信 y/n),而 agy / Cursor 的 CLI 没有逐工具回调;在严格模式下它们把工具直接拒掉(agy 的 print 模式连文件都写不了)。

主人的判断:装了就该能用,和 Claude / Codex 一样零配置;差别要明说。

**「免审」的真实含义:用这两家 CLI 自己的跳过审批开关启动(agy `--dangerously-skip-permissions`,Cursor `--yolo`)。** 不是"我们不弹卡片",是"没有卡片可弹"。

## 目标

- 工作台执行者列表把已发现的 agy / Cursor 列出来,标「免审」;没装的不出现。
- 第一次选到时确认一次(daemon 侧持久化),之后不再问;微信也能 `用 @agy`。
- 现有三家一行不变;"不按品牌准入"的不变式保留。

**不做**:给它们补活动信息流(它们的事件流不带工具调用);按任务隔离它们的 MCP 凭据;附件;模型/推理档选择。

## 组件

### 1. 能力模型(`src/core/workbench/executor-capabilities.ts`)

- `permissions: 'task' | 'unattended'`(其余字段不变)。
- 新增 `UNATTENDED_CAPABILITIES = { version:1, permissions:'unattended', configuration:'task-policy', completion:'native', stop:'confirmed', background:'disabled', features:{ nativeResume:true, attachments:false, executionSettings:false, modelCatalog:false } }`。
- `isWorkbenchExecutorCapabilities` 认两种 `permissions`;`isUnattendedExecutor(caps)` 便捷判断。
- `requireWorkbenchInput` 不变(附件 / 执行设置 / 恢复的拒绝照旧由 features 决定)。

### 2. 确认开关(daemon 侧持久化)

- `agent-config.json` 新字段 `workbench_unattended_ack_at?: number`(zod optional,load/save 透传)。
- service `Options.unattendedAck?: { get(): number | null; set(at: number): void }`;`wire-workbench` 用 `loadAgentConfig/saveAgentConfig` 接。
- `provider(id)` 之后、`requireInput` 内:若 `caps.permissions==='unattended'` 且 `unattendedAck.get()===null` ⇒ 抛 `unattended_ack_required`。`create` / `continueTask` / 微信 `createWechat` 都经这里,所以门在服务层,HTTP 直调与手机端绕不过。
- `service.acknowledgeUnattended(): number`(写入当前时间并返回);`list()` 的返回加 `unattendedAcknowledgedAt: number | null`。

### 3. 启动方式(`service.ts` spawn 上下文)

- `permissionMode: caps.permissions==='unattended' ? 'dangerously' : 'strict'`。Claude / Codex / API 仍是 `strict`。
- 其它上下文照传(`mcpEnv` 它们会忽略;`appendInstructions`、`resumeSessionId` 它们会用)。

### 4. 注册(`src/daemon/bootstrap/wire-workbench.ts`)

- 启动时若 `opts.boot.registry` 里有 `agy` / `cursor`,把**同一个 provider 实例**注册进工作台 registry,挂 `UNATTENDED_CAPABILITIES`,`displayName` 沿用。
- `usage` 仍只对 claude / codex 取订阅额度。

### 5. 内部 API

- `POST /v1/workbench/unattended-ack`(admin 档;operator 放行;Tauri 放行清单两处;desktop `api.js` 不需要改,走 `workbench_api` 代理)⇒ `{ acknowledgedAt }`。
- 错误映射:`unattended_ack_required` ⇒ 428 `{ error:'unattended_ack_required' }`。
- `GET /v1/workbench` 的 body 带 `unattendedAcknowledgedAt`。

### 6. 微信(`wechat-control.ts`)

- `任务 新建 <p-id> 用 @agy …` 已能解析;`unattended_ack_required` 的文案:「agy / Cursor 是免审执行者:跑任务时看不到、拦不下单步操作,只能停止。请先在桌面工作台确认一次,之后微信也能直接用。」
- `unavailable_provider` 的文案去掉写死的 "Claude Code／Codex"。
- 项目列表里的示例执行者照旧取第一个可用的。

### 7. 桌面

- 执行者下拉标签:`providerLabel` 对 `capabilities.permissions==='unattended'` 追加 `（免审）`(与「额度已用完」「限流中」同一处)。
- 空状态文案改成通用("请连接一个支持工作任务的执行者")。
- `create` / `continue` 收到 428 ⇒ 弹 `<dialog>`(仿 handoff 对话框):标题「免审执行者」,四条:看不到、拦不下单步,没有权限卡和提问,只能停止;工具凭据不是按任务隔离的;时间线只有文字;不能带附件、不能选模型。按钮「知道了,继续」⇒ `POST /v1/workbench/unattended-ack` ⇒ 原请求重发;「取消」⇒ 什么都不做。
- 任务详情头部:免审任务多一行「免审执行者 · 看不到单步,只能停止」。

## 数据流

选 agy 新建任务 → `create` → `requireInput` 抛 `unattended_ack_required` → 428 → 桌面对话框 → ack → 重发 `create` → 通过 → `execute` 以 `permissionMode:'dangerously'` spawn → 事件进时间线(只有文字)→ 成果 / diff 快照 / 租约 / 停止全部照旧。

## 错误处理

- 未确认时微信与 HTTP 都拿到同一个错误码;桌面把它变成对话框,微信变成一句说明。
- agy 在 `dangerously` 下仍可能因 CLI 版本 / 登录失败 ⇒ 走现有的 `provider_auth_failed` / 失败通知,不新增。
- 确认开关写盘失败 ⇒ 抛错到 ack 路由(500),不静默。

## 测试

- 能力:两种 `permissions` 都通过校验;`UNATTENDED_CAPABILITIES` 的 features 拒绝附件 / 执行设置。
- service:未确认 ⇒ `unattended_ack_required`;确认后 ⇒ 建任务成功;`list()` 带 `unattendedAcknowledgedAt`;spawn 上下文 `permissionMode` 免审为 `dangerously`、claude 为 `strict`(假 provider 记录 spawn 参数);"不按品牌准入"测试原样通过。
- wire-workbench:boot registry 有 agy/cursor ⇒ 工作台 registry 有它们且 caps 为 UNATTENDED;没有 ⇒ 没有。
- 路由:ack 端点 tier / operator 放行 / 428 映射 / body 字段。
- 微信:两种状态的回复。
- 桌面:标签、空状态文案、428 ⇒ 对话框 ⇒ ack ⇒ 重发(controller 级单测,`invoke` 假件)。

## 修订记录

- 2026-09-17:初稿(定案:免审 = 用 CLI 自己的旁路开关;门在 daemon 侧;四条限制明说)。
- 2026-09-17:按计划落地(任务 1–6);偏离:空状态文案保持无品牌;桌面重发逻辑放在共用的 mutate();取消按钮文案「先不用」。
