import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
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
import { makeQuotaHandoffDomain } from './quota-handoff'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []; const shutdowns: Array<() => Promise<void>> = []
afterEach(async () => { for (const s of shutdowns.splice(0)) await s(); for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const REQ = '11111111-1111-4111-8111-111111111111'
const REQ2 = '22222222-2222-4222-8222-222222222222'
const QUOTA_TEXT = "You've hit your usage limit. Try again at 10:00"
/** 测试只看建没建、建了几件;run 起不来就在后台失败,不影响断言。 */
const hanging: AgentProvider = { async spawn() { throw new Error('not spawned') } }

/** 迷你组装(同 entry.test.ts):claude + codex 两家原生执行者,主人 owner。 */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-quota-handoff-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', hanging, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('codex', hanging, { displayName: 'Codex', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const actions = new Ref<ServiceActions>('t')
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }, deps: { ownerChatId: () => 'owner', registry }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const attachments = makeAttachmentsDomain(ctx), quota = makeQuotaDomain(ctx), admission = makeAdmissionDomain(ctx), view = makeViewDomain(ctx), native = makeNativeDomain(ctx), inputs = makeInputsDomain(ctx), lifecycle = makeLifecycleDomain(ctx), notices = makeNoticesDomain(ctx), artifacts = makeArtifactsDomain(ctx)
  const execute = makeExecuteDomain(ctx, { admission, attachments, quota, view, native, inputs, lifecycle, notices, artifacts })
  const handoff = makeQuotaHandoffDomain(ctx, { execute, quota })
  actions.set({ submitInput: inputs.submitInput, continueTask: execute.continueTask, isReplied: view.isReplied, fallbackExecutor: quota.fallbackExecutor, artifact: artifacts.artifact, quotaExhausted: quota.quotaExhausted, continuation: admission.continuation, provider: admission.provider, requireInput: admission.requireInput, canResume: admission.canResume, taskVersion: admission.taskVersion, selectAttachments: attachments.selectAttachments, combinedAttachments: attachments.combinedAttachments, handoffAttachments: attachments.handoffAttachments, taskView: view.taskView, matterSync: execute.matterSync, start: execute.start, continuationAttachmentScope: attachments.continuationAttachmentScope, inputMode: view.inputMode, armIdleClose: lifecycle.armIdleClose, cancelIdleClose: lifecycle.cancelIdleClose, settleAfterDecision: lifecycle.settleAfterDecision, execute: execute.execute, hasUndeliveredInput: inputs.hasUndeliveredInput, holdInputs: inputs.holdInputs, collect: artifacts.collect, collectTurnArtifacts: artifacts.collectTurnArtifacts, captureCodeChanges: artifacts.captureCodeChanges, runtimeSnapshot: view.runtimeSnapshot, held: view.held, stageFinishedNotice: notices.stageFinishedNotice, publishFinishedNotices: notices.publishFinishedNotices })
  shutdowns.push(lifecycle.shutdown)
  /** 一件不在跑、因额度失败的 claude 任务(主人的)。 */
  const failed = (owner: string | null = 'owner') => {
    const t = store.create({ title: '修登录页', path: project, providerId: 'claude', ownerChatId: owner })
    return t
  }
  const exhaust = (id = 'claude') => quota.quota.note(id, QUOTA_TEXT)
  const tasks = () => store.listPage({ limit: 50 }).tasks
  return { store, state, handoff, quota, project, failed, exhaust, tasks }
}

describe('quotaHandoff:这件事要不要、能不能交给另一位继续(只读)', () => {
  it('执行者没耗尽 ⇒ null(不打扰)', () => {
    const { handoff, failed } = setup()
    expect(handoff.quotaHandoff(failed().id)).toBeNull()
  })
  it('耗尽 + 有别人能接 ⇒ offer(from / to / kind / resetAt)', () => {
    const { handoff, failed, exhaust } = setup()
    const t = failed(); exhaust()
    expect(handoff.quotaHandoff(t.id)).toMatchObject({ state: 'offer', from: 'claude', to: 'codex', kind: 'quota' })
    expect((handoff.quotaHandoff(t.id) as { resetAt: number }).resetAt).toBeGreaterThan(Date.now())
  })
  it('两家都耗尽 ⇒ none(说实话:现在没人能接)', () => {
    const { handoff, failed, exhaust } = setup()
    const t = failed(); exhaust('claude'); exhaust('codex')
    expect(handoff.quotaHandoff(t.id)).toMatchObject({ state: 'none', from: 'claude', kind: 'quota' })
  })
  it('这件事正在跑 ⇒ null(跑完 / 失败了再说)', () => {
    const { handoff, failed, exhaust, state } = setup()
    const t = failed(); exhaust()
    state.runsByTask.set(t.id, {} as never)
    expect(handoff.quotaHandoff(t.id)).toBeNull()
    state.runsByTask.delete(t.id)
  })
  it('不是主人的任务 ⇒ null', () => {
    const { handoff, failed, exhaust } = setup()
    const t = failed('someone'); exhaust()
    expect(handoff.quotaHandoff(t.id)).toBeNull()
  })
})

