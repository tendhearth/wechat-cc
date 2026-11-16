import { afterEach, expect, it, vi } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeReplyDeliveryRuntime } from '../reply-delivery'
import { makeReplySinks } from '../reply-sinks'
import { makeOwnerConversationReader, ownerConversationEvents, ownerConversationWork } from './owner-conversation'
import { ConversationEvents, ConversationWindow, ConversationWork } from '../../../packages/protocol/src/owner-conversation'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProviderRegistry } from '../../app/provider-registry'
import { SessionManager } from '../../app/session-manager'
import { createConversationCoordinator } from '../../app/conversation-coordinator'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import { makeChatTurnLog } from '../../adapters/store/chat-turns'
import { wireCompanionConverse } from './wire-converse'
import type { Bootstrap } from '../bootstrap'
import { makeIlinkAdapter } from '../ilink-glue'
import { makeMediaMirror } from '../companion/media-mirror'
import type { CareLedger } from '../../features/companion'
import { makePendingNotices } from '../speech/pending-notices'
import { captureReplyAttribution } from '../../lib/reply-attribution'
import { makeTimelineEvents } from '../../adapters/store/workbench/timeline-events'
import { makeWorkbenchStore } from '../../adapters/store/workbench/store'
import { makeWorkbenchService } from '../../features/workbench/service'
import { makeMattersService } from '../../app/matters/service'
import { MatterDetail } from '../../../packages/protocol/src/api'

let db: Db | undefined
afterEach(() => { db?.close(); db = undefined })

it('preserves optional attribution through old and new conversation contracts and durable message reconstruction', async () => {
  db = openTestDb()
  const messages = makeMessagesStore(db)
  const base = { chatId: 'owner', ts: '2026-11-16T00:00:00Z', direction: 'out' as const, kind: 'text', source: 'desktop' }
  await messages.append({ ...base, id: 'old', text: 'old reply' })
  await messages.append({ ...base, id: 'cc', text: 'CC reply', speaker: 'cc', provider: 'gateway-a', model: 'model-a', turnId: 'turn-a', extras: JSON.stringify({ attachments: [{ kind: 'voice', text: 'hello' }], narration: [] }) })
  await messages.append({ ...base, id: 'agent', text: 'agent reply', speaker: 'agent', provider: 'codex', matterId: 'work-a', agentId: 'run-a', turnId: 'turn-b' })
  const read = makeOwnerConversationReader(db)
  const window = ConversationWindow.parse(await read('owner', { limit: 30 }))
  expect(window.messages.find(m => m.messageId === 'old')).not.toHaveProperty('speaker')
  expect(window.messages.find(m => m.messageId === 'cc')).toMatchObject({ speaker: 'cc', provider: 'gateway-a', model: 'model-a', turnId: 'turn-a', replyExtras: { attachments: [{ kind: 'voice', text: 'hello' }] } })
  expect(window.messages.find(m => m.messageId === 'agent')).toMatchObject({ speaker: 'agent', provider: 'codex', matterId: 'work-a', agentId: 'run-a', turnId: 'turn-b' })
  expect(await makeMessagesStore(db).get('owner', 'cc')).toMatchObject({ speaker: 'cc', provider: 'gateway-a', model: 'model-a' })
  expect(ConversationEvents.parse({ running: null, events: [], cursor: 0 }).events).toEqual([])
  expect(ConversationWork.parse({ references: [], results: [] }).results).toEqual([])
})

it('freezes each delivery source for the sink including attachment-only replies', async () => {
  const sinks = makeReplySinks()
  const runtime = makeReplyDeliveryRuntime({ sendText: async () => ({ msgId: 'unused' }), sink: { captureReply: (c, r) => sinks.captureReply!(c, r) }, log: () => {} })
  const opts = { context: 'dm' as const, providerId: 'gateway-a', speaker: 'cc' as const, model: 'model-a' }
  const sink = sinks.open('owner')
  const first = runtime.begin('owner', opts)
  opts.providerId = 'gateway-b'; opts.model = 'model-b'
  runtime.attach('owner', { attachment: { kind: 'voice', text: 'hello' }, send: async () => ({ ok: true }) })
  await first.deliver({ finalText: '', narration: [] })
  expect(sink.attribution?.()).toEqual({ speaker: 'cc', provider: 'gateway-a', model: 'model-a' })
  expect(sink.extras?.().attachments).toEqual([{ kind: 'voice', text: 'hello' }])
  sink.close()
  const next = sinks.open('owner')
  await runtime.begin('owner', { context: 'dm', speaker: 'agent', providerId: 'codex', matterId: 'work-a', agentId: 'run-a', turnId: 'turn-a' }).deliver({ finalText: 'done', narration: [] })
  expect(next.attribution?.()).toEqual({ speaker: 'agent', provider: 'codex', matterId: 'work-a', agentId: 'run-a', turnId: 'turn-a' })
  expect(next.close()).toBe('done')
})

