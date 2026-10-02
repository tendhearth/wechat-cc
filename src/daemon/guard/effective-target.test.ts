/**
 * 评审 #193 P1-1:守护判的目标必须是执行者**真正**连的那一个。
 *
 * 闸门过去按「此刻的配置」补端点 / 模型(targets.ts makeResolveTarget),而执行者 / 会话用的是
 * 它们起来那一刻定下的端点和模型。配置一改,两边就分家:配置切到 DeepSeek ⇒ 守护说不需要保护
 * ⇒ 放行,可在用的会话还在连官方 OpenAI。这里用 daemon 的真闸门(按配置补目标的那一份)+
 * 真的 provider 工厂 + 真的 SessionManager / registry 把这几种分家场景钉住。
 */
import { describe, expect, it, vi } from 'vitest'
import { createNetworkGate } from './gate'
import { initialState, type GuardState } from './scheduler'
import { makeResolveTarget } from './targets'
import type { AgentConfig } from '../../lib/agent-config'
import { createProviderRegistry } from '../../core/provider-registry'
import { SessionManager } from '../../core/session-manager'
import { createOpenAiAgentProvider } from '../../core/openai-agent-provider'
import { createAcpCursorChatProvider } from '../../core/acp-cursor-chat'
import type { AgentProvider } from '../../core/agent-provider'
import { makeFakeSession } from '../../core/test-helpers'
import { TIER_PROFILES } from '../../core/user-tier'

function daemonGate(cfg: Partial<AgentConfig>, net: { safe: boolean }, env: NodeJS.ProcessEnv = {}) {
  const check = vi.fn()
  const g = createNetworkGate({
    isEnabled: () => true,
    current: (): GuardState => ({ ...initialState(), source: 'bx', safe: net.safe, reachable: net.safe, detail: net.safe ? 'bx 保护中' : 'bx 未保护', lastChecked: new Date().toISOString() }),
    findBx: () => '/fake/bx',
    readBx: async () => { throw new Error('tests never call the real bx') },
    resolveTarget: makeResolveTarget(() => cfg as AgentConfig, env),
  })
  return { gate: { check: async () => { check(); return g.check() }, classify: g.classify }, check }
}

const drain = async (it: AsyncIterable<unknown>) => { for await (const _ of it) { /* drain */ } }
const req = (chatId: string, providerId: string) => ({ alias: 'a', path: '/tmp', providerId: providerId as never, chatId, tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' as const })

describe('guard classifies the target the executor actually uses (review #193 P1)', () => {
  it('openai-compatible session started on official OpenAI, config then switched to DeepSeek → still protected', async () => {
    const cfg: Partial<AgentConfig> = { openaiBaseUrl: 'https://api.openai.com/v1', openaiModel: 'gpt-5' }
    const net = { safe: true }
    const { gate } = daemonGate(cfg, net)
    const generate = vi.fn(async () => 'should never run')
    const chatModel = { streamTurn: vi.fn(), generate, userMessage: (t: string) => ({ role: 'user', content: t }), systemMessage: (t: string) => ({ role: 'system', content: t }), toolResultMessage: vi.fn() }
    // 端点在 boot 时定下(和 bootstrap/providers.ts 一样:openaiBaseUrl 是注册那一刻读的)。
    const provider = createOpenAiAgentProvider({
      endpoint: { baseUrl: cfg.openaiBaseUrl!, model: cfg.openaiModel! },
      makeChatModel: () => chatModel as never,
      makeMcpBridge: async () => ({ tools: [], call: async () => '', close: async () => {}, serverOf: () => undefined }) as never,
    })
    const registry = createProviderRegistry({ networkGate: gate })
    registry.register('openai', provider, { displayName: 'OpenAI-compatible', canResume: () => false })
    const mgr = new SessionManager({ maxConcurrent: 4, idleEvictMs: 60_000, registry, networkGate: gate })
    const h = await mgr.acquire(req('c1', 'openai'))

    // 主人把配置切到 DeepSeek,但没有重启:在用的会话 / provider 还连着官方 OpenAI。
    cfg.openaiBaseUrl = 'https://api.deepseek.com/v1'
    net.safe = false

    await expect(drain(h.dispatch('hi'))).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(mgr.acquire(req('c2', 'openai'))).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(registry.getCheapEval()!('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(generate).not.toHaveBeenCalled()
    expect(mgr.list()[0]!).toMatchObject({ providerId: 'openai' })
    expect(h.callTarget?.()).toMatchObject({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })
    await mgr.shutdown()
  })

  it('the reverse also holds: session started on DeepSeek keeps working while unsafe even if config now says OpenAI', async () => {
    const cfg: Partial<AgentConfig> = { openaiBaseUrl: 'https://api.deepseek.com/v1', openaiModel: 'deepseek-chat' }
    const net = { safe: true }
    const { gate, check } = daemonGate(cfg, net)
    const provider: AgentProvider = {
      spawn: async () => ({ ...makeFakeSession({ events: [{ kind: 'result', sessionId: 's', numTurns: 1, durationMs: 0 }] }), callTarget: () => ({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }) }),
      callTarget: () => ({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }),
    }
    const registry = createProviderRegistry({ networkGate: gate })
    registry.register('openai', provider, { displayName: 'OpenAI-compatible', canResume: () => false })
    const mgr = new SessionManager({ maxConcurrent: 4, idleEvictMs: 60_000, registry, networkGate: gate })
    const h = await mgr.acquire(req('c1', 'openai'))
    cfg.openaiBaseUrl = 'https://api.openai.com/v1'
    net.safe = false
    await drain(h.dispatch('hi'))
    expect(check).not.toHaveBeenCalled()
    await mgr.shutdown()
  })

  it('Cursor one-shot (cheapEval) uses the model the provider was built with, not the latest config', async () => {
    const cfg: Partial<AgentConfig> = { cursorModel: 'claude-4.5-sonnet' }
    const net = { safe: false }
    const { gate } = daemonGate(cfg, net)
    const evalSpawn = vi.fn(() => { throw new Error('must not spawn cursor-agent') })
    const provider = createAcpCursorChatProvider({ bin: '/nonexistent/cursor-agent', model: cfg.cursorModel!, log: () => {}, mcpSpecs: { wechat: null, delegate: null }, evalSpawn })
    const registry = createProviderRegistry({ networkGate: gate })
    registry.register('cursor' as never, provider, { displayName: 'Cursor', canResume: () => true })
    // 主人把配置改成 auto,但这个 provider 实例的一次性评估仍然用 claude-4.5-sonnet。
    cfg.cursorModel = 'auto'
    await expect(registry.getCheapEval()!('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(registry.get('cursor' as never)!.provider.strongEval!('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(evalSpawn).not.toHaveBeenCalled()
  })

  it('a provider that cannot say where it connects is treated as protected (fail closed)', async () => {
    const cfg: Partial<AgentConfig> = { openaiBaseUrl: 'https://api.deepseek.com/v1', openaiModel: 'deepseek-chat' }
    const { gate } = daemonGate(cfg, { safe: false })
    const spawn = vi.fn(async () => makeFakeSession({ events: [] }))
    const cheapEval = vi.fn(async () => 'x')
    const registry = createProviderRegistry({ networkGate: gate })
    registry.register('openai', { spawn, cheapEval } as AgentProvider, { displayName: 'OpenAI-compatible', canResume: () => false })
    await expect(registry.getCheapEval()!('x')).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(registry.get('openai')!.provider.spawn({ alias: 'a', path: '/a' }, {} as never)).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(spawn).not.toHaveBeenCalled()
    expect(cheapEval).not.toHaveBeenCalled()
  })
})
