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
import { makeEntryDomain } from './entry'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []; const shutdowns: Array<() => Promise<void>> = []
afterEach(async () => { for (const s of shutdowns.splice(0)) await s(); for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const REQ = '11111111-1111-4111-8111-111111111111'
const provider: AgentProvider = { async spawn() { throw new Error('not spawned') } }
const OWNER = { ownerKey: 'owner', surface: 'desktop' as const }

/** 迷你组装(同 execute.test.ts);entry 域拿 execute / view / admission / quota 四个域对象。 */
function setup(over: { defaultProvider?: string; managedRoot?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-entry-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const actions = new Ref<ServiceActions>('t')
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }, deps: { ownerChatId: () => 'owner', registry, ...(over.defaultProvider ? { defaultProvider: over.defaultProvider } : {}), ...(over.managedRoot ? { managedWorkspaceRoot: over.managedRoot } : {}) }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const attachments = makeAttachmentsDomain(ctx), quota = makeQuotaDomain(ctx), admission = makeAdmissionDomain(ctx), view = makeViewDomain(ctx), native = makeNativeDomain(ctx), inputs = makeInputsDomain(ctx), lifecycle = makeLifecycleDomain(ctx), notices = makeNoticesDomain(ctx), artifacts = makeArtifactsDomain(ctx)
  const execute = makeExecuteDomain(ctx, { admission, attachments, quota, view, native, inputs, lifecycle, notices, artifacts })
  const entry = makeEntryDomain(ctx, { execute, view, admission, quota })
  actions.set({ submitInput: inputs.submitInput, continueTask: execute.continueTask, isReplied: view.isReplied, fallbackExecutor: quota.fallbackExecutor, artifact: artifacts.artifact, quotaExhausted: quota.quotaExhausted, continuation: admission.continuation, provider: admission.provider, requireInput: admission.requireInput, canResume: admission.canResume, taskVersion: admission.taskVersion, selectAttachments: attachments.selectAttachments, combinedAttachments: attachments.combinedAttachments, handoffAttachments: attachments.handoffAttachments, taskView: view.taskView, matterSync: execute.matterSync, start: execute.start, continuationAttachmentScope: attachments.continuationAttachmentScope, inputMode: view.inputMode, armIdleClose: lifecycle.armIdleClose, cancelIdleClose: lifecycle.cancelIdleClose, settleAfterDecision: lifecycle.settleAfterDecision, execute: execute.execute, hasUndeliveredInput: inputs.hasUndeliveredInput, holdInputs: inputs.holdInputs, collect: artifacts.collect, collectTurnArtifacts: artifacts.collectTurnArtifacts, captureCodeChanges: artifacts.captureCodeChanges, runtimeSnapshot: view.runtimeSnapshot, held: view.held, stageFinishedNotice: notices.stageFinishedNotice, publishFinishedNotices: notices.publishFinishedNotices })
  shutdowns.push(lifecycle.shutdown)
  return { store, entry, project, root }
}

describe('makeEntryDomain · 守门', () => {
  it('managed():没配受管根目录 ⇒ entry_not_wired;配了 ⇒ 能拿到', async () => {
    expect(() => setup().entry.managed()).toThrow('entry_not_wired')
    const { entry, root } = setup({ managedRoot: join(root_of(), 'managed') })
    void root; expect(entry.managed()).toBeTruthy()
  })
  it('requireEntryOwner:没 ownerKey / 不是主人 / surface 不对 ⇒ invalid_entry_owner;对的 ⇒ 过', async () => {
    const { entry } = setup()
    expect(() => entry.requireEntryOwner({ ownerKey: '', surface: 'desktop' })).toThrow('invalid_entry_owner')
    expect(() => entry.requireEntryOwner({ ownerKey: 'someone', surface: 'desktop' })).toThrow('invalid_entry_owner')
    expect(() => entry.requireEntryOwner({ ownerKey: 'owner', surface: 'watch' as never })).toThrow('invalid_entry_owner')
    expect(() => entry.requireEntryOwner(OWNER)).not.toThrow()
  })
  it('entryReceipt:没记录 ⇒ null;不是主人 ⇒ invalid_entry_owner', async () => {
    const { entry } = setup()
    expect(entry.entryReceipt(REQ, OWNER)).toBeNull()
    expect(() => entry.entryReceipt(REQ, { ownerKey: 'x', surface: 'phone' })).toThrow('invalid_entry_owner')
  })
})

describe('makeEntryDomain · 选项与创建', () => {
  it('entryOptions:不是主人 ⇒ needs_connection + invalid_entry_owner;是主人 ⇒ 列出可用执行者,默认执行者只在配了且可用时才有', async () => {
    const { entry } = setup()
    expect(entry.entryOptions({ ownerKey: 'x', surface: 'phone' })).toMatchObject({ status: 'needs_connection', reason: { code: 'invalid_entry_owner' }, providers: [] })
    const o = entry.entryOptions(OWNER)
    expect(o.providers.map(p => p.id)).toEqual(['claude']); expect(o.providers[0]).toMatchObject({ available: true }); expect(o.defaultProviderId).toBeNull(); expect(o.status).toBe('needs_connection')
    expect(setup({ defaultProvider: 'claude' }).entry.entryOptions(OWNER)).toMatchObject({ status: 'ready', defaultProviderId: 'claude' })
  })
  it('createEntry:没接 matters ⇒ entry_not_wired;同 requestId 但内容 hash 不同 ⇒ creation_conflict', async () => {
    const { entry, store } = setup()
    const input = { requestId: REQ, text: '做点事', target: { kind: 'managed' as const } }
    await expect(entry.createEntry(input, OWNER)).rejects.toThrow('entry_not_wired')
    store.entryRequests.reserve({ ownerKey: 'owner', requestId: REQ, canonicalRequestHash: 'f'.repeat(64), target: { kind: 'managed' }, workspaceId: null, resolvedPath: null, directoryIdentity: null, providerId: 'claude', execution: PROVIDER_EXECUTION_CHOICE, materialSnapshot: [] })
    await expect(entry.createEntry(input, OWNER)).rejects.toThrow('creation_conflict')
  })
})

function root_of() { const d = realpathSync(mkdtempSync(join(tmpdir(), 'wb-entry-root-'))); dirs.push(d); return d }

describe('makeEntryDomain · entryModels(2026-10-06)', () => {
  it('owner-checked; unknown project ⇒ project_stale; managed without a root ⇒ entry_not_wired; otherwise asks the executor for its catalog', async () => {
    const { entry } = setup()
    await expect(entry.entryModels({ providerId: 'claude' }, { ownerKey: 'x', surface: 'phone' })).rejects.toThrow('invalid_entry_owner')
    await expect(entry.entryModels({ providerId: 'claude', projectId: 'p-00000000000000000000' }, OWNER)).rejects.toThrow('project_stale')
    await expect(entry.entryModels({ providerId: 'claude' }, OWNER)).rejects.toThrow('entry_not_wired')
    const managed = setup({ managedRoot: join(root_of(), 'managed-models') })
    // 这个测试执行者不带模型目录 ⇒ 走到了真正去问它那一步(目录路径在电脑上解析、受管根目录被建出来)
    await expect(managed.entry.entryModels({ providerId: 'claude' }, OWNER)).rejects.toThrow('model_catalog_unavailable')
  })
})
