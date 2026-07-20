import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeMailboxClient } from './mailbox-client'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
function stubFetch(impl: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = (vi.fn(async (u: any, i: any) => impl(String(u), i)) as unknown) as typeof fetch
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('makeMailboxClient', () => {
  it('drop posts {to,envelope} to /drop and returns true on 200', async () => {
    const seen: Array<{ url: string; body: any }> = []
    stubFetch((url, init) => { seen.push({ url, body: JSON.parse(String(init.body)) }); return ok({ ok: true }) })
    expect(await makeMailboxClient().drop('https://r/', 'boxA', 'ENV')).toBe(true)
    expect(seen[0]!.url).toBe('https://r/drop'); expect(seen[0]!.body).toEqual({ to: 'boxA', envelope: 'ENV' })
  })
  it('fetch returns the parsed page, and null on a non-200', async () => {
    stubFetch((url) => url.endsWith('/fetch') ? ok({ items: [{ cursor: 3, envelope: 'e' }], next_cursor: 3 }) : ok({}))
    expect(await makeMailboxClient().fetch('https://r/', 'm', 0, 1, 's')).toEqual({ items: [{ cursor: 3, envelope: 'e' }], next_cursor: 3 })
    stubFetch(() => new Response('nope', { status: 401 }))
    expect(await makeMailboxClient().fetch('https://r/', 'm', 0, 1, 's')).toBeNull()
  })
  it('ack posts up_to_cursor to /ack; a network throw → false (never throws)', async () => {
    const seen: any[] = []
    stubFetch((url, init) => { seen.push(JSON.parse(String(init.body))); return ok({ ok: true }) })
    expect(await makeMailboxClient().ack('https://r/', 'm', 7, 2, 'sig')).toBe(true)
    expect(seen[0]).toEqual({ mailbox: 'm', up_to_cursor: 7, ts: 2, sig: 'sig' })
    globalThis.fetch = (vi.fn(async () => { throw new Error('econnrefused') }) as unknown) as typeof fetch
    expect(await makeMailboxClient().ack('https://r/', 'm', 7, 2, 'sig')).toBe(false)
  })
})
