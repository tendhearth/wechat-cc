# Async Foraging Spine — Design Spec

**Date:** 2026-07-15
**Status:** Approved (brainstorming), ready for implementation plan
**Feature:** Rework `broker.seek()` from a synchronous one-shot into an async
"sow → forage → reveal" spine, with a durable, restart-survivable, mutual
double-opt-in reveal step.

## Why

Today `broker.seek()` (`src/core/social-broker.ts`) does everything in one
blocking call: gate → discover → send → **and inline `confirmWithOwner`, which
WeChat-messages the owner and blocks up to 5 min per match** on their reply
(via the in-memory `pendingConfirms` Map). Two structural problems fall out:

1. **It blocks the caller** for up to `5min × N matches`. A seek initiated from
   a WeChat turn (the P4 "帮我找X" story) deadlocks — the seek blocks waiting
   for the owner's reply while the owner is mid-turn with the bot.
2. **Consent is not durable.** `pendingConfirms` is an in-memory `Map` +
   `setTimeout`; a daemon restart drops every in-flight confirm. Confirms can
   only resolve while the same process lives.

Because dual-confirm happens *inside* the seek, there is also no "reveal later"
operation — which is exactly why the P3 desktop handoff had to say "no reveal
button; nothing to call." This rework unblocks **P4 (WeChat seek flow)**, the
**揭晓 (reveal) button**, and the **live "觅食中" trickle** — all of which were
deferred pending this.

## Scope

**In scope (this spec, "spec #1 — the spine"):**
- Non-blocking `seek()`: sow the wish, forage in the background, return
  immediately.
- Echoes accrue over time as `social_echo` rows (`pending`).
- Dual-confirm moves **out** of `seek()` into a durable, row-driven,
  restart-survivable **reveal** step.
- **Mutual async reveal** ("双向异步互揭"): the owner's reveal action *is* their
  consent; the backend only asks the peer's side; both sides revealing →
  `connected` + identity exchange. Like a mutual right-swipe: two-sided consent,
  neither side blocks.
- Concrete path is **1-hop** (direct paired peers, answering synchronously to
  `send`), but the data model (`degree` first-class) and the reveal/connection
  flow are **structurally multi-hop-ready** — not degree-1-assuming.

