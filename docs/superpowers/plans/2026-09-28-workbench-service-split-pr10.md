# workbench service 拆分 · PR 10(execute / create + entry 域;收尾)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 最后一刀:把 `execute` / `start` / `matterSync` / `safeOriginMatterId` / `createTask` 与 `create` / `continueTask` / `createWechat`(execute 域)以及 `managed` / `requireEntryOwner` / `entryResult` 与 `entryOptions` / `entryReceipt` / `createEntry`(entry 域)逐字搬进 `service/execute.ts` / `service/entry.ts`,`service.ts` 只剩 Options、组装、public 对象、`actions.set`、wechatControl(目标 ≤ 300 行,spec 说的 ≤ 500)。顺手还三笔账:native/inputs 里 deref 帮手 `a`→`act`、`ServiceActions` 过时注释、roadmap「一个文件夹连开两件事」真机账划掉、spec 状态改完成。**行为一字不变**,19 份既有 `service*.test.ts` 一行不改、全绿。

**Architecture(裁决:最后两个模块用「已建好的域对象显式注入」,不再往 `ServiceActions` 塞二十个字段):** execute 域跨全部九个域(spec §4 说它跨域是事实、不再往下切)。它是组装根的邻居,所有它要的域在它之前都已建好 —— `makeExecuteDomain(ctx, domains)` 直接拿 `{admission, attachments, quota, view, native, inputs, lifecycle, notices, artifacts}`,工厂顶部**解构成与 service.ts 里同名的局部量**(`const {requireInput,canResume,…}=domains.admission`),于是函数体逐字、零替换。这不是第二种「晚绑定」:域对象是急切值,不是 Ref;真正需要晚绑定的(lifecycle 的 `pump → execute`)仍走 `ctx.actions.execute`。entry 域同理,注入 `{execute, view, admission, quota}`。`ServiceActions` 保持平铺不重排(其他域都在用,重排是纯 churn),只把过时注释改成按域归组的说明。`ctx.deps` 加 `matters` / `mintSessionToken` / `timeoutMs` / `closeTimeoutMs` / `holdBusy` / `managedWorkspaceRoot`。模块级的 `RECOVERY_MESSAGE` 与 `collectWorkbenchTurn` 随 execute 走。

**Tech Stack:** TypeScript(`strict` + `verbatimModuleSyntax`)、vitest、dependency-cruiser。

