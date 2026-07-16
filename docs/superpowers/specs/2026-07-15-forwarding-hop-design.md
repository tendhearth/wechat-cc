# Forwarding Hop — Design Spec (spec #2)

**Date:** 2026-07-15
**Status:** Approved (brainstorming), ready for implementation plan
**Feature:** Let a seek reach **a friend of a friend** (2-hop). When a peer can't
match a seek itself, its bot forwards the seek to its OWN peers (`hop+1`), relays
their echoes back, and — on a successful mutual reveal — proxies the identity
exchange as the 介绍人 (connector). Builds on the shipped async foraging spine.

## Why

Spec #1 (the async foraging spine, shipped on `dev`) delivers async 1-hop
foraging + durable mutual reveal, but is degree-1 only: `discover` returns direct
paired peers and `send()` gets a synchronous `MatchReceipt` from each. The
product magic the user wants — "reach *through* the network to a friend of a
friend" — needs one more hop. This spec adds exactly that: **2-hop, hard-capped**
(one intermediary, the 介绍人). Deeper multi-hop is explicitly out of scope.

## Scope

**In scope:**
- Forwarding: a peer that receives a seek (`hop=1`) and doesn't/can't only-match
  it forwards the card (`hop=2`) to its own paired peers (excluding the sender),
  aggregates their echoes, and returns them alongside its own match.
- 2-hop echoes reach the seeker (degree 2), masked, via the existing synchronous
  `/a2a/intent` response (extended backward-compatibly).
- Mutual reveal across the hop, **proxied by the intermediary** (the 介绍人): the
  seeker and the 2-hop peer never share a direct channel, so both reveal legs run
  through the intermediary, which holds a `social_relay` row linking them.
- Identity exchange at mutual: because the intermediary is a direct peer of BOTH
  endpoints, it resolves both identities from its OWN registry — no identity
  travels across hops.
- 介绍人 warmth: on a successful 2-hop connection, all three are notified.
- Loop prevention: `hop` ceiling (2), never-forward-to-sender, and a seen-intent
  dedup.

**Out of scope (future):**
- 3+ hops / arbitrary depth. `hop` makes it *representable*, but forwarding is
  hard-capped at 2 and the reveal relay assumes exactly one intermediary.
- A desktop "派心愿" create route; live push/streaming (echoes are still poll-read).
- Ranking/selection of which peers to forward to (M1's "every paired peer, capped"
  carries over).
- We never surface "six degrees" as product copy; echoes carry a `degree` number.

## Architecture

Reuse the spine's synchronous `send()` → `/a2a/intent` → receipt path, extended so
a responder can return **forwarded echoes** alongside its own match. Reveal reuses
the spine's `/a2a/reveal` + `makeRevealer`, extended with a **relay branch**: the
seeker's echo carries `relay_via` + `relay_token`, its reveal is addressed to the
intermediary, and the intermediary proxies the two reveal legs via a durable
`social_relay` row. No new async echo-callback route — a 2-hop peer answers the
intermediary synchronously, and the intermediary aggregates into its one response.

Rejected alternatives:
- **Async echo-callback channel** (new inbound `/a2a/echo`, peers POST echoes back
  over time): more "pure async" but a much larger build; for a 2-hop hard cap where
  the downstream peer answers the intermediary synchronously, it's over-engineering.
- **Forward but defer 2-hop reveal**: a 2-hop echo you can see but can't act on is
  half a feature — the point is to connect. Reveal-relay is in scope.

Load-bearing simplification: **the intermediary is a direct peer of both endpoints**
(pairing is mutual, so the seeker is in the intermediary's registry, and the
intermediary forwards only to its own registry peers). So at mutual the intermediary
hands each endpoint the other's identity via two local `a2aRegistry.get(...)` calls
— identity never crosses a hop in a payload.

## Forwarding Mechanics

`IntentCard` gains `hop: number` (a2a-intent.ts schema): a seek leaves the seeker
with `hop=1`; a relay forwards only when `card.hop < 2`, forwarding with `hop+1`.
So a `hop=1` card is forwarded (→`hop=2`); a `hop=2` card is **terminal** (judged
locally, never re-forwarded). `hop` never exceeds 2 — the guard is `card.hop < 2`,
which is the sole depth cap.

