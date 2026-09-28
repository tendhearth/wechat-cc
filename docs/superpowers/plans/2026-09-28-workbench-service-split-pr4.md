# workbench service 拆分 · PR 4(notices / 微信投递域)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 notices 域(微信提醒的入队 / 终态通知 / 唤醒、成果投递、订阅开关,6 个闭包 + 7 个 public 入口)逐字搬进 `src/core/workbench/service/notices.ts`。**行为一字不变**,19 份既有 `service*.test.ts` 一行不改、全绿;棘轮再下调。

**Architecture:** 同 PR 1–3。跨域依赖两处:`stageFinishedNotice` 要 quota 域的 `fallbackExecutor`,`deliverWechatArtifact` 要 `service.artifact()` —— 都进 `ServiceActions`(Ref 晚绑定,与 PR 1 的 `isReplied` 同一种机制,不引入第二种)。`ctx.deps` 加 `permissionTimeoutMs`。**`createWechat` 不在本 PR**:它依赖 `projects()` / `createTask` / `safeOriginMatterId` 三样都在 create/execute 域,搬它要三条晚绑定只为一个方法,留给 execute/create 那个 PR(spec §1 把它列在 notices 下,这里按依赖面裁决)。`artifactDeliveryStore` / `notificationStore` 是 store 的直接引用,留在 service.ts。

**Tech Stack:** TypeScript(`strict` + `verbatimModuleSyntax`)、vitest、dependency-cruiser。

