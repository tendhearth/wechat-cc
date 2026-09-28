# workbench service 拆分 · PR 9(lifecycle + settle 域)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 lifecycle + settle 域(租约 / 空闲自动收工 / 回报与回忆去重 / 安静落定 / 占用释放 / 不确定退出 / 派发泵 / 取消,以及 `setArchived` / `cancel` / `shutdown` 三个入口)逐字搬进 `service/lifecycle.ts`。这是 spec §1 说的那个环(`pump → execute → settleQuiet → armIdleClose → closeForIdle → cancelRun → pump`)**完整经 `ctx.actions` 走**的一刀。**行为一字不变**,19 份既有 `service*.test.ts` 一行不改、全绿;棘轮再下调。

**Architecture:** 同 PR 1–8。搬走后 service.ts 只剩 hub / entry 三个帮手 / `ensureAccepting` / `execute` / `start` / `matterSync` / `safeOriginMatterId` / `createTask` 和 create/entry/wechat 那几个入口(PR 10)。本域的跨域依赖:`execute`(pump 派发,真晚绑定)、inputs 的 `hasUndeliveredInput` / `holdInputs`、artifacts 的 `collect` / `collectTurnArtifacts` / `captureCodeChanges`、view 的 `runtimeSnapshot` / `isReplied` / `held` / `taskView`、notices 的 `stageFinishedNotice` / `publishFinishedNotices`、`matterSync` —— 全部走 `ServiceActions`(到此 ~30 字段,**PR 10 收尾时按域分组**是已立的账)。`ctx.deps` 加 `reports` / `recollect` / `revokeSessionToken` / `handoffGraceMs` / `retainedIdleCloseMs`;`ctx.hub` 加 `dispose`(shutdown 用)。`quiet` 别名留在域内(`const quiet=(running:Active)=>act().isReplied(running)`,service.ts 里已无人用)。

**Tech Stack:** TypeScript(`strict` + `verbatimModuleSyntax`)、vitest(fake timers)、dependency-cruiser。

