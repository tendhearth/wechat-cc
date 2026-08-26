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
  const relayUrl = deps.relayUrl ?? 'wss://brain.youdamaster.cc/tunnel/daemon'
  const reconnectMs = deps.reconnectMs ?? 15_000
  const log = deps.log ?? (() => {})
  // Per-stream ephemeral state: our keypair, the raw ECDH bits, and — once the
  // first frame identifies the device — the token-bound key + that device token.
  const streams = new Map<string, { kp: TunnelKeypair; bits: ArrayBuffer; key?: CryptoKey; device?: string }>()
  let ws: TunnelWS | null = null
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

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
    const synthUrl = new URL(`http://127.0.0.1${parsed.path}`)
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
    ws.addEventListener('open', () => log('TUNNEL', `connected to relay as ${deps.daemonId}`))
    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
      let msg: { stream?: unknown; frame?: unknown }
      try { msg = JSON.parse(raw) } catch { return }
      if (typeof msg.stream !== 'string') return
      void onStreamFrame(msg.stream, msg.frame)
    })
    ws.addEventListener('close', () => {
      streams.clear()
      ws = null
      if (stopped) return
      log('TUNNEL', `relay socket closed — reconnecting in ${Math.round(reconnectMs / 1000)}s`)
      reconnectTimer = setTimeout(open, reconnectMs)
    })
    ws.addEventListener('error', () => { try { ws?.close() } catch { /* noop */ } })
  }

  return {
    start() { stopped = false; open() },
    stop() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { ws?.close() } catch { /* noop */ }
      ws = null
    },
  }
}