it('projects the exact historical work turn and chat events, keeping notices out of agent identity', async () => {
  db = openTestDb()
  const matters = makeMatterStore(db), log = makeMatterLog(db)
  await makeMessagesStore(db).append({ id: 'origin', chatId: 'owner', ts: '2026-11-16T00:00:00Z', direction: 'in', kind: 'text', text: 'do it', source: 'desktop' })
  const work = matters.create({ kind: 'task', title: 'work', ownerChatId: 'owner', originMessageId: 'origin' })
  const first = log.startTurn({ matterId: work.id, executor: 'codex', model: 'first-model', runId: 'first-run' })
  log.writeItem({ matterId: work.id, turnId: first.id, kind: 'agent_message', status: 'completed', payload: { text: 'first result' } })
  log.finishTurn(first.id, { status: 'completed' })
  log.startTurn({ matterId: work.id, executor: 'claude', model: 'second-model', runId: 'second-run' })
  const result = ConversationWork.parse(ownerConversationWork(db, 'owner')).results[0]
  expect(result).toMatchObject({ speaker: 'agent', provider: 'codex', model: 'first-model', agentId: 'first-run', turnId: first.id, matterId: work.id })
  const chat = matters.ensureChat('owner'), turn = log.startTurn({ matterId: chat.id, executor: 'gateway-a', model: 'chat-model', policy: { speaker: 'cc' } })
  log.writeItem({ matterId: chat.id, turnId: turn.id, kind: 'agent_message', status: 'started', payload: { text: 'hello' } })
  log.writeItem({ matterId: chat.id, turnId: turn.id, kind: 'system', status: 'completed', payload: { text: 'notice' } })
  const events = ConversationEvents.parse(ownerConversationEvents(db, 'owner', 0)).events
  expect(events.find(e => e.text === 'hello')).toMatchObject({ speaker: 'cc', provider: 'gateway-a', model: 'chat-model', matterId: chat.id, turnId: turn.id })
  expect(events.find(e => e.text === 'notice')).toMatchObject({ speaker: 'notice' })
  expect(events.find(e => e.text === 'notice')).not.toHaveProperty('provider')
})

it('uses actual CC sessions through converse and keeps previous sources after a backend switch', async () => {
  db = openTestDb()
  const dir = mkdtempSync(join(tmpdir(), 'reply-attribution-'))
  mkdirSync(join(dir, 'companion'))
  writeFileSync(join(dir, 'companion/config.json'), JSON.stringify({ default_chat_id: 'owner' }))
  const registry = createProviderRegistry(), messages = makeMessagesStore(db), matters = makeMatterStore(db), log = makeMatterLog(db)
  for (const id of ['claude', 'codex']) registry.register(id, { spawn: async () => ({ async *dispatch() { yield { kind: 'text' as const, text: `${id} reply` }; yield { kind: 'result' as const, sessionId: id, numTurns: 1, durationMs: 0 } }, close: async () => {} }) }, { displayName: id, canResume: () => true })
  const manager = new SessionManager({ registry, maxConcurrent: 4, idleEvictMs: 60_000 }), sinks = makeReplySinks()
  const runtime = makeReplyDeliveryRuntime({ sendText: async () => { throw Error('must stay in app sink') }, sink: { captureReply: (c, r) => sinks.captureReply!(c, r) }, log: () => {} })
  const coordinator = createConversationCoordinator({ resolveProject: () => ({ alias: 'test', path: dir }), manager, registry, conversationStore: makeConversationStore(db), defaultProviderId: 'claude', permissionMode: 'strict', format: m => m.text, loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: ['owner'] }), replyDelivery: runtime, chatTurns: makeChatTurnLog({ db, log, matters }), log: () => {} })
  const converse = wireCompanionConverse({ stateDir: dir, boot: { coordinator, sessionManager: manager, resolve: () => ({ alias: 'test', path: dir }), defaultProviderId: 'claude' } as unknown as Bootstrap, careLedger: { resetNoReply: () => {} } as unknown as CareLedger, replySinks: sinks, messagesStore: messages, matters, ilink: { resolveAccountId: () => 'offline' }, appTurn: () => null, log: () => {} })
  try {
    const first = await converse('hello')
    expect(first).toMatchObject({ reply: 'claude reply', speaker: 'cc', provider: 'claude' })
    coordinator.setMode('owner', { kind: 'solo', provider: 'codex' })
    expect(await converse('hello again')).toMatchObject({ reply: 'codex reply', speaker: 'cc', provider: 'codex' })
    const history = ConversationWindow.parse(await makeOwnerConversationReader(db)('owner', { limit: 30 }))
    expect(history.messages.find(m => m.text === 'claude reply')).toMatchObject({ speaker: 'cc', provider: 'claude' })
    expect(history.messages.find(m => m.text === 'codex reply')).toMatchObject({ speaker: 'cc', provider: 'codex' })
    const events = ConversationEvents.parse(ownerConversationEvents(db, 'owner', 1))
    expect(events.events.find(e => e.text === 'claude reply')).toMatchObject({ speaker: 'cc', provider: 'claude' })
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }) }
})

