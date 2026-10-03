/**
 * Claude 会话路径:SDK 标了「这是一次 API 失败」的助理消息,**永远不当回复发出去**
 * (arch backlog #4 第 2 步第一片,owner 2026-10-02)。
 *
 * 真机 2026-07-28:`[FALLBACK_REPLY] provider=claude chunks=1 preview="Failed to
 * authenticate. API Error: 403 Request not allowed"` —— 一条 text 事件 + 正常的
 * result,回合记成 completed,原文被当回复发到主人微信。
 *
 * SDK 消息按 #188 的真实样本(`__fixtures__/provider-errors/claude.json` 里
 * 带 `sdkStructure` 的会话样本)重放:助理消息带 `error` 标注、正文是 API
 * 错误原文;结果消息 `subtype: 'success'` 但 `is_error: true` + `api_error_status`。
 * 这里走真的 claude provider + 真的 coordinator,只把 SDK 的 `query()` 换成重放。
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeApiErrorCode, createClaudeAgentProvider } from './claude-agent-provider'
import { createConversationCoordinator, type TurnRecord } from './conversation-coordinator'
import { createProviderRegistry } from './provider-registry'
import type { AgentEvent, AgentProvider, AgentSession } from './agent-provider'
import type { Mode } from './conversation'
import type { InboundMsg } from './prompt-format'
import { TIER_PROFILES } from './user-tier'

const h = vi.hoisted(() => ({ script: [] as unknown[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  // Replays `h.script` once the turn's user message has been pushed, then ends
  // (the provider's consumer loop drains and settles).
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const script = h.script
    async function* gen() {
      const it = prompt[Symbol.asyncIterator]()
      await it.next()
      for (const m of script) yield m
    }
    return Object.assign(gen(), { interrupt() {}, close() {} })
  },
}))

interface Sample {
  id: string
  provider: string
  path: string
  errorCode: string | null
  message: string
  sdkStructure?: Record<string, unknown>
}

const FIXTURE = join(__dirname, '..', 'daemon', 'diagnostics', '__fixtures__', 'provider-errors', 'claude.json')
const samples = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Sample[])
const replayable = samples.filter(s => s.path === 'session' && s.sdkStructure)
const sample = (id: string): Sample => {
  const s = samples.find(x => x.id === id)
  if (!s) throw new Error(`fixture missing: ${id}`)
  return s
}

/** The raw SDK messages the claude binary produced for this sample. */
function sdkScript(s: Sample): unknown[] {
  const st = s.sdkStructure!
  const text = (st['assistant.text'] as string | undefined) ?? s.message
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      error: st['assistant.error'],
      message: { model: '<synthetic>', content: [{ type: 'text', text }] },
    },
    {
      type: 'result', subtype: 'success', session_id: 'sess-1', num_turns: 1, duration_ms: 5,
      is_error: true, api_error_status: st['result.api_error_status'] ?? null, result: text,
    },
  ]
}

async function runProviderTurn(script: unknown[]): Promise<AgentEvent[]> {
  h.script = script
  const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
  const session = await provider.spawn({ alias: 'a', path: '/tmp' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'chat-1' })
  const out: AgentEvent[] = []
  for await (const ev of session.dispatch('你好')) out.push(ev)
  await session.close()
  return out
}

describe('claudeApiErrorCode — SDK 的结构化标注 → 码', () => {
  it('按 SDK 标注与 HTTP status 分类,不看正文', () => {
    expect(claudeApiErrorCode('authentication_failed', 401)).toBe('auth_rejected')
    expect(claudeApiErrorCode('authentication_failed', 403)).toBe('auth_rejected')
    expect(claudeApiErrorCode('server_error', null)).toBe('network')       // 拒连 / 超时 / TLS:没拿到 HTTP 响应
    expect(claudeApiErrorCode('server_error', undefined)).toBe('network')
    expect(claudeApiErrorCode('server_error', 529)).toBe('server_error')
    expect(claudeApiErrorCode('rate_limit', 429)).toBe('rate_limited')
    expect(claudeApiErrorCode('billing_error', 400)).toBe('quota')
    expect(claudeApiErrorCode('invalid_request', 400)).toBe('invalid_request')
    expect(claudeApiErrorCode('unknown', null)).toBe('provider_error')
    expect(claudeApiErrorCode('some_future_label', null)).toBe('provider_error')
  })

  it('max_output_tokens 与无标注都不是失败', () => {
    expect(claudeApiErrorCode('max_output_tokens', null)).toBeNull()
    expect(claudeApiErrorCode(undefined, null)).toBeNull()
  })
})

