import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { createProviderRegistry } from '../../../app/provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../../../adapters/store/workbench/store'
import { MANAGED_NATIVE_CAPABILITIES } from '../../../domain/workbench/executor-capabilities'
import { PROVIDER_EXECUTION_CHOICE } from '../../../adapters/store/workbench/execution-settings'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentProvider } from '../../../ports/agent-provider'
import { makeRuntimeState, type Active } from './state'
import { makeInputsDomain } from './inputs'
import { directoryIdentity } from './directory-identity'
import type { ServiceCtx } from './ctx'
import { makePendingInputs } from './pending-inputs'
import { makeMatterStore } from '../../../adapters/store/matters-store'
import { randomUUID } from 'node:crypto'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const provider: AgentProvider = { async spawn() { throw new Error('not spawned') } }
const unused = () => { throw new Error('unused') }
const REQ = '11111111-1111-4111-8111-111111111111'

function setup(over: { owner?: string | null; networkGate?: ServiceCtx['deps']['networkGate'] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-inputs-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const hub = { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }
  const spies = { armIdleClose: vi.fn(), cancelIdleClose: vi.fn(), settleAfterDecision: vi.fn(), start: vi.fn(), continuation: vi.fn(() => ({ mode: 'new' } as never)), inputMode: vi.fn(() => 'queue' as 'steer' | 'send' | 'queue'), requireInput: vi.fn() }
  const ctx: ServiceCtx = { store, stateDir, state, hub, deps: { ownerChatId: () => (over.owner === undefined ? 'owner' : over.owner), registry, ...(over.networkGate ? { networkGate: over.networkGate } : {}) }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now }
  const domain = makeInputsDomain(ctx, {
    admission: { continuation: spies.continuation, requireInput: (id, ...rest) => { spies.requireInput(id, ...rest); return registry.get(id) as never } },
    attachments: { selectAttachments: () => [], continuationAttachmentScope: () => undefined },
    view: { inputMode: spies.inputMode },
    lifecycle: { armIdleClose: spies.armIdleClose, cancelIdleClose: spies.cancelIdleClose, settleAfterDecision: spies.settleAfterDecision },
    pending: makePendingInputs(ctx),
  })
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const running = (over: Partial<Active> = {}): Active => ({ identity: 'run-1', taskId: task.id, title: task.title, task, path: project, directoryIdentity: directoryIdentity(project), execution: PROVIDER_EXECUTION_CHOICE, cancelled: false, finishing: false, uncertain: false, delivering: false, permissions: { pending: () => [], resolve: () => true }, questions: { pending: () => [], resolve: () => true }, ...over } as unknown as Active)
  const pending = (text = '补一句') => store.liveInputs.add({ id: REQ, taskId: task.id, runId: 'run-1', text, attachments: [], execution: PROVIDER_EXECUTION_CHOICE })
  return { store, state, hub, domain, task, project, running, spies, pending, db }
}

describe('makeInputsDomain · 拍板与撤回', () => {
  it('withdrawInput:不存在 / 不是 pending ⇒ input_stale;pending ⇒ withdrawn + bumped', () => {
    const { domain, task, store, hub, pending } = setup()
    expect(() => domain.withdrawInput(task.id, REQ)).toThrow('input_stale')
    pending(); domain.withdrawInput(task.id, REQ)
    expect(store.liveInputs.get(REQ)!.status).toBe('withdrawn'); expect(hub.bumped).toHaveBeenCalledWith(task.id)
    expect(() => domain.withdrawInput(task.id, REQ)).toThrow('input_stale')
  })
  it('resolveAnswer / resolvePermission:没 run ⇒ *_stale;拍板后 bumped 且经注入的 lifecycle.settleAfterDecision 补一次落定;非法 decision ⇒ invalid_decision', () => {
    const { domain, task, state, running, spies, hub } = setup()
    expect(() => domain.resolveAnswer(task.id, 'q1', {})).toThrow('question_stale')
    expect(() => domain.resolvePermission(task.id, 'p1', 'allow')).toThrow('permission_stale')
    expect(() => domain.resolvePermission(task.id, 'p1', 'maybe' as never)).toThrow('invalid_decision')
    state.runsByTask.set(task.id, running())
    domain.resolveAnswer(task.id, 'q1', {}); domain.resolvePermission(task.id, 'p1', 'deny')
    expect(spies.settleAfterDecision).toHaveBeenCalledTimes(2); expect(hub.bumped).toHaveBeenCalledTimes(2)
  })
})

describe('makeInputsDomain · 补充的投递', () => {
  it('submitInput:带 execution ⇒ invalid_execution;被 hold 中 ⇒ input_storage_unavailable;没 run ⇒ input_stale;stopping ⇒ workbench_stopping', async () => {
    const { domain, task, state } = setup()
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x', execution: {} } as never)).rejects.toThrow('invalid_execution')
    state.autoContinueBlocked.add(task.id)
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x' })).rejects.toThrow('input_storage_unavailable')
    state.autoContinueBlocked.clear()
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x' })).rejects.toThrow('input_stale')
    state.stopping = true
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x' })).rejects.toThrow('workbench_stopping')
  })
  it('submitInput:没有 runtime 也没有 steer ⇒ 存成 pending 返回;入口先 cancelIdleClose;同 id 重发同文 ⇒ 幂等返回,异文 ⇒ input_conflict', async () => {
    const { domain, task, state, running, spies, store } = setup()
    state.runsByTask.set(task.id, running())
    const saved = await domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: '补一句' })
    expect(saved).toMatchObject({ id: REQ, status: 'pending', text: '补一句' }); expect(spies.cancelIdleClose).toHaveBeenCalledTimes(1)
    expect(await domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: '补一句' })).toMatchObject({ id: REQ })
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: '另一句' })).rejects.toThrow('input_conflict')
    expect(store.liveInputs.count(task.id)).toBe(1)
  })
  it('submitInput:存库失败 ⇒ armIdleClose 兜回去、错误透传', async () => {
    const { domain, task, state, running, spies, store } = setup()
    state.runsByTask.set(task.id, running())
    vi.spyOn(store.liveInputs, 'add').mockImplementationOnce(() => { throw new Error('disk_full') })
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x' })).rejects.toThrow('disk_full')
    expect(spies.armIdleClose).toHaveBeenCalledTimes(1)
  })
  it('submitInput:await 基线期间 run 被替换 ⇒ input_stale、不落库', async () => {
    const { domain, task, state, running, spies, store } = setup()
    let release!: () => void
    const capture = new Promise<void>(r => { release = r })
    const r = running({ session: { workbenchRuntime: { snapshot: () => ({ retained: true, foreground: 'idle', backgroundCount: 0, input: 'send' }), submit: unused } }, reviewCapture: capture } as never)
    spies.inputMode.mockReturnValue('send'); state.runsByTask.set(task.id, r)
    const p = domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x' })
    state.runsByTask.set(task.id, running({ identity: 'run-2' })); release()
    await expect(p).rejects.toThrow('input_stale'); expect(store.liveInputs.count(task.id)).toBe(0)
  })
})

