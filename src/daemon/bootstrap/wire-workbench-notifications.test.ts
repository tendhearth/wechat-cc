import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSqlite, type SqlDatabase as Database } from '../../lib/runtime/sqlite'
import { initializeWechatNotificationSchema, makeWechatNotificationStore } from '../../core/workbench/wechat-notifications'
import { wireWorkbenchNotifications } from './wire-workbench-notifications'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../lib/db'
import { makeWorkbenchStore } from '../../core/workbench/store'
import { makeWorkbenchService } from '../../core/workbench/service'
import { createProviderRegistry } from '../../app/provider-registry'
import { makeConversationStore } from '../../core/conversation-store'
import { makeIlinkAdapter } from '../ilink-glue'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeMwCaptureCtx } from '../inbound/mw-capture-ctx'
import { makeMwCommand } from '../inbound/mw-command'
import { makeCommandRegistry } from '../commands/registry'
import { makeTaskCommand } from '../commands/task-command'
import { createInternalApi } from '../internal-api'
import {MANAGED_NATIVE_CAPABILITIES} from '../../core/workbench/executor-capabilities'
import {removeTempDir} from '../../lib/test-temp'
import { serve } from '../../lib/runtime/http'
import { makeProactiveOutbound, type AppChannel } from '../companion/proactive-channel'
import { makeSpeechPolicy } from '../speech/policy'
import { makePendingNotices } from '../speech/pending-notices'

/** 真的门 + 真的 proactive-channel(微信那条腿是工作台自己的发送口);App 那条路是假的。 */
function speechHarness(o: { care?: 'off' | 'low'; quietEnds?: number | null; wechatDegraded?: boolean; app?: AppChannel | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-speech-')); tempDirs.push(dir)
  const sendWechat = vi.fn(async () => ({ msgId: 'plain' }))
  const outbound = makeProactiveOutbound({ wechatDegraded: () => o.wechatDegraded ?? false, wechatClosedSince: () => null, sendWechat, app: () => o.app ?? null, log: () => {} })
  const pending = makePendingNotices({ stateDir: dir, log: () => {} })
  const speech = makeSpeechPolicy({ care: () => o.care ?? 'low', quietEndsAt: () => o.quietEnds ?? null, outbound, log: () => {}, pending })
  return { speech, pending, sendWechat }
}
const tempDirs: string[] = []
const fakeApp = () => ({ deliverable: () => true, record: vi.fn(async (_c: string, _t: string) => true), push: vi.fn((_t: string) => {}) })

const databases: Database[] = []
function fixture(speechOpts: Parameters<typeof speechHarness>[0] = {}) {
  const sh = speechHarness(speechOpts)
  const db = openSqlite(':memory:'); databases.push(db)
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE workbench_tasks(id TEXT PRIMARY KEY NOT NULL) STRICT; INSERT INTO workbench_tasks(id) VALUES('task-1'),('task-2');")
  initializeWechatNotificationSchema(db)
  const notificationStore = makeWechatNotificationStore(db)
  let wake: ((context?: { ownerChatId: string; accountId: string }) => Promise<void>) | undefined
  let eligibleCalls = 0
  const workbench = {
    notificationStore,
    notificationEligible: vi.fn(() => { eligibleCalls++; return true }),
    setNotificationWake: vi.fn((next: typeof wake) => { wake = next }),
  }
  const sendWorkbenchNotice = vi.fn(async (_notice: unknown, _signal?: AbortSignal) => ({ status: 'accepted' as const }))
  const chatAccountId = vi.fn((chatId: string): string | null => chatId === 'owner-2' ? 'account-2' : 'account-1')
  const wired = wireWorkbenchNotifications({ workbench: workbench as never, ilink: { sendWorkbenchNotice, chatAccountId }, speech: sh.speech })
  return { notificationStore, workbench, sendWorkbenchNotice, chatAccountId, wired, ...sh, get eligibleCalls() { return eligibleCalls }, get wake() { return wake } }
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const d of tempDirs.splice(0)) removeTempDir(d) })

const input = (overrides = {}) => ({ taskId: 'task-1', runId: 'run-1', ownerChatId: 'owner-1', accountId: 'account-1', kind: 'completed' as const, text: '完成', ...overrides })

