/**
 * client.ts — 手机隧道协议客户端(未来的 Expo/RN app 与 CLI 自检用)。
 *
 * 一条连接的生命周期:
 *   1. `opts.open()` 拿到一个 socket(接口见 client-types.ts),等它 `onOpen`。
 *   2. 明文发 `{hs, v:[1,2]}`,开握手期限(缺省 = requestTimeoutMs,过期或
 *      hello 畸形 ⇒ 断开按退避重连);后台回 `{hs, v:2}` ⇒ v2,回 `{hs}` ⇒ 老后台 v1。
 *      密钥经 HKDF 绑定设备令牌(令牌从不上线)。
 *   3. 之后全是密封帧。v2 每次握手新建一条 V2Channel —— 每次重连都是新的
 *      X25519 密钥对 ⇒ 新密钥 ⇒ 新 channel,同一组密钥永不重建(否则
 *      计数器 nonce 复用)。
 *
 * 可靠性语义:
 *   - 每次尝试的超时只在真正发出后才计;等连接/握手的时间不耗重试次数,但受总
 *     期限约束(见 `ClientOpts.requestDeadlineMs`):到期仍没发出 ⇒ `unreachable`,
 *     到期时在途 ⇒ 这次超时后不再重试。
 *   - 请求超时 ⇒ 只有可重试的请求(GET/HEAD,或显式 `retry: true`)以**同一个
 *     rid** 重发(`retries` 次,缺省 1),用完以 `timeout` 拒绝;同一 rid 的
 *     回复先到先得,后到的忽略。超时时若该连接自请求发出后什么都没收到
 *     (换网络后没收到关闭的死连接),先丢掉连接,重试走新握手。
 *   - 断线 ⇒ 若还有挂起请求或订阅,指数退避重连(500 ms 起,封顶 15 s);
 *     连接稳定 ≥ 10 s 才把退避清零,抖动的连接不会以最快速度狂连。
 *     没事可做时不重连,下次用到再连。
 *   - 订阅重连后带最后见过的 `{epoch, seq}` 重新 `sub`;事件是状态快照,
 *     不保证每条中间事件都到,同 epoch 下 seq 不更新的一律丢(去重)。
 *   - 明文 `auth_failed` ⇒ 所有挂起请求以它拒绝,永不再连;订阅者收到 onSubscriptionError(topic,'auth_failed');明文 `stream_unknown`
 *     (后台跟中继重连过、忘了这条流)⇒ 断开按退避重连,这条连接上在途的可重试请求耗一次
 *     重试以同一 rid 重发,不可重试的以 `stream_unknown` 拒绝,订阅带 since 重新 sub;其它
 *     明文错误(中继的 `daemon_offline` 等)⇒ 挂起请求以该 code 拒绝,断开后按退避重连。
 *     `frame_too_large` ⇒ 已发出的请求失败不重试;`rate_limited` / `quota_exceeded` /
 *     `too_many_streams` ⇒ 至少 30 s 后才重连。
 *   - 保活:v2 连接上只挂订阅、没有挂起请求时,空闲 `keepaliveMs`(缺省 30 s)就发 `ping`,
 *     `requestTimeoutMs` 内一帧都没回 ⇒ 当死连接丢掉重连。v1 连接从不发。
 *   - 线上来的一切先过 zod;不合形状就丢并报 `onProtocolError`,永不从
 *     socket 回调里往外抛。
 *
 * RN 可用:不碰 node:*、字节容器全局、Web Crypto 的 subtle、DOM 全局;计时器走
 * globalThis 的 setTimeout/clearTimeout,`now` 可注入。
 */
import { b64uEncode, b64uDecode } from './b64u'
import { x25519KeyPair, x25519Shared } from './x25519'
import { deriveV1Key, sealV1, openV1 } from './v1'
import { deriveV2Keys, makeV2Channel } from './v2'
import type { V2Channel } from './v2'
import {
  ServerHello, ErrorFrame, SealedV1Frame, SealedV2Frame, V1Response, V2ServerMessage, b64Encode, b64Decode,
} from './messages'
import type { V1RequestT, ReqMsgT, V2ClientMessageT, V2ServerMessageT } from './messages'

