import { test, expect } from 'bun:test'
import { rankPeersByCloseness, type PeerEventsView } from './peer-closeness'

const NOW = Date.parse('2026-08-13T00:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

function view(spec: Record<string, { in: number; out: number; lastDaysAgo?: number }>): PeerEventsView {
  return {
    counts: (id) => ({ inbound: spec[id]?.in ?? 0, outbound: spec[id]?.out ?? 0 }),
    recentForAgent: (id, _l) => {
      const s = spec[id]
      return s?.lastDaysAgo === undefined ? [] : [{ ts: daysAgo(s.lastDaysAgo), direction: 'in' as const }]
    },
  }
}
const peers = (...ids: string[]) => ids.map((id) => ({ id }))

test('a recent peer outranks a stale one at equal volume', () => {
  const v = view({ a: { in: 5, out: 5, lastDaysAgo: 1 }, b: { in: 5, out: 5, lastDaysAgo: 60 } })
  expect(rankPeersByCloseness(peers('b', 'a'), v, NOW, 5).map((p) => p.id)).toEqual(['a', 'b'])
})

test('higher volume breaks a recency tie', () => {
  const v = view({ a: { in: 1, out: 1, lastDaysAgo: 2 }, b: { in: 40, out: 40, lastDaysAgo: 2 } })
  expect(rankPeersByCloseness(peers('a', 'b'), v, NOW, 5).map((p) => p.id)).toEqual(['b', 'a'])
})

test('a mutually-engaged peer outranks a one-directional peer (equal recency+volume)', () => {
  const v = view({ a: { in: 5, out: 5, lastDaysAgo: 3 }, b: { in: 10, out: 0, lastDaysAgo: 3 } })
  // Same total volume (10 vs 10) and same recency → the volume+recency terms tie;
  // a is mutual (in+out) so gets the +0.15 reciprocity bonus, b (one-directional) does not.
  expect(rankPeersByCloseness(peers('b', 'a'), v, NOW, 5).map((p) => p.id)).toEqual(['a', 'b'])
})

test('no-events peer sorts last but is still returned under the cap', () => {
  const v = view({ a: { in: 3, out: 3, lastDaysAgo: 5 } })   // b has no history
  expect(rankPeersByCloseness(peers('b', 'a'), v, NOW, 5).map((p) => p.id)).toEqual(['a', 'b'])
})

test('limit is respected', () => {
  const v = view({ a: { in: 1, out: 1, lastDaysAgo: 1 }, b: { in: 1, out: 1, lastDaysAgo: 2 }, c: { in: 1, out: 1, lastDaysAgo: 3 } })
  expect(rankPeersByCloseness(peers('a', 'b', 'c'), v, NOW, 2).map((p) => p.id)).toEqual(['a', 'b'])
})

test('empty history → deterministic stable id-ascending order, still returns up to limit', () => {
  const v = view({})   // nobody has any events
  expect(rankPeersByCloseness(peers('c', 'a', 'b'), v, NOW, 5).map((p) => p.id)).toEqual(['a', 'b', 'c'])
})
