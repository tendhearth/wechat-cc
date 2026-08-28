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
 * The relay never sees plaintext (tunnel.ts is content-blind); confidentiality
 * lives entirely here + on the phone. Device-token auth still applies: the
 * synthesized request carries the phone's `d=` token in its URL, so an
 * un-paired phone's requests 401 exactly as on the LAN.
 */
import { deriveSharedBits, hkdfAesKey, generateTunnelKeypair, exportPublicKeyB64, importPublicKeyB64, sealFrame, openFrame, type TunnelKeypair } from '../lib/tunnel-crypto'
import type { webcrypto } from 'node:crypto'

type CryptoKey = webcrypto.CryptoKey

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
  /** Opens the outbound WS. Default dials the relay via Bun's WebSocket. */
  connect?: (url: string) => TunnelWS
  relayUrl?: string
  reconnectMs?: number
  /** 心跳间隔(ms)。默认 20s。一轮 ping 没等到 pong 就判连接已死、强制重连。 */
  pingIntervalMs?: number
  /** Injected clock (tests). Backoff/down-time accounting only. */
  now?: () => number
  log?: (tag: string, line: string) => void
}

/** Read a plaintext handshake control frame → the peer's pubkey b64, or null. */
export function handshakePlaintext(frame: unknown): string | null {
  if (frame && typeof frame === 'object' && typeof (frame as { hs?: unknown }).hs === 'string') {
    return (frame as { hs: string }).hs
  }
  return null
}

export interface TunnelClient { start(): void; stop(): void }

export function makeTunnelClient(deps: TunnelClientDeps): TunnelClient {
  const relayUrl = deps.relayUrl ?? 'wss://cc.tendhearth.com/tunnel/daemon'
  // 指数退避重连(2026-08-27 日志:网络抖动时固定 15s 重连,恢复慢 + 日志
  // 刷屏)。首次断开 2s 重试(瞬时抖动秒回),连败翻倍到 reconnectMs 上限。
  const maxReconnectMs = deps.reconnectMs ?? 15_000
  const minReconnectMs = 2_000
  const log = deps.log ?? (() => {})
  let reconnectAttempts = 0     // 连续失败计数(open 成功清零)
  let downSince = 0             // 首次断开时刻(重连成功时算下线时长)
  let now = deps.now ?? (() => Date.now())
  // Per-stream ephemeral state: our keypair, the raw ECDH bits, and — once the
  // first frame identifies the device — the token-bound key + that device token.
  const streams = new Map<string, { kp: TunnelKeypair; bits: ArrayBuffer; key?: CryptoKey; device?: string }>()
  let ws: TunnelWS | null = null
  let stopped = false
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
      try { sock.send(JSON.stringify({ ping: now() })) } catch { /* onclose 会接手 */ }
    }, PING_INTERVAL_MS)
    if (typeof (pingTimer as unknown as { unref?: () => void }).unref === 'function') (pingTimer as unknown as { unref: () => void }).unref()
  }

  const defaultConnect = (url: string): TunnelWS => new (globalThis as unknown as { WebSocket: new (u: string) => TunnelWS }).WebSocket(url)
  const connect = deps.connect ?? defaultConnect

  function sendToStream(stream: string, frame: unknown): void {
    ws?.send(JSON.stringify({ stream, frame }))
  }

  async function onStreamFrame(stream: string, frame: unknown): Promise<void> {
    const hsPub = handshakePlaintext(frame)
    if (hsPub) {
      // New stream (or re-handshake): fresh ephemeral keypair, compute raw ECDH
      // bits, reply with our pubkey. The FINAL key isn't derivable yet — it's
      // HKDF-bound to the device token, which we learn by trial-decrypting the
      // first sealed frame below.
      const kp = await generateTunnelKeypair()
      let bits: ArrayBuffer
      try { bits = await deriveSharedBits(kp.privateKey, await importPublicKeyB64(hsPub)) }
      catch { log('TUNNEL', `bad handshake pubkey on ${stream}`); return }
      streams.set(stream, { kp, bits })
      sendToStream(stream, { hs: await exportPublicKeyB64(kp.publicKey) })
      return
    }
    // Sealed request — resolve/verify the device on the FIRST frame by finding
    // the paired token whose HKDF(bits, token) key decrypts it. A MITM relay
    // knows no token, so no candidate authenticates → dropped.
    const st = streams.get(stream)
    if (!st) { log('TUNNEL', `sealed frame before handshake on ${stream} — dropped`); return }
    let reqBytes: Uint8Array | null = null
    if (st.key) {
      try { reqBytes = await openFrame(st.key, frame as { iv: string; ct: string }) } catch { reqBytes = null }
    } else {
      for (const tok of deps.knownDeviceTokens()) {
        try {
          const cand = await hkdfAesKey(st.bits, new TextEncoder().encode(tok))
          const opened = await openFrame(cand, frame as { iv: string; ct: string })
          st.key = cand; st.device = tok; reqBytes = opened; break
        } catch { /* not this token */ }
      }
    }
    if (!reqBytes) { log('TUNNEL', `frame auth failed on ${stream} (no paired device / MITM) — dropped`); return }
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
    if (!parsed.path.startsWith('/')) { log('TUNNEL', `non-absolute path on ${stream} — dropped`); return }
    let synthUrl: URL
    try { synthUrl = new URL(`http://127.0.0.1${parsed.path}`) }
    catch { log('TUNNEL', `unparseable path on ${stream} — dropped`); return }
    synthUrl.searchParams.delete('d'); synthUrl.searchParams.delete('t')
    if (st.device) synthUrl.searchParams.set('d', st.device)
    // Mark tunnel-origin so mutating/dangerous ops can refuse over remote.
    synthUrl.searchParams.set('_via', 'tunnel')
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

  function open(): void {
    if (stopped) return
    const url = `${relayUrl}?id=${encodeURIComponent(deps.daemonId)}`
    ws = connect(url)
    ws.addEventListener('open', () => {
      if (reconnectAttempts > 0) {
        // 从一段断连中恢复 —— 一条摘要代替刷屏(N 次尝试 / 下线 Xs)。
        log('TUNNEL', `reconnected to relay after ${reconnectAttempts} attempt(s), down ${Math.round((now() - downSince) / 1000)}s`)
      } else {
        log('TUNNEL', `connected to relay as ${deps.daemonId}`)
      }
      reconnectAttempts = 0
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
      if (typeof msg.stream !== 'string') return
      if (msg.closed === true) { streams.delete(msg.stream); return }   // relay 通知手机断开 — 释放该 stream 的密钥条目
      void onStreamFrame(msg.stream, msg.frame)
    })
    ws.addEventListener('close', () => {
      stopHeartbeat()
      streams.clear()
      ws = null
      if (stopped) return
      // 指数退避:min·2^n,封顶 max。只在首次断开记一条,后续静默重试
      // (避免网络抖动时每 15s 刷一行)—— 恢复时的 open 摘要报清总账。
      if (reconnectAttempts === 0) { downSince = now(); log('TUNNEL', 'relay socket closed — reconnecting…') }
      const delay = Math.min(maxReconnectMs, minReconnectMs * 2 ** reconnectAttempts)
      reconnectAttempts++
      reconnectTimer = setTimeout(open, delay)
    })
    ws.addEventListener('error', () => { try { ws?.close() } catch { /* noop */ } })
  }

  return {
    start() { stopped = false; open() },
    stop() {
      stopped = true
      stopHeartbeat()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { ws?.close() } catch { /* noop */ }
      ws = null
    },
  }
}
