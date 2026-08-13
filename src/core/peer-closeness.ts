export interface PeerEventsView {
  counts(agentId: string): { inbound: number; outbound: number }
  recentForAgent(agentId: string, limit: number): readonly { ts: string; direction: 'in' | 'out' }[]
}

const TAU_DAYS = 30
const RECIP_BONUS = 0.15
const VOL_NORM = 5 // log1p(inbound+outbound)/VOL_NORM, clamped to 1

function scorePeer(id: string, events: PeerEventsView, now: number): number {
  const { inbound, outbound } = events.counts(id)
  const recent = events.recentForAgent(id, 1)
  let recency = 0
  if (recent.length > 0) {
    const ts = Date.parse(recent[0]!.ts)
    if (!Number.isNaN(ts)) {
      const ageDays = Math.max(0, (now - ts) / 86_400_000)
      recency = Math.exp(-ageDays / TAU_DAYS)
    }
  }
  const volume = Math.min(1, Math.log1p(inbound + outbound) / VOL_NORM)
  const reciprocity = inbound > 0 && outbound > 0 ? RECIP_BONUS : 0
  return 0.6 * recency + 0.3 * volume + reciprocity
}

/** Rank paired peers by a2a interaction closeness (recency + volume + reciprocity),
 *  descending; stable id-ascending tiebreak; return the top `limit`. `now` injected.
 *  With no a2a history every peer scores ~0 → deterministic id order, still up to `limit`. */
export function rankPeersByCloseness<T extends { id: string }>(
  peers: T[], events: PeerEventsView, now: number, limit: number,
): T[] {
  return peers
    .map((p) => ({ p, s: scorePeer(p.id, events, now) }))
    .sort((a, b) => b.s - a.s || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0))
    .slice(0, limit)
    .map((x) => x.p)
}
