/**
 * 真实形状沙盒(real-shaped.ts)用的系统边界替身:只替身「这台机器以外」的东西,daemon 内部一个模块都不 mock。
 *
 *  - `startFakeInternet`:网络守护的连通探测(generate_204)、出口 IP(ipify)、语音合成(http_tts)那几个外部 HTTP 端点,
 *    全部换成本机的一个 HTTP 服务。守护照真机那样开着,判据走的是真的 probe / ipify 代码路径。
 *  - `startFakeMailboxRelay`:笔友信箱中继(`mailbox_relays`)的 `/drop` `/fetch` `/ack`,存在内存里。不验签 ——
 *    验签是中继自己的事(apps/relay 的测试),这里只要 daemon 的社交 / 配对 / 信箱轮询能照真机那样起来、拨得通。
 *  - `startFakePhoneRelay`:手机中继 v2 的 daemon 那一侧(`/v2/daemon` 的 WebSocket):发 challenge、收到签名就回
 *    login_ok,之后的流帧只收不转。手机那一侧不在这里(手机协议的闭环在 src/features/phone 的测试里)。
 *  - `fenceNetwork`:把 `fetch` / `WebSocket` 包一层,只放行本机(127.0.0.1 / localhost / ::1),往外的一律当场失败
 *    并记下来 —— 沙盒「不出网」是被强制的,不是靠自觉;记下来的那张单子让测试能断言「这次开机没想往外打」。
 */
import { serve, type Server } from '../../lib/runtime/http'

const LOOPBACK = /^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i

export interface NetworkFence {
  /** 被拦下的往外请求(URL),按发生先后。 */
  blocked(): readonly string[]
  restore(): void
}

export function fenceNetwork(): NetworkFence {
  const blocked: string[] = []
  const g = globalThis as unknown as { fetch: typeof fetch; WebSocket: typeof WebSocket }
  const origFetch = g.fetch
  const origWs = g.WebSocket
  const urlOf = (input: unknown): string => typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url ?? input)
  g.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = urlOf(input)
    if (!LOOPBACK.test(url)) {
      blocked.push(url)
      throw new TypeError(`real-shaped sandbox: outbound network blocked (${url})`)
    }
    return origFetch(input, init)
  }, origFetch)
  class FencedWebSocket extends origWs {
    constructor(url: string | URL, protocols?: string | string[]) {
      const u = typeof url === 'string' ? url : url.href
      if (!LOOPBACK.test(u)) {
        blocked.push(u)
        throw new TypeError(`real-shaped sandbox: outbound websocket blocked (${u})`)
      }
      super(url, protocols)
    }
  }
  g.WebSocket = FencedWebSocket as unknown as typeof WebSocket
  return {
    blocked: () => blocked,
    restore() { g.fetch = origFetch; g.WebSocket = origWs },
  }
}

export interface FakeInternet {
  baseUrl: string
  /** 每个路径被打了几次(`/generate_204`、`/ip`、`/tts` …)。 */
  hits(path: string): number
  stop(): void
}

export function startFakeInternet(): FakeInternet {
  const hits = new Map<string, number>()
  const server: Server = serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      hits.set(path, (hits.get(path) ?? 0) + 1)
      if (path === '/generate_204') return new Response(null, { status: 204 })
      // TEST-NET-3(RFC 5737),不是谁真的地址
      if (path === '/ip') return new Response('203.0.113.7', { headers: { 'content-type': 'text/plain' } })
      // http_tts:回一段假的音频字节(daemon 只转发,不解码)
      if (path.startsWith('/tts')) return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), { headers: { 'content-type': 'audio/mpeg' } })
      return new Response('not found', { status: 404 })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}`, hits: (p) => hits.get(p) ?? 0, stop: () => server.stop(true) }
}

export interface FakeMailboxRelay {
  url: string
  /** 投进来的信封数(按收件箱)。 */
  dropped(mailbox?: string): number
  fetches(): number
  stop(): void
}

export function startFakeMailboxRelay(): FakeMailboxRelay {
  const boxes = new Map<string, Array<{ cursor: number; envelope: string }>>()
  let cursor = 0, fetches = 0
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
  const server: Server = serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method !== 'POST') return json({ error: 'method' }, 405)
      const body = await req.json().catch(() => null) as Record<string, unknown> | null
      if (!body) return json({ error: 'bad json' }, 400)
      if (path === '/drop') {
        const to = String(body.to ?? ''), envelope = String(body.envelope ?? '')
        if (!to || !envelope) return json({ error: 'bad drop' }, 400)
        const box = boxes.get(to) ?? []
        box.push({ cursor: ++cursor, envelope })
        boxes.set(to, box)
        return json({ ok: true, cursor })
      }
      if (path === '/fetch') {
        fetches++
        const since = Number(body.since ?? 0)
        const items = (boxes.get(String(body.mailbox ?? '')) ?? []).filter(i => i.cursor > since).slice(0, 64)
        return json({ items, next_cursor: items.at(-1)?.cursor ?? since })
      }
      if (path === '/ack') {
        const box = boxes.get(String(body.mailbox ?? ''))
        if (box) boxes.set(String(body.mailbox), box.filter(i => i.cursor > Number(body.up_to_cursor ?? 0)))
        return json({ ok: true })
      }
      return json({ error: 'not found' }, 404)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    dropped: (mailbox) => mailbox ? (boxes.get(mailbox)?.length ?? 0) : [...boxes.values()].reduce((n, b) => n + b.length, 0),
    fetches: () => fetches,
    stop: () => server.stop(true),
  }
}

export interface FakePhoneRelay {
  /** 写进 agent-config 的 `relay_v2_url`。 */
  url: string
  /** 登录成功过几次(daemon 的隧道客户端连上并签了 challenge)。 */
  logins(): number
  stop(): void
}

/** 手机中继 v2 的 daemon 侧。WebSocket 服务端只有 Bun.serve 有(同 yi-ws-server 的理由),这里是测试代码,直接用。 */
export function startFakePhoneRelay(): FakePhoneRelay {
  let logins = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (new URL(req.url).pathname === '/v2/daemon' && srv.upgrade(req)) return undefined
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) { ws.send(JSON.stringify({ challenge: 'sandbox-challenge' })) },
      message(ws, raw) {
        let msg: Record<string, unknown> = {}
        try { msg = JSON.parse(String(raw)) as Record<string, unknown> } catch { return }
        if (typeof msg.sig === 'string' && typeof msg.pub === 'string') { logins++; ws.send(JSON.stringify({ login_ok: true })); return }
        if ('ping' in msg) ws.send(JSON.stringify({ pong: msg.ping }))
      },
    },
  })
  return { url: `ws://127.0.0.1:${server.port}`, logins: () => logins, stop: () => server.stop(true) }
}

/** 拿一个此刻空着的本机端口(A2A / 乙 hub 要配死端口,配置里不接受 0)。 */
export function freePort(): number {
  const s = serve({ port: 0, fetch: () => new Response('') })
  const p = s.port
  s.stop(true)
  return p
}
