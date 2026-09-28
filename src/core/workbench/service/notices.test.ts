import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { saveArtifactSnapshot } from '../artifacts'
import { providerDisplayName } from '../../provider-display-names'
import { executionFailureMessage } from '../execution-settings'
import { removeTempDir } from '../../../lib/test-temp'
import { makeRuntimeState, type Active } from './state'
import { makeNoticesDomain } from './notices'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })

function setup(owner: string | null = 'owner', permissionTimeoutMs?: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-notices-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const state = makeRuntimeState()
  const noticeWake = vi.fn(async () => {}); state.noticeWake = noticeWake
  const actions = new Ref<ServiceActions>('t')
  actions.set({ submitInput: vi.fn(), continueTask: vi.fn(), isReplied: () => false, fallbackExecutor: () => 'claude', artifact: () => ({ name: 'a.txt', mime: 'text/plain', size: 1, sha256: 'f'.repeat(64), contentBase64: 'YQ==' }), quotaExhausted: () => null, continuation: () => ({ mode: 'new' }), provider: () => { throw new Error('unused') }, requireInput: () => { throw new Error('unused') }, canResume: () => false, taskVersion: () => 'v', selectAttachments: () => [], combinedAttachments: () => [], handoffAttachments: () => [], taskView: () => { throw new Error('unused') }, matterSync: () => {}, start: () => { throw new Error('unused') } } as never)
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn() }, deps: { ownerChatId: () => owner, registry: createProviderRegistry(), ...(permissionTimeoutMs !== undefined ? { permissionTimeoutMs } : {}) }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const domain = makeNoticesDomain(ctx)
  const task = store.create({ title: '写周报', path: project, providerId: 'codex', ownerChatId: owner })
  /** 假的 Active:只给 notices 用得到的字段。 */
  const running = (over: Partial<Active> = {}): Active => ({ identity: 'run-1', taskId: task.id, title: task.title, task, cancelled: false, finishing: false, uncertain: false, permissions: { pending: () => [] }, questions: { pending: () => [] }, ...over } as unknown as Active)
  /** 真种一份成果(artifact_deliveries.reserve 有外键指向它)。 */
  const plantArtifact = () => { saveArtifactSnapshot(store, task.id, { name: 'a.txt', mime: 'text/plain', bytes: Buffer.from('a') }, stateDir); return store.artifacts(task.id)[0]!.id }
  return { store, state, domain, task, noticeWake, running, plantArtifact }
}
const tick = () => new Promise<void>(r => queueMicrotask(r))

describe('makeNoticesDomain · 入队与唤醒', () => {
  it('没订阅 ⇒ requestNotice 不入队、不唤醒', async () => {
    const { domain, task, store, noticeWake } = setup()
    domain.requestNotice(task, 'run-1', 'permission', 'p1', 'rm -rf')
    await tick()
    expect(store.wechatNotifications.list(task.id)).toEqual([]); expect(noticeWake).not.toHaveBeenCalled()
  })
  it('订阅开着且是主人 ⇒ 入队一条 permission 通知(标题 · id / 需要你批准 / 查看…),微任务里唤醒', async () => {
    const { domain, task, store, noticeWake } = setup()
    store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    domain.requestNotice(task, 'run-1', 'permission', 'p1', 'rm -rf')
    expect(noticeWake).not.toHaveBeenCalled()
    await tick()
    const [n] = store.wechatNotifications.list(task.id)
    expect(n).toMatchObject({ kind: 'permission', requestId: 'p1', runId: 'run-1', accountId: 'acct' })
    expect(n!.text).toContain(`写周报 · ${task.id}`); expect(n!.text).toContain('需要你批准'); expect(n!.text).toContain(`查看：任务 ${task.id} 权限 p1`)
    expect(noticeWake).toHaveBeenCalledTimes(1)
  })
  it('订阅的主人不是当前主人 ⇒ 不入队', async () => {
    const { domain, task, store } = setup()
    store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    const other = { ...task, ownerChatId: 'someone-else' }
    domain.requestNotice(other, 'run-1', 'question', 'q1', '要哪种?')
    expect(store.wechatNotifications.list(task.id)).toEqual([])
  })
  it('contextAvailable:是主人才唤醒,带上下文;stopping 之后不再唤醒', async () => {
    const { domain, state, noticeWake } = setup()
    domain.contextAvailable('someone-else', 'acct'); await tick(); expect(noticeWake).not.toHaveBeenCalled()
    domain.contextAvailable('owner', 'acct'); await tick(); expect(noticeWake).toHaveBeenCalledWith({ ownerChatId: 'owner', accountId: 'acct' })
    state.stopping = true
    domain.contextAvailable('owner', 'acct'); await tick(); expect(noticeWake).toHaveBeenCalledTimes(1)
  })
})