it('retains each source in an aggregate sink, including attachment-only replies and rule notices', async () => {
  const sinks = makeReplySinks(), sink = sinks.open('owner')
  const runtime = makeReplyDeliveryRuntime({ sendText: async () => { throw Error('must stay in sink') }, sink: { captureReply: (c, r) => sinks.captureReply!(c, r) }, log: () => {} })
  await runtime.begin('owner', { context: 'parallel', speaker: 'agent', providerId: 'codex' }).deliver({ finalText: 'first', narration: [] })
  const second = runtime.begin('owner', { context: 'parallel', speaker: 'agent', providerId: 'claude' })
  runtime.attach('owner', { attachment: { kind: 'voice', text: 'second' }, send: async () => ({ ok: true }) })
  runtime.noteRuleAllow('owner', { key: 'r', rule: 'listed', target: 'ls' })
  await second.deliver({ finalText: '', narration: [] })
  expect(sink.attribution?.()).toBeUndefined()
  expect(sink.replyParts?.()).toMatchObject([
    { speaker: 'agent', provider: 'codex', text: 'first' },
    { speaker: 'agent', provider: 'claude', text: '', attachmentIndexes: [0] },
    { speaker: 'notice' },
  ])
  expect(sink.close()).toContain('first')
})

it('keeps an attachment with its actual caller when another parallel participant delivers first', async () => {
  const sinks = makeReplySinks(), sink = sinks.open('owner')
  const runtime = makeReplyDeliveryRuntime({ sendText: async () => ({ msgId: 'unused' }), sink: { captureReply: (c, r) => sinks.captureReply!(c, r) }, log: () => {} })
  const codex = runtime.begin('owner', { context: 'parallel', speaker: 'agent', providerId: 'codex' })
  const claude = runtime.begin('owner', { context: 'parallel', speaker: 'agent', providerId: 'claude' })
  runtime.attach('owner', { attachment: { kind: 'voice', text: 'from codex' }, send: async () => ({ ok: true }) }, 'codex')
  await claude.deliver({ finalText: 'claude reply', narration: [] })
  expect(sink.attribution?.()).toBeUndefined()
  expect(sink.replyParts?.()).toMatchObject([{ speaker: 'agent', provider: 'claude', text: 'claude reply' }, { speaker: 'agent', provider: 'codex', text: '', attachmentIndexes: [0] }])
  codex.abandon('done')
  sink.close()
})

it('records the successful eval provider and retains that source through a deferred notice reconstruction', async () => {
  db = openTestDb()
  const registry = createProviderRegistry()
  registry.register('claude', { spawn: async () => { throw Error('unused') }, cheapEval: async () => { throw Error('offline') } }, { displayName: 'Claude', canResume: () => false })
  registry.register('codex', { spawn: async () => { throw Error('unused') }, cheapEval: async () => 'narration' }, { displayName: 'Codex', canResume: () => false })
  const evaluated = await captureReplyAttribution(() => registry.getCheapEval()!('test'))
  expect(evaluated).toEqual({ result: 'narration', attribution: { speaker: 'cc', provider: 'codex' } })
  const queue = makePendingNotices({ db, log: () => {}, now: () => 1 })
  queue.add({ kind: 'social_story', chatId: 'owner', text: evaluated.result, attribution: evaluated.attribution })
  expect(makePendingNotices({ db, log: () => {} }).groups(2)[0]?.items[0]).toMatchObject({ text: 'narration', attribution: { speaker: 'cc', provider: 'codex' } })
})

