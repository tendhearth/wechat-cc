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

// 2026-09-01:真机上 Mac 的取件连续几百拍失败,而日志只会说「超时/非 2xx/
// 网络」—— 三种成因的处置完全不同(超时=调 timeoutMs 或换中继;401=签名/
// 时钟;网络=DNS/断网),混成一句等于什么都没说。手工探针一跑就发现中继
// 好好的、200 只要 0.5s,真正的成因是间歇性超时 —— 那条日志本该直接告诉我。
describe('onError —— 失败原因必须能区分', () => {
  it('非 2xx 报出状态码', async () => {
    const seen: Array<[string, string]> = []
    const client = makeMailboxClient({
      onError: (op, reason) => seen.push([op, reason]),
      fetchImpl: async () => new Response('nope', { status: 401 }),
    })
    expect(await client.fetch('https://r/mailbox', 'm', 0, 1, 's')).toBeNull()
    expect(seen).toEqual([['fetch', 'HTTP 401']])
  })

  it('超时报 timeout,不报成含糊的网络错误', async () => {
    const seen: Array<[string, string]> = []
    const client = makeMailboxClient({
      timeoutMs: 20,
      onError: (op, reason) => seen.push([op, reason]),
      fetchImpl: (_u, init) => new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('The operation was aborted.')))
      }),
    })
    expect(await client.fetch('https://r/mailbox', 'm', 0, 1, 's')).toBeNull()
    expect(seen).toEqual([['fetch', 'timeout(20ms)']])
  })

  it('网络错误原样报出来', async () => {
    const seen: Array<[string, string]> = []
    const client = makeMailboxClient({
      onError: (op, reason) => seen.push([op, reason]),
      fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND r') },
    })
    expect(await client.drop('https://r/mailbox', 'to', 'env')).toBe(false)
    expect(seen).toEqual([['drop', 'getaddrinfo ENOTFOUND r']])
  })

  it('成功不报错', async () => {
    const seen: unknown[] = []
    const client = makeMailboxClient({
      onError: (...a) => seen.push(a),
      fetchImpl: async () => new Response(JSON.stringify({ items: [], next_cursor: 3 }), { status: 200 }),
    })
    expect(await client.fetch('https://r/mailbox', 'm', 0, 1, 's')).toEqual({ items: [], next_cursor: 3 })
    expect(seen).toEqual([])
  })
})
