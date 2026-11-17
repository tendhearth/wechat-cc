import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { createProviderRegistry } from '../../app/provider-registry'
import { SessionManager } from '../../app/session-manager'
import { createConversationCoordinator } from '../../app/conversation-coordinator'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import { makeReplyDeliveryRuntime } from '../reply-delivery'
import { makeReplySinks } from '../reply-sinks'
import { wireCompanionConverse } from './wire-converse'
import { makeMwRoute } from '../inbound/mw-route'
import { formatInbound } from '../../domain/prompt-format'
import type { Bootstrap } from '../bootstrap'
import type { CareLedger } from '../../features/companion'
import type { NetworkGate } from '../../lib/network-gate'
import { classifyCall } from '../../lib/call-classifier'
import { makeTokenRegistry } from '../internal-api/token-registry'
import { scopedSend } from '../inbound/reply-scope'
import { makeCheapAnswerJudge } from '../inbound/answer-fallback'
import type { InboundCtx } from '../inbound/types'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function setup(options: { unavailable?: boolean; gate?: NetworkGate; trusted?: boolean; fail?: boolean; onSpawn?: () => void; evaluate?: (prompt: string) => Promise<string> } = {}) {
  const db = openTestDb(), stateDir = mkdtempSync(join(tmpdir(), 'who-answers-'))
  mkdirSync(join(stateDir, 'companion'))
  writeFileSync(join(stateDir, 'companion/config.json'), JSON.stringify({ default_chat_id: 'owner' }))
  const registry = createProviderRegistry({ networkGate: options.gate }), sinks = makeReplySinks(), messages = makeMessagesStore(db)
  const spawns: Array<{ provider: string; alias: string; path?: string; ephemeral?: boolean; instructions?: string; resume?: string; permissionMode?: string; allow?: string[] }> = []
  const prompts: Array<{ provider: string; text: string }> = [], closed: string[] = [], revoked: string[] = []
  for (const id of ['claude', 'codex', 'grok']) registry.register(id, {
    callTarget: () => ({ provider: id, model: `${id}-test` }),
    spawn: async (project, ctx) => {
      // 白名单采集；不读取或断言 spawn 的环境字段。
      spawns.push({ provider: id, alias: project.alias, path: project.path, ephemeral: ctx.ephemeral, instructions: ctx.appendInstructions, resume: ctx.resumeSessionId, permissionMode: ctx.permissionMode, allow: [...(ctx.tierProfile?.allow ?? [])] })
      options.onSpawn?.()
      return { async *dispatch(text) {
        prompts.push({ provider: id, text })
        if (options.fail && id === 'codex') { yield { kind: 'error' as const, message: 'not logged in', code: 'auth_failed' }; return }
        yield { kind: 'text' as const, text: `${id} 原样答复` }
        yield { kind: 'result' as const, sessionId: id, numTurns: 1, durationMs: 0 }
      }, close: async () => { closed.push(id) } }
    },
  }, { canResume: () => true })
  const instructions = vi.fn(() => 'CC_PRIVATE_INSTRUCTIONS')
  const tokens = makeTokenRegistry()
  const minted: Array<{ key: string; token: string }> = []
  const rotation = { isOwnerChat: () => true, opened: vi.fn(), tracked: () => false, started: vi.fn(), observe: vi.fn(), isInFlight: () => false, beforeTurn: async () => null, needsContinuation: () => false, eventsBlock: async () => null, delivered: () => {} }
  const manager = new SessionManager({ registry, maxConcurrent: 4, idleEvictMs: 60_000, buildInstructions: instructions, contextRotation: rotation as never,
    mintSessionToken: (tier, key, opts) => { const token = tokens.mint(tier, key, opts); minted.push({ key, token }); return token },
    invalidateSessionToken: key => { revoked.push(key) },
  })
  const runtime = makeReplyDeliveryRuntime({ sendText: async () => { throw Error('must stay in sink') }, sink: { captureReply: (c, r) => sinks.captureReply!(c, r) }, log: () => {} })
  const notices: string[] = [], workspaces: string[] = [], released: string[] = []
  const coordinator = createConversationCoordinator({ resolveProject: () => ({ alias: 'fixture', path: stateDir }), manager, registry,
    oneoffWorkspace: () => { const w = mkdtempSync(join(tmpdir(), 'who-oneoff-')); workspaces.push(w); return w }, releaseOneoffWorkspace: w => { released.push(w); rmSync(w, { recursive: true, force: true }) },
    conversationStore: makeConversationStore(db), defaultProviderId: 'claude', permissionMode: 'strict', format: formatInbound,
    recentTurns: async () => [{ text: 'PRIVATE_HISTORY', dir: 'in' as const, ts: '2026-11-16T00:00:00Z' }],
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['owner'], admins: options.trusted ? [] : ['owner'] }), trustedProviders: () => ['claude'],
    replyDelivery: runtime, networkGate: options.gate, log: () => {}, sendNotice: async (_c, text) => { notices.push(text); sinks.capture('owner', text) },
  })
  const route = makeMwRoute({ probes: {}, providers: () => [{ id: 'codex', names: ['Codex'], available: !options.unavailable }, { id: 'grok', names: ['Grok'], available: true }, { id: 'claude', names: ['Claude'], available: true }], log: () => {},
    ...(options.evaluate ? { judge: makeCheapAnswerJudge(options.evaluate) } : {}),
    sendMessage: scopedSend(async (_c, text) => { notices.push(text) }),
  })
  const topicRecall = vi.fn(async () => ({ block: 'PRIVATE_TOPIC', topicIds: [], entryIds: [], via: 'exact' as const })), matterRecall = vi.fn(async () => 'PRIVATE_MATTERS')
  const converse = wireCompanionConverse({ stateDir, boot: { coordinator, sessionManager: manager, resolve: () => ({ alias: 'fixture', path: stateDir }), defaultProviderId: 'claude' } as unknown as Bootstrap,
    careLedger: { resetNoReply: () => {} } as unknown as CareLedger, replySinks: sinks, messagesStore: messages,
    ilink: { resolveAccountId: () => 'offline' }, appTurn: () => async ctx => { let consumed = true; await route(ctx, () => route.consume(ctx, async () => { consumed = false })); return { consumed } }, log: () => {}, topicRecall, matterRecall,
  })
  cleanups.push(async () => { await manager.shutdown(); db.close(); rmSync(stateDir, { recursive: true, force: true }) })
  // 落库 id 是 app:<来源>:<毫秒>:in/out;测试一毫秒内连发两句会撞 id 被当重复丢掉(主人不会这样发)。每句前等时钟走一格。
  let lastAt = 0
  const send = async (...args: Parameters<typeof converse>) => { while (Date.now() <= lastAt) await new Promise(r => setTimeout(r, 1)); try { return await converse(...args) } finally { lastAt = Date.now() } }
  return { route, workspaces, released, converse: send, coordinator, manager, spawns, prompts, closed, revoked, instructions, rotation, messages, notices, topicRecall, matterRecall, tokens, minted }
}

