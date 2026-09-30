/**
 * tunnel-client.ts — the daemon's outbound leg of 随身 CC 的远程中继
 * (2026-08-26, mobile route step 4). Dials ONE WebSocket out to the relay's
 * /tunnel/daemon?id=<opaque> (NAT-piercing), then for each phone stream:
 *
 *   1. handshake: the phone sends `{hs:<its X25519 pubkey b64>}` plaintext;
 *      the daemon mints a FRESH ephemeral keypair per stream, replies
 *      `{hs:<daemon pubkey>}`, and derives the AES-GCM shared key. Perfect
 *      forward secrecy per stream (a leaked key can't decrypt other streams).
 *   2. request: the phone seals `{path,method,body}` → the daemon opens it,
 *      synthesizes a Request, runs it through the SAME handleRequest the LAN
 *      settings-panel uses (so /m/* and /set/* behave identically), seals the
 *      `{status,headers,body}` back under that stream.
 *
 * Protocol v2 (2026-09-29): a phone whose handshake carries `v:[…,2]` gets
 * `{hs, v:2}` back and speaks v2 on that stream — per-direction keys, counter
 * nonces + replay rejection, `req`/`res` with headers + binary bodies, and
 * `sub`/`unsub` onto the PhoneEvents hub. That per-stream logic lives in
 * tunnel-v2-stream.ts; this file only negotiates, identifies the device and
 * routes frames. v1 streams behave exactly as before (fully concurrent). Only
 * the ordering-sensitive part is serialized per stream (one promise chain):
 * handshakes, v2 device identification and v2 `channel.open` — the counter
 * check needs frames OPENED in arrival order. A v2 `req` is dispatched off the
 * chain once opened, so a slow request (a chat `say` awaiting a model turn)
 * never head-of-line-blocks the requests behind it.
 *
 * The relay never sees plaintext (tunnel.ts is content-blind); confidentiality
 * lives entirely here + on the phone. Device-token auth still applies: the
 * synthesized request carries the phone's `d=` token in its URL, so an
 * un-paired phone's requests 401 exactly as on the LAN.
 *
 * 中继 v2(2026-09-30):给了 `login` ⇒ id 走子协议、socket 里挑战登录;登录后才发控制帧(推送登记 / 发送)。
 */
import { RELAY_SUBPROTOCOL, relayIdProtocol } from '@wechat-cc/protocol'
import { deriveSharedBits, hkdfAesKey, generateTunnelKeypair, exportPublicKeyB64, importPublicKeyB64, sealFrame, openFrame, type TunnelKeypair, type TunnelSharedKey } from '../lib/tunnel-crypto'
import type { PhoneEvents } from './phone-events'
import { identifyV2, makeV2Stream, tunnelRequestUrl, type V2Stream } from './tunnel-v2-stream'

/** Minimal WS surface (browser-style events) both Bun's WebSocket and a fake satisfy. */
export interface TunnelWS {
  send(data: string): void
  close(): void
  addEventListener(type: 'message' | 'close' | 'open' | 'error', handler: (ev: { data?: unknown }) => void): void
  readyState: number
}

