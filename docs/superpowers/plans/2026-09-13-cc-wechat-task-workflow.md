# 微信共用工作任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 从微信创建已有项目中的任务，接收属于同一后台任务的可靠待处理与完成通知。

**Architecture:** 持久创建回执在调度前与任务一同提交；只读项目目录给微信稳定选择。独立 task outbox 保存原始 run/request 与投递状态，daemon 通过明确 source 的严格发送通道投递。

**Tech Stack:** Bun、TypeScript、SQLite、Vitest；现有 WorkbenchService 与 ilink 通道。

**Spec:** `docs/superpowers/specs/2026-09-13-cc-wechat-task-workflow.md`

## Global Constraints

- 仅 `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit`、`codex/cc-workbench-v1`；本地提交，不推送/合并。
- 本批使用合成执行者和 loopback HTTP，不调用真实微信、真实模型 API 或用户 MCP，不重启真实 bot；不改冻结角色资产，不跑 build-cc-asset-kit.mjs。整体目标另已允许用 agy/Cursor CLI 模型做验收，本批无需使用。
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

- [x] Tests create duplicate receipt with same identity, conflict on changed command/account/owner, SQLite reopen, rollback, and FK enforcement. Catalog tests canonical symlink dedup, same basename distinct IDs, replacement invalidates ID, owner changes ID, missing directory excluded, only available provider selected.
- [x] Run the focused new tests and record the initial failure.
- [x] Implement the two focused modules and append-only migration; expose `store.creationReceipts` and `store.ownedProjects` without changing old assertions.
- [x] Run both suites plus `store.test.ts`; include owned files in the reviewed Tasks 1–4 integration commit.

### Task 2: 共用服务创建与微信命令

Files: `service.ts`, `wechat-control.ts`, new `wechat-create.test.ts`, `wire-workbench.ts`.

Interfaces:
```ts
// Options.registeredProjects?:()=>Array<{alias:string,path:string}>
// service.projects(): ProjectCatalogEntry[]
// service.createWechat({ownerChatId,accountId,requestId,commandHash,projectId,providerId?,text}): CreationReceipt
// actions receives both methods; parser passes untouched original command hash.
```

- [x] Test real service/SQLite with a fake provider: phone creates one task shared with service.list/detail; duplicate before/after finish/restart gives original reply; changed payload does not execute; owner rebind, invalid path/project/provider, and injected receipt-write failure create no task or running resource.
- [x] Refactor start acceptance so callback persists receipt in the task/input transaction and activation follows its commit. `createWechat` looks up receipt before checking current project/provider defaults.
- [x] Add explicit `任务 项目`, `任务 新建 p-… [用 Claude/Codex] <要求>` grammar, no global selected task. List help explains creating in known projects. Register source paths through existing project registry.
- [x] Run `wechat-create.test.ts`, `wechat-control.test.ts`, `service.test.ts`, and workbench API tests. Include in the reviewed Tasks 1–4 integration commit.

### Task 3: 订阅、通知存储及 worker

Files: new `wechat-notifications.ts`, `wechat-notifications.test.ts`; append migration v56; service/event hooks and command/UI metadata integrated by root.

Interfaces:
```ts
type NoticeStatus='pending'|'sending'|'accepted'|'unknown'|'suppressed';
type NoticeKind='permission'|'question'|'completed'|'failed'|'interrupted'|'cancelled';
// Subscription: taskId, ownerChatId, accountId, enabled, generation, createdAt, updatedAt.
// Notice: id, taskId, runId, ownerChatId, accountId, subscriptionGeneration, kind, requestId|null,
// text, status, createdAt, updatedAt, reason|null.
// store.watch(taskId, ownerChatId, accountId, enabled), subscription(taskId)
// enqueue(input): Notice; identity derived from task/run/kind/request/generation, content never updated.
// stage(input): Intent; persist atomically with terminal status, then materializeIntents() after commit.
// worker opts: store, eligible(notice):boolean, send(notice,signal):Promise<{status:'accepted'|'deferred'|'unknown'|'blocked';reason?:string}>
// worker wake():Promise<void>, close():Promise<void>; recover stale sending -> unknown at startup.
```