**Spec:** `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(§3 第 4 项)。基线 dev `69cd7c7f`。

## Global Constraints

- 分支 `sweep/workbench-service-split-4`,工作树 `.claude/worktrees/deploy-dev`;进 dev 走 PR + squash。
- 不改任何行为、错误码、**通知文案**(逐字搬,四段长注释一起搬——它们是终审修复的依据)。
- 不改 public 方法签名;19 份既有 `src/core/workbench/service*.test.ts` 一行不改。三份域单测(review / attachments / quota)允许为 ctx 新字段补字段。
- `service/*.ts` 禁止 import `../service`。
- 每个任务一个 commit,中文,结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## Review Focus

1. **`stageFinishedNotice` 与终态状态同一事务**(注释「Persist the frozen result in the same transaction as the terminal task status」):它由 `execute` / `cancelRun` 在 `store.atomic` 里调用,搬进域后仍是同步函数、不加 await —— Task 2 域单测「stage 之后 list 为空、publishFinishedNotices 之后才出现」钉住两段式语义;`service-report.test.ts` / `service-quota.test.ts` 走完整链。
2. **额度耗尽的通知文案**用 `ctx.actions.deref().fallbackExecutor` —— 搬家后「交给 X 继续?」那句必须还在。Task 2 域单测「failed + provider_quota_exhausted ⇒ 文案含 executionFailureMessage + 候选显示名」钉住。
3. **`notificationEligible` 的 permission 超时用 `ctx.deps.permissionTimeoutMs ?? WORKBENCH_PERMISSION_TIMEOUT_MS`**,`opts.permissionTimeoutMs` 没传时缺省不变 —— Task 2 域单测「pending permission 过期 ⇒ false」钉住。
4. **`wakeNotices` 在 stopping 后不再唤醒**,且经 `queueMicrotask` 异步 —— Task 2 域单测「contextAvailable 后 noticeWake 在微任务里被调;stopping=true 时不调」钉住。
5. **`deliverWechatArtifact` 的检查顺序**:identity → requestId → commandHash → 三张回执表冲突 → prior 回放 → transport 缺失 → reserve。搬家后 `artifact_transport_unavailable` 必须在 reserve **之前**抛(不留下孤儿预约)—— Task 2 域单测「无 transport ⇒ 抛且 artifactDeliveries 里没有该 id」钉住。

---

### Task 1: `ctx.deps.permissionTimeoutMs` + `ServiceActions` 加 `fallbackExecutor` / `artifact`

**Files:**
- Modify: `src/core/workbench/service/ctx.ts`
- Modify: `src/core/workbench/service.ts`(ctx 字面量、`actions.set`)
- Modify: `src/core/workbench/service/review.test.ts`(`stub()` 补两个字段)

**Interfaces:**
- Produces:
  ```ts
  export interface ServiceDeps { …; /** 权限卡的等待上限(ms);缺省 WORKBENCH_PERMISSION_TIMEOUT_MS。 */ permissionTimeoutMs?: number }
  export interface ServiceActions {
    …
    fallbackExecutor(exhaustedId:string): string|null
    artifact(id:string,artifactId:string): {name:string;mime:string;size:number;sha256:string;contentBase64:string}
  }
  ```

- [ ] **Step 1**:改 `ctx.ts`(两处加字段,注释照上面)。
- [ ] **Step 2: typecheck 先红** —— Expected `Found 2 errors`(service.ts 的 `actions.set` 缺两字段;`review.test.ts` 的 `stub()` 缺两字段)。`deps.permissionTimeoutMs` 是可选的,不会红。
- [ ] **Step 3: `service.ts`**:ctx 字面量 `deps:{…,...(opts.permissionTimeoutMs!==undefined?{permissionTimeoutMs:opts.permissionTimeoutMs}:{})}`;`actions.set({…,fallbackExecutor,artifact:(id,artifactId)=>service.artifact(id,artifactId)})`。
- [ ] **Step 4: `review.test.ts`** 的 `stub()` 默认对象补 `fallbackExecutor: () => null, artifact: () => { throw new Error('unused') }`。
- [ ] **Step 5: 验证** —— typecheck 0;`bun --bun vitest run src/core/workbench/service` 23 文件 265 条全过。
- [ ] **Step 6: Commit** —— `workbench service 拆分 11/n:ctx.deps 加 permissionTimeoutMs;actions 加 fallbackExecutor / artifact(notices 域的前置,行为不变)`

---

### Task 2: notices 域

**Files:**
- Create: `src/core/workbench/service/notices.ts`
- Create: `src/core/workbench/service/notices.test.ts`
- Modify: `src/core/workbench/service.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NoticesDomain {
    wakeNotices(context?:{ownerChatId:string;accountId:string}): void
    enqueueNotice(task:StoredTask,runId:string,kind:WechatNoticeKind,text:string,requestId?:string|null): void
    requestNotice(task:StoredTask,runId:string,kind:'permission'|'question',id:string,label:string): void
    terminalReportBody(running:Active): string|undefined
    stageFinishedNotice(running:Active,status:TaskStatus,error?:string|null,suppressCompleted?:boolean): void
    publishFinishedNotices(): void
    setArtifactDelivery(deliver:((id:string)=>Promise<ArtifactDeliveryReceipt>)|undefined): void
    artifactDeliveryEligible(receipt:ArtifactDeliveryReceipt): boolean
    deliverWechatArtifact(input:SendWechatArtifact): Promise<ArtifactDeliveryReceipt>
    setNotificationWake(wake:(context?:{ownerChatId:string;accountId:string})=>Promise<void>): void
    contextAvailable(ownerChatId:string,accountId:string): void
    notificationEligible(notice:WechatNotificationNotice): boolean
    setWechatWatch(id:string,accountId:string,enabled:boolean): WechatNotificationSubscription
  }
  export function makeNoticesDomain(ctx:ServiceCtx): NoticesDomain
  ```
  `service.ts` 解构 `{requestNotice,terminalReportBody,stageFinishedNotice,publishFinishedNotices}`(execute / cancelRun 的调用点不改;`wakeNotices` / `enqueueNotice` 只在域内用)。

- [ ] **Step 1: 写 `service/notices.test.ts`(红)**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { providerDisplayName } from '../../provider-display-names'
import { executionFailureMessage } from '../execution-settings'
import { removeTempDir } from '../../../lib/test-temp'
import { makeRuntimeState, type Active } from './state'
import { makeNoticesDomain } from './notices'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })

function setup(owner: string | null = 'owner', permissionTimeoutMs?: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-notices-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const state = makeRuntimeState()
  const noticeWake = vi.fn(async () => {}); state.noticeWake = noticeWake
  const actions = new Ref<ServiceActions>('t')
  actions.set({ submitInput: vi.fn(), continueTask: vi.fn(), isReplied: () => false, fallbackExecutor: () => 'claude', artifact: () => ({ name: 'a.txt', mime: 'text/plain', size: 1, sha256: 'f'.repeat(64), contentBase64: 'YQ==' }) } as never)
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn() }, deps: { ownerChatId: () => owner, registry: createProviderRegistry(), ...(permissionTimeoutMs !== undefined ? { permissionTimeoutMs } : {}) }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const domain = makeNoticesDomain(ctx)
  const task = store.create({ title: '写周报', path: project, providerId: 'codex', ownerChatId: owner })
  /** 假的 Active:只给 notices 用得到的字段。 */
  const running = (over: Partial<Active> = {}): Active => ({ identity: 'run-1', taskId: task.id, title: task.title, task, cancelled: false, finishing: false, uncertain: false, permissions: { pending: () => [] }, questions: { pending: () => [] }, ...over } as unknown as Active)
  return { store, state, domain, task, noticeWake, running }
}
const tick = () => new Promise<void>(r => queueMicrotask(r))

describe('makeNoticesDomain · 入队与唤醒', () => {
  it('没订阅 ⇒ requestNotice 不入队、不唤醒', async () => {
    const { domain, task, store, noticeWake } = setup()
    domain.requestNotice(task, 'run-1', 'permission', 'p1', 'rm -rf')
    await tick()
    expect(store.wechatNotifications.list(task.id)).toEqual([]); expect(noticeWake).not.toHaveBeenCalled()
  })
  it('订阅开着且是主人 ⇒ 入队一条 permission 通知(标题 · id / 需要你批准 / 查看…),微任务里唤醒', async () => {
    const { domain, task, store, noticeWake } = setup()
    store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    domain.requestNotice(task, 'run-1', 'permission', 'p1', 'rm -rf')
    expect(noticeWake).not.toHaveBeenCalled()
    await tick()
    const [n] = store.wechatNotifications.list(task.id)
    expect(n).toMatchObject({ kind: 'permission', requestId: 'p1', runId: 'run-1', accountId: 'acct' })
    expect(n!.text).toContain(`写周报 · ${task.id}`); expect(n!.text).toContain('需要你批准'); expect(n!.text).toContain(`查看：任务 ${task.id} 权限 p1`)
    expect(noticeWake).toHaveBeenCalledTimes(1)
  })
  it('订阅的主人不是当前主人 ⇒ 不入队', async () => {
    const { domain, task, store } = setup()
    store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    const other = { ...task, ownerChatId: 'someone-else' }
    domain.requestNotice(other, 'run-1', 'question', 'q1', '要哪种?')
    expect(store.wechatNotifications.list(task.id)).toEqual([])
  })
  it('contextAvailable:是主人才唤醒,带上下文;stopping 之后不再唤醒', async () => {
    const { domain, state, noticeWake } = setup()
    domain.contextAvailable('someone-else', 'acct'); await tick(); expect(noticeWake).not.toHaveBeenCalled()
    domain.contextAvailable('owner', 'acct'); await tick(); expect(noticeWake).toHaveBeenCalledWith({ ownerChatId: 'owner', accountId: 'acct' })
    state.stopping = true
    domain.contextAvailable('owner', 'acct'); await tick(); expect(noticeWake).toHaveBeenCalledTimes(1)
  })
})

describe('makeNoticesDomain · 终态通知', () => {
  it('非终态 / completed 且被压 ⇒ 什么都不 stage', () => {
    const { domain, task, store, running } = setup()
    store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    domain.stageFinishedNotice(running(), 'running'); domain.stageFinishedNotice(running(), 'completed', null, true)
    domain.publishFinishedNotices()
    expect(store.wechatNotifications.list(task.id)).toEqual([])
  })
  it('stage 是两段式:stage 之后 list 仍空,publishFinishedNotices 之后才出现;文案含标签与「查看/结果」', () => {
    const { domain, task, store, running } = setup()
    store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    store.update(task.id, 'completed')
    domain.stageFinishedNotice(running(), 'completed')
    expect(store.wechatNotifications.list(task.id)).toEqual([])
    domain.publishFinishedNotices()
    const [n] = store.wechatNotifications.list(task.id)
    expect(n).toMatchObject({ kind: 'completed', runId: 'run-1' })
    expect(n!.text).toContain('这一轮已完成'); expect(n!.text).toContain(`结果：任务 ${task.id} 结果`)
  })
  it('failed + 额度耗尽 ⇒ 文案是 executionFailureMessage + 「交给 <候选> 继续?」(候选来自 ctx.actions.fallbackExecutor)', () => {
    const { domain, task, store, running } = setup()
    store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    store.update(task.id, 'failed', 'provider_quota_exhausted')
    domain.stageFinishedNotice(running(), 'failed', 'provider_quota_exhausted'); domain.publishFinishedNotices()
    const [n] = store.wechatNotifications.list(task.id)
    expect(n!.text).toContain(executionFailureMessage('provider_quota_exhausted'))
    expect(n!.text).toContain(`交给 ${providerDisplayName('claude')} 继续？`)
  })
  it('terminalReportBody:取这一轮最后一条 text 事件 + 最多 5 个成果名;都没有 ⇒ undefined', () => {
    const { domain, task, store, running } = setup()
    expect(domain.terminalReportBody(running())).toBeUndefined()
    store.addEvent(task.id, 'text', '第一句', null, 'run-1'); store.addEvent(task.id, 'text', '最后一句', null, 'run-1'); store.addEvent(task.id, 'text', '别的 run', null, 'run-2')
    expect(domain.terminalReportBody(running())).toBe('最后一句')
  })
})

describe('makeNoticesDomain · 订阅与资格', () => {
  it('setWechatWatch:任务没主人 / 不是当前主人 ⇒ invalid_wechat_identity', () => {
    const { domain, task } = setup(null)
    expect(() => domain.setWechatWatch(task.id, 'acct', true)).toThrow('invalid_wechat_identity')
  })
  it('setWechatWatch 打开时,正在等的权限卡立刻补一条通知', async () => {
    const { domain, task, store, state, running } = setup()
    state.runsByTask.set(task.id, running({ permissions: { pending: () => [{ id: 'p9', tool: 'bash', description: 'ls', createdAt: Date.now() }] } } as never))
    const watch = domain.setWechatWatch(task.id, 'acct', true)
    expect(watch).toMatchObject({ enabled: true, accountId: 'acct' })
    expect(store.wechatNotifications.list(task.id)).toMatchObject([{ kind: 'permission', requestId: 'p9' }])
  })
  it('notificationEligible:generation 不符 ⇒ false;终态类通知有效订阅 ⇒ true;permission 类要 run 还在且未过期', () => {
    const { domain, task, store, state, running } = setup('owner', 1000)
    const watch = store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    const base = { taskId: task.id, ownerChatId: 'owner', accountId: 'acct', runId: 'run-1', subscriptionGeneration: watch.generation }
    expect(domain.notificationEligible({ ...base, kind: 'completed', subscriptionGeneration: watch.generation + 1 } as never)).toBe(false)
    expect(domain.notificationEligible({ ...base, kind: 'completed' } as never)).toBe(true)
    expect(domain.notificationEligible({ ...base, kind: 'permission', requestId: 'p1' } as never)).toBe(false)   // 没有 run
    state.runsByTask.set(task.id, running({ permissions: { pending: () => [{ id: 'p1', createdAt: Date.now() - 5000 }] } } as never))
    expect(domain.notificationEligible({ ...base, kind: 'permission', requestId: 'p1' } as never)).toBe(false)   // 过期(1000ms)
    state.runsByTask.set(task.id, running({ permissions: { pending: () => [{ id: 'p1', createdAt: Date.now() }] } } as never))
    expect(domain.notificationEligible({ ...base, kind: 'permission', requestId: 'p1' } as never)).toBe(true)
  })
})

describe('makeNoticesDomain · 成果投递', () => {
  it('artifactDeliveryEligible:主人对得上才 true;stopping ⇒ false', () => {
    const { domain, task, state } = setup()
    const receipt = { ownerChatId: 'owner', taskId: task.id } as never
    expect(domain.artifactDeliveryEligible(receipt)).toBe(true)
    expect(domain.artifactDeliveryEligible({ ownerChatId: 'x', taskId: task.id } as never)).toBe(false)
    state.stopping = true; expect(domain.artifactDeliveryEligible(receipt)).toBe(false)
  })
  it('deliverWechatArtifact:身份不符 / hash 畸形 / 没有投递通道 各自的错误码;没通道时不留预约', async () => {
    const { domain, task, store } = setup()
    const input = { ownerChatId: 'owner', accountId: 'acct', requestId: '11111111-1111-4111-8111-111111111111', commandHash: 'a'.repeat(64), taskId: task.id, artifactId: 'art-1' }
    await expect(domain.deliverWechatArtifact({ ...input, ownerChatId: 'x' })).rejects.toThrow('invalid_wechat_identity')
    await expect(domain.deliverWechatArtifact({ ...input, commandHash: 'zz' })).rejects.toThrow('invalid_request')
    await expect(domain.deliverWechatArtifact(input)).rejects.toThrow('artifact_transport_unavailable')
    expect(store.artifactDeliveries.get(input.requestId)).toBeNull()
    const deliver = vi.fn(async (id: string) => ({ id, status: 'accepted' } as never))
    domain.setArtifactDelivery(deliver)
    await domain.deliverWechatArtifact(input)
    expect(deliver).toHaveBeenCalledWith(input.requestId)
    expect(store.artifactDeliveries.get(input.requestId)).toMatchObject({ taskId: task.id, artifactId: 'art-1', name: 'a.txt' })
  })
})
```