describe('makeInputsDomain · 持有、排空与结算', () => {
  it('holdInputs:pending 变 held、bumped;落库成功后 autoContinueBlocked 里没有它;hasUndeliveredInput 随之为 false', () => {
    const { domain, task, state, store, hub, pending, running } = setup()
    pending(); expect(domain.hasUndeliveredInput(running())).toBe(true)
    domain.holdInputs(task.id, '任务已停止')
    expect(store.liveInputs.get(REQ)!.status).toBe('held'); expect(hub.bumped).toHaveBeenCalledWith(task.id)
    expect(state.autoContinueBlocked.has(task.id)).toBe(false); expect(domain.hasUndeliveredInput(running())).toBe(false)
  })
  it('drainInputs:被 hold 中 / 没有 pending ⇒ 不动;有 pending 但续接不是 resume ⇒ hold 并留下「原会话需要你确认恢复方式，补充尚未发送。」;是 resume ⇒ 经调用方带下来的 start 派发', () => {
    const { domain, task, state, store, pending, spies, project } = setup()
    domain.drainInputs(task.id, directoryIdentity(project), spies.start); expect(spies.start).not.toHaveBeenCalled()
    pending(); state.autoContinueBlocked.add(task.id); domain.drainInputs(task.id, directoryIdentity(project), spies.start); expect(store.liveInputs.get(REQ)!.status).toBe('pending')
    state.autoContinueBlocked.clear(); domain.drainInputs(task.id, directoryIdentity(project), spies.start)
    expect(store.liveInputs.get(REQ)).toMatchObject({ status: 'held' }); expect(store.liveInputs.get(REQ)!.error).toContain('原会话需要你确认恢复方式')
    const again = setup(); again.pending(); again.store.session(again.task.id, 'sess'); again.spies.continuation.mockReturnValue({ mode: 'resume' } as never)
    again.domain.drainInputs(again.task.id, directoryIdentity(again.project), again.spies.start)
    expect(again.spies.start).toHaveBeenCalledTimes(1); expect(again.store.liveInputs.get(REQ)!.status).toBe('sending')
  })
  it('settleRuntimeInput:shutdownComplete ⇒ 只删本地登记;error ⇒ sending→held 带错误信息;成功 ⇒ delivered + user 事件 + touched', () => {
    const { domain, task, state, store, hub, pending, running } = setup()
    const saved = pending(); store.liveInputs.set(REQ, 'sending')
    const r = running({ runtimeInputs: new Map([[REQ, saved]]) } as never)
    state.shutdownComplete = true; domain.settleRuntimeInput(r, saved); expect(r.runtimeInputs!.size).toBe(0); expect(store.liveInputs.get(REQ)!.status).toBe('sending')
    state.shutdownComplete = false; r.runtimeInputs!.set(REQ, saved)
    domain.settleRuntimeInput(r, saved, new Error('boom')); expect(store.liveInputs.get(REQ)!.status).toBe('held'); expect(hub.bumped).toHaveBeenCalledWith(task.id)
    r.runtimeInputs!.set(REQ, saved); domain.settleRuntimeInput(r, saved)
    expect(store.liveInputs.get(REQ)!.status).toBe('delivered'); expect(store.events(task.id).some(e => e.kind === 'user' && e.text === '补一句')).toBe(true); expect(hub.touched).toHaveBeenCalledWith(task.id)
  })
})

