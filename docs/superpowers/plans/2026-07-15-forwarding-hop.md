# Forwarding Hop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a seek reach **a friend of a friend** (2-hop, hard-capped). When a peer can't match a seek itself, its bot forwards the card (`hop+1`) to its OWN paired peers (excluding the sender), aggregates their echoes, and returns them alongside its own `MatchReceipt`. On a successful mutual reveal, the intermediary (介绍人 / W) proxies the two reveal legs via a durable `social_relay` row and crosses the two endpoints' identities from its own registry — no identity ever travels across a hop. Builds on the shipped async foraging spine. See `docs/superpowers/specs/2026-07-15-forwarding-hop-design.md`.

**Architecture:** Row-driven, no long-lived in-memory state — `social_seek` / `social_echo` / `social_pledge` / `social_relay` / `social_seen_intent` rows **are** the state machine. Forwarding is a pure aggregator core (`makeForwarder`) that wraps the spine's `answerLocally` (judge + pledge) and, when `card.hop < 2`, fans the `hop+1` card out to the responder's own peers, minting an opaque `relay_token` + `social_relay` row per downstream `yes`. The seeker's `/a2a/intent` response is a backward-compatible superset: the responder's own `MatchReceipt` plus an optional `forwarded?: ForwardedEcho[]`. Reveal reuses the spine's `makeRevealer` extended with a **relay branch** (the seeker's relay echo carries `relay_via` + `relay_token`, its reveal is addressed to W), plus a new **`makeRelayReconciler`** that runs on W and pivots the two legs on the `social_relay` row. Whoever reveals **second** learns `mutual:true` synchronously; the first revealer's leg is completed by W's post-back. Loop prevention = hop ceiling (`< 2`) + never-forward-to-sender + `social_seen_intent` dedup.

**Tech Stack:** TypeScript, Bun runtime, Vitest. SQLite via `bun:sqlite` (`src/lib/db.ts`, append-only migrations). Stores follow the `makeXStore(db: Db)` idiom; A2A HTTP server/client (`src/core/a2a-server.ts` / `a2a-client.ts`); social wiring in `src/daemon/bootstrap/index.ts`.

## Global Constraints

- **Runtime is Bun.** Single test file: `bun run test <path>`. Typecheck: `bun run typecheck`. Run typecheck after any task that changes a shared type (1, 2, 5, 7, 8). Vitest transpiles (no typecheck), so a per-task test can be **green** while `bun run typecheck` is still **red** on a not-yet-wired ripple — that is expected until Task 8 makes the tree clean.
- **zod v4 gotcha:** in *test* files use `import z from 'zod'` (default import). `import { z } from 'zod'` is `undefined` under vitest here. (No test in this plan needs zod directly; obey this if you add one.)
- **Store idiom (mirror `social-echo-store.ts` / `social-pledge-store.ts`):** `makeXStore(db: Db)` returns an object literal of methods; prepared statements via `db.query<Row, Params>(sql)`; tables `STRICT`; list order `ORDER BY created_at DESC, rowid DESC`. `Db` is `import type { Db } from '../lib/db'`.
- **Migrations** live in `src/lib/db.ts` `const migrations: Migration[]` — append a new `(db) => { db.exec(...) }` at the END (after the v20 entry that closes `~:503`), never edit a shipped one. Nullable-TEXT `ADD COLUMN` is safe on STRICT tables. The v19 entry always runs `CREATE TABLE IF NOT EXISTS social_echo` before v20/v21, so v21's `ALTER TABLE social_echo` is safe even in the `PRAGMA user_version = 9` → `runMigrations` harnesses — **no guard needed**.
- **a2a-server:** inbound handlers are capability-gated (advertised in the agent card only when the opt is wired), Bearer-auth'd, and follow a fixed body-parse → auth → dispatch → error-shape order. The `/a2a/reveal` handler acts as the **verified Bearer** `agent.id` — client-supplied `agent_id` is never trusted as the acting identity. `relay_token` / `peer_name` are additional optional body fields it forwards.
- **fail-closed posture (load-bearing):** one bad/unreachable forward target never aborts the aggregation or the reveal (try/catch continue). Store-write failures are logged, never thrown to a caller whose network action already happened. `postPeerReveal` returning `null` (unreachable) must **never** lose the caller's already-persisted `self_revealed_at`.
- **Backward-compat (load-bearing):** `IntentCard.hop` is `z.number().int().min(1).default(1)` — an old seeker's card has **no** `hop` and must still `safeParse` (default fills it). `MatchReceiptSchema` gains `forwarded: z.array(ForwardedEchoSchema).optional()` — an old seeker parsing with the OLD schema strips it silently; an old responder never produces it.
- **Anonymity:** a forwarded card carries only `intent_id`, `kind`, `topic`, (optional `city`,) and `hop` — never the originator's identity. `relay_token` is opaque and meaningful only to W; the seeker cannot use it to reach the downstream peer. Identity crosses only at the mutual instant, handed over by W (adjacent to both), never relayed across a hop.
- **Consistency of names across tasks (must match exactly):**
  - `IntentCard` gains `hop: number`; `ForwardedEcho = { blurb: string; degree: number; relay_token: string }`; `MatchReceipt` gains `forwarded?: ForwardedEcho[]` (Task 1).
  - `EchoRow`/`EchoStore.create` gain `relay_via` / `relay_token`; `peerAgentId` widens to `string | null` (Task 2).
  - `RelayStore` = `create` / `get` / `getByIntentDownstream` / `setUpstreamRevealed` / `setDownstreamRevealed` / `list`; `SeenIntentStore` = `markSeen` / `hasSeen` (Task 3). Relay id = `intent_id:relay_token`.
  - `makeForwarder<T extends { id: string }>(deps)` → `(event: IntentEvent) => Promise<MatchReceipt>` (Task 4).
  - `postPeerReveal(agentId, intentId, relayToken?)`; `onInboundReveal({ agentId, intentId, relayToken?, peerName? })` (Task 5).
  - `makeRelayReconciler(deps)` → `{ onRelayReveal({ callerAgentId, intentId, relayToken? }): { mutual: boolean; identity?: PeerIdentity } | null }` (Task 6).
  - `RevealEvent` gains `relay_token?: string`, `peer_name?: string` (Task 7).

---

## File Structure

- **Modify** `src/lib/db.ts` — append migration v21 (Task 1).
- **Modify** `src/lib/state-migration.test.ts` — v20→v21, 18→20 tables (Task 1).
- **Modify** `src/core/a2a-intent.ts` — `hop`, `ForwardedEcho`, `forwarded` (Task 1).
- **Modify** `src/core/social-broker.ts` + `src/core/social-answer.test.ts` — card `hop:1` typecheck ripple (Task 1).
- **Modify** `src/core/social-echo-store.ts` + `src/core/social-echo-store.test.ts` — relay columns (Task 2).
- **Create** `src/core/social-relay-store.ts` + `src/core/social-relay-store.test.ts` (Task 3).
- **Create** `src/core/social-seen-intent-store.ts` + `src/core/social-seen-intent-store.test.ts` (Task 3).
- **Create** `src/core/social-forwarder.ts` + `src/core/social-forwarder.test.ts` (Task 4).
- **Modify** `src/core/social-reveal.ts` + `src/core/social-reveal.test.ts` — relay branch (Task 5).
- **Create** `src/core/social-relay-reveal.ts` + `src/core/social-relay-reveal.test.ts` (Task 6).
- **Modify** `src/core/a2a-server.ts` + `src/core/a2a-server.test.ts` — `RevealEvent` relay fields (Task 7).
- **Modify** `src/core/social-broker.ts` + `src/core/social-broker.test.ts` — record forwarded (relay) echoes (Task 7).
- **Modify** `src/daemon/bootstrap/index.ts` + `src/daemon/bootstrap.test.ts` — forwarder + reconciler + reveal-relay wiring (Task 7).
- **Modify** `src/core/social-m1.e2e.test.ts` (add S→W→Q e2e + compat) (Task 8).

---

## Task 1: Migration v21 + wire schema (`hop`, `ForwardedEcho`, `forwarded`)

**Files:**
- Modify: `src/lib/db.ts` (append to `migrations`, after the v20 entry closing `~:503`)
- Modify: `src/lib/state-migration.test.ts` (`~:64`–`:79`)
- Modify: `src/core/a2a-intent.ts`
- Modify: `src/core/social-broker.ts` (`forage` card literal, `~:54`) — typecheck ripple
- Modify: `src/core/social-answer.test.ts` (`:5` card fixture) — typecheck ripple

**Interfaces:**
- Consumes: nothing (schema + wire types only).
- Produces: `social_echo` gains `relay_via TEXT`, `relay_token TEXT` (nullable); new STRICT tables `social_relay` + `social_seen_intent`; `PRAGMA user_version` → 21; table count 18→20. `IntentCard` gains `hop: number`; `ForwardedEcho = { blurb: string; degree: number; relay_token: string }`; `MatchReceipt` gains `forwarded?: ForwardedEcho[]`.

- [ ] **Step 1: Failing migration smoke test** — edit `src/lib/state-migration.test.ts`. Rename the `it('opens a fresh db with PRAGMA user_version = 20 and the 18 tables', ...)` block to `= 21 and the 20 tables`, bump the expectation, add a comment line, and insert `'social_relay'` + `'social_seen_intent'` into the sorted list (they sort between `social_pledge` and `thread_extract_state`; note `social_seek` < `social_seen_intent`):

```ts
  it('opens a fresh db with PRAGMA user_version = 21 and the 20 tables', () => {
    const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    // v19 (agent-social 觅食台 state): social_seek + social_echo tables added.
    // v20 (async foraging spine): social_echo reveal columns + social_pledge table added.
    // v21 (forwarding hop): social_echo relay columns + social_relay + social_seen_intent tables added.
    expect(v).toBe(21)
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toEqual([
      'a2a_events', 'activity', 'connection_heartbeat', 'conversations', 'events', 'handled_messages', 'message_attempts', 'messages',
      'milestones', 'observations', 'session_state', 'sessions', 'social_echo', 'social_pledge', 'social_relay', 'social_seek', 'social_seen_intent', 'thread_extract_state', 'threads', 'turn_records',
    ])
  })
```

- [ ] **Step 2: Run to verify it fails** — Run: `bun run test src/lib/state-migration.test.ts`. Expected: FAIL — `user_version` is 20; `social_relay` / `social_seen_intent` missing.

