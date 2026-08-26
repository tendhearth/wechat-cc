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
import { deriveSharedKey, generateTunnelKeypair, exportPublicKeyB64, importPublicKeyB64, sealFrame, openFrame, type TunnelKeypair } from '../lib/tunnel-crypto'
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
  // Per-stream ephemeral state: our keypair + derived shared key (once handshaken).
  const streams = new Map<string, { kp: TunnelKeypair; key?: CryptoKey }>()
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
      // New stream (or a re-handshake): fresh ephemeral keypair, derive, reply.
      const kp = await generateTunnelKeypair()
      let key: CryptoKey
      try { key = await deriveSharedKey(kp.privateKey, await importPublicKeyB64(hsPub)) }
      catch { log('TUNNEL', `bad handshake pubkey on ${stream}`); return }
      streams.set(stream, { kp, key })
      sendToStream(stream, { hs: await exportPublicKeyB64(kp.publicKey) })
      return
    }
    // Sealed request — needs an established key for this stream.
    const st = streams.get(stream)
    if (!st?.key) { log('TUNNEL', `sealed frame before handshake on ${stream} — dropped`); return }
    let reqBytes: Uint8Array
    try { reqBytes = await openFrame(st.key, frame as { iv: string; ct: string }) }
    catch { log('TUNNEL', `frame open failed on ${stream}`); return }
    let parsed: { path?: unknown; method?: unknown; body?: unknown; rid?: unknown }
    try { parsed = JSON.parse(new TextDecoder().decode(reqBytes)) }
    catch { return }
    if (typeof parsed.path !== 'string') return
    const rid = typeof parsed.rid === 'string' ? parsed.rid : ''

    // Synthesize the request against a loopback origin; handleRequest only
    // reads pathname/searchParams/method/body. The device token rides in the
    // path's own query (?d=…), so auth is identical to the LAN path.
    const method = typeof parsed.method === 'string' ? parsed.method : 'GET'
    const init: RequestInit = { method }
    if (typeof parsed.body === 'string' && method !== 'GET' && method !== 'HEAD') {
      init.body = parsed.body
      init.headers = { 'content-type': 'application/json' }
    }
    let res: Response
    try { res = await deps.handleRequest(new Request(`http://127.0.0.1${parsed.path}`, init)) }
    catch (e) { log('TUNNEL', `handleRequest threw on ${stream}: ${String(e)}`); return }

    const bodyText = await res.text()
    const replyBytes = new TextEncoder().encode(JSON.stringify({
      rid,
      status: res.status,
      body: bodyText,
    }))
    sendToStream(stream, await sealFrame(st.key, replyBytes))
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
