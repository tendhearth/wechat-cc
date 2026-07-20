/**
 * pairing.ts — the 配对码 engine (spec §4–§6). Deps-injected: no direct network,
 * clock, or scheduler, so it unit-tests against a fake relay + registry.
 *
 * start()  — initiator: mint a code + keyI, derive the rendezvous identity, seal
 *            its own card and drop it into the shared rendezvous box, then arm a
 *            bounded ~10s poller (≤10 min) waiting for the acceptor's card.
 * accept() — acceptor: derive the same identity, fetch the box, find the
 *            initiator card, reject self-pair, write the peer record, drop its
 *            own card back.
 * writePeerFromCard — shared: overwrite-by-self_id, bearer crossing (spec §5):
 *            outbound_api_key = card.bearer, inbound_api_key = the key WE minted.
 *
 * NO ack (shared box; ack is a global delete — §4). Cards carry role + nonce so
 * each side ignores its own. Only one active initiator code at a time (a new
 * start() supersedes). Not restart-persistent (§8).
 */
import { deriveRendezvous } from './pairing-crypto'
import { sealEnvelope, openEnvelope, signFetch, type Envelope } from './mailbox-crypto'
import type { MailboxClient } from './mailbox-client'
import type { A2ARegistry } from './a2a-registry'
import type { A2AAgentRecord } from '../lib/agent-config'

export interface PairCard {
  v: 1
  role: 'initiator' | 'acceptor'
  nonce: string
  self_id: string
  name: string
  url?: string
  mailbox_addr: string
  mailbox_enc_pub: string
  relays: string[]
  bearer: string
}

export type PairResult =
  | { ok: true; peer: { self_id: string; name: string } }
  | { ok: false; reason: 'expired_or_wrong' | 'self_pair' | 'id_conflict' | 'relay_drop_failed' }

// start() can now fail too (the initiator card drop is awaited + checked —
// see makePairing's start()). Uses the same {ok, reason} shape as PairResult
// for consistency rather than a bespoke {ok:false, error} pair.
export type PairStartResult =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; reason: 'relay_drop_failed' }

export interface PairScheduleHandle { cancel(): void }

export interface PairingDeps {
  client: MailboxClient
  registry: A2ARegistry
  self: { mailbox_addr: string; mailbox_enc_pub: string; relays: string[] }
  selfId: () => string
  name: () => string
  url?: () => string | undefined
  now: () => number
  mintKey: () => string
  genCode: () => string
  genNonce: () => string
  /** notify is for ASYNC outcomes only (the initiator's background poller —
   *  TTL expiry, a peer card showing up mid-poll): there is no caller waiting
   *  on those. Every SYNCHRONOUS start()/accept() result is rendered by the
   *  caller instead (WeChat dispatch / internal-api / CLI) — calling notify
   *  there too double-messages the owner, since notify targets
   *  resolveOperatorChatId(), which in a solo-owner install is the SAME chat
   *  the caller is about to reply to directly. */
  notify: (msg: string) => void
  schedule: (fn: () => void, ms: number) => PairScheduleHandle
  pollIntervalMs?: number
  ttlMs?: number
  log?: (msg: string) => void
}

export interface PairingEngine {
  start(): Promise<PairStartResult>
  accept(code: string): Promise<PairResult>
  stop(): void
}

interface ActiveInitiator {
  code: string
  nonce: string
  myKey: string
  expiresAt: number
  rvAddr: string
  rvEncPriv: string
  rvSign: (m: string) => string
  handle: PairScheduleHandle | null
}