describe('wireWorkbenchNotifications', () => {
  it('binds workbench wakes and forwards one eligible notice through the strict adapter', async () => {
    const f = fixture(); f.notificationStore.watch('task-1', 'owner-1', 'account-1', true)
    const notice = f.notificationStore.enqueue(input())
    await f.wake!()
    expect(f.sendWorkbenchNotice).toHaveBeenCalledOnce()
    expect(f.sendWorkbenchNotice).toHaveBeenCalledWith(expect.objectContaining({ id: notice.id, taskId: 'task-1', runId: 'run-1', ownerChatId: 'owner-1', accountId: 'account-1', text: '完成' }), expect.any(AbortSignal))
    expect(f.notificationStore.list('task-1')[0]?.status).toBe('accepted')
  })

  it('rechecks eligibility synchronously at the send boundary and suppresses a stale notice', async () => {
    const f = fixture(); f.notificationStore.watch('task-1', 'owner-1', 'account-1', true); f.notificationStore.enqueue(input())
    f.workbench.notificationEligible.mockReturnValueOnce(true).mockReturnValueOnce(false)
    await f.wired.wake()
    expect(f.workbench.notificationEligible).toHaveBeenCalledTimes(2)
    expect(f.sendWorkbenchNotice).not.toHaveBeenCalled()
    expect(f.notificationStore.list('task-1')[0]).toMatchObject({ status: 'suppressed', reason: 'ineligible' })
  })

  it('releases only matching deferred context and unbinds before close', async () => {
    const f = fixture()
    f.notificationStore.watch('task-1', 'owner-1', 'account-1', true)
    f.notificationStore.watch('task-2', 'owner-2', 'account-2', true)
    const one = f.notificationStore.enqueue(input())
    const two = f.notificationStore.enqueue(input({ taskId: 'task-2', runId: 'run-2', ownerChatId: 'owner-2', accountId: 'account-2' }))
    const now = Date.now()
    for (const notice of [one, two]) { f.notificationStore.claim(notice.id, now); f.notificationStore.defer(notice.id, 'missing_context', now, 60_000, 60_000) }
    await f.wired.wake({ ownerChatId: 'owner-2', accountId: 'account-2' })
    expect(f.sendWorkbenchNotice.mock.calls.map(call => (call[0] as { taskId: string }).taskId)).toEqual(['task-2'])
    expect(f.notificationStore.list('task-1')[0]?.status).toBe('pending')
    await f.wired.close()
    expect(f.workbench.setNotificationWake).toHaveBeenLastCalledWith(expect.any(Function))
    await expect(f.wake!()).resolves.toBeUndefined()
  })

  it('suppresses delivery when the strict adapter method is unavailable', async () => {
    const f = fixture(); await f.wired.close()
    const wired = wireWorkbenchNotifications({ workbench: f.workbench as never, ilink: { chatAccountId: f.chatAccountId }, speech: f.speech })
    f.notificationStore.watch('task-1', 'owner-1', 'account-1', true); f.notificationStore.enqueue(input())
    await wired.wake()
    expect(f.notificationStore.list('task-1')[0]).toMatchObject({ status: 'suppressed', reason: 'transport_unavailable' })
    await wired.close()
  })

  it('suppresses an account-rebound notice before transport', async () => {
    const f = fixture(); f.notificationStore.watch('task-1', 'owner-1', 'account-1', true); f.notificationStore.enqueue(input())
    f.chatAccountId.mockReturnValue('account-new')
    await f.wired.wake()
    expect(f.sendWorkbenchNotice).not.toHaveBeenCalled()
    expect(f.notificationStore.list('task-1')[0]).toMatchObject({ status: 'suppressed', reason: 'binding_changed' })
  })

  it('carries a real phone-created task through permission, question, desktop answer, and completion over loopback HTTP', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wcc-notification-integration-')))
    const project = join(root, 'project'); mkdirSync(project)
    const db = openDb({ path: join(root, 'state.db') })
    const store = makeWorkbenchStore(db)
    const registry = createProviderRegistry()
    registry.register('claude', { async spawn(_project, context) { return {
      async *dispatch() {
        await context.requestPermission!({ tool: 'Write', description: 'write report' })
        const answer = await context.requestUserInput!({ questions: [{ id: 'format', header: '格式', question: '选择格式', options: [{ label: 'PDF', description: 'PDF' }] }] })
        yield { kind: 'text' as const, text: `完成：${JSON.stringify(answer)}` }
        yield { kind: 'result' as const, sessionId: 'native-fixture', numTurns: 1, durationMs: 1 }
      },
      async close() {},
    } } }, { displayName: 'Claude', canResume: () => true,workbench:MANAGED_NATIVE_CAPABILITIES })
    const service = makeWorkbenchService({ store, registry, stateDir: root, ownerChatId: () => 'owner', registeredProjects: () => [{ alias: 'project', path: project }] })
    const ilinkRequests: Array<{ url: string; body: unknown }> = []
    const ilinkServer = serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      ilinkRequests.push({ url: request.url, body: await request.json() })
      return Response.json({ errcode: 0 })
    } })
    await ilinkServer.ready
    const adapter = makeIlinkAdapter({ stateDir: root, accounts: [{ id: 'account-1', botId: 'bot', userId: 'user', baseUrl: `http://127.0.0.1:${ilinkServer.port}`, token: 'secret', syncBuf: '' }], db, conversationStore: makeConversationStore(db) })
    const wired = wireWorkbenchNotifications({ workbench: service, ilink: adapter, speech: speechHarness().speech })
    const internalApi = createInternalApi({ stateDir: root, daemonPid: 1, workbench: service } as never)
    const adminToken = internalApi.mintSessionToken('admin', 'codex/default/owner')
    const { port: internalPort } = await internalApi.start()
    const desktopGet = (path: string) => fetch(`http://127.0.0.1:${internalPort}${path}`, { headers: { authorization: `Bearer ${adminToken}` } })
    const replies = vi.fn(async () => ({ msgId: 'fixture-reply' }))
    const capture = makeMwCaptureCtx(adapter)
    const commands = makeMwCommand({ registry: makeCommandRegistry([makeTaskCommand({ handleWechat: service.handleWechat, sendMessage: replies })]), log: () => {} })
    const incoming = async (text: string, msgId: string) => {
      const ctx = { msg: { chatId: 'owner', userId: 'owner', accountId: 'account-1', text, msgType: 'text', createTimeMs: 1, msgId, contextToken: 'context-1' }, receivedAtMs: 1, requestId: msgId }
      await capture(ctx, () => commands(ctx, async () => {}))
    }
    try {
      const command = `任务 新建 ${service.projects()[0]!.id} 整理报告`
      await incoming(command, 'create-1')
      await incoming(command, 'create-1')
      const task = service.list().tasks[0]!
      const desktopListResponse = await desktopGet('/v1/workbench')
      expect(desktopListResponse.status).toBe(200)
      const desktopList = await desktopListResponse.json() as ReturnType<typeof service.list>
      expect(desktopList.tasks).toHaveLength(1)
      expect(desktopList.tasks[0]).toMatchObject({ id: task.id, path: project, providerId: 'claude' })
      expect(store.get(task.id).ownerChatId).toBe('owner')
      expect(store.wechatNotifications.subscription(task.id)).toMatchObject({ ownerChatId: 'owner', accountId: 'account-1' })
      await expect.poll(() => service.detail(task.id).permissions.length).toBe(1)
      await expect.poll(() => store.wechatNotifications.list(task.id).find(n => n.kind === 'permission')?.status).toBe('accepted')
      const permission = service.detail(task.id).permissions[0]!
      await incoming(`任务 ${task.id} 允许 ${permission.id}`, 'allow-1')
      await expect.poll(() => service.detail(task.id).questions.length).toBe(1)
      await expect.poll(() => store.wechatNotifications.list(task.id).find(n => n.kind === 'question')?.status).toBe('accepted')
      const question = service.detail(task.id).questions[0]!
      service.resolveAnswer(task.id, question.id, { format: ['PDF'] })
      await expect.poll(() => service.detail(task.id).task.status).toBe('completed')
      await expect.poll(() => store.wechatNotifications.list(task.id).find(n => n.kind === 'completed')?.status).toBe('accepted')
      const desktopDetailResponse = await desktopGet(`/v1/workbench/task?id=${task.id}`)
      expect(desktopDetailResponse.status).toBe(200)
      const desktopDetail = await desktopDetailResponse.json() as ReturnType<typeof service.detail>
      expect(desktopDetail).toMatchObject({ task: { id: task.id, path: project, providerId: 'claude' } })
      const originalRunId = desktopDetail.wechatNotifications.notices.find(notice => notice.kind === 'completed')!.runId
      expect(originalRunId).toEqual(expect.any(String))
      expect(desktopDetail.events.find(event => event.kind === 'user')).toMatchObject({ text: '整理报告', runId: originalRunId })
      expect(ilinkRequests).toHaveLength(3)
      expect(ilinkRequests.every(request => new URL(request.url).hostname === '127.0.0.1')).toBe(true)
      expect((await makeMessagesStore(db).listRange('owner', { limit: 10 })).map(m => m.source)).toEqual(['workbench', 'workbench', 'workbench'])
      expect(replies).toHaveBeenCalledTimes(3)
    } finally {
      await internalApi.stop(); ilinkServer.stop(true); await wired.close(); await service.shutdown(); await adapter.flush(); db.close(); removeTempDir(root)
    }
  })
})