`store.addEvent` 的参数顺序、`artifactDeliveries.get` 的返回(null 还是 undefined)、`WechatNotificationNotice` 的字段以各自源文件为准;**不要改 store**。

- [ ] **Step 2: 跑,确认红** —— `Cannot find module './notices'`。

- [ ] **Step 3: 新建 `service/notices.ts`** —— 脚本从 `service.ts` 抠三块,逐字:
  - A:`const wakeNotices=…` 那一行(`:184`);
  - B:`function enqueueNotice(` 起到 `publishFinishedNotices` 闭合 `}`(`:188-263`,含 `terminalReportBody` / `stageFinishedNotice` 上面两段长注释);
  - C:public 对象里 `setArtifactDelivery` … `deliverWechatArtifact` 闭合 `},`(`:1146-1167`),`setNotificationWake`(`:1169`),`contextAvailable` … `setWechatWatch` 闭合 `},`(`:1174-1195`)。
  替换只有:`opts.ownerChatId`→`ctx.deps.ownerChatId`、`opts.permissionTimeoutMs`→`ctx.deps.permissionTimeoutMs`、`touched(`→`ctx.hub.touched(`、`ensureAccepting()`→`ctx.ensureAccepting()`、`runsByTask`→`ctx.state.runsByTask`、`fallbackExecutor(`→`ctx.actions.deref('notices').fallbackExecutor(`、`service.artifact(`→`ctx.actions.deref('notices').artifact(`。文件头 import:`executionFailureMessage` from `../execution-settings`、`normalizeInputRequestId` from `../live-inputs`、`WORKBENCH_PERMISSION_TIMEOUT_MS` from `../permissions`、`providerDisplayName` from `../../provider-display-names`、`TERMINAL_TASK_STATUSES, type StoredTask, type TaskStatus` from `../store`、类型 `WechatNoticeKind, WechatNotificationNotice, WechatNotificationSubscription` from `../wechat-notifications`、`ArtifactDeliveryReceipt` from `../artifact-deliveries`、`SendWechatArtifact` from `../wechat-types`、`Active` from `./state`、`ServiceCtx` from `./ctx`。

