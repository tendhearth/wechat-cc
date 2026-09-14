import { afterEach, describe, expect, it, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { initializeWechatNotificationSchema, makeWechatNotificationStore } from '../../core/workbench/wechat-notifications'
import { wireWorkbenchNotifications } from './wire-workbench-notifications'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../lib/db'
import { makeWorkbenchStore } from '../../core/workbench/store'
import { makeWorkbenchService } from '../../core/workbench/service'
import { createProviderRegistry } from '../../core/provider-registry'
import { makeConversationStore } from '../../core/conversation-store'
import { makeIlinkAdapter } from '../ilink-glue'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeMwCaptureCtx } from '../inbound/mw-capture-ctx'
import { makeMwWorkbench } from '../inbound/mw-workbench'
import { createInternalApi } from '../internal-api'
import {MANAGED_NATIVE_CAPABILITIES} from '../../core/workbench/executor-capabilities'

const databases: Database[] = []
function fixture() {
  const db = new Database(':memory:'); databases.push(db)
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
  const wired = wireWorkbenchNotifications({ workbench: workbench as never, ilink: { sendWorkbenchNotice, chatAccountId } })
  return { notificationStore, workbench, sendWorkbenchNotice, chatAccountId, wired, get eligibleCalls() { return eligibleCalls }, get wake() { return wake } }
}
afterEach(() => { for (const db of databases.splice(0)) db.close() })

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
    const wired = wireWorkbenchNotifications({ workbench: f.workbench as never, ilink: { chatAccountId: f.chatAccountId } })
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
    const ilinkServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      ilinkRequests.push({ url: request.url, body: await request.json() })
      return Response.json({ errcode: 0 })
    } })
    const adapter = makeIlinkAdapter({ stateDir: root, accounts: [{ id: 'account-1', botId: 'bot', userId: 'user', baseUrl: `http://127.0.0.1:${ilinkServer.port}`, token: 'secret', syncBuf: '' }], db, conversationStore: makeConversationStore(db) })
    const wired = wireWorkbenchNotifications({ workbench: service, ilink: adapter })
    const internalApi = createInternalApi({ stateDir: root, daemonPid: 1, workbench: service } as never)
    const adminToken = internalApi.mintSessionToken('admin', 'codex/default/owner')
    const { port: internalPort } = await internalApi.start()
    const desktopGet = (path: string) => fetch(`http://127.0.0.1:${internalPort}${path}`, { headers: { authorization: `Bearer ${adminToken}` } })
    const replies = vi.fn(async () => ({ msgId: 'fixture-reply' }))
    const capture = makeMwCaptureCtx(adapter)
    const commands = makeMwWorkbench({ handleWechat: service.handleWechat, sendMessage: replies })
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
      await internalApi.stop(); ilinkServer.stop(true); await wired.close(); await service.shutdown(); await adapter.flush(); db.close(); rmSync(root, { recursive: true, force: true })
    }
  })
})
