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
import { makeRuntimeState, type Active } from './state'
import { makeInputsDomain } from './inputs'
import { directoryIdentity } from './directory-identity'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const provider: AgentProvider = { async spawn() { throw new Error('not spawned') } }
const unused = () => { throw new Error('unused') }
const REQ = '11111111-1111-4111-8111-111111111111'

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-inputs-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const hub = { touched: vi.fn(), bumped: vi.fn() }
  const actions = new Ref<ServiceActions>('t')
  const spies = { armIdleClose: vi.fn(), cancelIdleClose: vi.fn(), settleAfterDecision: vi.fn(), start: vi.fn(), continuation: vi.fn(() => ({ mode: 'new' } as never)), inputMode: vi.fn(() => 'queue' as 'steer' | 'send' | 'queue') }
  actions.set({ submitInput: vi.fn(), continueTask: vi.fn(), isReplied: () => false, fallbackExecutor: () => null, artifact: unused, quotaExhausted: () => null, continuation: spies.continuation, provider: unused, requireInput: id => registry.get(id) as never, canResume: () => false, taskVersion: () => 'v', selectAttachments: () => [], combinedAttachments: c => [...c], handoffAttachments: () => [], taskView: t => t as never, matterSync: () => {}, start: spies.start, continuationAttachmentScope: () => undefined, inputMode: spies.inputMode, armIdleClose: spies.armIdleClose, cancelIdleClose: spies.cancelIdleClose, settleAfterDecision: spies.settleAfterDecision })
  const ctx: ServiceCtx = { store, stateDir, state, hub, deps: { ownerChatId: () => 'owner', registry }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const domain = makeInputsDomain(ctx)
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const running = (over: Partial<Active> = {}): Active => ({ identity: 'run-1', taskId: task.id, title: task.title, task, path: project, directoryIdentity: directoryIdentity(project), execution: PROVIDER_EXECUTION_CHOICE, cancelled: false, finishing: false, uncertain: false, delivering: false, permissions: { pending: () => [], resolve: () => true }, questions: { pending: () => [], resolve: () => true }, ...over } as unknown as Active)
  const pending = (text = '补一句') => store.liveInputs.add({ id: REQ, taskId: task.id, runId: 'run-1', text, attachments: [], execution: PROVIDER_EXECUTION_CHOICE })
  return { store, state, hub, domain, task, project, running, spies, pending }
}

describe('makeInputsDomain · 拍板与撤回', () => {
  it('withdrawInput:不存在 / 不是 pending ⇒ input_stale;pending ⇒ withdrawn + bumped', () => {
    const { domain, task, store, hub, pending } = setup()
    expect(() => domain.withdrawInput(task.id, REQ)).toThrow('input_stale')
    pending(); domain.withdrawInput(task.id, REQ)
    expect(store.liveInputs.get(REQ)!.status).toBe('withdrawn'); expect(hub.bumped).toHaveBeenCalledWith(task.id)
    expect(() => domain.withdrawInput(task.id, REQ)).toThrow('input_stale')
  })
  it('resolveAnswer / resolvePermission:没 run ⇒ *_stale;拍板后 bumped 且经 ctx.actions.settleAfterDecision 补一次落定;非法 decision ⇒ invalid_decision', () => {
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
  it('drainInputs:被 hold 中 / 没有 pending ⇒ 不动;有 pending 但续接不是 resume ⇒ hold 并留下「原会话需要你确认恢复方式，补充尚未发送。」;是 resume ⇒ 经 ctx.actions.start 派发', () => {
    const { domain, task, state, store, pending, spies, project } = setup()
    domain.drainInputs(task.id, directoryIdentity(project)); expect(spies.start).not.toHaveBeenCalled()
    pending(); state.autoContinueBlocked.add(task.id); domain.drainInputs(task.id, directoryIdentity(project)); expect(store.liveInputs.get(REQ)!.status).toBe('pending')
    state.autoContinueBlocked.clear(); domain.drainInputs(task.id, directoryIdentity(project))
    expect(store.liveInputs.get(REQ)).toMatchObject({ status: 'held' }); expect(store.liveInputs.get(REQ)!.error).toContain('原会话需要你确认恢复方式')
    const again = setup(); again.pending(); again.store.session(again.task.id, 'sess'); again.spies.continuation.mockReturnValue({ mode: 'resume' } as never)
    again.domain.drainInputs(again.task.id, directoryIdentity(again.project))
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
