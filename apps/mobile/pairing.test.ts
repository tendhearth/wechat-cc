/**
 * 手机页在隧道里的两条路(2026-09-24 真机:微信里点 /set 链接,在外面永远卡住):
 *   - 配对按钮必须走 api():裸 fetch 在壳模式下打到中继域,必 404;
 *   - 握手之后 daemon 回的明文错误帧(auth_failed)要让挂着的请求失败,而不是永远等。
 * 两段都是经典脚本,这里按页面里的全局变量把它们跑起来。
 */
import { describe, it, expect, vi } from 'vitest'
import { readMobileSource } from './sources'
import { generateTunnelKeypair, exportPublicKeyB64 } from '../../src/lib/tunnel-crypto'

function el() {
  const handlers: Record<string, () => void> = {}
  return { hidden: true, textContent: '', handlers, addEventListener(t: string, fn: () => void) { handlers[t] = fn } }
}

function runNav(opts: { shell: boolean }) {
  const els: Record<string, ReturnType<typeof el>> = { pairbtn: el(), pairbar: el(), 'nav-set': el() }
  els.pairbar!.hidden = false
  const store = new Map<string, string>()
  const env = {
    document: { getElementById: (id: string) => els[id], querySelectorAll: () => [] },
    api: vi.fn(async () => ({ json: async () => ({ ok: true, device_token: 'dNEW' }) })),
    fetch: vi.fn(async () => { throw new Error('bare fetch must not be used for pairing') }),
    toast: vi.fn(), ccNav: vi.fn(), resetTunnel: vi.fn(),
    localStorage: { setItem: (k: string, v: string) => store.set(k, v) },
    location: { reload: vi.fn() },
    window: opts.shell ? { __CC_SHELL__: { relay: 'wss://r', id: 'x' } } : {},
  }
  const src = `var T = "tLINK", isDevice = false\n${readMobileSource('nav.js')}\nreturn { get T() { return T }, get isDevice() { return isDevice } }`
  const state = new Function(...Object.keys(env), src)(...Object.values(env)) as { T: string; isDevice: boolean }
  return { env, els, store, state }
}

describe('pair button', () => {
  it('pairs through api() (tunnel-aware), stores the device token and hides the bar', async () => {
    const { env, els, store, state } = runNav({ shell: false })
    els.pairbtn!.handlers.click!()
    await vi.waitFor(() => expect(env.toast).toHaveBeenCalled())
    expect(env.api).toHaveBeenCalledWith('/set/api/pair', { method: 'POST' })
    expect(env.fetch).not.toHaveBeenCalled()
    expect(store.get('deviceToken')).toBe('dNEW')
    expect(state.T).toBe('dNEW')
    expect(state.isDevice).toBe(true)
    expect(els.pairbar!.hidden).toBe(true)
    expect(env.location.reload).not.toHaveBeenCalled()
    expect(env.resetTunnel).toHaveBeenCalledTimes(1)
  })

  it('in the relay shell, reloads so the shell re-handshakes with the new device token', async () => {
    const { env } = runNav({ shell: true })
    env.document.getElementById('pairbtn')!.handlers.click!()
    await vi.waitFor(() => expect(env.location.reload).toHaveBeenCalled(), { timeout: 3000 })   // 先让「配好了」停留 1.2s
  })
})

