import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore, type Task, publicTask } from '../store'
import { MANAGED_NATIVE_CAPABILITIES } from '../executor-capabilities'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentProvider, AgentRuntimeSnapshot } from '../../agent-provider'
import { makeRuntimeState, type Active } from './state'
import { makeViewDomain } from './view'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const provider: AgentProvider = { async spawn() { throw new Error('not spawned') } }

function setup(over: { defaultProvider?: string; owner?: string | null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-view-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('codex', provider, { displayName: 'Codex', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const actions = new Ref<ServiceActions>('t')
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn() }, deps: { ownerChatId: () => over.owner === undefined ? 'owner' : over.owner, registry, nativeHistory: { claude: {} as never }, ...(over.defaultProvider ? { defaultProvider: over.defaultProvider } : {}) }, ensureAccepting: () => {}, now: Date.now, actions }
  const domain = makeViewDomain(ctx)
  actions.set({ submitInput: vi.fn(), continueTask: vi.fn(), isReplied: domain.isReplied, fallbackExecutor: () => null, artifact: () => { throw new Error('unused') }, quotaExhausted: () => null, continuation: () => ({ mode: 'new' }), provider: id => { const p = registry.get(id); if (!p) throw new Error('unavailable_provider'); return p as never }, requireInput: () => { throw new Error('unused') }, canResume: () => false, taskVersion: () => 'v', selectAttachments: () => [], combinedAttachments: () => [], handoffAttachments: () => [], taskView: () => { throw new Error('unused') }, matterSync: () => {}, start: () => { throw new Error('unused') }, continuationAttachmentScope: () => undefined, inputMode: () => 'queue' as const, armIdleClose: () => {}, cancelIdleClose: () => {}, settleAfterDecision: () => {} })
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const snapshot = (over: Partial<AgentRuntimeSnapshot> = {}): AgentRuntimeSnapshot => ({ retained: true, foreground: 'idle', backgroundCount: 0, input: 'send', ...over })
  /** 假 Active:带 runtime 快照与空的待决队列。 */
  const running = (over: Partial<Active> & { snap?: AgentRuntimeSnapshot } = {}): Active => {
    const { snap, ...rest } = over
    return { identity: 'run-1', taskId: task.id, title: task.title, task, path: project, order: 1, state: 'active', cancelled: false, finishing: false, uncertain: false, permissions: { pending: () => [] }, questions: { pending: () => [] }, session: snap ? { workbenchRuntime: { snapshot: () => snap } } : undefined, ...rest } as unknown as Active
  }
  return { store, state, domain, task, project, running, snapshot }
}

describe('makeViewDomain · 进度', () => {
  it('isReplied:retained + idle + 无后台 + 无待决 ⇒ true;取消/在写/有待决 ⇒ false', () => {
    const { domain, running, snapshot } = setup()
    expect(domain.isReplied(running({ snap: snapshot() }))).toBe(true)
    expect(domain.isReplied(running({ snap: snapshot({ foreground: 'running' }) }))).toBe(false)
    expect(domain.isReplied(running({ snap: snapshot(), cancelled: true }))).toBe(false)
    expect(domain.isReplied(running({ snap: snapshot(), permissions: { pending: () => [{}] } } as never))).toBe(false)
    expect(domain.isReplied(running())).toBe(false)   // 没有 runtime 快照
  })
  it('phaseOf / taskView:queued→queued;running 已答复→replied 否则 working;completed→replied;终态照抄;canArchive 只对没在跑的终态', () => {
    const { domain, running, snapshot, task, store, state } = setup()
    const t = (status: string) => ({ ...publicTask(store.get(task.id)), status } as unknown as Task)
    expect(domain.phaseOf(t('queued'), undefined)).toBe('queued')
    expect(domain.phaseOf(t('running'), running({ snap: snapshot() }))).toBe('replied')
    expect(domain.phaseOf(t('running'), running())).toBe('working')
    expect(domain.phaseOf(t('completed'), undefined)).toBe('replied')
    expect(domain.phaseOf(t('failed'), undefined)).toBe('failed')
    expect(domain.taskView(t('completed')).canArchive).toBe(true)
    expect(domain.taskView({ ...t('completed'), error: 'writer_not_closed' } as never).canArchive).toBe(false)
    state.runsByTask.set(task.id, running())
    expect(domain.taskView(t('completed')).canArchive).toBe(false)
    expect(domain.taskView(t('running'), true)).toMatchObject({ pendingPermissionCount: 0, pendingQuestionCount: 0 })
  })
  it('waitingFor:不在排队 ⇒ null;同路径被占、持有者已答复 ⇒ holderWriting=false 且 closeInMs≥0;持有者找不到 ⇒ holderWriting=true', () => {
    const { domain, running, snapshot, state } = setup()
    expect(domain.waitingFor(running())).toBeNull()
    const holder = running({ identity: 'holder', snap: snapshot(), idleClose: { timer: 0 as never, at: Date.now() + 5000, reason: 'idle' } })
    state.reservations.set('holder', holder); state.runsByTask.set(holder.taskId, holder)
    const waiter = running({ identity: 'waiter', taskId: 'other', order: 2, state: 'queued' })
    const w = domain.waitingFor(waiter)
    expect(w).toMatchObject({ holderWriting: false }); expect(w!.closeInMs).toBeGreaterThanOrEqual(0)
    state.runsByTask.clear()
    expect(domain.waitingFor(waiter)).toMatchObject({ holderWriting: true, closeInMs: null })
  })
  it('attention:只列有待决权限/提问的 run', () => {
    const { domain, running, state, task } = setup()
    state.runsByTask.set(task.id, running())
    expect(domain.attention().tasks).toEqual([])
    state.runsByTask.set(task.id, running({ permissions: { pending: () => [{ id: 'p1' }] } } as never))
    expect(domain.attention().tasks).toMatchObject([{ id: task.id, pendingPermissionCount: 1, pendingQuestionCount: 0 }])
  })
})

describe('makeViewDomain · 列表与详情', () => {
  it('list:执行者带能力/额度/用量;defaultProvider 不在名单 ⇒ 回落第一个;historyProviders / canWechat / unattendedAcknowledgedAt', () => {
    const { domain } = setup({ defaultProvider: 'nope' })
    const l = domain.list()
    expect(l.providers.map(p => p.id)).toEqual(['claude', 'codex'])
    expect(l.defaultProvider).toBe('claude'); expect(l.historyProviders).toEqual(['claude']); expect(l.canWechat).toBe(true); expect(l.unattendedAcknowledgedAt).toBeNull()
    expect(setup({ defaultProvider: 'codex' }).domain.list().defaultProvider).toBe('codex')
  })
  it('projects:没配主人 ⇒ [];addProject:未知执行者 ⇒ unavailable_provider、畸形 ⇒ invalid_request', () => {
    expect(setup({ owner: null }).domain.projects()).toEqual([])
    const { domain, project } = setup()
    expect(() => domain.addProject({ path: project, providerId: 'nope' })).toThrow('unavailable_provider')
    expect(() => domain.addProject({ path: project, providerId: 'claude', name: '' })).toThrow('invalid_request')
    expect(domain.addProject({ path: project, providerId: 'claude' })).toMatchObject({ path: project })
  })
  it('detail:没在跑 ⇒ 带 continuation(经 ctx.actions)、没有 inputMode;在跑 ⇒ runId + inputMode', () => {
    const { domain, running, snapshot, task, state } = setup()
    const d1 = domain.detail(task.id)
    expect(d1).toMatchObject({ continuation: { mode: 'new' }, wechatNotifications: { enabled: false } }); expect(d1).not.toHaveProperty('inputMode')
    state.runsByTask.set(task.id, running({ snap: snapshot({ input: 'steer' }) }))
    expect(domain.detail(task.id)).toMatchObject({ runId: 'run-1', inputMode: 'steer' })
  })
})
