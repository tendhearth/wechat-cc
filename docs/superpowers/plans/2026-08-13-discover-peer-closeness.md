# Agent-Social — discover peer fan-out by a2a interaction closeness — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Rank the seeker-side discover fan-out by a2a interaction closeness (recency + volume + reciprocity, from the existing `a2a_events` log), replacing the arbitrary `.slice(0,5)` at both fan-out sites. Pseudonymous — no wxid, reads only existing observability data.

**Architecture:** A pure `src/core/peer-closeness.ts` ranks peers over a narrow `PeerEventsView` (structurally satisfied by `A2AEventsStore`) with an injected `now`. `wire-social.ts` supplies the real events store (threaded through `SocialDeps` from `bootstrap/index.ts`) + `Date.now()` at each discover call. Both fan-out sites use the ranker; existing eligibility filters are preserved.

**Tech Stack:** TypeScript/Bun. Branch `feat/discover-peer-closeness` (base dev `edda7358`). `peer-closeness.test.ts` = `bun:test`; `wire-social` suites = vitest (`bun --bun vitest run`).

## Global Constraints
- **Pure ranker, injected `now`** — no `Date.now()` inside `peer-closeness.ts` (testability). `wire-social` passes `Date.now()` at the call.
- **Preserve each fan-out site's existing eligibility filters** (paused; the forward path's `id !== excludeAgentId` + mailbox-without-url exclusion). The ranker replaces ONLY the ordering + cap, not eligibility.
- **Empty-history degrades deterministically:** all peers score ~0 → stable id-ascending order → still return up to `limit` (never drop below the cap arbitrarily; never crash). Pinned by a test.
- **Reads only `a2a_events`** — nothing new persisted, nothing crosses the wire, no identity bound. Answer-side judge / disclosure gate / intent protocol / pairing untouched.
- **TDD**; `bunx tsc --noEmit` clean; never `git add -A`; never touch package.json/bun.lock; commits end `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Source of truth
Spec: `docs/superpowers/specs/2026-08-13-discover-peer-closeness-design.md`. Read: `src/core/a2a-events-store.ts` (`A2AEventsStore`: `counts(id)→{inbound,outbound}`, `recentForAgent(id,limit)→EventRow[]` with `ts`/`direction`), `src/daemon/bootstrap/wire-social.ts` (the two fan-out sites + `SocialDeps`), `src/daemon/bootstrap/index.ts:929` (`a2aEventsStore = makeA2AEventsStore(deps.db)`) + the `wireSocial({…})` call (~:955).

---

## Task 1: peer-closeness.ts — the pure ranker

**Files:** Create `src/core/peer-closeness.ts` + `src/core/peer-closeness.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export interface PeerEventsView {
    counts(agentId: string): { inbound: number; outbound: number }
    recentForAgent(agentId: string, limit: number): readonly { ts: string; direction: 'in' | 'out' }[]
  }
  export function rankPeersByCloseness<T extends { id: string }>(
    peers: T[], events: PeerEventsView, now: number, limit: number,
  ): T[]
  ```
  (`A2AEventsStore` structurally satisfies `PeerEventsView` — `EventRow` has `ts`+`direction`; the extra fields are fine.)

- [ ] **Step 1: Write failing tests** `peer-closeness.test.ts`:
```ts
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
```

- [ ] **Step 2: Run, verify fail.** `bun test src/core/peer-closeness.test.ts` → FAIL.
- [ ] **Step 3: Implement** `peer-closeness.ts`:
```ts
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
```
- [ ] **Step 4: Run, verify pass + `bunx tsc --noEmit` clean.**
- [ ] **Step 5: Commit** `feat(social): peer interaction-closeness ranker for discover (PC T1)`.

---

## Task 2: wire the ranker into both fan-out sites

**Files:** Modify `src/daemon/bootstrap/wire-social.ts` (`SocialDeps` + the two fan-out sites), `src/daemon/bootstrap/index.ts` (thread `eventsStore` into the `wireSocial({…})` call). Tests: the wire-social suite that covers discover/forward (`wire-social.forage.test.ts` and/or a discover-specific test) — extend to assert closeness ordering.

**Interfaces:**
- Consumes: `rankPeersByCloseness` (T1), `A2AEventsStore` (structurally a `PeerEventsView`).

- [ ] **Step 1:** Add `eventsStore: import('../../core/a2a-events-store').A2AEventsStore` to the `SocialDeps` interface (near `a2aRegistry`, `wire-social.ts:69`). In `bootstrap/index.ts`, at the `wireSocial({…})` call (~:955), pass `eventsStore: a2aEventsStore` (the instance built at `index.ts:929`; confirm the variable name in scope).
- [ ] **Step 2:** Import `rankPeersByCloseness` in `wire-social.ts`. Replace the **discover** closure (~`:628`):
```ts
discover: async (_topic) =>
  rankPeersByCloseness(a2aRegistry.list().filter((a) => !a.paused), deps.eventsStore, Date.now(), 5),