export interface TunnelClientDeps {
  daemonId: string
  /** The daemon's request router — the very same closure the LAN panel serves. */
  handleRequest: (req: Request) => Promise<Response>
  /** Current paired device tokens. The tunnel authenticates each stream by
   *  finding the token whose HKDF-bound key decrypts the phone's first frame
   *  (see the handshake below) — so the token is NEVER sent over the wire, and
   *  a MITM relay (which knows no token) can't forge a working key. */
  knownDeviceTokens: () => string[]
  /** 当前还有效的 /set 链接令牌(单活、10 分钟),没有就 null。没配对的手机在外面点链接,
   *  只有它可以用来握手;进去后点「把 CC 带在身上」换长期设备令牌(2026-09-24)。
   *  与设备令牌同一套 HKDF 绑定:令牌只在链接的 # 里,不上中继。 */
  activeLinkToken?: () => string | null
  /** Opens the outbound WS. Default dials the relay via Bun's WebSocket. */
  connect?: (url: string, protocols?: string[]) => TunnelWS
  relayUrl?: string
  reconnectMs?: number
  /** 心跳间隔(ms)。默认 20s。一轮 ping 没等到 pong 就判连接已死、强制重连。 */
  pingIntervalMs?: number
  /** Injected clock (tests). Backoff/down-time accounting only. */
  now?: () => number
  log?: (tag: string, line: string) => void
  /** v2 订阅的事件集线器。没有 ⇒ v2 的 `sub` 一律回 `err subscriptions_unavailable`。 */
  events?: PhoneEvents
  /** 给了 ⇒ 走官方中继 v2:id 放子协议,收到 {challenge} 用它签名回复。 */
  login?: { sign(challenge: string): { pub: string; sig: string } }
  /** v2 非流控制帧:push_result / push_invalid / error。 */
  onControl?: (msg: Record<string, unknown>) => void
  /** v2 登录成功(每次重连后都会再来一次)。 */
  onLogin?: () => void
}

/** Does this handshake ask for v2? (`v` is an array containing 2; anything else ⇒ v1.) */
function wantsV2(frame: unknown): boolean {
  const v = (frame as { v?: unknown }).v
  return Array.isArray(v) && v.includes(2)
}

/** Read a plaintext handshake control frame → the peer's pubkey b64, or null. */
export function handshakePlaintext(frame: unknown): string | null {
  if (frame && typeof frame === 'object' && typeof (frame as { hs?: unknown }).hs === 'string') {
    return (frame as { hs: string }).hs
  }
  return null
}

export interface TunnelClient {
  start(): void
  stop(): void
  /** 发一条控制帧;v2 模式要已登录,否则 false。 */
  sendControl(msg: object): boolean
  /** 有活订阅的已识别流对应的设备令牌(= 在线设备)。 */
  subscribedDeviceTokens(): Set<string>
}

