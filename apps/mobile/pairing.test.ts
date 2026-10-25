/**
 * 手机页在隧道里的两条路(2026-09-24 真机:微信里点 /set 链接,在外面永远卡住):
 *   - 配对按钮必须走 api():裸 fetch 在壳模式下打到中继域,必 404;
 *   - 握手之后 daemon 回的明文错误帧(auth_failed)要让挂着的请求失败,而不是永远等。
 * 两段都是经典脚本,这里按页面里的全局变量把它们跑起来。
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { readMobileSource } from './sources'
import { Window } from 'happy-dom'
import { makeFakeV2Relay } from './fake-v2-relay'

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

/** 在 new Function 里跑 transport.js(经典脚本,按页面里的全局变量喂),中继 + daemon 是 fake-v2-relay 的假 socket。 */
function runTunnel(relay: ReturnType<typeof makeFakeV2Relay>, o: { T?: string; remote?: { relay: string; id: string }; document?: unknown; store?: Map<string, string> } = {}) {
  const remote = o.remote ?? { relay: 'wss://r/v2/phone', id: 'rX' }
  const store = o.store ?? new Map<string, string>()
  const env = {
    WebSocket: relay.WebSocket, crypto: globalThis.crypto, TextEncoder, TextDecoder,
    T: o.T ?? 'tLINK', REMOTE: remote, q: (p: string) => p,
    window: { __CC_SHELL__: remote }, location: {},
    fetch: vi.fn(async () => { throw new Error('offline') }),
    localStorage: { getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => { store.delete(k) } },
    document: o.document,
  }
  return new Function(...Object.keys(env), `${readMobileSource('transport.js')}\nreturn { api, resetTunnel }`)(...Object.values(env)) as
    { api(path: string, opts?: object): Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>; resetTunnel(): void }
}