describe('transport error frame after the handshake', () => {
  it('fails pending requests with the daemon error instead of hanging', async () => {
    let sock: { onopen?: () => void; onmessage?: (ev: { data: string }) => void; onclose?: () => void; send: (s: string) => void; close: () => void } | null = null
    class FakeWS {
      onopen?: () => void; onmessage?: (ev: { data: string }) => void; onclose?: () => void; onerror?: () => void
      sent: string[] = []
      constructor() { sock = this; setTimeout(() => this.onopen?.(), 0) }
      send(s: string) { this.sent.push(s) }
      close() { this.onclose?.() }
    }
    const env = {
      WebSocket: FakeWS, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob,
      T: 'tLINK', REMOTE: { relay: 'wss://r', id: 'x' }, q: (p: string) => p,
      window: { __CC_SHELL__: { relay: 'wss://r', id: 'x' } }, location: {},
      fetch: vi.fn(async () => { throw new Error('offline') }),
    }
    const api = new Function(...Object.keys(env), `${readMobileSource('transport.js')}\nreturn api`)(...Object.values(env)) as
      (path: string, opts?: object) => Promise<unknown>
    const pending = api('/m/api/home')
    await vi.waitFor(() => expect((sock as unknown as FakeWS | null)?.sent.length).toBe(1))   // phone sent its hs
    const daemon = await generateTunnelKeypair()
    sock!.onmessage!({ data: JSON.stringify({ hs: await exportPublicKeyB64(daemon.publicKey) }) })
    await vi.waitFor(() => expect((sock as unknown as FakeWS).sent.length).toBe(2))            // sealed request went out
    sock!.onmessage!({ data: JSON.stringify({ error: 'auth_failed' }) })
    await expect(pending).rejects.toThrow('auth_failed')
  })

  it('stream_unknown (daemon reconnected to the relay and forgot this stream) ⇒ the request fails, the socket closes, the next api() re-handshakes on a fresh socket', async () => {
    const socks: Array<{ onopen?: () => void; onmessage?: (ev: { data: string }) => void; onclose?: () => void; sent: string[]; closed: boolean }> = []
    class FakeWS {
      onopen?: () => void; onmessage?: (ev: { data: string }) => void; onclose?: () => void; onerror?: () => void
      sent: string[] = []; closed = false
      constructor() { socks.push(this); setTimeout(() => this.onopen?.(), 0) }
      send(s: string) { this.sent.push(s) }
      close() { this.closed = true; this.onclose?.() }
    }
    const env = {
      WebSocket: FakeWS, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob,
      T: 'tLINK', REMOTE: { relay: 'wss://r', id: 'x' }, q: (p: string) => p,
      window: { __CC_SHELL__: { relay: 'wss://r', id: 'x' } }, location: {},
      fetch: vi.fn(async () => { throw new Error('offline') }),
    }
    const api = new Function(...Object.keys(env), `${readMobileSource('transport.js')}\nreturn api`)(...Object.values(env)) as
      (path: string, opts?: object) => Promise<unknown>
    const daemon = await generateTunnelKeypair()
    const hs = JSON.stringify({ hs: await exportPublicKeyB64(daemon.publicKey) })
    const first = api('/m/api/home')
    await vi.waitFor(() => expect(socks[0]?.sent.length).toBe(1))
    socks[0]!.onmessage!({ data: hs })
    await vi.waitFor(() => expect(socks[0]!.sent.length).toBe(2))
    socks[0]!.onmessage!({ data: JSON.stringify({ error: 'stream_unknown' }) })
    await expect(first).rejects.toThrow('stream_unknown')
    expect(socks[0]!.closed).toBe(true)
    void api('/m/api/home').catch(() => {})
    await vi.waitFor(() => expect(socks[1]?.sent.length).toBe(1))                              // new socket, new hs
    expect(JSON.parse(socks[1]!.sent[0]!)).toHaveProperty('hs')
  })
})