describe('makeNoticesDomain · 终态通知', () => {
  it('非终态 / completed 且被压 ⇒ 什么都不 stage', () => {
    const { domain, task, store, running } = setup()
    store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    domain.stageFinishedNotice(running(), 'running'); domain.stageFinishedNotice(running(), 'completed', null, true)
    domain.publishFinishedNotices()
    expect(store.wechatNotifications.list(task.id)).toEqual([])
  })
  it('stage 是两段式:stage 之后 list 仍空,publishFinishedNotices 之后才出现;文案含标签与「查看/结果」', () => {
    const { domain, task, store, running } = setup()
    store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    store.update(task.id, 'completed')
    domain.stageFinishedNotice(running(), 'completed')
    expect(store.wechatNotifications.list(task.id)).toEqual([])
    domain.publishFinishedNotices()
    const [n] = store.wechatNotifications.list(task.id)
    expect(n).toMatchObject({ kind: 'completed', runId: 'run-1' })
    expect(n!.text).toContain('这一轮已完成'); expect(n!.text).toContain(`结果：任务 ${task.id} 结果`)
  })
  it('failed + 额度耗尽 ⇒ 文案是 executionFailureMessage + 「交给 <候选> 继续?」(候选来自 ctx.actions.fallbackExecutor)', () => {
    const { domain, task, store, running } = setup()
    store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    store.update(task.id, 'failed', 'provider_quota_exhausted')
    domain.stageFinishedNotice(running(), 'failed', 'provider_quota_exhausted'); domain.publishFinishedNotices()
    const [n] = store.wechatNotifications.list(task.id)
    expect(n!.text).toContain(executionFailureMessage('provider_quota_exhausted'))
    expect(n!.text).toContain(`交给 ${providerDisplayName('claude')} 继续？`)
  })
  it('terminalReportBody:取这一轮最后一条 text 事件;都没有 ⇒ undefined', () => {
    const { domain, task, store, running } = setup()
    expect(domain.terminalReportBody(running())).toBeUndefined()
    store.addEvent(task.id, 'text', '第一句', null, 'run-1'); store.addEvent(task.id, 'text', '最后一句', null, 'run-1'); store.addEvent(task.id, 'text', '别的 run', null, 'run-2')
    expect(domain.terminalReportBody(running())).toBe('最后一句')
  })
})

describe('makeNoticesDomain · 订阅与资格', () => {
  it('setWechatWatch:任务没主人 / 不是当前主人 ⇒ invalid_wechat_identity', () => {
    const { domain, task } = setup(null)
    expect(() => domain.setWechatWatch(task.id, 'acct', true)).toThrow('invalid_wechat_identity')
  })
  it('setWechatWatch 打开时,正在等的权限卡立刻补一条通知', async () => {
    const { domain, task, store, state, running } = setup()
    state.runsByTask.set(task.id, running({ permissions: { pending: () => [{ id: 'p9', tool: 'bash', description: 'ls', createdAt: Date.now() }] } } as never))
    const watch = domain.setWechatWatch(task.id, 'acct', true)
    expect(watch).toMatchObject({ enabled: true, accountId: 'acct' })
    expect(store.wechatNotifications.list(task.id)).toMatchObject([{ kind: 'permission', requestId: 'p9' }])
  })
  it('notificationEligible:generation 不符 ⇒ false;终态类通知有效订阅 ⇒ true;permission 类要 run 还在且未过期', () => {
    const { domain, task, store, state, running } = setup('owner', 1000)
    const watch = store.wechatNotifications.watch(task.id, 'owner', 'acct', true)
    const base = { taskId: task.id, ownerChatId: 'owner', accountId: 'acct', runId: 'run-1', subscriptionGeneration: watch.generation }
    expect(domain.notificationEligible({ ...base, kind: 'completed', subscriptionGeneration: watch.generation + 1 } as never)).toBe(false)
    expect(domain.notificationEligible({ ...base, kind: 'completed' } as never)).toBe(true)
    expect(domain.notificationEligible({ ...base, kind: 'permission', requestId: 'p1' } as never)).toBe(false)   // 没有 run
    state.runsByTask.set(task.id, running({ permissions: { pending: () => [{ id: 'p1', createdAt: Date.now() - 5000 }] } } as never))
    expect(domain.notificationEligible({ ...base, kind: 'permission', requestId: 'p1' } as never)).toBe(false)   // 过期(1000ms)
    state.runsByTask.set(task.id, running({ permissions: { pending: () => [{ id: 'p1', createdAt: Date.now() }] } } as never))
    expect(domain.notificationEligible({ ...base, kind: 'permission', requestId: 'p1' } as never)).toBe(true)
  })
})

describe('makeNoticesDomain · 成果投递', () => {
  it('artifactDeliveryEligible:主人对得上才 true;stopping ⇒ false', () => {
    const { domain, task, state } = setup()
    const receipt = { ownerChatId: 'owner', taskId: task.id } as never
    expect(domain.artifactDeliveryEligible(receipt)).toBe(true)
    expect(domain.artifactDeliveryEligible({ ownerChatId: 'x', taskId: task.id } as never)).toBe(false)
    state.stopping = true; expect(domain.artifactDeliveryEligible(receipt)).toBe(false)
  })
  it('deliverWechatArtifact:身份不符 / hash 畸形 / 没有投递通道 各自的错误码;没通道时不留预约', async () => {
    const { domain, task, store, plantArtifact } = setup()
    const artifactId = plantArtifact()
    const input = { ownerChatId: 'owner', accountId: 'acct', requestId: '11111111-1111-4111-8111-111111111111', commandHash: 'a'.repeat(64), taskId: task.id, artifactId }
    await expect(domain.deliverWechatArtifact({ ...input, ownerChatId: 'x' })).rejects.toThrow('invalid_wechat_identity')
    await expect(domain.deliverWechatArtifact({ ...input, commandHash: 'zz' })).rejects.toThrow('invalid_request')
    await expect(domain.deliverWechatArtifact(input)).rejects.toThrow('artifact_transport_unavailable')
    expect(store.artifactDeliveries.get(input.requestId)).toBeFalsy()
    const deliver = vi.fn(async (id: string) => ({ id, status: 'accepted' } as never))
    domain.setArtifactDelivery(deliver)
    await domain.deliverWechatArtifact(input)
    expect(deliver).toHaveBeenCalledWith(input.requestId)
    expect(store.artifactDeliveries.get(input.requestId)).toMatchObject({ taskId: task.id, artifactId, name: 'a.txt' })
  })
})
