import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { createProviderRegistry } from '../../../app/provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../../../adapters/store/workbench/store'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentRuntimeSnapshot } from '../../../ports/agent-provider'
import { makeRuntimeState, type Active } from './state'
import { makeLifecycleDomain } from './lifecycle'
import type { ServiceCtx, ServiceDeps } from './ctx'
import type { ViewDomain } from './view'

const dbs: Db[] = []; const dirs: string[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const idle = (): AgentRuntimeSnapshot => ({ retained: true, foreground: 'idle', backgroundCount: 0, input: 'send' })

function setup(deps: Partial<ServiceDeps> = {}, over: Partial<Pick<ViewDomain, 'taskView'>> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-lifecycle-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const state = makeRuntimeState()
  const hub = { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }
  const log = vi.fn()
  const spies = {
    execute: vi.fn(async (_task: Active['task'], _text: string, _running: Active) => {}), hasUndeliveredInput: vi.fn(() => false), holdInputs: vi.fn(), collect: vi.fn(async () => {}), collectTurnArtifacts: vi.fn(), captureCodeChanges: vi.fn(async () => {}),
    stageFinishedNotice: vi.fn(), publishFinishedNotices: vi.fn(), untilAfterTurn: vi.fn(), untilStop: vi.fn(), matterSync: vi.fn(), isReplied: vi.fn(() => true), runtimeSnapshot: vi.fn(() => idle() as AgentRuntimeSnapshot | undefined),
    enqueueNotice: vi.fn(),
  }
  // matter 同步只认 ctx.deps.matters(matter-sync.ts):给一个假的,setStatus 就是 matterSync 的那次调用
  const matters = { setStatus: spies.matterSync }
  const ctx: ServiceCtx = { store, stateDir, state, hub, deps: { ownerChatId: () => 'owner', registry: createProviderRegistry(), matters: matters as never, ...deps }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, log, now: Date.now }
  const domain = makeLifecycleDomain(ctx, {
    view: { isReplied: spies.isReplied, runtimeSnapshot: spies.runtimeSnapshot, taskView: over.taskView ?? (t => ({ ...t, phase: 'replied', canArchive: true, waitingFor: null }) as never), held: () => [...state.reservations.values()] },
    artifacts: { collect: spies.collect, collectTurnArtifacts: spies.collectTurnArtifacts, captureCodeChanges: spies.captureCodeChanges },
    notices: { stageFinishedNotice: spies.stageFinishedNotice, publishFinishedNotices: spies.publishFinishedNotices, enqueueNotice: spies.enqueueNotice },
    pending: { holdInputs: spies.holdInputs, hasUndeliveredInput: spies.hasUndeliveredInput },
    until: { afterTurn: spies.untilAfterTurn, stop: spies.untilStop },
  })
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const running = (over: Partial<Active> = {}): Active => {
    let resolveDone!: () => void
    const done = new Promise<void>(r => { resolveDone = r })
    const r = { identity: 'run-1', taskId: task.id, title: task.title, task, path: project, order: 1, state: 'active', cancelled: false, finishing: false, uncertain: false, publicFinished: false, credentialsMinted: false, credentialsRevoked: false, turnSeq: 0, reportedTurn: -1, recollectedTurn: -1, done, resolveDone: () => resolveDone(), signalStop: vi.fn(), permissions: { pending: () => [], rejectAll: vi.fn() }, questions: { pending: () => [], close: vi.fn() }, ...over } as unknown as Active
    // 同 execute.start:run 自己带着「轮到它时怎么跑」,pump 调的就是它
    if (!over.launch) r.launch = text => spies.execute(r.task, text, r)
    return r
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
  it('pump:没挡路的排队 run 变 active、进占用、经 run 自带的 launch 派发;被挡的 run 让持有者重排短让位', async () => {
    const { domain, running, state, spies, project } = setup()
    const holder = running({ identity: 'holder', order: 1 }); state.reservations.set('holder', holder); state.runsByTask.set(holder.taskId, holder)
    const waiter = running({ identity: 'waiter', taskId: 'other', order: 2, state: 'queued', path: project }); state.queue.push(waiter); state.runningText.set('waiter', '做')
    domain.pump(); expect(waiter.state).toBe('queued'); expect(holder.idleClose).toMatchObject({ reason: 'handoff' }); expect(spies.execute).not.toHaveBeenCalled()
    state.reservations.clear(); domain.pump(); await Promise.resolve()
    expect(waiter.state).toBe('active'); expect(state.reservations.get('waiter')).toBe(waiter); expect(state.queue).toEqual([]); expect(spies.execute).toHaveBeenCalledWith(waiter.task, '做', waiter)
  })
  it('cancelRun 排队分支:任务 cancelled、stageFinishedNotice + publishFinishedNotices 各一次、matter done、出队、pump', () => {
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

// 2026-10 变异测试第二轮:派发泵里「起不来」那一支(launch 失败)整段没有测试跑到 —— 收卡、撤凭据、还文件夹、
// 起过会话的挂成「没确认退出」继续占着;归档撤销时 matter 回到哪一态也没被钉住。
describe('makeLifecycleDomain · 起不来与归档撤销(变异测试第二轮)', () => {
  const queued = (s: ReturnType<typeof setup>, over: Partial<Active> = {}) => {
    const r = s.running({ state: 'queued', launch: async () => { throw new Error('spawn failed') }, ...over })
    s.state.queue.push(r); s.state.runsByTask.set(r.taskId, r); s.state.runningText.set(r.identity, '做')
    return r
  }
  it('launch 失败、还没起会话 ⇒ 收掉提问和权限卡(ended)、标完成、还文件夹', async () => {
    const s = setup()
    const r = queued(s)
    s.domain.pump(); await vi.advanceTimersByTimeAsync(0)
    expect((r.questions as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1)
    expect(r.permissions.rejectAll).toHaveBeenCalledWith('ended')
    expect(s.hub.bumped).toHaveBeenCalledWith(r.taskId)
    expect(r.publicFinished).toBe(true)
    expect(r.uncertain).toBe(false)
    expect(s.state.reservations.has(r.identity)).toBe(false)
    expect(s.state.runsByTask.has(r.taskId)).toBe(false)
  })
  it('已取消的 run 起不来 ⇒ 权限卡按 cancelled 拒;发过凭据 ⇒ 撤掉', async () => {
    const revoke = vi.fn()
    const s = setup({ revokeSessionToken: revoke })
    const r = queued(s, { cancelled: true, credentialsMinted: true })
    s.domain.pump(); await vi.advanceTimersByTimeAsync(0)
    expect(r.permissions.rejectAll).toHaveBeenCalledWith('cancelled')
    expect(revoke).toHaveBeenCalledWith(`workbench/${r.taskId}`)
  })
  it('起过会话再失败 ⇒ 挂成「没确认退出」,文件夹继续占着', async () => {
    const s = setup()
    const r = queued(s, { session: {} as never })
    s.domain.pump(); await vi.advanceTimersByTimeAsync(0)
    expect(r.uncertain).toBe(true)
    expect(r.state).toBe('uncertain')
    expect(s.state.reservations.get(r.identity)).toBe(r)
    expect(r.publicFinished).toBe(true)
  })
  it('已经公开收尾的 run 再报 launch 失败 ⇒ 什么都不动', async () => {
    const s = setup()
    const r = queued(s, { launch: async () => { r.publicFinished = true; throw new Error('late') } })
    s.domain.pump(); await vi.advanceTimersByTimeAsync(0)
    expect(r.permissions.rejectAll).not.toHaveBeenCalled()
    expect(s.state.reservations.get(r.identity)).toBe(r)
  })
  it.each([
    // [任务状态, 视图 phase, 撤销归档后 matter 的状态]
    ['interrupted', 'working', 'open'],
    ['completed', 'working', 'done'],
    ['running', 'replied', 'replied'],
    ['running', 'working', 'open'],
  ] as const)('取消归档:%s / %s ⇒ matter %s', (status, phase, want) => {
    const s = setup(undefined, { taskView: t => ({ ...t, phase, canArchive: true, waitingFor: null }) as never })
    s.store.update(s.task.id, status)
    s.domain.setArchived(s.task.id, false)
    expect(s.spies.matterSync).toHaveBeenLastCalledWith(s.task.id, want)
  })
})

// 2026-10-28 变异测试第三轮:lifecycle 的活变异逐条分类,「看得见、没人断言」的这一批(分类见
// docs/maintainer/mutation-baseline-2026-10.md「lifecycle 活变异逐条分类」)。
describe('makeLifecycleDomain · 活变异逐条分类后补的', () => {
  const holding = (s: ReturnType<typeof setup>, over: Partial<Active> = {}) => {
    const r = s.running(over); s.state.reservations.set(r.identity, r); s.state.runsByTask.set(r.taskId, r); return r
  }
  const waiter = (s: ReturnType<typeof setup>, over: Partial<Active>) => {
    const w = s.running({ state: 'queued', ...over }); s.state.queue.push(w); return w
  }
  const lastEvent = (s: ReturnType<typeof setup>) => s.store.events(s.task.id).at(-1)?.text

  it('短让位只看「排队里挡在这个文件夹上的」:别的文件夹有人排队 ⇒ 仍按长空闲', () => {
    const s = setup(); const r = holding(s)
    waiter(s, { identity: 'far', taskId: 'far', order: 2, path: join(s.project, '..', 'elsewhere') })
    s.domain.armIdleClose(r)
    expect(r.idleClose).toMatchObject({ reason: 'idle', at: Date.now() + 600_000 })
  })

  it('到点收工的那句话:短让位写短让位的秒数、让给挡在这个文件夹上的那条、标题里的换行折成一个空格', () => {
    const s = setup(); const r = holding(s)
    waiter(s, { identity: 'far', taskId: 'far', title: '别处的事', order: 2, path: join(s.project, '..', 'elsewhere') })
    waiter(s, { identity: 'near', taskId: 'near', title: '下一件\r\n第二行', order: 3 })
    s.domain.armIdleClose(r); expect(r.idleClose?.reason).toBe('handoff')
    vi.advanceTimersByTime(15_000)
    expect(lastEvent(s)).toBe('空闲 15 秒后自动收工，文件夹让给「下一件 第二行」；要接着说直接发下一句，会按原会话恢复。')
    expect(r.cancelled).toBe(true)
  })

  it('撤掉的计时器不会再响:撤销后过一会儿重新武装,按新的到点收工,不按旧的', () => {
    const s = setup(); const r = holding(s)
    s.domain.armIdleClose(r)                                    // t=0,到点 600 s
    s.domain.cancelIdleClose(r)
    vi.advanceTimersByTime(300_000); s.domain.armIdleClose(r)   // t=300 s,到点 900 s
    vi.advanceTimersByTime(300_000)                             // t=600 s:旧的那个若还在,这里就收工了
    expect(r.cancelled).toBe(false); expect(s.store.events(s.task.id)).toEqual([])
    vi.advanceTimersByTime(300_000)
    expect(r.cancelled).toBe(true)
  })

  it('长空闲被短让位替换后,旧的长空闲计时器不会再响', () => {
    const s = setup(); const r = holding(s)
    s.domain.armIdleClose(r)                                    // t=0:长空闲,到点 600 s
    const w = waiter(s, { identity: 'near', taskId: 'near', order: 2 })
    s.domain.armIdleClose(r); expect(r.idleClose?.reason).toBe('handoff')
    s.spies.hasUndeliveredInput.mockReturnValueOnce(true)
    vi.advanceTimersByTime(15_000)                              // 短让位到点,复查时有未投递的补充 ⇒ 不收
    expect(r.cancelled).toBe(false)
    s.state.queue.splice(s.state.queue.indexOf(w), 1)
    vi.advanceTimersByTime(85_000); s.domain.armIdleClose(r)    // t=100 s:重新武装长空闲,到点 700 s
    vi.advanceTimersByTime(500_000)                             // t=600 s
    expect(r.cancelled).toBe(false)
    vi.advanceTimersByTime(100_000)
    expect(r.cancelled).toBe(true)
  })

  it.each([
    ['还有后台子任务在写', { backgroundCount: 1 }],
    ['会话不保留', { retained: false }],
    ['前台还在跑', { foreground: 'running' }],
  ] as const)('settleQuiet:%s ⇒ 不收成果、不标答复、不武装', (_name, over) => {
    const s = setup(); const r = holding(s)
    s.spies.runtimeSnapshot.mockReturnValue({ ...idle(), ...over } as AgentRuntimeSnapshot)
    s.domain.settleQuiet(r)
    expect(s.spies.collectTurnArtifacts).not.toHaveBeenCalled(); expect(s.spies.matterSync).not.toHaveBeenCalled(); expect(r.idleClose).toBeUndefined()
  })

  it('settleQuiet 安静了 ⇒ 排一次「做到条件成立为止」的检查;那一步抛了 ⇒ 记日志,落定照走', () => {
    const s = setup(); const r = holding(s)
    s.domain.settleQuiet(r); expect(s.spies.untilAfterTurn).toHaveBeenCalledWith(r)
    const t = setup(); const q = holding(t)
    t.spies.untilAfterTurn.mockImplementation(() => { throw new Error('until down') })
    expect(() => t.domain.settleQuiet(q)).not.toThrow()
    expect(t.log).toHaveBeenCalledWith('WORKBENCH_UNTIL', `afterTurn failed for ${q.taskId}: until down`); expect(q.idleClose).toBeDefined()
  })

  it.each([
    ['已取消', { cancelled: true }],
    ['在收尾', { finishing: true }],
  ] as const)('settleAfterDecision:%s ⇒ 不重新落定(不收成果、matter 不回到已答复)', (_name, over) => {
    const s = setup(); const r = holding(s, over)
    s.domain.settleAfterDecision(r)
    expect(s.spies.collectTurnArtifacts).not.toHaveBeenCalled(); expect(s.spies.matterSync).not.toHaveBeenCalled()
  })

  it('重启后核对:库读不出来 ⇒ 不抛、什么都不占', () => {
    const s = setup()
    vi.spyOn(s.store, 'writerHolds').mockImplementation(() => { throw new Error('db locked') })
    expect(() => s.domain.adoptWriters()).not.toThrow()
    expect(s.state.writerOrphans.size).toBe(0)
  })

  it('主人确认「已经结束」:任务还有一条正常在跑的 run ⇒ workbench_busy,占用不动', async () => {
    const s = setup(); const r = holding(s)
    s.store.update(s.task.id, 'interrupted', 'writer_not_closed')
    await expect(s.domain.confirmWriterExited(s.task.id)).rejects.toThrow('workbench_busy')
    expect(s.state.reservations.get(r.identity)).toBe(r); expect(s.store.get(s.task.id).error).toBe('writer_not_closed')
  })

  it('主人确认本进程里那条「没确认退出」的 run:不收成果(没确认退出时的半成品),解除占用、留一句', async () => {
    const s = setup(); const r = holding(s, { uncertain: true, state: 'uncertain', publicFinished: true })
    s.store.update(s.task.id, 'interrupted', 'writer_not_closed')
    const view = await s.domain.confirmWriterExited(s.task.id)
    expect(s.spies.collect).not.toHaveBeenCalled()
    expect(view.error).toBeNull(); expect(r.uncertain).toBe(false); expect(s.state.reservations.has(r.identity)).toBe(false)
    expect(lastEvent(s)).toBe('主人确认执行程序已经结束，这条占用解除。')
  })

  it('cancelRun:session.cancel 同步就抛 ⇒ 时间线留一句「正在等待执行程序退出」,取消照样生效', () => {
    const s = setup()
    const r = holding(s, { session: { cancel: () => { throw new Error('sync boom') } } as never })
    s.domain.cancelRun(r)
    expect(r.cancelled).toBe(true); expect(s.store.events(s.task.id).at(-1)).toMatchObject({ kind: 'system', text: '已请求停止，正在等待执行程序退出。' })
    expect(s.hub.touched).toHaveBeenLastCalledWith(s.task.id)
  })

  it('cancelRun 在跑的:收掉提问、权限卡按 cancelled 拒、优雅取消(没冻住的树不走 terminate)', () => {
    const s = setup()
    const terminate = vi.fn(), cancel = vi.fn(async () => {})
    const r = holding(s, { session: { cancel, suspension: { suspend: vi.fn(), resume: vi.fn(), terminate } } as never })
    s.domain.cancelRun(r)
    expect((r.questions as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled()
    expect(r.permissions.rejectAll).toHaveBeenCalledWith('cancelled')
    expect(cancel).toHaveBeenCalledTimes(1); expect(terminate).not.toHaveBeenCalled()
  })

  it('cancelRun 排队的:出队且不会被随后的 pump 起起来;排在它后面、只被它挡着的那条马上起;matter 记 done', async () => {
    const s = setup()
    const holder = holding(s, { identity: 'h', taskId: 'h', path: join(s.project, 'a'), order: 1 })
    const a = s.running({ identity: 'a', state: 'queued', path: s.project, order: 2 })              // 被 holder 挡(嵌套)
    const b = s.running({ identity: 'b', taskId: 'b', state: 'queued', path: join(s.project, 'b'), order: 3 })  // 只被排在前面的 a 挡
    s.state.queue.push(a, b); s.state.runsByTask.set(a.taskId, a); s.state.runsByTask.set('b', b); s.state.runningText.set('a', '甲'); s.state.runningText.set('b', '乙')
    s.domain.pump(); expect([a.state, b.state]).toEqual(['queued', 'queued'])
    s.domain.cancelRun(a); await vi.advanceTimersByTimeAsync(0)
    expect(s.spies.execute).toHaveBeenCalledTimes(1); expect(s.spies.execute).toHaveBeenCalledWith(b.task, '乙', b)
    expect(s.state.reservations.has('a')).toBe(false); expect(s.state.queue).toEqual([])
    expect(s.spies.matterSync).toHaveBeenCalledWith(a.taskId, 'done')
    expect(holder.cancelled).toBe(false)
  })

  it('派发失败 ⇒ done 也要 resolve(shutdown 在等它)', async () => {
    const s = setup()
    const r = s.running({ state: 'queued', launch: async () => { throw new Error('spawn failed') } })
    s.state.queue.push(r); s.state.runsByTask.set(r.taskId, r); s.state.runningText.set(r.identity, '做')
    let done = false; void r.done.then(() => { done = true })
    s.domain.pump(); await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it.each([
    // [情形, run 的初值, capture, 收不收成果, 之后的 uncertain, 之后的 state, 占用还在不在]
    ['不是「没确认退出」的 run', { uncertain: false, state: 'active', publicFinished: true }, true, false, false, 'active', true],
    ['没确认退出、还没公开收尾、不收成果', { uncertain: true, state: 'uncertain', publicFinished: false }, false, false, false, 'active', true],
    ['没确认退出、已公开收尾、收成果', { uncertain: true, state: 'uncertain', publicFinished: true }, true, true, false, 'active', false],
  ] as const)('confirmLateClose:%s', async (_name, over, capture, collected, uncertain, state, held) => {
    const s = setup(); const r = holding(s, over as Partial<Active>)
    await s.domain.confirmLateClose(r, capture)
    expect(s.spies.collect).toHaveBeenCalledTimes(collected ? 1 : 0)
    expect(r.uncertain).toBe(uncertain); expect(r.state).toBe(state); expect(s.state.reservations.has(r.identity)).toBe(held)
  })

  it('主人亲手停 ⇒「做到条件成立为止」也停,写清原因', async () => {
    const s = setup()
    await s.domain.cancel(s.task.id)
    expect(s.spies.untilStop).toHaveBeenCalledWith(s.task.id, '你停下了这件事')
  })

  it('shutdown:cancelRun 抛了 ⇒ 手工兜底也要标取消、按 cancelled 拒卡、撤凭据、请求会话取消', async () => {
    const revoke = vi.fn()
    const s = setup({ revokeSessionToken: revoke })
    const cancel = vi.fn(async () => {})
    const b = s.running({ identity: 'b', taskId: 'b', credentialsMinted: true, session: { cancel } as never, questions: { close: () => { throw new Error('boom') } } as never })
    s.state.runsByTask.set('b', b); s.state.reservations.set('b', b)
    const p = s.domain.shutdown(); b.resolveDone(); await p
    expect(b.cancelled).toBe(true); expect(b.permissions.rejectAll).toHaveBeenCalledWith('cancelled')
    expect(revoke).toHaveBeenCalledWith('workbench/b'); expect(cancel).toHaveBeenCalledTimes(1)
  })

  describe('没确认退出的守望(进程组证据)', () => {
    const BOOT = Date.parse('2026-10-28T00:00:00Z')
    const withGroups = (s: ReturnType<typeof setup>, groups: number[], over: Partial<Active> = {}) =>
      holding(s, { uncertain: true, state: 'uncertain', publicFinished: true, session: { processGroups: () => groups } as never, ...over })
    const stuck = (s: ReturnType<typeof setup>, groups: number[], boot?: number) => {
      s.store.update(s.task.id, 'interrupted', 'writer_not_closed'); s.store.setWriterGroups(s.task.id, groups, boot)
    }

    it.each([
      // [情形, 记下的组, 记没记开机时刻, 还活着的组, 重启后还占着吗]
      ['两个组里还有一个活着', [12, 13], true, [13], true],
      ['旧记录没有开机时刻、组还活着(不能当成「电脑重启过」)', [3], false, [3], true],
      ['组全没了', [4], true, [], false],
    ] as const)('重启后核对:%s', (_name, groups, withBoot, alive, held) => {
      const s = setup({ writerGroupAlive: g => (alive as readonly number[]).includes(g), bootTimeMs: () => BOOT })
      stuck(s, [...groups], withBoot ? BOOT : undefined)
      s.domain.adoptWriters()
      expect(s.state.writerOrphans.has(s.task.id)).toBe(held)
      expect(s.store.get(s.task.id).error).toBe(held ? 'writer_not_closed' : null)
      if (!held) {
        expect(s.store.events(s.task.id).at(-1)).toMatchObject({ kind: 'system', text: '重启后核对：当时没确认退出的执行程序已经不在了，这条占用随之解除。' })
        expect(s.hub.touched).toHaveBeenCalledWith(s.task.id)
      }
    })

    it('重启后留下的占用:组还活着就一直占着,守望每一拍都不放', async () => {
      const s = setup({ writerGroupAlive: () => true, bootTimeMs: () => BOOT, writerWatchMs: 20 })
      stuck(s, [5], BOOT); s.domain.adoptWriters()
      await vi.advanceTimersByTimeAsync(100)
      expect(s.state.writerOrphans.has(s.task.id)).toBe(true); expect(s.store.get(s.task.id).error).toBe('writer_not_closed')
    })

    it('主人确认重启后留下的占用 ⇒ 当场派发在等这个文件夹的任务(不等下一拍守望)', async () => {
      const alive = new Set([6])
      const s = setup({ writerGroupAlive: g => alive.has(g), bootTimeMs: () => BOOT })
      stuck(s, [6], BOOT); s.domain.adoptWriters()
      const w = s.running({ identity: 'w', taskId: 'w', state: 'queued', order: 2 }); s.state.queue.push(w); s.state.runningText.set('w', '等着')
      s.domain.pump(); expect(w.state).toBe('queued')
      alive.clear()
      await s.domain.confirmWriterExited(s.task.id); await vi.advanceTimersByTimeAsync(0)
      expect(s.spies.execute).toHaveBeenCalledWith(w.task, '等着', w)
      expect(s.hub.touched).toHaveBeenCalledWith(s.task.id)
    })

    it('本进程里关不掉的:旁边有正常在跑的任务也照样守望;组没了 ⇒ 收成果、解除、留一句;没交出进程组的那条不动', async () => {
      const alive = new Set([7])
      const s = setup({ writerGroupAlive: g => alive.has(g), writerWatchMs: 20 })
      holding(s, { identity: 'x', taskId: 'x', path: join(s.project, '..', 'elsewhere') })     // 正常在跑、没有进程组
      const blind = holding(s, { identity: 'v', taskId: 'v', uncertain: true, state: 'uncertain', publicFinished: true, path: join(s.project, '..', 'other') })
      const u = withGroups(s, [7])
      s.domain.markUncertain(u)
      expect(s.state.writerWatch).toBeDefined()
      alive.clear(); await vi.advanceTimersByTimeAsync(20)
      expect(u.uncertain).toBe(false); expect(s.state.reservations.has(u.identity)).toBe(false)
      expect(s.spies.collect).toHaveBeenCalledTimes(1); expect(s.spies.collect).toHaveBeenCalledWith(u)
      expect(s.store.events(s.task.id).at(-1)).toMatchObject({ kind: 'system', text: '执行程序已经退出，这条占用随之解除。' })
      expect(s.hub.touched).toHaveBeenCalledWith(s.task.id)
      expect(blind.uncertain).toBe(true); expect(s.state.reservations.get('v')).toBe(blind)
    })

    it('迟到的收尾还没做完时,下一拍守望不会再做一遍', async () => {
      let finish!: () => void
      const s = setup({ writerGroupAlive: () => false, writerWatchMs: 20 })
      s.spies.collect.mockImplementation(() => new Promise<void>(r => { finish = r }))
      const u = withGroups(s, [8]); s.domain.markUncertain(u)
      await vi.advanceTimersByTimeAsync(60)
      expect(s.spies.collect).toHaveBeenCalledTimes(1)
      finish(); await vi.advanceTimersByTimeAsync(0)
      expect(s.store.events(s.task.id).filter(e => e.text === '执行程序已经退出，这条占用随之解除。')).toHaveLength(1)
    })

    it('停机中挂上「没确认退出」⇒ 不再起守望', () => {
      const s = setup({ writerGroupAlive: () => true, writerWatchMs: 20 })
      s.state.stopping = true
      s.domain.markUncertain(withGroups(s, [9]))
      expect(s.state.writerWatch).toBeUndefined()
    })

    it('shutdown 之后守望不再查进程组(重启留下的 + 本进程关不掉的也只有一个守望,停机时一并撤掉)', async () => {
      const alive = vi.fn(() => true)
      const s = setup({ writerGroupAlive: alive, bootTimeMs: () => BOOT, writerWatchMs: 20 })
      stuck(s, [10], BOOT); s.domain.adoptWriters()                         // 重启留下的:停机不动它,守望若还在就会查它
      const u = withGroups(s, [11], { identity: 'u2', taskId: 'u2', path: join(s.project, '..', 'other') })
      s.domain.markUncertain(u)
      const p = s.domain.shutdown(); u.resolveDone(); await p
      alive.mockClear(); await vi.advanceTimersByTimeAsync(100)
      expect(alive).not.toHaveBeenCalled()
    })
  })

  describe('网络守护暂停', () => {
    const suspendable = (suspend: () => boolean) => ({
      callTarget: () => ({ provider: 'claude', model: 'claude-opus-5' }),
      suspension: { suspend: vi.fn(suspend), resume: vi.fn(), terminate: vi.fn() },
    })
    const live = (s: ReturnType<typeof setup>, session: object, over: Partial<Active> = {}) =>
      holding(s, { session: session as never, execution: { model: null } as never, permissions: { pending: () => [], rejectAll: vi.fn(), pause: vi.fn(), resume: vi.fn() } as never, ...over })
    const elsewhere = (s: ReturnType<typeof setup>) => ({ identity: 'o', taskId: 'o', path: join(s.project, '..', 'other') })

    it('判「要不要保护」的回调抛了 ⇒ 当作不需要保护:不冻、不停', () => {
      const s = setup(); const session = suspendable(() => true); const r = live(s, session)
      expect(s.domain.suspendForNetwork(() => { throw new Error('selector broke') })).toEqual({ suspended: 0, stopped: 0 })
      expect(session.suspension.suspend).not.toHaveBeenCalled(); expect(r.networkSuspended).toBeUndefined(); expect(r.cancelled).toBe(false)
    })
    it('冻的那一下抛了 ⇒ 不算冻住,退回按取消停下(不能让一棵没冻住的树挂着「已暂停」接着跑)', () => {
      const s = setup(); const r = live(s, suspendable(() => { throw new Error('EPERM') }))
      expect(s.domain.suspendForNetwork(() => 'VPN 掉了。')).toEqual({ suspended: 0, stopped: 1 })
      expect(r.networkSuspended).toBeUndefined(); expect(r.cancelled).toBe(true)
      expect(s.store.events(s.task.id)).toContainEqual(expect.objectContaining({ kind: 'system', text: '网络未受保护：VPN 掉了。这个执行者暂停不了，已停止本轮，恢复后可以继续。' }))
    })

    it.each([
      ['已取消', { cancelled: true }],
      ['在收尾', { finishing: true }],
      ['还在排队(轮到它时闸门按调用拦)', { state: 'queued' }],
      ['没确认退出', { state: 'uncertain', uncertain: true }],
      ['已经冻住了', { networkSuspended: { since: 1 } }],
    ] as const)('不碰的 run:%s ⇒ 连「要不要保护」都不问', (_name, over) => {
      const s = setup(); const session = suspendable(() => true)
      const r = live(s, session); Object.assign(r, over)
      const select = vi.fn(() => 'VPN 掉了。')
      expect(s.domain.suspendForNetwork(select)).toEqual({ suspended: 0, stopped: 0 })
      expect(select).not.toHaveBeenCalled(); expect(session.suspension.suspend).not.toHaveBeenCalled(); expect(s.store.events(s.task.id)).toEqual([])
    })

    it('执行者已不在登记表里也照样判(网络守护不能因此放过它)', () => {
      const s = setup(); live(s, suspendable(() => true))
      const select = vi.fn(() => 'VPN 掉了。')
      expect(s.domain.suspendForNetwork(select)).toEqual({ suspended: 1, stopped: 0 })
      expect(select).toHaveBeenCalledWith({ providerId: 'claude', model: null, target: expect.objectContaining({ provider: 'claude' }) })
    })

    it('冻住:时间线一句、订了提醒的发一条(标题换行折成空格、按冻住时刻去重)、撤掉已排的空闲收工', () => {
      const s = setup(); const r = live(s, suspendable(() => true)); r.title = '事\r\n二'
      s.domain.armIdleClose(r); expect(r.idleClose).toBeDefined()
      expect(s.domain.suspendForNetwork(() => 'VPN 掉了。')).toEqual({ suspended: 1, stopped: 0 })
      const since = r.networkSuspended!.since
      expect(s.store.events(s.task.id).at(-1)).toMatchObject({ kind: 'system', text: '已暂停(网络未受保护)：VPN 掉了。恢复后自动继续。' })
      expect(s.spies.enqueueNotice).toHaveBeenCalledWith(r.task, r.identity, 'interrupted',
        `事 二 · ${r.taskId}\nclaude · 已暂停(网络未受保护)\n\nVPN 掉了。恢复后自动继续。\n\n查看：任务 ${r.taskId}`, `network-suspend-${since}`)
      vi.advanceTimersByTime(600_000)
      expect(r.cancelled).toBe(false)
    })

    it('恢复:只放开冻住的那条,留一句;放开后重新评估安静、起空闲收工', () => {
      const s = setup()
      const frozen = live(s, suspendable(() => true))
      const other = live(s, suspendable(() => true), elsewhere(s))
      let first = true
      s.domain.suspendForNetwork(() => { const m = first ? 'VPN 掉了。' : null; first = false; return m })
      expect(frozen.networkSuspended).toBeDefined(); expect(other.networkSuspended).toBeUndefined()
      expect(frozen.idleClose).toBeUndefined()
      expect(s.domain.resumeFromNetwork()).toBe(1)
      expect(frozen.networkSuspended).toBeUndefined(); expect(frozen.idleClose).toBeDefined()
      expect(s.store.events(s.task.id).at(-1)).toMatchObject({ kind: 'system', text: '网络恢复，已继续。' })
      expect(s.store.events('o')).toEqual([])
      expect(other.permissions.resume).not.toHaveBeenCalled()
    })

    it('暂停到顶:只停冻住的那条;「做到条件成立为止」跟着停并写原因;时间线写主人那句', () => {
      const s = setup()
      const frozen = live(s, suspendable(() => true)); frozen.networkSuspended = { since: 1 }
      const other = live(s, suspendable(() => true), elsewhere(s))
      expect(s.domain.stopSuspendedForNetwork('网络一直没恢复，任务已停止。')).toBe(1)
      expect(frozen.cancelled).toBe(true); expect(other.cancelled).toBe(false)
      expect(s.spies.untilStop).toHaveBeenCalledTimes(1); expect(s.spies.untilStop).toHaveBeenCalledWith(frozen.taskId, '网络一直没恢复,任务停了')
      expect(s.store.events(s.task.id)).toContainEqual(expect.objectContaining({ kind: 'system', text: '网络一直没恢复，任务已停止。' }))
    })
  })
})