it.each(['codex', 'grok'])('%s 一次代答用隔离会话、原样交付且记 agent 来源；下一句与原 CC 会话续聊', async provider => {
  const t = setup()
  await t.converse('先聊一句')
  const before = t.rotation.opened.mock.calls.length
  const result = await t.converse(`让 ${provider} 回答这个问题: 2+2`)
  expect(result).toMatchObject({ reply: `${provider} 原样答复`, speaker: 'agent', provider })
  expect(t.coordinator.getMode('owner')).toEqual({ kind: 'solo', provider: 'claude' })
  const spawned = t.spawns.find(s => s.provider === provider)!
  expect(spawned).toMatchObject({ ephemeral: true, permissionMode: 'strict', allow: ['reply'] })
  // 评审 P1:代答不在主人的项目里跑,用一次性的空目录,答完删掉。
  expect(spawned.path).toBe(t.workspaces[0])
  expect(spawned.path).not.toBe(t.spawns[0]!.path)
  expect(t.released).toEqual(t.workspaces)
  expect(spawned.resume).toBeUndefined()
  expect(spawned.alias).not.toBe('fixture')
  expect(spawned.instructions).toContain('硬规矩')
  expect(spawned.instructions).not.toContain('CC_PRIVATE')
  expect(t.prompts.find(p => p.provider === provider)?.text).not.toMatch(/PRIVATE_/)
  expect(t.rotation.opened.mock.calls.length).toBe(before)
  expect(t.closed).toEqual([provider])
  expect(t.revoked).toEqual([`${provider}/${spawned.alias}/owner`])
  const permission = t.tokens.resolve(t.minted.find(m => m.key.startsWith(`${provider}/`))!.token)
  expect(permission?.routeAllow).toEqual(new Set())
  expect(permission?.routeAllow?.has('POST /v1/conversation/set-mode')).toBe(false)
  expect(permission?.routeAllow?.has('GET /v1/memory/search')).toBe(false)
  expect(t.manager.has({ alias: 'fixture', chatId: 'owner', providerId: 'claude' })).toBe(true)
  expect(await t.converse('接着聊')).toMatchObject({ reply: 'claude 原样答复', speaker: 'cc', provider: 'claude' })
  expect(t.spawns.map(s => s.provider)).toEqual(['claude', provider])
  expect(t.instructions).toHaveBeenCalledTimes(1)
  expect(t.topicRecall).toHaveBeenCalledTimes(2)
  expect(t.matterRecall).toHaveBeenCalledTimes(2)
  // 落库在回复交付之后异步写;等它落下再看来源,不赌时序。
  await vi.waitFor(async () => expect((await t.messages.listRange('owner', { limit: 20 })).find(m => m.text === `${provider} 原样答复`)).toMatchObject({ speaker: 'agent', provider }))
})