import type { ProtocolSocket, ClientOpts, ProtocolRequest, ProtocolResponse, EventMeta, ProtocolClient } from './client-types'

export type { ProtocolSocket, ClientOpts, ProtocolRequest, ProtocolResponse, EventMeta, ProtocolClient } from './client-types'

const DEFAULT_TIMEOUT_MS = 15_000
const BACKOFF_BASE_MS = 500
const BACKOFF_CAP_MS = 15_000
/** 中继说「你太快了 / 今天用超了 / 流太多」:至少这么久之后才重连,别把房间打爆(spec §6)。 */
const RELAY_BUSY_BACKOFF_MS = 30_000
const STABLE_MS = 10_000
const DEFAULT_KEEPALIVE_MS = 30_000

type Timer = ReturnType<typeof setTimeout>

interface Conn {
  sock: ProtocolSocket
  priv: Uint8Array
  version: 1 | 2 | null
  v1Key?: Uint8Array
  chan?: V2Channel
  readyAt?: number
  /** 这条连接收到过几帧(任何帧都算,用来判断「悄悄死掉」)。 */
  recv: number
  hsTimer?: Timer
  /** 保活:空闲 keepaliveMs 后触发;每收到一帧重新计时。只在 v2 连接上用。 */
  kaTimer?: Timer
  /** 保活 ping 已发、在等任何一帧回来(requestTimeoutMs)。 */
  pingTimer?: Timer
}

interface Pending {
  req: ProtocolRequest
  retriesLeft: number
  rid: string
  sent: boolean
  /** 本次尝试发在哪条连接上、当时那条连接已收到几帧。 */
  sentOn?: Conn
  recvAtSend: number
  /** 本次尝试的超时:只在真正发出去之后才开始计。 */
  timer?: Timer
  /** 整个请求的总期限(见 ClientOpts.requestDeadlineMs,从 request() 起算)。 */
  deadline?: Timer
  /** 总期限已过、但当时请求在途:这次尝试超时后不再重试。 */
  overdue: boolean
  resolve(r: ProtocolResponse): void
  reject(e: Error): void
}

interface Sub {
  sid: string
  topic: string
  cb: (data: unknown, meta: EventMeta) => void
  last?: EventMeta
}

const utf8 = new TextEncoder()
const utf8d = new TextDecoder()

function makeResponse(status: number, headers: Record<string, string>, body: Uint8Array): ProtocolResponse {
  return {
    status,
    headers,
    body,
    text: () => utf8d.decode(body),
    json: <T>() => JSON.parse(utf8d.decode(body)) as T,
  }
}