// 2026-10 变异测试第二轮:回执只认本人本任务、排空时文件夹换了不投、补充的幂等 / 冲突、投递中不叠、守护放行、10 条上限、
// steer 那条路的三种结局 —— 这些分支改掉没有测试红。
describe('makeInputsDomain · 回执(变异测试第二轮)', () => {
  const link = (s: ReturnType<typeof setup>) => { const m = makeMatterStore(s.db); m.create({ id: s.task.id, kind: 'task', title: s.task.title, ownerChatId: 'owner' } as never); m.linkTask(s.task.id) }
  it('id 必须恰好 8 位小写十六进制', () => {
    const { domain } = setup()
    for (const bad of ['abcdef1', 'abcdef123', 'xabcdef12', 'abcdef12x', 'ABCDEF12']) expect(() => domain.inputReceipt(bad, REQ), bad).toThrow('invalid_matter_id')
  })
  it('本人本任务的回执 ⇒ 给;没有主人 / 任务不存在 / 没挂 matter / 回执属于别的任务 ⇒ null', () => {
    const s = setup(); link(s); s.pending()
    expect(s.domain.inputReceipt(s.task.id, REQ)).toMatchObject({ id: REQ, taskId: s.task.id })
    expect(s.domain.inputReceipt('00000000', REQ)).toBeNull()
    const other = s.store.create({ title: '别的', path: s.project, providerId: 'claude', ownerChatId: 'owner' })
    const m = makeMatterStore(s.db); m.create({ id: other.id, kind: 'task', title: '别的', ownerChatId: 'owner' } as never); m.linkTask(other.id)
    expect(s.domain.inputReceipt(other.id, REQ)).toBeNull()       // REQ 是第一个任务的
    const unlinked = setup(); unlinked.pending()
    expect(unlinked.domain.inputReceipt(unlinked.task.id, REQ)).toBeNull()
    const noOwner = setup({ owner: null }); link(noOwner); noOwner.pending()
    expect(noOwner.domain.inputReceipt(noOwner.task.id, REQ)).toBeNull()
  })
})

describe('makeInputsDomain · 排空与撤回的边界(变异测试第二轮)', () => {
  it('drainInputs:文件夹身份变了 ⇒ 不投、hold 成 invalid_path;身份对 ⇒ 按续接(resume=true)过准入', () => {
    const s = setup(); s.pending(); s.store.session(s.task.id, 'sess'); s.spies.continuation.mockReturnValue({ mode: 'resume' } as never)
    s.domain.drainInputs(s.task.id, 'some-other-identity', s.spies.start)
    expect(s.spies.start).not.toHaveBeenCalled()
    expect(s.store.liveInputs.get(REQ)).toMatchObject({ status: 'held', error: 'invalid_path' })
    const t = setup(); t.pending(); t.store.session(t.task.id, 'sess'); t.spies.continuation.mockReturnValue({ mode: 'resume' } as never)
    t.domain.drainInputs(t.task.id, directoryIdentity(t.project), t.spies.start)
    expect(t.spies.requireInput).toHaveBeenCalledWith('claude', [], PROVIDER_EXECUTION_CHOICE, true)
    expect(t.spies.start.mock.calls[0]!.slice(1, 4)).toEqual(['补一句', directoryIdentity(t.project), { mode: 'resume', sessionId: 'sess' }])
  })
  it('withdrawInput:回执属于别的任务 ⇒ input_stale', () => {
    const s = setup(); s.pending()
    const other = s.store.create({ title: '别的', path: s.project, providerId: 'claude', ownerChatId: 'owner' })
    expect(() => s.domain.withdrawInput(other.id, REQ)).toThrow('input_stale')
    expect(s.store.liveInputs.get(REQ)!.status).toBe('pending')
  })
  it('resolvePermission:任务不存在 ⇒ not_found(先认任务再看决定)', () => {
    expect(() => setup().domain.resolvePermission('00000000', 'p1', 'allow')).toThrow('not_found')
  })
})