describe('工作台通知经 CC 开口那道门(第三批 3a)', () => {
  const QUIET_END = Date.parse('2030-01-01T07:00:00.000Z')
  const permission = () => input({ kind: 'permission' as const, requestId: 'perm-1', text: '需要你批准' })

  it('别烦我 ⇒ 批准卡(blocking)和做完了(report)都照发', async () => {
    const f = fixture({ care: 'off' }); f.notificationStore.watch('task-1', 'owner-1', 'account-1', true)
    f.notificationStore.enqueue(permission()); f.notificationStore.enqueue(input())
    await f.wake!()
    expect(f.sendWorkbenchNotice).toHaveBeenCalledTimes(2)
    expect(f.notificationStore.list('task-1').map(n => n.status)).toEqual(['accepted', 'accepted'])
  })

  it('免打扰 ⇒ 批准卡照发;做完了推到时段结束 —— 留在自己的 outbox(不算尝试),不进「待说」队列', async () => {
    const f = fixture({ quietEnds: QUIET_END }); f.notificationStore.watch('task-1', 'owner-1', 'account-1', true)
    f.notificationStore.enqueue(permission()); const done = f.notificationStore.enqueue(input())
    await f.wake!()
    expect(f.sendWorkbenchNotice).toHaveBeenCalledOnce()
    expect((f.sendWorkbenchNotice.mock.calls[0]![0] as { kind: string }).kind).toBe('permission')
    expect(f.notificationStore.list('task-1').find(n => n.id === done.id)).toMatchObject({ status: 'pending', reason: 'quiet_hours' })
    expect(f.notificationStore.nextDue(Date.now())).toBe(QUIET_END)
    expect(f.pending.groups()).toEqual([])
    await f.wired.close()
    // 不算尝试:时段结束后第一次真发失败,退避从头算(defer_count 没因推后而涨)
    expect(f.notificationStore.claim(done.id, QUIET_END)).not.toBeNull()
    f.notificationStore.defer(done.id, 'window_closed', QUIET_END, 1000, 60_000)
    expect(f.notificationStore.nextDue(QUIET_END)).toBe(QUIET_END + 1000)
  })

  it('微信降级 ⇒ 落到 App:记进主人对话,不另推(phone-notifier 已经推过原生通知),工作台发送口不碰', async () => {
    const app = fakeApp()
    const f = fixture({ wechatDegraded: true, app }); f.notificationStore.watch('task-1', 'owner-1', 'account-1', true)
    f.notificationStore.enqueue(input())
    await f.wake!()
    expect(f.sendWorkbenchNotice).not.toHaveBeenCalled()
    expect(app.record).toHaveBeenCalledWith('owner-1', '完成')
    expect(app.push).not.toHaveBeenCalled()
    expect(f.notificationStore.list('task-1')[0]).toMatchObject({ status: 'accepted', reason: 'app' })
  })

  it('微信推送窗口关了(-2,确定没发出去)⇒ 改走 App', async () => {
    const app = fakeApp()
    const f = fixture({ app }); f.notificationStore.watch('task-1', 'owner-1', 'account-1', true)
    f.sendWorkbenchNotice.mockResolvedValueOnce({ status: 'deferred', reason: 'window_closed' } as never)
    f.notificationStore.enqueue(input())
    await f.wake!()
    expect(f.sendWorkbenchNotice).toHaveBeenCalledOnce()
    expect(app.record).toHaveBeenCalledOnce()
    expect(f.notificationStore.list('task-1')[0]).toMatchObject({ status: 'accepted', reason: 'app' })
  })

  it('结果不明(unknown,可能已经到了)⇒ 不换路,免得说两遍', async () => {
    const app = fakeApp()
    const f = fixture({ app }); f.notificationStore.watch('task-1', 'owner-1', 'account-1', true)
    f.sendWorkbenchNotice.mockResolvedValueOnce({ status: 'unknown', reason: 'transport_uncertain' } as never)
    f.notificationStore.enqueue(input())
    await f.wake!()
    expect(app.record).not.toHaveBeenCalled()
    expect(f.notificationStore.list('task-1')[0]).toMatchObject({ status: 'unknown' })
  })

  it('两条路都送不到 ⇒ 批准卡**不进**「待说」队列(带会过期的码);留在 outbox,重试前再核一次,请求没了就作废', async () => {
    const f = fixture({ wechatDegraded: true, app: null }); f.notificationStore.watch('task-1', 'owner-1', 'account-1', true)
    const card = f.notificationStore.enqueue(permission())
    await f.wake!()
    expect(f.sendWorkbenchNotice).not.toHaveBeenCalled()
    expect(f.pending.groups()).toEqual([])
    expect(f.notificationStore.list('task-1')[0]).toMatchObject({ id: card.id, status: 'pending', reason: 'undeliverable' })
    // 主人在桌面上拍了板 ⇒ 请求不在了;到点重试时核对不过 ⇒ 作废,永远不会补发一个死码
    f.workbench.notificationEligible.mockReturnValue(false)
    f.notificationStore.releaseDeferred('owner-1', 'account-1')
    await f.wake!()
    expect(f.sendWorkbenchNotice).not.toHaveBeenCalled()
    expect(f.notificationStore.list('task-1')[0]).toMatchObject({ status: 'suppressed', reason: 'ineligible' })
  })
})