export function makeProtocolClient(opts: ClientOpts): ProtocolClient {
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = opts.retries ?? 1
  const hsTimeoutMs = opts.handshakeTimeoutMs ?? timeoutMs
  const deadlineMs = opts.requestDeadlineMs
  const keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS
  const now = opts.now ?? (() => Date.now())
  const protoErr = (reason: string, detail?: unknown) => { try { opts.onProtocolError?.(reason, detail) } catch { /* 钩子自己的错不关我们的事 */ } }
  const subErr = (topic: string, code: string) => { try { opts.onSubscriptionError?.(topic, code) } catch { /* 同上 */ } }

  let conn: Conn | null = null
  let negotiated: 1 | 2 | null = null
  let closed = false
  let fatal: Error | null = null
  let reconnectTimer: Timer | null = null
  let backoffAttempt = 0
  let busyUntil = 0
  let ridSeq = 0
  let sidSeq = 0
  let pingSeq = 0
  const byRid = new Map<string, Pending>()
  const subs = new Map<string, Sub>()

  // ── 连接 ────────────────────────────────────────────────────────────

  const needsConnection = () => byRid.size > 0 || subs.size > 0

  function ensureConnected(): void {
    if (closed || fatal || conn || reconnectTimer) return
    connect()
  }

  function connect(): void {
    const kp = x25519KeyPair()
    let sock: ProtocolSocket
    try { sock = opts.open() } catch (e) { protoErr('open_failed', e); scheduleReconnect(); return }
    const c: Conn = { sock, priv: kp.priv, version: null, recv: 0 }
    conn = c
    // 握手期限从 open 起算:连不上、连上了后台不回 hs,都走同一条断开+退避。
    c.hsTimer = setTimeout(() => { c.hsTimer = undefined; if (c.version === null) dropConn(c) }, hsTimeoutMs)
    sock.onOpen(() => {
      if (conn !== c) return
      sendRaw(c, JSON.stringify({ hs: b64uEncode(kp.pub), v: [1, 2] }))
    })
    sock.onMessage(s => {
      if (conn !== c) return
      c.recv += 1
      // 收到任何帧都证明这条流活着、后台还认得它:清掉在等的 ping,空闲计时重来。
      if (c.pingTimer) { clearTimeout(c.pingTimer); c.pingTimer = undefined }
      armKeepalive(c)
      try { onFrame(c, s) } catch (e) { protoErr('handler_threw', e) }
    })
    sock.onClose(() => { if (conn === c) dropConn(c) })
  }

  /** 这条连接作废:清状态,按需排重连。可由 onClose 或我们主动断开触发,只生效一次。 */
  function dropConn(c: Conn): void {
    if (conn !== c) return
    conn = null
    if (c.hsTimer) { clearTimeout(c.hsTimer); c.hsTimer = undefined }
    if (c.kaTimer) { clearTimeout(c.kaTimer); c.kaTimer = undefined }
    if (c.pingTimer) { clearTimeout(c.pingTimer); c.pingTimer = undefined }
    try { c.sock.close() } catch { /* 已经关了 */ }
    if (c.readyAt !== undefined && now() - c.readyAt >= STABLE_MS) backoffAttempt = 0
    if (!closed && !fatal && needsConnection()) scheduleReconnect()
  }

  function scheduleReconnect(): void {
    if (reconnectTimer || closed || fatal) return
    const delay = Math.max(Math.min(BACKOFF_BASE_MS * 2 ** backoffAttempt, BACKOFF_CAP_MS), busyUntil - now())
    backoffAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (needsConnection()) connect()
    }, delay)
  }

  // ── 保活 ────────────────────────────────────────────────────────────
  // 只挂订阅、没有挂起请求的客户端没有任何超时会触发:后台把流忘了(它跟中继重连过)或者
  // 连接悄悄死了,都永远察觉不到。所以空闲 keepaliveMs 就发一个 v2 `ping`;requestTimeoutMs
  // 内一帧都没回来 ⇒ 当死连接丢掉、按退避重连、重新 sub。后台不认这条流会明文回
  // `stream_unknown`,走 onErrorFrame 那条更快的路。v1 连接永远不发(老后台不认 ping)。

  function armKeepalive(c: Conn): void {
    if (keepaliveMs <= 0 || c.version !== 2 || conn !== c) return
    if (c.kaTimer) clearTimeout(c.kaTimer)
    c.kaTimer = setTimeout(() => onIdle(c), keepaliveMs)
  }

  function onIdle(c: Conn): void {
    c.kaTimer = undefined
    if (conn !== c || closed) return
    armKeepalive(c)
    // 有挂起请求 ⇒ 请求自己的超时会发现死连接;没订阅 ⇒ 这条连接断了也没人在乎。
    if (subs.size === 0 || byRid.size > 0 || c.pingTimer) return
    const recvAtPing = c.recv
    sendV2(c, { t: 'ping', rid: `k${++pingSeq}` })
    c.pingTimer = setTimeout(() => {
      c.pingTimer = undefined
      if (conn === c && c.recv === recvAtPing) dropConn(c)
    }, timeoutMs)
  }

  function sendRaw(c: Conn, s: string): void {
    try { c.sock.send(s) } catch (e) { protoErr('send_failed', e) }
  }

  function sendV2(c: Conn, m: V2ClientMessageT): void {
    sendRaw(c, JSON.stringify(c.chan!.seal(utf8.encode(JSON.stringify(m)))))
  }

  // ── 收帧 ────────────────────────────────────────────────────────────

  function onFrame(c: Conn, s: string): void {
    let f: unknown
    try { f = JSON.parse(s) } catch { protoErr('not_json'); return }
    const errFrame = ErrorFrame.safeParse(f)
    if (errFrame.success) { onErrorFrame(c, errFrame.data.error); return }
    if (c.version === null) { onHello(c, f); return }
    if (c.version === 1) onV1Frame(c, f)
    else onV2Frame(c, f)
  }

  function onErrorFrame(c: Conn, code: string): void {
    if (code === 'auth_failed') {
      fatal = new Error('auth_failed')
      failAll(fatal)
      for (const sub of [...subs.values()]) { subs.delete(sub.sid); subErr(sub.topic, 'auth_failed') }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      dropConn(c)
      return
    }
    if (code === 'stream_unknown') {
      // 后台不认这条流(它跟中继重连过,流状态没了)。发在这条流上的请求多半没被处理:可重试的
      // 按老规矩耗一次重试、以同一 rid 在新连接上重发;其余以 stream_unknown 拒绝。还没发出去
      // 的留着等新连接。订阅在新握手后带 since 重新 sub。
      for (const p of [...byRid.values()]) {
        if (!p.sent || p.sentOn !== c) continue
        if (p.timer) { clearTimeout(p.timer); p.timer = undefined }
        if (p.retriesLeft > 0 && !p.overdue) { p.retriesLeft -= 1; p.sent = false; p.sentOn = undefined }
        else settle(p.rid, q => q.reject(new Error(code)))
      }
      dropConn(c)
      return
    }
    if (code === 'frame_too_large') {
      // 中继拒了一帧(太大)。是哪一条请求中继不知道(密文),但重发同一帧只会再被拒:
      // 这条连接上已发出的请求一律以它失败,不重试;没发出去的留给新连接。
      for (const p of [...byRid.values()]) {
        if (!p.sent || p.sentOn !== c) continue
        settle(p.rid, q => q.reject(new Error(code)))
      }
      dropConn(c)
      return
    }
    if (code === 'rate_limited' || code === 'quota_exceeded' || code === 'too_many_streams') {
      busyUntil = now() + RELAY_BUSY_BACKOFF_MS
    }
    failAll(new Error(code))
    dropConn(c)
  }

  function onHello(c: Conn, f: unknown): void {
    const h = ServerHello.safeParse(f)
    if (!h.success) { protoErr('bad_hello', h.error); dropConn(c); return }
    let theirPub: Uint8Array
    let shared: Uint8Array
    try {
      theirPub = b64uDecode(h.data.hs)
      shared = x25519Shared(c.priv, theirPub)
    } catch (e) { protoErr('bad_hello_key', e); dropConn(c); return }
    if (h.data.v === 2) {
      c.chan = makeV2Channel(deriveV2Keys(shared, opts.token), 'client')
      c.version = 2
    } else {
      c.v1Key = deriveV1Key(shared, opts.token)
      c.version = 1
    }
    negotiated = c.version
    c.readyAt = now()
    if (c.hsTimer) { clearTimeout(c.hsTimer); c.hsTimer = undefined }
    armKeepalive(c)
    if (c.version === 1) {
      for (const sub of [...subs.values()]) { subs.delete(sub.sid); subErr(sub.topic, 'subscriptions_need_v2') }
    } else {
      for (const sub of subs.values()) sendSub(c, sub)
    }
    for (const p of [...byRid.values()]) if (!p.sent) sendReq(c, p)
  }

  function onV1Frame(c: Conn, f: unknown): void {
    const sealed = SealedV1Frame.safeParse(f)
    if (!sealed.success) { protoErr('bad_v1_frame', sealed.error); return }
    let pt: Uint8Array
    try { pt = openV1(c.v1Key!, sealed.data) } catch (e) { protoErr('v1_open_failed', e); return }
    let body: unknown
    try { body = JSON.parse(utf8d.decode(pt)) } catch { protoErr('v1_not_json'); return }
    const r = V1Response.safeParse(body)
    if (!r.success) { protoErr('bad_v1_response', r.error); return }
    settle(r.data.rid, p => p.resolve(makeResponse(r.data.status, {}, utf8.encode(r.data.body))))
  }

  function onV2Frame(c: Conn, f: unknown): void {
    const sealed = SealedV2Frame.safeParse(f)
    if (!sealed.success) { protoErr('bad_v2_frame', sealed.error); return }
    let pt: Uint8Array
    try { pt = c.chan!.open(sealed.data) } catch (e) { protoErr('v2_open_failed', e); return }
    let body: unknown
    try { body = JSON.parse(utf8d.decode(pt)) } catch { protoErr('v2_not_json'); return }
    const m = V2ServerMessage.safeParse(body)
    if (!m.success) { protoErr('bad_v2_message', m.error); return }
    onV2Message(m.data)
  }

  function onV2Message(m: V2ServerMessageT): void {
    if (m.t === 'res') {
      let bytes: Uint8Array
      try { bytes = m.bodyEncoding === 'base64' ? b64Decode(m.body) : utf8.encode(m.body) } catch (e) { protoErr('bad_res_body', e); return }
      settle(m.rid, p => p.resolve(makeResponse(m.status, m.headers, bytes)))
      return
    }
    if (m.t === 'pong') return   // 保活回执:到达本身已在 onMessage 里清掉了在等的 ping
    if (m.t === 'err') {
      if (m.rid !== undefined) settle(m.rid, p => p.reject(new Error(m.code)))
      if (m.sid !== undefined) {
        const sub = subs.get(m.sid)
        if (sub) { subs.delete(m.sid); subErr(sub.topic, m.code) }
      }
      return
    }
    // ev
    const sub = subs.get(m.sid)
    if (!sub) return
    if (sub.last && sub.last.epoch === m.epoch && m.seq <= sub.last.seq) return
    sub.last = { epoch: m.epoch, seq: m.seq }
    try { sub.cb(m.data, { epoch: m.epoch, seq: m.seq }) } catch (e) { protoErr('subscriber_threw', e) }
  }

  // ── 请求 ────────────────────────────────────────────────────────────

  function settle(rid: string, fn: (p: Pending) => void): void {
    const p = byRid.get(rid)
    if (!p) return // 迟到的旧 rid,或者根本不是我们的
    byRid.delete(rid)
    if (p.timer) clearTimeout(p.timer)
    if (p.deadline) clearTimeout(p.deadline)
    fn(p)
  }

  function failAll(e: Error): void {
    for (const rid of [...byRid.keys()]) settle(rid, p => p.reject(e))
  }

  function startAttempt(p: Pending): void {
    p.sent = false
    p.sentOn = undefined
    byRid.set(p.rid, p)
    ensureConnected()
    if (conn && conn.version !== null) sendReq(conn, p)
  }

  /**
   * 总期限:还没发出去(一直在等连接/握手)⇒ 以 unreachable 拒绝;在途 ⇒ 让这次
   * 尝试自己超时,但不再重试。等连接的时间从不消耗重试次数。
   */
  function onDeadline(p: Pending): void {
    p.deadline = undefined
    if (byRid.get(p.rid) !== p) return
    if (p.sent) { p.overdue = true; return }
    settle(p.rid, q => q.reject(new Error('unreachable')))
  }

  function onTimeout(p: Pending): void {
    p.timer = undefined
    if (byRid.get(p.rid) !== p) return
    // 发出后这条连接一帧都没再收到 ⇒ 多半是悄悄死掉的连接,换一条再说。
    const dead = p.sentOn !== undefined && p.sentOn === conn && p.sentOn.recv === p.recvAtSend
    if (p.retriesLeft > 0 && !p.overdue) {
      p.retriesLeft -= 1
      if (dead) dropConn(p.sentOn!)
      startAttempt(p)
      return
    }
    settle(p.rid, q => q.reject(new Error('timeout')))
    if (dead) dropConn(p.sentOn!)
  }

  function sendReq(c: Conn, p: Pending): void {
    const { req } = p
    if (c.version === 1) {
      if (req.body instanceof Uint8Array) { settle(p.rid, q => q.reject(new Error('binary_body_needs_v2'))); return }
      const m: V1RequestT = { path: req.path, method: req.method, rid: p.rid }
      if (req.body !== undefined) m.body = req.body
      markSent(c, p)
      sendRaw(c, JSON.stringify(sealV1(c.v1Key!, utf8.encode(JSON.stringify(m)))))
      return
    }
    const m: ReqMsgT = { t: 'req', rid: p.rid, method: req.method, path: req.path }
    if (req.headers) m.headers = req.headers
    if (req.body instanceof Uint8Array) { m.body = b64Encode(req.body); m.bodyEncoding = 'base64' }
    else if (req.body !== undefined) { m.body = req.body; m.bodyEncoding = 'utf8' }
    markSent(c, p)
    sendV2(c, m)
  }

  function markSent(c: Conn, p: Pending): void {
    p.sent = true
    p.sentOn = c
    p.recvAtSend = c.recv
    if (p.timer) clearTimeout(p.timer)
    p.timer = setTimeout(() => onTimeout(p), timeoutMs)
  }

  // ── 订阅 ────────────────────────────────────────────────────────────

  function sendSub(c: Conn, sub: Sub): void {
    sendV2(c, sub.last ? { t: 'sub', sid: sub.sid, topic: sub.topic, since: sub.last } : { t: 'sub', sid: sub.sid, topic: sub.topic })
  }

  // ── 对外 ────────────────────────────────────────────────────────────

  return {
    version: () => negotiated,

    request(req) {
      if (closed) return Promise.reject(new Error('closed'))
      if (fatal) return Promise.reject(fatal)
      return new Promise<ProtocolResponse>((resolve, reject) => {
        const m = req.method.toUpperCase()
        const retryable = req.retry ?? (m === 'GET' || m === 'HEAD')
        const retriesLeft = retryable ? retries : 0
        const p: Pending = { req, retriesLeft, rid: `r${++ridSeq}`, sent: false, recvAtSend: 0, overdue: false, resolve, reject }
        p.deadline = setTimeout(() => onDeadline(p), deadlineMs ?? (timeoutMs + hsTimeoutMs + BACKOFF_CAP_MS) * (retriesLeft + 1))
        startAttempt(p)
      })
    },

    subscribe(topic, onEvent) {
      if (closed) throw new Error('closed')
      if (fatal) throw fatal
      if (negotiated === 1) throw new Error('subscriptions_need_v2')
      const sub: Sub = { sid: `s${++sidSeq}`, topic, cb: onEvent }
      subs.set(sub.sid, sub)
      ensureConnected()
      if (conn && conn.version === 2) sendSub(conn, sub)
      return () => {
        if (subs.get(sub.sid) !== sub) return
        subs.delete(sub.sid)
        if (conn && conn.version === 2) sendV2(conn, { t: 'unsub', sid: sub.sid })
      }
    },

    close() {
      if (closed) return
      closed = true
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      failAll(new Error('closed'))
      subs.clear()
      if (conn) dropConn(conn)
    },
  }
}