describe('配对换令牌之后的 401(plan 7a 单次配对)', () => {
  function runTransport(T0: string) {
    const store = new Map<string, string>([['deviceToken', 'dNEW']])
    const env = {
      WebSocket: class {}, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob,
      T: T0, REMOTE: null, q: (p: string) => p, window: {}, fetch: vi.fn(),
      localStorage: { removeItem: (k: string) => { store.delete(k) } },
      location: { replace: vi.fn() },
    }
    const api = new Function(...Object.keys(env), `${readMobileSource('transport.js')}\nreturn { onUnauthorized, resetTunnel }`)(...Object.values(env)) as
      { onUnauthorized(sentAs: string): void; resetTunnel(): void }
    return { api, env, store }
  }
  it('发请求时的令牌就是现在的令牌 ⇒ 本机令牌失效:清掉、回 /m', () => {
    const { api, env, store } = runTransport('dNEW')
    api.onUnauthorized('dNEW')
    expect(store.has('deviceToken')).toBe(false)
    expect(env.location.replace).toHaveBeenCalledWith('/m')
  })
  it('刚配对换了令牌,在飞的旧短令牌请求回 401 ⇒ 什么都不动', () => {
    const { api, env, store } = runTransport('dNEW')
    api.onUnauthorized('tLINK')
    expect(store.get('deviceToken')).toBe('dNEW')
    expect(env.location.replace).not.toHaveBeenCalled()
  })
  it('resetTunnel 之后旧 socket 的 close 是异步到的:不许把已经开好的新隧道清掉(真 WebSocket 的 onclose 晚到)', async () => {
    const socks: Array<{ onopen?: () => void; onmessage?: (ev: { data: string }) => void; onclose?: () => void; sent: string[]; closed: boolean }> = []
    class FakeWS {
      onopen?: () => void; onmessage?: (ev: { data: string }) => void; onclose?: () => void; onerror?: () => void
      sent: string[] = []; closed = false
      constructor() { socks.push(this); setTimeout(() => this.onopen?.(), 0) }
      send(s: string) { this.sent.push(s) }
      close() { this.closed = true; setTimeout(() => this.onclose?.(), 20) }   // 浏览器里 close 事件晚一拍
    }
    const env = {
      WebSocket: FakeWS, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob,
      T: 'tLINK', REMOTE: { relay: 'wss://r', id: 'x' }, q: (p: string) => p,
      window: { __CC_SHELL__: { relay: 'wss://r', id: 'x' } }, location: {},
      fetch: vi.fn(async () => { throw new Error('offline') }),
    }
    const t = new Function(...Object.keys(env), `${readMobileSource('transport.js')}\nreturn { api, resetTunnel }`)(...Object.values(env)) as
      { api(path: string, opts?: object): Promise<unknown>; resetTunnel(): void }
    const daemon = await generateTunnelKeypair()
    const hs = JSON.stringify({ hs: await exportPublicKeyB64(daemon.publicKey) })
    void t.api('/m/api/home').catch(() => {})
    await vi.waitFor(() => expect(socks[0]?.sent.length).toBe(1))
    socks[0]!.onmessage!({ data: hs })
    await vi.waitFor(() => expect(socks[0]!.sent.length).toBe(2))
    t.resetTunnel()
    expect(socks[0]!.closed).toBe(true)
    void t.api('/m/api/home').catch(() => {})                                                   // 新隧道,旧 close 还没到
    await vi.waitFor(() => expect(socks[1]?.sent.length).toBe(1))
    socks[1]!.onmessage!({ data: hs })
    await vi.waitFor(() => expect(socks[1]!.sent.length).toBe(2))
    await new Promise((r) => setTimeout(r, 40))                                                  // 旧 socket 的 onclose 这时才到
    void t.api('/m/api/home').catch(() => {})
    await vi.waitFor(() => expect(socks[1]!.sent.length).toBe(3))                                // 还走新隧道
    expect(socks).toHaveLength(2)                                                                // 没有第三次握手
  })
  it('没有隧道时 resetTunnel 不抛', () => {
    expect(() => runTransport('dNEW').api.resetTunnel()).not.toThrow()
  })
  it('home.js 的 401 一律走 onUnauthorized,不再直接删令牌', () => {
    const src = readMobileSource('home.js')
    expect(src).not.toContain('localStorage.removeItem("deviceToken")')
    expect(src.match(/onUnauthorized\(sent\)/g)?.length).toBe(2)
  })
})