**Spec:** `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(§3 第 9 项)。基线 dev `f6a36916`(#140 之后)。

## Global Constraints

- 分支 `sweep/workbench-service-split-9`,工作树 `.claude/worktrees/deploy-dev`;进 dev 走 PR + squash。
- 不改任何行为、错误码、文案(空闲收工那两句系统事件逐字)、数值(15 s / 600 s / 2³¹−1 封顶)。逐字搬,注释一起搬(租约长注释、reportOnce / recollectOnce / settleQuiet 三段修复依据)。
- 不改 public 方法签名;19 份既有 `src/core/workbench/service*.test.ts` 一行不改。域单测允许补 stub。
- `service/*.ts` 禁止 import `../service`。
- 每个任务一个 commit,中文,结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 链式命令里别用 `grep -c`;替换脚本别用宽 `\b` 正则,逐名带 `(?<![.\w])…(?![\w])` 边界;带注释的方法首行不是方法名。

## Review Focus

1. **`closeForIdle` 到点的复查**:`!quiet || reservations.get(identity)!==running || finishing || cancelled || hasUndeliveredInput ⇒ return`,复查过了才写系统事件 + `closedWhileReplied=true` + `cancelRun` —— Task 2 域单测「有未投递补充 ⇒ 不收工;干净 ⇒ 事件文案含『空闲 N 秒后自动收工』且 cancelRun 被调」钉住(fake timers)。
2. **`armIdleClose` 不推迟已排好的短让位**(`existing.at<=at ⇒ return`),有人等 ⇒ `handoffGraceMs`,没人等 ⇒ `retainedIdleMs`;旋钮封顶 `MAX_TIMEOUT_MS`、非法值回落 —— Task 2 域单测「先 handoff 后 idle 不被推迟;knob 给函数抛错 ⇒ 回落;给 Infinity ⇒ 封顶」钉住。
3. **`reportOnce` / `recollectOnce` 按 `turnSeq` 去重且吞异常记日志** —— Task 2 域单测「同 turnSeq 二次 no-op;sink 抛 ⇒ ctx.log 记 MATTER_REPORT / MATTER_RECOLLECT」钉住。
4. **`cancelRun` 排队分支**:`store.atomic(update cancelled + stageFinishedNotice)` → touched → matterSync done → publishFinishedNotices → 出队 → pump —— 顺序逐字;Task 2 域单测「queued run 取消 ⇒ 任务 cancelled、stageFinishedNotice/publishFinishedNotices 经 actions 各一次、pump 被调」钉住。
5. **`shutdown` 的收尾顺序**:stopping → 逐个 cancelRun(抛了就手工兜底)→ 等所有 done → 排空 `state.collections` → `shutdownComplete=true` → 逐个 releaseReservation → `hub.dispose()` —— Task 2 域单测「两个 run:一个 cancelRun 正常、一个抛 ⇒ 都被 signalStop;collections 排空后才 shutdownComplete;dispose 最后被调;第二次 shutdown 返回同一 promise」钉住。

---

### Task 1: `ctx.deps` 五个字段 + `ctx.hub.dispose` + `ServiceActions` 十二个字段

**Files:**
- Modify: `service/ctx.ts`、`service.ts`(ctx/hub/actions.set)、七份域单测 stub(review / notices / admission / view / native / inputs;attachments / quota / artifacts 没 set 过 actions 不用动)

**Interfaces:**
```ts
export interface ServiceHub { …; /** 长轮询中心收尾:叫醒所有 waiter、清缓存(shutdown 最后一步)。 */ dispose(): void }
export interface ServiceDeps {
  …
  reports?: ReportSink
  recollect?: RecollectSink
  revokeSessionToken?: (sessionKey: string) => void
  retainedIdleCloseMs?: number | (() => number)
  handoffGraceMs?: number | (() => number)
}
export interface ServiceActions {
  …
  execute(task:StoredTask,text:string,running:Active): Promise<void>
  hasUndeliveredInput(running:Active): boolean
  holdInputs(id:string,error:string): void
  collect(running:Active): Promise<void>
  collectTurnArtifacts(running:Active): void
  captureCodeChanges(running:Active): Promise<void>
  runtimeSnapshot(running:Active|undefined): AgentRuntimeSnapshot|undefined
  held(): Active[]
  stageFinishedNotice(running:Active,status:TaskStatus,error?:string|null,suppressCompleted?:boolean): void
  publishFinishedNotices(): void
}
```
(`isReplied` / `taskView` / `matterSync` 已在。`execute` 的签名照 service.ts `async function execute(task:StoredTask,text:string,running:Active)` 抄。)

- [ ] **Step 1**:改 `ctx.ts`(import `ReportSink` from `'../../matters/report'`、`RecollectSink` from `'../../matters/recollection'`、`AgentRuntimeSnapshot` from `'../../agent-provider'`、`TaskStatus` from `'../store'`)。typecheck 先红(service.ts 的 ctx 字面量 `hub`、`actions.set`,六份 stub)。
- [ ] **Step 2**:service.ts —— `hub:{touched,bumped,dispose:()=>changes.dispose()}`;`deps` 加 `...(opts.reports?{reports:opts.reports}:{}),...(opts.recollect?{recollect:opts.recollect}:{}),...(opts.revokeSessionToken?{revokeSessionToken:opts.revokeSessionToken}:{}),...(opts.retainedIdleCloseMs!==undefined?{retainedIdleCloseMs:opts.retainedIdleCloseMs}:{}),...(opts.handoffGraceMs!==undefined?{handoffGraceMs:opts.handoffGraceMs}:{})`;`actions.set` 加 `execute,hasUndeliveredInput,holdInputs,collect,collectTurnArtifacts,captureCodeChanges,runtimeSnapshot,held,stageFinishedNotice,publishFinishedNotices`。六份 stub 各补(`execute: unused, hasUndeliveredInput: () => false, holdInputs: () => {}, collect: async () => {}, collectTurnArtifacts: () => {}, captureCodeChanges: async () => {}, runtimeSnapshot: () => undefined, held: () => [], stageFinishedNotice: () => {}, publishFinishedNotices: () => {}`);各 fixture 的 `hub` 补 `dispose: vi.fn()`。
- [ ] **Step 3: 验证** —— typecheck 0;`bun --bun vitest run src/core/workbench/service` 全过;depcheck `0 errors, 21 warnings`。
- [ ] **Step 4: Commit** —— `workbench service 拆分 27/n:ctx.deps 加 reports/recollect/revokeSessionToken/两个 idle 旋钮、hub 加 dispose、actions 加 lifecycle 要的十个动作(行为不变)`

---

### Task 2: lifecycle + settle 域

**Files:**
- Create: `src/core/workbench/service/lifecycle.ts`、`src/core/workbench/service/lifecycle.test.ts`
- Modify: `src/core/workbench/service.ts`

**Interfaces:**
```ts
export function makeLifecycleDomain(ctx:ServiceCtx) {
  …
  return { revokeCredentials,quiet,handoffGraceMs,retainedIdleMs,armIdleClose,cancelIdleClose,closeForIdle,reportOnce,recollectOnce,settleQuiet,settleAfterDecision,releaseReservation,confirmLateClose,markUncertain,pump,cancelRun, setArchived,cancel,shutdown }
}
export type LifecycleDomain = ReturnType<typeof makeLifecycleDomain>
```
`service.ts` 解构 `{revokeCredentials,cancelIdleClose,reportOnce,recollectOnce,settleQuiet,settleAfterDecision,releaseReservation,confirmLateClose,markUncertain,pump,cancelRun}`(execute / start 的调用点不改);public 三个换 `xxx:lifecycleDomain.xxx,`;`actions.set` 里 `armIdleClose,cancelIdleClose,settleAfterDecision` 改成 `lifecycleDomain.xxx`(它们不再是 service.ts 的声明;`cancelIdleClose`/`settleAfterDecision` 解构出来的名字也行,保持一致用解构名)。

- [ ] **Step 1: 写 `service/lifecycle.test.ts`(红)**

```ts
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentRuntimeSnapshot } from '../../agent-provider'
import { makeRuntimeState, type Active } from './state'
import { makeLifecycleDomain } from './lifecycle'
import type { ServiceActions, ServiceCtx, ServiceDeps } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const unused = () => { throw new Error('unused') }
const idle = (): AgentRuntimeSnapshot => ({ retained: true, foreground: 'idle', backgroundCount: 0, input: 'send' })