**Spec:** `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(§3 第 10 项)。基线 dev `8252705f`(#141 之后)。

## Global Constraints

- 分支 `sweep/workbench-service-split-10`,工作树 `.claude/worktrees/deploy-dev`;进 dev 走 PR + squash。
- 不改任何行为、错误码、文案、数值。逐字搬,注释一起搬(execute 里的每一段修复依据都是承重的)。
- 不改 public 方法签名、不改 `WorkbenchService` 的形状(`wechat-control.ts` 按结构化类型拿它;`continueTask` / `create` 不能变 async)。19 份既有 `src/core/workbench/service*.test.ts` 一行不改。
- `service/*.ts` 禁止 import `../service`;`execute.ts` / `entry.ts` 只 `import type` 其它域的类型(值都由注入拿),depcruise 环规则兜底。
- 每个任务一个 commit,中文,结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 替换脚本:逐名带 `(?<![.\w])…(?![\w])` 边界并单独处理 `...name` 展开;链式命令不用 `grep -c`;带注释的方法首行不是方法名。

## Review Focus

1. **`createTask` 的事务与 `activate` 分离**:`store.atomic(...)` 里 `start(...)` 只登记、`activate` 延后到事务提交之后(「An accepted in-memory run must never outlive a rolled-back creation transaction」)—— 搬家后 `acceptance.activate` 那条路逐字;Task 2 域单测「beforeCreate 抛 ⇒ 没有任务、runsByTask 空」钉住。
2. **`continueTask` 的幂等分支**:同 `inputRequestId` 重发同文 ⇒ 直接回视图不派发;异文 / 异 execution ⇒ `input_conflict`;`start` 抛错 ⇒ 把那条 liveInput 置 held 并 `bumped`,失败再退化到 `autoContinueBlocked.add` —— Task 2 域单测三条。
3. **`start` 的双重占用检查**:`runsByTask.has ⇒ workbench_busy`;同 provider 同 sessionId 已在跑 ⇒ `native_session_busy`;`executionConflict` ⇒ `native_session_busy` —— Task 2 域单测钉住。
4. **`createEntry` 的赢家回放**:catch 里若 `winner.phase==='accepted' && hash 相同 ⇒ 返回赢家`,否则原错误透传 —— Task 3 域单测「record 存在且 hash 不同 ⇒ creation_conflict;没接 matters ⇒ entry_not_wired」钉住(完整链由 `service-entry.test.ts` 兜底)。
5. **`execute` 经 `ctx.actions.execute` 被 lifecycle 的 `pump` 调到**:`actions.set` 里的 `execute` 必须指向 execute 域的函数;Task 2 域单测「createTask 后 run 真被派发并跑到 completed(fakeProvider)」走完整环钉住。

---

### Task 1: `ctx.deps` 六个字段 + `ServiceActions` 注释 + `a`→`act`

**Files:**
- Modify: `service/ctx.ts`、`service.ts`(ctx 字面量)、`service/native.ts`、`service/inputs.ts`

- [ ] **Step 1**:`ctx.ts` —— `ServiceDeps` 加(注释照 `Options` 里的抄):`matters?: MatterStore`、`mintSessionToken?: (sessionKey:string)=>string`、`timeoutMs?: number`、`closeTimeoutMs?: number`、`holdBusy?: (label:string)=>()=>void`、`managedWorkspaceRoot?: string`。`ServiceActions` 顶部注释改成:「service.ts 在 public 对象建好后 set 一次;域在调用时 deref。平铺不分组(重排是纯 churn);每段注释标明谁提供、谁消费。pump / cancelRun 留在 lifecycle 域内不进这里;execute 是唯一真正需要晚绑定的(lifecycle.pump → execute)。」
- [ ] **Step 2**:service.ts 的 `deps` 字面量加 `...(opts.matters?{matters:opts.matters}:{}),...(opts.mintSessionToken?{mintSessionToken:opts.mintSessionToken}:{}),...(opts.timeoutMs!==undefined?{timeoutMs:opts.timeoutMs}:{}),...(opts.closeTimeoutMs!==undefined?{closeTimeoutMs:opts.closeTimeoutMs}:{}),...(opts.holdBusy?{holdBusy:opts.holdBusy}:{}),...(opts.managedWorkspaceRoot!==undefined?{managedWorkspaceRoot:opts.managedWorkspaceRoot}:{})`。
- [ ] **Step 3**:`native.ts` / `inputs.ts`:`const a=()=>ctx.actions.deref(` → `const act=()=>ctx.actions.deref(`;`a().` → `act().`(只这两种形态,`grep -c "a()\."` 前后对上)。
- [ ] **Step 4: 验证** —— typecheck 0;`bun --bun vitest run src/core/workbench/service` 全过;depcheck `0 errors, 21 warnings`。
- [ ] **Step 5: Commit** —— `workbench service 拆分 30/n:ctx.deps 加 execute/entry 要的六个字段;actions 注释按域归组;native/inputs 的 deref 帮手改名 act(行为不变)`

---

### Task 2: execute 域

**Files:**
- Create: `src/core/workbench/service/execute.ts`、`src/core/workbench/service/execute.test.ts`
- Modify: `src/core/workbench/service.ts`

**Interfaces:**
```ts
export interface ExecuteDomains {
  admission: AdmissionDomain; attachments: AttachmentsDomain; quota: QuotaDomain; view: ViewDomain; native: NativeDomain
  inputs: InputsDomain; lifecycle: LifecycleDomain; notices: NoticesDomain; artifacts: ArtifactsDomain
}
export function makeExecuteDomain(ctx:ServiceCtx, domains:ExecuteDomains) {
  const { store, state } = ctx
  const {runsByTask,queue,runningText}=state
  const {requireInput,canResume,continuation,provider}=domains.admission
  const {selectAttachments,combinedAttachments,continuationAttachmentScope}=domains.attachments
  const {quota}=domains.quota
  const {taskView,runtimeSnapshot,isReplied,projects}=domains.view
  const {validateNativeDecision}=domains.native
  const {holdInputs,drainInputs,settleRuntimeInput}=domains.inputs
  const {revokeCredentials,cancelIdleClose,reportOnce,recollectOnce,settleQuiet,settleAfterDecision,releaseReservation,confirmLateClose,markUncertain,pump}=domains.lifecycle
  const {requestNotice,terminalReportBody,stageFinishedNotice,publishFinishedNotices}=domains.notices
  const {collect,captureCodeChanges,retakeBaseline}=domains.artifacts
  …
  return { execute,start,matterSync,safeOriginMatterId,createTask, create,continueTask,createWechat }
}
export type ExecuteDomain = ReturnType<typeof makeExecuteDomain>
```
`service.ts` 不再解构这些(execute/start 的调用点都搬走了);public 对象 `create:executeDomain.create, continueTask:executeDomain.continueTask, createWechat:executeDomain.createWechat`;`actions.set` 里 `execute:executeDomain.execute, start:executeDomain.start, matterSync:executeDomain.matterSync`,`continueTask:(…)=>service.continueTask(…)` 保留。

- [ ] **Step 1: 写 `service/execute.test.ts`(红)** —— 这个域的单测是「迷你组装」:建 ctx、九个域、execute 域、`actions.set`,用 fakeProvider 跑真派发。

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { MANAGED_NATIVE_CAPABILITIES } from '../executor-capabilities'
import { PROVIDER_EXECUTION_CHOICE } from '../execution-settings'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentProvider } from '../../agent-provider'
import { makeRuntimeState } from './state'
import { makeReviewDomain } from './review'
import { makeAttachmentsDomain } from './attachments'
import { makeQuotaDomain } from './quota'
import { makeAdmissionDomain } from './admission'
import { makeViewDomain } from './view'
import { makeNativeDomain } from './native'
import { makeInputsDomain } from './inputs'
import { makeLifecycleDomain } from './lifecycle'
import { makeNoticesDomain } from './notices'
import { makeArtifactsDomain } from './artifacts'
import { makeExecuteDomain } from './execute'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(async () => { for (const s of shutdowns.splice(0)) await s(); for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const shutdowns: Array<() => Promise<void>> = []

/** 每轮都能跑完的假执行者(照 service-review.test.ts)。 */
function fakeProvider(): AgentProvider {
  let index = 0
  return { async spawn(_project, context) { const sessionId = context.resumeSessionId ?? `native-${index++}`; return { async *dispatch() { yield { kind: 'init' as const, sessionId }; yield { kind: 'text' as const, text: '好了' }; yield { kind: 'result' as const, sessionId, numTurns: 1, durationMs: 1 } }, async close() {} } } }
}