describe('makeInputsDomain · 投递的边界(变异测试第二轮)', () => {
  const submit = (s: ReturnType<typeof setup>, over: Partial<{ runId: string; requestId: string; text: string }> = {}) =>
    s.domain.submitInput(s.task.id, { runId: 'run-1', requestId: REQ, text: '补一句', ...over })
  it('同 id 重发:换了 runId 也算冲突', async () => {
    const s = setup(); s.state.runsByTask.set(s.task.id, s.running())
    await submit(s)
    await expect(submit(s, { runId: 'run-2' })).rejects.toThrow('input_conflict')
  })
  it('上一句还在投 ⇒ input_delivery_busy', async () => {
    const s = setup(); s.state.runsByTask.set(s.task.id, s.running({ delivering: true }))
    await expect(submit(s)).rejects.toThrow('input_delivery_busy')
  })
  it('网络守护:信号安全 ⇒ 照收;需要保护且不安全 ⇒ network_unprotected,不落库', async () => {
    const ok = setup({ networkGate: { check: async () => ({ safe: true, source: 'probe', detail: '' }) } })
    ok.state.runsByTask.set(ok.task.id, ok.running())
    await expect(submit(ok)).resolves.toMatchObject({ id: REQ })
    const bad = setup({ networkGate: { check: async () => ({ safe: false, source: 'probe', detail: 'x' }) } })
    bad.state.runsByTask.set(bad.task.id, bad.running())
    await expect(submit(bad)).rejects.toThrow('network_unprotected')
    expect(bad.store.liveInputs.count(bad.task.id)).toBe(0)
  })
  it('一个任务最多攒 10 句补充:第 10 句照收,第 11 句 input_limit', async () => {
    const s = setup(); s.state.runsByTask.set(s.task.id, s.running())
    for (let i = 0; i < 9; i++) await submit(s, { requestId: randomUUID(), text: `第${i}句` })
    await expect(submit(s, { requestId: randomUUID(), text: '第十句' })).resolves.toBeTruthy()
    await expect(submit(s, { requestId: randomUUID(), text: '第十一句' })).rejects.toThrow('input_limit')
  })
  it('steer:送到 ⇒ delivered + 一条 user 事件,投递中挡住第二句;执行者没确认 ⇒ held 带原因;文件夹身份变了 ⇒ held、不调 steer', async () => {
    let release!: () => void
    const steer = vi.fn(() => new Promise<void>(r => { release = r }))
    const s = setup(); s.state.runsByTask.set(s.task.id, s.running({ session: { steer } } as never))
    const p = submit(s)
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))
    expect(s.store.liveInputs.get(REQ)!.status).toBe('sending')
    await expect(submit(s, { requestId: randomUUID(), text: '又一句' })).rejects.toThrow('input_delivery_busy')
    release()
    expect(await p).toMatchObject({ status: 'delivered' })
    expect(s.store.events(s.task.id).filter(e => e.kind === 'user').map(e => e.text)).toEqual(['补一句'])
    expect(s.state.runsByTask.get(s.task.id)!.delivering).toBe(false)

    const f = setup(); f.state.runsByTask.set(f.task.id, f.running({ session: { steer: async () => { throw new Error('pipe closed') } } } as never))
    const held = await submit(f)
    expect(held.status).toBe('held')
    expect(held.error).toContain('未确认执行者收到')
    expect(held.error).toContain('pipe closed')

    const moved = vi.fn(async () => {})
    const m = setup(); m.state.runsByTask.set(m.task.id, m.running({ session: { steer: moved }, directoryIdentity: 'changed' } as never))
    expect((await submit(m)).status).toBe('held')
    expect(moved).not.toHaveBeenCalled()
  })
  it('runtime(send 模式):文件夹身份变了 ⇒ 不投给 runtime,落成 held,重新武装收工计时', async () => {
    const submitRt = vi.fn(async () => {})
    const s = setup(); s.spies.inputMode.mockReturnValue('send')
    s.state.runsByTask.set(s.task.id, s.running({ session: { workbenchRuntime: { snapshot: () => ({ retained: true, foreground: 'idle', backgroundCount: 0, input: 'send' }), submit: submitRt } }, directoryIdentity: 'changed', reviewBaseline: {} } as never))
    const r = await submit(s)
    expect(submitRt).not.toHaveBeenCalled()
    expect(r.status).toBe('held')
    expect(s.spies.armIdleClose).toHaveBeenCalledTimes(1)
  })
})