function setup(deps: Partial<ServiceDeps> = {}, over: Partial<ServiceActions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-lifecycle-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const state = makeRuntimeState()
  const hub = { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }
  const log = vi.fn()
  const actions = new Ref<ServiceActions>('t')
  const spies = {
    execute: vi.fn(async () => {}), hasUndeliveredInput: vi.fn(() => false), holdInputs: vi.fn(), collect: vi.fn(async () => {}), collectTurnArtifacts: vi.fn(), captureCodeChanges: vi.fn(async () => {}),
    stageFinishedNotice: vi.fn(), publishFinishedNotices: vi.fn(), matterSync: vi.fn(), isReplied: vi.fn(() => true), runtimeSnapshot: vi.fn(() => idle() as AgentRuntimeSnapshot | undefined),
  }
  actions.set({ submitInput: vi.fn(), continueTask: vi.fn(), fallbackExecutor: () => null, artifact: unused, quotaExhausted: () => null, continuation: () => ({ mode: 'new' }), provider: unused, requireInput: unused, canResume: () => false, taskVersion: () => 'v', selectAttachments: () => [], combinedAttachments: c => [...c], handoffAttachments: () => [], taskView: t => ({ ...t, phase: 'replied', canArchive: true, waitingFor: null }) as never, start: unused, continuationAttachmentScope: () => undefined, inputMode: () => 'queue', armIdleClose: unused, cancelIdleClose: unused, settleAfterDecision: unused, held: () => [...state.reservations.values()], ...spies, ...over })
  const ctx: ServiceCtx = { store, stateDir, state, hub, deps: { ownerChatId: () => 'owner', registry: createProviderRegistry(), ...deps }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, log, now: Date.now, actions }
  const domain = makeLifecycleDomain(ctx)
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  let resolveDone!: () => void
  const running = (over: Partial<Active> = {}): Active => {
    const done = new Promise<void>(r => { resolveDone = r })
    return { identity: 'run-1', taskId: task.id, title: task.title, task, path: project, order: 1, state: 'active', cancelled: false, finishing: false, uncertain: false, publicFinished: false, credentialsMinted: false, credentialsRevoked: false, turnSeq: 0, reportedTurn: -1, recollectedTurn: -1, done, resolveDone: () => resolveDone(), signalStop: vi.fn(), permissions: { pending: () => [], rejectAll: vi.fn() }, questions: { pending: () => [], close: vi.fn() }, ...over } as unknown as Active
  }
  return { store, state, hub, log, domain, task, project, running, spies }
}

