import { describe, expect, it, vi } from 'vitest'
import { cmdPairStart, cmdPairAccept } from './pair'

// Capture console.log calls during a block (mirrors src/cli/social.test.ts).
function captureLog(fn: () => unknown | Promise<unknown>): Promise<string[]> {
  const out: string[] = []
  const stub = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '))
  })
  const result = fn()
  if (result instanceof Promise) {
    return result.then(() => { stub.mockRestore(); return out })
      .catch(err => { stub.mockRestore(); throw err })
  }
  stub.mockRestore()
  return Promise.resolve(out)
}

const info = { baseUrl: 'http://127.0.0.1:9', tokenFilePath: '/tmp/tok' }
const baseDeps = { readInfo: () => info, readToken: () => 'tokhex' }

describe('cmdPairStart', () => {
  it('posts to /v1/pair/start and prints the code', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true, code: '483921', expiresAt: 123 }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await captureLog(() => cmdPairStart('/nope', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(calls[0]!.url).toContain('/v1/pair/start')
    expect(calls[0]!.init.method).toBe('POST')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tokhex')
    expect(out.join('\n')).toContain('483921')
  })

  it('--json emits the raw body verbatim', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: true, code: '111222', expiresAt: 999 }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdPairStart('/nope', { json: true }, { ...baseDeps, fetch: fakeFetch }))
    expect(JSON.parse(out[0]!)).toEqual({ ok: true, code: '111222', expiresAt: 999 })
  })

  // T8 carry-forward: the route passes PairStartResult through VERBATIM at
  // HTTP 200 — an `ok:false` body (e.g. the card never reached the relay)
  // must NOT be misread as a flattened `{code, expiresAt}` success.
  it('renders the honest failure on an ok:false body (relay_drop_failed) instead of crashing', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: false, reason: 'relay_drop_failed' }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdPairStart('/nope', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(out.join('\n')).not.toContain('undefined')
    expect(out.join('\n')).toMatch(/中继|失败/)
  })

  it('503 ⇒ friendly "not available" message', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: 'pairing_not_wired' }), { status: 503 })) as unknown as typeof fetch
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdPairStart('/nope', { json: false }, { ...baseDeps, fetch: fakeFetch, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/pairing not available/i)
  })

  it('daemon not running (info missing) ⇒ friendly error', async () => {
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdPairStart('/nope', { json: false }, { readInfo: () => null, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/daemon/i)
  })
})

describe('cmdPairAccept', () => {
  it('rejects a non-6-digit code before ever calling the daemon', async () => {
    const fakeFetch = vi.fn() as unknown as typeof fetch
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdPairAccept('/nope', 'abc', { json: false }, { ...baseDeps, fetch: fakeFetch, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/6 digits/i)
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('posts the code to /v1/pair/accept and prints the peer name on success', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ ok: true, peer: { self_id: 'cc-x', name: 'Bob' } }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await captureLog(() => cmdPairAccept('/nope', '483921', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(calls[0]!.url).toContain('/v1/pair/accept')
    expect(calls[0]!.body).toEqual({ code: '483921' })
    expect(out.join('\n')).toContain('Bob')
  })

  it('self_pair ⇒ friendly copy', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: false, reason: 'self_pair' }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdPairAccept('/nope', '483921', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(out.join('\n')).toContain('自己的码')
  })

  it('id_conflict ⇒ friendly copy', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: false, reason: 'id_conflict' }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdPairAccept('/nope', '483921', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(out.join('\n')).toContain('撞名')
  })

  it('expired_or_wrong ⇒ friendly copy', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: false, reason: 'expired_or_wrong' }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdPairAccept('/nope', '483921', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(out.join('\n')).toContain('码不对或已过期')
  })

  it('relay_drop_failed ⇒ friendly copy (distinct from expired_or_wrong)', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: false, reason: 'relay_drop_failed' }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdPairAccept('/nope', '483921', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(out.join('\n')).toContain('中继')
    expect(out.join('\n')).not.toContain('码不对或已过期')
  })

  it('--json emits the raw body verbatim', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: false, reason: 'id_conflict' }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdPairAccept('/nope', '483921', { json: true }, { ...baseDeps, fetch: fakeFetch }))
    expect(JSON.parse(out[0]!)).toEqual({ ok: false, reason: 'id_conflict' })
  })

  it('503 ⇒ friendly "not available" message', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: 'pairing_not_wired' }), { status: 503 })) as unknown as typeof fetch
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdPairAccept('/nope', '483921', { json: false }, { ...baseDeps, fetch: fakeFetch, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/pairing not available/i)
  })

  it('daemon not running (info missing) ⇒ friendly error', async () => {
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdPairAccept('/nope', '483921', { json: false }, { readInfo: () => null, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/daemon/i)
  })

  it('could not reach the daemon ⇒ friendly error', async () => {
    const fakeFetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdPairAccept('/nope', '483921', { json: false }, { ...baseDeps, fetch: fakeFetch, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/could not reach the daemon/i)
  })
})
