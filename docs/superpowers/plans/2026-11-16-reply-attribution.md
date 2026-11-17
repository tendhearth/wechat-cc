# 回复来源贯通 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实际执行轮的回复归属贯通存储、converse 与历史协议，不改变展示。

**Architecture:** protocol 定义共享归属，daemon 在开轮时复制来源；交付的异步作用域把同一来源带给文字、附件及主动出口。聚合回复用可选 replyParts 保留逐段来源与附件索引，原正文不变。messages 复用 provider 列与 extras JSON；历史从存量元数据或确切 MatterTurn 投影，不猜当前后端。

**Tech Stack:** TypeScript、Zod、SQLite、Vitest。

**Spec:** `/Users/nategu_mac_company/Documents/tendhearth/wt-design-who-answers/docs/superpowers/specs/2026-11-16-who-answers-design.md` §3 / §5 PR 1（已批准）。

## Global Constraints

- 只改 reply-attribution worktree；单一写入者，其他 agent 只读探索/评审。
- 不改展示、微信前缀或路由判定；不运行 UI、真实 daemon、模型或微信。
- 旧记录缺字段不补猜；测试只增不减；不输出环境变量。
- verify 绿后中文提交并附 Codex Co-Authored-By，不 push、不开 PR。

## Review Focus

- 流开始后切换后端：分条、附件和历史仍属于原轮。
- 通知：独立标 notice，不继承失败执行者。
- 旧记录及旧协议：字段保持可选，不补推断。
- 接力/复用 run：用确切 turn，不能取当前任务 provider。
- 附件及主动 App 出口：与文字来源一致，不泄露内部路径。

### Task 1: 共享契约和持久化

**Files:** `packages/protocol/src/reply-attribution.ts`、`owner-conversation.ts`、`api.ts`、`desktop-api.ts`、`index.ts`、`src/lib/messages-store.ts`。
**Interfaces:** `ReplyAttribution`：speaker、provider?、model?、matterId?、agentId?、turnId?；旧出口使用可选字段。

- [x] 增加协议往返和存储重建测试，确认新字段未贯通时失败。
- [x] 实现共享类型及可选 schema；provider 复用列，其他字段存 extras 元数据。
- [x] 定向 Vitest 绿。

### Task 2: 实际轮到交付/存储/converse

**Files:** `src/domain/turn-reply.ts`、`src/lib/reply-attribution.ts`、`src/daemon/reply-delivery.ts`、`reply-sinks.ts`、`wiring/wire-converse.ts`、`ilink-glue.ts`、`companion/{app-channel,media-mirror}.ts`、实际 begin 调用方。
**Interfaces:** begin 接受可信 speaker/model/可选轮身份；归属快照在交付作用域传给所有出站，sink 暴露 attribution。

- [x] 增加真模块接线测试：CC/agent、分条/附件、切后端后重读、notice。
- [x] 确认红后贯通实际执行轮，converse 回包及持久化保留字段。
- [x] 定向 Vitest 绿。

### Task 3: 历史投影与收尾

**Files:** `src/daemon/wiring/{owner-conversation,owner-chat-reading}.ts`、`src/adapters/store/workbench/timeline-events.ts`、`src/app/matters/service.ts` 及对应测试。
**Interfaces:** 事内 agent_message 只从绑定的 MatterTurn executor/model/runId/id 投影；window/events/work.results 输出可选归属。

- [x] 增加接力历史、旧行及通知测试，确认红。
- [x] 实现投影，通过协议白名单；更新必要生成物/快照。
- [ ] 定向测试、只读正确性评审、`bun run verify` 全绿。
- [ ] 写指定短报告并提交。

执行记录：来源回归 9/9、金样 9/9、守卫 418/418；14 份金样仅增加来源字段。只读评审的聚合、并行附件、直接模型出口和手机白名单问题已修复并回归。完整 verify 因沙箱测试监听限制及依赖预热超时未绿，未提交。指定 scratchpad 报告已写。