**Out of scope (deferred to spec #2 — "the forwarding hop"):**
- A peer *forwarding* a seek to its own peers (the actual 2-hop that lets a user
  see "a friend of a friend"). This is additive on top of the async spine: it
  reuses the same echo intake and reveal protocol with `degree+1`.
- Loop prevention, degree ceilings, anonymous relay across strangers.
- We **never** surface "six degrees" as product copy; echoes simply carry a
  degree number.

## Architecture

**Row-driven, no long-lived in-memory state.** The `social_seek` / `social_echo`
/ `social_pledge` rows *are* the state machine. Everything that used to live in
`pendingConfirms` (an in-memory Map that dies on restart) becomes a durable row
plus an inbound `/a2a/reveal` event. Restart-survivability stops being a feature
that needs machinery and becomes a property of the data model — the same idiom
as the codebase's existing `makeXStore` stores + append-only migrations.

Rejected alternatives:
- **Generic job queue + worker ticker** (a `jobs` table + polling worker): a new
  subsystem, over-engineered for 1-hop where `send` answers synchronously. YAGNI
  now; spec #2's multi-hop could grow toward it if load demands.
- **Keep in-memory + persist only checkpoints:** fragile on restart — precisely
  the `pendingConfirms` trap we are removing.

A "connection" spans **two machines**; each side holds one local row. Reveal =
each side marks its own row + notifies the other; **either side, on seeing "both
marked," transitions to `connected` + exchanges identity.**

## Data Model (append-only migration v20)

### `social_seek` (exists) — unchanged columns; status semantics sharpened
Status lifecycle, with **explicit transition points** (this is also the
restart-resume signal — see Lifecycle):
- `foraging` — the background leg is still running (or pending resume after a
  restart). This is the *only* status that means "background work owes me."
- `echoed` — background leg **completed** with ≥1 echo, not yet connected.
- `connected` — ≥1 echo reached mutual reveal.
- `closed` — background leg completed with 0 echoes (or TTL expired / owner
  closed the wish).

The background leg sets `echoed`/`closed` when it finishes; `connected` is set by
the reveal flow, never by the seek itself.

### `social_echo` (exists) — the seeker's side; a reply to *my* wish. Add 3 columns:
- `peer_agent_id TEXT` — which A2A agent the echo came from. **Server-side only;
  never sent to the frontend before reveal.** Needed to POST the peer's
  `/a2a/reveal`. (Frontend keeps showing `peer_masked`.)
- `self_revealed_at TEXT` — when *I* clicked reveal (my consent leg). Nullable.
- `peer_revealed_at TEXT` — when the peer revealed back. Nullable.
- Both non-null ⇒ mutual reveal ⇒ echo `status='revealed'`, seek `connected`.
  Only `self_revealed_at` set ⇒ "揭晓已发出,等对方" (frontend may render this).

Existing PK stays `intent_id:peer_agent_id` (echo id), which makes repeated
sends/records idempotent.

### `social_pledge` (NEW table) — the answerer's mirror side.
When *my* bot answers *someone else's* wish with `match:'yes'`, it must record a
row, or it can never later reveal back. Symmetric to an echo, but this side has
no local `social_seek` parent row (the wish is the peer's), so it is a separate
table rather than a dangling FK crammed into `social_echo`:
- `id TEXT PRIMARY KEY` (`intent_id:seeker_agent_id`)
- `intent_id TEXT`
- `seeker_agent_id TEXT` — who sought (needed to POST back their `/a2a/reveal`)
- `topic TEXT`
- `self_revealed_at TEXT` — when *this* owner revealed. Nullable.
- `peer_revealed_at TEXT` — when the seeker revealed. Nullable.
- `created_at TEXT`
- Table is `STRICT`; `ORDER BY created_at DESC, rowid DESC` for listing.

### `pendingConfirms` retires from the spine
The in-memory `pendingConfirms` Map (and the `confirmWithOwner` / `confirmPeer`
seams that used it) are removed from the social wiring. Reveal waiting is driven
by rows + the inbound `/a2a/reveal` event, not a process-bound promise.
(`pending-confirm.ts` and `classifyReply` remain in the tree for any other
caller, but the social broker no longer depends on them.)

## Components & Data Flow

### 1. Non-blocking `seek()` (rework `src/core/social-broker.ts`)
- **Synchronous leg** (returns immediately): `gateOutbound(topic)` → write
  `social_seek` (`foraging`) → return `{ intent_id }`.
- **Background leg** (fire-and-forget coroutine, does not block the caller):
  `discover(topic)` → for each candidate `send(card)`; each `match:'yes'`
  writes a `social_echo` row (`pending`, with `peer_agent_id`, `degree=1`,
  sanitized `blurb` as content). The **first** echo written for a seek fires
  notification beat #1. No `confirmWithOwner`, no blocking, inside seek.
- The background leg's store writes stay wrapped in try/catch (P1 principle: a
  persistence error must never undo a network action that already happened).

### 2. Reveal core (one function, two callers)
`reveal(kind: 'echo' | 'pledge', id)`:
1. Write my side's `self_revealed_at = now` (idempotent — re-reveal is a no-op).
2. POST the peer's `/a2a/reveal { agent_id: SOCIAL_SELF_ID, intent_id }`.
3. Interpret the response:
   - `{ mutual: true, identity }` → write my `peer_revealed_at`, set
     `status='revealed'` (echo) / mark pledge connected, set the parent seek
     `connected` (echo side), store the peer identity, fire beat #3 (both sides).
   - `{ mutual: false }` → stop at "revealed, awaiting peer." No error.
   - unreachable/timeout/error → my `self_revealed_at` is already persisted;
     mark "reveal sent, peer unreachable," retryable. **My consent is never
     lost.** Fail-closed: one bad peer never crashes reveal.

### 3. Inbound `POST /a2a/reveal` (new `onReveal` handler in `src/core/a2a-server.ts`)
Capability-gated + Bearer + localhost, exactly like `onIntent`/`onIntentConfirm`
(advertised in the agent card only when wired). Body `{ agent_id, intent_id }` =
"my owner revealed; wants to connect on this intent." Handler:
1. Find my local row for `(intent_id, agent_id)` — an echo (if the caller is
   answering *my* wish) or a pledge (if I answered *theirs*). Write
   `peer_revealed_at = now`.
2. If my `self_revealed_at` is **already** set → mutual. Respond
   `{ mutual: true, identity: <my A2AAgentRecord public identity> }`, mark my
   side `connected`, fire beat #3 on my side.
3. Else → respond `{ mutual: false }`, and fire notification beat #2 ("有人想和
   你牵线") to my owner so they can reveal later.

**Symmetry guarantee:** whoever reveals *second* gets `mutual:true` synchronously
in their own `/a2a/reveal` round-trip — no polling needed on either side.

### 4. Identity exchange
On the mutual instant, each side's `/a2a/reveal` response carries `identity` —
the peer's public `name` + reachable `url` (from `A2AAgentRecord`; no secrets).
It is written onto the local echo/pledge row. **Only then** does the frontend
swap `peer_masked` ("第 1 度的某人") for the real name. Before reveal the real
identity lives only server-side.

### 5. Notifications — three beats (克制三拍)
Hooked into the flows above; each fires **once**:
- **Beat #1 — first echo:** the first `social_echo` written for a seek (seek had
  0 echoes) → "✨ 你的心愿有回声了,去瞧瞧".
