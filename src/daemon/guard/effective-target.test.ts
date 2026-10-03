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
import { classifyConfiguredForCli, makeResolveTarget } from './targets'
import { classifyCall } from '../../lib/call-classifier'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig } from '../../lib/agent-config'
import { createProviderRegistry } from '../../core/provider-registry'
import { SessionManager } from '../../core/session-manager'
import { createOpenAiAgentProvider } from '../../core/openai-agent-provider'
import { createAcpCursorChatProvider } from '../../core/acp-cursor-chat'
import type { AgentProvider } from '../../core/agent-provider'
import { makeFakeSession } from '../../core/test-helpers'
import { TIER_PROFILES } from '../../core/user-tier'
import { runSelftestConverse } from '../selftest'

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

// 第二轮评审 #194 P1:「先建会话再查实际模型」之后,谁拿到会话直接发都必须先过守护 —— 检查放在会话
// 自己的发送方法里(registry 的代理包上),不靠调用方记得补。复现:Cursor 明确用 Claude、网络不安全,
// selftest 照样发出了请求,守护检查 0 次。
describe('every send on a session handed out by the gated registry passes the guard (review #194 P1)', () => {
  function cursorOnClaude() {
    const sent = vi.fn()
    const steered = vi.fn(async () => {})
    const submitted = vi.fn(async () => {})
    const started = vi.fn()
    const session = {
      dispatch: (text: string) => { sent(text); return makeFakeSession({ events: [{ kind: 'result', sessionId: 's', numTurns: 1, durationMs: 0 }] }).dispatch(text) },
      steer: steered,
      workbenchRuntime: {
        events: (async function* () { yield { kind: 'result' as const, sessionId: 's', numTurns: 1, durationMs: 0 } })(),
        start: started, submit: submitted,
        snapshot: () => ({ retained: false, foreground: 'idle' as const, backgroundCount: 0, input: 'send' as const }),
      },
      close: async () => {},
      // cursor-agent 起会话后自报:当前模型是 Claude。
      callTarget: () => ({ provider: 'cursor', model: 'claude-opus-5[thinking=true]' }),
    }
    // 起会话本身不发模型请求(ACP setup),所以 spawn 这一步不拦。
    const provider = { spawn: vi.fn(async () => session), callTarget: (kind: string) => (kind === 'spawn' ? { provider: 'cursor', purpose: 'setup' as const } : null) } as unknown as AgentProvider
    return { provider, sent, steered, submitted, started }
  }

  it('dispatch / steer / workbench submit on the raw session are refused while unsafe; nothing reaches the agent', async () => {
    const { gate, check } = daemonGate({}, { safe: false })
    const f = cursorOnClaude()
    const registry = createProviderRegistry({ networkGate: gate })
    registry.register('cursor' as never, f.provider, { displayName: 'Cursor', canResume: () => true })
    const s = await registry.get('cursor' as never)!.provider.spawn({ alias: 'a', path: '/tmp' }, {} as never)
    await expect(drain(s.dispatch('hi'))).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(s.steer!('more')).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(s.workbenchRuntime!.submit('r1', 'more')).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(f.sent).not.toHaveBeenCalled()
    expect(f.steered).not.toHaveBeenCalled()
    expect(f.submitted).not.toHaveBeenCalled()
    expect(check.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('workbench runtime start (sync) is held until the guard answers; refused ⇒ never started, the stream reports network_unprotected', async () => {
    const { gate } = daemonGate({}, { safe: false })
    const f = cursorOnClaude()
    const registry = createProviderRegistry({ networkGate: gate })
    registry.register('cursor' as never, f.provider, { displayName: 'Cursor', canResume: () => true })
    const s = await registry.get('cursor' as never)!.provider.spawn({ alias: 'a', path: '/tmp' }, {} as never)
    const rt = s.workbenchRuntime!
    rt.start('go')
    const events: unknown[] = []
    for await (const ev of rt.events) events.push(ev)
    expect(f.started).not.toHaveBeenCalled()
    expect(events).toEqual([expect.objectContaining({ kind: 'error', code: 'network_unprotected' })])
  })

  it('safe ⇒ the same session sends normally', async () => {
    const { gate } = daemonGate({}, { safe: true })
    const f = cursorOnClaude()
    const registry = createProviderRegistry({ networkGate: gate })
    registry.register('cursor' as never, f.provider, { displayName: 'Cursor', canResume: () => true })
    const s = await registry.get('cursor' as never)!.provider.spawn({ alias: 'a', path: '/tmp' }, {} as never)
    await drain(s.dispatch('hi'))
    expect(f.sent).toHaveBeenCalledOnce()
  })

  it('selftest chat (POST /v1/selftest/converse) on Cursor+Claude while unsafe → refused, no request, guard consulted', async () => {
    const { gate, check } = daemonGate({}, { safe: false })
    const f = cursorOnClaude()
    const registry = createProviderRegistry({ networkGate: gate })
    registry.register('cursor' as never, f.provider, { displayName: 'Cursor', canResume: () => true })
    const r = await runSelftestConverse({ registry, mintSessionToken: () => 't', invalidateSession: () => {}, log: () => {} }, { providerId: 'cursor', text: 'ping' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/网络未受保护/)
    expect(f.sent).not.toHaveBeenCalled()
    expect(check).toHaveBeenCalled()
  })
})

describe('Codex 的端点按 codex 自己的配置(2026-10-03:codex 0.153 不认 OPENAI_BASE_URL)', () => {
  const DS = 'model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com/v1"\n'
  const withHome = (fn: (home: string, root: string) => void) => () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-codex-'))
    try { const home = join(root, 'codex-home'); mkdirSync(home, { recursive: true }); fn(home, root) } finally { rmSync(root, { recursive: true, force: true }) }
  }
  const GW = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

  it('按配置推(health / 语音 / resume 的预测):OPENAI_BASE_URL 指国内但 config 默认 ⇒ 需要保护', withHome((home) => {
    const resolve = makeResolveTarget(() => ({}) as AgentConfig, { CODEX_HOME: home, OPENAI_BASE_URL: GW }, { systemDir: null })
    expect(classifyCall(resolve({ provider: 'codex', purpose: 'turn' }))).toMatchObject({ protected: true, kind: 'official', host: 'api.openai.com' })
    writeFileSync(join(home, 'config.toml'), DS)
    expect(classifyCall(resolve({ provider: 'codex', purpose: 'turn' }))).toMatchObject({ protected: false, kind: 'domestic' })
    writeFileSync(join(home, 'config.toml'), 'model_provider = [broken\n')
    expect(classifyCall(resolve({ provider: 'codex', purpose: 'turn' }))).toMatchObject({ protected: true, kind: 'unresolved' })
  }))

  it('执行者自己报的目标(exact)不被配置覆盖;Codex 额度查询永远是 OpenAI 官方', withHome((home) => {
    writeFileSync(join(home, 'config.toml'), DS)
    const resolve = makeResolveTarget(() => ({}) as AgentConfig, { CODEX_HOME: home }, { systemDir: null })
    expect(resolve({ provider: 'codex', baseUrl: null, exact: true })).toEqual({ provider: 'codex', baseUrl: null, exact: true })
    expect(classifyCall(resolve({ provider: 'codex', baseUrl: 'https://chatgpt.com', purpose: 'usage', exact: true }))).toMatchObject({ protected: true, kind: 'official' })
  }))

  it('daemon 闸门:config 默认 + OPENAI_BASE_URL 指国内 + 信号不安全 ⇒ codex 被拒', withHome((home) => {
    const { gate } = daemonGate({}, { safe: false }, { CODEX_HOME: home, HOME: home, OPENAI_BASE_URL: GW })
    expect(gate.classify({ provider: 'codex', purpose: 'turn' })).toMatchObject({ protected: true })
  }))

  it('wechat-cc guard status 按 CODEX_HOME 里的 config 判 codex', withHome((home, root) => {
    const prior = { h: process.env.CODEX_HOME, b: process.env.OPENAI_BASE_URL }
    process.env.CODEX_HOME = home; process.env.OPENAI_BASE_URL = GW
    try {
      const stateDir = join(root, 'state'); mkdirSync(stateDir, { recursive: true })
      const row = () => classifyConfiguredForCli(stateDir, { onPath: () => null }).find(p => p.id === 'codex')!
      expect(row()).toMatchObject({ protected: true, kind: 'official', host: 'api.openai.com' })
      writeFileSync(join(home, 'config.toml'), DS)
      expect(row()).toMatchObject({ protected: false, kind: 'domestic', host: 'api.deepseek.com' })
    } finally {
      if (prior.h === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior.h
      if (prior.b === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = prior.b
    }
  }))
})
