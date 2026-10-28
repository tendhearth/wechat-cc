/**
 * 测试用:扮「中继 + daemon」的假 WebSocket,给手机网页(transport.js)与公网壳页(relay/pset.html)的测试用。
 *
 * 用协议包自己的密码学(x25519 + deriveV2Keys + makeV2Channel('server'))回握手、开密封帧、封回复,不手搓密文。
 * 行为照 src/features/phone/tunnel-client.ts:握手 v 含 2 ⇒ `{hs, v:2}`;不含 ⇒ 明文 `upgrade_required`。
 * `auto: false` 时什么都不自动回,测试自己用 `deliver` 喂帧(测时序)。
 */
import { x25519KeyPair, x25519Shared, deriveV2Keys, makeV2Channel, b64uEncode, b64uDecode, type V2Channel } from '../../packages/protocol/src/index'

export interface FakeReq { t: 'req'; rid: string; method: string; path: string; headers?: Record<string, string>; body?: string; bodyEncoding?: string }
export interface FakeRes { status: number; body: string; headers?: Record<string, string> }

export interface FakeWS {
  url: string
  sent: string[]
  closed: boolean
  hellos: Array<Record<string, unknown>>
  reqs: FakeReq[]
  onopen?: () => void
  onmessage?: (ev: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  send(s: string): void
  close(): void
  /** 中继 / daemon 往这条 socket 发一帧(明文对象)。 */
  deliver(obj: unknown): void
  /** 用这条流的 v2 通道封一条 res 发回去。 */
  reply(rid: string, res: FakeRes): void
  /** 手动回最近那次握手(`auto: false` 时用)。 */
  hello(): void
}

export function makeFakeV2Relay(opts: {
  /** daemon 认的令牌(设备令牌或链接令牌);不在里面 ⇒ 第一个密封帧回明文 auth_failed。 */
  tokens: () => string[]
  /** 自动回握手 / 请求。缺省 true。 */
  auto?: boolean
  /** 自动回请求时的处理器;缺省回 200 `{"ok":true}`。 */
  handler?: (req: FakeReq) => FakeRes
  /** 回 hello 时把 v 抹掉(中继想降级 / 老后台)。 */
  stripV?: boolean
}) {
  const sockets: FakeWS[] = []
  const auto = opts.auto ?? true

  class Socket implements FakeWS {
    url: string
    sent: string[] = []
    closed = false
    hellos: Array<Record<string, unknown>> = []
    reqs: FakeReq[] = []
    onopen?: () => void
    onmessage?: (ev: { data: string }) => void
    onclose?: () => void
    onerror?: () => void
    shared: Uint8Array | null = null
    chan: V2Channel | null = null
    constructor(url: string) {
      this.url = url
      sockets.push(this)
      setTimeout(() => { if (!this.closed) this.onopen?.() }, 0)
    }
    send(s: string) {
      if (this.closed) return
      this.sent.push(s)
      queueMicrotask(() => this.handle(s))
    }
    close() {
      if (this.closed) return
      this.closed = true
      setTimeout(() => this.onclose?.(), 0)
    }
    deliver(obj: unknown) {
      if (!this.closed) this.onmessage?.({ data: JSON.stringify(obj) })
    }
    reply(rid: string, res: FakeRes) {
      const m = { t: 'res', rid, status: res.status, headers: res.headers ?? { 'content-type': 'application/json' }, body: res.body, bodyEncoding: 'utf8' }
      this.deliver(this.chan!.seal(new TextEncoder().encode(JSON.stringify(m))))
    }
    hello() {
      const f = this.hellos.at(-1)!
      if (!(Array.isArray(f.v) && f.v.includes(2))) { this.deliver({ error: 'upgrade_required' }); return }
      const kp = x25519KeyPair()
      this.shared = x25519Shared(kp.priv, b64uDecode(f.hs as string))
      this.chan = null
      this.deliver(opts.stripV ? { hs: b64uEncode(kp.pub) } : { hs: b64uEncode(kp.pub), v: 2 })
    }
    private handle(s: string) {
      if (this.closed) return
      const f = JSON.parse(s) as Record<string, unknown>
      if (typeof f.hs === 'string') {
        this.hellos.push(f)
        if (auto) this.hello()
        return
      }
      if (!this.chan) {
        if (!this.shared) return
        for (const token of opts.tokens()) {
          const c = makeV2Channel(deriveV2Keys(this.shared, token), 'server')
          try { this.onSealed(c, c.open(f as { c: string; ct: string })); this.chan = c; return } catch { /* 不是这个令牌 */ }
        }
        this.deliver({ error: 'auth_failed' })
        return
      }
      this.onSealed(this.chan, this.chan.open(f as { c: string; ct: string }))
    }
    private onSealed(c: V2Channel, pt: Uint8Array) {
      const m = JSON.parse(new TextDecoder().decode(pt)) as FakeReq
      if (m.t !== 'req') return
      this.reqs.push(m)
      if (!auto) { this.chan = c; return }
      this.chan = c
      this.reply(m.rid, opts.handler ? opts.handler(m) : { status: 200, body: '{"ok":true}' })
    }
  }

  return { WebSocket: Socket, sockets }
}
