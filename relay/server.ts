/**
 * server.ts — the content-blind mailbox relay (standalone Bun entry, deploy to
 * a VPS; NOT part of the wechat-cc daemon). Three routes: /drop (open — the
 * address is the capability — rate-limited + size/depth/TTL-capped), /fetch and
 * /ack (Ed25519-signed ownership proof). The relay stores `envelope` as an
 * opaque string and NEVER parses it. See spec §3.1.
 */
import { Database } from 'bun:sqlite'
import { makeMailboxStore } from './mailbox-store'
import { verifyFetchSig, verifyAckSig } from './mailbox-auth'
import { makeRateLimiter } from './rate-limit'

export interface RelayServer { fetchHandler(req: Request, ip: string): Promise<Response>; sweep(now: number): number }

const DEFAULT_MAX_ENVELOPE = 16 * 1024
const DEFAULT_PAGE = 64
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function makeRelayServer(opts: {
  db: Database
  now?: () => number
  maxEnvelopeBytes?: number
  fetchPageLimit?: number
  rate?: { capacity: number; refillPerSec: number }
}): RelayServer {
  const store = makeMailboxStore(opts.db)
  const now = opts.now ?? (() => Date.now())
  const maxEnvelope = opts.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE
  const page = opts.fetchPageLimit ?? DEFAULT_PAGE
  const rl = makeRateLimiter(opts.rate ?? { capacity: 60, refillPerSec: 1 })

  async function body(req: Request): Promise<any | null> { try { return await req.json() } catch { return null } }

  return {
    sweep(t) { return store.sweep(t) },
    async fetchHandler(req, ip) {
      const url = new URL(req.url)
      const t = now()
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

      if (url.pathname === '/drop') {
        const b = await body(req)
        if (!b || typeof b.to !== 'string' || !b.to || typeof b.envelope !== 'string' || !b.envelope) return json({ error: 'invalid_body' }, 400)
        if (Buffer.byteLength(b.envelope, 'utf8') > maxEnvelope) return json({ error: 'too_large' }, 400)
        if (!rl.allow(`ip:${ip}`, t) || !rl.allow(`to:${b.to}`, t)) return json({ error: 'rate_limited' }, 429)
        store.drop(b.to, b.envelope, t)   // opaque — never parsed
        return json({ ok: true })
      }
      if (url.pathname === '/fetch') {
        const b = await body(req)
        if (!b || typeof b.mailbox !== 'string' || typeof b.since !== 'number' || typeof b.ts !== 'number' || typeof b.sig !== 'string') return json({ error: 'invalid_body' }, 400)
        if (!verifyFetchSig(b.mailbox, b.ts, b.sig, t)) return json({ error: 'unauthorized' }, 401)
        return json(store.fetchSince(b.mailbox, b.since, t, page))
      }
      if (url.pathname === '/ack') {
        const b = await body(req)
        if (!b || typeof b.mailbox !== 'string' || typeof b.up_to_cursor !== 'number' || typeof b.ts !== 'number' || typeof b.sig !== 'string') return json({ error: 'invalid_body' }, 400)
        if (!verifyAckSig(b.mailbox, b.up_to_cursor, b.ts, b.sig, t)) return json({ error: 'unauthorized' }, 401)
        store.ackUpTo(b.mailbox, b.up_to_cursor)
        return json({ ok: true })
      }
      return new Response('not found', { status: 404 })
    },
  }
}

/** Bun.serve entry — used by the VPS runbook (Task 13), not by vitest. */
export function startRelay(opts: { port?: number; dbPath?: string } = {}): { stop(): void; port: number } {
  const db = new Database(opts.dbPath ?? 'mailbox.sqlite')
  db.run('PRAGMA journal_mode = WAL')
  const relay = makeRelayServer({ db })
  const server = Bun.serve({
    port: opts.port ?? 8787,
    fetch(req, srv) {
      const ip = srv.requestIP(req)?.address ?? 'unknown'
      return relay.fetchHandler(req, ip)
    },
  })
  const sweepTimer = setInterval(() => relay.sweep(Date.now()), 60 * 60_000)   // hourly TTL sweep
  return { stop() { clearInterval(sweepTimer); server.stop() }, port: server.port ?? opts.port ?? 8787 }
}

if (import.meta.main) {
  const { port } = startRelay({ port: Number(process.env.RELAY_PORT ?? 8787), dbPath: process.env.RELAY_DB ?? 'mailbox.sqlite' })
  console.log(`[relay] listening on :${port}`)
}
