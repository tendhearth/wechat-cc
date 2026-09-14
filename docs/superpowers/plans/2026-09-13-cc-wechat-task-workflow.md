# 微信共用工作任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 从微信创建已有项目中的任务，接收属于同一后台任务的可靠待处理与完成通知。

**Architecture:** 持久创建回执在调度前与任务一同提交；只读项目目录给微信稳定选择。独立 task outbox 保存原始 run/request 与投递状态，daemon 通过明确 source 的严格发送通道投递。

**Tech Stack:** Bun、TypeScript、SQLite、Vitest；现有 WorkbenchService 与 ilink 通道。

**Spec:** `docs/superpowers/specs/2026-09-13-cc-wechat-task-workflow.md`

## Global Constraints

- 仅 `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit`、`codex/cc-workbench-v1`；本地提交，不推送/合并。
- 不调用真实微信、真实模型 API 或用户 MCP，不重启真实 bot；不改冻结角色资产，不跑 build-cc-asset-kit.mjs。
- 创建以原消息稳定 ID 幂等，错误 sender/owner 不接受；同一个 WorkbenchService 服务桌面和微信。
- 发送只在明确服务端确认后记 accepted；不确定结果不能自动重发，source 必须是 workbench。
- 任务、run、请求、原账号与原 owner 的归属不可通过最近任务或当前轮次推测。

### Task 1: 项目目录与创建回执

Files: new `src/core/workbench/project-catalog.ts`, `creation-receipts.ts`, corresponding tests; modify `store.ts`, append migration v55 in `src/lib/db.ts`.

Interfaces:
```ts
interface CreationReceipt {
  id:string; accountId:string; ownerChatId:string; commandHash:string;
  projectId:string; path:string; providerId:string; taskId:string; runId:string;
  reply:string; createdAt:number;
}
// makeCreationReceiptStore(db): {get(id), add(inputWithoutCreatedAt)}
// makeProjectCatalog({ownerChatId, registered:[{alias,path}], known:[{path,providerId}], providers:string[], defaultProvider?:string})
// returns [{id,name,path,providerId:string|null}] with stable p-<20 hex> IDs.
// store.ownedProjects(ownerChatId): latest provider per exact path, all history including archived.
```

- [ ] Tests create duplicate receipt with same identity, conflict on changed command/account/owner, SQLite reopen, rollback, and FK enforcement. Catalog tests canonical symlink dedup, same basename distinct IDs, replacement invalidates ID, owner changes ID, missing directory excluded, only available provider selected.
- [ ] Run the focused new tests and record the initial failure.
- [ ] Implement the two focused modules and append-only migration; expose `store.creationReceipts` and `store.ownedProjects` without changing old assertions.
- [ ] Run both suites plus `store.test.ts`; commit owned files after review.

### Task 2: 共用服务创建与微信命令

Files: `service.ts`, `wechat-control.ts`, new `wechat-create.test.ts`, `wire-workbench.ts`.

Interfaces:
```ts
// Options.registeredProjects?:()=>Array<{alias:string,path:string}>
// service.projects(): ProjectCatalogEntry[]
// service.createWechat({ownerChatId,accountId,requestId,commandHash,projectId,providerId?,text}): CreationReceipt
// actions receives both methods; parser passes untouched original command hash.
```

- [ ] Test real service/SQLite with a fake provider: phone creates one task shared with service.list/detail; duplicate before/after finish/restart gives original reply; changed payload does not execute; owner rebind, invalid path/project/provider, and injected receipt-write failure create no task or running resource.
- [ ] Refactor start acceptance so callback persists receipt in the task/input transaction and activation follows its commit. `createWechat` looks up receipt before checking current project/provider defaults.
- [ ] Add explicit `任务 项目`, `任务 新建 p-… [用 Claude/Codex] <要求>` grammar, no global selected task. List help explains creating in known projects. Register source paths through existing project registry.
- [ ] Run `wechat-create.test.ts`, `wechat-control.test.ts`, `service.test.ts`, and workbench API tests. Commit after focused review.

### Task 3: 订阅、通知存储及 worker

Files: new `wechat-notifications.ts`, `wechat-notifications.test.ts`; append migration v56; service/event hooks and command/UI metadata integrated by root.

Interfaces:
```ts
type NoticeStatus='pending'|'sending'|'accepted'|'unknown'|'suppressed';
type NoticeKind='permission'|'question'|'completed'|'failed'|'interrupted'|'cancelled';
// Notice: id, taskId, runId, ownerChatId, accountId, kind, requestId|null,
// text, status, createdAt, updatedAt, reason|null.
// store.watch(taskId, ownerChatId, accountId, enabled), subscription(taskId)
// enqueue(input): Notice; identity derived from task/run/kind/request, content never updated.
// worker opts: store, eligible(notice):boolean, send(notice):Promise<'accepted'|'deferred'|'unknown'>
// worker wake():Promise<void>, close():Promise<void>; recover stale sending -> unknown at startup.
```

- [ ] Test duplicate enqueue, immutable content, claimed-before-send, no overlapping worker sends, muted/wrong-owner suppression, stale permission suppression, blocked transport remains pending, ambiguous and abandoned sending become unknown, restart and send-then-store-failure no blind replay.
- [ ] Implement standalone persistence/worker, export schema initializer for migration. Transport callback owns context checking; worker owns state machine and bounded drain.
- [ ] Hook service permission/question requests and final durable run status; phone-created tasks subscribe atomically. Existing tasks accept explicit reminders on/off. Detail returns current subscription and recent notice states. Do not equate retained idle with completed.
- [ ] Verify two concurrent tasks and old run notice after new run. Commit after review.

### Task 4: 严格通道、daemon 连接及结果阅读

Files: `src/lib/ilink.ts`, `src/daemon/ilink-glue.ts`, daemon wiring/main and tests; `wechat-control.ts` result paging and tests.

- [ ] First test strict acknowledged response vs malformed/status-less response, timeout, definitive closed messaging window; use fake HTTP only. Assert new path marks outbound source workbench and no account rerouting.
- [ ] Add dedicated acknowledged workbench send using persisted notice ID; avoid legacy retries after ambiguous delivery. Wire worker start/stop and context wake through existing daemon lifecycle without restarting live daemon.
- [ ] Add fixed event-ID based result pages so continuation does not change page two. Keep explicit distinction between complete text availability and binary artifact delivery; implement verified artifact delivery as its own following task if it cannot share the bounded acknowledged transport safely.
- [ ] Integration test inbound command → one shared service task → attention → phone resolution → completed notice; verify source exclusion from memory, duplicate inbound, and desktop continuation of same task.
- [ ] Run task suites, relevant inbound/ilink/memory suites, whole-repository typecheck; broad suite preserves any known unrelated baseline failures as failures. Independent review and local commits with exact evidence report.

### Task 5: 完整结果附件交付与整体验收

Files: workbench result transport and ilink file sender interfaces, corresponding fake-server tests.

- [ ] Read existing SHA256 artifact snapshot via `service.artifact`, never a model path. Bind explicit phone request to task/artifact/version and receipt before upload/send.
- [ ] Test content mutation/foreign task rejected, repeated message reuses original artifact, account/source constraints, unknown upload/send ack remains uncertain. Implement phone command only with this path in place.
- [ ] Reuse ordinary file presentation but give workbench files their own provenance and delivery receipts. No real outbound file tests.
- [ ] Run complete phone/desktop workflow evidence; document remaining full-goal gaps (additional executors, independent workspaces, cross-device execution) without treating this slice as overall completion.