it('spawn 后网络失保护也说明失败并问 CC，释放代答会话且不重放', async () => {
  const state = { safe: true }
  const gate: NetworkGate = { classify: classifyCall, check: async () => ({ safe: state.safe, source: 'bx', detail: 'offline fixture' }) }
  const t = setup({ gate, onSpawn: () => { state.safe = false } })
  expect((await t.converse('让 Codex 回答这个问题: 2+2')).reply).toMatch(/CC.*[？?]/)
  expect(t.spawns.map(s => s.provider)).toEqual(['codex'])
  expect(t.prompts).toEqual([])
  expect(t.closed).toEqual(['codex'])
})

it.each(['unavailable', 'trusted', 'network', 'auth'] as const)('点名失败不代换、不改 Mode：%s', async reason => {
  const gate: NetworkGate = { classify: classifyCall, check: async () => ({ safe: false, source: 'bx', detail: 'offline fixture' }) }
  const t = setup({ unavailable: reason === 'unavailable', trusted: reason === 'trusted', gate: reason === 'network' ? gate : undefined, fail: reason === 'auth' })
  const result = await t.converse('让 Codex 回答这个问题: 2+2')
  expect(result.reply).toMatch(/CC.*[？?]/)
  expect(result.reply).not.toContain('claude 原样答复')
  expect(t.spawns.map(s => s.provider)).toEqual(reason === 'auth' ? ['codex'] : [])
  expect(t.coordinator.getMode('owner')).toEqual({ kind: 'solo', provider: 'claude' })
  expect(t.topicRecall).not.toHaveBeenCalled()
  expect(t.matterRecall).not.toHaveBeenCalled()
})