describe('makeLifecycleDomain · 旋钮与计时', () => {
  it('旋钮:没传 ⇒ 缺省 15 s / 600 s;函数抛错 ⇒ 缺省;负数/NaN ⇒ 缺省;Infinity ⇒ 封顶 2³¹−1', () => {
    expect(setup().domain.handoffGraceMs()).toBe(15_000); expect(setup().domain.retainedIdleMs()).toBe(600_000)
    expect(setup({ handoffGraceMs: () => { throw new Error('x') } }).domain.handoffGraceMs()).toBe(15_000)
    expect(setup({ retainedIdleCloseMs: -1 }).domain.retainedIdleMs()).toBe(600_000)
    expect(setup({ retainedIdleCloseMs: Infinity }).domain.retainedIdleMs()).toBe(2_147_483_647)
    expect(setup({ retainedIdleCloseMs: () => 0 }).domain.retainedIdleMs()).toBe(0)
  })
  it('armIdleClose:不安静 / 有未投递补充 ⇒ 不武装;没人等 ⇒ 长空闲;有人等 ⇒ 短让位;已排好的短让位不被长空闲推迟', () => {
    const { domain, running, state, spies } = setup()
    const r = running(); state.reservations.set(r.identity, r); state.runsByTask.set(r.taskId, r)
    spies.isReplied.mockReturnValueOnce(false); domain.armIdleClose(r); expect(r.idleClose).toBeUndefined()
    spies.hasUndeliveredInput.mockReturnValueOnce(true); domain.armIdleClose(r); expect(r.idleClose).toBeUndefined()
    domain.armIdleClose(r); expect(r.idleClose).toMatchObject({ reason: 'idle' })
    state.queue.push(running({ identity: 'waiter', taskId: 'other', order: 2, state: 'queued' }))
    domain.cancelIdleClose(r); domain.armIdleClose(r); expect(r.idleClose).toMatchObject({ reason: 'handoff' })
    const at = r.idleClose!.at; state.queue.length = 0
    domain.armIdleClose(r); expect(r.idleClose!.at).toBe(at)   // 不推迟
    domain.cancelIdleClose(r); expect(r.idleClose).toBeUndefined()
  })
  it('closeForIdle 到点:复查有未投递补充 ⇒ 不收工;干净 ⇒ 系统事件「空闲 N 秒后自动收工…」+ closedWhileReplied + cancelRun', () => {
    const { domain, running, state, store, spies, task } = setup()
    const r = running(); state.reservations.set(r.identity, r); state.runsByTask.set(r.taskId, r)
    domain.armIdleClose(r)
    spies.hasUndeliveredInput.mockReturnValueOnce(true); vi.runOnlyPendingTimers()
    expect(store.events(task.id)).toEqual([]); expect(r.closedWhileReplied).toBeUndefined()
    domain.armIdleClose(r); vi.runOnlyPendingTimers()
    expect(store.events(task.id).at(-1)!.text).toContain('空闲 600 秒后自动收工，释放文件夹'); expect(r.closedWhileReplied).toBe(true); expect(r.cancelled).toBe(true)
  })
})

describe('makeLifecycleDomain · 回报、回忆、落定', () => {
  it('reportOnce / recollectOnce:同 turnSeq 只一次;sink 抛 ⇒ 吞掉并记日志', () => {
    const enqueue = vi.fn(() => { throw new Error('sink down') }), maybeTrigger = vi.fn()
    const { domain, running, log } = setup({ reports: { enqueue } as never, recollect: { maybeTrigger } as never })
    const r = running({ turnSeq: 3 })
    domain.reportOnce(r); domain.reportOnce(r); expect(enqueue).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalledWith('MATTER_REPORT', expect.stringContaining('sink down'))
    domain.recollectOnce(r); domain.recollectOnce(r); expect(maybeTrigger).toHaveBeenCalledWith(r.taskId, 3); expect(maybeTrigger).toHaveBeenCalledTimes(1)
  })
  it('settleQuiet:快照不是 idle ⇒ 什么都不做;idle 但有待决 ⇒ 只收成果;安静 ⇒ matter replied + reportOnce + captureCodeChanges + 武装计时', () => {
    const { domain, running, state, spies } = setup({ reports: { enqueue: vi.fn() } as never })
    const r = running(); state.reservations.set(r.identity, r); state.runsByTask.set(r.taskId, r)
    spies.runtimeSnapshot.mockReturnValueOnce({ ...idle(), foreground: 'running' }); domain.settleQuiet(r); expect(spies.collectTurnArtifacts).not.toHaveBeenCalled()
    spies.isReplied.mockReturnValueOnce(false); domain.settleQuiet(r); expect(spies.collectTurnArtifacts).toHaveBeenCalledTimes(1); expect(spies.matterSync).not.toHaveBeenCalled()
    domain.settleQuiet(r); expect(spies.matterSync).toHaveBeenCalledTimes(1); expect(spies.captureCodeChanges).toHaveBeenCalledTimes(1); expect(r.idleClose).toBeDefined(); expect(r.reportedTurn).toBe(0)
  })
  it('settleAfterDecision:已取消 / 在收尾 ⇒ 不动;否则先取消计时再重新落定', () => {
    const { domain, running, state } = setup()
    const r = running(); state.reservations.set(r.identity, r); state.runsByTask.set(r.taskId, r)
    domain.armIdleClose(r); const before = r.idleClose
    domain.settleAfterDecision(r); expect(r.idleClose).toBeDefined(); expect(r.idleClose).not.toBe(before)
    r.cancelled = true; domain.cancelIdleClose(r); domain.settleAfterDecision(r); expect(r.idleClose).toBeUndefined()
  })
})