describe('claude provider — #188 会话样本重放', () => {
  it('语料里有可重放的会话样本(含 07-28 的 403、哨兵、401、拒连、超时)', () => {
    expect(replayable.map(s => s.id).sort()).toEqual([
      'claude.bad_key.session',
      'claude.forbidden_403.session',
      'claude.net_refused.session',
      'claude.not_logged_in.session',
      'claude.timeout.session',
    ])
  })

  it.each(replayable.map(s => [s.id, s] as const))('%s ⇒ 一个带码的 error 事件,没有 text 事件', async (_id, s) => {
    const events = await runProviderTurn(sdkScript(s))
    expect(events.filter(e => e.kind === 'text')).toEqual([])
    expect(events.filter(e => e.kind === 'error')).toEqual([{ kind: 'error', code: s.errorCode, message: s.message }])
    expect(events[events.length - 1]?.kind).toBe('result')
  })

  it('非哨兵认证失败 ⇒ auth_rejected,不是 auth_failed(红线 A)', async () => {
    for (const id of ['claude.bad_key.session', 'claude.forbidden_403.session']) {
      const events = await runProviderTurn(sdkScript(sample(id)))
      expect(events.find(e => e.kind === 'error'), id).toMatchObject({ code: 'auth_rejected' })
    }
  })

  it('网络 / 超时 ⇒ network,不是任何认证码', async () => {
    for (const id of ['claude.net_refused.session', 'claude.timeout.session']) {
      const events = await runProviderTurn(sdkScript(sample(id)))
      expect(events.find(e => e.kind === 'error'), id).toMatchObject({ code: 'network' })
    }
  })

  it('max_output_tokens 标注的正文照常作为回复文本', async () => {
    const events = await runProviderTurn([
      { type: 'assistant', error: 'max_output_tokens', message: { content: [{ type: 'text', text: '很长的回答……' }] } },
      { type: 'result', subtype: 'success', session_id: 's', num_turns: 1, duration_ms: 1 },
    ])
    expect(events.filter(e => e.kind === 'text')).toEqual([{ kind: 'text', text: '很长的回答……' }])
    expect(events.some(e => e.kind === 'error')).toBe(false)
  })

  it('没有 SDK 标注的正文 —— 哪怕在复述 401 —— 仍是普通回复(不扫正文)', async () => {
    const quoted = '你这个 curl 返回 Failed to authenticate. API Error: 401,说明 token 过期了'
    const events = await runProviderTurn([
      { type: 'assistant', message: { content: [{ type: 'text', text: quoted }] } },
      { type: 'result', subtype: 'success', session_id: 's', num_turns: 1, duration_ms: 1 },
    ])
    expect(events.filter(e => e.kind === 'text')).toEqual([{ kind: 'text', text: quoted }])
    expect(events.some(e => e.kind === 'error')).toBe(false)
  })

  it('5xx 带 HTTP status ⇒ server_error', async () => {
    const events = await runProviderTurn([
      { type: 'assistant', error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } },
      { type: 'result', subtype: 'success', session_id: 's', num_turns: 1, duration_ms: 1, is_error: true, api_error_status: 529 },
    ])
    expect(events.filter(e => e.kind === 'error')).toEqual([{ kind: 'error', code: 'server_error', message: 'API Error: 529 Overloaded' }])
  })
})

// ── 真 provider → 真 coordinator:主人微信上收到什么 ─────────────────────────