export function makeTunnelClient(deps: TunnelClientDeps): TunnelClient {
  const relayUrl = deps.relayUrl ?? 'wss://cc.tendhearth.com/tunnel/daemon'
  // 指数退避重连(2026-08-27 日志:网络抖动时固定 15s 重连,恢复慢 + 日志
  // 刷屏)。首次断开 2s 重试(瞬时抖动秒回),连败翻倍到 reconnectMs 上限。
  const maxReconnectMs = deps.reconnectMs ?? 15_000
  const minReconnectMs = 2_000
  const log = deps.log ?? (() => {})
  let reconnectAttempts = 0     // 连续失败计数(老中继 open 成功清零;v2 要等 login_ok 才清零,见 markConnected)
  let downSince = 0             // 首次断开时刻(重连成功时算下线时长)
  let now = deps.now ?? (() => Date.now())
  // Per-stream ephemeral state: our keypair, the raw ECDH bits, and — once the
  // first frame identifies the device — the token-bound key + that device token.
  // v2 streams also carry `v2: true` from the handshake and, once identified, their V2Stream.
  type StreamState = { kp: TunnelKeypair; bits: ArrayBuffer; key?: TunnelSharedKey; device?: string; v2?: boolean; v2s?: V2Stream }
  const streams = new Map<string, StreamState>()
  // One promise chain per stream for the ordering-sensitive work (handshake, v2
  // identification + open). v2 req handling is dispatched off it; v1 never uses it
  // once its handshake is done.
  const chains = new Map<string, Promise<void>>()
  function enqueue(stream: string, task: () => Promise<void>): void {
    const next = (chains.get(stream) ?? Promise.resolve())
      .then(task)
      .catch(e => log('TUNNEL', `stream ${stream} handler threw: ${String(e)}`))
    chains.set(stream, next)
    void next.then(() => { if (chains.get(stream) === next) chains.delete(stream) })
  }
  /** Forget a stream: drop its keys and unsubscribe everything it held. */
  function forgetStream(stream: string): void {
    streams.get(stream)?.v2s?.close()
    streams.delete(stream)
  }
  let ws: TunnelWS | null = null
  let stopped = false
  let loggedIn = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // 心跳(2026-08-28 实测:过公司安全代理时,长连 WS 会被静默掐断 —— TCP 壳
  // 还在、close 帧不来,于是 daemon 以为还连着、relay 却早把它踢了,手机报
  // daemon_offline / 握手超时)。定时 ping,relay 回 pong;一轮没等到 pong 就
  // 判定连接已死,强制 close 触发重连(relay 端 registerDaemon 会用新 socket
  // 替换僵尸)。
  const PING_INTERVAL_MS = deps.pingIntervalMs ?? 20_000
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let awaitingPong = false
  function stopHeartbeat(): void { if (pingTimer) { clearInterval(pingTimer); pingTimer = null } awaitingPong = false }
  function startHeartbeat(sock: TunnelWS): void {
    stopHeartbeat()
    awaitingPong = false
    pingTimer = setInterval(() => {
      if (ws !== sock || stopped) { stopHeartbeat(); return }
      if (awaitingPong) {                 // 上一轮 ping 没回 pong → 连接已死
        stopHeartbeat()
        try { sock.close() } catch { /* close 会触发 onclose → 重连 */ }
        return
      }
      awaitingPong = true
      // 固定串:新中继的边缘直接回 pong 不唤醒房间
      try { sock.send('{"ping":1}') } catch { /* onclose 会接手 */ }
    }, PING_INTERVAL_MS)
    if (typeof (pingTimer as unknown as { unref?: () => void }).unref === 'function') (pingTimer as unknown as { unref: () => void }).unref()
  }

  // 认不出的流(2026-09-29 终审):心跳判死重连后 streams 清空了,但中继 registerDaemon 让手机
  // 的旧流原样挂到新 socket 上 —— 手机那头 WebSocket 不断,它再发的密封帧在这里一律找不到
  // 状态。以前只记一行就丢,只挂订阅的客户端永远察觉不到(Live Activity / 角标冻住)。现在
  // 明文回 `{error:'stream_unknown'}`,客户端据此断开重握手。握手进行中的流不会走到这里:
  // hs 进了这条流的串行链,后面的帧排在它后面,轮到时状态已经在了。每条流每 5 s 最多回一次,
  // 防止跟一个坏客户端来回打乒乓。
  const STREAM_UNKNOWN_EVERY_MS = 5_000
  const unknownNotified = new Map<string, number>()
  function notifyStreamUnknown(stream: string, frame: unknown): void {
    const ct = (frame as { ct?: unknown } | null)?.ct
    if (typeof ct !== 'string') { log('TUNNEL', `non-sealed frame on unknown stream ${stream} — dropped`); return }
    const t = now()
    const last = unknownNotified.get(stream)
    if (last !== undefined && t - last < STREAM_UNKNOWN_EVERY_MS) return
    for (const [s, at] of unknownNotified) if (t - at >= STREAM_UNKNOWN_EVERY_MS) unknownNotified.delete(s)
    unknownNotified.set(stream, t)
    log('TUNNEL', `sealed frame on unknown stream ${stream} (relay reconnect / before handshake) — told phone stream_unknown`)
    sendToStream(stream, { error: 'stream_unknown' })
  }

  const defaultConnect = (url: string, protocols?: string[]): TunnelWS => new (globalThis as unknown as { WebSocket: new (u: string, p?: string[]) => TunnelWS }).WebSocket(url, protocols)
  const connect = deps.connect ?? defaultConnect

  function sendToStream(stream: string, frame: unknown): void {
    ws?.send(JSON.stringify({ stream, frame }))
  }

  /** 明文告诉手机「没认出你」。中继 v2 模式下紧跟 `{stream, close:true}`:房间关掉这条流、立刻腾名额
   *  (否则知道 id 的人能用认不出的流占满 16 个名额)。房间关流时不再回 `closed`,这里自己忘掉它。
   *  老中继不认 close,会把没有 frame 的消息当 `{}` 转给手机 —— 所以只在 `deps.login` 时发。 */
  function rejectStream(stream: string): void {
    sendToStream(stream, { error: 'auth_failed' })
    if (!deps.login) return
    try { ws?.send(JSON.stringify({ stream, close: true })) } catch { /* close 会接手 */ }
    forgetStream(stream)
  }

  async function onStreamFrame(stream: string, frame: unknown): Promise<void> {
    const hsPub = handshakePlaintext(frame)
    if (hsPub) {
      // New stream (or re-handshake): fresh ephemeral keypair, compute raw ECDH
      // bits, reply with our pubkey. The FINAL key isn't derivable yet — it's
      // HKDF-bound to the device token, which we learn by trial-decrypting the
      // first sealed frame below.
      // A re-handshake on the same stream id drops the old keys + subscriptions.
      streams.get(stream)?.v2s?.close()
      const kp = await generateTunnelKeypair()
      let bits: ArrayBuffer
      try { bits = await deriveSharedBits(kp.privateKey, await importPublicKeyB64(hsPub)) }
      catch { log('TUNNEL', `bad handshake pubkey on ${stream}`); return }
      if (wantsV2(frame)) {
        streams.set(stream, { kp, bits, v2: true })
        sendToStream(stream, { hs: await exportPublicKeyB64(kp.publicKey), v: 2 })
        return
      }
      streams.set(stream, { kp, bits })
      sendToStream(stream, { hs: await exportPublicKeyB64(kp.publicKey) })
      return
    }
    // Sealed request — resolve/verify the device on the FIRST frame by finding
    // the paired token whose HKDF(bits, token) key decrypts it. A MITM relay
    // knows no token, so no candidate authenticates → dropped.
    const st = streams.get(stream)
    if (!st) { notifyStreamUnknown(stream, frame); return }
    if (st.v2) { await onV2Frame(stream, st, frame); return }
    let reqBytes: Uint8Array | null = null
    if (st.key) {
      try { reqBytes = await openFrame(st.key, frame as { iv: string; ct: string }) } catch { reqBytes = null }
    } else {
      const link = deps.activeLinkToken?.() ?? null
      for (const tok of link ? [...deps.knownDeviceTokens(), link] : deps.knownDeviceTokens()) {
        try {
          const cand = await hkdfAesKey(st.bits, new TextEncoder().encode(tok))
          const opened = await openFrame(cand, frame as { iv: string; ct: string })
          st.key = cand; st.device = tok; reqBytes = opened; break
        } catch { /* not this token */ }
      }
    }
    if (!reqBytes) {
      log('TUNNEL', `frame auth failed on ${stream} (no paired device / expired link / MITM) — dropped`)
      // 明文告诉手机「没认出你」,别让页面永远卡在「连回你的电脑…」。不带任何令牌或密文信息。
      rejectStream(stream)
      return
    }
    let parsed: { path?: unknown; method?: unknown; body?: unknown; rid?: unknown }
    try { parsed = JSON.parse(new TextDecoder().decode(reqBytes)) }
    catch { return }
    if (typeof parsed.path !== 'string') return
    const rid = typeof parsed.rid === 'string' ? parsed.rid : ''

    // Synthesize the request against a loopback origin; handleRequest only
    // reads pathname/searchParams/method/body. The device token is NEVER on
    // the wire — the daemon injects the AUTHENTICATED device's token (st.device,
    // proven by the HKDF trial-decrypt above) into the ?d= query so
    // routeRequest's auth passes exactly as on the LAN path.
    const method = typeof parsed.method === 'string' ? parsed.method : 'GET'
    const init: RequestInit = { method }
    if (typeof parsed.body === 'string' && method !== 'GET' && method !== 'HEAD') {
      init.body = parsed.body
      init.headers = { 'content-type': 'application/json' }
    }
    // 路径来自手机 —— 已认证但仍是不可信输入。必须以 / 开头,否则 new URL 会把
    // 它拼进 authority(host 被污染 → 误路由到别的 pathname);畸形路径(如裸 %、
    // 带空格)还会让 new URL 直接抛 —— 而 onStreamFrame 是 void 调用,抛出即变成
    // 未捕获的 promise rejection。两种都干净丢弃,不路由、不 reject。
    // tunnelRequestUrl also marks tunnel-origin (_via=tunnel) so mutating/dangerous ops can refuse over remote.
    const synthUrl = tunnelRequestUrl(parsed.path, st.device)
    if (typeof synthUrl === 'string') { log('TUNNEL', `${synthUrl} path on ${stream} — dropped`); return }
    let res: Response
    try { res = await deps.handleRequest(new Request(synthUrl.toString(), init)) }
    catch (e) { log('TUNNEL', `handleRequest threw on ${stream}: ${String(e)}`); return }

    const bodyText = await res.text()
    const replyBytes = new TextEncoder().encode(JSON.stringify({
      rid,
      status: res.status,
      body: bodyText,
    }))
    if (st.key) sendToStream(stream, await sealFrame(st.key, replyBytes))
  }

  /** Token list the tunnel accepts right now: paired devices + the active /set link token. */
  function candidateTokens(): string[] {
    const link = deps.activeLinkToken?.() ?? null
    return link ? [...deps.knownDeviceTokens(), link] : deps.knownDeviceTokens()
  }

  async function onV2Frame(stream: string, st: StreamState, frame: unknown): Promise<void> {
    if (st.v2s) { await st.v2s.onFrame(frame); return }
    // First sealed frame: identify the device by which token's channel opens it.
    const hit = identifyV2(new Uint8Array(st.bits), candidateTokens(), frame)
    if (!hit) {
      log('TUNNEL', `frame auth failed on ${stream} (no paired device / expired link / MITM) — dropped`)
      rejectStream(stream)
      return
    }
    const token = hit.token
    st.device = token
    st.v2s = makeV2Stream({
      stream, channel: hit.channel, token,
      send: (f) => { if (streams.get(stream) === st) sendToStream(stream, f) },
      handleRequest: deps.handleRequest,
      events: deps.events,
      tokenValid: () => deps.knownDeviceTokens().includes(token) || (deps.activeLinkToken?.() ?? null) === token,
      onRevoked: () => {
        if (streams.get(stream) !== st) return
        streams.delete(stream)
        rejectStream(stream)
      },
      log,
    })
    await st.v2s.onPlaintext(hit.plaintext)
  }

  function open(): void {
    if (stopped) return
    loggedIn = false
    ws = deps.login
      ? connect(relayUrl, [RELAY_SUBPROTOCOL, relayIdProtocol(deps.daemonId)])
      : connect(`${relayUrl}?id=${encodeURIComponent(deps.daemonId)}`, undefined)
    // 连上后的总账:摘要日志 + 退避清零。v2 模式中继在 open 之后才可能拒绝(login_failed 4001 /
    // rate_limited 4008 / replaced 4000),所以 v2 只在 login_ok 时清零,否则被拒会永远 2s 重连成风暴。
    function markConnected(): void {
      if (reconnectAttempts > 0) {
        // 从一段断连中恢复 —— 一条摘要代替刷屏(N 次尝试 / 下线 Xs)。
        log('TUNNEL', `reconnected to relay after ${reconnectAttempts} attempt(s), down ${Math.round((now() - downSince) / 1000)}s`)
      } else {
        log('TUNNEL', `connected to relay as ${deps.daemonId}`)
      }
      reconnectAttempts = 0
    }
    ws.addEventListener('open', () => {
      if (!deps.login) markConnected()
      if (ws) startHeartbeat(ws)
    })
    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
      let msg: { stream?: unknown; frame?: unknown; closed?: unknown; pong?: unknown; ping?: unknown }
      try { msg = JSON.parse(raw) } catch { return }
      // 收到任何 relay 帧都证明连接活着 —— 清掉待 pong,别在活跃会话里(pong
      // 被代理拖慢、但数据帧在流)误杀健康连接。ping/pong 只是空闲时的兜底。
      awaitingPong = false
      if (msg.pong !== undefined) return   // 纯心跳回执,不是数据帧
      if (deps.login && typeof (msg as { challenge?: unknown }).challenge === 'string') {
        try { ws?.send(JSON.stringify(deps.login.sign((msg as { challenge: string }).challenge))) } catch { /* close 会接手 */ }
        return
      }
      if ((msg as { login_ok?: unknown }).login_ok === true) {
        loggedIn = true
        markConnected()
        log('TUNNEL', 'relay v2 login ok')
        try { deps.onLogin?.() } catch (e) { log('TUNNEL', `onLogin threw: ${String(e)}`) }
        return
      }
      if (typeof msg.stream !== 'string') {
        const m = msg as Record<string, unknown>
        if (typeof m.error === 'string') log('TUNNEL', `relay error ${m.error}`)
        if (m.push_result !== undefined || m.push_invalid !== undefined || typeof m.error === 'string') {
          try { deps.onControl?.(m) } catch (e) { log('TUNNEL', `onControl threw: ${String(e)}`) }
        }
        return
      }
      if (msg.closed === true) { forgetStream(msg.stream); return }   // relay 通知手机断开 — 释放该 stream 的密钥条目与订阅
      const stream = msg.stream, frame = msg.frame
      // Handshakes, v2 streams, and anything queued behind a pending handshake go
      // through the per-stream chain; an established v1 stream stays fully concurrent.
      if (handshakePlaintext(frame) || streams.get(stream)?.v2 || chains.has(stream)) enqueue(stream, () => onStreamFrame(stream, frame))
      else void onStreamFrame(stream, frame)
    })
    ws.addEventListener('close', () => {
      stopHeartbeat()
      for (const st of streams.values()) st.v2s?.close()
      streams.clear()
      chains.clear()
      loggedIn = false
      ws = null
      if (stopped) return
      // 指数退避:min·2^n,封顶 max。只在首次断开记一条,后续静默重试
      // (避免网络抖动时每 15s 刷一行)—— 恢复时 markConnected 的摘要报清总账
      // (老中继在 open 时,v2 在 login_ok 时)。
      if (reconnectAttempts === 0) { downSince = now(); log('TUNNEL', 'relay socket closed — reconnecting…') }
      const delay = Math.min(maxReconnectMs, minReconnectMs * 2 ** reconnectAttempts)
      reconnectAttempts++
      reconnectTimer = setTimeout(open, delay)
    })
    ws.addEventListener('error', () => { try { ws?.close() } catch { /* noop */ } })
  }

  return {
    start() { stopped = false; open() },
    sendControl(msg) {
      if (!ws || (deps.login && !loggedIn)) return false
      try { ws.send(JSON.stringify(msg)); return true } catch { return false }
    },
    subscribedDeviceTokens() {
      const out = new Set<string>()
      for (const st of streams.values()) if (st.device && st.v2s && st.v2s.subscriptionCount() > 0) out.add(st.device)
      return out
    },
    stop() {
      stopped = true
      stopHeartbeat()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      for (const st of streams.values()) st.v2s?.close()
      streams.clear()
      try { ws?.close() } catch { /* noop */ }
      ws = null
    },
  }
}