- [ ] **Step 3: Append migration v21** — in `src/lib/db.ts`, add a new entry at the END of `migrations` (immediately after the v20 entry's closing `},` at `~:503`, before the array-closing `]`):

```ts
  // v21 — forwarding hop (spec #2). Two nullable relay columns on social_echo
  // (the seeker's degree-2 echoes) + the intermediary's social_relay table
  // (links the two proxied reveal legs) + social_seen_intent (loop-prevention
  // dedup). Nullable-TEXT ADD COLUMN is safe on STRICT; social_echo is created
  // unconditionally by v19, so the ALTER is safe even in user_version=9 harnesses.
  // See docs/superpowers/specs/2026-07-15-forwarding-hop-design.md.
  (db) => {
    db.exec(`
      ALTER TABLE social_echo ADD COLUMN relay_via TEXT;
      ALTER TABLE social_echo ADD COLUMN relay_token TEXT;
      CREATE TABLE IF NOT EXISTS social_relay (
        id                     TEXT PRIMARY KEY,   -- intent_id:relay_token
        intent_id              TEXT NOT NULL,
        relay_token            TEXT NOT NULL,
        upstream_agent_id      TEXT NOT NULL,       -- who W received the card from (the seeker S)
        downstream_agent_id    TEXT NOT NULL,       -- who W forwarded to + got the yes from (Q)
        upstream_revealed_at   TEXT,                -- S revealed to W (nullable)
        downstream_revealed_at TEXT,                -- Q revealed to W (nullable)
        created_at             TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_social_relay_intent_downstream ON social_relay(intent_id, downstream_agent_id);
      CREATE TABLE IF NOT EXISTS social_seen_intent (
        intent_id     TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL,
        expires_at    TEXT NOT NULL
      ) STRICT;
    `)
  },
```

- [ ] **Step 3b: Confirm the low-level db migration test still passes** — Run: `bun run test src/lib/db.test.ts`. Expected: PASS (v19 `CREATE TABLE IF NOT EXISTS social_echo` runs before v21's ALTER).

- [ ] **Step 4: Run the smoke test** — Run: `bun run test src/lib/state-migration.test.ts`. Expected: PASS.

- [ ] **Step 5: Wire the schema types** — replace `src/core/a2a-intent.ts` entirely with:

```ts
import z from 'zod'
import { randomUUID } from 'node:crypto'

export const IntentCardSchema = z.object({
  intent_id: z.string().min(1),
  kind: z.literal('seek'),                 // M1: seek only
  topic: z.string().min(1).max(280),       // policy-filtered NL — the intent, not raw data
  city: z.string().max(64).optional(),
  expires_at: z.string().min(1),           // ISO-8601; peer drops stale ones
  // spec #2 forwarding: a seek leaves the seeker with hop=1; a relay forwards
  // with hop+1 only while hop < 2. OPTIONAL with a default so an old seeker's
  // card (no hop) still safeParses and lands hop=1.
  hop: z.number().int().min(1).default(1),
})
export type IntentCard = z.infer<typeof IntentCardSchema>

// A degree-2 echo aggregated by an intermediary and returned to the seeker
// alongside the intermediary's own MatchReceipt. `relay_token` is opaque and
// meaningful only to the intermediary (it maps to the downstream peer there).
export const ForwardedEchoSchema = z.object({
  blurb: z.string().max(280),
  degree: z.number().int(),
  relay_token: z.string().min(1),
})
export type ForwardedEcho = z.infer<typeof ForwardedEchoSchema>

export const MatchReceiptSchema = z.object({
  intent_id: z.string().min(1),
  match: z.enum(['yes', 'no']),
  blurb: z.string().max(280).optional(),   // only on yes; policy-filtered; NO contact info
  // spec #2: degree-2 echoes forwarded by this responder. Backward-compatible
  // superset — an old seeker parsing with the OLD schema drops it silently.
  forwarded: z.array(ForwardedEchoSchema).optional(),
})
export type MatchReceipt = z.infer<typeof MatchReceiptSchema>

export function newIntentId(): string { return randomUUID() }
```

- [ ] **Step 6: Fix the `hop` typecheck ripple** — `IntentCard` (z.infer output) now requires `hop`. Two hand-built card literals need it:
  - `src/core/social-broker.ts` `forage()` (`~:54`): add `hop: 1,` to the `const card: IntentCard = { ... }` object (the seek leaves the seeker with hop=1):

```ts
    const card: IntentCard = {
      intent_id: intentId, kind: 'seek', topic: gated.redacted, hop: 1,
      ...(cardCity ? { city: cardCity } : {}),
      expires_at: new Date(Date.now() + ttl).toISOString(),
    }
```

  - `src/core/social-answer.test.ts` (`:5`): add `hop: 1` to the shared `card` fixture:

```ts
const card = { intent_id: 'i1', kind: 'seek' as const, topic: '找摄影搭子', hop: 1, expires_at: new Date(Date.now()+60000).toISOString() }
```

  (a2a-server.test.ts card literals sit inside untyped fetch bodies — no annotation, no ripple. The broker/e2e sends flow the parsed card, so no other literal needs `hop`.)

- [ ] **Step 7: Confirm existing intent/receipt tests + typecheck** — Run: `bun run test src/core/social-answer.test.ts src/core/social-broker.test.ts` (PASS — the optional `forwarded` field and defaulted `hop` don't change any assertion), then `bun run typecheck` (CLEAN).

- [ ] **Step 8: Commit** — `feat(social): migration v21 + wire hop/ForwardedEcho/forwarded schema (fwd T1)`.

---

## Task 2: Echo store relay columns

**Files:**
- Modify: `src/core/social-echo-store.ts`
- Test: `src/core/social-echo-store.test.ts`

**Interfaces:**
- Consumes: the v21 `social_echo.relay_via` / `relay_token` columns (Task 1).
- Produces: `EchoRow` gains `relay_via: string | null; relay_token: string | null`; `EchoStore.create` widens `peerAgentId` to `string | null` and accepts optional `relayVia?`/`relayToken?`. A direct echo passes a string `peerAgentId` (id `intent_id:peer_agent_id`); a relay echo passes `peerAgentId: null` + `relayVia`/`relayToken` (id `intent_id:relay_via:relay_token`).

- [ ] **Step 1: Failing test** — append to `src/core/social-echo-store.test.ts`:

```ts
  it('creates a relay (degree-2) echo with a null peer + relay_via/relay_token, gettable by relay id', () => {
    const db = openDb({ path: ':memory:' })
    const e = makeEchoStore(db)
    // Relay echo id is intent_id:relay_via:relay_token; peer_agent_id is null.
    e.create({ id: 'i1:ccw:tok', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: '经W转发的回声', peerAgentId: null, relayVia: 'ccw', relayToken: 'tok' })
    const r = e.get('i1:ccw:tok')!
    expect(r.peer_agent_id).toBeNull()
    expect(r.relay_via).toBe('ccw')
    expect(r.relay_token).toBe('tok')
    expect(r.degree).toBe(2)
    // A direct echo still stores relay_* as null.
    e.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    const d = e.get('i1:ccb')!
    expect(d.peer_agent_id).toBe('ccb')
    expect(d.relay_via).toBeNull()
    expect(d.relay_token).toBeNull()
  })
```

- [ ] **Step 2: Run to verify it fails** — Run: `bun run test src/core/social-echo-store.test.ts`. Expected: FAIL — `create` rejects `relayVia`/`null peerAgentId`; `relay_via`/`relay_token` undefined on the row.

- [ ] **Step 3: Add the columns + widen create** — in `src/core/social-echo-store.ts`, extend `EchoRow`, the `EchoStore.create` signature, the INSERT statement + its param tuple, and the `create` impl:

```ts
export interface EchoRow {
  id: string; seek_id: string; peer_masked: string; degree: number
  content: string; status: 'pending' | 'revealed' | 'declined'; created_at: string
  peer_agent_id: string | null
  self_revealed_at: string | null
  peer_revealed_at: string | null
  relay_via: string | null
  relay_token: string | null
}
export interface EchoStore {
  create(e: { id: string; seekId: string; peerMasked: string; degree: number; content: string; peerAgentId: string | null; relayVia?: string; relayToken?: string }): void
  setStatus(id: string, status: EchoRow['status']): void
  /** Write self_revealed_at (my consent leg). */
  setSelfRevealed(id: string, at: string): void
  /** Write peer_revealed_at (the peer revealed back). */
  setPeerRevealed(id: string, at: string): void
  /** Post-reveal: swap the masked placeholder for the peer's real name. */
  setRevealedIdentity(id: string, name: string): void
  listForSeek(seekId: string): EchoRow[]
  listAll(): EchoRow[]
  get(id: string): EchoRow | null
}
```

Replace the `ins` prepared statement + the `create` method:

```ts
  const ins = db.query<unknown, [string, string, string, number, string, string, string | null, string | null, string | null]>(
    `INSERT INTO social_echo(id, seek_id, peer_masked, degree, content, status, created_at, peer_agent_id, relay_via, relay_token)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  )
```

```ts
    create(e) { ins.run(e.id, e.seekId, e.peerMasked, e.degree, e.content, new Date().toISOString(), e.peerAgentId, e.relayVia ?? null, e.relayToken ?? null) },
```

- [ ] **Step 4: Run to verify PASS** — Run: `bun run test src/core/social-echo-store.test.ts`. Expected: PASS (both existing tests + the new relay test).

- [ ] **Step 5: Verify the ripple is compatible** — widening `peerAgentId` to `string | null` is source-compatible for every existing caller passing a string. Confirm no consumer read of `peer_agent_id` as non-null breaks: `grep -rn "peer_agent_id\|peerAgentId" src --include='*.ts'`. The only impl reads are in `social-reveal.ts` (guarded by `if (!echo.peer_agent_id) return ...`) and bootstrap `recordEcho` (passes a string). Run: `bun run typecheck`. Expected: CLEAN.

- [ ] **Step 6: Commit** — `feat(social): social_echo relay_via/relay_token columns + nullable peer (fwd T2)`.

---

## Task 3: Relay store + seen-intent store (new)

**Files:**
- Create: `src/core/social-relay-store.ts`, `src/core/social-relay-store.test.ts`
- Create: `src/core/social-seen-intent-store.ts`, `src/core/social-seen-intent-store.test.ts`

**Interfaces:**
- Consumes: v21 `social_relay` + `social_seen_intent` tables (Task 1).
- Produces: `RelayStore` = `create` / `get` / `getByIntentDownstream` / `setUpstreamRevealed` / `setDownstreamRevealed` / `list`; `SeenIntentStore` = `markSeen` / `hasSeen`.

- [ ] **Step 1: Failing relay-store test** — create `src/core/social-relay-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeRelayStore } from './social-relay-store'

describe('makeRelayStore', () => {
  it('creates relays, gets by id + by (intent,downstream), records both reveal legs, lists newest-first', () => {
    const db = openDb({ path: ':memory:' })
    const r = makeRelayStore(db)
    r.create({ id: 'i1:tokA', intentId: 'i1', relayToken: 'tokA', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    r.create({ id: 'i2:tokB', intentId: 'i2', relayToken: 'tokB', upstreamAgentId: 'ccs', downstreamAgentId: 'ccz' })
    expect(r.list().map(x => x.id)).toEqual(['i2:tokB', 'i1:tokA'])   // newest first

    const byId = r.get('i1:tokA')!
    expect(byId.intent_id).toBe('i1')
    expect(byId.upstream_agent_id).toBe('ccs')
    expect(byId.downstream_agent_id).toBe('ccq')
    expect(byId.upstream_revealed_at).toBeNull()
    expect(byId.downstream_revealed_at).toBeNull()

    const byPair = r.getByIntentDownstream('i1', 'ccq')!
    expect(byPair.id).toBe('i1:tokA')
    expect(r.getByIntentDownstream('i1', 'nobody')).toBeNull()

    r.setUpstreamRevealed('i1:tokA', '2026-07-15T00:00:00.000Z')
    r.setDownstreamRevealed('i1:tokA', '2026-07-15T00:01:00.000Z')
    const after = r.get('i1:tokA')!
    expect(after.upstream_revealed_at).toBe('2026-07-15T00:00:00.000Z')
    expect(after.downstream_revealed_at).toBe('2026-07-15T00:01:00.000Z')
    expect(r.get('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — Run: `bun run test src/core/social-relay-store.test.ts`. Expected: FAIL — module `./social-relay-store` does not exist.

- [ ] **Step 3: Implement the relay store** — create `src/core/social-relay-store.ts`:

```ts
/**
 * social-relay-store.ts — the INTERMEDIARY's (介绍人 / W) side of a 2-hop
 * connection. When W forwards a seek and a downstream peer answers yes, W mints
 * a relay_token and persists this row linking the two reveal legs. Both
 * *_revealed_at set ⇒ W declares mutual and crosses the endpoints' identities.
 * Row-driven + durable → survives a W restart (spec #2 reveal relay).
 */
import type { Db } from '../lib/db'

export interface RelayRow {
  id: string; intent_id: string; relay_token: string
  upstream_agent_id: string; downstream_agent_id: string
  upstream_revealed_at: string | null; downstream_revealed_at: string | null
  created_at: string
}
export interface RelayStore {
  /** Persist a relay leg. id = `intent_id:relay_token`. */
  create(r: { id: string; intentId: string; relayToken: string; upstreamAgentId: string; downstreamAgentId: string }): void
  get(id: string): RelayRow | null
  /** Resolve the downstream (Q) leg when a reveal arrives WITHOUT a relay_token. */
  getByIntentDownstream(intentId: string, downstreamAgentId: string): RelayRow | null
  setUpstreamRevealed(id: string, at: string): void
  setDownstreamRevealed(id: string, at: string): void
  list(): RelayRow[]
}

export function makeRelayStore(db: Db): RelayStore {
  const ins = db.query<unknown, [string, string, string, string, string, string]>(
    `INSERT INTO social_relay(id, intent_id, relay_token, upstream_agent_id, downstream_agent_id, upstream_revealed_at, downstream_revealed_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
  )
  const selOne = db.query<RelayRow, [string]>('SELECT * FROM social_relay WHERE id = ?')
  const selByPair = db.query<RelayRow, [string, string]>(
    'SELECT * FROM social_relay WHERE intent_id = ? AND downstream_agent_id = ? ORDER BY created_at DESC, rowid DESC',
  )
  const selAll = db.query<RelayRow, []>('SELECT * FROM social_relay ORDER BY created_at DESC, rowid DESC')
  const updUp = db.query<unknown, [string, string]>('UPDATE social_relay SET upstream_revealed_at = ? WHERE id = ?')
  const updDown = db.query<unknown, [string, string]>('UPDATE social_relay SET downstream_revealed_at = ? WHERE id = ?')
  return {
    create(r) { ins.run(r.id, r.intentId, r.relayToken, r.upstreamAgentId, r.downstreamAgentId, new Date().toISOString()) },
    get(id) { return selOne.get(id) ?? null },
    getByIntentDownstream(intentId, downstreamAgentId) { return selByPair.get(intentId, downstreamAgentId) ?? null },
    setUpstreamRevealed(id, at) { updUp.run(at, id) },
    setDownstreamRevealed(id, at) { updDown.run(at, id) },
    list() { return selAll.all() },
  }
}
```

- [ ] **Step 4: Run to verify PASS** — Run: `bun run test src/core/social-relay-store.test.ts`. Expected: PASS.

- [ ] **Step 5: Failing seen-intent test** — create `src/core/social-seen-intent-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeSeenIntentStore } from './social-seen-intent-store'

describe('makeSeenIntentStore', () => {
  it('marks an intent seen once (idempotent) and answers hasSeen', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeenIntentStore(db)
    expect(s.hasSeen('i1')).toBe(false)
    s.markSeen({ intentId: 'i1', expiresAt: '2026-07-15T01:00:00.000Z' })
    expect(s.hasSeen('i1')).toBe(true)
    // Idempotent: a second markSeen (diamond path / cycle) does not throw on the PK.
    s.markSeen({ intentId: 'i1', expiresAt: '2026-07-15T02:00:00.000Z' })
    expect(s.hasSeen('i1')).toBe(true)
    expect(s.hasSeen('other')).toBe(false)
  })
})
```

- [ ] **Step 6: Run to verify it fails** — Run: `bun run test src/core/social-seen-intent-store.test.ts`. Expected: FAIL — module missing.

- [ ] **Step 7: Implement the seen-intent store** — create `src/core/social-seen-intent-store.ts`:

```ts
/**
 * social-seen-intent-store.ts — forwarding loop-prevention dedup (spec #2). A
 * relay records each intent_id it has forwarded; a second arrival of the same
 * intent_id (diamond path / cycle) is skipped, not re-forwarded. INSERT OR
 * IGNORE keeps markSeen idempotent on the PK.
 */
import type { Db } from '../lib/db'

export interface SeenIntentRow { intent_id: string; first_seen_at: string; expires_at: string }
export interface SeenIntentStore {
  markSeen(s: { intentId: string; expiresAt: string }): void
  hasSeen(intentId: string): boolean
}

export function makeSeenIntentStore(db: Db): SeenIntentStore {
  const ins = db.query<unknown, [string, string, string]>(
    `INSERT OR IGNORE INTO social_seen_intent(intent_id, first_seen_at, expires_at) VALUES (?, ?, ?)`,
  )
  const sel = db.query<{ one: number }, [string]>('SELECT 1 as one FROM social_seen_intent WHERE intent_id = ?')
  return {
    markSeen(s) { ins.run(s.intentId, new Date().toISOString(), s.expiresAt) },
    hasSeen(intentId) { return sel.get(intentId) != null },
  }
}
```

- [ ] **Step 8: Run to verify PASS** — Run: `bun run test src/core/social-seen-intent-store.test.ts`. Expected: PASS. Then `bun run typecheck` (CLEAN).

- [ ] **Step 9: Commit** — `feat(social): relay-store + seen-intent-store (fwd T3)`.

---

## Task 4: Forwarding aggregator core (`makeForwarder`)

**Files:**
- Create: `src/core/social-forwarder.ts`, `src/core/social-forwarder.test.ts`

**Interfaces:**
- Consumes: `IntentEvent` (`a2a-server.ts`), `IntentCard` / `MatchReceipt` / `ForwardedEcho` (Task 1).
- Produces: `makeForwarder<T extends { id: string }>(deps)` → `(event: IntentEvent) => Promise<MatchReceipt>`. Deps: `answerLocally(event) => Promise<MatchReceipt>`; `forwardTargets(excludeAgentId) => T[]`; `forwardSend(target, card) => Promise<MatchReceipt | null>`; `recordRelay(intentId, upstreamAgentId, downstreamAgentId) => string` (persists the relay row keyed to the sender=upstream + the downstream peer, returns the minted `relay_token`); `markSeen(intentId, expiresAt) => void`; `hasSeen(intentId) => boolean`; `hopCap?: number` (=2). The upstream is `event.agent.id` (the seeker as this responder sees it) — the forwarder threads it into `recordRelay` so W can later resolve S's identity from its registry.

- [ ] **Step 1: Failing test** — create `src/core/social-forwarder.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeForwarder } from './social-forwarder'
import type { IntentEvent } from './a2a-server'
import type { IntentCard, MatchReceipt } from './a2a-intent'

function card(over: Partial<IntentCard> = {}): IntentCard {
  return { intent_id: 'i1', kind: 'seek', topic: 't', hop: 1, expires_at: '2026-07-15T01:00:00.000Z', ...over }
}
function event(agentId: string, over: Partial<IntentCard> = {}): IntentEvent {
  return { agent: { id: agentId } as any, card: card(over) }
}

describe('makeForwarder', () => {
  it('judges locally AND forwards hop+1 to peers minus sender, aggregating degree-2 echoes', async () => {
    const answerLocally = vi.fn(async (): Promise<MatchReceipt> => ({ intent_id: 'i1', match: 'no' }))
    const forwardSend = vi.fn(async (_t: { id: string }, _c: IntentCard): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'yes', blurb: '我认识个摄影师' }))
    const recordRelay = vi.fn((_i: string, _up: string, downstream: string) => `tok-${downstream}`)
    const forwardTargets = vi.fn((exclude: string) => [{ id: 'ccq' }, { id: 'ccr' }].filter(t => t.id !== exclude))
    const fwd = makeForwarder({ answerLocally, forwardTargets, forwardSend, recordRelay, markSeen: vi.fn(), hasSeen: () => false })

    const r = await fwd(event('ccs'))

    expect(r.match).toBe('no')
    expect(forwardTargets).toHaveBeenCalledWith('ccs')
    // hop+1 card forwarded to each of the 2 targets.
    expect(forwardSend).toHaveBeenCalledTimes(2)
    expect(forwardSend.mock.calls[0]![1].hop).toBe(2)
    expect(r.forwarded).toEqual([
      { blurb: '我认识个摄影师', degree: 2, relay_token: 'tok-ccq' },
      { blurb: '我认识个摄影师', degree: 2, relay_token: 'tok-ccr' },
    ])
  })

  it('excludes the sender from forward targets', async () => {
    const forwardTargets = vi.fn((exclude: string) => [{ id: 'ccs' }, { id: 'ccq' }].filter(t => t.id !== exclude))
    const forwardSend = vi.fn(async (): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'no' }))
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets, forwardSend, recordRelay: () => 'tok', markSeen: vi.fn(), hasSeen: () => false })
    await fwd(event('ccs'))
    expect(forwardSend).toHaveBeenCalledTimes(1)   // ccs (sender) excluded, only ccq sent
  })

  it('hop cap: a hop=2 card is terminal — judged locally, never forwarded', async () => {
    const forwardSend = vi.fn(async (): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'yes', blurb: 'x' }))
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'yes', blurb: 'me' }), forwardTargets: () => [{ id: 'ccq' }], forwardSend, recordRelay: () => 'tok', markSeen: vi.fn(), hasSeen: () => false })
    const r = await fwd(event('ccs', { hop: 2 }))
    expect(forwardSend).not.toHaveBeenCalled()
    expect(r.forwarded).toBeUndefined()
    expect(r.match).toBe('yes')
  })

  it('dedup: a seen intent is answered locally but not re-forwarded', async () => {
    const forwardSend = vi.fn(async (): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'yes' }))
    const markSeen = vi.fn()
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [{ id: 'ccq' }], forwardSend, recordRelay: () => 'tok', markSeen, hasSeen: () => true })
    const r = await fwd(event('ccs'))
    expect(forwardSend).not.toHaveBeenCalled()
    expect(markSeen).not.toHaveBeenCalled()   // already seen → not re-marked
    expect(r.forwarded).toBeUndefined()
  })

  it('marks an unseen intent seen before forwarding', async () => {
    const markSeen = vi.fn()
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [], forwardSend: async () => null, recordRelay: () => 'tok', markSeen, hasSeen: () => false })
    await fwd(event('ccs'))
    expect(markSeen).toHaveBeenCalledWith('i1', '2026-07-15T01:00:00.000Z')
  })

  it('one bad target is skipped, the rest aggregate (fail-closed)', async () => {
    const forwardSend = vi.fn(async (t: { id: string }): Promise<MatchReceipt | null> => {
      if (t.id === 'bad') throw new Error('boom')
      return { intent_id: 'i1', match: 'yes', blurb: 'ok' }
    })
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [{ id: 'bad' }, { id: 'ccq' }], forwardSend, recordRelay: (_i, _up, d) => `tok-${d}`, markSeen: vi.fn(), hasSeen: () => false })
    const r = await fwd(event('ccs'))
    expect(r.forwarded).toEqual([{ blurb: 'ok', degree: 2, relay_token: 'tok-ccq' }])
  })

  it('no yes downstream → forwarded omitted (not an empty array)', async () => {
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [{ id: 'ccq' }], forwardSend: async () => ({ intent_id: 'i1', match: 'no' }), recordRelay: () => 'tok', markSeen: vi.fn(), hasSeen: () => false })
    const r = await fwd(event('ccs'))
    expect(r.forwarded).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — Run: `bun run test src/core/social-forwarder.test.ts`. Expected: FAIL — module missing.

