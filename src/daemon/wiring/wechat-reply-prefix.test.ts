import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProviderRegistry } from '../../app/provider-registry'
import { createConversationCoordinator } from '../../app/conversation-coordinator'
import { SessionManager } from '../../app/session-manager'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeIlinkAdapter } from '../ilink-glue'
import { replyDeliveryModule } from '../ilink/module'
import { makeReplySinks } from '../reply-sinks'
import { makeProactiveOutbound } from '../companion/proactive-channel'
import type { Foundation } from '../foundation'
import type { ModuleCtx } from '../modules/container'

const first = '第一条回复有足够的内容'
const second = '第二条回复也有足够的内容'
const body = `${first}\n\n${second}`
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllGlobals()
})

// Real coordinator → production delivery module → ilink adapter → temporary message DB.
// Only the provider process and HTTP fetch are replaced; no listener or live state is used.
async function setup() {
  const db = openTestDb(), stateDir = mkdtempSync(join(tmpdir(), 'wechat-reply-prefix-'))
  const conversationStore = makeConversationStore(db), messages = makeMessagesStore(db)
  const registry = createProviderRegistry(), sinks = makeReplySinks(), wire: string[] = []
  for (const id of ['claude', 'codex', 'custom-acp']) registry.register(id, {
    spawn: async () => ({
      async *dispatch() {
        yield { kind: 'text' as const, text: body }
        yield { kind: 'result' as const, sessionId: id, numTurns: 1, durationMs: 0 }
      },
      close: async () => {},
    }),
  }, { displayName: id === 'custom-acp' ? '小助手' : 'ignored-model-name', canResume: () => true })
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    const payload = JSON.parse(String(options.body))
    wire.push(payload.msg.item_list[0].text_item.text)
    return Response.json({ ret: 0 })
  })
  const adapter = makeIlinkAdapter({ stateDir, db, conversationStore, accounts: [{ id: 'offline', botId: 'bot', userId: 'bot', baseUrl: 'https://ilink.example', token: 'fixture', syncBuf: '' }] })
  adapter.captureContextToken('owner', 'fixture')
  const module = replyDeliveryModule({ replySinks: sinks, outboundTaps: { observe: () => {} }, chatPrefs: { get: () => undefined } } as unknown as Foundation)
  const runtime = await module.init({ get: () => adapter, late: () => () => ({ registry }) } as unknown as ModuleCtx)
  const manager = new SessionManager({ registry, maxConcurrent: 4, idleEvictMs: 60_000 })
  const coordinator = createConversationCoordinator({
    resolveProject: () => ({ alias: 'fixture', path: stateDir }), registry, manager, conversationStore,
    defaultProviderId: 'claude', permissionMode: 'strict', format: m => m.text,
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: ['owner'] }),
    oneoffWorkspace: () => mkdtempSync(join(stateDir, 'oneoff-')),
    releaseOneoffWorkspace: path => rmSync(path, { recursive: true, force: true }),
    replyDelivery: runtime, log: () => {},
  })
  cleanups.push(async () => { await manager.shutdown(); await adapter.flush(); db.close(); rmSync(stateDir, { recursive: true, force: true }) })
  return { runtime, coordinator, sinks, wire, messages }
}

it('单次代答每个微信气泡用 registry 短名；CC 与通知无标；存库保留原文和来源', async () => {
  const t = await setup()
  const inbound = { chatId: 'owner', userId: 'owner', accountId: 'offline', text: '这个问题', msgType: 'text' as const, createTimeMs: 1 }
  await t.coordinator.dispatch({ ...inbound, answerTarget: { kind: 'oneoff', provider: 'codex', reason: 'explicit', requestId: 'fixture-oneoff' } })
  await t.coordinator.dispatch({ ...inbound, createTimeMs: 2 })
  await t.runtime.begin('owner', { context: 'dm', speaker: 'notice', providerId: 'codex' }).deliver({ finalText: '系统通知', narration: [] })
  expect(t.wire).toEqual([`[Codex] ${first}`, `[Codex] ${second}`, first, second, '系统通知'])
  const rows = await t.messages.listRange('owner', { limit: 10 })
  expect(rows.map(r => r.text).sort()).toEqual([first, second, first, second, '系统通知'].sort())
  expect(rows.filter(r => r.speaker === 'agent')).toMatchObject([{ provider: 'codex' }, { provider: 'codex' }])
  expect(rows.filter(r => r.speaker === 'cc')).toMatchObject([{ provider: 'claude' }, { provider: 'claude' }])
  expect(rows.find(r => r.text === '系统通知')).toMatchObject({ speaker: 'notice' })
  expect(t.coordinator.getMode('owner')).toEqual({ kind: 'solo', provider: 'claude' })
})