it('PR3 App 歧义下一句选名字：原句单次代答，已送出纠正不重放', async () => {
  const t = setup()
  const question = await t.converse('Codex 还是 Claude 说说：2+2？')
  expect(question.reply).toContain('还是我来答')
  expect(t.prompts).toHaveLength(0)
  expect(await t.converse('Codex')).toMatchObject({ speaker: 'agent', provider: 'codex', reply: 'codex 原样答复' })
  expect(t.prompts).toHaveLength(1)
  expect(t.prompts[0]?.text).toContain('Codex 还是 Claude 说说：2+2？')
  const correction = await t.converse('不是这件')
  expect(correction.reply).toContain('已送达')
  expect((await t.converse('换成 Claude 答')).reply).toContain('不会自动改投')
  expect(t.prompts).toHaveLength(1)
})

it('PR3 模型 fallback 在真实协调器成为隔离代答，乱回仍由 CC 答', async () => {
  for (const raw of ['1', '1 或 2']) {
    const t = setup({ evaluate: async () => raw })
    expect(await t.converse('我想请 Codex 看看这个问题')).toMatchObject({ speaker: raw === '1' ? 'agent' : 'cc', provider: raw === '1' ? 'codex' : 'claude' })
  }
})

it('PR3 排队尚未提交时只改单句目标，原句附件与回执只送一次', async () => {
  const t = setup()
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  const busy = t.coordinator.submitTurn({ chatId: 'owner', userId: 'owner', accountId: 'test', text: '占用队列', msgType: 'text', createTimeMs: 1 }, { within: async dispatch => { entered(); await hold; await dispatch() } })
  await ready
  const ctx: InboundCtx = { msg: { chatId: 'owner', userId: 'owner', accountId: 'test', text: '让 Codex 回答：看附件', attachments: [{ kind: 'file', path: '/fixture/NOTES.txt' }], msgType: 'text', createTimeMs: 2 }, requestId: 'queued-original', receivedAtMs: 2 }
  await t.route(ctx, async () => {})
  const queued = t.coordinator.submitTurn(ctx.msg)
  const correction: InboundCtx = { msg: { chatId: 'owner', userId: 'owner', accountId: 'test', text: '换成 Claude 答', msgType: 'text', createTimeMs: 3 }, requestId: 'correction', receivedAtMs: 3 }
  await t.route(correction, () => t.route.consume(correction, async () => { throw Error('correction must be consumed') }))
  release()
  await busy; await queued
  await t.coordinator.submitTurn(ctx.msg)
  expect(t.prompts).toHaveLength(2)
  expect(t.prompts[1]?.provider).toBe('claude')
  expect(t.prompts[1]?.text).toContain('让 Codex 回答：看附件')
  expect(t.prompts[1]?.text).toContain('/fixture/NOTES.txt')
  expect(t.coordinator.getMode('owner')).toEqual({ kind: 'solo', provider: 'claude' })
})

it('PR3 选择原句后，App 历史同时保留澄清和真正答复', async () => {
  const t = setup()
  let time = Date.now()
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => time)
  try {
    await t.converse('Codex 还是 Claude 说说：2+2？')
    time += 1000
    await t.converse('Codex')
    const history = await t.messages.listRange('owner', { limit: 20 })
    expect(history.some(m => m.text === 'codex 原样答复' && m.speaker === 'agent')).toBe(true)
    expect(history.some(m => m.text.includes('还是我来答'))).toBe(true)
  } finally { dateNow.mockRestore() }
})

it('PR3 守护在实际发送前拒绝，纠正回执不声称原句已送达', async () => {
  const state = { safe: true }
  const gate: NetworkGate = { classify: classifyCall, check: async () => ({ safe: state.safe, source: 'bx', detail: 'offline fixture' }) }
  const t = setup({ gate, onSpawn: () => { state.safe = false } })
  await t.converse('让 Codex 回答：2+2？')
  const correction = await t.converse('不是这件')
  expect(t.prompts).toHaveLength(0)
  expect(correction.reply).not.toContain('原句已送达')
  expect(correction.reply).toContain('不会自动改投')
})