- [ ] **Step 4: `service.ts` 接上** —— import;`const noticesDomain=makeNoticesDomain(ctx)` + `const {requestNotice,terminalReportBody,stageFinishedNotice,publishFinishedNotices}=noticesDomain` 放在 quota 解构之后(`wakeNotices` 原来在 `store.recover()` 之前定义;它只被域内函数用,位置无关);删三块;public 对象里七个方法换成 `xxx:noticesDomain.xxx,`;`artifactDeliveryStore` / `notificationStore` / `fallbackExecutor(exhaustedId){…}` / `createWechat` / `handleWechat` 原地不动。删不再用的 import(以 `grep -c` 为准:`providerDisplayName`、`WORKBENCH_PERMISSION_TIMEOUT_MS`、`type WechatNotificationNotice`、`type WechatNoticeKind` 可能只剩 import 一处)。

- [ ] **Step 5: 验证** —— notices 单测 13 通过;typecheck 0;`bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts` 25 文件全过(`service-report` / `service-quota` / `service-unattended` 走完整链);depcheck `0 errors, 21 warnings`;逐字 diff 核对。

- [ ] **Step 6: Commit** —— `workbench service 拆分 12/n:notices 域搬进 service/notices.ts(提醒入队/终态通知/唤醒/成果投递/订阅开关,行为不变)`

