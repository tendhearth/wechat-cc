import type { CheapEval } from './agent-provider'
import type { A2AAgentRecord } from '../lib/agent-config'
import { newIntentId, type IntentCard } from './a2a-intent'
import type { MatchReceipt } from './a2a-intent'
import { gateOutbound } from './a2a-disclosure'

export interface EchoRecord {
  intentId: string; peerAgentId: string; peerMasked: string; degree: number; content: string; first: boolean
}

export interface BrokerDeps {
  discover: (topic: string) => Promise<A2AAgentRecord[]>
  send: (hand: A2AAgentRecord, card: IntentCard) => Promise<MatchReceipt | null>
  policy: string
  cheapEval: CheapEval
  ttlMs?: number
  /** Sync leg: persist the wish as a `foraging` social_seek row. */
  sow: (intentId: string, topic: string) => void
  /** Background leg: persist one `match:'yes'` echo. `first` = the seek had 0 echoes. */
  recordEcho: (e: EchoRecord) => void
  /** Background leg completion: `echoed` (≥1 echo) or `closed` (0). */
  finishSeek: (intentId: string, status: 'echoed' | 'closed', peersAsked: number) => void
  /** Schedule the background coroutine off the caller's turn. Default: fire-and-forget. */
  schedule?: (fn: () => Promise<void>) => void
}
export interface SeekOutcome { intent_id: string }

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

  // Background leg. Also called directly by the boot-scan resume (Task 8) for
  // seeks still in `foraging` after a restart — idempotent via the echo PK
  // (`intent_id:peer_agent_id`), so a duplicate send does not double-insert.
  async function forage(intentId: string, topic: string, opts?: { city?: string }): Promise<void> {
    const gated = await gateOutbound(topic, { policy: deps.policy, cheapEval: deps.cheapEval })
    if (!gated.ok) { try { deps.finishSeek(intentId, 'closed', 0) } catch { /* logged by caller impl */ } return }
    const ttl = deps.ttlMs ?? 10 * 60_000
    let cardCity: string | undefined
    if (opts?.city) {
      const gatedCity = await gateOutbound(opts.city, { policy: deps.policy, cheapEval: deps.cheapEval })
      if (gatedCity.ok) cardCity = gatedCity.redacted   // else omit city (safe degradation)
    }
    const card: IntentCard = {
      intent_id: intentId, kind: 'seek', topic: gated.redacted,
      ...(cardCity ? { city: cardCity } : {}),
      expires_at: new Date(Date.now() + ttl).toISOString(),
    }

    let candidates: A2AAgentRecord[]
    try { candidates = await deps.discover(gated.redacted) }
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
    async seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> {
      const intent_id = newIntentId()
      // Gate the OUTBOUND intent topic before it ever leaves. Blocked → return
      // the id but sow nothing and schedule no forage (nothing was exposed).
      const gated = await gateOutbound(topic, { policy: deps.policy, cheapEval: deps.cheapEval })
      if (!gated.ok) return { intent_id }
      deps.sow(intent_id, topic)
      schedule(() => forage(intent_id, topic, opts))
      return { intent_id }
    },
  }
}