- [ ] **Step 3: Implement the forwarder** — create `src/core/social-forwarder.ts`:

```ts
/**
 * social-forwarder.ts — the forward heart (spec #2). Wraps the spine's local
 * answer (judge + pledge) into a "judge + forward": judge locally, then — while
 * the card is within the hop cap and this intent has not been seen before —
 * fan the hop+1 card out to the responder's OWN paired peers (excluding the
 * sender), minting a relay per downstream `yes`, and aggregate their degree-2
 * echoes onto the response. Pure + injected; loop prevention (hop ceiling +
 * never-forward-to-sender + seen-intent dedup) lives here; the network/persist
 * seams are injected. Fail-closed: one bad target never aborts the aggregation.
 */
import type { IntentEvent } from './a2a-server'
import type { IntentCard, MatchReceipt, ForwardedEcho } from './a2a-intent'

export interface ForwarderDeps<T extends { id: string }> {
  /** The existing local answer (makeAnswerIntent + pledge on match:yes). */
  answerLocally(event: IntentEvent): Promise<MatchReceipt>
  /** This responder's paired peers, MINUS the sender. */
  forwardTargets(excludeAgentId: string): T[]
  /** POST the hop+1 card to a peer's /a2a/intent. null on unreachable. */
  forwardSend(target: T, card: IntentCard): Promise<MatchReceipt | null>
  /** Persist a social_relay row for a downstream yes; returns the minted relay_token.
   *  upstreamAgentId = the sender (event.agent.id), so W can later resolve S's identity. */
  recordRelay(intentId: string, upstreamAgentId: string, downstreamAgentId: string): string
  markSeen(intentId: string, expiresAt: string): void
  hasSeen(intentId: string): boolean
  /** Depth cap; forward only while card.hop < hopCap. Default 2. */
  hopCap?: number
}

export function makeForwarder<T extends { id: string }>(deps: ForwarderDeps<T>): (event: IntentEvent) => Promise<MatchReceipt> {
  return async (event) => {
    const card = event.card
    const receipt = await deps.answerLocally(event)   // always judge locally first

    const cap = deps.hopCap ?? 2
    const alreadySeen = deps.hasSeen(card.intent_id)
    if (!alreadySeen) {
      // Loop prevention: record BEFORE forwarding so a diamond re-arrival dedups.
      // A persistence hiccup must not abort a network action we may still take.
      try { deps.markSeen(card.intent_id, card.expires_at) } catch { /* logged by dep impl */ }
    }
    // Skip forwarding when: already seen (dedup), or at/over the hop ceiling.
    if (alreadySeen || card.hop >= cap) return receipt

    const forwarded: ForwardedEcho[] = []
    for (const target of deps.forwardTargets(event.agent.id)) {
      try {
        const fwdCard: IntentCard = { ...card, hop: card.hop + 1 }
        const r = await deps.forwardSend(target, fwdCard)
        if (r && r.match === 'yes') {
          const relayToken = deps.recordRelay(card.intent_id, event.agent.id, target.id)
          forwarded.push({ blurb: r.blurb ?? '', degree: card.hop + 1, relay_token: relayToken })
        }
      } catch {
        // One bad/unreachable target (or a relay-write that threw) must never
        // abort the rest of the aggregation. Fail closed — skip and continue.
        continue
      }
    }
    return forwarded.length > 0 ? { ...receipt, forwarded } : receipt
  }
}
```

