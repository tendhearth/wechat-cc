/**
 * codex 边界产码 + 边界超时(arch backlog #4 第 2 步)。
 *
 * 真实形状来自 #188 的样本(`diagnostics/__fixtures__/provider-errors/codex.json`)与
 * 2026-10-02 的沙箱重跑(codex-cli 0.153.4,临时 CODEX_HOME + 自定义 model_provider
 * 指向 127.0.0.1;拒连时 codex 每 4s→43s 发一条
 * `Reconnecting... waiting for network (Connection failed: error sending request)`,永不结束)。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Codex, Thread, ThreadEvent } from '@openai/codex-sdk'
import { codexAppServerErrorCode, codexErrorCode, watchCodexEvents } from './codex-errors'
import { createCodexAgentProvider } from './codex-agent-provider'
import type { AgentEvent } from './agent-provider'
import { TIER_PROFILES } from './user-tier'
import { providerErrorCodeOf } from '../lib/provider-error-code'

const samples = JSON.parse(readFileSync(join(__dirname, '../daemon/diagnostics/__fixtures__/provider-errors/codex.json'), 'utf8')) as Array<{ id: string; message: string; errorCode: string | null }>
const byId = (id: string) => samples.find(s => s.id === id)!

describe('codexErrorCode — 每条真实样本在边界上的码(与 fixture 的 errorCode 一致)', () => {
  it.each(samples.map(s => [s.id, s] as const))('%s', (_id, s) => {
    expect(codexErrorCode(s.message) ?? null).toBe(s.errorCode)
  })

  it('websocket 401(exit 1 的 stderr)判认证被拒,不再因为 `failed to connect` 判成网络', () => {
    expect(codexErrorCode(byId('codex.bad_key.session_exit').message)).toBe('auth_rejected')
  })

  it('没有凭证(Missing bearer)= 登录失效;假 key = 凭证被拒(不说登录过期)', () => {
    expect(codexErrorCode(byId('codex.not_logged_in.cheap_eval').message)).toBe('auth_failed')
    expect(codexErrorCode(byId('codex.bad_key.cheap_eval').message)).toBe('auth_rejected')
  })

  it('拒连的重连通知 = 网络', () => {
    expect(codexErrorCode('Reconnecting... waiting for network (Connection failed: error sending request)')).toBe('network')
  })
})

describe('codexAppServerErrorCode — 工作台 app-server 的结构化 codexErrorInfo 优先', () => {
  it('字符串变体', () => {
    expect(codexAppServerErrorCode({ message: 'x', codexErrorInfo: 'unauthorized' })).toBe('auth_rejected')
    expect(codexAppServerErrorCode({ message: 'x', codexErrorInfo: 'usageLimitExceeded' })).toBe('quota')
    expect(codexAppServerErrorCode({ message: 'x', codexErrorInfo: 'rateLimitExceeded' })).toBe('rate_limited')
    expect(codexAppServerErrorCode({ message: 'x', codexErrorInfo: 'serverOverloaded' })).toBe('server_error')
    expect(codexAppServerErrorCode({ message: 'x', codexErrorInfo: 'contextWindowExceeded' })).toBe('invalid_request')
  })
  it('带 httpStatusCode 的变体:null = 没拿到响应 = 网络;有 status 按 status', () => {
    expect(codexAppServerErrorCode({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } } })).toBe('network')
    expect(codexAppServerErrorCode({ message: 'x', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } })).toBe('network')
    expect(codexAppServerErrorCode({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } })).toBe('auth_rejected')
    expect(codexAppServerErrorCode({ message: 'x', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } } })).toBe('server_error')
  })
  it('other / 缺省 ⇒ 退到文本(额度原文仍认得)', () => {
    expect(codexAppServerErrorCode({ message: byId('codex.quota.workbench').message, codexErrorInfo: 'other' })).toBe('quota')
    expect(codexAppServerErrorCode({ message: 'something odd', codexErrorInfo: null })).toBeUndefined()
  })
})

// ── 边界超时 ────────────────────────────────────────────────────────────────

const RECONNECT = { type: 'error', message: 'Reconnecting... waiting for network (Connection failed: error sending request)' } as unknown as ThreadEvent

async function* stream(events: ThreadEvent[], tail: 'hang' | 'end' | Error = 'end'): AsyncGenerator<ThreadEvent> {
  for (const ev of events) yield ev
  if (tail === 'hang') await new Promise<never>(() => {})
  if (tail instanceof Error) throw tail
}

describe('watchCodexEvents', () => {
  it('拿掉非终止的重连通知(只记日志);连不上超过 connect 上限 ⇒ abort + 带 network 码抛出', async () => {
    let aborted = false
    const notices: string[] = []
    const seen: string[] = []
    const err = await (async () => {
      for await (const ev of watchCodexEvents(stream([{ type: 'thread.started', thread_id: 't' } as ThreadEvent, RECONNECT, RECONNECT], 'hang'), {
        timeouts: { firstEventTimeoutMs: 10_000, connectTimeoutMs: 30 }, abort: () => { aborted = true }, onNotice: m => notices.push(m),
      })) seen.push(ev.type)
    })().catch(e => e)
    expect(seen).toEqual(['thread.started'])
    expect(notices).toHaveLength(2)
    expect(aborted).toBe(true)
    expect(providerErrorCodeOf(err)).toBe('network')
    expect((err as Error).message).toMatch(/连不上/)
  })

  it('一个有进展的事件都没有 ⇒ first-event 上限收尾(network)', async () => {
    const err = await (async () => {
      for await (const _ of watchCodexEvents(stream([{ type: 'thread.started', thread_id: 't' } as ThreadEvent, { type: 'turn.started' } as ThreadEvent], 'hang'), {
        timeouts: { firstEventTimeoutMs: 30, connectTimeoutMs: 10_000 }, abort: () => {},
      })) { /* drain */ }
    })().catch(e => e)
    expect(providerErrorCodeOf(err)).toBe('network')
  })

  it('有进展之后不再受 first-event 上限约束;正常结束原样透传', async () => {
    const out: string[] = []
    for await (const ev of watchCodexEvents(stream([
      { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'hi' } } as ThreadEvent,
      { type: 'turn.completed', usage: null } as unknown as ThreadEvent,
    ]), { timeouts: { firstEventTimeoutMs: 1, connectTimeoutMs: 1 }, abort: () => {} })) out.push(ev.type)
    expect(out).toEqual(['item.completed', 'turn.completed'])
  })

  it('重连期间的码取最后一条通知(401 重连 ⇒ 认证,不是网络)', async () => {
    const err = await (async () => {
      for await (const _ of watchCodexEvents(stream([{ type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Incorrect API key provided: x, auth error code: invalid_api_key)' } as unknown as ThreadEvent], 'hang'), {
        timeouts: { firstEventTimeoutMs: 10_000, connectTimeoutMs: 20 }, abort: () => {},
      })) { /* drain */ }
    })().catch(e => e)
    expect(providerErrorCodeOf(err)).toBe('auth_rejected')
  })
})