```
and the **forward** path (~`:591`), preserving its extra filters:
```ts
try {
  return rankPeersByCloseness(
    a2aRegistry.list().filter((a) => !a.paused && a.id !== excludeAgentId && !(a.transport === 'mailbox' && !a.url)),
    deps.eventsStore, Date.now(), 5,
  )
} catch { return [] }
```
(Keep the surrounding `try/catch` shape the forward site already has. The cap `5` is unchanged.)
- [ ] **Step 3: Tests** — extend the wire-social suite: with a fake `eventsStore` (a peer with recent+mutual events vs a peer with none), assert `broker.discover` (and the forward path) return the closeness-ranked order (engaged peer first), and that the existing filters still apply (a paused peer / a url-less mailbox peer in the forward path is excluded). Write these as vitest (match the suite).
- [ ] **Step 4:** `bunx tsc --noEmit` clean; `bun --bun vitest run src/daemon/bootstrap/wire-social.forage.test.ts src/daemon/bootstrap/wire-social.busy.test.ts` + any discover test green.
- [ ] **Step 5: Commit** `feat(social): rank discover + forward fan-out by peer closeness (PC T2)`.

---

## Task 3: VERIFY-AGAINST-REAL (owner machine)

**File:** `scratchpad/peer-closeness-verify.ts`.

- If the owner's DB has an `a2a_events` table with history: build the real `A2AEventsStore` (`makeA2AEventsStore(new Database(<stateDir>/…db))` — find the daemon DB path) + the real paired peers from `agent-config.json`'s `a2a_agents`, run `rankPeersByCloseness(peers, store, Date.now(), 5)`, print the ranked order + each peer's (inbound/outbound, last-event-age). Sanity: most recently/frequently engaged peers first.
- If there's no real a2a history (fresh owner / no paired peers): construct an in-memory `A2AEventsStore` over a temp DB, `append` a few synthetic events for 2-3 fake peer ids with differing recency/volume/reciprocity, and confirm the real ranker orders them as designed — plus assert the empty-history case (no events) returns a stable id-ordered top-5 without crashing.

- [ ] **Step 1:** Write + run (`bun scratchpad/peer-closeness-verify.ts`). Acceptance: the ranker orders real (or realistic synthetic) peers by interaction closeness, and degrades cleanly on empty history. (Harness not committed.)

## Self-review
- Coverage: pure ranker + numeric/degrade tests (T1), both fan-out sites + threading + integration tests (T2), real verify (T3). Replaces arbitrary `.slice(0,5)` with a pseudonymous interaction-closeness order.
- Risk: T1 empty-history determinism (pinned); T2 must preserve each site's eligibility filters (only ordering/cap changes) + confirm `eventsStore` is genuinely in scope at the index.ts call.
- Privacy: reads only existing a2a_events; no wxid; nothing crosses the wire.
