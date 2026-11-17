# 网页回复来源圆标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 已配对网页逐条显示实际代答者的一枚共享头像。

**Architecture:** 来源只读消息自身的 speaker/provider；复用 mAgents 的图形、圆形、单色与无障碍画法。名称读既有设备接口的 providers[].name，不复制名字表，也不以当前 Mode 决定来源。openai 与未知 provider 走共享通用首字符圆标。

**Tech Stack:** 经典 JavaScript、CSS tokens、Happy DOM、Vitest、Bun 构建。

**Spec:** `docs/superpowers/specs/2026-11-16-who-answers-design.md` §3/§5 PR7；本次用户授权覆盖源码编辑、离线 Vitest 和 build:mobile。

## Global Constraints

- 只修改分配的 `who-answers-web-avatar` worktree；主代理唯一写入者。
- CC / notice / 旧记录不露后端标；不根据 model、Mode、事项参与者猜来源。
- 不改 App、桌面、daemon 路由；不扩大短链接范围。
- 只增测试；不跑 UI/Playwright、真服务、真实模型或生产数据；不输出环境变量。
- 颜色仅使用现有 tokens，不新增深色模式。
- 不 push/开 PR；验证后提交，若沙盒不许则保留改动并按指定路径写提交信息和报告。

## Review Focus

- 带事项引用与普通消息必须走同一行模板；各测一次。
- 同一记录刷新、翻页后来源保持逐条独立，不拿当前模型补标。
- openai 即使 model 为其他厂牌也只显示通用圆标。
- 名称读取失败不阻止历史显示；撤权后的迟到读取不复活私信。
- link 身份无私人读取或发送；复用现有 link scope 和颜色/生成物守卫。

### Task 1: 网页来源圆标与交付

**Files:**
- Modify: `apps/mobile/src/conversation.js`, `apps/mobile/src/conversation.css`
- Test: `apps/mobile/conversation.test.ts`, `scripts/link-routes-from-source.guard.test.ts`, `scripts/mobile-web-errors.guard.test.ts`
- Generate: `src/features/phone/mobile-page.generated.json`（其他构建产物仅实际变化时提交）

**Interfaces:**
- Consumes: 消息 `{role,speaker?,provider?,model?,id,at,text}`；既有 `mAgents.agentGlyph/agentAvatarsHtml`；`GET /v1/matter/owner-chat/model` 的 `providers: {id,name}[]`。
- Produces: 统一 `cMessageHtml(m)`；`cReplyAvatar(m)` 仅 agent 回复输出单枚共享圆标。名称读取只能在 isDevice 且身份/隐私修订未变时采用。

- [x] 增测真实 DOM：对应 provider、CC/notice/旧记录、未知/openai、翻页刷新、引用路径、名称失败与撤权迟到。
- [x] Run: `bun --bun vitest run apps/mobile/conversation.test.ts --maxWorkers=1`。Expected: 新 agent 圆标断言红，旧测试仍绿。
- [x] 实现统一行模板、单枚来源圆标与 device-only 名称读取；CSS 只复用现有变量。
- [x] Run: 同一测试命令。Expected: 全绿。
- [x] Run: `bun run build:mobile`。Expected: 生成物更新，无服务监听。
- [x] Run: mobile/root typecheck、depcheck、针对性 mobile 单测、短链接/颜色/生成物守卫。Expected: 全绿；沙盒不支持项如实记报告。
- [x] 独立只读 review，处理正确性问题；`git diff --check`。
- [x] 写指定报告与中文提交信息；尝试仅提交自己的变更，不推送。结果：沙盒拒绝创建 index.lock，保留全部改动与指定提交信息。
