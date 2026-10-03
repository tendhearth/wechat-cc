import { describe, expect, it } from 'vitest'
import { makeTimeoutFetch, type FetchLike } from './timeout-fetch'
import { providerErrorCodeOf } from './provider-error-code'

const hang: FetchLike = (_i, init) => new Promise((_r, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted'))) })

describe('makeTimeoutFetch', () => {
  it('拿不到响应头 ⇒ connect 上限后抛带 network 码的错误', async () => {
    const err = await makeTimeoutFetch({ connectTimeoutMs: 20, idleTimeoutMs: 1_000 }, hang)('http://x/v1/chat').catch(e => e)
    expect(providerErrorCodeOf(err)).toBe('network')
    expect(['AbortError', 'TimeoutError', 'ResponseAborted']).not.toContain((err as Error).name) // AI SDK 会把 AbortError/TimeoutError 当用户中止
  })

  it('调用方自己中止(/stop)不是超时:不挂码', async () => {
    const ac = new AbortController()
    const p = makeTimeoutFetch({ connectTimeoutMs: 5_000, idleTimeoutMs: 5_000 }, hang)('http://x', { signal: ac.signal }).catch(e => e)
    ac.abort(new Error('user stop'))
    expect(providerErrorCodeOf(await p)).toBeUndefined()
  })

  it('流一直在动就不掐;停住超过 idle ⇒ 流报带码的错误', async () => {
    const enc = new TextEncoder()
    let pushes = 0
    const flowing: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({
      async pull(c) { await new Promise(r => setTimeout(r, 10)); if (++pushes > 5) { c.close(); return } c.enqueue(enc.encode('x')) },
    }))
    const ok = await makeTimeoutFetch({ connectTimeoutMs: 1_000, idleTimeoutMs: 30 }, flowing)('http://x')
    expect(await ok.text()).toBe('xxxxx')

    const stalled: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('a')) } }))
    const res = await makeTimeoutFetch({ connectTimeoutMs: 1_000, idleTimeoutMs: 30 }, stalled)('http://x')
    expect(providerErrorCodeOf(await res.text().catch(e => e))).toBe('network')
  })

  it('保留 status 与响应头', async () => {
    const res = await makeTimeoutFetch({ connectTimeoutMs: 1_000, idleTimeoutMs: 1_000 }, async () => new Response('{"error":1}', { status: 401, headers: { 'x-a': 'b' } }))('http://x')
    expect(res.status).toBe(401)
    expect(res.headers.get('x-a')).toBe('b')
    expect(await res.text()).toBe('{"error":1}')
  })
})
