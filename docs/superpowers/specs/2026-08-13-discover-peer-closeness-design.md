# Agent-Social — discover peer fan-out by a2a interaction closeness — Design

**Date**: 2026-08-13
**Status**: Design approved (brainstorm 2026-08-13); writing-plans next.
**Builds on**: agent-social M1 (intent brokering) + Phase 2 (in-proc judge). North star: `docs/design/agent-social-network.md` (pseudonymous social layer — peers are agents, never linked to a person on the wire).

## Goal

Rank the seeker-side **discover** fan-out by **a2a interaction closeness** — reach
the peers the owner's agent actually engages with first — instead of the current
arbitrary `a2aRegistry.list().filter(!paused).slice(0, 5)`. Uses only the
existing `a2a_events` observability log (frequency / recency / reciprocity of
agent-to-agent calls). No wxid, no wire exposure — fully within the pseudonymous
social design.

## Why not rank_contacts (the reframe that produced this design)

The obvious-sounding "discover → `rank_contacts`" is a category error, revealed by
the pairing flow:
- **Social pairing is pseudonymous.** `pairing.ts` (配对码 engine) writes a peer
  record with only `id`/`name`/`mailbox`/`pubkey` — **no wxid**, `capabilities:[]`.
  The pairing code is exchanged out-of-band; the daemon never learns which wechat
  contact a peer is. Binding one would break the "online is always the agent
  pseudonym, never the person" rule.
- Even with an owner-local link, `rank_contacts` (the owner's topical closeness to
  a person) doesn't answer discover's question — "which peer's agent can help with
  this seek" is about the **peer's** interests (hidden; `capabilities` empty) and
  is already decided on the **answering side** by that peer's judge.
- A seek is **broadcast + answer-side-judge-filtered** (M1). So discover's cap is
  just a fan-out budget; topical targeting is redundant with the answering judge.
  The only real question discover answers is **"which peers to spend the fan-out
  budget on"** → the peers the owner most/most-recently interacts with.

So `rank_contacts` stays owner-facing (person_brief / top_contacts); peer discovery
uses a **peer-level** interaction-closeness signal instead.

## Scope

**In:**

1. **`src/core/peer-closeness.ts`** (new, pure, unit-testable):
   ```ts
   export interface PeerEventsView {
     counts(agentId: string): { inbound: number; outbound: number }
     recentForAgent(agentId: string, limit: number): readonly { ts: string; direction: 'in' | 'out' }[]
   }
   export function rankPeersByCloseness<T extends { id: string }>(
     peers: T[], events: PeerEventsView, now: number, limit: number,
   ): T[]
   ```
   Score per peer (all injected, no `Date.now()` in the pure fn):
   - **recency** = `exp(-ageDays / TAU)` on the most-recent event ts from
     `recentForAgent(id, 1)` (TAU = 30 days; no events → recency 0).
   - **volume** = `log1p(inbound + outbound)` from `counts(id)`, normalized by a
     constant (log-damped so a chatty peer doesn't dominate).
   - **reciprocity** = small bonus (e.g. +0.15) when BOTH `inbound > 0` and
     `outbound > 0` (mutual engagement), else 0.
   - `closeness = 0.6*recency + 0.3*volumeNorm + reciprocity` (weights are a
     starting point, documented; tune later). Sort desc; **stable tiebreak by
     `id`** so equal-score/no-event peers order deterministically. Return the top
     `limit`. A peer with zero events scores ~0 but is still eligible (included
     only if fewer than `limit` peers have any history) — never silently dropped
     below the cap when the cap isn't full.

2. **`wire-social.ts` — both fan-out sites use the ranker.** Replace
   `a2aRegistry.list().filter(a => !a.paused).slice(0, 5)` at BOTH:
   - the `broker.discover` closure (~`:628`), and
   - the hop+1 forward-to-own-peers path (~`:591`, same cap),
   with `rankPeersByCloseness(list.filter(a => !a.paused && <existing extra filters>), eventsStore, Date.now(), 5)`. Preserve each site's existing extra filters (e.g. the forward path's `id !== excludeAgentId` and the mailbox-without-url exclusion). The cap constant (5) is unchanged.

3. **Thread `eventsStore` into `SocialDeps`** (`wire-social.ts` + the `wireSocial({…})`
   call in `bootstrap/index.ts`) — add `eventsStore: A2AEventsStore` (the same
   instance already built for the a2a server / dashboard observability; confirm
   it's in scope at the call site). `now` is taken as `Date.now()` at each
   discover call (the pure ranker receives it as a param for testability).

**Out (not this slice):**
- Any peer↔wechat-contact link, `rank_contacts` in discovery, or `capabilities`
  population — explicitly rejected above.
- Answer-side judge / disclosure gate / intent protocol / pairing — untouched.
- Tuning the weights against real fan-out outcomes (ship the documented starting
  weights; revisit with data).

## Architecture

`peer-closeness.ts` is a pure ranking function over a narrow `PeerEventsView`
(structurally satisfied by the real `A2AEventsStore` — `counts` +
`recentForAgent`), so it unit-tests with a fake events view and an injected `now`,
no daemon. `wire-social` supplies the real store + `Date.now()` at call time. The
`a2a_events` log is append-only observability data that already exists (migration
v12) — this slice only READS it. Nothing new is persisted; nothing crosses the
wire; no identity is bound.

## Verification
- **peer-closeness (unit):** a recent peer outranks a stale one at equal volume;
  higher volume breaks a recency tie; a mutually-engaged peer (in+out) outranks a
  one-directional peer at equal recency/volume; a no-events peer sorts last but is
  still returned when under the cap; `limit` respected; stable id tiebreak;
  injected `now` drives recency (no wall-clock in the pure fn).
- **wire-social (unit/integration):** `broker.discover` and the forward path
  return the closeness-ranked top-5 (not arbitrary order), preserving each site's
  existing filters; a fake `eventsStore` drives the ranking.
- **VERIFY-AGAINST-REAL (owner machine):** if the owner's `a2a_events` table has
  history, rank the real paired peers and print the order + scores (sanity: most
  recently/frequently engaged peers first); if the table is empty (no real a2a
  traffic yet), assert the ranker degrades to a stable id-ordered top-5 (no crash,
  no arbitrary drop) on the real registry.

## Non-goals / risks
- **Don't over-model.** This is fan-out prioritization, not a relationship graph —
  the 3-term score is deliberately simple; weights are a documented starting point.
- **Empty-history correctness:** with no a2a_events (fresh owner), every peer
  scores ~0 → the ranker must degrade to a deterministic stable order and still
  return up to `limit` peers (never drop below the cap arbitrarily). Pinned by a
  test.
- **Preserve each fan-out site's existing filters** (paused, self-exclude,
  mailbox-without-url) — the ranker replaces only the ordering + cap, not the
  eligibility filters.
