import type { CheapEval } from './agent-provider'
import type { A2AAgentRecord } from '../lib/agent-config'
import { newIntentId, type IntentCard } from './a2a-intent'
import type { MatchReceipt } from './a2a-intent'
import { gateOutbound } from './a2a-disclosure'

export interface EchoRecord {
  intentId: string; peerAgentId: string | null; peerMasked: string; degree: number; content: string; first: boolean
  relayVia?: string; relayToken?: string
}

/** Minimal read-back shape the broker needs to resume/confirm a proposed row. */
export interface BrokerSeekRow {
  status: string
  redacted_topic: string | null
  redacted_city: string | null
}

export interface BrokerDeps {
  discover: (topic: string) => Promise<A2AAgentRecord[]>
  send: (hand: A2AAgentRecord, card: IntentCard) => Promise<MatchReceipt | null>
  policy: string
  cheapEval: CheapEval
  ttlMs?: number
  /** Sync leg (deprecated `seek()` bridge only): persist the wish as a `foraging` social_seek row. */
  sow: (intentId: string, topic: string) => void
  /** P4 propose leg: persist a `proposed` row carrying the owner-approved redacted wording. */
  proposeRow: (intentId: string, r: { topic: string; redactedTopic: string; redactedCity?: string }) => void
  /** Read a seek row back (for confirmSeek/cancelSeek). null when unknown. */
  readSeek: (intentId: string) => BrokerSeekRow | null
  /** Flip a seek row's status (proposed → foraging on confirm, → cancelled on cancel). */
  markStatus: (intentId: string, status: 'foraging' | 'cancelled') => void
  /** Background leg: persist one `match:'yes'` echo. `first` = the seek had 0 echoes. */
  recordEcho: (e: EchoRecord) => void
  /** Background leg completion: `echoed` (≥1 echo) or `closed` (0). */
  finishSeek: (intentId: string, status: 'echoed' | 'closed', peersAsked: number) => void
  /** Schedule the background coroutine off the caller's turn. Default: fire-and-forget. */
  schedule?: (fn: () => Promise<void>) => void
}
export interface SeekOutcome { intent_id: string }
export type ProposeOutcome =
  | { ok: true; intent_id: string; redacted: string; redacted_city?: string }
  | { ok: false; reason: string }
export type ConfirmOutcome =
  | { ok: true; intent_id: string }
  | { ok: false; reason: string }
export type CancelOutcome =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Sanitize a peer-controlled blurb before it lands in a `social_echo.content`
 * row (and, downstream, a WeChat message). The blurb passed the PEER's own
 * gateOutbound (social-answer.ts), but that's the peer's CC, not ours — a
 * hostile/buggy peer could still stuff newlines/control chars or an oversized
 * payload. Defence-in-depth: collapse whitespace, cap length.
 */
