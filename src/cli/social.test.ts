import { describe, expect, it, vi } from 'vitest'
import { cmdSocialWishes } from './social'

// Capture console.log calls during a block.
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

// 心愿 (spec 2026-09-04-wish-postcard §4) — `wishes` GETs /v1/social/wishes
// from the running daemon (same injected-fetch/readInfo/readToken pattern
// the deleted P4 propose/confirm/cancel/reveal commands used).
describe('cmdSocialWishes', () => {
  const info = { baseUrl: 'http://127.0.0.1:9', tokenFilePath: '/tmp/tok' }
  const baseDeps = { readInfo: () => info, readToken: () => 'tokhex' }

  it('GETs /v1/social/wishes and prints id / status / sent_to / replies / text', async () => {
    const calls: { url: string; method?: string } [] = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method })
      return new Response(JSON.stringify({
        wishes: [{ id: 'abcd1234', text: '找搭子', status: 'open', created_at: 'c', expires_at: 'e', sent_to: 2, replies: 1 }],
      }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialWishes('/nope', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(calls[0]!.url).toContain('/v1/social/wishes')
    expect(calls[0]!.method).toBe('GET')
    const joined = out.join('\n')
    expect(joined).toContain('abcd1234')
    expect(joined).toContain('open')
    expect(joined).toContain('sent_to=2')
    expect(joined).toContain('replies=1')
    expect(joined).toContain('找搭子')
  })

  it('prints an empty note when there are no wishes', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ wishes: [] }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialWishes('/nope', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(out.some(l => /没有|no wishes/i.test(l))).toBe(true)
  })

  it('--json emits the wishes envelope verbatim', async () => {
    const wishes = [{ id: 'abcd1234', text: '找搭子', status: 'open', created_at: 'c', expires_at: 'e', sent_to: 2, replies: 1 }]
    const fakeFetch = (async () => new Response(JSON.stringify({ wishes }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialWishes('/nope', { json: true }, { ...baseDeps, fetch: fakeFetch }))
    expect(JSON.parse(out.join('\n'))).toEqual({ wishes })
  })

  it('fails clearly when the daemon is not running', async () => {
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdSocialWishes('/nope', { json: false }, { readInfo: () => null, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/daemon/i)
  })
})
