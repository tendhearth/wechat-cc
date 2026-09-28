import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { MANAGED_NATIVE_CAPABILITIES, UNATTENDED_CAPABILITIES } from '../executor-capabilities'
import { PROVIDER_EXECUTION_CHOICE } from '../execution-settings'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentProvider } from '../../agent-provider'
import { makeRuntimeState } from './state'
import { makeAdmissionDomain } from './admission'
import type { ServiceActions, ServiceCtx, ServiceDeps } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })

const provider: AgentProvider = { async spawn() { throw new Error('not spawned') } }

function setup(over: { ack?: ServiceDeps['unattendedAck']; canResume?: boolean; quotaExhausted?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-admission-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => over.canResume ?? true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('agy', provider, { displayName: 'Agy', canResume: () => false, workbench: UNATTENDED_CAPABILITIES })
  registry.register('kimi', provider, { displayName: 'Kimi', canResume: () => false })   // 没有 workbench 能力
  const state = makeRuntimeState()
  const actions = new Ref<ServiceActions>('t')
  actions.set({ submitInput: vi.fn(), continueTask: vi.fn(), isReplied: () => false, fallbackExecutor: () => null, artifact: () => { throw new Error('unused') }, quotaExhausted: () => over.quotaExhausted ? { kind: 'quota', since: 0, resetAt: Date.now() + 1000, message: '满了' } : null, continuation: () => ({ mode: 'new' }) })
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn() }, deps: { ownerChatId: () => 'owner', registry, ...(over.ack ? { unattendedAck: over.ack } : {}) }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const domain = makeAdmissionDomain(ctx)
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  return { store, domain, task, project }
}

describe('makeAdmissionDomain · 准入', () => {
  it('provider:没登记 / 没有 workbench 能力 ⇒ unavailable_provider;有 ⇒ 登记项', () => {
    const { domain } = setup()
    expect(() => domain.provider('nope')).toThrow('unavailable_provider')
    expect(() => domain.provider('kimi')).toThrow('unavailable_provider')
    expect(domain.provider('claude').opts.displayName).toBe('Claude')
  })
  it('requireInput:免审执行者没接 ack / ack 为空 ⇒ unattended_ack_required;确认过 ⇒ 放行', () => {
    expect(() => setup().domain.requireInput('agy', [], PROVIDER_EXECUTION_CHOICE)).toThrow('unattended_ack_required')
    let at: number | null = null
    const { domain } = setup({ ack: { get: () => at, set: v => { at = v } } })
    expect(() => domain.requireInput('agy', [], PROVIDER_EXECUTION_CHOICE)).toThrow('unattended_ack_required')
    expect(domain.acknowledgeUnattended()).toBe(at)
    expect(domain.requireInput('agy', [], PROVIDER_EXECUTION_CHOICE).opts.displayName).toBe('Agy')
  })
  it('acknowledgeUnattended:没接 ack ⇒ unattended_ack_unavailable', () => {
    expect(() => setup().domain.acknowledgeUnattended()).toThrow('unattended_ack_unavailable')
  })
  it('requireEntryInput:额度耗尽(经 ctx.actions.quotaExhausted)⇒ provider_quota_exhausted', () => {
    expect(() => setup({ quotaExhausted: true }).domain.requireEntryInput('claude', [], PROVIDER_EXECUTION_CHOICE, '做')).toThrow('provider_quota_exhausted')
    expect(() => setup().domain.requireEntryInput('claude', [], PROVIDER_EXECUTION_CHOICE, '做')).not.toThrow()
  })
})

describe('makeAdmissionDomain · 续接判定', () => {
  it('canResume:没 sessionId ⇒ false;有且执行者说能 ⇒ true;执行者说不能 ⇒ false', () => {
    const { domain, task, store } = setup()
    expect(domain.canResume(store.get(task.id))).toBe(false)
    store.session(task.id, 'sess-1')
    expect(domain.canResume(store.get(task.id))).toBe(true)
    const no = setup({ canResume: false }); no.store.session(no.task.id, 'sess-1')
    expect(no.domain.canResume(no.store.get(no.task.id))).toBe(false)
  })
  it('continuation:没有 user/text 事件 ⇒ new;有且能续 ⇒ resume;有且不能续 ⇒ restart_required 带预览', () => {
    const { domain, task, store } = setup({ canResume: false })
    expect(domain.continuation(store.get(task.id))).toEqual({ mode: 'new' })
    store.addEvent(task.id, 'user', '做点事'); store.addEvent(task.id, 'text', '好了')
    const restart = domain.continuation(store.get(task.id))
    expect(restart.mode).toBe('restart_required'); expect(restart).toHaveProperty('restart.token')
    const yes = setup(); yes.store.addEvent(yes.task.id, 'text', '好了'); yes.store.session(yes.task.id, 'sess-1')
    expect(yes.domain.continuation(yes.store.get(yes.task.id))).toEqual({ mode: 'resume' })
  })
  it('taskVersion:事件变了版本就变;同一状态两次相同', () => {
    const { domain, task, store } = setup()
    const v1 = domain.taskVersion(store.get(task.id))
    expect(domain.taskVersion(store.get(task.id))).toBe(v1)
    store.addEvent(task.id, 'text', 'x')
    expect(domain.taskVersion(store.get(task.id))).not.toBe(v1)
  })
  it('prepareContinuation:非终态 ⇒ workbench_busy;终态 ⇒ 续接判定;归档 ⇒ workbench_archived', () => {
    const { domain, task, store } = setup()
    expect(() => domain.prepareContinuation(task.id)).toThrow('workbench_busy')
    store.update(task.id, 'completed')
    expect(domain.prepareContinuation(task.id)).toEqual({ mode: 'new' })
    store.setArchived(task.id, true)
    expect(() => domain.prepareContinuation(task.id)).toThrow('workbench_archived')
  })
  it('modelCatalog:执行者没这功能 ⇒ model_catalog_unavailable', async () => {
    const { domain, project } = setup()
    await expect(domain.modelCatalog('claude', project)).rejects.toThrow('model_catalog_unavailable')
  })
})