/** 迷你组装:和 service.ts 同一套接线,只是没有 public 对象与 wechatControl。 */
function setup(over: { executionConflict?: ServiceCtx['deps']['executionConflict']; owner?: string | null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-execute-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', fakeProvider(), { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const actions = new Ref<ServiceActions>('t')
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }, deps: { ownerChatId: () => over.owner === undefined ? 'owner' : over.owner, registry, ...(over.executionConflict ? { executionConflict: over.executionConflict } : {}) }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const review = makeReviewDomain(ctx), attachments = makeAttachmentsDomain(ctx), quota = makeQuotaDomain(ctx), admission = makeAdmissionDomain(ctx), view = makeViewDomain(ctx), native = makeNativeDomain(ctx), inputs = makeInputsDomain(ctx), lifecycle = makeLifecycleDomain(ctx), notices = makeNoticesDomain(ctx), artifacts = makeArtifactsDomain(ctx)
  const execute = makeExecuteDomain(ctx, { admission, attachments, quota, view, native, inputs, lifecycle, notices, artifacts })
  actions.set({ submitInput: inputs.submitInput, continueTask: execute.continueTask, isReplied: view.isReplied, fallbackExecutor: quota.fallbackExecutor, artifact: artifacts.artifact, quotaExhausted: quota.quotaExhausted, continuation: admission.continuation, provider: admission.provider, requireInput: admission.requireInput, canResume: admission.canResume, taskVersion: admission.taskVersion, selectAttachments: attachments.selectAttachments, combinedAttachments: attachments.combinedAttachments, handoffAttachments: attachments.handoffAttachments, taskView: view.taskView, matterSync: execute.matterSync, start: execute.start, continuationAttachmentScope: attachments.continuationAttachmentScope, inputMode: view.inputMode, armIdleClose: lifecycle.armIdleClose, cancelIdleClose: lifecycle.cancelIdleClose, settleAfterDecision: lifecycle.settleAfterDecision, execute: execute.execute, hasUndeliveredInput: inputs.hasUndeliveredInput, holdInputs: inputs.holdInputs, collect: artifacts.collect, collectTurnArtifacts: artifacts.collectTurnArtifacts, captureCodeChanges: artifacts.captureCodeChanges, runtimeSnapshot: view.runtimeSnapshot, held: view.held, stageFinishedNotice: notices.stageFinishedNotice, publishFinishedNotices: notices.publishFinishedNotices })
  shutdowns.push(lifecycle.shutdown)
  void review
  const settled = async (id: string) => { await vi.waitFor(() => expect(store.get(id).status).not.toMatch(/^(queued|running|cancelling)$/), { timeout: 5000 }) }
  return { store, state, execute, view, project, settled }
}