- [x] Test duplicate enqueue, immutable content, claimed-before-send, no overlapping worker sends, muted/wrong-owner/generation suppression, stale permission suppression, definitive unavailable context remains pending, changed account is suppressed, ambiguous and abandoned sending become unknown, restart and send-then-store-failure no blind replay. Muting suppresses old pending intents too; reenable gives live requests fresh identity. Ordinary wake storage failures retry untouched work with bounded backoff.
- [x] Implement standalone persistence/worker, export schema initializer for migration. Transport callback owns context checking; worker owns state machine and bounded drain.
- [x] Hook service permission/question requests and final durable run status; phone-created tasks subscribe atomically. Existing tasks accept explicit reminders on/off with command receipts. Terminal status and frozen notification intent share a transaction; failure holds queued supplementary inputs. Detail returns current subscription and recent notice states. Do not equate retained idle with completed.
- [x] Verify two concurrent tasks and old run notice after new run. Include in the reviewed Tasks 1–4 integration commit.

### Task 4: 严格通道、daemon 连接及结果阅读

Files: new `src/lib/ilink-workbench.ts`, `src/daemon/ilink-glue.ts`, daemon wiring/main and tests; `wechat-control.ts` result paging and tests.

- [x] First test strict acknowledged response vs malformed/status-less response, timeout, definitive closed messaging window; use fake HTTP only. Assert new path marks outbound source workbench and no account rerouting.
- [x] Add dedicated acknowledged workbench send using persisted notice ID; avoid legacy retries after ambiguous delivery. Wire worker start/stop and context wake through existing daemon lifecycle without restarting live daemon.
- [x] Add fixed event-ID based result pages so continuation does not change page two. Keep explicit distinction between complete text availability and binary artifact delivery; implement verified artifact delivery as its own following task if it cannot share the bounded acknowledged transport safely.
- [x] Integration test inbound command → one shared service task → attention → phone resolution → completed notice; verify source exclusion from memory, duplicate inbound, and desktop continuation of same task.
- [x] Run task suites, relevant inbound/ilink/memory suites, whole-repository typecheck; broad suite preserves any known unrelated baseline failures as failures. Independent review and local commits with exact evidence report.

### Task 5: 完整结果附件交付与整体验收

Only an explicit owner command sends a binary artifact:

`任务 <taskId> 文件 <artifactId>`

No completion event, notification, status query, model output, or newly collected artifact may enqueue a binary delivery implicitly. Tests may use fake Claude/Codex/Cursor/agy providers, but this task does not need a real model or CLI process and never sends to real WeChat.

Files:

- Create `src/core/workbench/artifact-deliveries.ts`, `artifact-deliveries.test.ts` — immutable request receipt and bounded explicit-delivery state machine.
- Modify `src/core/workbench/wechat-control.ts`; create `wechat-artifact-delivery.test.ts` — exact command parsing, owner/account binding, and duplicate behavior.
- Modify `src/core/workbench/service.ts` — load the existing immutable artifact through `service.artifact(taskId,artifactId)` and inject the delivery callbacks; never accept a model-provided path.
- Modify `src/daemon/media.ts`; create `media-workbench.test.ts` — byte-based CDN preparation with no chat side effect.
- Modify `src/lib/ilink-workbench.ts`, `ilink-workbench.test.ts` — one-attempt acknowledged media-item send sharing the strict text response classifier.
- Modify `src/daemon/ilink-glue.ts`, `ilink-glue.workbench.test.ts` — exact persisted account/context checks, byte upload, final send, and accepted `source=workbench` file audit.
- Modify `src/daemon/inbound/mw-workbench.ts`, `pipeline.integration.test.ts` — consume an already-delivered structured result without sending a second text message.
- Create `src/daemon/bootstrap/wire-workbench-artifacts.ts` and its test; modify `src/daemon/main.ts` — compose the explicit worker and close it with the workbench lifecycle.
- Append the next migration in `src/lib/db.ts` and its fingerprint in `src/lib/migration-order.test.ts`; do not alter released migrations.

