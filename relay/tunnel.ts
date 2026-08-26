/**
 * tunnel.ts — content-blind WebSocket relay for 随身 CC 的远程访问
 * (2026-08-26). Runs on the SAME VPS as the mailbox relay, alongside it.
 *
 * Topology: a daemon holds ONE outbound WS to the relay (`/tunnel/daemon`,
 * NAT-piercing — the daemon dials out). A phone opens a WS to
 * `/tunnel/phone?id=<daemon-id>`; the hub pairs them by daemon id and forwards
 * OPAQUE sealed frames both ways, tagging each with a per-phone stream id so
 * one daemon can serve several phones. The relay NEVER decrypts — every frame
 * is a `{iv,ct}` blob sealed by tunnel-crypto (the phone/daemon shared X25519
 * key the relay doesn't have). Same content-blind posture as the mailbox
 * relay next door.
 *
 * Auth is deliberately thin at THIS layer: the daemon id is a capability-style
 * opaque token (the phone learned it during in-home pairing), and real
 * confidentiality/authenticity is the E2E seal, not the relay. The hub only
 * enforces routing + rate limits + size caps.
 */
import { makeRateLimiter, type RateLimiter } from './rate-limit'

export interface TunnelSocket {
  send(data: string): void
  close(): void
  readyState: number
}

interface PhoneEntry { ws: TunnelSocket; daemonId: string }

const DEFAULT_MAX_FRAME = 512 * 1024   // sealed frames carry JSON API bodies + occasional small images

export interface TunnelHub {
  registerDaemon(id: string, ws: TunnelSocket): void
  dropDaemon(id: string): void
  attachPhone(daemonId: string, ws: TunnelSocket): { ok: boolean; streamId?: string; error?: string }
  dropPhone(streamId: string): void
  onPhoneFrame(streamId: string, raw: string): void
  onDaemonFrame(daemonId: string, raw: string): void
}

let streamCounter = 0

export function makeTunnelHub(opts: {
  rate?: { capacity: number; refillPerSec: number }
  maxFrameBytes?: number
  now?: () => number
} = {}): TunnelHub {
  const daemons = new Map<string, TunnelSocket>()
  const phones = new Map<string, PhoneEntry>()          // streamId → phone
  const daemonPhones = new Map<string, Set<string>>()   // daemonId → streamIds
  const rl: RateLimiter = makeRateLimiter(opts.rate ?? { capacity: 120, refillPerSec: 20 })
  const maxFrame = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME
  const now = opts.now ?? (() => Date.now())

  function freePhone(streamId: string): void {
    const p = phones.get(streamId)
    if (!p) return
    phones.delete(streamId)
    daemonPhones.get(p.daemonId)?.delete(streamId)
    rl.drop(`stream:${streamId}`)   // free the rate-limit bucket too
  }

  return {
    registerDaemon(id, ws) {
      // A reconnecting daemon replaces its old socket; existing phones keep
      // their stream ids and transparently ride the new socket.
      daemons.set(id, ws)
      if (!daemonPhones.has(id)) daemonPhones.set(id, new Set())
    },

    dropDaemon(id) {
      daemons.delete(id)
      const streams = daemonPhones.get(id)
      if (streams) {
        for (const sid of streams) {
          try { phones.get(sid)?.ws.close() } catch { /* best effort */ }
          phones.delete(sid)
          rl.drop(`stream:${sid}`)
        }
        daemonPhones.delete(id)
      }
    },

    attachPhone(daemonId, ws) {
      if (!daemons.has(daemonId)) return { ok: false, error: 'daemon_offline' }
      const streamId = `s${now().toString(36)}${(streamCounter++).toString(36)}`
      phones.set(streamId, { ws, daemonId })
      daemonPhones.get(daemonId)!.add(streamId)
      return { ok: true, streamId }
    },

    dropPhone(streamId) {
      freePhone(streamId)
    },

    onPhoneFrame(streamId, raw) {
      const p = phones.get(streamId)
      if (!p) return
      if (Buffer.byteLength(raw, 'utf8') > maxFrame) return
      if (!rl.allow(`stream:${streamId}`, now())) return
      const daemon = daemons.get(p.daemonId)
      if (!daemon || daemon.readyState !== 1) return
      let frame: unknown
      try { frame = JSON.parse(raw) } catch { return }   // must be a JSON envelope, contents opaque
      daemon.send(JSON.stringify({ stream: streamId, frame }))
    },

    onDaemonFrame(daemonId, raw) {
      if (Buffer.byteLength(raw, 'utf8') > maxFrame) return
      let msg: { stream?: unknown; frame?: unknown }
      try { msg = JSON.parse(raw) } catch { return }
      if (typeof msg.stream !== 'string') return
      const p = phones.get(msg.stream)
      if (!p || p.daemonId !== daemonId || p.ws.readyState !== 1) return   // unknown/foreign stream — drop
      p.ws.send(JSON.stringify(msg.frame ?? {}))
    },
  }
}