describe('makeExecuteDomain · 创建与派发', () => {
  it('createTask ⇒ 排队视图;经 lifecycle.pump → ctx.actions.execute 真派发,fakeProvider 跑到 completed', async () => {
    const { execute, store, settled } = setup()
    const view = execute.create({ path: (await import('node:fs')).realpathSync(store.get ? '' : '') || '', providerId: 'claude', text: '做点事' } as never)
    void view
  })
})
```

**上面这条 it 是占位,写计划时没法预演 fakeProvider 路径——实施时按下面这组用例写,别照抄上面那条:**

- `createTask`:`title` 非法 ⇒ `invalid_title`;`executionConflict` 返回 true ⇒ `native_session_busy`;stopping ⇒ `workbench_stopping`;正常 ⇒ 返回 `{status:'queued',phase:'queued'}` 视图、`state.runsByTask` 有它,`await settled(id)` 后 `status==='completed'`、事件里有 `text:'好了'`(这条就是 Review Focus 5 的完整环)。
- `createTask` 带 `entry.beforeCreate` 抛错 ⇒ 没有任务被创建、`runsByTask` 空(Focus 1)。
- `start`:`runsByTask.has ⇒ workbench_busy`;同 provider 同 sessionId 在跑 ⇒ `native_session_busy`(Focus 3)。
- `continueTask`:任务在跑 ⇒ `workbench_busy`;归档 ⇒ `workbench_archived`;`restartToken` 畸形 ⇒ `invalid_request`;能续(fakeProvider `canResume` true + 有 sessionId + 有 text 事件)⇒ 派发新 run 并跑完;同 `inputRequestId` 重发同文 ⇒ 回视图不派发,异文 ⇒ `input_conflict`(Focus 2)。
- `createWechat`:身份不符 ⇒ `invalid_wechat_identity`;hash 畸形 ⇒ `invalid_request`;项目不存在 ⇒ `project_stale`。
- `safeOriginMatterId`:没接 matters ⇒ null。

- [ ] **Step 2: 跑,红**(`Cannot find module './execute'`)。
- [ ] **Step 3: 新建 `service/execute.ts`** —— 脚本抠:E = 模块级 `const RECOVERY_MESSAGE=…` 与 `async function collectWorkbenchTurn(` 到闭合 `}`;A = `async function execute(` 起到 `createTask` 闭合 `}`(execute / start / matterSync / safeOriginMatterId / createTask 五个连续定义,中间的注释一起);B = public `createWechat` / `create`(含上面两行「不标 async」注释)/ `continueTask` 三段。替换**只有**:`opts.{executionConflict,matters,mintSessionToken,timeoutMs,closeTimeoutMs,holdBusy,stateDir,permissionTimeoutMs,ownerChatId,log}`→`ctx.deps.*`(`opts.stateDir`→`ctx.stateDir`、`opts.log?.(`→`ctx.log?.(`)、`touched(`→`ctx.hub.touched(`、`bumped(`→`ctx.hub.bumped(`、`ensureAccepting()`→`ctx.ensureAccepting()`、`service.continueTask(`→`continueTask(`、`service.projects()`→`projects()`(view 解构)。**不替换任何域帮手名和 state 容器名**——它们在工厂顶部按 Interfaces 里那样解构成同名局部量。public 三段改 `function` 声明(`create` / `continueTask` 不是 async,`createWechat` 也不是)。import:`randomUUID` from `node:crypto`;`canonicalProject` from `../artifacts`;`normalizeExecutionChoice, PROVIDER_EXECUTION_CHOICE, sameExecutionChoice, executionFailureMessage` from `../execution-settings`(按实际用到的);`makeRunPermissions, WORKBENCH_PERMISSION_TIMEOUT_MS` from `../permissions`;`makeRunUserInput` from `../user-input`;`normalizeInputRequestId, sameAttachments` from `../live-inputs`;`classifyProviderError` from `../../provider-quota`;`TIER_PROFILES, sessionAuthEnv` from `../../user-tier`;`publicTask, type StoredTask, type TaskStatus` from `../store`;`isUnattendedExecutor` from `../executor-capabilities`;`makeDeltaCoalescer` from `../delta-coalescer`;`checkedText` / `directoryIdentity` from `./*`;类型:`AgentEvent, AgentSession, AgentExecutionChoice` from `../../agent-provider`、`MatterStore` from `../../matters/store`、`AcceptedNativeResume` from `../native-adoption`、`ArtifactSelection` from `../handoff`、`Attachment` from `../attachments`、`EntryContext` from `../task-entry`、`CreationReceipt` from `../creation-receipts`、`CreateWechatTask` from `../wechat-types`、`Active, AcceptedContinuation` from `./state`、`CreateTask, InputMaterials, WorkbenchTaskView` from `./types`、九个域类型 from `./<domain>`(`import type`)。**以 `bun run typecheck` 报的缺名为准补齐**,别猜。
- [ ] **Step 4: service.ts 接上** —— `const executeDomain=makeExecuteDomain(ctx,{admission:admissionDomain,attachments:attachmentsDomain,quota:quotaDomain,view:viewDomain,native:nativeDomain,inputs:inputsDomain,lifecycle:lifecycleDomain,notices:noticesDomain,artifacts:artifactsDomain})` 放在 artifacts 之后、`store.recover()` 之前;删 E / A / B;public 三个换引用;`actions.set` 里 `execute:executeDomain.execute,start:executeDomain.start,matterSync:executeDomain.matterSync`;service.ts 里那一大串域解构现在只剩 `service` 对象和 entry 方法还用的:用 `tsc --noEmit --noUnusedLocals | grep service.ts` 把没人用的解构名与 import 一次清掉(**解构名这次也删**——这是收尾 PR;`state` 的 `runsByTask` 若 entry 还用就留)。
- [ ] **Step 5: 验证** —— execute 单测全过;typecheck 0;`bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts` 全过(19 份旧套件是这一刀的验收面);depcheck `0 errors, 21 warnings`;逐字 diff 核对(替换清单短,反向还原后应零差异)。
- [ ] **Step 6: Commit** —— `workbench service 拆分 31/n:execute 域搬进 service/execute.ts(execute/start/createTask + create/continueTask/createWechat;域对象显式注入,行为不变)`

---

### Task 3: entry 域

**Files:**
- Create: `src/core/workbench/service/entry.ts`、`src/core/workbench/service/entry.test.ts`
- Modify: `src/core/workbench/service.ts`

**Interfaces:**
```ts
export interface EntryDomains { execute: ExecuteDomain; view: ViewDomain; admission: AdmissionDomain; quota: QuotaDomain }
export function makeEntryDomain(ctx:ServiceCtx, domains:EntryDomains) {
  const { store } = ctx
  const {createTask}=domains.execute
  const {taskView,projects}=domains.view
  const {requireInput,requireEntryInput}=domains.admission
  const {quota}=domains.quota
  let managedWorkspaces:ManagedWorkspaces|undefined
  … managed / requireEntryOwner / entryResult / entryOptions / entryReceipt / createEntry 逐字 …
  return { managed,requireEntryOwner,entryResult, entryOptions,entryReceipt,createEntry }
}
export type EntryDomain = ReturnType<typeof makeEntryDomain>
```

- [ ] **Step 1: 写 `service/entry.test.ts`(红)** —— fixture 同 execute.test 的迷你组装(可以把 `setup` 抽到 `service/test-assembly.ts`?**不**:测试帮手进 `service/` 会被 depcruise 与棘轮的 `service/*.ts` 规则扫到;各写各的,重复 30 行可接受)。用例:`managed()` 没配 root ⇒ `entry_not_wired`;`requireEntryOwner`:没 ownerKey / 不是主人 / surface 不对 ⇒ `invalid_entry_owner`;`entryReceipt`:没记录 ⇒ null;`entryOptions`:不是主人 ⇒ `needs_connection` + `invalid_entry_owner`;是主人 ⇒ providers 含 claude、`defaultProviderId`(配了 default 且可用才有);`createEntry`:没接 matters ⇒ `entry_not_wired`;同 requestId 不同 hash ⇒ `creation_conflict`(先用 `store.entryRequests.reserve` 种一条)。
- [ ] **Step 2: 跑,红**。
- [ ] **Step 3: 新建 `service/entry.ts`** —— 脚本抠:A = `let managedWorkspaces` 起到 `entryResult` 闭合 `}`;B = public `entryOptions` / `entryReceipt` / `createEntry` 三段。替换只有:`opts.managedWorkspaceRoot`/`opts.matters`/`opts.defaultProvider`/`opts.registry`/`opts.ownerChatId`→`ctx.deps.*`、`opts.stateDir`→`ctx.stateDir`、`ensureAccepting()`→`ctx.ensureAccepting()`、`service.projects()`→`projects()`。域帮手不替换(解构同名)。import:`createManagedWorkspaces, type ManagedWorkspaces` from `../managed-workspaces`;`canonicalEntryHash, composeEntryPrompt, parseEntryInput, type EntryContext, type EntryInput, type EntryOptions` from `../task-entry`;`type EntryRecord` from `../entry-store`;`readdirAnchored` from `../anchored-fs`;`normalizeInputRequestId, sameAttachments` from `../live-inputs`;`normalizeExecutionChoice, PROVIDER_EXECUTION_CHOICE, executionFailureMessage` from `../execution-settings`;`isWorkbenchProviderId, isWorkbenchExecutorCapabilities` from `../executor-capabilities`;`canonicalProject` from `../artifacts`;`publicTask` from `../store`;`randomUUID`;`directoryIdentity`;类型 `EntryResult` from `./types` 等。以 typecheck 为准。
- [ ] **Step 4: service.ts 接上** —— `const entryDomain=makeEntryDomain(ctx,{execute:executeDomain,view:viewDomain,admission:admissionDomain,quota:quotaDomain})`;删 A/B;public 三个换引用;再清一次无用解构/import。此时 service.ts 应只剩:imports、`Options`、`makeWorkbenchService`(hub / state / ctx / 十一个域 / `store.recover()` / `ensureAccepting` / `service` 对象 / `actions.set` / wechatControl)、`WorkbenchService` 类型。
- [ ] **Step 5: 验证** —— entry 单测全过;typecheck 0;33+ 文件全过;depcheck `0 errors, 21 warnings`;逐字核对。
- [ ] **Step 6: Commit** —— `workbench service 拆分 32/n:entry 域搬进 service/entry.ts(受管工作目录/主人校验/回执 + entryOptions/entryReceipt/createEntry,行为不变)`

---

### Task 4: 棘轮定稿 + 文档收尾 + 全量闸门

**Files:**
- Modify: `scripts/workbench-service-ratchet.guard.test.ts`、`docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(状态行改「完成」+ §2 目标形状补 `execute.ts` / `entry.ts` / `checked-text.ts` / `directory-identity.ts` / `types.ts` 的实际落点)、`docs/roadmap.md`(「一个文件夹连开两件事,看等待行」那条标 2026-09-28 真机核对通过)、`docs/maintainer/README.md` 或架构文档里若有「service.ts 是 god file」的说法改一句(以 `grep -rn "service.ts" docs/` 为准,只改说反的)。

- [ ] **Step 1**:量行数与内函数数(预期 ≈250 行 / 3),改常量与注释「当前值 = PR 10 收尾后的实际值;service.ts 只剩组装」。
- [ ] **Step 2**:文档三处。spec 状态行:「状态:**完成**(2026-09-28,PR #132–#134/#135/#136/#137/#138/#139/#140/#141 + 本 PR);service.ts 1965 → N 行、内函数 68 → 3;§3 第 6/7 项对调过;最后两个模块用域对象显式注入(见 PR 10 计划 Architecture 裁决)」。
- [ ] **Step 3**:全量 bun / node / typecheck / depcheck。Expected:bun 709 文件(PR 9 后 707 + execute.test + entry.test);node 全绿;0;`0 errors, 21 warnings`。
- [ ] **Step 4: Commit**(含本计划)—— `workbench service 拆分 33/33:棘轮定稿(service.ts 只剩组装);spec 状态改完成、roadmap 真机账划掉;附 PR 10 计划`

---

### Task 5: 推分支、PR、CI、合入后真机

同 PR 9 Task 4:push → PR → `ci triage` → 合 dev → build-sidecar → `self deploy` → `selftest workbench --executor cursor --image --resume` + `selftest chat --provider cursor --resume`(本 PR 动了 create/continue/entry/createWechat 全部入口,两项都跑)。

---

## Self-Review

- **Spec 覆盖**:§3 第 10 项 execute ✓(+ entry,Codex 加的域按 §6「直接建 service/<domain>.ts」);§2 目标形状全部落地(实际文件名与 spec 略有出入,Task 4 回写 spec);§5 棘轮定稿、域单测、真机 ✓;§4 不改行为 ✓。
- **占位符**:Task 2 Step 1 里那条 it 明确标了「占位,实施时按下面用例写」——保留是为了让文件骨架(import / 迷你组装)有据可抄;其余按锚点抠、diff 核对。
- **类型一致**:`ExecuteDomains` / `EntryDomains` 的字段名与 service.ts 里各域变量一一对应;`actions.set` 三处改指向 execute 域。
- **Review Focus** 归属:1→Task 2「beforeCreate 抛」;2→Task 2「continueTask 三条」;3→Task 2「start 双重占用」;4→Task 3「creation_conflict / entry_not_wired」;5→Task 2「跑到 completed」。