describe('makeLifecycleDomain · 占用、取消、收尾', () => {
  it('releaseReservation:删占用与登记、释放 busy、非 stopping 时 pump;markUncertain 重新挂回占用;confirmLateClose 清掉并释放', async () => {
    const { domain, running, state, store, spies } = setup()
    const release = vi.fn(); const r = running({ releaseBusy: release }); state.reservations.set(r.identity, r); state.runsByTask.set(r.taskId, r); state.runningText.set(r.identity, 'x')
    domain.releaseReservation(r); expect(state.reservations.size).toBe(0); expect(state.runsByTask.size).toBe(0); expect(state.runningText.size).toBe(0); expect(release).toHaveBeenCalledTimes(1)
    domain.markUncertain(r); expect(r.state).toBe('uncertain'); expect(state.reservations.get(r.identity)).toBe(r)
    r.publicFinished = true; await domain.confirmLateClose(r, true); expect(spies.collect).toHaveBeenCalledTimes(1); expect(r.uncertain).toBe(false); expect(state.reservations.size).toBe(0)
  })
  it('pump:没挡路的排队 run 变 active、进占用、经 ctx.actions.execute 派发;被挡的 run 让持有者重排短让位', async () => {
    const { domain, running, state, spies, project } = setup()
    const holder = running({ identity: 'holder', order: 1 }); state.reservations.set('holder', holder); state.runsByTask.set(holder.taskId, holder)
    const waiter = running({ identity: 'waiter', taskId: 'other', order: 2, state: 'queued', path: project }); state.queue.push(waiter); state.runningText.set('waiter', '做')
    domain.pump(); expect(waiter.state).toBe('queued'); expect(holder.idleClose).toMatchObject({ reason: 'handoff' }); expect(spies.execute).not.toHaveBeenCalled()
    state.reservations.clear(); domain.pump(); await Promise.resolve()
    expect(waiter.state).toBe('active'); expect(state.reservations.get('waiter')).toBe(waiter); expect(state.queue).toEqual([]); expect(spies.execute).toHaveBeenCalledWith(waiter.task, '做', waiter)
  })
  it('cancelRun 排队分支:任务 cancelled、stageFinishedNotice + publishFinishedNotices 经 actions 各一次、matter done、出队、pump', () => {
    const { domain, running, state, store, spies, task } = setup()
    const r = running({ state: 'queued' }); state.queue.push(r); state.runsByTask.set(task.id, r)
    domain.cancelRun(r)
    expect(store.get(task.id).status).toBe('cancelled'); expect(spies.stageFinishedNotice).toHaveBeenCalledWith(r, 'cancelled'); expect(spies.publishFinishedNotices).toHaveBeenCalledTimes(1)
    expect(spies.holdInputs).toHaveBeenCalledWith(task.id, '任务已停止，补充尚未发送。'); expect(state.queue).toEqual([]); expect(r.publicFinished).toBe(true); expect(state.runsByTask.has(task.id)).toBe(false)
  })
  it('cancelRun 运行分支:标 cancelled、拒掉权限卡、cancelling 落库、session.cancel;uncertain 的不动', () => {
    const { domain, running, state, store, task } = setup()
    const cancel = vi.fn(async () => {}); const r = running({ session: { cancel } as never }); state.runsByTask.set(task.id, r)
    domain.cancelRun(r); expect(r.cancelled).toBe(true); expect(r.closedWhileReplied).toBe(true); expect(store.get(task.id).status).toBe('cancelling'); expect(cancel).toHaveBeenCalledTimes(1)
    const u = running({ identity: 'u', state: 'uncertain' }); domain.cancelRun(u); expect(u.cancelled).toBe(false)
  })
  it('setArchived / cancel:非布尔 ⇒ invalid_request;不能归档 ⇒ workbench_busy;cancel 带过期 runId ⇒ control_stale;没在跑 ⇒ 只 bumped', async () => {
    const { domain, task, hub, store } = setup(undefined, { taskView: t => ({ ...t, phase: 'working', canArchive: false, waitingFor: null }) as never })
    expect(() => domain.setArchived(task.id, 'yes' as never)).toThrow('invalid_request')
    expect(() => domain.setArchived(task.id, true)).toThrow('workbench_busy')
    await expect(domain.cancel(task.id, 'nope')).rejects.toThrow('control_stale')
    await domain.cancel(task.id); expect(hub.bumped).toHaveBeenCalledWith(task.id)
    store.update(task.id, 'completed'); const ok = setup(); ok.store.update(ok.task.id, 'completed')
    expect(ok.domain.setArchived(ok.task.id, true)).toMatchObject({ archivedAt: expect.any(Number) }); expect(ok.spies.matterSync).toHaveBeenCalledTimes(1)
  })
  it('shutdown:stopping → 逐个 cancelRun(抛了手工兜底)→ 等 done → 排空 collections → shutdownComplete → 释放占用 → hub.dispose;二次调用同一 promise', async () => {
    const { domain, running, state, hub, task } = setup()
    const a = running({ identity: 'a' }); const b = running({ identity: 'b', taskId: 'b', questions: { close: () => { throw new Error('boom') } } as never })
    state.runsByTask.set(task.id, a); state.runsByTask.set('b', b); state.reservations.set('a', a); state.reservations.set('b', b)
    let order: string[] = []; const pending = new Promise<void>(r => setTimeout(() => { order.push('collection'); r() }, 10)); state.collections.add(pending); void pending.then(() => state.collections.delete(pending))
    hub.dispose.mockImplementation(() => order.push('dispose'))
    const p = domain.shutdown(); expect(domain.shutdown()).toBe(p); expect(state.stopping).toBe(true)
    expect(a.signalStop).toHaveBeenCalled(); expect(b.signalStop).toHaveBeenCalled()
    a.resolveDone(); b.resolveDone(); await vi.advanceTimersByTimeAsync(20); await p
    expect(order).toEqual(['collection', 'dispose']); expect(state.shutdownComplete).toBe(true); expect(state.reservations.size).toBe(0); expect(state.runsByTask.size).toBe(0)
  })
})
```

`Active` 的字段名以 `service/state.ts` 为准;fake timers 下 `Date.now()` 由 vitest 接管,`armIdleClose` 用它算 `at`。**不要改 store。**

- [ ] **Step 2: 跑,红**(`Cannot find module './lifecycle'`)。
- [ ] **Step 3: 新建 `service/lifecycle.ts`** —— 脚本抠:A = `function revokeCredentials(` 起到 `markUncertain` 闭合 `}`(含租约长注释、`quiet` 别名、`MAX_TIMEOUT_MS` / `msKnob` / 两个旋钮);B = `function pump()` 到闭合 `}`;C = `function cancelRun(` 到闭合 `}`;D = public `setArchived` / `async cancel` / `shutdown` 三段(各到 `    },`)。替换只有:`opts.revokeSessionToken`/`opts.reports`/`opts.recollect`/`opts.handoffGraceMs`/`opts.retainedIdleCloseMs`→`ctx.deps.*`、`opts.log?.(`→`ctx.log?.(`、`touched(`→`ctx.hub.touched(`、`bumped(`→`ctx.hub.bumped(`、`changes.dispose()`→`ctx.hub.dispose()`、`runsByTask`/`reservations`/`queue`/`runningText`/`collections`→`state.*`(逐名带边界;**别碰 `state.stopping` / `state.shutdownComplete` / `state.shutdownPromise`,它们已是 `state.` 形式**)、`const quiet=isReplied`→`const quiet=(running:Active)=>act().isReplied(running)`、以下经 `const act=()=>ctx.actions.deref('lifecycle')`(不叫 `a`:逐字搬来的 `.map(a=>…)` 会遮蔽它,PR 8 评审点名):`execute(`、`hasUndeliveredInput(`、`holdInputs(`、`collect(`、`collectTurnArtifacts(`、`captureCodeChanges(`、`runtimeSnapshot(`、`held(`、`stageFinishedNotice(`、`publishFinishedNotices(`、`matterSync(`、`taskView(`、`isReplied(`(cancelRun 里那处)。public 三段改 `function` 声明(`shutdown` 无 async 关键字;`cancel` 是 `async`)。import:`findPathBlocker` from `../scheduler`;`publicTask, TERMINAL_TASK_STATUSES` from `../store`;`type Active` from `./state`;`type WorkbenchTaskView` from `./types`;`type ServiceCtx` from `./ctx`。
- [ ] **Step 4: service.ts 接上** —— `const lifecycleDomain=makeLifecycleDomain(ctx)` + `const {revokeCredentials,cancelIdleClose,reportOnce,recollectOnce,settleQuiet,settleAfterDecision,releaseReservation,confirmLateClose,markUncertain,pump,cancelRun}=lifecycleDomain` 放在 inputs 解构之后;删 A–D;public 三个换引用;`actions.set` 的 `armIdleClose` 改成 `lifecycleDomain.armIdleClose`(其余两个用解构名);`tsc --noEmit --noUnusedLocals | grep service.ts` 清腾出来的 import(只删 import 行里的名字;`findPathBlocker` 若 execute 还用就留)。
- [ ] **Step 5: 验证** —— lifecycle 单测 12 通过;typecheck 0;`bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts` 34 文件全过(`service-lease` / `service-one-session` / `service-background` / `service-report` / `service-recollect` 走完整环);depcheck `0 errors, 21 warnings`;逐字 diff 核对。
- [ ] **Step 6: Commit** —— `workbench service 拆分 28/n:lifecycle+settle 域搬进 service/lifecycle.ts(租约/空闲收工/回报回忆/落定/派发泵/取消 + setArchived/cancel/shutdown,行为不变;环完整经 ctx.actions)`

---

### Task 3: 棘轮下调 + 全量闸门

- [ ] **Step 1**:量行数与内函数数(预期 ≈820 行 / 11),改常量与注释「当前值 = PR 9 搬完 lifecycle 域之后的实际值」(python 正则)。
- [ ] **Step 2**:全量 bun / node / typecheck / depcheck。Expected:bun 707 文件 / 9324 条(PR 8 后 706/9312 + 1 文件 12 条);node 全绿;0;`0 errors, 21 warnings`。满载偶发红按 PR 3 的办法单跑复核并记账。
- [ ] **Step 3: Commit**(含本计划)—— `workbench service 拆分 29/n:棘轮下调到搬完 lifecycle 域的实际值;附 PR 9 计划`

---

### Task 4: 推分支、PR、CI、合入后真机

同 PR 8 Task 4;本域动的是空闲收工与取消,合入后除 `selftest workbench --executor cursor --image --resume` 外,再做 spec §5 点名的真机核对:**一个文件夹连开两件事,看等待行**(第二件应显示「等 xxx 让出文件夹」而不是并行写)—— 用 `wechat-cc selftest workbench --keep` 留下 scratch,再对同一路径 `POST /v1/workbench/create` 第二件,`GET /v1/workbench/task` 看 `waitingFor`;做不了就记进 roadmap 真机账。

---

## Self-Review

- **Spec 覆盖**:§3 第 9 项 lifecycle + settle ✓;§2 `service/lifecycle.ts` ✓;§1 的环完整经 `ctx.actions` ✓;§5 域单测 / 棘轮 / 真机(含「一个文件夹连开两件事」)✓;§4 不改行为 ✓。
- **占位符**:Task 2 Step 3 按锚点抠,替换清单带边界与「别碰」清单。
- **类型一致**:Task 1 产 `deps.*`、`hub.dispose`、十个 actions,Task 2 消费;十一个解构名与 execute / start 调用点同名;`actions.set` 三个 lifecycle 动作改指向域。
- **Review Focus** 归属:1→「closeForIdle 到点」;2→「旋钮」+「armIdleClose」;3→「reportOnce / recollectOnce」;4→「cancelRun 排队分支」;5→「shutdown」。
