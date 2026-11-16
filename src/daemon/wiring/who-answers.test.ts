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

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function setup(options: { unavailable?: boolean; gate?: NetworkGate; trusted?: boolean; fail?: boolean; onSpawn?: () => void } = {}) {
  const db = openTestDb(), stateDir = mkdtempSync(join(tmpdir(), 'who-answers-'))
  mkdirSync(join(stateDir, 'companion'))
  writeFileSync(join(stateDir, 'companion/config.json'), JSON.stringify({ default_chat_id: 'owner' }))
  const registry = createProviderRegistry({ networkGate: options.gate }), sinks = makeReplySinks(), messages = makeMessagesStore(db)
  const spawns: Array<{ provider: string; alias: string; ephemeral?: boolean; instructions?: string; resume?: string }> = []
  const prompts: Array<{ provider: string; text: string }> = [], closed: string[] = [], revoked: string[] = []
  for (const id of ['claude', 'codex']) registry.register(id, {
    callTarget: () => ({ provider: id, model: `${id}-test` }),
    spawn: async (project, ctx) => {
      // 白名单采集；不读取或断言 spawn 的环境字段。
      spawns.push({ provider: id, alias: project.alias, ephemeral: ctx.ephemeral, instructions: ctx.appendInstructions, resume: ctx.resumeSessionId })
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
  const notices: string[] = []
  const coordinator = createConversationCoordinator({ resolveProject: () => ({ alias: 'fixture', path: stateDir }), manager, registry,
    conversationStore: makeConversationStore(db), defaultProviderId: 'claude', permissionMode: 'strict', format: formatInbound,
    recentTurns: async () => [{ text: 'PRIVATE_HISTORY', dir: 'in' as const, ts: '2026-11-16T00:00:00Z' }],
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['owner'], admins: options.trusted ? [] : ['owner'] }), trustedProviders: () => ['claude'],
    replyDelivery: runtime, networkGate: options.gate, log: () => {}, sendNotice: async (_c, text) => { notices.push(text); sinks.capture('owner', text) },
  })
  const route = makeMwRoute({ probes: {}, providers: () => [{ id: 'codex', names: ['Codex'], available: !options.unavailable }, { id: 'claude', names: ['Claude'], available: true }], log: () => {} })
  const topicRecall = vi.fn(async () => ({ block: 'PRIVATE_TOPIC', topicIds: [], entryIds: [], via: 'exact' as const })), matterRecall = vi.fn(async () => 'PRIVATE_MATTERS')
  const converse = wireCompanionConverse({ stateDir, boot: { coordinator, sessionManager: manager, resolve: () => ({ alias: 'fixture', path: stateDir }), defaultProviderId: 'claude' } as unknown as Bootstrap,
    careLedger: { resetNoReply: () => {} } as unknown as CareLedger, replySinks: sinks, messagesStore: messages,
    ilink: { resolveAccountId: () => 'offline' }, appTurn: () => async ctx => { await route(ctx, async () => {}); return { consumed: false } }, log: () => {}, topicRecall, matterRecall,
  })
  cleanups.push(async () => { await manager.shutdown(); db.close(); rmSync(stateDir, { recursive: true, force: true }) })
  return { converse, coordinator, manager, spawns, prompts, closed, revoked, instructions, rotation, messages, notices, topicRecall, matterRecall, tokens, minted }
}

it('一次代答用隔离会话、原样交付且记 agent 来源；下一句与原 CC 会话续聊', async () => {
  const t = setup()
  await t.converse('先聊一句')
  const before = t.rotation.opened.mock.calls.length
  const result = await t.converse('让 Codex 回答这个问题: 2+2')
  expect(result).toMatchObject({ reply: 'codex 原样答复', speaker: 'agent', provider: 'codex' })
  expect(t.coordinator.getMode('owner')).toEqual({ kind: 'solo', provider: 'claude' })
  const spawned = t.spawns.find(s => s.provider === 'codex')!
  expect(spawned).toMatchObject({ ephemeral: true })
  expect(spawned.resume).toBeUndefined()
  expect(spawned.alias).not.toBe('fixture')
  expect(spawned.instructions).toContain('硬规矩')
  expect(spawned.instructions).not.toContain('CC_PRIVATE')
  expect(t.prompts.find(p => p.provider === 'codex')?.text).not.toMatch(/PRIVATE_/)
  expect(t.rotation.opened.mock.calls.length).toBe(before)
  expect(t.closed).toEqual(['codex'])
  expect(t.revoked).toEqual([`codex/${spawned.alias}/owner`])
  const permission = t.tokens.resolve(t.minted.find(m => m.key.startsWith('codex/'))!.token)
  expect(permission?.routeAllow).toEqual(new Set())
  expect(permission?.routeAllow?.has('POST /v1/conversation/set-mode')).toBe(false)
  expect(permission?.routeAllow?.has('GET /v1/memory/search')).toBe(false)
  expect(t.manager.has({ alias: 'fixture', chatId: 'owner', providerId: 'claude' })).toBe(true)
  expect(await t.converse('接着聊')).toMatchObject({ reply: 'claude 原样答复', speaker: 'cc', provider: 'claude' })
  expect(t.spawns.map(s => s.provider)).toEqual(['claude', 'codex'])
  expect(t.instructions).toHaveBeenCalledTimes(1)
  expect(t.topicRecall).toHaveBeenCalledTimes(2)
  expect(t.matterRecall).toHaveBeenCalledTimes(2)
  expect((await t.messages.listRange('owner', { limit: 20 })).find(m => m.text === 'codex 原样答复')).toMatchObject({ speaker: 'agent', provider: 'codex' })
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