export function makePairing(deps: PairingDeps): PairingEngine {
  // Fail fast at construction, not with a silent `relays[0]!` non-null
  // assertion that would only blow up (as `undefined` in a URL string) the
  // first time start()/accept() actually tries to reach the relay.
  if (deps.self.relays.length === 0) {
    throw new Error('makePairing: deps.self.relays must be non-empty (relays[0] is the rendezvous relay)')
  }
  const pollIntervalMs = deps.pollIntervalMs ?? 10_000
  const ttlMs = deps.ttlMs ?? 600_000
  const rendezvousRelay = deps.self.relays[0]!
  let active: ActiveInitiator | null = null

  function ownCard(role: PairCard['role'], nonce: string, bearer: string): PairCard {
    const u = deps.url?.()
    return {
      v: 1, role, nonce,
      self_id: deps.selfId(), name: deps.name(),
      ...(u ? { url: u } : {}),
      mailbox_addr: deps.self.mailbox_addr,
      mailbox_enc_pub: deps.self.mailbox_enc_pub,
      relays: deps.self.relays,
      bearer,
    }
  }

  // spec §5/§6: outbound_api_key = card.bearer (peer's key for us), inbound_api_key
  // = the key WE minted (peer stores it as THEIR outbound). Overwrite-by-self_id,
  // but ONLY on a true re-pair (same self_id AND same mailbox_addr). A same-id +
  // different/absent mailbox_addr is an UNRELATED peer colliding on a legacy
  // shared 'wechat-cc' id (grandfather rule, spec §2) — overwriting would clobber
  // it, so reject the pairing instead (id_conflict).
  // Peek-only version of the id_conflict check writePeerFromCard applies, so
  // callers that need to decide something ELSE (e.g. accept()'s drop-first
  // ordering below) before committing a write can bail out with zero side
  // effects — no registry write, no card drop.
  function conflicts(card: PairCard): boolean {
    const existing = deps.registry.get(card.self_id)
    return !!existing && existing.mailbox_addr !== card.mailbox_addr
  }

  function writePeerFromCard(card: PairCard, myMintedKey: string): { ok: true } | { ok: false; reason: 'id_conflict' } {
    const existing = deps.registry.get(card.self_id)
    if (existing && existing.mailbox_addr !== card.mailbox_addr) return { ok: false, reason: 'id_conflict' }
    const rec: A2AAgentRecord = {
      id: card.self_id,
      name: card.name,
      ...(card.url ? { url: card.url } : {}),
      inbound_api_key: myMintedKey,
      outbound_api_key: card.bearer,
      capabilities: [],
      paused: false,
      transport: 'mailbox',
      mailbox_addr: card.mailbox_addr,
      mailbox_enc_pub: card.mailbox_enc_pub,
      relays: card.relays,
    }
    if (existing) deps.registry.remove(rec.id) // full overwrite of the true re-pair (§6)
    deps.registry.add(rec)
    return { ok: true }
  }

  const ID_CONFLICT_MSG = '对方 bot 使用旧版共享身份且与你已有的朋友撞名——请让对方升级出唯一身份后重试'

  // Cards come back in cursor-ASCENDING order (relay returns items ascending; no
  // ack/deletion during pairing), so callers' `.find(...)` = FIRST-dropper-wins
  // (spec §4). Note: a single /fetch returns ≤64 items (no client pagination) —
  // a code-holder could bury the card past item 64; accepted for v0 (same threat
  // class as §3's "third party who has the code").
  function readCards(rvAddr: string, rvEncPriv: string, rvSign: (m: string) => string): Promise<PairCard[]> {
    const ts = deps.now()
    return deps.client.fetch(rendezvousRelay, rvAddr, 0, ts, signFetch(rvSign, rvAddr, ts)).then(res => {
      if (!res) return []
      const cards: PairCard[] = []
      for (const item of res.items) {
        let env: Envelope
        try { env = JSON.parse(item.envelope) as Envelope } catch { continue }
        const inner = openEnvelope(rvEncPriv, env)
        if (!inner) continue
        const card = inner.body as PairCard
        if (card && card.v === 1 && (card.role === 'initiator' || card.role === 'acceptor')) cards.push(card)
      }
      return cards
    })
  }

  function stop(): void {
    if (active?.handle) active.handle.cancel()
    active = null
  }

  async function start(): Promise<PairStartResult> {
    stop() // supersede any prior active code (§8: one at a time)
    const code = deps.genCode()
    const rv = deriveRendezvous(code)
    const myKey = deps.mintKey()
    const nonce = deps.genNonce()
    const expiresAt = deps.now() + ttlMs

    // Await + check the initiator card drop BEFORE arming the poller or
    // handing back a code. `MailboxClient.drop` resolves `false` (not a
    // throw) on any non-2xx — the original fire-and-forget `.catch()` only
    // handled rejections, so a `false` resolution was silently swallowed: the
    // code would be handed to the friend, the poller would arm and dutifully
    // poll for 10 minutes, and the acceptor's `accept()` would find nothing
    // and report `expired_or_wrong` with zero diagnostics on either side. A
    // code whose card never reached the relay can never be redeemed — fail
    // loudly here instead.
    const env = sealEnvelope({ path: '/pair', bearer: '', body: ownCard('initiator', nonce, myKey) }, rv.enc_pub)
    let dropped: boolean
    try {
      dropped = await deps.client.drop(rendezvousRelay, rv.addr, JSON.stringify(env))
    } catch (e) {
      deps.log?.(`pair drop failed: ${String(e)}`)
      dropped = false
    }
    if (!dropped) {
      // Sync failure — the caller (WeChat dispatch / internal-api / CLI)
      // renders its own reply; see the notify dep's doc comment.
      return { ok: false, reason: 'relay_drop_failed' }
    }

    const cur: ActiveInitiator = { code, nonce, myKey, expiresAt, rvAddr: rv.addr, rvEncPriv: rv.enc_priv, rvSign: rv.sign, handle: null }
    active = cur

    const tick = (): void => {
      if (active !== cur) return // superseded
      if (deps.now() >= cur.expiresAt) {
        stop()
        deps.notify('配对码过期了,没等到朋友——要再来一次说“配对”')
        return
      }
      void readCards(cur.rvAddr, cur.rvEncPriv, cur.rvSign).then(cards => {
        if (active !== cur) return
        // Minor a: exclude our own card by self_id too (symmetry with accept's
        // self-pair reject), not just by nonce.
        const peer = cards.find(c => c.role === 'acceptor' && c.nonce !== cur.nonce && c.self_id !== deps.selfId())
        if (peer) {
          const write = writePeerFromCard(peer, cur.myKey)
          stop()
          deps.notify(write.ok ? `和 ${peer.name} 的 bot 连上了 ✓ 现在可以互相觅食/写信了` : ID_CONFLICT_MSG)
          return
        }
        cur.handle = deps.schedule(tick, pollIntervalMs)
      }).catch(e => {
        deps.log?.(`pair poll failed: ${String(e)}`)
        if (active === cur) cur.handle = deps.schedule(tick, pollIntervalMs)
      })
    }
    cur.handle = deps.schedule(tick, pollIntervalMs)
    return { ok: true, code, expiresAt }
  }

  async function accept(code: string): Promise<PairResult> {
    const rv = deriveRendezvous(code)
    const cards = await readCards(rv.addr, rv.enc_priv, rv.sign)
    const initiator = cards.find(c => c.role === 'initiator')
    if (!initiator) return { ok: false, reason: 'expired_or_wrong' }
    if (initiator.self_id === deps.selfId()) return { ok: false, reason: 'self_pair' }

    // id_conflict is checked (peek-only, zero side effects) BEFORE attempting
    // anything else, so a same-id/different-mailbox collision still means
    // NO card drop and NO write — preserved from before this fix. Sync
    // failure — the caller renders its own reply (notify dep's doc comment).
    if (conflicts(initiator)) return { ok: false, reason: 'id_conflict' }

    const myKey = deps.mintKey()

    // Drop-first, THEN write locally. `MailboxClient.drop` resolves `false`
    // (not a throw) on any non-2xx — previously this awaited call's result
    // was discarded entirely, so a failed drop still wrote the peer locally
    // and told the acceptor's own operator "connected ✓" while the initiator
    // silently timed out with "过期了" (one-sided broken pairing, zero
    // diagnostics on either side). Dropping first means a failed drop leaves
    // NO local state to unwind — the acceptor can just retry cleanly, no
    // rollback path needed. (Writing first and rolling back on drop failure
    // would need an explicit registry.remove() undo and risks a
    // half-committed peer if THAT itself fails.)
    const env = sealEnvelope({ path: '/pair', bearer: '', body: ownCard('acceptor', deps.genNonce(), myKey) }, rv.enc_pub)
    let dropped: boolean
    try {
      dropped = await deps.client.drop(rendezvousRelay, rv.addr, JSON.stringify(env))
    } catch (e) {
      deps.log?.(`pair drop failed: ${String(e)}`)
      dropped = false
    }
    if (!dropped) {
      // Sync failure — the caller renders its own reply (notify dep's doc comment).
      return { ok: false, reason: 'relay_drop_failed' }
    }

    const write = writePeerFromCard(initiator, myKey)
    // defensive: re-checked at write time too. Sync failure — caller renders its own reply.
    if (!write.ok) return { ok: false, reason: 'id_conflict' }

    return { ok: true, peer: { self_id: initiator.self_id, name: initiator.name } }
  }

  return { start, accept, stop }
}