- [ ] **Step 4: Run to verify PASS** — Run: `bun run test src/core/social-forwarder.test.ts`. Expected: PASS (all cases). Then `bun run typecheck` (CLEAN).

- [ ] **Step 5: Commit** — `feat(social): forwarding aggregator core makeForwarder (fwd T4)`.

---

## Task 5: Reveal core — relay branch on the endpoint (seeker side)

**Files:**
- Modify: `src/core/social-reveal.ts`
- Test: `src/core/social-reveal.test.ts`

**Interfaces:**
- Consumes: `EchoStore` relay columns (Task 2).
- Produces: `postPeerReveal` widens to `(agentId, intentId, relayToken?)`. `revealEcho` posts to `relay_via` carrying `relay_token` when the echo is a relay echo (direct echoes unchanged — still a 2-arg call, preserving existing assertions). `onInboundReveal` signature becomes `{ agentId, intentId, relayToken?, peerName? }`: a relay inbound (relayToken present) resolves the local relay echo by id `${intentId}:${agentId}:${relayToken}`; when `peerName` is present on the mutual instant it swaps the masked name in and carries it on the notify. All non-relay behavior identical.

- [ ] **Step 1: Failing tests** — append to `src/core/social-reveal.test.ts`:

```ts
describe('makeRevealer — relay branch (2-hop, spec #2)', () => {
  it('revealEcho on a relay echo posts to relay_via carrying the relay_token', async () => {
    const post = vi.fn(async () => ({ mutual: false }))
    const { echoStore, revealer } = fixture(post)
    // Relay echo: peer_agent_id null, relay_via = W, relay_token = T, id = intent:W:T.
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    const out = await revealer.revealEcho('i1:ccw:T')
    expect(out).toEqual({ state: 'awaiting_peer' })
    expect(post).toHaveBeenCalledWith('ccw', 'i1', 'T')   // addressed to W, carries the token
    expect(echoStore.get('i1:ccw:T')!.self_revealed_at).not.toBeNull()
  })

  it('relay revealEcho mutual → connected, identity swapped from the response', async () => {
    const post = vi.fn(async () => ({ mutual: true, identity: PEER }))   // W returns Q's identity
    const { echoStore, seekStore, revealer } = fixture(post)
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    const out = await revealer.revealEcho('i1:ccw:T')
    expect(out).toEqual({ state: 'connected' })
    expect(echoStore.get('i1:ccw:T')!.peer_masked).toBe('小B')
    expect(seekStore.get('i1')!.status).toBe('connected')
  })

  it('inbound relay reveal (carries relay_token) resolves the relay echo, not the direct key', () => {
    const { echoStore, notify, revealer } = fixture(vi.fn())
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    const resp = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T' })
    expect(resp).toEqual({ mutual: false })
    expect(echoStore.get('i1:ccw:T')!.peer_revealed_at).not.toBeNull()
    expect(notify).toHaveBeenCalledWith('await_reveal', expect.objectContaining({ intentId: 'i1' }))
  })

  it('inbound relay reveal completing me → mutual, swaps in peerName + notifies with it', () => {
    const { echoStore, seekStore, notify, revealer } = fixture(vi.fn())
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    echoStore.setSelfRevealed('i1:ccw:T', '2026-07-15T00:00:00.000Z')   // I revealed first
    const resp = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T', peerName: '小Q' })
    expect(resp).toEqual({ mutual: true, identity: SELF })
    expect(echoStore.get('i1:ccw:T')!.peer_masked).toBe('小Q')          // W handed me Q's name
    expect(seekStore.get('i1')!.status).toBe('connected')
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i1', peerName: '小Q' }))
  })

  it('retried relay inbound after mutual is idempotent (no duplicate connected beat)', () => {
    const { echoStore, seekStore, notify, revealer } = fixture(vi.fn())
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccw:T', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: 'x', peerAgentId: null, relayVia: 'ccw', relayToken: 'T' })
    echoStore.setSelfRevealed('i1:ccw:T', '2026-07-15T00:00:00.000Z')
    const first = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T', peerName: '小Q' })
    const second = revealer.onInboundReveal({ agentId: 'ccw', intentId: 'i1', relayToken: 'T', peerName: '小Q' })
    expect(first).toEqual({ mutual: true, identity: SELF })
    expect(second).toEqual({ mutual: true, identity: SELF })
    expect(notify.mock.calls.filter((c: any[]) => c[0] === 'connected').length).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — Run: `bun run test src/core/social-reveal.test.ts`. Expected: FAIL — relay echo not addressed to `relay_via`; `onInboundReveal` doesn't accept `relayToken`/`peerName`.

- [ ] **Step 3: Extend the reveal core** — in `src/core/social-reveal.ts`, update the `postPeerReveal` dep signature, the `Revealer.onInboundReveal` signature, `revealEcho`, and `onInboundReveal`.

Update `RevealerDeps.postPeerReveal`:

```ts
  /** Outbound A2A POST to the peer's /a2a/reveal. `relayToken` addresses a 2-hop
   *  relay leg (routed to the intermediary). null when unreachable. */
  postPeerReveal(agentId: string, intentId: string, relayToken?: string): Promise<{ mutual: boolean; identity?: PeerIdentity } | null>