describe('transport over relay v2 (F4:跟 App 同一个协议客户端)', () => {
  it('handshakes v2 as the web client, sends method / headers / body, resolves a fetch-like response', async () => {
    const relay = makeFakeV2Relay({ tokens: () => ['tLINK'], handler: r => ({ status: 200, body: JSON.stringify({ ok: true, device_token: 'dNEW', echo: r.body }) }) })
    const t = runTunnel(relay)
    const r = await t.api('/set/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, device_token: 'dNEW', echo: '{}' })
    expect(relay.sockets[0]!.url).toBe('wss://r/v2/phone?id=rX')
    expect(relay.sockets[0]!.hellos[0]).toMatchObject({ v: [2], client: 'web' })
    expect(relay.sockets[0]!.reqs[0]).toMatchObject({ method: 'POST', path: '/set/api/pair', headers: { 'content-type': 'application/json' }, body: '{}' })
  })

  it('fails pending requests with the daemon error (auth_failed) instead of hanging', async () => {
    const relay = makeFakeV2Relay({ tokens: () => [] })
    await expect(runTunnel(relay).api('/m/api/home')).rejects.toThrow('auth_failed')
  })

  it('stream_unknown (daemon reconnected to the relay and forgot this stream) ⇒ the socket closes, a GET is retried once on a fresh handshake', async () => {
    const relay = makeFakeV2Relay({ tokens: () => ['tLINK'], auto: false })
    const t = runTunnel(relay)
    const first = t.api('/m/api/home')
    await vi.waitFor(() => expect(relay.sockets[0]?.hellos).toHaveLength(1))
    relay.sockets[0]!.hello()
    await vi.waitFor(() => expect(relay.sockets[0]!.reqs).toHaveLength(1))
    relay.sockets[0]!.deliver({ error: 'stream_unknown' })
    await vi.waitFor(() => expect(relay.sockets[0]!.closed).toBe(true))
    await vi.waitFor(() => expect(relay.sockets[1]?.hellos).toHaveLength(1), { timeout: 3000 })   // 退避之后新 socket、新握手
    relay.sockets[1]!.hello()
    await vi.waitFor(() => expect(relay.sockets[1]!.reqs).toHaveLength(1))
    expect(relay.sockets[1]!.reqs[0]!.rid).toBe(relay.sockets[0]!.reqs[0]!.rid)                     // 同一个 rid 重发
    relay.sockets[1]!.reply(relay.sockets[1]!.reqs[0]!.rid, { status: 200, body: '{"ok":true}' })
    expect((await first).status).toBe(200)
  })
})

describe('v1 退休之后的老配对(F4):提示重新扫码配对', () => {
  const REPAIR = '连接方式升级了，请在电脑上重新扫码配对'
  const windows: Window[] = []
  afterEach(async () => { await Promise.all(windows.splice(0).map(w => w.happyDOM.abort())) })
  function page() {
    const w = new Window({ url: 'https://relay.test/pset/' }); windows.push(w)
    w.document.body.innerHTML = '<div id="banner"></div>'
    return w.document
  }
  const repairText = (d: ReturnType<typeof page>) => d.getElementById('cc-repair')?.textContent ?? null

  it('还拿着老中继的远程信息(t… id)⇒ 不连,请求以 upgrade_required 失败;页面顶上出那句话,丢掉老的 ccRemote 和绑在老中继上的设备令牌', async () => {
    const relay = makeFakeV2Relay({ tokens: () => ['dOLD'] })
    const doc = page()
    const store = new Map([['ccRemote', '{"relay":"wss://cc.tendhearth.com/tunnel/phone","id":"t000"}'], ['deviceToken', 'dOLD'], ['deviceTokenId', 't000']])
    const t = runTunnel(relay, { T: 'dOLD', remote: { relay: 'wss://cc.tendhearth.com/tunnel/phone', id: 't' + '0'.repeat(36) }, document: doc, store })
    await expect(t.api('/m/api/home')).rejects.toThrow('upgrade_required')
    expect(relay.sockets).toHaveLength(0)
    expect(repairText(doc)).toContain(REPAIR)
    expect(repairText(doc)).toContain('连接手机')
    expect(doc.body.firstElementChild?.id).toBe('cc-repair')
    expect([...store.keys()]).toEqual([])
    // 再来一次不叠第二块
    await expect(t.api('/m/api/home')).rejects.toThrow('upgrade_required')
    expect(doc.querySelectorAll('#cc-repair')).toHaveLength(1)
  })

  it('daemon 明文回 upgrade_required(这个页面还在说 v1)⇒ 同一句话,不再重连', async () => {
    const relay = makeFakeV2Relay({ tokens: () => ['dX'], auto: false })
    const doc = page()
    const t = runTunnel(relay, { T: 'dX', document: doc })
    const p = t.api('/m/api/home')
    await vi.waitFor(() => expect(relay.sockets[0]?.hellos).toHaveLength(1))
    relay.sockets[0]!.deliver({ error: 'upgrade_required' })
    await expect(p).rejects.toThrow('upgrade_required')
    expect(repairText(doc)).toContain(REPAIR)
    await new Promise(r => setTimeout(r, 50))
    expect(relay.sockets).toHaveLength(1)
  })

  it('回来的握手不是 v2(老后台 / 中继剥掉了 v)⇒ 拒绝降级,同一句话', async () => {
    const relay = makeFakeV2Relay({ tokens: () => ['dX'], stripV: true })
    const doc = page()
    const t = runTunnel(relay, { T: 'dX', document: doc })
    void t.api('/m/api/home').catch(() => {})
    await vi.waitFor(() => expect(repairText(doc)).toContain(REPAIR))
    expect(relay.sockets[0]!.reqs).toHaveLength(0)
  })
})

describe('配对换令牌之后的 401(plan 7a 单次配对)', () => {
  function runTransport(T0: string) {
    const store = new Map<string, string>([['deviceToken', 'dNEW']])
    const env = {
      WebSocket: class {}, crypto: globalThis.crypto, TextEncoder, TextDecoder,
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
    const relay = makeFakeV2Relay({ tokens: () => ['tLINK'] })
    const t = runTunnel(relay)
    expect((await t.api('/m/api/home')).status).toBe(200)
    t.resetTunnel()
    expect(relay.sockets[0]!.closed).toBe(true)
    expect((await t.api('/m/api/home')).status).toBe(200)                                       // 新隧道,旧 close 也许还没到
    await new Promise((r) => setTimeout(r, 40))                                                  // 旧 socket 的 onclose 这时早到了
    expect((await t.api('/m/api/home')).status).toBe(200)
    expect(relay.sockets).toHaveLength(2)                                                        // 没有第三次握手
    expect(relay.sockets[1]!.reqs).toHaveLength(2)                                               // 还走新隧道
  })
  it('没有隧道时 resetTunnel 不抛', () => {
    expect(() => runTransport('dNEW').api.resetTunnel()).not.toThrow()
  })
  it('home.js 的 401 一律走 onUnauthorized,不再直接删令牌', () => {
    const src = readMobileSource('home.js')
    expect(src).not.toContain('localStorage.removeItem("deviceToken")')
    expect(src.match(/onUnauthorized\(sent\)/g)?.length).toBe(1)
  })
})

describe('配对换令牌后,旧令牌那一趟的失败不是「连不上」(plan 7a fix round 1)', () => {
  type Resp = { status: number; json: () => Promise<unknown> }
  function runHome(api: (path: string) => Promise<Resp>) {
    const els: Record<string, { innerHTML: string; textContent: string; hidden: boolean; classList: { contains: () => boolean }; addEventListener: () => void }> = {}
    const get = (id: string) => (els[id] ??= { innerHTML: '', textContent: '', hidden: true, classList: { contains: () => true }, addEventListener: () => {} })
    const env = {
      document: { getElementById: get, querySelector: () => ({ addEventListener: () => {} }), addEventListener: () => {}, hidden: false, visibilityState: 'hidden' },
      api: vi.fn(api), toast: vi.fn(), esc: (s: unknown) => String(s), q: (p: string) => p, preferTunnel: false,
      REMOTE: null, location: { host: 'h', replace: vi.fn() }, setInterval: () => 0,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: vi.fn() },
      renderPresenceHome: () => {},
    }
    const src = `var T = "tLINK"\nfunction onUnauthorized(sentAs) { if (sentAs !== T) return; localStorage.removeItem("deviceToken"); location.replace("/m") }\n${readMobileSource('home.js')}
      return { setT: function(v){ T = v }, banner: function(){ return document.getElementById("banner").textContent } }`
    const page = new Function(...Object.keys(env), src)(...Object.values(env)) as { setT(v: string): void; banner(): string }
    return { env, page }
  }
  const okHome = { ok: true, events: [], synced_at: '2026-10-01T00:00:00.000Z', today: '2026-10-01' }

  it('旧令牌的 401 在飞时换了令牌 ⇒ 不出「连不上」横幅、不删令牌,用新令牌重拉一次', async () => {
    let swap!: () => void
    const gate = new Promise<void>((r) => { swap = r })
    let calls = 0
    const { env, page } = runHome(async () => {
      calls++
      if (calls <= 1) { await gate; return { status: 401, json: async () => ({ error: 'unauthorized' }) } }
      return { status: 200, json: async () => okHome }
    })
    page.setT('dNEW'); swap()
    await vi.waitFor(() => expect(env.api).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 0))
    expect(page.banner()).toBe('')
    expect(env.toast).not.toHaveBeenCalled()
    expect(env.localStorage.removeItem).not.toHaveBeenCalled()
    expect(env.location.replace).not.toHaveBeenCalled()
  })

  it('resetTunnel 把旧隧道上的请求以 closed 失败 ⇒ 同样不出「连不上」,用新令牌重拉', async () => {
    let swap!: () => void
    const gate = new Promise<void>((r) => { swap = r })
    let calls = 0
    const { env, page } = runHome(async () => {
      calls++
      if (calls <= 1) { await gate; throw new Error('closed') }
      return { status: 200, json: async () => okHome }
    })
    page.setT('dNEW'); swap()
    await vi.waitFor(() => expect(env.api).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 0))
    expect(page.banner()).toBe('')
    expect(env.toast).not.toHaveBeenCalled()
  })

  it('令牌没换时真连不上 ⇒ 照旧出横幅(不吞真故障)', async () => {
    const { env, page } = runHome(async () => { throw new Error('closed') })
    await vi.waitFor(() => expect(page.banner()).toContain('连不上'))
    expect(env.api).toHaveBeenCalledTimes(1)
  })
})