// ── 真的 codex provider(假 SDK) ──────────────────────────────────────────

function fakeCodex(turn: () => AsyncGenerator<ThreadEvent>): Codex {
  const thread = {
    id: 't1',
    async runStreamed() { return { events: turn() } },
    async run() { throw new Error('cheapEval must stream') },
  } as unknown as Thread
  return { startThread: () => thread, resumeThread: () => thread } as unknown as Codex
}
const spawnCtx = { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict' as const, chatId: 'c' }
async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> { const out: AgentEvent[] = []; for await (const ev of events) out.push(ev); return out }

describe('codex provider —— 会话路径', () => {
  it('拒连(沙箱实测形状):不再无限沉默 —— 重连通知不下发,connect 上限后以 network 码的 error 事件收尾', async () => {
    const p = createCodexAgentProvider({ codexFactory: () => fakeCodex(() => stream([{ type: 'thread.started', thread_id: 't1' } as ThreadEvent, { type: 'turn.started' } as ThreadEvent, RECONNECT, RECONNECT], 'hang')), timeouts: { firstEventTimeoutMs: 10_000, connectTimeoutMs: 30 } })
    const session = await p.spawn({ alias: 'a', path: '/p' }, spawnCtx)
    const events = await drain(session.dispatch('hi'))
    const errors = events.filter(e => e.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ kind: 'error', code: 'network' })
    expect(events.some(e => e.kind === 'error' && /^Reconnecting/.test(e.message))).toBe(false)
  })

  it('exit 1 带 websocket 401 的 stderr(之前:原样抛出,coordinator 拿不到 summary)⇒ auth_rejected 的 error 事件', async () => {
    const exit = new Error(byId('codex.bad_key.session_exit').message)
    const p = createCodexAgentProvider({ codexFactory: () => fakeCodex(() => stream([{ type: 'thread.started', thread_id: 't1' } as ThreadEvent], exit)) })
    const session = await p.spawn({ alias: 'a', path: '/p' }, spawnCtx)
    const events = await drain(session.dispatch('hi'))
    expect(events.filter(e => e.kind === 'error')).toEqual([expect.objectContaining({ code: 'auth_rejected' })])
  })

  it('已经发过终态 turn.failed 之后的 exit 1 不再重复', async () => {
    const failed = { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Incorrect API key provided: x, auth error code: invalid_api_key' } } as unknown as ThreadEvent
    const p = createCodexAgentProvider({ codexFactory: () => fakeCodex(() => stream([failed], new Error('Codex Exec exited with code 1: Reading prompt from stdin...\n'))) })
    const session = await p.spawn({ alias: 'a', path: '/p' }, spawnCtx)
    const events = await drain(session.dispatch('hi'))
    expect(events.filter(e => e.kind === 'error')).toEqual([expect.objectContaining({ code: 'auth_rejected' })])
  })

  it('额度耗尽 ⇒ quota', async () => {
    const p = createCodexAgentProvider({ codexFactory: () => fakeCodex(() => stream([{ type: 'turn.failed', error: { message: byId('codex.quota.session').message } } as unknown as ThreadEvent])) })
    const session = await p.spawn({ alias: 'a', path: '/p' }, spawnCtx)
    const events = await drain(session.dispatch('hi'))
    expect(events.filter(e => e.kind === 'error')).toEqual([expect.objectContaining({ code: 'quota' })])
  })
})

describe('codex provider —— 一次性评估', () => {
  it('拒连:不再一直挂着 —— 带 network 码抛出', async () => {
    const p = createCodexAgentProvider({ codexFactory: () => fakeCodex(() => stream([RECONNECT], 'hang')), timeouts: { firstEventTimeoutMs: 10_000, connectTimeoutMs: 30 } })
    const err = await p.cheapEval!('x').catch(e => e)
    expect(providerErrorCodeOf(err)).toBe('network')
  })

  it('401 终态 ⇒ 带码抛出(auth_rejected),原文保留', async () => {
    const message = byId('codex.bad_key.cheap_eval').message
    const p = createCodexAgentProvider({ codexFactory: () => fakeCodex(() => stream([{ type: 'turn.failed', error: { message } } as unknown as ThreadEvent])) })
    const err = await p.cheapEval!('x').catch(e => e)
    expect(providerErrorCodeOf(err)).toBe('auth_rejected')
    expect((err as Error).message).toBe(message)
  })
})
