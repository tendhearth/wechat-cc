import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { createProviderRegistry } from '../../../app/provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { MANAGED_NATIVE_CAPABILITIES } from '../executor-capabilities'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentProvider } from '../../../ports/agent-provider'
import { makeRuntimeState, type Active } from './state'
import { makeNativeDomain, type NativeDomains } from './native'
import { makeNativeCheck } from './native-check'
import type { ServiceCtx } from './ctx'

/** native 从别的域拿的动作(不含 check:那块用真的 native-check,它的 admission 也转发到这里)。 */
type Fakes = NativeDomains['admission'] & NativeDomains['attachments'] & NativeDomains['quota'] & NativeDomains['view'] & NativeDomains['execute']

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const provider: AgentProvider = { async spawn() { throw new Error('not spawned') } }
const unused = () => { throw new Error('unused') }

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-native-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('codex', provider, { displayName: 'Codex', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }, deps: { ownerChatId: () => 'owner', registry }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now }
  // 注入的是转发到 fakes 的薄包装:测试在建好域之后才 stub(),没 stub 就调到 ⇒ 当场报错
  let fakes: Fakes | null = null
  const use = (): Fakes => { if (!fakes) throw new Error('not_stubbed'); return fakes }
  const actions = { get current() { return fakes } }
  const admission: NativeDomains['admission'] = {
    canResume: task => use().canResume(task),
    continuation: (...args) => use().continuation(...args),
    provider: id => use().provider(id),
    requireInput: (...args) => use().requireInput(...args),
    taskVersion: task => use().taskVersion(task),
  }
  const domain = makeNativeDomain(ctx, {
    admission,
    attachments: {
      combinedAttachments: (...args) => use().combinedAttachments(...args),
      handoffAttachments: (...args) => use().handoffAttachments(...args),
      selectAttachments: (...args) => use().selectAttachments(...args),
    },
    quota: { quotaExhausted: id => use().quotaExhausted(id) },
    view: { taskView: (...args) => use().taskView(...args) },
    check: makeNativeCheck(ctx, { admission }),
    execute: { start: (...args) => use().start(...args) },
  })
  const stub = () => { fakes = { quotaExhausted: () => null, continuation: () => ({ mode: 'new' }), provider: id => { const p = registry.get(id); if (!p) throw new Error('unavailable_provider'); return p as never }, requireInput: id => registry.get(id) as never, canResume: () => false, taskVersion: () => 'v', selectAttachments: () => [], combinedAttachments: c => [...c], handoffAttachments: () => [], taskView: t => t as never, start: unused } }
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  return { store, state, domain, task, project, actions, stub }
}

describe('makeNativeDomain · 构造与守门', () => {
  it('构造时不调注入的跨域动作', () => { const { actions } = setup(); expect(actions.current).toBeNull() })
  it('stopping 之后五个会开新工作的入口都抛 workbench_stopping', async () => {
    const { domain, state, task, stub } = setup(); stub(); state.stopping = true
    await expect(domain.previewHandoff({} as never)).rejects.toThrow('workbench_stopping')
    await expect(domain.handoff({ token: 'a'.repeat(64) })).rejects.toThrow('workbench_stopping')
    await expect(domain.importNativeHistory({} as never)).rejects.toThrow('workbench_stopping')
    await expect(domain.prepareNativeResume(task.id)).rejects.toThrow('workbench_stopping')
    await expect(domain.continueNativeTask(task.id, 'x', 'a'.repeat(64))).rejects.toThrow('workbench_stopping')
  })
})

describe('makeNativeDomain · 原生历史', () => {
  it('没接读取器 ⇒ listNativeHistory / nativeReader 都是 native_history_unsupported', async () => {
    const { domain } = setup()
    await expect(domain.listNativeHistory('claude', {} as never)).rejects.toThrow('native_history_unsupported')
    expect(() => domain.nativeReader('claude')).toThrow('native_history_unsupported')
  })
  it('importNativeHistory:畸形输入 ⇒ invalid_request', async () => {
    const { domain, stub } = setup(); stub()
    await expect(domain.importNativeHistory({ key: 'bad', pages: [], messageIds: [] } as never)).rejects.toThrow('invalid_request')
  })
  it('prepareNativeResume:不是导入来的任务 ⇒ invalid_request;continueNativeTask:未知 token ⇒ external_close_confirmation_stale', async () => {
    const { domain, task, stub } = setup(); stub()
    await expect(domain.prepareNativeResume(task.id)).rejects.toThrow('invalid_request')
    await expect(domain.continueNativeTask(task.id, '继续', 'f'.repeat(64))).rejects.toThrow('external_close_confirmation_stale')
  })
})

describe('makeNativeDomain · 交接', () => {
  it('handoff:token 畸形 ⇒ invalid_request;未知 token ⇒ handoff_changed', async () => {
    const { domain, stub } = setup(); stub()
    await expect(domain.handoff({ token: 'short' })).rejects.toThrow('invalid_request')
    await expect(domain.handoff({ token: 'a'.repeat(64) })).rejects.toThrow('handoff_changed')
  })
  it('previewHandoff:同一执行者交给自己 ⇒ invalid_request;畸形输入 ⇒ invalid_request', async () => {
    const { domain, task, stub } = setup(); stub()
    await expect(domain.previewHandoff({ sourceTaskId: task.id, targetProviderId: 'claude', purpose: 'review', request: '看看', artifacts: [] })).rejects.toThrow('invalid_request')
    await expect(domain.previewHandoff({ sourceTaskId: 'zz', targetProviderId: 'codex', purpose: 'review', request: '看看', artifacts: [] })).rejects.toThrow('invalid_request')
  })
  it('handoffRecord:不存在 ⇒ 抛;conflictsExternal:路径不可 canonical ⇒ true、同路径有 run 在跑 ⇒ true、否则 false', () => {
    const { domain, task, state, project } = setup()
    expect(() => domain.handoffRecord(task.id, 'nope')).toThrow()
    expect(domain.conflictsExternal(join(project, 'missing-dir'), 'claude', null)).toBe(true)
    expect(domain.conflictsExternal(project, 'claude', null)).toBe(false)
    state.runsByTask.set(task.id, { identity: 'r', taskId: task.id, path: project } as unknown as Active)
    expect(domain.conflictsExternal(project, 'claude', null)).toBe(true)
  })
})
