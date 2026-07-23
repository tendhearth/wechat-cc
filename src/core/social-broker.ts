import type { CheapEval } from './agent-provider'
import type { A2AAgentRecord } from '../lib/agent-config'
import { newIntentId, type IntentCard } from './a2a-intent'
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
  /** v2: fast-ack fire-and-forget — true iff the peer accepted delivery (not
   *  whether they matched). The peer's own async judge decides match/no and
   *  posts any echo back later via /a2a/echo → social-echo-intake.ts. */
  send: (hand: A2AAgentRecord, card: IntentCard) => Promise<boolean>
  policy: string
  cheapEval: CheapEval
  ttlMs?: number
  /** P4 propose leg: persist a `proposed` row carrying the owner-approved redacted wording. */
  proposeRow: (intentId: string, r: { topic: string; redactedTopic: string; redactedCity?: string }) => void
  /** Read a seek row back (for confirmSeek/cancelSeek). null when unknown. */
  readSeek: (intentId: string) => BrokerSeekRow | null
  /** Flip a seek row's status (proposed → foraging on confirm, → cancelled on cancel). */
  markStatus: (intentId: string, status: 'foraging' | 'cancelled') => void
  /**
   * v2 forage completion: record how many peers accepted delivery (peers_asked).
   * The seek row's status is left AS-IS (foraging) — echoes now arrive out of
   * band, one at a time, via /a2a/echo → social-echo-intake.ts, which is what
   * flips foraging → echoed on the first accepted echo. There is no automatic
   * close: a forage that lands zero fast-acks simply stays foraging forever
   * (matches spec — cheap to leave open, the owner can always cancel).
   */
  markForaged: (intentId: string, peersAsked: number) => void
  /** Schedule the background coroutine off the caller's turn. Default: fire-and-forget. */
  schedule?: (fn: () => Promise<void>) => void
}
export type ProposeOutcome =
  | { ok: true; intent_id: string; redacted: string; redacted_city?: string }
  | { ok: false; reason: string }
export type ConfirmOutcome =
  | { ok: true; intent_id: string }
  | { ok: false; reason: string }
export type CancelOutcome =
  | { ok: true }
  | { ok: false; reason: string }

export function makeBroker(deps: BrokerDeps) {
  const schedule = deps.schedule ?? ((fn: () => Promise<void>) => { void fn() })

  // Background leg. `topic` (and `opts.city`) are ALREADY GATED — forage
  // broadcasts them VERBATIM and performs NO disclosure gating of its own
  // (P4 WYSIWYG: the owner saw and approved this exact wording at propose
  // time). Every caller (confirmSeek, resume, the seek() bridge) is
  // responsible for gating BEFORE it hands a string in here.
  //
  // v2: `send` is a fast-ack fire-and-forget (true iff the peer accepted
  // delivery). Forage does NOT wait for a verdict and does NOT record any
  // echo itself — the peer's own async judge decides match/no and, on a
  // match, posts the echo back later via /a2a/echo, which lands through
  // social-echo-intake.ts (idempotent there via the echo PK
  // `intent_id:peer_agent_id`, so a duplicate return-echo does not
  // double-insert). Forage's only job is to fan the card out and, once every
  // candidate has been tried, record how many accepted (markForaged) — the
  // seek row's status is left untouched (still `foraging`).
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

    let asked = 0
    for (const hand of candidates) {
      try { if (await deps.send(hand, card)) asked++ }
      catch { continue }   // one bad/unreachable peer must not abort the rest
    }
    try { deps.markForaged(intentId, asked) }
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
  }
}