function inbound(text: string): InboundMsg {
  return { chatId: 'chat-1', userId: 'chat-1', text, msgType: 'text', createTimeMs: Date.now(), accountId: 'acct-1' }
}

async function runCoordinatorTurn(s: Sample) {
  h.script = sdkScript(s)
  const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
  let session: AgentSession | undefined
  const sent: string[] = []
  const records: TurnRecord[] = []
  const release = vi.fn(async () => {})
  const registry = createProviderRegistry()
  const dummy: AgentProvider = { spawn: async () => { throw new Error('unused') } }
  registry.register('claude', dummy, { displayName: 'Claude', canResume: () => true })
  const store = new Map<string, { mode: Mode }>()
  const c = createConversationCoordinator({
    resolveProject: () => ({ alias: 'a', path: '/p' }),
    manager: {
      acquire: async () => {
        session = await provider.spawn({ alias: 'a', path: '/p' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'chat-1' })
        const live = session
        return { alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0, dispatch: (t: string) => live.dispatch(t), cancel: async () => {}, close: async () => {} }
      },
      release,
    },
    conversationStore: { get: (id: string) => store.get(id) ?? null, set: (id: string, mode: Mode) => { store.set(id, { mode }) }, setParticipants: () => {} },
    registry,
    defaultProviderId: 'claude',
    format: (m: InboundMsg) => m.text,
    sendAssistantText: async (_chat: string, text: string) => { sent.push(text) },
    recordTurn: (r: TurnRecord) => { records.push(r) },
    permissionMode: 'strict',
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], admins: ['chat-1'] }),
    log: () => {},
  })
  await c.dispatch(inbound('你好'))
  await session?.close()
  return { sent, records, release }
}

describe('claude 会话 → coordinator:API 错误不当回复发出去', () => {
  it('2026-07-28 的 403:不外发原文;回合 auth_failed + 码 auth_rejected;提示不说登录过期', async () => {
    const { sent, records, release } = await runCoordinatorTurn(sample('claude.forbidden_403.session'))
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toContain('Failed to authenticate')
    expect(sent[0]).not.toContain('Request not allowed')
    expect(sent[0]).not.toMatch(/登录|过期|login/)
    expect(sent[0]).toContain('认证没通过(API 返回 401/403)')
    expect(sent[0]).toContain('检查一下账号或密钥')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'auth_failed', errorCode: 'auth_rejected', textChunks: 0 })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('401 假 key:同上,不说登录过期', async () => {
    const { sent, records } = await runCoordinatorTurn(sample('claude.bad_key.session'))
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toContain('API key is invalid')
    expect(sent[0]).not.toMatch(/登录|过期/)
    expect(records[0]).toMatchObject({ outcome: 'auth_failed', errorCode: 'auth_rejected' })
  })

  it('双哨兵:仍是唯一说「登录已过期」的情形', async () => {
    const { sent, records } = await runCoordinatorTurn(sample('claude.not_logged_in.session'))
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toContain('Please run /login')
    expect(sent[0]).toMatch(/Claude 登录已过期/)
    expect(sent[0]).toContain('claude login')
    expect(records[0]).toMatchObject({ outcome: 'auth_failed', errorCode: 'auth_failed' })
  })

  // 第 2 步余下部分:错误提示按码说老实的原因(network ⇒「连不上 … 网络问题」),不再是笼统的「脑子卡了一下」。
  it.each(['claude.net_refused.session', 'claude.timeout.session'])('%s:回合 error + 码 network,提示说网络问题,不提认证', async (id) => {
    const s = sample(id)
    const { sent, records, release } = await runCoordinatorTurn(s)
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toContain(s.message)
    expect(sent[0]).not.toMatch(/登录|认证|过期/)
    expect(sent[0]).toMatch(/连不上 claude 的服务.*网络问题/)
    expect(records[0]).toMatchObject({ outcome: 'error', errorCode: 'network', error: s.message })
    expect(release).not.toHaveBeenCalled()
  })
})