```

Update the `Revealer` interface:

```ts
export interface Revealer {
  revealEcho(echoId: string): Promise<RevealOutcome | null>
  revealPledge(pledgeId: string): Promise<RevealOutcome | null>
  onInboundReveal(ev: { agentId: string; intentId: string; relayToken?: string; peerName?: string }): { mutual: boolean; identity?: PeerIdentity }
}
```

Replace `revealEcho` (a relay echo has `peer_agent_id = null` but `relay_via` set — post to `relay_via` with the token; direct echoes keep the exact 2-arg call so existing `toHaveBeenCalledWith('ccb','i1')` still passes):

```ts
    async revealEcho(echoId) {
      const echo = deps.echoStore.get(echoId)
      if (!echo) return null
      if (echo.self_revealed_at && echo.peer_revealed_at) return { state: 'connected' }  // already mutual, no-op
      const now = new Date().toISOString()
      if (!echo.self_revealed_at) deps.echoStore.setSelfRevealed(echoId, now)             // my consent, idempotent
      // Relay (degree-2) echo → reveal is addressed to the intermediary (relay_via),
      // carrying the relay_token; a direct echo posts to peer_agent_id (2-arg, unchanged).
      const target = echo.relay_via ?? echo.peer_agent_id
      if (!target) return { state: 'peer_unreachable' }                                   // legacy row, can't POST back
      const resp = echo.relay_token
        ? await deps.postPeerReveal(target, echo.seek_id, echo.relay_token)
        : await deps.postPeerReveal(target, echo.seek_id)
      if (!resp) return { state: 'peer_unreachable' }                                     // consent already persisted
      if (!resp.mutual) return { state: 'awaiting_peer' }
      deps.echoStore.setPeerRevealed(echoId, now)
      deps.echoStore.setStatus(echoId, 'revealed')
      deps.seekStore.update(echo.seek_id, { status: 'connected' })
      if (resp.identity) deps.echoStore.setRevealedIdentity(echoId, resp.identity.name)
      deps.notify('connected', { intentId: echo.seek_id, peerName: resp.identity?.name })
      return { state: 'connected' }
    },
```

Replace `onInboundReveal` (relay branch resolves the relay-echo id; `peerName` is W handing over the other endpoint's name on the mutual instant):

```ts
    onInboundReveal({ agentId, intentId, relayToken, peerName }) {
      const now = new Date().toISOString()
      // Relay inbound → the relay echo id is intent_id:relay_via:relay_token (S may
      // hold several relay echoes for one intent, so the direct key is insufficient).
      const rowId = relayToken ? `${intentId}:${agentId}:${relayToken}` : `${intentId}:${agentId}`
      const echo = deps.echoStore.get(rowId)
      if (echo) {
        if (echo.peer_revealed_at) {
          // duplicate/retried inbound reveal — no writes, no notify, just a consistent answer
          return echo.self_revealed_at ? { mutual: true, identity: deps.selfIdentity() } : { mutual: false }
        }
        deps.echoStore.setPeerRevealed(rowId, now)
        if (echo.self_revealed_at) {
          deps.echoStore.setStatus(rowId, 'revealed')
          deps.seekStore.update(intentId, { status: 'connected' })
          // Relay completion: W hands the other endpoint's real name (the caller
          // agentId is W, not the counterpart, so we can't resolve it locally).
          if (peerName) deps.echoStore.setRevealedIdentity(rowId, peerName)
          deps.notify('connected', { intentId, peerAgentId: agentId, ...(peerName ? { peerName } : {}) })
          return { mutual: true, identity: deps.selfIdentity() }
        }
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      const pledge = deps.pledgeStore.get(rowId)
      if (pledge) {
        if (pledge.peer_revealed_at) {
          // duplicate/retried inbound reveal — no writes, no notify, just a consistent answer
          return pledge.self_revealed_at ? { mutual: true, identity: deps.selfIdentity() } : { mutual: false }
        }
        deps.pledgeStore.setPeerRevealed(rowId, now)
        if (pledge.self_revealed_at) {
          deps.notify('connected', { intentId, peerAgentId: agentId, ...(peerName ? { peerName } : {}) })
          return { mutual: true, identity: deps.selfIdentity() }
        }
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      return { mutual: false }  // nothing to reveal against; respond without leaking
    },
```

- [ ] **Step 4: Run to verify PASS** — Run: `bun run test src/core/social-reveal.test.ts`. Expected: PASS (all existing spine tests + the 5 new relay tests). The existing direct-echo tests still pass because `revealEcho` keeps the 2-arg `postPeerReveal(target, seek_id)` call when `relay_token` is null.

- [ ] **Step 5: Typecheck ripple** — the `postPeerReveal` + `onInboundReveal` signature change ripples to bootstrap (Task 7). Run: `bun run typecheck`. Expected: RED only in `src/daemon/bootstrap/index.ts` (fixed in Task 7). Confirm no OTHER file regressed. Per-task tests green.

- [ ] **Step 6: Commit** — `feat(social): reveal core relay branch (relay_via post + relay_token/peerName inbound) (fwd T5)`.

---

## Task 6: Intermediary relay reconciliation (`makeRelayReconciler`)

**Files:**
- Create: `src/core/social-relay-reveal.ts`, `src/core/social-relay-reveal.test.ts`

**Interfaces:**
- Consumes: `RelayStore` (Task 3), `PeerIdentity` (`social-reveal.ts`).
- Produces: `makeRelayReconciler(deps)` → `{ onRelayReveal({ callerAgentId, intentId, relayToken? }): { mutual: boolean; identity?: PeerIdentity } | null }`. Runs on the INTERMEDIARY W. Resolves the relay row (token → the upstream/S leg via `get(intent:token)`; no token → the downstream/Q leg via `getByIntentDownstream(intent, caller)`). Returns `null` when there is no relay row (caller falls through to W's own echo/pledge revealer). Marks the correct leg (idempotent on `*_revealed_at`). On the second leg → resolves both identities from `identityOf`, crosses them via `completeUpstream`/`completeDownstream`, fires `notify3way`, returns `{ mutual:true, identity: <the OTHER party for the caller> }`. On the first leg → nudges the other endpoint, returns `{ mutual:false }`.

- [ ] **Step 1: Failing tests** — create `src/core/social-relay-reveal.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makeRelayStore } from './social-relay-store'
import { makeRelayReconciler } from './social-relay-reveal'
import type { PeerIdentity } from './social-reveal'

const S: PeerIdentity = { name: '小S', url: 'http://s/a2a' }
const Q: PeerIdentity = { name: '小Q', url: 'http://q/a2a' }
const ids: Record<string, PeerIdentity> = { ccs: S, ccq: Q }

function fixture() {
  const db = openDb({ path: ':memory:' })
  const relayStore = makeRelayStore(db)
  relayStore.create({ id: 'i1:T', intentId: 'i1', relayToken: 'T', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
  const completeUpstream = vi.fn()
  const completeDownstream = vi.fn()
  const nudge = vi.fn()
  const notify3way = vi.fn()
  const rec = makeRelayReconciler({
    relayStore,
    identityOf: (id) => ids[id] ?? null,
    completeUpstream, completeDownstream, nudge, notify3way,
  })
  return { relayStore, rec, completeUpstream, completeDownstream, nudge, notify3way }
}

describe('makeRelayReconciler', () => {
  it('no relay row → null (caller falls through to its own echo/pledge revealer)', () => {
    const { rec } = fixture()
    expect(rec.onRelayReveal({ callerAgentId: 'ccx', intentId: 'nope' })).toBeNull()
  })

  it('S reveals first (carries token) → mark upstream, nudge Q with NO token, mutual:false', () => {
    const { rec, relayStore, nudge, completeUpstream, completeDownstream } = fixture()
    const out = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })
    expect(out).toEqual({ mutual: false })
    expect(relayStore.get('i1:T')!.upstream_revealed_at).not.toBeNull()
    expect(nudge).toHaveBeenCalledWith('ccq', 'i1')            // Q's pledge is keyed intent:W → no token
    expect(completeUpstream).not.toHaveBeenCalled()
    expect(completeDownstream).not.toHaveBeenCalled()
  })

  it('Q reveals first (no token) → mark downstream, nudge S WITH token, mutual:false', () => {
    const { rec, relayStore, nudge } = fixture()
    const out = rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1' })
    expect(out).toEqual({ mutual: false })
    expect(relayStore.get('i1:T')!.downstream_revealed_at).not.toBeNull()
    expect(nudge).toHaveBeenCalledWith('ccs', 'i1', 'T')       // S needs the token
  })

  it('S-first then Q → mutual; Q learns S synchronously, S completed via post-back, 3-way fires', () => {
    const { rec, completeUpstream, completeDownstream, notify3way } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })   // S first
    const out = rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1' })        // Q second
    expect(out).toEqual({ mutual: true, identity: S })          // Q (caller) gets the OTHER party = S
    expect(completeUpstream).toHaveBeenCalledWith('ccs', 'i1', 'T', Q)             // post back to S with Q's identity
    expect(completeDownstream).not.toHaveBeenCalled()
    expect(notify3way).toHaveBeenCalledWith('i1', S, Q)
  })

  it('Q-first then S → mutual; S learns Q synchronously, Q completed via post-back', () => {
    const { rec, completeUpstream, completeDownstream, notify3way } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1' })                    // Q first
    const out = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })  // S second
    expect(out).toEqual({ mutual: true, identity: Q })          // S (caller) gets the OTHER party = Q
    expect(completeDownstream).toHaveBeenCalledWith('ccq', 'i1', S)                // post back to Q with S's identity
    expect(completeUpstream).not.toHaveBeenCalled()
    expect(notify3way).toHaveBeenCalledWith('i1', S, Q)
  })

  it('restart survivability: the relay row is durable, reconciliation is process-independent', () => {
    const { rec, relayStore } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })
    // Simulate a W restart: a fresh reconciler over the SAME store still crosses.
    const rec2 = makeRelayReconciler({
      relayStore,
      identityOf: (id) => ids[id] ?? null,
      completeUpstream: vi.fn(), completeDownstream: vi.fn(), nudge: vi.fn(),
      notify3way: vi.fn(),
    })
    const out = rec2.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1' })
    expect(out).toEqual({ mutual: true, identity: S })
  })

  it('retried reveal after mutual is idempotent (no duplicate cross/notify)', () => {
    const { rec, completeDownstream, notify3way } = fixture()
    rec.onRelayReveal({ callerAgentId: 'ccq', intentId: 'i1' })
    rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })   // reaches mutual
    completeDownstream.mockClear(); notify3way.mockClear()
    const again = rec.onRelayReveal({ callerAgentId: 'ccs', intentId: 'i1', relayToken: 'T' })   // retry
    expect(again).toEqual({ mutual: true, identity: Q })        // consistent answer
    expect(completeDownstream).not.toHaveBeenCalled()           // no duplicate post-back
    expect(notify3way).not.toHaveBeenCalled()                   // no duplicate warmth
  })
})
```

- [ ] **Step 2: Run to verify it fails** — Run: `bun run test src/core/social-relay-reveal.test.ts`. Expected: FAIL — module missing.

- [ ] **Step 3: Implement the reconciler** — create `src/core/social-relay-reveal.ts`:

```ts
/**
 * social-relay-reveal.ts — the INTERMEDIARY's (介绍人 / W) reveal reconciliation
 * for a 2-hop connection (spec #2). Both endpoints reveal TO W (S carries the
 * relay_token; Q reveals its pledge keyed intent:W). W pivots the two legs on
 * the durable social_relay row: it marks whichever leg came in and, when both
 * are revealed, crosses the two endpoints' identities — resolved from W's OWN
 * registry, so identity never travels across a hop. The second revealer learns
 * mutual synchronously; the first is completed by a post-back. Row-driven →
 * survives a W restart.
 */