function sanitizeBlurb(blurb: string): string {
  return blurb.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function makeBroker(deps: BrokerDeps) {
  const schedule = deps.schedule ?? ((fn: () => Promise<void>) => { void fn() })

  // Background leg. `topic` (and `opts.city`) are ALREADY GATED — forage
  // broadcasts them VERBATIM and performs NO disclosure gating of its own
  // (P4 WYSIWYG: the owner saw and approved this exact wording at propose
  // time). Every caller (confirmSeek, resume, the seek() bridge) is
  // responsible for gating BEFORE it hands a string in here. Idempotent via
  // the echo PK (`intent_id:peer_agent_id`), so a duplicate send does not
  // double-insert.
  async function forage(intentId: string, topic: string, opts?: { city?: string }): Promise<void> {
    const ttl = deps.ttlMs ?? 10 * 60_000
    const card: IntentCard = {
      intent_id: intentId, kind: 'seek', topic, hop: 1,
      ...(opts?.city ? { city: opts.city } : {}),
      expires_at: new Date(Date.now() + ttl).toISOString(),
    }

    let candidates: A2AAgentRecord[]
    try { candidates = await deps.discover(topic) }
    catch { candidates = [] }   // discovery failure is fail-closed — no candidates, no exposure

    let echoCount = 0
    for (const hand of candidates) {
      try {
        const r = await deps.send(hand, card)
        if (r && r.match === 'yes') {
          echoCount++
          deps.recordEcho({
            intentId, peerAgentId: hand.id, peerMasked: '第 1 度的某人', degree: 1,
            content: r.blurb ? sanitizeBlurb(r.blurb) : '', first: echoCount === 1,
          })
        }
        // spec #2: degree-2 echoes this peer forwarded on our behalf. peer_agent_id
        // is null (we can't reach the downstream peer); the relay is keyed to the
        // intermediary (hand.id) + the opaque relay_token.
        for (const fe of r?.forwarded ?? []) {
          echoCount++
          deps.recordEcho({
            intentId, peerAgentId: null, relayVia: hand.id, relayToken: fe.relay_token,
            peerMasked: '第 2 度的某人', degree: fe.degree,
            content: sanitizeBlurb(fe.blurb), first: echoCount === 1,
          })
        }
      } catch {
        // One bad/unreachable peer (or a store write that threw) must not abort
        // the rest of the forage. Fail closed — skip and continue.
        continue
      }
    }
    try { deps.finishSeek(intentId, echoCount > 0 ? 'echoed' : 'closed', candidates.length) }
    catch { /* persistence error must not undo the network actions already done */ }
  }

  return {
    forage,

    // P4 派心愿 — the propose→confirm split. `propose` GATES (topic + optional
    // city) and persists a `proposed` row carrying the redacted wording the
    // owner will see and approve. It sends nothing and schedules no forage.
    async propose(topic: string, opts?: { city?: string }): Promise<ProposeOutcome> {
      const intent = newIntentId()
      const gated = await gateOutbound(topic, { policy: deps.policy, cheapEval: deps.cheapEval })
      if (!gated.ok) return { ok: false, reason: gated.violations.join('; ') || 'blocked' }
      let redactedCity: string | undefined
      if (opts?.city) {
        const gatedCity = await gateOutbound(opts.city, { policy: deps.policy, cheapEval: deps.cheapEval })
        if (gatedCity.ok) redactedCity = gatedCity.redacted   // else omit city (safe degradation)
      }
      deps.proposeRow(intent, { topic, redactedTopic: gated.redacted, ...(redactedCity ? { redactedCity } : {}) })
      return { ok: true, intent_id: intent, redacted: gated.redacted, ...(redactedCity ? { redacted_city: redactedCity } : {}) }
    },

    // Flip a `proposed` row to `foraging` and schedule the (already-gated)
    // forage of its STORED redacted wording — no re-gate (WYSIWYG). Clear
    // errors for a missing / already-non-proposed row.
    confirmSeek(intentId: string): ConfirmOutcome {
      const row = deps.readSeek(intentId)
      if (!row || row.status !== 'proposed') return { ok: false, reason: 'not_proposed' }
      deps.markStatus(intentId, 'foraging')
      schedule(() => forage(intentId, row.redacted_topic!, row.redacted_city ? { city: row.redacted_city } : undefined))
      return { ok: true, intent_id: intentId }
    },

    // Cancel a `proposed` row. Idempotent: a non-proposed row (already
    // cancelled / foraging / gone-terminal) returns ok without a re-write; a
    // missing id returns not_found.
    cancelSeek(intentId: string): CancelOutcome {
      const row = deps.readSeek(intentId)
      if (!row) return { ok: false, reason: 'not_found' }
      if (row.status !== 'proposed') return { ok: true }
      deps.markStatus(intentId, 'cancelled')
      return { ok: true }
    },

    // DEPRECATED — deleted in P4 Task 7; bridges pre-split callers. Gate →
    // sow (a `foraging` row) → forage the redacted result. The gating that
    // used to live INSIDE forage now lives here, so alias callers keep
    // byte-for-byte behavior: a `foraging` row + a redacted broadcast.
    async seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> {
      const intent_id = newIntentId()
      // Gate the OUTBOUND intent topic before it ever leaves. Blocked → return
      // the id but sow nothing and schedule no forage (nothing was exposed).
      const gated = await gateOutbound(topic, { policy: deps.policy, cheapEval: deps.cheapEval })
      if (!gated.ok) return { intent_id }
      let redactedCity: string | undefined
      if (opts?.city) {
        const gatedCity = await gateOutbound(opts.city, { policy: deps.policy, cheapEval: deps.cheapEval })
        if (gatedCity.ok) redactedCity = gatedCity.redacted   // else omit city (safe degradation)
      }
      deps.sow(intent_id, topic)
      schedule(() => forage(intent_id, gated.redacted, redactedCity ? { city: redactedCity } : undefined))
      return { intent_id }
    },
  }
}