Interfaces:

```ts
type ArtifactDeliveryStatus =
  | 'prepared' | 'uploading' | 'uploaded' | 'sending'
  | 'accepted' | 'unknown' | 'blocked'

interface ArtifactDeliveryReceipt {
  id:string; commandHash:string; taskId:string; artifactId:string;
  artifactSha256:string; name:string; mime:string; size:number;
  ownerChatId:string; accountId:string; status:ArtifactDeliveryStatus;
  mediaItemJson:string|null; reason:string|null;
  createdAt:number; updatedAt:number;
}

makeArtifactDeliveryStore(db): {
  get(id:string): ArtifactDeliveryReceipt|null;
  reserve(input:Omit<ArtifactDeliveryReceipt,
    'status'|'mediaItemJson'|'reason'|'createdAt'|'updatedAt'>):
    {receipt:ArtifactDeliveryReceipt;created:boolean};
  claimUpload(id:string):ArtifactDeliveryReceipt|null;
  uploaded(id:string,item:WorkbenchMediaItem):ArtifactDeliveryReceipt;
  retryUpload(id:string,reason:string):ArtifactDeliveryReceipt; // uploading -> prepared; upload alone is not visible
  claimSend(id:string):ArtifactDeliveryReceipt|null;
  complete(id:string,status:'accepted'|'unknown'|'blocked',reason?:string):ArtifactDeliveryReceipt;
  deferSend(id:string,reason:string):ArtifactDeliveryReceipt; // sending -> uploaded only after definitive non-acceptance
  recover():{uploadsReset:number;sendsUnknown:number}; // uploading -> prepared; sending -> unknown
}

type WorkbenchMediaItem =
  | {type:2;image_item:NonNullable<MessageItem['image_item']>}
  | {type:4;file_item:NonNullable<MessageItem['file_item']>}
  | {type:5;video_item:NonNullable<MessageItem['video_item']>};
type ArtifactTransportOutcome =
  {status:'accepted'} |
  {status:'deferred'|'unknown'|'blocked';reason:string};

makeArtifactDeliveryWorker({store,load,upload,send}): {
  deliver(id:string,signal?:AbortSignal):Promise<ArtifactDeliveryReceipt>;
  close():Promise<void>;
}

// load calls service.artifact and must match every receipt metadata field.
load(receipt):Promise<{
  name:string;mime:string;size:number;sha256:string;contentBase64:string;
}>;

upload(receipt,payload,signal):Promise<
  {status:'uploaded';item:WorkbenchMediaItem} |
  {status:'retryable'|'blocked';reason:string}
>;

send(receipt,item,signal):Promise<ArtifactTransportOutcome>;

buildMediaItemFromArtifact(input:{
  bytes:Uint8Array;name:string;mime:string;toUserId:string;
  baseUrl:string;token:string;signal?:AbortSignal;
}):Promise<WorkbenchMediaItem>;

sendIlinkWorkbenchItem(input:{
  baseUrl:string;token:string;clientId:string;ownerChatId:string;
  contextToken:string;item:WorkbenchMediaItem;
  signal?:AbortSignal;timeoutMs?:number;
}):Promise<ArtifactTransportOutcome>;

type WechatWorkbenchReply = string | {kind:'artifact_delivered';receiptId:string};
```

The worker owns the state transitions but scans no artifact table and has no automatic artifact-enqueue hook. `deliver(id)` is called only by the exact parsed command. An exact duplicate uses the existing receipt: `accepted` is consumed without uploading or sending again; `unknown` reports uncertainty without replay; `prepared`/recovered `uploading` may upload again because CDN preparation alone posts no visible message; `uploaded` reuses its persisted media item. A definitively deferred final send remains `uploaded` and may run again only when the owner repeats the same explicit command. There is no timer-based binary retry.