import type { RelayStore } from './social-relay-store'
import type { PeerIdentity } from './social-reveal'

export interface RelayReconcilerDeps {
  relayStore: RelayStore
  /** Resolve a direct peer's identity from W's registry (both endpoints are W's peers). */
  identityOf(agentId: string): PeerIdentity | null
  /** Complete the upstream (S) leg by posting back to S with the relay_token + Q's identity. */
  completeUpstream(upstreamAgentId: string, intentId: string, relayToken: string, downstreamIdentity: PeerIdentity): void
  /** Complete the downstream (Q) leg by posting back to Q (pledge keyed intent:W) with S's identity. */
  completeDownstream(downstreamAgentId: string, intentId: string, upstreamIdentity: PeerIdentity): void
  /** Pre-mutual nudge to the un-revealed endpoint (relayToken only when nudging S). */
  nudge(agentId: string, intentId: string, relayToken?: string): void
  /** 介绍人 warmth: tell W's own owner it connected upstream↔downstream. */
  notify3way(intentId: string, upstream: PeerIdentity, downstream: PeerIdentity): void
}

export interface RelayReconciler {
  onRelayReveal(ev: { callerAgentId: string; intentId: string; relayToken?: string }): { mutual: boolean; identity?: PeerIdentity } | null
}

export function makeRelayReconciler(deps: RelayReconcilerDeps): RelayReconciler {
  return {
    onRelayReveal({ callerAgentId, intentId, relayToken }) {
      // Token ⇒ the caller is S (upstream). No token ⇒ the caller is Q (downstream),
      // resolved by (intent_id, downstream=caller).
      const isUpstreamLeg = !!relayToken
      const relay = isUpstreamLeg
        ? deps.relayStore.get(`${intentId}:${relayToken}`)
        : deps.relayStore.getByIntentDownstream(intentId, callerAgentId)
      if (!relay) return null   // not a relay we hold — caller falls through to its own revealer

      const sIdentity = deps.identityOf(relay.upstream_agent_id)
      const qIdentity = deps.identityOf(relay.downstream_agent_id)
      const otherForCaller = isUpstreamLeg ? qIdentity : sIdentity

      // Idempotency: if THIS leg was already revealed, this is a retry — no writes,
      // no nudge/complete/notify; return a consistent answer (spine invariant).
      const legAlready = isUpstreamLeg ? !!relay.upstream_revealed_at : !!relay.downstream_revealed_at
      if (legAlready) {
        const both = !!relay.upstream_revealed_at && !!relay.downstream_revealed_at
        return both ? { mutual: true, ...(otherForCaller ? { identity: otherForCaller } : {}) } : { mutual: false }
      }

      const now = new Date().toISOString()
      if (isUpstreamLeg) deps.relayStore.setUpstreamRevealed(relay.id, now)
      else deps.relayStore.setDownstreamRevealed(relay.id, now)

      const otherLegRevealed = isUpstreamLeg ? !!relay.downstream_revealed_at : !!relay.upstream_revealed_at
      if (otherLegRevealed) {
        // Both legs in → mutual. Cross identities: post back to whoever revealed
        // FIRST (the OTHER leg); the caller (second) learns mutual synchronously.
        if (sIdentity && qIdentity) {
          if (isUpstreamLeg) deps.completeDownstream(relay.downstream_agent_id, intentId, sIdentity)
          else deps.completeUpstream(relay.upstream_agent_id, intentId, relay.relay_token, qIdentity)
          deps.notify3way(intentId, sIdentity, qIdentity)
        }
        return { mutual: true, ...(otherForCaller ? { identity: otherForCaller } : {}) }
      }

      // Only this leg revealed → nudge the un-revealed endpoint so its owner gets
      // beat #2. Nudging S must carry the relay_token; nudging Q must not.
      if (isUpstreamLeg) deps.nudge(relay.downstream_agent_id, intentId)
      else deps.nudge(relay.upstream_agent_id, intentId, relay.relay_token)
      return { mutual: false }
    },
  }
}
```

- [ ] **Step 4: Run to verify PASS** — Run: `bun run test src/core/social-relay-reveal.test.ts`. Expected: PASS (all cases incl. both orderings, restart, idempotent, no-row→null). Then `bun run typecheck` (still RED only in bootstrap until Task 7).

- [ ] **Step 5: Commit** — `feat(social): intermediary relay reconciler makeRelayReconciler (fwd T6)`.

---

## Task 7: Bootstrap wiring (integration)

**Files:**
- Modify: `src/core/a2a-server.ts` (+ `src/core/a2a-server.test.ts`) — `RevealEvent` relay fields.
- Modify: `src/core/social-broker.ts` (+ `src/core/social-broker.test.ts`) — record forwarded (relay) echoes.
- Modify: `src/daemon/bootstrap/index.ts` (+ `src/daemon/bootstrap.test.ts`) — forwarder + reconciler + reveal-relay wiring.

**Interfaces:**
- Consumes: `makeForwarder` (T4), `makeRelayStore`/`makeSeenIntentStore` (T3), `makeRelayReconciler` (T6), the widened `postPeerReveal`/`onInboundReveal` (T5), the echo-store relay create (T2), `ForwardedEcho`/`hop` (T1).
- Produces: `RevealEvent = { agent_id: string; intent_id: string; relay_token?: string; peer_name?: string }`; the `/a2a/reveal` handler forwards `body.relay_token` + `body.peer_name`. `socialOnIntent` becomes the forwarder; `socialOnReveal` tries the reconciler first, then the endpoint revealer. `EchoRecord` gains optional `relayVia`/`relayToken` + nullable `peerAgentId`; the broker records degree-2 relay echoes from `receipt.forwarded`.

### 7a — a2a-server RevealEvent relay fields

- [ ] **Step 1: Failing server test** — append to the `describe('POST /a2a/reveal ...')` block in `src/core/a2a-server.test.ts`:

```ts
    it('forwards relay_token + peer_name from the body to onReveal (verified agent_id preserved)', async () => {
      const onReveal = vi.fn(async (_e: import('./a2a-server').RevealEvent) => ({ mutual: false }))
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onReveal })
      try {
        const res = await fetch(`${baseUrl}/a2a/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1', relay_token: 'T', peer_name: '小Q' }),
        })
        expect(res.status).toBe(200)
        expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'alpha', intent_id: 'i1', relay_token: 'T', peer_name: '小Q' }))
      } finally { await server.stop() }
    })
```

(Confirm the exact helper names — `startServer`, `alphaRec`, `.inbound_api_key` — against the existing reveal test at `a2a-server.test.ts:399`; adapt if the harness differs.)

- [ ] **Step 2: Run to verify it fails** — Run: `bun run test src/core/a2a-server.test.ts`. Expected: FAIL — `relay_token`/`peer_name` not forwarded.

- [ ] **Step 3: Extend `RevealEvent` + the handler** — in `src/core/a2a-server.ts`, extend the interface:

```ts
export interface RevealEvent {
  agent_id: string
  intent_id: string
  /** spec #2: present when this reveal is a 2-hop relay leg addressed to an intermediary. */
  relay_token?: string
  /** spec #2: the OTHER endpoint's display name, handed over by the intermediary on the mutual instant. */
  peer_name?: string
}
```

Widen the `/a2a/reveal` body type and the `onReveal` call (the handler already exists at `~:353`; change the body typing line and the dispatch line):

```ts
      let body: { agent_id?: unknown; intent_id?: unknown; relay_token?: unknown; peer_name?: unknown }
```

```ts
      try {
        const relayToken = typeof body.relay_token === 'string' && body.relay_token ? body.relay_token : undefined
        const peerName = typeof body.peer_name === 'string' && body.peer_name ? body.peer_name : undefined
        const result = await opts.onReveal({ agent_id: agent.id, intent_id: body.intent_id, relay_token: relayToken, peer_name: peerName })
        return new Response(JSON.stringify(result), { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: 'reveal_failed', detail: msg }), { status: 500 })
      }
```

(`agent_id` stays the verified Bearer `agent.id` — client-supplied `agent_id` is still never trusted as the acting identity; `relay_token`/`peer_name` are display/routing metadata the intermediary provides.)

- [ ] **Step 4: Run to verify PASS** — Run: `bun run test src/core/a2a-server.test.ts`. Expected: PASS (new test + all existing reveal tests, which pass no relay fields → both `undefined`).

### 7b — broker records forwarded (relay) echoes

- [ ] **Step 5: Failing broker test** — append to `src/core/social-broker.test.ts` a case asserting the seeker records degree-2 relay echoes when a response carries `forwarded[]` (mirror the file's existing `stubDeps` helper; adapt names as needed):

```ts
  it('records degree-2 relay echoes from a response forwarded[] (spec #2)', async () => {
    const recorded: any[] = []
    const d = deferred()
    const broker = makeBroker(stubDeps({
      send: async () => ({ intent_id: 'x', match: 'no' as const, forwarded: [{ blurb: '经W的回声', degree: 2, relay_token: 'T' }] }),
      recordEcho: (e: any) => recorded.push(e),
      schedule: d.schedule,
    }))
    const out = await broker.seek('找摄影搭子')
    await d.run()
    const relay = recorded.find(r => r.relayToken === 'T')
    expect(relay).toMatchObject({ intentId: out.intent_id, peerAgentId: null, relayVia: expect.any(String), relayToken: 'T', degree: 2 })
  })
```

- [ ] **Step 6: Run to verify it fails** — Run: `bun run test src/core/social-broker.test.ts`. Expected: FAIL — forwarded echoes ignored.

- [ ] **Step 7: Extend `EchoRecord` + `forage`** — in `src/core/social-broker.ts`, widen `EchoRecord` and record forwarded echoes inside the per-hand `try` in `forage`:

```ts
export interface EchoRecord {
  intentId: string; peerAgentId: string | null; peerMasked: string; degree: number; content: string; first: boolean
  relayVia?: string; relayToken?: string
}
```

In `forage`, replace the `if (r && r.match === 'yes') { ... }` block with (keeps the direct-echo path, adds the relay-echo path):

```ts
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
```

- [ ] **Step 8: Run to verify PASS** — Run: `bun run test src/core/social-broker.test.ts`. Expected: PASS.

### 7c — bootstrap: forwarder, reconciler, reveal-relay

- [ ] **Step 9: Failing bootstrap integration test** — add a focused case to `src/daemon/bootstrap.test.ts` that boots a social-enabled daemon and asserts the forwarding surface is wired (adapt to the file's existing boot harness / fixture builder — read the existing social assertions there first). At minimum assert: (a) with `social_enabled` + policy, `/a2a/reveal` accepts a body with `relay_token` without 400/500; (b) an inbound intent whose card has `hop: 2` produces a `MatchReceipt` with **no** `forwarded` (terminal). If the harness can't easily drive HTTP, assert the exported `social.*` handles exist and that `socialOnReveal`/`socialOnIntent` are defined when social is enabled. Keep this test scoped — the full S→W→Q path is Task 8.

- [ ] **Step 10: Run to verify it fails** — Run: `bun run test src/daemon/bootstrap.test.ts`. Expected: FAIL (or typecheck-red) on the not-yet-wired forwarder/reconciler.

- [ ] **Step 11: Wire the stores + forwarder + reconciler** — in `src/daemon/bootstrap/index.ts`:

Add imports (next to the existing social imports `~:69`–`:75`):

```ts
import { makeForwarder } from '../../core/social-forwarder'
import { makeRelayStore } from '../../core/social-relay-store'
import { makeSeenIntentStore } from '../../core/social-seen-intent-store'
import { makeRelayReconciler } from '../../core/social-relay-reveal'
import { randomUUID } from 'node:crypto'
```

Inside the `if (configuredAgent.social_enabled && ...)` block, after the existing stores (`~:1349`), construct the two new stores:

```ts
      const relayStore = makeRelayStore(deps.db)
      const seenIntentStore = makeSeenIntentStore(deps.db)
```

Widen `postPeerReveal` to carry the relay token (replace the existing closure `~:1378`):

```ts
      const postPeerReveal = async (agentId: string, intentId: string, relayToken?: string): Promise<{ mutual: boolean; identity?: PeerIdentity } | null> => {
        const hand = a2aRegistry.get(agentId)
        if (!hand) return null
        const r = await a2aClient.send({ url: revealUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, intent_id: intentId, ...(relayToken ? { relay_token: relayToken } : {}) } })
        if (!r.ok) return null
        return r.response as { mutual: boolean; identity?: PeerIdentity }
      }
```

Add a reveal-post helper (used by the reconciler's complete/nudge deps — posts to a peer's `/a2a/reveal` with arbitrary relay fields; fail-closed, never throws to the reconciler):

```ts
      const postReveal = (agentId: string, body: { intent_id: string; relay_token?: string; peer_name?: string }): void => {
        const hand = a2aRegistry.get(agentId)
        if (!hand) return
        void a2aClient.send({ url: revealUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } })
          .catch(err => deps.log('SOCIAL_REC', `relay reveal post failed intent=${body.intent_id} agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`))
      }
```

Build the reconciler (after `revealer` is constructed, `~:1387`):

```ts
      const relayReconciler = makeRelayReconciler({
        relayStore,
        identityOf: (id) => { const a = a2aRegistry.get(id); return a ? { name: a.name, url: a.url } : null },
        completeUpstream: (upstreamId, intentId, relayToken, downstreamIdentity) =>
          postReveal(upstreamId, { intent_id: intentId, relay_token: relayToken, peer_name: downstreamIdentity.name }),
        completeDownstream: (downstreamId, intentId, upstreamIdentity) =>
          postReveal(downstreamId, { intent_id: intentId, peer_name: upstreamIdentity.name }),
        nudge: (agentId, intentId, relayToken) =>
          postReveal(agentId, { intent_id: intentId, ...(relayToken ? { relay_token: relayToken } : {}) }),
        notify3way: (intentId, upstream, downstream) => {
          // 介绍人 warmth: only W's own owner is told — telling W leaks nothing
          // extra (W already proxied the reveal). S/Q get their own beats.
          const op = resolveOperatorChatId()
          if (op && sendAssistantText) void sendAssistantText(op, `🎉 你把朋友和${downstream.name}牵上线了`)
        },
      })
```

Replace `socialOnReveal` (try the reconciler first, then the endpoint revealer; forward `relay_token`/`peer_name`):

```ts
      socialOnReveal = async (ev) => {
        // First: is this a relay leg addressed to US as the intermediary? The
        // reconciler resolves via a social_relay row; null ⇒ not ours, fall through.
        const relayResult = relayReconciler.onRelayReveal({ callerAgentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token })
        if (relayResult) return relayResult

        // Otherwise WE are an endpoint: mark our own echo/pledge. A relay inbound
        // (relay_token present, or peer_name handed over on mutual) drives the
        // relay branch of onInboundReveal.
        const result = revealer.onInboundReveal({ agentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerName: ev.peer_name })
        // Direct-echo first-revealer identity swap (unchanged from the spine): the
        // relay branch already swapped peer_name in when present, so only swap the
        // DIRECT case (no relay_token) here to avoid clobbering with W's name.
        if (result.mutual && !ev.relay_token && !ev.peer_name) {
          try {
            const name = a2aRegistry.get(ev.agent_id)?.name
            if (name) echoStore.setRevealedIdentity(`${ev.intent_id}:${ev.agent_id}`, name)
          } catch (err) {
            deps.log('SOCIAL_REC', `reveal identity swap failed intent=${ev.intent_id} agent=${ev.agent_id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return result
      }
```

Replace `socialOnIntent` with the forwarder wrapping the existing answer+pledge (keep the pledge recording as the `answerLocally`):

```ts
      // answerLocally = the spine's judge + pledge-on-yes. The forwarder wraps it
      // with the 2-hop fan-out.
      const answerLocally = async (event: import('../../core/a2a-server').IntentEvent): Promise<import('../../core/a2a-intent').MatchReceipt> => {
        const receipt = await answerIntent(event)
        if (receipt.match === 'yes') {
          try {
            pledgeStore.create({ id: `${event.card.intent_id}:${event.agent.id}`, intentId: event.card.intent_id, seekerAgentId: event.agent.id, topic: event.card.topic })
          } catch (err) {
            deps.log('SOCIAL_REC', `pledge record failed intent=${event.card.intent_id} agent=${event.agent.id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return receipt
      }
      socialOnIntent = makeForwarder({
        answerLocally,
        // Forward to our OWN paired peers, minus the sender; same cap as discover.
        forwardTargets: (excludeAgentId) => a2aRegistry.list().filter(a => !a.paused && a.id !== excludeAgentId).slice(0, 5),
        forwardSend: async (hand, card) => {
          const r = await a2aClient.send({ url: intentUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, card } })
          return r.ok ? MatchReceiptSchema.parse(r.response) : null
        },
        recordRelay: (intentId, upstreamAgentId, downstreamAgentId) => {
          const relayToken = randomUUID()
          try {
            relayStore.create({ id: `${intentId}:${relayToken}`, intentId, relayToken, upstreamAgentId, downstreamAgentId })
          } catch (err) {
            deps.log('SOCIAL_REC', `relay record failed intent=${intentId} downstream=${downstreamAgentId}: ${err instanceof Error ? err.message : String(err)}`)
          }
          return relayToken
        },
        markSeen: (intentId, expiresAt) => {
          try { seenIntentStore.markSeen({ intentId, expiresAt }) }
          catch (err) { deps.log('SOCIAL_REC', `seen mark failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`) }
        },
        hasSeen: (intentId) => { try { return seenIntentStore.hasSeen(intentId) } catch { return false } },
        hopCap: 2,
      })
```

> **NOTE — upstream_agent_id:** `makeForwarder` (Task 4) threads `event.agent.id` (the seeker S as W sees it) into `recordRelay(intentId, upstreamAgentId, downstreamAgentId)`, so the relay row is keyed to the REAL upstream — W later resolves S's identity from its own registry via `upstream_agent_id`. Do NOT use `SOCIAL_SELF_ID` here (W is the intermediary, not the upstream).

Update the broker's `recordEcho` wiring (`~:1436`) to build the relay-echo id + pass relay fields:

```ts
        recordEcho: (e) => {
          try {
            const id = e.peerAgentId != null ? `${e.intentId}:${e.peerAgentId}` : `${e.intentId}:${e.relayVia}:${e.relayToken}`
            echoStore.create({ id, seekId: e.intentId, peerMasked: e.peerMasked, degree: e.degree, content: e.content, peerAgentId: e.peerAgentId, relayVia: e.relayVia, relayToken: e.relayToken })
          } catch (err) {
            deps.log('SOCIAL_REC', `echo record failed intent=${e.intentId} peer=${e.peerAgentId ?? e.relayVia}: ${err instanceof Error ? err.message : String(err)}`)
          }
          if (e.first) notify('first_echo', { intentId: e.intentId })
        },
```

(The broker's `send` already `MatchReceiptSchema.parse`s the response — now including the optional `forwarded`, so the seeker receives degree-2 echoes with no further change there.)

- [ ] **Step 12: Run the bootstrap test + typecheck** — Run: `bun run test src/daemon/bootstrap.test.ts`, then `bun run typecheck`. Expected: PASS + CLEAN tree-wide.

- [ ] **Step 13: Commit** — `feat(social): wire forwarder + relay reconciler + reveal-relay into the daemon (fwd T7)`.

---

## Task 8: End-to-end + compatibility

**Files:**
- Modify: `src/core/social-m1.e2e.test.ts` (add the forwarding e2e + compat cases)

**Interfaces:**
- Consumes: the REAL `makeForwarder`, `makeRelayReconciler`, `makeRevealer`, `makeBroker`, `makeAnswerIntent`, and all stores — composed S→W→Q in-process.
- Produces: no new production code; this task proves the full path and leaves typecheck CLEAN + the broad suite green.

- [ ] **Step 1: Add the S→W→Q forwarding e2e** — append to `src/core/social-m1.e2e.test.ts`. Compose three in-process daemons sharing nothing but the injected send/reveal seams. Drive: S sows a hop-1 seek → W judges no-match + forwards hop-2 → Q matches → a degree-2 relay echo returns to S (relay row persisted on W) → S reveals (routed to W) → W nudges Q → Q reveals → W crosses identities → S connected with Q's name, Q connected with S's name, W's owner gets the 3-way warmth, and S/Q stay mutually anonymous until mutual. Skeleton:

```ts
describe('forwarding hop e2e (S → W → Q)', () => {
  it('2-hop forage → relay echo → proxied mutual reveal → identity crossing, anonymous until mutual', async () => {
    // Three dbs (three daemons).
    const sDb = openDb({ path: ':memory:' }); const wDb = openDb({ path: ':memory:' }); const qDb = openDb({ path: ':memory:' })
    const sSeek = makeSeekStore(sDb); const sEcho = makeEchoStore(sDb); const sPledge = makePledgeStore(sDb)
    const wRelay = makeRelayStore(wDb); const wSeen = makeSeenIntentStore(wDb); const wEcho = makeEchoStore(wDb); const wPledge = makePledgeStore(wDb); const wSeek = makeSeekStore(wDb)
    const qEcho = makeEchoStore(qDb); const qPledge = makePledgeStore(qDb); const qSeek = makeSeekStore(qDb)

    const S = { id: 'ccs', name: '小S', url: 'http://s/a2a' }
    const W = { id: 'ccw', name: '小W', url: 'http://w/a2a' }
    const Q = { id: 'ccq', name: '小Q', url: 'http://q/a2a' }

    // Q's answer: matches. W's answer: no-match (forces the forward).
    const qAnswer = makeAnswerIntent({ judge: async () => ({ match: 'yes', blurb: '我主人认识个摄影师' }), policy: POLICY, cheapEval: passingCheck })
    const wAnswerLocal = makeAnswerIntent({ judge: async () => ({ match: 'no' }), policy: POLICY, cheapEval: passingCheck })

    // Q's /a2a/intent — records a pledge on yes (seeker, as Q sees it, is W).
    const qOnIntent = async (event: any) => {
      const r = await qAnswer(event)
      if (r.match === 'yes') qPledge.create({ id: `${event.card.intent_id}:${event.agent.id}`, intentId: event.card.intent_id, seekerAgentId: event.agent.id, topic: event.card.topic })
      return r
    }
    // W's forwarder: forwards to Q, mints a relay row.
    const wForwarder = makeForwarder({
      answerLocally: wAnswerLocal,
      forwardTargets: (exclude) => [Q].filter(t => t.id !== exclude),
      forwardSend: async (target, card) => target.id === Q.id ? qOnIntent({ agent: W, card }) : null,
      recordRelay: (intentId, upstreamAgentId, downstreamAgentId) => {
        const tok = 'TOK'
        wRelay.create({ id: `${intentId}:${tok}`, intentId, relayToken: tok, upstreamAgentId, downstreamAgentId })
        return tok
      },
      markSeen: (i, e) => wSeen.markSeen({ intentId: i, expiresAt: e }),
      hasSeen: (i) => wSeen.hasSeen(i),
      hopCap: 2,
    })

    // S's broker: forwards a seek to W, records the degree-2 relay echo.
    const jobs: Array<() => Promise<void>> = []
    const sBroker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [W as any],
      send: async (_hand, card) => wForwarder({ agent: S as any, card }),
      sow: (id, topic) => sSeek.create({ id, kind: 'seek', topic }),
      recordEcho: (e) => {
        const id = e.peerAgentId != null ? `${e.intentId}:${e.peerAgentId}` : `${e.intentId}:${e.relayVia}:${e.relayToken}`
        sEcho.create({ id, seekId: e.intentId, peerMasked: e.peerMasked, degree: e.degree, content: e.content, peerAgentId: e.peerAgentId, relayVia: e.relayVia, relayToken: e.relayToken })
      },
      finishSeek: (id, status, n) => sSeek.update(id, { status, peersAsked: n }),
      schedule: (fn) => { jobs.push(fn) },
    })

    // 1) Sow + forage: S ends with ONE degree-2 relay echo, still masked.
    const { intent_id } = await sBroker.seek('找周末拍照搭子')
    await Promise.all(jobs.map(j => j()))
    const echoes = sEcho.listForSeek(intent_id)
    expect(echoes).toHaveLength(1)
    expect(echoes[0]!.degree).toBe(2)
    expect(echoes[0]!.relay_via).toBe('ccw')
    expect(echoes[0]!.peer_masked).toBe('第 2 度的某人')     // anonymous until mutual
    const relayEchoId = echoes[0]!.id

    // Reconciler on W + revealers on S and Q, wired to route reveals through W.
    const idOf = (id: string): PeerIdentity | null => ({ ccs: S, ccw: W, ccq: Q } as any)[id] ?? null
    const wReconciler = makeRelayReconciler({
      relayStore: wRelay, identityOf: idOf,
      completeUpstream: (up, i, tok, dIdent) => { void sOnReveal({ agent_id: 'ccw', intent_id: i, relay_token: tok, peer_name: dIdent.name }) },
      completeDownstream: (down, i, uIdent) => { void qOnReveal({ agent_id: 'ccw', intent_id: i, peer_name: uIdent.name }) },
      nudge: (agentId, i, tok) => { if (agentId === 'ccq') void qOnReveal({ agent_id: 'ccw', intent_id: i }); else void sOnReveal({ agent_id: 'ccw', intent_id: i, relay_token: tok }) },
      notify3way: (..._a) => { w3way++ },
    })
    let w3way = 0
    // W's inbound reveal handler = reconciler-first.
    const wOnReveal = (ev: any) => wReconciler.onRelayReveal({ callerAgentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token }) ?? { mutual: false }

    const sRevealer = makeRevealer({ echoStore: sEcho, pledgeStore: sPledge, seekStore: sSeek, postPeerReveal: async (agentId, i, tok) => wOnReveal({ agent_id: 'ccs', intent_id: i, relay_token: tok }), selfIdentity: () => S, notify: () => {} })
    const qRevealer = makeRevealer({ echoStore: qEcho, pledgeStore: qPledge, seekStore: qSeek, postPeerReveal: async (agentId, i) => wOnReveal({ agent_id: 'ccq', intent_id: i }), selfIdentity: () => Q, notify: () => {} })
    // S/Q inbound reveal handlers (endpoint side; W posts back to them).
    const sOnReveal = (ev: any) => sRevealer.onInboundReveal({ agentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerName: ev.peer_name })
    const qOnReveal = (ev: any) => qRevealer.onInboundReveal({ agentId: ev.agent_id, intentId: ev.intent_id, relayToken: ev.relay_token, peerName: ev.peer_name })

    // 2) S reveals first → awaiting (W nudges Q).
    const sFirst = await sRevealer.revealEcho(relayEchoId)
    expect(sFirst).toEqual({ state: 'awaiting_peer' })

    // 3) Q reveals → mutual. Q learns S synchronously; W posts back to complete S.
    const qPledgeId = qPledge.list()[0]!.id
    const qOut = await qRevealer.revealPledge(qPledgeId)
    expect(qOut).toEqual({ state: 'connected' })

    // 4) Assert both connected + identity crossing + 3-way warmth.
    expect(sEcho.get(relayEchoId)!.peer_masked).toBe('小Q')   // S now sees Q
    expect(sSeek.get(intent_id)!.status).toBe('connected')
    expect(w3way).toBe(1)
  })
})
```

(Adapt the exact wiring of the mutual post-back ordering to the real reveal semantics — the key invariants to assert are: one degree-2 relay echo on S, masked until mutual; a durable relay row on W; and after both reveal, S shows Q's name + seek `connected`, plus the single 3-way notify.)

- [ ] **Step 2: Add the compatibility cases** — append two small cases proving backward-compat with a spec-#1 peer:

```ts
describe('forwarding hop — spec-#1 compatibility', () => {
  it('an old-style MatchReceipt (no forwarded) parses fine', () => {
    const r = MatchReceiptSchema.parse({ intent_id: 'i1', match: 'yes', blurb: 'x' })
    expect(r.forwarded).toBeUndefined()
  })
  it('an old IntentCard (no hop) safeParses and lands hop=1', () => {
    const p = IntentCardSchema.safeParse({ intent_id: 'i1', kind: 'seek', topic: 't', expires_at: '2026-07-15T01:00:00.000Z' })
    expect(p.success).toBe(true)
    expect(p.success && p.data.hop).toBe(1)
  })
  it('a forwarded field is stripped by the OLD MatchReceipt shape (no error)', () => {
    // Simulate an old seeker: parse with a schema that omits `forwarded`.
    const OldReceipt = z.object({ intent_id: z.string(), match: z.enum(['yes', 'no']), blurb: z.string().optional() })
    const r = OldReceipt.parse({ intent_id: 'i1', match: 'yes', blurb: 'x', forwarded: [{ blurb: 'y', degree: 2, relay_token: 'T' }] })
    expect((r as any).forwarded).toBeUndefined()
  })
})
```

(Add the imports the e2e/compat need at the top of the file: `makeForwarder`, `makeRelayStore`, `makeSeenIntentStore`, `makeRelayReconciler`, `IntentCardSchema`, `MatchReceiptSchema`, `type PeerIdentity`, and `import z from 'zod'` per the zod-v4 test gotcha.)

- [ ] **Step 3: Run the e2e + compat** — Run: `bun run test src/core/social-m1.e2e.test.ts`. Expected: PASS.

- [ ] **Step 4: Full green + clean tree** — Run: `bun run test` (broad suite) and `bun run typecheck`. Expected: all PASS, typecheck CLEAN tree-wide. If any spine test regressed, fix before proceeding — the forwarding path must not disturb the degree-1 spine.

- [ ] **Step 5: Commit** — `test(social): S→W→Q forwarding e2e + spec-#1 compatibility (fwd T8)`.

---

## Done criteria

- `PRAGMA user_version = 21`, 20 tables; `social_echo` has `relay_via`/`relay_token`; `social_relay` + `social_seen_intent` exist.
- A responder that no-matches a `hop=1` seek forwards `hop=2` to its own peers (minus sender), aggregates degree-2 echoes, never re-forwards a `hop=2` card, and dedups repeat `intent_id`s.
- A degree-2 echo reaches the seeker masked; the seeker's reveal routes through the intermediary; both endpoints connect with the other's real name; the intermediary's owner gets a single 3-way warmth ping; S and Q stay mutually anonymous until mutual.
- One bad forward target / unreachable intermediary never aborts an aggregation or loses persisted consent.
- Spec-#1 peers interoperate both directions with no error.
- `bun run typecheck` clean, broad `bun run test` green.
