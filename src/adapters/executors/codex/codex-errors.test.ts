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
import { codexAppServerErrorCode, codexErrorCode } from './codex-errors'
import { createCodexChatProvider } from './codex-chat-provider'
import { createScriptedCodex, type CodexScriptedTurn, type ScriptedRpc } from '../../../test-support/executors/codex-scripted'
import type { AgentEvent } from '../../../ports/agent-provider'
import { TIER_PROFILES } from '../../../domain/user-tier'
import { providerErrorCodeOf } from '../../../lib/provider-error-code'

const samples = JSON.parse(readFileSync(join(__dirname, '../../../daemon/diagnostics/__fixtures__/provider-errors/codex.json'), 'utf8')) as Array<{ id: string; message: string; errorCode: string | null }>
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

// ── 边界超时 + 码:真的 codex 对话 provider(剧本 app-server,B1 起) ─────────────────────

const RECONNECT = 'Reconnecting... waiting for network (Connection failed: error sending request)'
const spawnCtx = { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict' as const, chatId: 'c' }
async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> { const out: AgentEvent[] = []; for await (const ev of events) out.push(ev); return out }
function provider(turns: CodexScriptedTurn[], timeouts = { firstEventTimeoutMs: 10_000, connectTimeoutMs: 30 }, rewrite?: (m: ScriptedRpc) => ScriptedRpc | ScriptedRpc[] | null) {
  const scripted = createScriptedCodex({ turns, ...(rewrite ? { rewrite } : {}) })
  return createCodexChatProvider({ codexPathOverride: '/bin/codex', spawnProcess: scripted.spawn, timeouts, rpcTimeoutMs: 2_000, closeTimeoutMs: 300 })
}

describe('codex provider —— 会话路径', () => {
  it('拒连(沙箱实测形状):不再无限沉默 —— 重连通知不下发,connect 上限后以 network 码的 error 事件收尾', async () => {
    const session = await provider([{ steps: [{ reconnect: RECONNECT }, { reconnect: RECONNECT }], hang: true }]).spawn({ alias: 'a', path: '/p' }, spawnCtx)
    const events = await drain(session.dispatch('hi'))
    const errors = events.filter(e => e.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ kind: 'error', code: 'network' })
    expect(events.some(e => e.kind === 'error' && /^Reconnecting/.test(e.message))).toBe(false)
    await session.close()
  })

  it('重连期间的码取最后一条通知(401 重连 ⇒ 认证,不是网络)', async () => {
    const session = await provider([{ steps: [{ reconnect: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Incorrect API key provided: x, auth error code: invalid_api_key)' }], hang: true }], { firstEventTimeoutMs: 10_000, connectTimeoutMs: 20 }).spawn({ alias: 'a', path: '/p' }, spawnCtx)
    const events = await drain(session.dispatch('hi'))
    expect(events.filter(e => e.kind === 'error')).toEqual([expect.objectContaining({ code: 'auth_rejected' })])
    await session.close()
  })

  it('app-server 退出、stderr 带 websocket 401 ⇒ auth_rejected 的 error 事件(不抛,协调器拿得到 summary)', async () => {
    const session = await provider([{ steps: [{ crash: byId('codex.bad_key.session_exit').message }] }]).spawn({ alias: 'a', path: '/p' }, spawnCtx)
    const events = await drain(session.dispatch('hi'))
    expect(events.filter(e => e.kind === 'error')).toEqual([expect.objectContaining({ code: 'auth_rejected' })])
    await session.close()
  })

  it('终态失败只发一次 error(error 通知 + turn/completed{failed} 不重复)', async () => {
    const session = await provider([{ steps: [], fail: 'unexpected status 401 Unauthorized: Incorrect API key provided: x, auth error code: invalid_api_key' }]).spawn({ alias: 'a', path: '/p' }, spawnCtx)
    const events = await drain(session.dispatch('hi'))
    expect(events.filter(e => e.kind === 'error')).toEqual([expect.objectContaining({ code: 'auth_rejected' })])
    await session.close()
  })

  it('额度耗尽 ⇒ quota', async () => {
    const session = await provider([{ steps: [], fail: byId('codex.quota.session').message }]).spawn({ alias: 'a', path: '/p' }, spawnCtx)
    const events = await drain(session.dispatch('hi'))
    expect(events.filter(e => e.kind === 'error')).toEqual([expect.objectContaining({ code: 'quota' })])
    await session.close()
  })
})

describe('codex provider —— 一次性评估', () => {
  it('拒连:不再一直挂着 —— 带 network 码抛出', async () => {
    // 一次性评估的线程不走剧本(总是回答)—— 这里让 app-server 把 turn/start 之后的通知换成一直重连。
    const err = await provider([], { firstEventTimeoutMs: 10_000, connectTimeoutMs: 30 }, m => {
      if (m.method === 'turn/started') return [m, { method: 'error', params: { threadId: m.params.threadId, turnId: m.params.turn.id, willRetry: true, error: { message: RECONNECT } } }]
      if (m.method === 'item/completed' || m.method === 'turn/completed') return null
      return m
    }).cheapEval!('x').catch(e => e)
    expect(providerErrorCodeOf(err)).toBe('network')
  })

  it('401 终态 ⇒ 带码抛出(auth_rejected),原文保留', async () => {
    const message = byId('codex.bad_key.cheap_eval').message
    const err = await provider([], undefined, m => {
      if (m.method === 'item/completed') return null
      if (m.method === 'turn/completed') return { method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: m.params.turn.id, status: 'failed', error: { message, codexErrorInfo: null } } } }
      return m
    }).cheapEval!('x').catch(e => e)
    expect(providerErrorCodeOf(err)).toBe('auth_rejected')
    expect((err as Error).message).toBe(message)
  })
})
