/**
 * openai 兼容边界产码 + 请求超时(arch backlog #4 第 2 步;provider-error-shapes §4.4 §4.5)。
 * 走**真的** AI SDK(createAiSdkChatModel),只把 fetch 换成假的 —— 401 / 429 / 524 /
 * 拒连 / 黑洞 / 流停住都是对端的真实形状,不碰网络。
 */
import { describe, expect, it } from 'vitest'
import { APICallError, RetryError } from 'ai'
import { createAiSdkChatModel } from './openai-chat-model'
import { createOpenAiAgentProvider } from './openai-agent-provider'
import { openaiErrorCode, openaiErrorMessage } from './openai-error-code'
import type { AgentEvent } from './agent-provider'
import type { McpToolBridge } from './openai-mcp-bridge'
import { TIER_PROFILES } from './user-tier'
import { providerErrorCodeOf } from '../lib/provider-error-code'
import type { FetchLike } from '../lib/timeout-fetch'

const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const bridge: McpToolBridge = { tools: [], serverOf: () => undefined, call: async () => '', close: async () => {} } as unknown as McpToolBridge
const TIMEOUTS = { connectTimeoutMs: 60, idleTimeoutMs: 60 }

function provider(fetch: FetchLike, timeouts = TIMEOUTS) {
  return createOpenAiAgentProvider({
    makeChatModel: () => createAiSdkChatModel({ baseURL: 'http://gateway.test/v1', apiKey: 'SANDBOXBOGUS', model: 'm', fetch, timeouts }),
    makeMcpBridge: async () => bridge,
  })
}
async function sessionErrors(fetch: FetchLike, timeouts = TIMEOUTS): Promise<AgentEvent[]> {
  const s = await provider(fetch, timeouts).spawn({ alias: 'a', path: '/tmp' }, { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'c' })
  const events: AgentEvent[] = []
  for await (const ev of s.dispatch('hi')) events.push(ev)
  await s.close()
  return events.filter(e => e.kind === 'error')
}

describe('openai 兼容 —— 会话与一次性评估都按对端的真实结构产码', () => {
  it('401(DeepSeek / Kimi 假 key)⇒ auth_rejected(不是 auth_failed:不说登录过期)', async () => {
    const f = json(401, { error: { message: 'Invalid Authentication', type: 'invalid_authentication_error' } })
    expect(await sessionErrors(f)).toEqual([expect.objectContaining({ code: 'auth_rejected' })])
    expect(providerErrorCodeOf(await provider(f).cheapEval!('x').catch(e => e))).toBe('auth_rejected')
  })

  it('403 ⇒ auth_rejected', async () => {
    expect(await sessionErrors(json(403, { error: { message: 'forbidden' } }))).toEqual([expect.objectContaining({ code: 'auth_rejected' })])
  })

  it('Gemini 风格:400 但正文说 key 无效 ⇒ auth_rejected;普通 400 ⇒ invalid_request', async () => {
    const gemini = json(400, [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }])
    expect(providerErrorCodeOf(await provider(gemini).cheapEval!('x').catch(e => e))).toBe('auth_rejected')
    expect(providerErrorCodeOf(await provider(json(400, { error: { message: 'context too long' } })).cheapEval!('x').catch(e => e))).toBe('invalid_request')
  })

  it('拒连(Bun 的 ConnectionRefused)⇒ network', async () => {
    const refused: FetchLike = async () => { throw Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' }) }
    expect(await sessionErrors(refused)).toEqual([expect.objectContaining({ code: 'network' })])
    expect(providerErrorCodeOf(await provider(refused).cheapEval!('x').catch(e => e))).toBe('network')
  })

  it('黑洞(之前:一直挂到 600s 回合看门狗)⇒ connect 上限后 network', async () => {
    const blackhole: FetchLike = (_input, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)) })
    const started = Date.now()
    expect(await sessionErrors(blackhole)).toEqual([expect.objectContaining({ code: 'network' })])
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(providerErrorCodeOf(await provider(blackhole).cheapEval!('x').catch(e => e))).toBe('network')
  })

  it('响应头来了但流停住 ⇒ idle 上限后 network', async () => {
    const stall: FetchLike = async () => {
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"半"},"finish_reason":null}]}\n\n')) } })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const errors = await sessionErrors(stall)
    expect(errors).toEqual([expect.objectContaining({ code: 'network' })])
  })
})

describe('openaiErrorCode / openaiErrorMessage — RetryError 里的真实 status(§4.5)', () => {
  const attempt = (status: number) => new APICallError({ message: 'Gateway Timeout', url: 'u', requestBodyValues: {}, statusCode: status, responseBody: '<html>524: A timeout occurred</html>', isRetryable: true })
  it('网关 524 重试三次:码 server_error,消息带回 HTTP 524 而不是 `Last error: <none>`', () => {
    const err = new RetryError({ message: 'Failed after 3 attempts. Last error: <none>', reason: 'maxRetriesExceeded', errors: [attempt(524), attempt(524), attempt(524)] })
    expect(openaiErrorCode(err)).toBe('server_error')
    expect(openaiErrorMessage(err)).toMatch(/^HTTP 524 \(after 3 attempts\): /)
  })
  it('429(AI SDK 会重试,所以落在 RetryError.errors[] 里)⇒ rate_limited', () => {
    const err = new RetryError({ message: 'Failed after 3 attempts. Last error: Too Many Requests', reason: 'maxRetriesExceeded', errors: [429, 429, 429].map(s => new APICallError({ message: 'Too Many Requests', url: 'u', requestBodyValues: {}, statusCode: s, isRetryable: true })) })
    expect(openaiErrorCode(err)).toBe('rate_limited')
  })
  it('Bun 的 `socket connection was closed` ⇒ network;认不出 ⇒ undefined', () => {
    expect(openaiErrorCode(new Error("The socket connection was closed unexpectedly. For more information, pass 'verbose: true' in the second argument to fetch()"))).toBe('network')
    expect(openaiErrorCode(new Error('step budget 25 exhausted'))).toBeUndefined()
  })
})