it('projects matter history by exact turn through the public detail whitelist, including same-run model changes', async () => {
  db = openTestDb()
  const store = makeWorkbenchStore(db), log = makeMatterLog(db), timeline = makeTimelineEvents(db, log)
  const task = store.create({ title: 'test', path: '/tmp/offline-attribution', providerId: 'claude', ownerChatId: 'owner' })
  const first = log.startTurn({ matterId: task.id, executor: 'codex', model: 'first-model', runId: 'same-run' })
  timeline.recordAgentEvent(task.id, 'same-run', { kind: 'text', text: 'first reply', itemId: 'first' }, 1)
  log.finishTurn(first.id, { status: 'completed' })
  const second = log.startTurn({ matterId: task.id, executor: 'codex', model: 'second-model', runId: 'same-run' })
  timeline.recordAgentEvent(task.id, 'same-run', { kind: 'text', text: 'second reply', itemId: 'second' }, 2)
  timeline.addEvent(task.id, 'text', 'legacy reply', null, null, [], 3, null)
  timeline.addEvent(task.id, 'system', 'system notice', null, 'same-run', [], 4)
  const before = Math.max(...log.items(task.id).map(i => i.cursor))
  log.updateTurn(second.id, { model: 'updated-second-model' })
  expect(timeline.events(task.id, undefined, before).find(e => e.text === 'second reply')).toMatchObject({ model: 'updated-second-model' })
  const workbench = makeWorkbenchService({ store, registry: createProviderRegistry(), stateDir: '/tmp/offline-attribution', ownerChatId: () => 'owner' })
  try {
    const service = makeMattersService({ store: makeMatterStore(db), log, workbench })
    const detail = MatterDetail.parse(await service.detail(task.id))
    expect(detail.events.find(e => e.text === 'first reply')).toMatchObject({ speaker: 'agent', provider: 'codex', model: 'first-model', agentId: 'same-run', turnId: first.id })
    expect(detail.events.find(e => e.text === 'second reply')).toMatchObject({ speaker: 'agent', provider: 'codex', model: 'updated-second-model', turnId: second.id })
    expect(detail.events.find(e => e.text === 'legacy reply')).not.toHaveProperty('provider')
    expect(detail.events.find(e => e.text === 'system notice')).toMatchObject({ speaker: 'notice' })
  } finally { await workbench.shutdown() }
})

it('persists one fixed execution source across bubbles and media while notices have their own identity', async () => {
    db = openTestDb()
    const deps = { db, conversationStore: makeConversationStore(db) }, stateDir = mkdtempSync(join(tmpdir(), 'wcc-attribution-outbound-'))
    const wireTexts: string[] = []
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => { const body = JSON.parse(String(options.body)); wireTexts.push(body.msg.item_list[0].text_item.text); return Response.json({ ret: 0 }) })
    const adapter = makeIlinkAdapter({ stateDir, accounts: [{ id: 'A1', botId: 'b', userId: 'ubot', baseUrl: 'https://ilink.example', token: 'T', syncBuf: '' }], ...deps })
    const store = makeMessagesStore(deps.db)
    const mirror = makeMediaMirror({ ownerChatId: () => 'chat-1', stickerDir: null, stickerLabel: () => null, scratchRoots: [], append: r => store.append(r), touched: () => {}, log: () => {} })
    const runtime = makeReplyDeliveryRuntime({ sendText: (c, t) => adapter.sendMessage(c, t), sleep: async () => {}, log: () => {} })
    try {
      adapter.captureContextToken('chat-1', 'tok-1')
      const opts = { context: 'dm' as const, speaker: 'agent' as const, providerId: 'codex', model: 'first-model', matterId: 'work', agentId: 'run', turnId: 'turn' }
      const turn = runtime.begin('chat-1', opts)
      opts.providerId = 'claude'; opts.model = 'later-model'
      runtime.attach('chat-1', { attachment: { kind: 'voice', text: 'spoken attachment' }, send: async () => { mirror.noteSent('chat-1', { kind: 'voice', text: 'spoken attachment' }); return { ok: true } } })
      await turn.deliver({ finalText: '第一条回复有足够的内容\n\n第二条回复也有足够的内容', narration: [] })
      await adapter.sendMessage('chat-1', 'system notice')
      const rows = await store.listRange('chat-1', { limit: 10 })
      expect(rows.filter(r => r.text !== 'system notice')).toHaveLength(3)
      for (const row of rows.filter(r => r.text !== 'system notice')) expect(row).toMatchObject({ speaker: 'agent', provider: 'codex', model: 'first-model', matterId: 'work', agentId: 'run', turnId: 'turn' })
      expect(rows.find(r => r.text === 'system notice')).toMatchObject({ speaker: 'notice' })
      expect(rows.find(r => r.text === 'system notice')).not.toHaveProperty('provider')
      expect(wireTexts).toEqual(['第一条回复有足够的内容', '第二条回复也有足够的内容', 'system notice'])
    } finally { vi.unstubAllGlobals(); await adapter.flush(); rmSync(stateDir, { recursive: true, force: true }) }
  })