describe('handOff:在同一个文件夹交给另一位新开一件(幂等)', () => {
  it('成功:新任务用 to、同一文件夹、标题不变、第一句说清接替谁;之后详情是 handed', () => {
    const { handoff, failed, exhaust, store, project } = setup()
    const t = failed(); exhaust()
    const r = handoff.handOff(t.id, { requestId: REQ, providerId: 'codex' })
    expect(r.created).toBe(true); expect(r.taskId).not.toBe(t.id)
    const made = store.get(r.taskId)
    expect(made).toMatchObject({ providerId: 'codex', path: project, title: '修登录页', ownerChatId: 'owner' })
    expect(handoff.quotaHandoff(t.id)).toEqual({ state: 'handed', from: 'claude', to: 'codex', matterId: r.taskId })
  })
  it('同一个 requestId 重发 ⇒ 同一件、不建第二件(即使额度已恢复)', () => {
    const { handoff, failed, exhaust, tasks, quota } = setup()
    const t = failed(); exhaust()
    const a = handoff.handOff(t.id, { requestId: REQ, providerId: 'codex' })
    quota.quota.clear('claude')
    const b = handoff.handOff(t.id, { requestId: REQ, providerId: 'codex' })
    expect(b).toEqual({ taskId: a.taskId, created: false })
    expect(tasks()).toHaveLength(2)
  })
  it('别的 requestId(另一台设备)再交 ⇒ 回已交出的那件,不建第二件', () => {
    const { handoff, failed, exhaust, tasks } = setup()
    const t = failed(); exhaust()
    const a = handoff.handOff(t.id, { requestId: REQ, providerId: 'codex' })
    expect(handoff.handOff(t.id, { requestId: REQ2, providerId: 'codex' })).toEqual({ taskId: a.taskId, created: false })
    expect(tasks()).toHaveLength(2)
  })
  it('同一个 requestId 用在另一件事上 ⇒ creation_conflict', () => {
    const { handoff, failed, exhaust } = setup()
    const a = failed(), b = failed(); exhaust()
    handoff.handOff(a.id, { requestId: REQ, providerId: 'codex' })
    expect(() => handoff.handOff(b.id, { requestId: REQ, providerId: 'codex' })).toThrow('creation_conflict')
  })
  it('额度已经恢复 ⇒ quota_handoff_not_needed,什么都不建', () => {
    const { handoff, failed, tasks } = setup()
    const t = failed()
    expect(() => handoff.handOff(t.id, { requestId: REQ, providerId: 'codex' })).toThrow('quota_handoff_not_needed')
    expect(tasks()).toHaveLength(1)
  })
  it('确认卡上的接手人变了 ⇒ quota_handoff_changed;没人能接 ⇒ quota_handoff_unavailable', () => {
    const { handoff, failed, exhaust, tasks } = setup()
    const t = failed(); exhaust()
    expect(() => handoff.handOff(t.id, { requestId: REQ, providerId: 'claude' })).toThrow('quota_handoff_changed')
    exhaust('codex')
    expect(() => handoff.handOff(t.id, { requestId: REQ, providerId: 'codex' })).toThrow('quota_handoff_unavailable')
    expect(tasks()).toHaveLength(1)
  })
  it('正在跑 ⇒ workbench_busy;不是主人的 ⇒ invalid_entry_owner;坏参数 ⇒ invalid_request / invalid_provider', () => {
    const { handoff, failed, exhaust, state } = setup()
    const t = failed(); exhaust()
    state.runsByTask.set(t.id, {} as never)
    expect(() => handoff.handOff(t.id, { requestId: REQ, providerId: 'codex' })).toThrow('workbench_busy')
    state.runsByTask.delete(t.id)
    const other = failed('someone')
    expect(() => handoff.handOff(other.id, { requestId: REQ, providerId: 'codex' })).toThrow('invalid_entry_owner')
    expect(() => handoff.handOff('nope', { requestId: REQ, providerId: 'codex' })).toThrow('invalid_request')
    expect(() => handoff.handOff(t.id, { requestId: 'x', providerId: 'codex' })).toThrow('invalid_request')
    expect(() => handoff.handOff(t.id, { requestId: REQ, providerId: 'Bad Id!' })).toThrow('invalid_provider')
  })
  it('文件夹不在了 ⇒ 抛(不建),与交办同一个错误', () => {
    const { handoff, failed, exhaust, project, tasks } = setup()
    const t = failed(); exhaust()
    rmSync(project, { recursive: true })
    expect(() => handoff.handOff(t.id, { requestId: REQ, providerId: 'codex' })).toThrow()
    expect(tasks()).toHaveLength(1)
  })
})