it('旧 /both 不双加，聊天型的每段一致；自定义执行者用注册名而非模型名', async () => {
  const t = await setup()
  await t.runtime.begin('owner', { context: 'parallel', speaker: 'agent', providerId: 'codex', participantLabel: 'Codex', textStrategy: 'all_segments', model: 'not-a-display-name' })
    .deliver({ finalText: second, narration: [first] })
  await t.runtime.begin('owner', { context: 'dm', speaker: 'agent', providerId: 'custom-acp', model: 'not-a-display-name' })
    .deliver({ finalText: '自定义的回复', narration: [] })
  expect(t.wire).toEqual([`[Codex] ${first}`, `[Codex] ${second}`, '[小助手] 自定义的回复'])
  expect((await t.messages.listRange('owner', { limit: 10 })).map(r => r.text).sort()).toEqual([first, second, '自定义的回复'].sort())
})

it('App 接收器拿原文、分段和附件；已有 participantLabel 也不进入正文', async () => {
  const t = await setup(), sink = t.sinks.open('owner')
  const turn = t.runtime.begin('owner', { context: 'parallel', speaker: 'agent', providerId: 'codex', participantLabel: 'Codex' })
  const send = vi.fn(async () => ({ ok: true }))
  t.runtime.attach('owner', { attachment: { kind: 'voice', text: '语音原文' }, send }, 'codex')
  await turn.deliver({ finalText: body, narration: [] })
  expect(sink.attribution?.()).toMatchObject({ speaker: 'agent', provider: 'codex' })
  expect(sink.extras?.().attachments).toEqual([{ kind: 'voice', text: '语音原文' }])
  expect(sink.close()).toBe(body)
  expect(send).not.toHaveBeenCalled()
  expect(t.wire).toEqual([])
})

it('微信语音失败按附件自己的来源标名；图片/文件不多发文字，通知与固定进度不标名', async () => {
  const t = await setup()
  const codex = t.runtime.begin('owner', { context: 'parallel', speaker: 'agent', providerId: 'codex' })
  const claude = t.runtime.begin('owner', { context: 'parallel', speaker: 'agent', providerId: 'claude', participantLabel: 'Claude' })
  const media = vi.fn(async () => ({ ok: true }))
  t.runtime.attach('owner', { attachment: { kind: 'voice', text: '语音原文' }, send: async () => ({ ok: false, error: 'fixture' }) }, 'codex')
  t.runtime.attach('owner', { attachment: { kind: 'sticker', ref: { tag: '开心' } }, send: media }, 'claude')
  t.runtime.attach('owner', { attachment: { kind: 'file', path: join(tmpdir(), 'fixture.png') }, send: media }, 'claude')
  t.runtime.noteRuleAllow('owner', { key: 'fixture', rule: '离线规则', target: 'ls' })
  await claude.progress('模型进度', 'model')
  await claude.progress('固定进度')
  await claude.deliver({ finalText: '', narration: [] })
  codex.abandon('fixture done')
  expect(t.wire.slice(0, 3)).toEqual(['[Claude] 模型进度', '固定进度', '[Codex] 语音原文'])
  expect(t.wire).toHaveLength(4)
  expect(t.wire[3]).toMatch(/^按规则/)
  expect(media).toHaveBeenCalledTimes(2)
  const rows = await t.messages.listRange('owner', { limit: 10 })
  expect(rows.find(r => r.text === '语音原文')).toMatchObject({ speaker: 'agent', provider: 'codex' })
})

it.each(['closed', 'failed'] as const)('微信出口%s时回退 App，原文落库与推送均无展示前缀', async state => {
  const t = await setup(), recorded: string[] = [], pushed: string[] = []
  const outbound = makeProactiveOutbound({
    wechatDegraded: () => false, wechatClosedSince: () => state === 'closed' ? 'fixture' : null,
    sendWechat: async () => ({ msgId: 'fixture', error: 'offline failure' }),
    app: () => ({ deliverable: () => true, record: async (_c, text) => { recorded.push(text); return true }, push: text => { pushed.push(text) } }),
    log: () => {},
  }).open('owner')
  const turn = t.runtime.begin('owner', { context: 'dm', speaker: 'agent', providerId: 'codex', outbound })
  t.runtime.attach('owner', { attachment: { kind: 'voice', text: '语音原文' }, send: async () => { throw Error('must stay in app') } }, 'codex')
  await turn.deliver({ finalText: body, narration: [] })
  outbound.finish()
  expect(recorded).toEqual([first, second, '语音原文'])
  expect(pushed).toEqual([`${body}\n\n语音原文`])
  expect(t.wire).toEqual([])
})