The answer path (bootstrap's `socialOnIntent`, which wraps `makeAnswerIntent`)
becomes "judge + forward":
1. Judge locally (existing `answerIntent`). A local `match:'yes'` is a **degree-1
   echo** from the seeker's view; record the answerer's pledge as today.
2. **If `card.hop < 2`**: forward the card (`hop+1`) to the responder's own paired
   peers, **excluding the sender** (`event.agent.id`), synchronously `send()`-ing
   each and collecting their `MatchReceipt`s. Each forwarded `match:'yes'` becomes
   a **degree-2 echo**. The intermediary cannot hand the seeker the downstream
   peer's real `agent_id` (the seeker can't reach it), so it mints an opaque random
   `relay_token` and persists a `social_relay` row mapping
   `(intent_id, relay_token) → downstream_agent_id`.
3. **Aggregate + return**: the `/a2a/intent` response is extended backward-
   compatibly — the responder's own `MatchReceipt` (unchanged), plus an optional
   `forwarded?: ForwardedEcho[]` where `ForwardedEcho = { blurb: string; degree:
   number; relay_token: string }`. A spec-#1 seeker ignores `forwarded`; a spec-#1
   responder simply never produces it.

**Loop prevention (three guards, together make a 2-hop network non-looping):**
- **Never forward to the sender** — exclude `event.agent.id` from forward targets.
- **Seen-intent dedup** — each relay records `intent_id` in `social_seen_intent`
  (TTL = the card's `expires_at`); a second arrival of the same `intent_id`
  (diamond path / cycle) is skipped, not re-forwarded.
- **Hop ceiling** — `hop > 2` is never forwarded.

**Anonymity:** the forwarded card carries only `topic` (already policy-gated),
`intent_id`, `hop` — **never the originator's identity**. The downstream peer sees
"an anonymous seek relayed by <intermediary>", not who sought. Echoes carry only a
masked, gate-filtered blurb — no contact info.

## Data Model (migration v21)

**Wire schema:**
- `IntentCard` + `hop: number` (a2a-intent.ts). Seek sets `hop=1`.
- `/a2a/intent` response: keep the `MatchReceipt` shape, add optional
  `forwarded?: ForwardedEcho[]`. Backward-compatible superset.

**`social_echo` (exists) — 2 new nullable columns:**
- `relay_via TEXT` — the intermediary's `agent_id` for a 2-hop echo; `null` for a
  direct 1-hop echo.
- `relay_token TEXT` — the intermediary-minted token for a 2-hop echo; `null` for
  direct.
- A direct echo keeps id `intent_id:peer_agent_id` (with `peer_agent_id` set,
  `relay_*` null). A relay echo has `peer_agent_id = null`, `relay_via = <W>`,
  `relay_token = <T>`, and id `intent_id:relay_via:relay_token`. `degree`
  (existing) is 1 for direct, 2 for relay.

**`social_relay` (NEW, STRICT — the intermediary's side):** links the two reveal
legs of one proxied connection.
- `id TEXT PRIMARY KEY` = `intent_id:relay_token`
- `intent_id TEXT`
- `relay_token TEXT`
- `upstream_agent_id TEXT` — who the intermediary received the card from (the seeker)
- `downstream_agent_id TEXT` — who it forwarded to and got the `yes` from
- `upstream_revealed_at TEXT` — the seeker revealed to the intermediary (nullable)
- `downstream_revealed_at TEXT` — the downstream peer revealed to the intermediary
  (nullable)
- `created_at TEXT`
- Both revealed-timestamps set ⇒ the intermediary declares mutual.

**`social_seen_intent` (NEW, STRICT — dedup):**
- `intent_id TEXT PRIMARY KEY`
- `first_seen_at TEXT`
- `expires_at TEXT` — copied from the card; a relay may prune expired rows lazily.

## Reveal Relay (the two-leg handshake)

A 2-hop connection S↔Q via intermediary W is two reveal legs, pivoted on W. The
endpoints reuse the spine's echo/pledge machinery; W adds the `social_relay` row.

Endpoint view (unchanged shapes):
- **S** holds a `degree:2` echo with `relay_via=W`, `relay_token=T`. Its reveal
  target is W.
- **Q** recorded a normal pledge whose "seeker" is **W** (the card was forwarded by
  W, so to Q the seeker *is* W). Q's reveal target is W.
- Neither endpoint knows the other until mutual.

Handshake:
1. **S reveals** (desktop 揭晓 / WeChat) → `revealEcho` sees `relay_via` set → POST
   **W** `/a2a/reveal { agent_id: S, intent_id, relay_token: T }`.
2. W receives a reveal carrying `relay_token` ⇒ it's a **relay**, not W's own
   echo/pledge → set `social_relay.upstream_revealed_at`. Then W **proxies Q's leg**:
   POST **Q** `/a2a/reveal { agent_id: W, intent_id }` (to Q this is "the seeker W is
   revealing") → Q's `onInboundReveal` matches Q's pledge `intent_id:W`, marks it,
   and fires beat #2 ("👀 有人想连你") to Q's owner.
3. **Q reveals later** → `revealPledge` → POST **W** `/a2a/reveal { agent_id: Q,
   intent_id }` → W finds the same `social_relay` row by `(intent_id,
   downstream_agent_id=Q)` → set `downstream_revealed_at`.
4. **Both legs revealed ⇒ W declares mutual.** W resolves S and Q from its OWN
   `a2aRegistry` and crosses the identities:
   - to S's leg: `{ mutual: true, identity: <Q's identity> }` → S's relay echo
     `peer_masked` becomes Q's real name, seek → `connected`.
   - to Q's leg: `{ mutual: true, identity: <S's identity> }` → Q's pledge completes.
   - Whoever reveals **second** learns `mutual:true` synchronously in their own
     `/a2a/reveal` round-trip (spine invariant); the first revealer's side is
     completed when W posts back to it on the second leg (the spine's
     `onInboundReveal` inbound-completion shape).

**Both orderings — W always nudges whichever endpoint hasn't revealed.** The steps
above trace S-first; Q-first is symmetric. Whenever W marks one leg and the other
leg is not yet revealed, W POSTs the *un-revealed* endpoint a reveal-nudge so that
endpoint's owner gets beat #2 ("👀 有人想连你"). Nudging Q is a plain `/a2a/reveal
{ agent_id: W, intent_id }` (Q's pledge is keyed `intent_id:W`). **Nudging S must
carry the `relay_token`** — because S may hold *several* relay echoes for one
`intent_id` (via different intermediaries, or several downstream peers via the same
W), so the plain `intent_id:agent_id` key is insufficient. Therefore:

**`onInboundReveal` gains a relay branch (seeker side).** An inbound `/a2a/reveal`
carrying a `relay_token` resolves the local **relay echo** by its id
`intent_id:<caller>:relay_token` (rather than the direct `intent_id:agent_id`
key), then marks/nudges/mutual-completes exactly as the direct branch does. Q's
side needs no change — Q holds an ordinary pledge and W nudges/reveals it with the
plain key.

**Idempotency:** the relay legs and the relay-branch `onInboundReveal` guard on the
`*_revealed_at` timestamps exactly as the spine's `onInboundReveal` does (a retried
inbound reveal is a no-op, fires no duplicate beat).

## Notifications — 介绍人 warmth (restrained; only at success)

At the mutual instant, three one-time pings:
- **S**: `🤝 牵上线了 —— 经<W名>,认识了<Q名>`
- **Q**: `🤝 牵上线了 —— 经<W名>,认识了<S名>`
- **W (介绍人)**: `🎉 你把朋友和<Q名>牵上线了` — W already proxied the reveal, so
  telling W leaks nothing extra.

W stays **silent during foraging and forwarding** (no ping per relayed seek) — only
the success beat fires, consistent with the spine's restrained cadence.

## Trigger Surfaces

Fully reused from the spine — **no user-facing change**. Desktop `POST
/v1/social/echoes/reveal { id }` (the `id` may now be a relay echo's
`intent_id:relay_via:relay_token`) and WeChat `揭晓 <id>`. Relay vs. direct is
transparent to the user; the reveal outcome states (`connected` / `awaiting_peer`
/ `peer_unreachable`) are unchanged.

## Security / Trust

- Originator identity never enters a forwarded card; endpoints stay mutually
  anonymous until mutual reveal.
- `relay_token` is random + opaque and meaningful only to the intermediary; the
  seeker cannot use it to infer or directly reach the downstream peer.
- `/a2a/reveal`'s relay branch keeps the spine's auth: Bearer-verified, and the
  acting `agent_id` is the **verified Bearer identity**, not client-supplied — so a
  peer can only drive relays/reveals for its own edges, and cannot probe arbitrary
  intents or forge a connection.
- The intermediary's bot forwards automatically (joining the social network =
  consenting to be a connector), consistent with the spine's autonomous
  judge/answer model; the owner is not interrupted per relayed seek, only
  celebrated on success. The downstream peer's match still runs its own
  `gateOutbound` (blurb carries no contact info).
- Trust propagation stops at 2 hops: hop ceiling + never-forward-to-sender +
  seen-intent dedup — no cycles, no unbounded fan-out.

## Error Handling (continues fail-closed)

- A forward target unreachable/timeout → skip it, still return the rest of the
  aggregated echoes; one bad peer never fails the whole `/a2a/intent` response.
- Intermediary offline when S reveals → S's reveal of the relay echo returns
  `peer_unreachable` (existing spine state); S's consent is persisted, retryable;
  the connection is not lost.
- Intermediary restarted before Q reveals → `social_relay` is durable; W
  reconciles by `(intent_id, downstream)` on Q's reveal, process-independent (the
  spine's row-driven restart survivability).
- `social_relay` / `social_seen_intent` write failure → log, never undo a network
  action already taken (the spine's try/catch-around-recording principle).

## Testing (TDD; vitest — `import z from 'zod'` gotcha)

- **Unit — forwarding/aggregation:** judge-then-forward, `hop+1`, exclude sender,
  `hop>2` never forwards; aggregated response shape (own match + `forwarded[]`).
- **Unit — dedup:** the same `intent_id` arriving twice is processed once.
- **Unit — relay reveal:** the two-leg reconciliation (S-first / Q-first / both
  timeout / intermediary restart then Q reveals); identity crossing via the
  intermediary's registry (no identity in cross-hop payloads); idempotent retried
  relay reveal fires no duplicate beat.
- **Unit — anonymity:** forwarded card carries no originator; S cannot obtain Q's
  address before mutual reveal.
- **Store:** `social_relay` + `social_seen_intent` CRUD + the two new `social_echo`
  columns; migration v21 smoke test (table count, `user_version`).
- **Compatibility:** a spec-#1 peer returning a plain `MatchReceipt` → a spec-#2
  seeker works (no `forwarded`); a spec-#2 responder's `forwarded` is ignored by a
  spec-#1 seeker without error.
- **e2e:** compose S→W→Q in-process — S sows → W judges no-match + forwards → Q
  matches → a degree-2 echo returns to S → S reveals (proxied by W) → Q reveals →
  `connected` + three-way warmth + identity crossing, with S and Q mutually
  anonymous until mutual reveal.

## Changed Existing Code

- `src/core/a2a-intent.ts` — `IntentCard` + `hop`; the `/a2a/intent` response type
  gains optional `forwarded`.
- `src/core/social-answer.ts` and/or the wiring — judge-then-forward + aggregation.
- `src/daemon/bootstrap/index.ts` — forwarding wiring (forward to own peers, mint
  relay tokens, record `social_relay`/`social_seen_intent`), the `/a2a/reveal`
  relay branch (proxy the two legs), and the three-way warmth notify.
- `src/core/social-echo-store.ts` — the two new columns + relay-echo create/get.
- `src/core/social-reveal.ts` — the relay-aware reveal branch (or a companion
  relay module the wiring composes).
- `src/lib/db.ts` — migration v21.
- New stores: `src/core/social-relay-store.ts`, `src/core/social-seen-intent-store.ts`.

## Open Follow-ups (not this spec)
- 3+ hops (deeper propagation, cross-hop identity relay, path state).
- Peer selection/ranking for forwarding (wxgraph closeness/topical relevance).
- Desktop-initiated seek create; a "not found" reply for an unknown 揭晓 id
  (carried from the spine's follow-ups).
