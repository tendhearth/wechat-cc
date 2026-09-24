/**
 * relay/pset.html —— 微信里 /set 链接落地的公网壳页(部署在中继,不随 daemon 发布)。
 * 2026-09-24 定:家里用电脑,手机网页只在外面用 ⇒ 不再探测 LAN,一律走隧道;
 * daemon 认不出令牌时回明文 auth_failed,壳页要说人话,而不是永远「连回你的电脑…」。
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../../relay/pset.html', import.meta.url), 'utf8')
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(SRC)![1]!

function runShell(hash: string, stored: string | null) {
  const sockets: FakeWS[] = []
  class FakeWS {
    url: string; sent: string[] = []; closed = false
    onopen?: () => void; onmessage?: (ev: { data: string }) => void; onerror?: () => void
    constructor(url: string) { this.url = url; sockets.push(this) }
    send(s: string) { this.sent.push(s) }
    close() { this.closed = true }
  }
  const store = new Map<string, string>(stored ? [['deviceToken', stored]] : [])
  const msg = { textContent: '' }
  const images: unknown[] = []
  const env = {
    location: { hash, host: 'cc.example', replace: vi.fn() },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => store.delete(k) },
    document: { getElementById: () => msg, open: vi.fn(), write: vi.fn(), close: vi.fn() },
    WebSocket: FakeWS, Image: class { constructor() { images.push(this) } },
    crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob,
  }
  new Function(...Object.keys(env), SCRIPT)(...Object.values(env))
  return { sockets, store, msg, images, env }
}

describe('pset shell', () => {
  it('goes straight to the tunnel even when the link carries a LAN address (no home probe)', () => {
    const { sockets, images, env } = runShell('#id=D1&t=tLINK&p=%2Fset&lan=192.168.1.2:5000', null)
    expect(images).toHaveLength(0)
    expect(env.location.replace).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.url).toBe('wss://cc.example/tunnel/phone?id=D1')
  })

  it('a stale stored device token falls back to the link token and retries once', () => {
    const { sockets, store } = runShell('#id=D1&t=tLINK&p=%2Fset', 'dOLD')
    sockets[0]!.onmessage!({ data: JSON.stringify({ error: 'auth_failed' }) })
    expect(store.has('deviceToken')).toBe(false)
    expect(sockets).toHaveLength(2)
  })

  it('an unrecognised link token tells the owner to ask for a new link', () => {
    const { sockets, msg } = runShell('#id=D1&t=tLINK&p=%2Fset', null)
    sockets[0]!.onmessage!({ data: JSON.stringify({ error: 'auth_failed' }) })
    expect(sockets).toHaveLength(1)
    expect(msg.textContent).toBe('链接过期啦,回微信跟 CC 再要一个')
  })
})