The adapter must verify `chatAccountId(ownerChatId)===accountId`, account presence, and the current chat context before either upload or send; it never falls back to another account. The final send uses receipt `id` as `client_id`, contains exactly one media item, and makes one `sendmessage` attempt. Set `sending` durably before dispatch. Timeout, abort, connection loss, malformed/status-less/contradictory response, or restart from `sending` becomes `unknown`; never retry it. Only explicit numeric zero becomes `accepted`. Accepted audit-storage failure does not downgrade delivery.

`buildMediaItemFromArtifact` consumes the already verified bytes returned by `service.artifact`; use `basename(name) || 'file'` as the file item's single-segment display name and use MIME/name only for image/video/file presentation. Validate `mediaItemJson` back into the exact `WorkbenchMediaItem` union before sending. The workbench 8 MiB artifact cap is below the ordinary 50 MiB outbound cap. `getuploadurl` and the raw CDN upload have no visible chat side effect. Because the existing Bun CDN upload deliberately cannot attach an abort signal without corrupting encoding, cancellation is logical: race the raw upload against the worker signal/deadline, attach a terminal rejection handler, ignore any late result, and never proceed to final send. A later explicit request may upload again safely.

- [x] **Receipt/store red-green:** first test exact duplicate vs changed command/task/artifact/hash/owner/account conflicts, SQLite reopen, transaction rollback, artifact/task foreign key, `uploading -> prepared`, and `sending -> unknown`; run `bun run test src/core/workbench/artifact-deliveries.test.ts` and record the missing-module failure before implementing the append-only schema/store.
- [x] **Worker red-green:** test persisted media reuse, crash after CDN success but before `uploaded` persistence (safe re-upload), restart from `uploaded`, no overlap, close/cancel before final send, definitive deferred remaining retryable only through a repeated explicit command, and ambiguous send becoming terminal `unknown`; implement the bounded `deliver(id)` state machine with no timer or automatic scan.
- [x] **Immutable service/parser red-green:** with real SQLite and fake transport, create an artifact snapshot and verify the exact owner command sends its bytes once; mutation, missing/foreign artifact, wrong owner/sender/account, malformed reserved `文件`, page/status commands, and changed duplicate payload never upload or dispatch. Reopen the DB and verify exact replay returns the original receipt outcome and never switches to a newer artifact version. An accepted structured result must be consumed by `mw-workbench` without its ordinary text `sendMessage`; errors remain ordinary bounded text replies.
- [x] **Upload seam red-green:** fake `getuploadurl` and CDN HTTP only. Assert byte-for-byte encryption input, original name/size/media type, 8 MiB acceptance, over-limit rejection before network, retryable upload failures never call `sendmessage`, logical cancellation ignores a late upload and never invokes final send, and upload retry alone cannot produce a visible chat message.
- [x] **Strict final-send red-green:** extend the fake-server strict helper tests for explicit zero, closed window, account unavailable, HTTP error, timeout/abort, malformed/status-less/contradictory JSON, and one request only. Assert stable receipt `client_id`, exact account and context, one media item, no account rerouting, no legacy `sendFile`/`ilinkSendMessage` retry path, and accepted file audit provenance `source=workbench`.
- [x] **Composition and acceptance:** fake inbound command -> one durable receipt -> verified snapshot upload -> one strict final media send; cover restart at every phase and two concurrent explicit requests without cross-task/account/artifact mixing. Run the new suites plus `wechat-control.test.ts`, `service.test.ts`, `pipeline.integration.test.ts`, `ilink-glue.test.ts`, `ilink-glue.workbench.test.ts`, `db.test.ts`, `migration-order.test.ts`, and `bun run typecheck`. Record full-text paging as complete and binary delivery as complete only when this production path passes; additional executors, independent workspaces, and cross-device takeover remain overall-goal gaps.