---

### Task 3: 棘轮下调 + 全量闸门

- [ ] **Step 1**:量行数与内函数数(预期 ≈1615 行 / 54),改常量与注释「当前值 = PR 4 搬完 notices 域之后的实际值」。数字手抄。
- [ ] **Step 2**:全量 bun / node / typecheck / depcheck。Expected:bun 699 文件 / 9267 条(PR 3 后 698/9254 + 1 文件 13 条);node 全绿;0;`0 errors, 21 warnings`。满载偶发红按 PR 3 的办法单跑复核并记账。
- [ ] **Step 3: Commit**(含本计划)—— `workbench service 拆分 13/n:棘轮下调到搬完 notices 域的实际值;附 PR 4 计划`

---

### Task 4: 推分支、PR、CI、合入后真机

同 PR 3 Task 4。selftest 之外,本 PR 动的是微信提醒链,合入后再跑一次 `wechat-cc selftest chat --provider cursor --resume`(它不发微信,但走 daemon 的通知接线)。

---

## Self-Review

- **Spec 覆盖**:§3 第 4 项 notices ✓(`createWechat` 按依赖面延后,见 Architecture 裁决);§2 `service/notices.ts` ✓;§5 域单测 / 棘轮 / 真机 ✓;§4 不改行为 ✓。
- **占位符**:Task 2 Step 3 三块按行段抠、diff 核对。
- **类型一致**:`ServiceActions.fallbackExecutor/artifact` Task 1 产、Task 2 消费;`NoticesDomain` 四个解构名与 execute/cancelRun 调用点同名。
- **Review Focus** 归属:1→「两段式」;2→「额度耗尽文案」;3→「permission 过期」;4→「contextAvailable / stopping」;5→「无通道不留预约」。
