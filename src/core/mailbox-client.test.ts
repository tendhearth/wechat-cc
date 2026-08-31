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
  // 2026-08-29 生产事故:mailbox 轮询卡满 11 分钟被调度器放弃
  // (`[SCHED] mailbox tick exceeded 660000ms`,当天三次)。根因是超时定时器
  // 只包住 fetch() 本身——而 fetch() 在响应【头】到达就 resolve,body 读取
  // 落在 clearTimeout 之后,完全不受保护。对端发了头就卡住 body(网络不稳
  // 时的常见形态)⇒ 永久挂死。a2a-client.ts 的 withTimeout 一直是对的。
  it('a stalled response BODY still times out — the timer must cover the body read, not just the headers', async () => {
    // 头立刻到,body 永不到达:半开连接的精确形态。桩必须像真实 fetch 那样
    // 把 abort 传导到 body 流 —— 否则测的是桩不是代码(忽略 signal 的桩会
    // 让修好的实现也照样挂死,给出假红)。
    stubFetch((_url, init) => new Response(
      new ReadableStream({
        start(controller) {
          const signal = init.signal as AbortSignal | undefined
          signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
          // 永不 enqueue、永不 close
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const STALLED = Symbol('stalled')
    const r = await Promise.race([
      makeMailboxClient({ timeoutMs: 50 }).fetch('https://r/', 'm', 0, 1, 's'),
      new Promise(resolve => setTimeout(() => resolve(STALLED), 1000)),
    ])
    expect(r).toBeNull()   // 挂死的话这里会是 STALLED
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
