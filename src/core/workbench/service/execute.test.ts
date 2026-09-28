import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { MANAGED_NATIVE_CAPABILITIES } from '../executor-capabilities'
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
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []; const shutdowns: Array<() => Promise<void>> = []
afterEach(async () => { for (const s of shutdowns.splice(0)) await s(); for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const REQ = '11111111-1111-4111-8111-111111111111'

/** 每轮都能跑完的假执行者(照 service-review.test.ts):resume 时沿用 resumeSessionId。 */
function fakeProvider(): AgentProvider {
  let index = 0
  return {
    async spawn(_project, context) {
      const sessionId = context.resumeSessionId ?? `native-${index++}`
      return { async *dispatch() { yield { kind: 'init' as const, sessionId }; yield { kind: 'text' as const, text: '好了' }; yield { kind: 'result' as const, sessionId, numTurns: 1, durationMs: 1 } }, async close() {} }
    },
  }
}

/** 迷你组装:和 service.ts 同一套接线,只是没有 public 对象与 wechatControl。 */
function setup(over: { executionConflict?: NonNullable<ServiceCtx['deps']['executionConflict']>; owner?: string | null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-execute-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', fakeProvider(), { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const actions = new Ref<ServiceActions>('t')
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }, deps: { ownerChatId: () => over.owner === undefined ? 'owner' : over.owner, registry, ...(over.executionConflict ? { executionConflict: over.executionConflict } : {}) }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const attachments = makeAttachmentsDomain(ctx), quota = makeQuotaDomain(ctx), admission = makeAdmissionDomain(ctx), view = makeViewDomain(ctx), native = makeNativeDomain(ctx), inputs = makeInputsDomain(ctx), lifecycle = makeLifecycleDomain(ctx), notices = makeNoticesDomain(ctx), artifacts = makeArtifactsDomain(ctx)
  const execute = makeExecuteDomain(ctx, { admission, attachments, quota, view, native, inputs, lifecycle, notices, artifacts })
  actions.set({ submitInput: inputs.submitInput, continueTask: execute.continueTask, isReplied: view.isReplied, fallbackExecutor: quota.fallbackExecutor, artifact: artifacts.artifact, quotaExhausted: quota.quotaExhausted, continuation: admission.continuation, provider: admission.provider, requireInput: admission.requireInput, canResume: admission.canResume, taskVersion: admission.taskVersion, selectAttachments: attachments.selectAttachments, combinedAttachments: attachments.combinedAttachments, handoffAttachments: attachments.handoffAttachments, taskView: view.taskView, matterSync: execute.matterSync, start: execute.start, continuationAttachmentScope: attachments.continuationAttachmentScope, inputMode: view.inputMode, armIdleClose: lifecycle.armIdleClose, cancelIdleClose: lifecycle.cancelIdleClose, settleAfterDecision: lifecycle.settleAfterDecision, execute: execute.execute, hasUndeliveredInput: inputs.hasUndeliveredInput, holdInputs: inputs.holdInputs, collect: artifacts.collect, collectTurnArtifacts: artifacts.collectTurnArtifacts, captureCodeChanges: artifacts.captureCodeChanges, runtimeSnapshot: view.runtimeSnapshot, held: view.held, stageFinishedNotice: notices.stageFinishedNotice, publishFinishedNotices: notices.publishFinishedNotices })
  shutdowns.push(lifecycle.shutdown)
  const settled = async (id: string) => { await vi.waitFor(() => expect(store.get(id).status).not.toMatch(/^(queued|running|cancelling)$/), { timeout: 5000 }) }
  return { store, state, execute, view, project, settled }
}

describe('makeExecuteDomain · 创建与派发', () => {
  it('create ⇒ 排队视图、runsByTask 有它;经 lifecycle.pump → ctx.actions.execute 真派发,fakeProvider 跑到 completed,事件里有回答', async () => {
    const { execute, store, state, project, settled } = setup()
    const view = execute.create({ path: project, providerId: 'claude', text: '做点事' })
    expect(view).toMatchObject({ status: 'queued', phase: 'queued' }); expect(state.runsByTask.has(view.id)).toBe(true)
    await settled(view.id)
    expect(store.get(view.id).status).toBe('completed'); expect(store.events(view.id).some(e => e.kind === 'text' && e.text === '好了')).toBe(true)
    expect(state.runsByTask.size).toBe(0); expect(state.reservations.size).toBe(0)
  })
  it('createTask 守门:标题非法 ⇒ invalid_title;外部占着 ⇒ native_session_busy;stopping ⇒ workbench_stopping', () => {
    const { execute, project, state } = setup({ executionConflict: () => true })
    expect(() => execute.create({ path: project, providerId: 'claude', text: 'x', title: ' ' })).toThrow('invalid_title')
    expect(() => execute.create({ path: project, providerId: 'claude', text: 'x' })).toThrow('native_session_busy')
    state.stopping = true
    expect(() => execute.create({ path: project, providerId: 'claude', text: 'x' })).toThrow('workbench_stopping')
  })
  it('createTask 带 entry:事务里抛错 ⇒ 没有任务被创建、runsByTask 空(接受的 run 绝不活过回滚的事务)', () => {
    const { execute, project, state, store } = setup()
    const entry = { context: { ownerKey: 'owner', surface: 'desktop' as const }, workspaceKind: 'project' as const, fromChat: false, materials: [], beforeCreate: () => { throw new Error('boom') }, verifyDirectory: () => {} }
    expect(() => execute.createTask({ path: project, providerId: 'claude', text: 'x' }, undefined, undefined, entry as never)).toThrow()
    expect(state.runsByTask.size).toBe(0); expect(store.listPage({}).tasks).toEqual([])
  })
  it('start:任务已在跑 ⇒ workbench_busy', async () => {
    const { execute, store, project, settled } = setup()
    const view = execute.create({ path: project, providerId: 'claude', text: '做点事' })
    expect(() => execute.start(store.get(view.id), 'again', 'x')).toThrow('workbench_busy')
    await settled(view.id)
  })
})

describe('makeExecuteDomain · 续接', () => {
  it('continueTask:在跑 ⇒ workbench_busy;归档 ⇒ workbench_archived;restartToken 畸形 ⇒ invalid_request;能续 ⇒ 新一轮跑完', async () => {
    const { execute, store, project, settled } = setup()
    const first = execute.create({ path: project, providerId: 'claude', text: '做点事' })
    expect(() => execute.continueTask(first.id, '再来')).toThrow('workbench_busy')
    await settled(first.id)
    expect(() => execute.continueTask(first.id, '再来', { restartToken: 'short' })).toThrow('invalid_request')
    const second = execute.continueTask(first.id, '再来')
    expect(second).toMatchObject({ id: first.id, status: 'queued' })
    await settled(first.id)
    expect(store.events(first.id).filter(e => e.kind === 'text')).toHaveLength(2)
    store.setArchived(first.id, true)
    expect(() => execute.continueTask(first.id, '三来')).toThrow('workbench_archived')
  })
  it('continueTask 幂等:同 inputRequestId 重发同文 ⇒ 回视图不再派发;异文 ⇒ input_conflict', async () => {
    const { execute, store, project, state, settled } = setup()
    const task = execute.create({ path: project, providerId: 'claude', text: '做点事' }); await settled(task.id)
    execute.continueTask(task.id, '再来', { inputRequestId: REQ })
    const replay = execute.continueTask(task.id, '再来', { inputRequestId: REQ })
    expect(replay.id).toBe(task.id); expect(state.runsByTask.size).toBeLessThanOrEqual(1)
    expect(() => execute.continueTask(task.id, '另一句', { inputRequestId: REQ })).toThrow('input_conflict')
    await settled(task.id)
    expect(store.liveInputs.get(REQ)).toMatchObject({ taskId: task.id, text: '再来' })
  })
})

describe('makeExecuteDomain · 微信创建与出生地', () => {
  it('createWechat:身份不符 ⇒ invalid_wechat_identity;hash 畸形 ⇒ invalid_request;项目不存在 ⇒ project_stale', () => {
    const { execute } = setup()
    const input = { ownerChatId: 'owner', accountId: 'acct', requestId: REQ, commandHash: 'a'.repeat(64), projectId: 'nope', text: '做' }
    expect(() => execute.createWechat({ ...input, ownerChatId: 'x' })).toThrow('invalid_wechat_identity')
    expect(() => execute.createWechat({ ...input, commandHash: 'zz' })).toThrow('invalid_request')
    expect(() => execute.createWechat(input)).toThrow('project_stale')
  })
  it('safeOriginMatterId:没接 matters ⇒ null', () => {
    expect(setup().execute.safeOriginMatterId('owner')).toBeNull()
  })
})
