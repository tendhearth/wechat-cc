/**
 * relay/pset.html —— 微信里 /set 链接落地的公网壳页(部署在中继,不随 daemon 发布)。
 * 2026-09-24 定:家里用电脑,手机网页只在外面用 ⇒ 不再探测 LAN,一律走隧道;
 * daemon 认不出令牌时回明文 auth_failed,壳页要说人话,而不是永远「连回你的电脑…」。
 * 2026-10-25(F4):壳页跟 App / 网页同一个协议客户端说 v2,只连 /v2/phone;老中继 id(t…)或
 * daemon 回 upgrade_required ⇒ 「连接方式升级了，请在电脑上重新扫码配对」。
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { makeFakeV2Relay } from './fake-v2-relay'

const SRC = readFileSync(new URL('../../relay/pset.html', import.meta.url), 'utf8')
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(SRC)![1]!
const REPAIR = '连接方式升级了，请在电脑上重新扫码配对'
const EXPIRED = '这个链接已经用过或过期了，回微信跟 CC 再要一个'

function runShell(hash: string, stored: string | null, storedId?: string, relayOpts: Partial<Parameters<typeof makeFakeV2Relay>[0]> = {}) {
  const relay = makeFakeV2Relay({ tokens: () => ['tLINK'], handler: () => ({ status: 200, body: '<html><script>var T=1</script></html>', headers: { 'content-type': 'text/html' } }), ...relayOpts })
  const store = new Map<string, string>([...(stored ? [['deviceToken', stored]] as const : []), ...(storedId ? [['deviceTokenId', storedId]] as const : [])])
  const msg = { textContent: '' }
  const images: unknown[] = []
  const written: string[] = []
  const env = {
    location: { hash, host: 'cc.example', replace: vi.fn() },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => store.delete(k) },
    document: { getElementById: () => msg, open: vi.fn(), write: (h: string) => { written.push(h) }, close: vi.fn() },
    WebSocket: relay.WebSocket, Image: class { constructor() { images.push(this) } },
    crypto: globalThis.crypto, TextEncoder, TextDecoder,
  }
  new Function(...Object.keys(env), SCRIPT)(...Object.values(env))
  return { sockets: relay.sockets, store, msg, images, env, written }
}

describe('pset shell', () => {
  it('connects to /v2/phone, handshakes v2 as the web client and writes the fetched page with __CC_SHELL__', async () => {
    const { sockets, written } = runShell('#id=rABC&t=tLINK', null)
    expect(sockets[0]!.url).toBe('wss://cc.example/v2/phone?id=rABC')
    await vi.waitFor(() => expect(written).toHaveLength(1))
    expect(sockets[0]!.hellos[0]).toMatchObject({ v: [2], client: 'web' })
    expect(sockets[0]!.reqs[0]).toMatchObject({ method: 'GET', path: '/m?t=tLINK' })
    expect(written[0]).toContain('window.__CC_SHELL__={"relay":"wss://cc.example/v2/phone","id":"rABC"}')
  })

  it('goes straight to the tunnel even when the link carries a LAN address (no home probe)', () => {
    const { sockets, images, env } = runShell('#id=rD1&t=tLINK&p=%2Fset&lan=192.168.1.2:5000', null)
    expect(images).toHaveLength(0)
    expect(env.location.replace).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.url).toBe('wss://cc.example/v2/phone?id=rD1')
  })

  it('a stale stored device token (of this computer) is dropped and the link token retried once', async () => {
    const { sockets, store, written } = runShell('#id=rD1&t=tLINK&p=%2Fset', 'dOLD', 'rD1')
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    expect(store.has('deviceToken')).toBe(false)
    expect(store.has('deviceTokenId')).toBe(false)
    await vi.waitFor(() => expect(written).toHaveLength(1))       // 用链接里的短令牌重来一次就进去了
  })

  // 2026-10-10 评审:中继是所有人共用的一个域,别人的配对链接(#id=<他的电脑>)也打开这个壳页、读写同一份
  // localStorage。对方回一句明文 auth_failed,原先就删掉主人的令牌(一键解配)。只用、只删属于这台电脑的令牌。
  it('a link for ANOTHER computer neither uses nor deletes my token', async () => {
    const { msg, store } = runShell('#id=rOTHER&t=tOTHER', 'dMINE', 'rMINE')
    await vi.waitFor(() => expect(msg.textContent).toBe(EXPIRED))
    expect(store.get('deviceToken')).toBe('dMINE')
    expect(store.get('deviceTokenId')).toBe('rMINE')
  })
  it('a legacy token with no recorded computer is tried, but an auth_failed never deletes it', async () => {
    const { sockets, store } = runShell('#id=rD1&t=tLINK&p=%2Fset', 'dOLD')
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    expect(store.get('deviceToken')).toBe('dOLD')
  })

  it('an unrecognised link token tells the owner to ask for a new link', async () => {
    const { sockets, msg } = runShell('#id=rD1&t=tGONE&p=%2Fset', null)
    await vi.waitFor(() => expect(msg.textContent).toBe(EXPIRED))
    expect(sockets).toHaveLength(1)
  })
})

describe('pset shell:v1 退休之后的老链接 / 老配对(F4)', () => {
  it('老中继的链接(#id=t…)⇒ 不连,直接说「连接方式升级了，请在电脑上重新扫码配对」,丢掉绑在老中继上的设备令牌', () => {
    const { sockets, msg, store } = runShell('#id=t' + '0'.repeat(36) + '&t=tLINK&p=%2Fset', 'dOLD', 't' + '0'.repeat(36))
    expect(sockets).toHaveLength(0)
    expect(msg.textContent).toBe(REPAIR)
    expect(store.has('deviceToken')).toBe(false)
    expect(store.has('deviceTokenId')).toBe(false)
  })
  it('daemon 明文回 upgrade_required ⇒ 同一句,不再重连', async () => {
    const { sockets, msg } = runShell('#id=rD1&t=tLINK', null, undefined, { auto: false })
    await vi.waitFor(() => expect(sockets[0]?.hellos).toHaveLength(1))
    sockets[0]!.deliver({ error: 'upgrade_required' })
    await vi.waitFor(() => expect(msg.textContent).toBe(REPAIR))
    await new Promise(r => setTimeout(r, 50))
    expect(sockets).toHaveLength(1)
  })
  it('回来的握手不是 v2(中继剥掉了 v)⇒ 拒绝降级、不取页;说「连接在半路被改过」,存着的配对不删', async () => {
    const { msg, store, sockets, written } = runShell('#id=rD1&t=tLINK', 'dMINE', 'rD1', { stripV: true })
    await vi.waitFor(() => expect(msg.textContent).toContain('连接在半路被改过'))
    expect(store.get('deviceToken')).toBe('dMINE')
    expect(store.get('deviceTokenId')).toBe('rD1')
    expect(sockets[0]!.reqs).toHaveLength(0)
    expect(written).toHaveLength(0)
  })
})