- **Beat #2 — someone awaits your reveal:** an inbound `/a2a/reveal` arrives and
  I have not yet revealed my side → "👀 有人想和你牵线,去看看".
- **Beat #3 — connected:** the mutual instant → both sides "🤝 牵上线了 ——
  是<真名>".
- Subsequent echoes on an already-echoed seek do **not** ping (desktop shows
  them quietly) — avoids spamming a popular wish.

### 6. Trigger surfaces
- **Desktop (unblocks P3):** `POST /v1/social/echoes/:id/reveal`,
  `POST /v1/social/pledges/:id/reveal`, and `GET /v1/social/pledges` (mirrors
  P2's read surface). All admin-tiered (route-tiers completeness test), 503 when
  the social broker isn't wired, empty-body guarded (P2 lesson).
- **WeChat (converges P4):** reply "揭晓 #<short-id>", or reply "揭晓" to a
  notification. Reuses the inbound-text path (`resolveByOwner`'s hookpoint) but
  the **semantics change** to *trigger reveal*, not resolve a yes/no
  `pendingConfirm`.

## Lifecycle / Restart
- On boot, scan `social_seek` rows still in `foraging` (the status *is* the
  "background leg unfinished" signal — a completed leg would have moved the row
  to `echoed`/`closed`) → resume `discover`/`send`. Idempotent via the echo PK
  (`intent_id:peer_agent_id`): a duplicate send does not double-insert.
- Reveal waiting needs **no** restart recovery — it is inbound-`/a2a/reveal`-
  event-driven and row-persisted, independent of the process. This is the
  dividend of removing `pendingConfirms`.

## Error Handling (continues existing fail-closed posture)
- `discover` / `send` / peer `/a2a/reveal` failure → skip that peer, keep going;
  one bad/unreachable peer never aborts a seek or a reveal.
- Peer `/a2a/reveal` unreachable → my `self_revealed_at` is already persisted;
  surface "reveal sent, peer unreachable," retryable; consent not lost.
- Store write failure (locked db / disk full) → log, do not alter the network
  action that already happened (P1's try/catch-around-recording principle).
- All outbound `topic` / `city` / `blurb` keep flowing through `gateOutbound`
  + `sanitizeBlurb` — no regression to the existing safety surface.

## Testing (TDD; vitest — note the `import z from 'zod'` v4 gotcha)
- **Unit — reveal reconciliation** (symmetric, both sides): I-reveal-first /
  peer-reveals-first / both-timeout / one-side-unreachable / repeat-reveal
  idempotent / mutual instant returns identity synchronously to the second
  revealer / identity never leaks before reveal.
- **Unit — seek non-blocking:** `seek()` returns before any echo is written; the
  first echo fires beat #1 exactly once; a store failure in the background leg
  does not throw to the caller.
- **Unit — notifications:** each of the three beats fires exactly once at its
  trigger and not on subsequent echoes.
- **Store:** `social_pledge` CRUD + the three new `social_echo` columns; v20
  state-migration smoke test (table count, version number).
- **Routes:** the new reveal/pledge routes tiered (completeness test) + 503
  gating + empty-body guard.
- **e2e:** extend `src/core/social-m1.e2e.test.ts` — sow → echo → desktop reveal
  → peer reveals back → `connected` + identity, verifying nothing blocks.

## Changed Existing Code
- `src/core/social-broker.ts` — `seek` split into sync + background legs; the
  inline confirm phase removed.
- `src/daemon/bootstrap/index.ts` — social wiring drops the `pendingConfirms`
  dependency; wires the row-driven reveal core + the a2a-server `onReveal`
  handler; boot-scan resume for `foraging` seeks.
- `src/core/a2a-server.ts` — add the `onReveal` handler + agent-card advertise.
- `src/daemon/internal-api/routes-social.ts` + `route-tiers.ts` — reveal/pledge
  routes.
- Inbound WeChat pipeline — "揭晓" reveal semantics.
- **Retired from the social wiring:** the `confirmWithOwner` / `confirmPeer`
  synchronous seams and the social broker's use of `pendingConfirms`.

## Open Follow-ups (not this spec)
- **Spec #2 — the forwarding hop:** peers relay unmatched seeks to their own
  peers with `degree+1`, plus loop prevention + degree ceiling + anonymous
  relay. Additive on the intake + reveal protocol built here.
- Reveal-declined path ("不想连") beyond simply never revealing — if an explicit
  decline is wanted later.
