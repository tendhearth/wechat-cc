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
  const running = (over: Partial<Active> = {}): Active => {
    let resolveDone!: () => void
    const done = new Promise<void>(r => { resolveDone = r })
    return { identity: 'run-1', taskId: task.id, title: task.title, task, path: project, order: 1, state: 'active', cancelled: false, finishing: false, uncertain: false, publicFinished: false, credentialsMinted: false, credentialsRevoked: false, turnSeq: 0, reportedTurn: -1, recollectedTurn: -1, done, resolveDone: () => resolveDone(), signalStop: vi.fn(), permissions: { pending: () => [], rejectAll: vi.fn() }, questions: { pending: () => [], close: vi.fn() }, ...over } as unknown as Active
  }
  return { store, state, hub, log, domain, task, project, running, spies }
}

describe('makeLifecycleDomain · 旋钮与计时', () => {
  it('旋钮:没传 ⇒ 缺省 15 s / 600 s;函数抛错 ⇒ 缺省;负数 / Infinity(非有限)⇒ 缺省;很大的有限数 ⇒ 封顶 2³¹−1;0 合法', () => {
    expect(setup().domain.handoffGraceMs()).toBe(15_000); expect(setup().domain.retainedIdleMs()).toBe(600_000)
    expect(setup({ handoffGraceMs: () => { throw new Error('x') } }).domain.handoffGraceMs()).toBe(15_000)
    expect(setup({ retainedIdleCloseMs: -1 }).domain.retainedIdleMs()).toBe(600_000)
    expect(setup({ retainedIdleCloseMs: Infinity }).domain.retainedIdleMs()).toBe(600_000)
    expect(setup({ retainedIdleCloseMs: 1e15 }).domain.retainedIdleMs()).toBe(2_147_483_647)
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
    const { domain, running, state, spies } = setup()
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
  it('setArchived / cancel:非布尔 ⇒ invalid_request;不能归档 ⇒ workbench_busy;cancel 带过期 runId ⇒ control_stale;没在跑 ⇒ 只 bumped;能归档 ⇒ 归档 + matter', async () => {
    const { domain, task, hub } = setup(undefined, { taskView: t => ({ ...t, phase: 'working', canArchive: false, waitingFor: null }) as never })
    expect(() => domain.setArchived(task.id, 'yes' as never)).toThrow('invalid_request')
    expect(() => domain.setArchived(task.id, true)).toThrow('workbench_busy')
    await expect(domain.cancel(task.id, 'nope')).rejects.toThrow('control_stale')
    await domain.cancel(task.id); expect(hub.bumped).toHaveBeenCalledWith(task.id)
    const ok = setup(); ok.store.update(ok.task.id, 'completed')
    expect(ok.domain.setArchived(ok.task.id, true)).toMatchObject({ archivedAt: expect.any(Number) }); expect(ok.spies.matterSync).toHaveBeenCalledTimes(1)
  })
  it('shutdown:stopping → 逐个 cancelRun(抛了手工兜底)→ 等 done → 排空 collections → shutdownComplete → 释放占用 → hub.dispose;二次调用同一 promise', async () => {
    const { domain, running, state, hub, task } = setup()
    const a = running({ identity: 'a' }); const b = running({ identity: 'b', taskId: 'b', questions: { close: () => { throw new Error('boom') } } as never })
    state.runsByTask.set(task.id, a); state.runsByTask.set('b', b); state.reservations.set('a', a); state.reservations.set('b', b)
    const order: string[] = []; const pending = new Promise<void>(r => setTimeout(() => { order.push('collection'); r() }, 10)); state.collections.add(pending); void pending.then(() => state.collections.delete(pending))
    hub.dispose.mockImplementation(() => { order.push('dispose') })
    const p = domain.shutdown(); expect(domain.shutdown()).toBe(p); expect(state.stopping).toBe(true)
    expect(a.signalStop).toHaveBeenCalled(); expect(b.signalStop).toHaveBeenCalled()
    a.resolveDone(); b.resolveDone(); await vi.advanceTimersByTimeAsync(20); await p
    expect(order).toEqual(['collection', 'dispose']); expect(state.shutdownComplete).toBe(true); expect(state.reservations.size).toBe(0); expect(state.runsByTask.size).toBe(0)
  })
})
