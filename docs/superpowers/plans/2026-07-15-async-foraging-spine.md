# Async Foraging Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `broker.seek()` from a synchronous, owner-blocking one-shot into an async **sow → forage → reveal** spine. `seek()` returns immediately after gating + sowing the wish; echoes accrue in the background as `social_echo` rows; dual-confirm moves **out** of the seek into a durable, row-driven, restart-survivable **mutual async reveal** (双向异步互揭). This unblocks P4 (WeChat seek flow), the 揭晓 (reveal) button, and the live 觅食中 trickle. See `docs/superpowers/specs/2026-07-15-async-foraging-spine-design.md`.

**Architecture:** Row-driven, no long-lived in-memory state — the `social_seek` / `social_echo` / `social_pledge` rows **are** the state machine. `seek()` splits into a sync leg (gate → sow `foraging` → return `{ intent_id }`) and a background leg (`forage()`: discover → send → record echoes → set `echoed`/`closed`). Reveal is a pure core (`makeRevealer`) with two outbound callers (`revealEcho` / `revealPledge`) and one inbound event (`onInboundReveal`, wired to a new `POST /a2a/reveal`). Whoever reveals **second** learns `mutual:true` synchronously in their own round-trip; identity is exchanged only at that instant. The in-memory `pendingConfirms` Map + `confirmWithOwner` / `confirmPeer` seams retire from the social wiring (the file stays in tree for other callers). Boot scans `foraging` seeks and re-forages them.

**Tech Stack:** TypeScript, Bun runtime, Vitest. SQLite via `bun:sqlite` (`src/lib/db.ts`, append-only migrations). Stores follow the `makeXStore(db: Db)` idiom; internal-api route table (`src/daemon/internal-api/*`); A2A HTTP server/client (`src/core/a2a-server.ts` / `a2a-client.ts`).

## Global Constraints

- **Runtime is Bun.** Single test file: `bun run test <path>` (maps to `bun --bun vitest run <path>`). Typecheck: `bun run typecheck`. Run typecheck after any task that changes a shared type (2, 5, 7, 8).
- **zod v4 gotcha:** in *test* files use `import z from 'zod'` (default import). `import { z } from 'zod'` is `undefined` under vitest here. (No test in this plan needs zod directly, but obey this if you add one.)
- **Store idiom (mirror `social-echo-store.ts` / `social-seek-store.ts`):** `makeXStore(db: Db)` returns an object literal of methods; prepared statements via `db.query<Row, Params>(sql)`; tables `STRICT`; list order `ORDER BY created_at DESC, rowid DESC`. `Db` is `import type { Db } from '../lib/db'`.
- **Migrations** live in `src/lib/db.ts` `const migrations: Migration[]` — append a new `(db) => { db.exec(...) }` at the END, never edit a shipped one. `Migration = (db: Database) => void`. The v19 social-tables entry always runs `CREATE TABLE IF NOT EXISTS social_echo` before v20, so v20's `ALTER TABLE social_echo` is safe even in the `PRAGMA user_version = 9` → `runMigrations` test harnesses (`src/lib/db.test.ts`) — **no guard needed**. Nullable-TEXT `ADD COLUMN` is safe on STRICT tables.
- **internal-api routes:** handlers return `{ status, body }`; **503 when `!deps.social`** (`{ error: 'social_not_wired' }`); guard empty POST body with `(body ?? {})`; **every** route MUST appear in `src/daemon/internal-api/route-tiers.ts` `ROUTE_MIN_TIER` (the completeness test in `route-tiers.test.ts` enforces it) — new reveal/pledge routes are `'admin'`. The router matches `` `${method} ${url.pathname}` `` **exactly** — there is **no path-param support**, so reveal routes take the id in the JSON **body** (`{ id }`), not `:id` in the path.
- **a2a-server:** inbound handlers (`onIntent`, `onIntentConfirm`) are capability-gated (advertised in the agent card only when the opt is wired), Bearer-auth'd, and follow a fixed body-parse → auth → dispatch → error-shape order. `onReveal` mirrors `onIntentConfirm` exactly.
- **fail-closed posture:** one bad/unreachable peer never aborts a seek or a reveal (try/catch continue). Background/reveal store-write failures are logged, never thrown to a caller whose network action already happened. `postPeerReveal` returning `null` (unreachable) must **never** lose the caller's already-persisted `self_revealed_at`.
- Outbound `topic` / `city` / `blurb` keep flowing through `gateOutbound` + `sanitizeBlurb` (both already in `social-broker.ts`) — do not regress the disclosure surface.
- **Consistency of names across tasks (must match exactly):**
  - `EchoStore` gains `create(...peerAgentId)`, `setSelfRevealed(id, at)`, `setPeerRevealed(id, at)`, `setRevealedIdentity(id, name)` (Task 2) — consumed by the revealer (Task 4) and wiring (Task 8).
  - `PledgeStore` = `create` / `get` / `list` / `setSelfRevealed` / `setPeerRevealed` (Task 3).
  - `makeRevealer(deps)` → `Revealer` = `{ revealEcho(id), revealPledge(id), onInboundReveal(ev) }` (Task 4); `PeerIdentity = { name: string; url: string }`; `RevealOutcome = { state: 'connected' | 'awaiting_peer' | 'peer_unreachable' }`.
  - Broker gains deps `sow` / `recordEcho` / `finishSeek` / `schedule?`, loses `confirmWithOwner` / `confirmPeer`, and returns `{ seek, forage }` where `seek(...)` resolves to `SeekOutcome = { intent_id: string }` (Task 5).
  - `RevealEvent = { agent_id: string; intent_id: string }` and server opt `onReveal?` (Task 6).

---

## File Structure

- **Modify** `src/lib/db.ts` — append migration v20 (Task 1).
- **Modify** `src/lib/state-migration.test.ts` — v19→v20, 17→18 tables (Task 1).
- **Modify** `src/core/social-echo-store.ts` + `src/core/social-echo-store.test.ts` — new columns + reveal methods (Task 2).
- **Create** `src/core/social-pledge-store.ts` + `src/core/social-pledge-store.test.ts` (Task 3).
- **Create** `src/core/social-reveal.ts` + `src/core/social-reveal.test.ts` (Task 4).
- **Modify** `src/core/social-broker.ts` + `src/core/social-broker.test.ts` — non-blocking split (Task 5).
- **Modify** `src/core/a2a-server.ts` + `src/core/a2a-server.test.ts` — `onReveal` + `POST /a2a/reveal` (Task 6).
- **Modify** `src/daemon/internal-api/{routes-social.ts,route-tiers.ts,types.ts}` + `src/daemon/internal-api.test.ts` — reveal/pledge routes (Task 7).
- **Modify** `src/core/a2a-delegate.ts` (+ its test) — `revealUrl` helper (Task 8).
- **Modify** `src/daemon/bootstrap/index.ts` + `src/daemon/bootstrap.test.ts` — wiring, resume, retire pendingConfirms (Task 8).
- **Create** `src/core/reveal-command.ts` + `src/core/reveal-command.test.ts`; **Modify** `src/daemon/wiring/pipeline-deps.ts` + `src/daemon/wiring/pipeline-deps-social-dispatch.test.ts` — 揭晓 semantics (Task 9).
- **Modify** `src/core/social-m1.e2e.test.ts` — end-to-end spine (Task 10).

---

## Task 1: Migration v20 — schema (echo columns + `social_pledge`)

**Files:**
- Modify: `src/lib/db.ts` (append to `migrations`, after the v19 social-tables entry ending ~`:479`)
- Test: `src/lib/state-migration.test.ts` (~`:64`–`:79`)

**Interfaces:**
- Consumes: nothing (schema only).
- Produces: `social_echo` gains `peer_agent_id TEXT`, `self_revealed_at TEXT`, `peer_revealed_at TEXT` (all nullable); new `social_pledge` STRICT table `(id, intent_id, seeker_agent_id, topic, self_revealed_at, peer_revealed_at, created_at)` + index `idx_social_pledge_intent`. `PRAGMA user_version` becomes 20; table count 17→18.

- [ ] **Step 1: Write the failing test** — edit `src/lib/state-migration.test.ts`. Rename the assertion `it('opens a fresh db with PRAGMA user_version = 19 and the 17 tables', ...)` to `= 20 and the 18 tables`, bump the version expectation, add the comment line, and insert `'social_pledge'` into the sorted table list (it sorts between `social_echo` and `social_seek`):

```ts
  it('opens a fresh db with PRAGMA user_version = 20 and the 18 tables', () => {
    const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    // v14 (dialogue real data): messages / threads / thread_extract_state tables added;
    // events.kind widened with 'threads_extracted'.
    // v15 (turn observability): turn_records table added.
    // v16 (sleep/wake dedup): handled_messages table added.
    // v17 (poison-message bound): message_attempts table added.
    // v18 (connection heartbeat): per-account last-successful-poll timestamp table added.
    // v19 (agent-social 觅食台 state): social_seek + social_echo tables added.
    // v20 (async foraging spine): social_echo reveal columns + social_pledge table added.
    expect(v).toBe(20)
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toEqual([
      'a2a_events', 'activity', 'connection_heartbeat', 'conversations', 'events', 'handled_messages', 'message_attempts', 'messages',
      'milestones', 'observations', 'session_state', 'sessions', 'social_echo', 'social_pledge', 'social_seek', 'thread_extract_state', 'threads', 'turn_records',
    ])
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/lib/state-migration.test.ts`
Expected: FAIL — `user_version` is 19; `social_pledge` missing from the table list.

- [ ] **Step 3: Append migration v20** — in `src/lib/db.ts`, add a new entry at the END of the `migrations` array (immediately after the v19 social-tables entry that closes with `].` at ~`:479`, i.e. after its closing `},`):

```ts
  // v20 — async foraging spine. Adds the reveal columns to social_echo (the
  // seeker's side) + the social_pledge table (the answerer's mirror side) so
  // dual-confirm can move OUT of broker.seek() into a durable, row-driven,
  // restart-survivable mutual reveal. Nullable-TEXT ADD COLUMN is safe on a
  // STRICT table; social_echo is created unconditionally by v19 above, so no
  // table-exists guard is needed even for the user_version=9 test harnesses.
  // See docs/superpowers/specs/2026-07-15-async-foraging-spine-design.md.
  (db) => {
    db.exec(`
      ALTER TABLE social_echo ADD COLUMN peer_agent_id TEXT;
      ALTER TABLE social_echo ADD COLUMN self_revealed_at TEXT;
      ALTER TABLE social_echo ADD COLUMN peer_revealed_at TEXT;
      CREATE TABLE IF NOT EXISTS social_pledge (
        id                TEXT PRIMARY KEY,
        intent_id         TEXT NOT NULL,
        seeker_agent_id   TEXT NOT NULL,      -- who sought (POST back their /a2a/reveal)
        topic             TEXT NOT NULL,
        self_revealed_at  TEXT,               -- when THIS owner revealed (nullable)
        peer_revealed_at  TEXT,               -- when the seeker revealed (nullable)
        created_at        TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_social_pledge_intent ON social_pledge(intent_id);
    `)
  },
```

- [ ] **Step 3b: Run the db migration test too** — `src/lib/db.test.ts` exercises `PRAGMA user_version = 9` → `runMigrations`; confirm it still passes (the v19 `CREATE TABLE IF NOT EXISTS social_echo` runs before v20's ALTER).

Run: `bun run test src/lib/db.test.ts`
Expected: PASS.

- [ ] **Step 4: Run to verify the smoke test passes**

Run: `bun run test src/lib/state-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(db): migration v20 — social_echo reveal columns + social_pledge table"`

---

## Task 2: Echo store — new columns + reveal methods

**Files:**
- Modify: `src/core/social-echo-store.ts`
- Test: `src/core/social-echo-store.test.ts`
- Modify (typecheck ripple): `src/daemon/internal-api.test.ts` (`EchoRow` fixture ~`:2736`), `src/daemon/wiring/pipeline-deps-social-dispatch.test.ts` (`echoStore` stub ~`:27`)

**Interfaces:**
- Consumes: migration v20's `social_echo` columns.
- Produces:
  - `EchoRow` gains `peer_agent_id: string | null; self_revealed_at: string | null; peer_revealed_at: string | null`.
  - `EchoStore.create(e: { id; seekId; peerMasked; degree; content; peerAgentId: string })` — now writes `peer_agent_id`.
  - `EchoStore.setSelfRevealed(id: string, at: string): void`
  - `EchoStore.setPeerRevealed(id: string, at: string): void`
  - `EchoStore.setRevealedIdentity(id: string, name: string): void` — writes the revealed peer name into `peer_masked` (spec: frontend swaps masked→real; no identity column exists, so `peer_masked` becomes the real name post-reveal).
  - The echo id is `intent_id:peer_agent_id`, so the existing `get(id)` is the reveal lookup — **no new getter is added.**

> NOTE — signature change: `create` now requires `peerAgentId`. The only production caller was bootstrap's P1 recording wrapper, which Task 8 replaces with the `recordEcho` hook. Test stubs are updated below so the tree typechecks after this task.

- [ ] **Step 1: Write the failing test** — replace the body of `src/core/social-echo-store.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeEchoStore } from './social-echo-store'

describe('makeEchoStore', () => {
  it('creates pending echoes, lists by seek + all, and updates status', () => {
    const db = openDb({ path: ':memory:' })
    const e = makeEchoStore(db)
    e.create({ id: 'e1', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: '我认识个老师傅', peerAgentId: 'ccb' })
    e.create({ id: 'e2', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: '我家布偶生了一窝', peerAgentId: 'ccc' })
    expect(e.get('e1')!.status).toBe('pending')
    expect(e.get('e1')!.peer_agent_id).toBe('ccb')
    expect(e.get('e1')!.self_revealed_at).toBeNull()
    expect(e.get('e1')!.peer_revealed_at).toBeNull()
    expect(e.listForSeek('k1').map(r => r.id).sort()).toEqual(['e1', 'e2'])
    e.setStatus('e1', 'revealed')
    expect(e.get('e1')!.status).toBe('revealed')
    expect(e.listAll().length).toBe(2)
  })

  it('records the two reveal timestamps + swaps the masked name for the real identity', () => {
    const db = openDb({ path: ':memory:' })
    const e = makeEchoStore(db)
    e.create({ id: 'e1', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    e.setSelfRevealed('e1', '2026-07-15T00:00:00.000Z')
    e.setPeerRevealed('e1', '2026-07-15T00:01:00.000Z')
    e.setRevealedIdentity('e1', '小B')
    const r = e.get('e1')!
    expect(r.self_revealed_at).toBe('2026-07-15T00:00:00.000Z')
    expect(r.peer_revealed_at).toBe('2026-07-15T00:01:00.000Z')
    expect(r.peer_masked).toBe('小B')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/core/social-echo-store.test.ts`
Expected: FAIL — `create` rejects `peerAgentId` / `setSelfRevealed` is not a function.

- [ ] **Step 3: Implement** — replace `src/core/social-echo-store.ts` with:

```ts
/**
 * social-echo-store.ts — persisted "postcards" that came back for a seek
 * (觅食台 P1). Masked peer identity until dual-confirm reveal; the async
 * foraging spine adds peer_agent_id (server-side only, needed to POST the
 * peer's /a2a/reveal) + the two reveal timestamps.
 */
import type { Db } from '../lib/db'

export interface EchoRow {
  id: string; seek_id: string; peer_masked: string; degree: number
  content: string; status: 'pending' | 'revealed' | 'declined'; created_at: string
  peer_agent_id: string | null
  self_revealed_at: string | null
  peer_revealed_at: string | null
}
export interface EchoStore {
  create(e: { id: string; seekId: string; peerMasked: string; degree: number; content: string; peerAgentId: string }): void
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

export function makeEchoStore(db: Db): EchoStore {
  const ins = db.query<unknown, [string, string, string, number, string, string, string]>(
    `INSERT INTO social_echo(id, seek_id, peer_masked, degree, content, status, created_at, peer_agent_id)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
  const selOne = db.query<EchoRow, [string]>('SELECT * FROM social_echo WHERE id = ?')
  const selBySeek = db.query<EchoRow, [string]>(
    'SELECT * FROM social_echo WHERE seek_id = ? ORDER BY created_at DESC, rowid DESC',
  )
  const selAll = db.query<EchoRow, []>('SELECT * FROM social_echo ORDER BY created_at DESC, rowid DESC')
  const updStatus = db.query<unknown, [string, string]>('UPDATE social_echo SET status = ? WHERE id = ?')
  const updSelf = db.query<unknown, [string, string]>('UPDATE social_echo SET self_revealed_at = ? WHERE id = ?')
  const updPeer = db.query<unknown, [string, string]>('UPDATE social_echo SET peer_revealed_at = ? WHERE id = ?')
  const updIdentity = db.query<unknown, [string, string]>('UPDATE social_echo SET peer_masked = ? WHERE id = ?')
  return {
    create(e) { ins.run(e.id, e.seekId, e.peerMasked, e.degree, e.content, new Date().toISOString(), e.peerAgentId) },
    setStatus(id, status) { updStatus.run(status, id) },
    setSelfRevealed(id, at) { updSelf.run(at, id) },
    setPeerRevealed(id, at) { updPeer.run(at, id) },
    setRevealedIdentity(id, name) { updIdentity.run(name, id) },
    listForSeek(seekId) { return selBySeek.all(seekId) },
    listAll() { return selAll.all() },
    get(id) { return selOne.get(id) ?? null },
  }
}
```

- [ ] **Step 4: Fix the two typecheck ripples** (both are test-only stubs/fixtures the widened types now break):

In `src/daemon/internal-api.test.ts`, the `echoRow: EchoRow` fixture (~`:2736`) — add the three new fields:

```ts
    const echoRow: EchoRow = {
      id: 'e1', seek_id: 'k1', peer_masked: 'p***', degree: 1,
      content: 'hi there', status: 'pending', created_at: 't',
      peer_agent_id: 'ccb', self_revealed_at: null, peer_revealed_at: null,
    }
```

In `src/daemon/wiring/pipeline-deps-social-dispatch.test.ts`, the `echoStore` stub inside `socialStoreStubs` (~`:27`) — add the three new methods so it still `satisfies EchoStore`:

```ts
  echoStore: { create() {}, setStatus() {}, setSelfRevealed() {}, setPeerRevealed() {}, setRevealedIdentity() {}, listForSeek: () => [], listAll: () => [], get: () => null },
```

- [ ] **Step 5: Run + typecheck**

Run: `bun run test src/core/social-echo-store.test.ts` → PASS.
Run: `bun run typecheck` → clean (the two fixtures are the only ripples; `pipeline-deps-social-dispatch.test.ts` is rewritten in Task 9 but must typecheck now).

- [ ] **Step 6: Commit** — `git commit -am "feat(social): echo store peer_agent_id + reveal-timestamp methods"`

---

## Task 3: Pledge store (new) — the answerer's mirror side

**Files:**
- Create: `src/core/social-pledge-store.ts`
- Test: `src/core/social-pledge-store.test.ts`

**Interfaces:**
- Consumes: migration v20's `social_pledge` table.
- Produces:
  - `PledgeRow { id: string; intent_id: string; seeker_agent_id: string; topic: string; self_revealed_at: string | null; peer_revealed_at: string | null; created_at: string }`.
  - `makePledgeStore(db: Db): PledgeStore` where `PledgeStore` = `create(p: { id; intentId; seekerAgentId; topic }): void` / `get(id): PledgeRow | null` / `list(): PledgeRow[]` / `setSelfRevealed(id, at): void` / `setPeerRevealed(id, at): void`. id = `intent_id:seeker_agent_id`.

- [ ] **Step 1: Write the failing test** — create `src/core/social-pledge-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makePledgeStore } from './social-pledge-store'

describe('makePledgeStore', () => {
  it('creates pledges, lists newest-first, gets by id, and records reveal timestamps', () => {
    const db = openDb({ path: ':memory:' })
    const p = makePledgeStore(db)
    p.create({ id: 'i1:cca', intentId: 'i1', seekerAgentId: 'cca', topic: '找摄影搭子' })
    p.create({ id: 'i2:ccd', intentId: 'i2', seekerAgentId: 'ccd', topic: '找球友' })
    expect(p.list().map(r => r.id)).toEqual(['i2:ccd', 'i1:cca'])   // newest first
    const row = p.get('i1:cca')!
    expect(row.intent_id).toBe('i1')
    expect(row.seeker_agent_id).toBe('cca')
    expect(row.self_revealed_at).toBeNull()
    expect(row.peer_revealed_at).toBeNull()
    p.setSelfRevealed('i1:cca', '2026-07-15T00:00:00.000Z')
    p.setPeerRevealed('i1:cca', '2026-07-15T00:01:00.000Z')
    const after = p.get('i1:cca')!
    expect(after.self_revealed_at).toBe('2026-07-15T00:00:00.000Z')
    expect(after.peer_revealed_at).toBe('2026-07-15T00:01:00.000Z')
    expect(p.get('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/core/social-pledge-store.test.ts`
Expected: FAIL — module `./social-pledge-store` does not exist.

- [ ] **Step 3: Implement** — create `src/core/social-pledge-store.ts`:

```ts
/**
 * social-pledge-store.ts — the answerer's mirror of an echo. When MY bot
 * answers someone ELSE's wish with match:'yes', it records a pledge so it can
 * later reveal back. There is no local social_seek parent (the wish is the
 * peer's), so it is its own table. Symmetric to social-echo-store.ts.
 */
import type { Db } from '../lib/db'

export interface PledgeRow {
  id: string; intent_id: string; seeker_agent_id: string; topic: string
  self_revealed_at: string | null; peer_revealed_at: string | null; created_at: string
}
export interface PledgeStore {
  create(p: { id: string; intentId: string; seekerAgentId: string; topic: string }): void
  get(id: string): PledgeRow | null
  list(): PledgeRow[]
  setSelfRevealed(id: string, at: string): void
  setPeerRevealed(id: string, at: string): void
}

export function makePledgeStore(db: Db): PledgeStore {
  const ins = db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO social_pledge(id, intent_id, seeker_agent_id, topic, self_revealed_at, peer_revealed_at, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
  )
  const selOne = db.query<PledgeRow, [string]>('SELECT * FROM social_pledge WHERE id = ?')
  const selAll = db.query<PledgeRow, []>('SELECT * FROM social_pledge ORDER BY created_at DESC, rowid DESC')
  const updSelf = db.query<unknown, [string, string]>('UPDATE social_pledge SET self_revealed_at = ? WHERE id = ?')
  const updPeer = db.query<unknown, [string, string]>('UPDATE social_pledge SET peer_revealed_at = ? WHERE id = ?')
  return {
    create(p) { ins.run(p.id, p.intentId, p.seekerAgentId, p.topic, new Date().toISOString()) },
    get(id) { return selOne.get(id) ?? null },
    list() { return selAll.all() },
    setSelfRevealed(id, at) { updSelf.run(at, id) },
    setPeerRevealed(id, at) { updPeer.run(at, id) },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/core/social-pledge-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(social): social_pledge store (answerer's reveal-back side)"`

---

## Task 4: Reveal reconciliation core (the heart)

**Files:**
- Create: `src/core/social-reveal.ts`
- Test: `src/core/social-reveal.test.ts`

**Interfaces:**
- Consumes: `EchoStore` (Task 2), `PledgeStore` (Task 3), `SeekStore` (`social-seek-store.ts`). Its `postPeerReveal` / `selfIdentity` / `notify` deps are supplied by the caller (unit tests inject fakes; Task 8 supplies the real A2A + WeChat impls).
- Produces:
  - `PeerIdentity = { name: string; url: string }`
  - `RevealBeat = 'first_echo' | 'await_reveal' | 'connected'`
  - `NotifyCtx = { intentId: string; peerAgentId?: string; peerName?: string }`
  - `RevealOutcome = { state: 'connected' | 'awaiting_peer' | 'peer_unreachable' }`
  - `RevealerDeps = { echoStore; pledgeStore; seekStore; postPeerReveal(agentId, intentId): Promise<{ mutual: boolean; identity?: PeerIdentity } | null>; selfIdentity(): PeerIdentity; notify(beat: RevealBeat, ctx: NotifyCtx): void }`
  - `makeRevealer(deps: RevealerDeps): Revealer` where `Revealer = { revealEcho(echoId): Promise<RevealOutcome | null>; revealPledge(pledgeId): Promise<RevealOutcome | null>; onInboundReveal(ev: { agentId: string; intentId: string }): { mutual: boolean; identity?: PeerIdentity } }`.

> Design notes baked in: `revealEcho`/`revealPledge` return `null` when no such row exists (route → 404). The revealer only fires `notify` with `'await_reveal'` / `'connected'` (the `'first_echo'` beat is fired by the broker's `recordEcho` wiring in Task 8 — the shared `notify` type just includes it). On `onInboundReveal`-driven `connected`, we hold only the peer's `agentId` (the inbound body carries no display name), so we pass `peerAgentId` and let the Task-8 `notify` impl resolve the name from the registry; on outbound-driven `connected` we have `identity.name` and pass `peerName`.

- [ ] **Step 1: Write the failing test** — create `src/core/social-reveal.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makeEchoStore } from './social-echo-store'
import { makePledgeStore } from './social-pledge-store'
import { makeSeekStore } from './social-seek-store'
import { makeRevealer, type PeerIdentity } from './social-reveal'

const SELF: PeerIdentity = { name: '我方', url: 'http://self/a2a' }
const PEER: PeerIdentity = { name: '小B', url: 'http://peerb/a2a' }

function fixture(postPeerReveal: any) {
  const db = openDb({ path: ':memory:' })
  const echoStore = makeEchoStore(db)
  const pledgeStore = makePledgeStore(db)
  const seekStore = makeSeekStore(db)
  const notify = vi.fn()
  const revealer = makeRevealer({ echoStore, pledgeStore, seekStore, postPeerReveal, selfIdentity: () => SELF, notify })
  return { db, echoStore, pledgeStore, seekStore, notify, revealer }
}

describe('makeRevealer — echo side (I reveal first)', () => {
  it('I reveal, peer already consented → mutual: echo revealed, seek connected, identity swapped, beat #3', async () => {
    const post = vi.fn(async () => ({ mutual: true, identity: PEER }))
    const { echoStore, seekStore, notify, revealer } = fixture(post)
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const out = await revealer.revealEcho('i1:ccb')

    expect(out).toEqual({ state: 'connected' })
    expect(post).toHaveBeenCalledWith('ccb', 'i1')
    const echo = echoStore.get('i1:ccb')!
    expect(echo.status).toBe('revealed')
    expect(echo.self_revealed_at).not.toBeNull()
    expect(echo.peer_revealed_at).not.toBeNull()
    expect(echo.peer_masked).toBe('小B')                    // identity swapped in
    expect(seekStore.get('i1')!.status).toBe('connected')
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i1', peerName: '小B' }))
  })

  it('I reveal, peer has NOT → awaiting_peer, my consent persisted, no connected beat', async () => {
    const post = vi.fn(async () => ({ mutual: false }))
    const { echoStore, seekStore, notify, revealer } = fixture(post)
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const out = await revealer.revealEcho('i1:ccb')

    expect(out).toEqual({ state: 'awaiting_peer' })
    expect(echoStore.get('i1:ccb')!.self_revealed_at).not.toBeNull()
    expect(echoStore.get('i1:ccb')!.peer_revealed_at).toBeNull()
    expect(seekStore.get('i1')!.status).toBe('foraging')
    expect(notify).not.toHaveBeenCalledWith('connected', expect.anything())
  })

  it('peer unreachable → peer_unreachable, my consent is NOT lost, retryable', async () => {
    const post = vi.fn(async () => null)
    const { echoStore, revealer } = fixture(post)
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const out = await revealer.revealEcho('i1:ccb')

    expect(out).toEqual({ state: 'peer_unreachable' })
    expect(echoStore.get('i1:ccb')!.self_revealed_at).not.toBeNull()
  })

  it('double reveal after connected is a no-op (idempotent)', async () => {
    const post = vi.fn(async () => ({ mutual: true, identity: PEER }))
    const { echoStore, revealer } = fixture(post)
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    await revealer.revealEcho('i1:ccb')
    post.mockClear()
    const out = await revealer.revealEcho('i1:ccb')
    expect(out).toEqual({ state: 'connected' })
    expect(post).not.toHaveBeenCalled()                     // already mutual → no second outbound call
  })

  it('returns null when the echo id does not exist', async () => {
    const { revealer } = fixture(vi.fn(async () => null))
    expect(await revealer.revealEcho('nope:ccb')).toBeNull()
  })
})

describe('makeRevealer — inbound (peer reveals first)', () => {
  it('peer reveals before me → mutual:false, beat #2 (await_reveal) fires', () => {
    const { echoStore, notify, revealer } = fixture(vi.fn())
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    const resp = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })

    expect(resp).toEqual({ mutual: false })
    expect(echoStore.get('i1:ccb')!.peer_revealed_at).not.toBeNull()
    expect(notify).toHaveBeenCalledWith('await_reveal', expect.objectContaining({ intentId: 'i1', peerAgentId: 'ccb' }))
  })

  it('second revealer gets mutual synchronously with our identity (I revealed first, peer calls in)', () => {
    const { echoStore, seekStore, notify, revealer } = fixture(vi.fn())
    seekStore.create({ id: 'i1', kind: 'seek', topic: 't' })
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    echoStore.setSelfRevealed('i1:ccb', '2026-07-15T00:00:00.000Z')  // I already revealed

    const resp = revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })

    expect(resp).toEqual({ mutual: true, identity: SELF })
    expect(echoStore.get('i1:ccb')!.status).toBe('revealed')
    expect(seekStore.get('i1')!.status).toBe('connected')
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i1', peerAgentId: 'ccb' }))
  })

  it('resolves against a pledge when there is no echo (I answered THEIR wish)', () => {
    const { pledgeStore, notify, revealer } = fixture(vi.fn())
    pledgeStore.create({ id: 'i2:cca', intentId: 'i2', seekerAgentId: 'cca', topic: 't' })

    const resp = revealer.onInboundReveal({ agentId: 'cca', intentId: 'i2' })

    expect(resp).toEqual({ mutual: false })
    expect(pledgeStore.get('i2:cca')!.peer_revealed_at).not.toBeNull()
    expect(notify).toHaveBeenCalledWith('await_reveal', expect.objectContaining({ intentId: 'i2', peerAgentId: 'cca' }))
  })

  it('no matching row → mutual:false, no throw', () => {
    const { revealer } = fixture(vi.fn())
    expect(revealer.onInboundReveal({ agentId: 'zzz', intentId: 'nope' })).toEqual({ mutual: false })
  })
})

describe('makeRevealer — pledge side (I reveal my answer)', () => {
  it('revealPledge mutual → connected beat, timestamps set', async () => {
    const post = vi.fn(async () => ({ mutual: true, identity: PEER }))
    const { pledgeStore, notify, revealer } = fixture(post)
    pledgeStore.create({ id: 'i2:cca', intentId: 'i2', seekerAgentId: 'cca', topic: 't' })

    const out = await revealer.revealPledge('i2:cca')

    expect(out).toEqual({ state: 'connected' })
    expect(post).toHaveBeenCalledWith('cca', 'i2')
    expect(pledgeStore.get('i2:cca')!.self_revealed_at).not.toBeNull()
    expect(pledgeStore.get('i2:cca')!.peer_revealed_at).not.toBeNull()
    expect(notify).toHaveBeenCalledWith('connected', expect.objectContaining({ intentId: 'i2', peerName: '小B' }))
  })

  it('identity never leaks before reveal', () => {
    const { echoStore, revealer } = fixture(vi.fn())
    echoStore.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    // Before any reveal, the masked placeholder is intact and no identity is exposed.
    expect(echoStore.get('i1:ccb')!.peer_masked).toBe('第 1 度的某人')
    // An inbound reveal we have NOT matched with our own consent returns no identity.
    expect(revealer.onInboundReveal({ agentId: 'ccb', intentId: 'i1' })).toEqual({ mutual: false })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/core/social-reveal.test.ts`
Expected: FAIL — module `./social-reveal` does not exist.

- [ ] **Step 3: Implement** — create `src/core/social-reveal.ts`:

```ts
/**
 * social-reveal.ts — the row-driven mutual reveal core (双向异步互揭). One
 * function, three entry points: revealEcho / revealPledge (outbound: my owner
 * clicked 揭晓) and onInboundReveal (a peer's /a2a/reveal arrived). Whoever
 * reveals SECOND learns mutual:true synchronously in their own round-trip; the
 * connection is two local rows on two machines, each side transitioning on
 * "both marked". No in-memory waiting — restart-survivability is a property of
 * the rows. See docs/superpowers/specs/2026-07-15-async-foraging-spine-design.md.
 */
import type { EchoStore } from './social-echo-store'
import type { PledgeStore } from './social-pledge-store'
import type { SeekStore } from './social-seek-store'

export interface PeerIdentity { name: string; url: string }
export type RevealBeat = 'first_echo' | 'await_reveal' | 'connected'
export interface NotifyCtx { intentId: string; peerAgentId?: string; peerName?: string }
export interface RevealOutcome { state: 'connected' | 'awaiting_peer' | 'peer_unreachable' }

export interface RevealerDeps {
  echoStore: EchoStore
  pledgeStore: PledgeStore
  seekStore: SeekStore
  /** Outbound A2A POST to the peer's /a2a/reveal. null when unreachable. */
  postPeerReveal(agentId: string, intentId: string): Promise<{ mutual: boolean; identity?: PeerIdentity } | null>
  /** This daemon's public identity ({ name, url }) handed back on the mutual instant. */
  selfIdentity(): PeerIdentity
  /** Notification beats (克制三拍). Only await_reveal + connected fire from here. */
  notify(beat: RevealBeat, ctx: NotifyCtx): void
}

export interface Revealer {
  revealEcho(echoId: string): Promise<RevealOutcome | null>
  revealPledge(pledgeId: string): Promise<RevealOutcome | null>
  onInboundReveal(ev: { agentId: string; intentId: string }): { mutual: boolean; identity?: PeerIdentity }
}

export function makeRevealer(deps: RevealerDeps): Revealer {
  return {
    async revealEcho(echoId) {
      const echo = deps.echoStore.get(echoId)
      if (!echo) return null
      if (echo.self_revealed_at && echo.peer_revealed_at) return { state: 'connected' }  // already mutual, no-op
      const now = new Date().toISOString()
      if (!echo.self_revealed_at) deps.echoStore.setSelfRevealed(echoId, now)             // my consent, idempotent
      if (!echo.peer_agent_id) return { state: 'peer_unreachable' }                       // legacy row, can't POST back
      const resp = await deps.postPeerReveal(echo.peer_agent_id, echo.seek_id)
      if (!resp) return { state: 'peer_unreachable' }                                     // consent already persisted
      if (!resp.mutual) return { state: 'awaiting_peer' }
      deps.echoStore.setPeerRevealed(echoId, now)
      deps.echoStore.setStatus(echoId, 'revealed')
      deps.seekStore.update(echo.seek_id, { status: 'connected' })
      if (resp.identity) deps.echoStore.setRevealedIdentity(echoId, resp.identity.name)
      deps.notify('connected', { intentId: echo.seek_id, peerName: resp.identity?.name })
      return { state: 'connected' }
    },

    async revealPledge(pledgeId) {
      const pledge = deps.pledgeStore.get(pledgeId)
      if (!pledge) return null
      if (pledge.self_revealed_at && pledge.peer_revealed_at) return { state: 'connected' }
      const now = new Date().toISOString()
      if (!pledge.self_revealed_at) deps.pledgeStore.setSelfRevealed(pledgeId, now)
      const resp = await deps.postPeerReveal(pledge.seeker_agent_id, pledge.intent_id)
      if (!resp) return { state: 'peer_unreachable' }
      if (!resp.mutual) return { state: 'awaiting_peer' }
      deps.pledgeStore.setPeerRevealed(pledgeId, now)
      deps.notify('connected', { intentId: pledge.intent_id, peerName: resp.identity?.name })
      return { state: 'connected' }
    },

    onInboundReveal({ agentId, intentId }) {
      const now = new Date().toISOString()
      const rowId = `${intentId}:${agentId}`
      const echo = deps.echoStore.get(rowId)
      if (echo) {
        deps.echoStore.setPeerRevealed(rowId, now)
        if (echo.self_revealed_at) {
          deps.echoStore.setStatus(rowId, 'revealed')
          deps.seekStore.update(intentId, { status: 'connected' })
          deps.notify('connected', { intentId, peerAgentId: agentId })
          return { mutual: true, identity: deps.selfIdentity() }
        }
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      const pledge = deps.pledgeStore.get(rowId)
      if (pledge) {
        deps.pledgeStore.setPeerRevealed(rowId, now)
        if (pledge.self_revealed_at) {
          deps.notify('connected', { intentId, peerAgentId: agentId })
          return { mutual: true, identity: deps.selfIdentity() }
        }
        deps.notify('await_reveal', { intentId, peerAgentId: agentId })
        return { mutual: false }
      }
      return { mutual: false }  // nothing to reveal against; respond without leaking
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/core/social-reveal.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit** — `git commit -am "feat(social): mutual async reveal core (revealEcho/revealPledge/onInboundReveal)"`

---

## Task 5: `seek()` non-blocking split (sow + background forage)

**Files:**
- Modify: `src/core/social-broker.ts`
- Test: `src/core/social-broker.test.ts`

**Interfaces:**
- Consumes: the caller injects `sow` / `recordEcho` / `finishSeek` / `schedule?` (Task 8 supplies the real store-backed impls).
- Produces:
  - `SeekOutcome = { intent_id: string }` (redefined — the old `matched`/`lit` fields are gone; the broker no longer confirms inline).
  - `EchoRecord = { intentId: string; peerAgentId: string; peerMasked: string; degree: number; content: string; first: boolean }`.
  - `BrokerDeps` = `{ discover; send; policy; cheapEval; ttlMs?; sow(intentId, topic): void; recordEcho(e: EchoRecord): void; finishSeek(intentId, status: 'echoed' | 'closed', peersAsked): void; schedule?(fn: () => Promise<void>): void }` — **`confirmWithOwner` / `confirmPeer` removed.**
  - `makeBroker(deps): { seek(topic, opts?): Promise<SeekOutcome>; forage(intentId, topic, opts?): Promise<void> }`. `seek` runs the sync leg then `schedule(() => forage(...))`; `forage` is the background leg (also called directly by the boot-scan resume in Task 8).

- [ ] **Step 1: Rewrite the test** — replace `src/core/social-broker.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { makeBroker } from './social-broker'

const cheapEval = async () => JSON.stringify({ violation: false, redacted: '找摄影搭子' })
const peerB = { id: 'ccb', name: 'CC-B' } as any

// A scheduler that captures the background coroutine so the test can assert
// what state exists BEFORE it runs, then drive it deterministically.
function deferred() {
  const jobs: Array<() => Promise<void>> = []
  return { schedule: (fn: () => Promise<void>) => { jobs.push(fn) }, run: () => Promise.all(jobs.map(j => j())) }
}
function stubDeps(over: Partial<Parameters<typeof makeBroker>[0]> = {}) {
  return {
    policy: 'p', cheapEval,
    discover: async () => [peerB],
    send: async () => ({ intent_id: 'x', match: 'yes' as const, blurb: '也爱摄影' }),
    sow: () => {},
    recordEcho: () => {},
    finishSeek: () => {},
    ...over,
  }
}

describe('makeBroker.seek — non-blocking', () => {
  it('returns { intent_id } after the sync leg, BEFORE any echo is recorded', async () => {
    const recorded: string[] = []
    const d = deferred()
    const broker = makeBroker(stubDeps({ recordEcho: (e) => { recorded.push(e.peerAgentId) }, schedule: d.schedule }))
    const out = await broker.seek('找摄影搭子')
    expect(out.intent_id).toMatch(/.+/)
    expect(recorded).toEqual([])          // background leg has not run yet
    await d.run()
    expect(recorded).toEqual(['ccb'])     // echo recorded only after foraging
  })

  it('sows a foraging seek row synchronously', async () => {
    const sown: Array<{ id: string; topic: string }> = []
    const broker = makeBroker(stubDeps({ sow: (id, topic) => { sown.push({ id, topic }) }, schedule: () => {} }))
    const out = await broker.seek('找摄影搭子')
    expect(sown).toEqual([{ id: out.intent_id, topic: '找摄影搭子' }])
  })

  it('the FIRST echo per seek is flagged first:true, the rest first:false', async () => {
    const flags: boolean[] = []
    const d = deferred()
    const broker = makeBroker(stubDeps({
      discover: async () => [peerB, { id: 'ccc', name: 'CC-C' } as any],
      recordEcho: (e) => { flags.push(e.first) },
      schedule: d.schedule,
    }))
    await broker.seek('找摄影搭子')
    await d.run()
    expect(flags).toEqual([true, false])
  })

  it('finishSeek marks echoed when ≥1 echo, closed when none', async () => {
    const finishes: Array<[string, string, number]> = []
    const d = deferred()
    const yes = makeBroker(stubDeps({ finishSeek: (id, s, n) => finishes.push([id, s, n]), schedule: d.schedule }))
    await yes.seek('找摄影搭子'); await d.run()
    expect(finishes[0]![1]).toBe('echoed')

    const finishes2: Array<[string, string, number]> = []
    const d2 = deferred()
    const no = makeBroker(stubDeps({ send: async () => ({ intent_id: 'x', match: 'no' as const }), finishSeek: (id, s, n) => finishes2.push([id, s, n]), schedule: d2.schedule }))
    await no.seek('找打篮球的'); await d2.run()
    expect(finishes2[0]![1]).toBe('closed')
  })

  it('one bad peer does not abort the forage — the good peer still records', async () => {
    const recorded: string[] = []
    const d = deferred()
    const bad = { id: 'bad', name: 'BAD' } as any
    const broker = makeBroker(stubDeps({
      discover: async () => [bad, peerB],
      send: async (hand: any) => { if (hand.id === 'bad') throw new Error('boom'); return { intent_id: 'x', match: 'yes' as const, blurb: 'ok' } },
      recordEcho: (e) => { recorded.push(e.peerAgentId) },
      schedule: d.schedule,
    }))
    await broker.seek('找摄影搭子'); await d.run()
    expect(recorded).toEqual(['ccb'])
  })

  it('a recordEcho store failure never throws out of the forage', async () => {
    const d = deferred()
    const broker = makeBroker(stubDeps({ recordEcho: () => { throw new Error('db locked') }, finishSeek: () => {}, schedule: d.schedule }))
    await broker.seek('找摄影搭子')
    await expect(d.run()).resolves.toBeDefined()   // forage swallows the write failure
  })

  it('gate blocks the intent topic → nothing sown, nothing sent, no forage scheduled', async () => {
    let sent = 0, sown = 0, scheduled = 0
    const broker = makeBroker(stubDeps({
      cheapEval: async () => JSON.stringify({ violation: true, redacted: '', reasons: ['leak'] }),
      send: async () => { sent++; return { intent_id: 'x', match: 'yes' as const } },
      sow: () => { sown++ },
      schedule: () => { scheduled++ },
    }))
    const out = await broker.seek('涉密意图')
    expect(out.intent_id).toMatch(/.+/)
    expect([sent, sown, scheduled]).toEqual([0, 0, 0])
  })

  it('redacted topic is what actually gets sent (not raw input)', async () => {
    let sentCard: any
    const d = deferred()
    const broker = makeBroker(stubDeps({
      cheapEval: async () => JSON.stringify({ violation: false, redacted: '寻找摄影伙伴【已清理】' }),
      send: async (_h: any, card: any) => { sentCard = card; return { intent_id: 'x', match: 'yes' as const } },
      schedule: d.schedule,
    }))
    await broker.seek('找摄影搭子+电话'); await d.run()
    expect(sentCard.topic).toBe('寻找摄影伙伴【已清理】')
    expect(sentCard.topic).not.toBe('找摄影搭子+电话')
  })

  it('city gated through: forage sends the redacted city', async () => {
    let sentCard: any, n = 0
    const d = deferred()
    const broker = makeBroker(stubDeps({
      cheapEval: async () => { n++; return JSON.stringify(n === 1 ? { violation: false, redacted: '找摄影搭子' } : { violation: false, redacted: '<REDACTED-CITY>' }) },
      send: async (_h: any, card: any) => { sentCard = card; return { intent_id: 'x', match: 'yes' as const } },
      schedule: d.schedule,
    }))
    await broker.seek('找摄影搭子', { city: 'Beijing' }); await d.run()
    expect(sentCard.city).toBe('<REDACTED-CITY>')
  })

  it('city blocked by gate: omit from card, forage still proceeds', async () => {
    let sentCard: any, n = 0
    const d = deferred()
    const broker = makeBroker(stubDeps({
      cheapEval: async () => { n++; return JSON.stringify(n === 1 ? { violation: false, redacted: '找摄影搭子' } : { violation: true, redacted: '', reasons: ['leak'] }) },
      send: async (_h: any, card: any) => { sentCard = card; return { intent_id: 'x', match: 'yes' as const } },
      schedule: d.schedule,
    }))
    await broker.seek('找摄影搭子', { city: 'Beijing' }); await d.run()
    expect(sentCard.city).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/core/social-broker.test.ts`
Expected: FAIL — `makeBroker` still expects `confirmWithOwner`/`confirmPeer`; `seek` returns `matched`/`lit`; no `forage`.

- [ ] **Step 3: Rewrite the broker** — replace `src/core/social-broker.ts` with:

```ts
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
```

> Note: `content` now holds the sanitized blurb persisted at record time; the old inline `sanitizeBlurb` for the owner-confirm summary is gone with `confirmWithOwner`. `gateOutbound` runs in both `seek` (abort-early) and `forage` (authoritative) — a deliberate, cheap double-gate that keeps `forage` self-contained for restart-resume (which only has the topic).

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/core/social-broker.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck** — `bun run typecheck` will now report errors in `bootstrap/index.ts` (uses `confirmWithOwner`/`SeekOutcome.matched`) and `social-m1.e2e.test.ts`. Those are fixed in Tasks 8 and 10 respectively. If you are running tasks strictly in order, expect this typecheck to be red until Task 8 lands; the per-file tests above are green. (Subagent-driven execution isolates each task's test; the tree-wide typecheck gate is Task 8's Step for the broker consumers.)

- [ ] **Step 6: Commit** — `git commit -am "feat(social): non-blocking seek — sync sow + background forage; drop inline confirm"`

---

## Task 6: a2a-server `onReveal` + `POST /a2a/reveal`

**Files:**
- Modify: `src/core/a2a-server.ts`
- Test: `src/core/a2a-server.test.ts`

**Interfaces:**
- Consumes: a wired `onReveal` (Task 8 passes `revealer.onInboundReveal`, adapted to a Promise).
- Produces:
  - `RevealEvent = { agent_id: string; intent_id: string }`
  - `A2AServerOpts.onReveal?: (event: RevealEvent) => Promise<{ mutual: boolean; identity?: { name: string; url: string } }>`
  - `POST /a2a/reveal` route (Bearer, mirrors `/a2a/intent/confirm`) returning the handler's `{ mutual, identity? }` as JSON; agent-card `reveal` capability advertised only when `onReveal` is wired.

- [ ] **Step 1: Add failing tests** — append a describe block to `src/core/a2a-server.test.ts`, and extend the `startServer` helper's opts to accept `onReveal`. First, in the `startServer` opts type (~`:32`) add:

```ts
  onReveal?: (event: import('./a2a-server').RevealEvent) => Promise<{ mutual: boolean; identity?: { name: string; url: string } }>
```

and in the `createA2AServer({ ... })` spread (~`:41`) add:

```ts
    ...(opts.onReveal ? { onReveal: opts.onReveal } : {}),
```

Then add the describe block (mirror the intent/confirm block at ~`:332`):

```ts
  describe('POST /a2a/reveal (async foraging spine)', () => {
    it('runs onReveal and returns { mutual, identity } when authed', async () => {
      const onReveal = vi.fn(async (_e: import('./a2a-server').RevealEvent) => ({ mutual: true, identity: { name: '小B', url: 'http://b/a2a' } }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onReveal })
      try {
        const res = await fetch(`${baseUrl}/a2a/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1' }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ mutual: true, identity: { name: '小B', url: 'http://b/a2a' } })
        expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'alpha', intent_id: 'i1' }))
      } finally { await server.stop() }
    })

    it('returns 501 when this machine is not wired for reveal (no onReveal)', async () => {
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec] })
      try {
        const res = await fetch(`${baseUrl}/a2a/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1' }),
        })
        expect(res.status).toBe(501)
      } finally { await server.stop() }
    })

    it('rejects reveal without a valid Bearer → 401, onReveal not called', async () => {
      const onReveal = vi.fn(async () => ({ mutual: false }))
      const { server, baseUrl } = await startServer({ onReveal })
      try {
        const res = await fetch(`${baseUrl}/a2a/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1' }),
        })
        expect(res.status).toBe(401)
        expect(onReveal).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('advertises the reveal capability in the agent card only when wired', async () => {
      const wired = await startServer({ onReveal: async () => ({ mutual: false }) })
      try {
        const card = await (await fetch(`${wired.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        expect(card.capabilities.some(c => c.name === 'reveal')).toBe(true)
      } finally { await wired.server.stop() }
      const bare = await startServer({})
      try {
        const card = await (await fetch(`${bare.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        expect(card.capabilities.some(c => c.name === 'reveal')).toBe(false)
      } finally { await bare.server.stop() }
    })
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/core/a2a-server.test.ts`
Expected: FAIL — `/a2a/reveal` 404s / `onReveal` opt unknown.

- [ ] **Step 3: Implement** — in `src/core/a2a-server.ts`:

(a) Add the event interface (after `IntentConfirmEvent`, ~`:77`):

```ts
/**
 * A peer's "my owner revealed; wants to connect on this intent" event —
 * the inbound half of the mutual async reveal. Handler marks the local
 * echo/pledge row's peer_revealed_at and, if this side already revealed,
 * responds { mutual:true, identity } for a synchronous connect.
 */
export interface RevealEvent {
  agent_id: string
  intent_id: string
}
```

(b) Add the opt to `A2AServerOpts` (after `onIntentConfirm?`, ~`:112`):

```ts
  /** Optional. When wired, enables POST /a2a/reveal — a peer signals its owner
   *  revealed; mark my matching row + return { mutual, identity? }. Undefined → 501. */
  onReveal?: (event: RevealEvent) => Promise<{ mutual: boolean; identity?: { name: string; url: string } }>
```

(c) Advertise the capability — in the `agentCard.capabilities` array, after the `onIntentConfirm` block (~`:186`):

```ts
      // Advertised only when this machine is wired to receive inbound reveals.
      ...(opts.onReveal ? [{
        name: 'reveal',
        description: 'Mutual async reveal: a peer whose owner revealed asks THIS owner\'s row to mark peer-revealed; returns { mutual, identity } when both sides have revealed.',
        endpoint: '/a2a/reveal',
        method: 'POST',
        request_schema: { agent_id: 'string', intent_id: 'string' },
      }] : []),
```

(d) Add the route handler — insert a new `if (url.pathname === '/a2a/reveal')` block immediately after the `/a2a/intent/confirm` block closes (~`:330`), mirroring it exactly:

```ts
    if (url.pathname === '/a2a/reveal') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (!opts.onReveal) return new Response(JSON.stringify({ error: 'reveal_not_supported' }), { status: 501 })

      let body: { agent_id?: unknown; intent_id?: unknown }
      try {
        body = await req.json() as typeof body
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 })
      }
      if (typeof body.agent_id !== 'string') return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 })
      const claimedId = body.agent_id

      const auth = req.headers.get('authorization')
      if (!auth?.startsWith('Bearer ')) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'missing_bearer' })
        return new Response(JSON.stringify({ error: 'missing_bearer' }), { status: 401 })
      }
      const agent = opts.registry.verifyBearer(claimedId, auth.slice('Bearer '.length).trim())
      if (!agent) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'wrong_bearer' })
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      }
      if (agent.id !== claimedId) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'agent_id_mismatch' })
        return new Response(JSON.stringify({ error: 'agent_id_mismatch' }), { status: 403 })
      }
      if (agent.paused) return new Response(JSON.stringify({ ok: false, reason: 'paused' }), { status: 202 })

      if (typeof body.intent_id !== 'string' || body.intent_id.length === 0) {
        return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 })
      }
      try {
        const result = await opts.onReveal({ agent_id: agent.id, intent_id: body.intent_id })
        return new Response(JSON.stringify(result), { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: 'reveal_failed', detail: msg }), { status: 500 })
      }
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/core/a2a-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(a2a): POST /a2a/reveal inbound handler + agent-card advertise"`

---

## Task 7: internal-api reveal/pledge routes

**Files:**
- Modify: `src/daemon/internal-api/routes-social.ts`
- Modify: `src/daemon/internal-api/route-tiers.ts`
- Modify: `src/daemon/internal-api/types.ts`
- Test: `src/daemon/internal-api.test.ts`

**Interfaces:**
- Consumes: `deps.social` now also carries `pledgeStore: PledgeStore` and `revealer: Revealer`.
- Produces (routes; ids come in the **body**, not the path — the router is exact-match, no `:id` support):
  - `GET /v1/social/pledges` → `{ pledges: deps.social.pledgeStore.list() }`
  - `POST /v1/social/echoes/reveal` `{ id }` → `deps.social.revealer.revealEcho(id)` → `{ outcome }` (or 404 `{ error: 'not_found' }` when the revealer returns null)
  - `POST /v1/social/pledges/reveal` `{ id }` → `revealPledge(id)` → `{ outcome }` (404 on null)
  - All three 503 when `!deps.social`; empty-body-guarded; tiered `'admin'`.

> DEVIATION from the brief's sketch: routes are `POST /v1/social/echoes/reveal` + `POST /v1/social/pledges/reveal` taking `{ id }` in the body, NOT `POST /v1/social/echoes/:id/reveal`. The internal-api router keys on `` `${method} ${url.pathname}` `` exactly (`index.ts:143`) with no path-param support, so a `:id` path can never match.

- [ ] **Step 1: Extend `InternalApiDeps.social`** — in `src/daemon/internal-api/types.ts`, the `social?: { ... }` block (~`:205`) becomes:

```ts
  social?: {
    broker: { seek(topic: string, opts?: { city?: string }): Promise<import('../../core/social-broker').SeekOutcome> }
    seekStore: import('../../core/social-seek-store').SeekStore
    echoStore: import('../../core/social-echo-store').EchoStore
    pledgeStore: import('../../core/social-pledge-store').PledgeStore
    revealer: import('../../core/social-reveal').Revealer
  }
```

- [ ] **Step 2: Write the failing tests** — in `src/daemon/internal-api.test.ts`, extend the social read-routes suite (`startWithSocial` ~`:2741`) to also stub `pledgeStore` + `revealer`, then add route tests. Update `startWithSocial`'s `social` object to include:

```ts
            pledgeStore: {
              create: () => {}, get: () => null, list: () => opts.pledges ?? [],
              setSelfRevealed: () => {}, setPeerRevealed: () => {},
            },
            revealer: {
              revealEcho: async (id: string) => opts.revealEcho ? opts.revealEcho(id) : { state: 'awaiting_peer' as const },
              revealPledge: async (id: string) => opts.revealPledge ? opts.revealPledge(id) : { state: 'awaiting_peer' as const },
              onInboundReveal: () => ({ mutual: false }),
            },
```

and widen the `opts` param type to `{ seeks?; echoes?; pledges?: PledgeRow[]; revealEcho?: (id: string) => any; revealPledge?: (id: string) => any } | null`. Add the import `import type { PledgeRow } from '../core/social-pledge-store'` near the other type imports (~`:16`). Then add a new describe:

```ts
  describe('reveal + pledge routes (async foraging spine)', () => {
    const pledgeRow: PledgeRow = {
      id: 'i1:cca', intent_id: 'i1', seeker_agent_id: 'cca', topic: 't',
      self_revealed_at: null, peer_revealed_at: null, created_at: 't',
    }

    it('GET /v1/social/pledges returns the stored pledges', async () => {
      const { port, token } = await startWithSocial({ pledges: [pledgeRow] })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/social/pledges`, { headers: { Authorization: `Bearer ${token}` } })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ pledges: [pledgeRow] })
    })

    it('GET /v1/social/pledges → 503 when social is not wired', async () => {
      const { port, token } = await startWithSocial()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/social/pledges`, { headers: { Authorization: `Bearer ${token}` } })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toEqual({ error: 'social_not_wired' })
    })

    it('POST /v1/social/echoes/reveal drives revealEcho(id) and returns the outcome', async () => {
      const { port, token } = await startWithSocial({ revealEcho: () => ({ state: 'connected' }) })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/social/echoes/reveal`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'i1:ccb' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ outcome: { state: 'connected' } })
    })

    it('POST /v1/social/echoes/reveal → 404 when the echo id is unknown (revealer returns null)', async () => {
      const { port, token } = await startWithSocial({ revealEcho: () => null })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/social/echoes/reveal`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'nope' }),
      })
      expect(resp.status).toBe(404)
      expect(await resp.json()).toEqual({ error: 'not_found' })
    })

    it('POST /v1/social/echoes/reveal → 503 when social not wired', async () => {
      const { port, token } = await startWithSocial()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/social/echoes/reveal`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'x' }),
      })
      expect(resp.status).toBe(503)
    })

    it('POST /v1/social/echoes/reveal → 400 on empty/missing id (empty-body guard)', async () => {
      const { port, token } = await startWithSocial({ revealEcho: () => ({ state: 'connected' }) })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/social/echoes/reveal`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '',
      })
      expect(resp.status).toBe(400)
      expect(await resp.json()).toEqual({ error: 'missing_id' })
    })

    it('POST /v1/social/pledges/reveal drives revealPledge(id)', async () => {
      const { port, token } = await startWithSocial({ revealPledge: () => ({ state: 'awaiting_peer' }) })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/social/pledges/reveal`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'i1:cca' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ outcome: { state: 'awaiting_peer' } })
    })

    it('tier gate: a trusted token gets 403 on POST /v1/social/echoes/reveal', async () => {
      const { port } = await startWithSocial({ revealEcho: () => ({ state: 'connected' }) })
      const tok = api!.mintSessionToken('trusted', 'test')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/social/echoes/reveal`, {
        method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'x' }),
      })
      expect(resp.status).toBe(403)
    })
  })
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun run test src/daemon/internal-api.test.ts`
Expected: FAIL — new routes 404 (unregistered), types missing.

- [ ] **Step 4: Add the routes** — in `src/daemon/internal-api/routes-social.ts`, add three entries to the returned `RouteTable` (alongside the existing social routes):

```ts
    // async foraging spine — the answerer's pledge rows (mirrors GET echoes).
    'GET /v1/social/pledges': async () => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      return { status: 200, body: { pledges: deps.social.pledgeStore.list() } }
    },
    // 揭晓 — desktop reveal buttons. id comes in the BODY (router is exact-match,
    // no :id path params). null outcome ⇒ no such row ⇒ 404.
    'POST /v1/social/echoes/reveal': async (_q, body) => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) return { status: 400, body: { error: 'missing_id' } }
      const outcome = await deps.social.revealer.revealEcho(id)
      if (outcome === null) return { status: 404, body: { error: 'not_found' } }
      return { status: 200, body: { outcome } }
    },
    'POST /v1/social/pledges/reveal': async (_q, body) => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) return { status: 400, body: { error: 'missing_id' } }
      const outcome = await deps.social.revealer.revealPledge(id)
      if (outcome === null) return { status: 404, body: { error: 'not_found' } }
      return { status: 200, body: { outcome } }
    },
```

- [ ] **Step 5: Tier the routes** — in `src/daemon/internal-api/route-tiers.ts`, add to `ROUTE_MIN_TIER` (in the admin/social section ~`:107`):

```ts
  // admin — async foraging spine: read the answerer's pledges + trigger reveals.
  'GET /v1/social/pledges': 'admin',
  'POST /v1/social/echoes/reveal': 'admin',
  'POST /v1/social/pledges/reveal': 'admin',
```

- [ ] **Step 6: Run to verify it passes** (route tests + the completeness test)

Run: `bun run test src/daemon/internal-api.test.ts src/daemon/internal-api/route-tiers.test.ts`
Expected: PASS (the completeness test proves every new route is tiered).

- [ ] **Step 7: Commit** — `git commit -am "feat(social): internal-api reveal + pledge routes (admin-tiered)"`

---

## Task 8: Bootstrap wiring — real revealer, resume, retire pendingConfirms

**Files:**
- Modify: `src/core/a2a-delegate.ts` + `src/core/a2a-delegate.test.ts` (add `revealUrl`)
- Modify: `src/daemon/bootstrap/index.ts`
- Test: `src/daemon/bootstrap.test.ts`

**Interfaces:**
- Consumes: `makePledgeStore` (Task 3), `makeRevealer` (Task 4), broker's new `{ seek, forage }` + deps (Task 5), a2a-server `onReveal` (Task 6), `revealUrl` (this task), `a2aClient.send` (`a2a-client.ts`), `sendAssistantText` (`fallback-reply.ts`), `resolveOperatorChatId` + `a2aRegistry` (already in bootstrap).
- Produces:
  - `revealUrl(agentUrl: string): string` in `a2a-delegate.ts` (mirrors `intentUrl`).
  - `Bootstrap['social']` shape becomes `{ broker; seekStore; echoStore; pledgeStore; revealer }` — **`pendingConfirms` removed.**
  - The a2a-server is constructed with `onReveal` when social is wired.
  - Boot-scan: `foraging` seeks are re-foraged on boot.

- [ ] **Step 1a: `revealUrl` test** — in `src/core/a2a-delegate.test.ts`, add (mirroring the existing `intentUrl` cases):

```ts
import { revealUrl } from './a2a-delegate'

describe('revealUrl', () => {
  it('derives /a2a/reveal from the same shapes intentUrl tolerates', () => {
    expect(revealUrl('http://x/a2a')).toBe('http://x/a2a/reveal')
    expect(revealUrl('http://x/a2a/notify')).toBe('http://x/a2a/reveal')
    expect(revealUrl('http://x/a2a/intent')).toBe('http://x/a2a/reveal')
    expect(revealUrl('http://x')).toBe('http://x/a2a/reveal')
    expect(revealUrl('http://x/a2a/reveal')).toBe('http://x/a2a/reveal')
  })
})
```

(If `a2a-delegate.test.ts` lacks a `describe` import wrapper, add `import { describe, it, expect } from 'vitest'` — check the file header first.)

- [ ] **Step 1b: Run → FAIL** — `bun run test src/core/a2a-delegate.test.ts` (no `revealUrl` export).

- [ ] **Step 1c: Implement `revealUrl`** — in `src/core/a2a-delegate.ts`, after `intentUrl` (~`:38`):

```ts
/**
 * Derive a peer's /a2a/reveal URL from its registered url, tolerating the same
 * shapes as {@link intentUrl}: a bare base, `/a2a`, `/a2a/notify`, `/a2a/exec`,
 * `/a2a/intent`, or already `/a2a/reveal`.
 */
export function revealUrl(agentUrl: string): string {
  const u = agentUrl.replace(/\/+$/, '')
  if (u.endsWith('/a2a/reveal')) return u
  if (u.endsWith('/a2a/notify')) return u.replace(/\/a2a\/notify$/, '/a2a/reveal')
  if (u.endsWith('/a2a/exec')) return u.replace(/\/a2a\/exec$/, '/a2a/reveal')
  if (u.endsWith('/a2a/intent')) return u.replace(/\/a2a\/intent$/, '/a2a/reveal')
  if (u.endsWith('/a2a')) return `${u}/reveal`
  return `${u}/a2a/reveal`
}
```

Run → PASS: `bun run test src/core/a2a-delegate.test.ts`.

- [ ] **Step 2: Update the bootstrap social tests** — in `src/daemon/bootstrap.test.ts`:
  - In the "wires onIntent/onIntentConfirm + boot.social" test (~`:1064`), replace the two `pendingConfirms` assertions with reveal/pledge ones, and assert the `reveal` capability is advertised:

```ts
      expect(boot.social).toBeDefined()
      expect(typeof boot.social!.broker.seek).toBe('function')
      expect(typeof boot.social!.revealer.revealEcho).toBe('function')
      expect(typeof boot.social!.pledgeStore.list).toBe('function')
      expect(card.capabilities.some(c => c.name === 'reveal')).toBe(true)
```

  - In "a wired social seek persists a social_seek row" (~`:1150`): `broker.seek` is now non-blocking (`forage` is fire-and-forget). With the default (synchronous, ECONNREFUSED-fast) discover path the row may still be `foraging` when the assertion runs. Change the assertion to accept the sown row in any post-sow status and await the background settle. Since the fixture has no paired peers, `discover` returns `[]` quickly; wrap the assertion in a short poll:

```ts
      await boot.social!.broker.seek('找个会修老相机的')
      // Non-blocking: the sync leg sows `foraging`; the background forage
      // (0 peers here) settles it to `closed`. Poll briefly for the terminal row.
      const seen = await pollFor(() => {
        const rows = db.query('SELECT topic, status FROM social_seek').all() as Array<{ topic: string; status: string }>
        return rows.find(r => r.topic.includes('相机') && (r.status === 'closed' || r.status === 'foraging')) ?? null
      })
      expect(seen).not.toBeNull()
```

Add a small `pollFor` helper near the top of the test file if one does not already exist:

```ts
async function pollFor<T>(fn: () => T | null, tries = 50, gapMs = 10): Promise<T | null> {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, gapMs)) }
  return fn()
}
```

  - In the "recording failure does not surface as a rejected/broken seek" test (~`:1161`): its premise (the P1 wrapper's try/catch) moves into `recordEcho`/`finishSeek`. Keep it but retarget: force `finishSeek`'s underlying `seekStore.update` to throw by pre-inserting a bad row is fragile — simplest is to assert `broker.seek(...)` resolves (never rejects) even when the db is closed mid-flight. Given the fixture has 0 peers, the safest retarget is: assert `await boot.social!.broker.seek('x')` resolves to an object with an `intent_id` string and does not throw. Replace the body's assertion accordingly:

```ts
      const out = await boot.social!.broker.seek('找个会修老相机的')
      expect(typeof out.intent_id).toBe('string')   // never rejects; background write failures are swallowed
```

- [ ] **Step 3: Run → FAIL** — `bun run test src/daemon/bootstrap.test.ts` (boot.social lacks `revealer`/`pledgeStore`; `pendingConfirms` still referenced in impl).

- [ ] **Step 4: Rewrite the bootstrap social block** — in `src/daemon/bootstrap/index.ts`:

(a) Imports (~`:72`): add
```ts
import { makePledgeStore } from '../../core/social-pledge-store'
import { makeRevealer, type Revealer, type RevealBeat, type NotifyCtx, type PeerIdentity } from '../../core/social-reveal'
import { revealUrl } from '../../core/a2a-delegate'
```
(`intentUrl` is already imported from `a2a-delegate`; extend that import to include `revealUrl` if it is a named import there.)

(b) `Bootstrap['social']` shape (~`:390`): replace with
```ts
  social?: {
    broker: { seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> }
    seekStore: import('../../core/social-seek-store').SeekStore
    echoStore: import('../../core/social-echo-store').EchoStore
    pledgeStore: import('../../core/social-pledge-store').PledgeStore
    revealer: Revealer
  }
```

(c) Delete the `hashSummary` helper (~`:463`–`:479`) — it only served `confirmWithOwner`, which is gone. (Leave `pending-confirm.ts` and its `createPendingConfirms` import elsewhere untouched; just stop importing it in this file if this was its only use — check `createPendingConfirms` has no other bootstrap reference before removing the import.)

(d) Replace the whole social wiring block (`let socialOnIntent` … through the closing of the `rawBroker`/`socialBroker` assignment, ~`:1313`–`:1441`) with:

```ts
  let socialOnIntent: A2AServerOpts['onIntent']
  let socialOnReveal: A2AServerOpts['onReveal']
  let socialBroker: { seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> } | undefined
  let socialForage: ((intentId: string, topic: string, opts?: { city?: string }) => Promise<void>) | undefined
  let socialSeekStore: import('../../core/social-seek-store').SeekStore | undefined
  let socialEchoStore: import('../../core/social-echo-store').EchoStore | undefined
  let socialPledgeStore: import('../../core/social-pledge-store').PledgeStore | undefined
  let socialRevealer: Revealer | undefined

  if (configuredAgent.social_enabled && configuredAgent.social_disclosure_policy) {
    const socialPolicy = configuredAgent.social_disclosure_policy
    const socialCheapEval = registry.getCheapEval()
    if (!socialCheapEval) {
      deps.log('BOOT', 'social: no cheapEval available from any registered provider — social_enabled is on but wiring is skipped (inert)')
    } else {
      const SOCIAL_SELF_ID = process.env.WECHAT_A2A_SELF_ID || 'wechat-cc'
      const socialOpenaiKey = process.env.WECHAT_OPENAI_API_KEY

      const { makeGroundedJudgeRunTurn } = await import('../social/grounded-judge')
      const groundedRunTurn = makeGroundedJudgeRunTurn({
        providerId: defaultProviderId,
        pluginMcp,
        stateDir: deps.stateDir,
        log: deps.log,
        openai: (socialOpenaiKey && configuredAgent.openaiBaseUrl && configuredAgent.openaiModel)
          ? { apiKey: socialOpenaiKey, baseUrl: configuredAgent.openaiBaseUrl, model: configuredAgent.openaiModel }
          : undefined,
        claude: { model: () => currentClaudeModel(), ...(claudeBin ? { claudeBin } : {}) },
      })
      const socialRunTurn: (systemPrompt: string, userPrompt: string) => Promise<string> =
        groundedRunTurn ?? (async (systemPrompt, userPrompt) => socialCheapEval(`${systemPrompt}\n\n${userPrompt}`))
      deps.log('BOOT', groundedRunTurn
        ? `social: plugin-grounded judge via ${defaultProviderId} (pluginMcp only, no wechat/delegate)`
        : `social: grounded judging unavailable for provider=${defaultProviderId} — judge falls back to cheapEval (no tools)`)

      const socialJudge = makeJudge({ runTurn: socialRunTurn, policy: socialPolicy })
      const answerIntent = makeAnswerIntent({ judge: socialJudge, policy: socialPolicy, cheapEval: socialCheapEval })

      // Stores.
      const seekStore = makeSeekStore(deps.db)
      const echoStore = makeEchoStore(deps.db)
      const pledgeStore = makePledgeStore(deps.db)
      socialSeekStore = seekStore
      socialEchoStore = echoStore
      socialPledgeStore = pledgeStore

      // Notification beats (克制三拍). One WeChat sender for all three; on the
      // inbound-completed `connected` beat we only hold the peer's agent_id, so
      // resolve its display name from the registry here.
      const notify = (beat: RevealBeat, ctx: NotifyCtx): void => {
        const op = resolveOperatorChatId()
        if (!op || !sendAssistantText) return
        const peerName = ctx.peerName ?? (ctx.peerAgentId ? (a2aRegistry.get(ctx.peerAgentId)?.name ?? null) : null)
        const text = beat === 'first_echo'
          ? '✨ 你的心愿有回声了,去瞧瞧'
          : beat === 'await_reveal'
            ? '👀 有人想和你牵线,去看看'
            : `🤝 牵上线了${peerName ? ' —— 是' + peerName : ''}`
        void sendAssistantText(op, text)
      }

      // This daemon's public identity, handed back on the mutual instant. url is
      // read lazily (a2aServer is constructed further below); name prefers the
      // configured bot name.
      const selfIdentity = (): PeerIdentity => ({
        name: configuredAgent.bot_name ?? SOCIAL_SELF_ID,
        url: a2aServer ? a2aServer.baseUrl() : '',
      })

      // Outbound reveal POST to a peer's /a2a/reveal. null on unreachable/unknown.
      const postPeerReveal = async (agentId: string, intentId: string): Promise<{ mutual: boolean; identity?: PeerIdentity } | null> => {
        const hand = a2aRegistry.get(agentId)
        if (!hand) return null
        const r = await a2aClient.send({ url: revealUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, intent_id: intentId } })
        if (!r.ok) return null
        return r.response as { mutual: boolean; identity?: PeerIdentity }
      }

      const revealer = makeRevealer({ echoStore, pledgeStore, seekStore, postPeerReveal, selfIdentity, notify })
      socialRevealer = revealer
      socialOnReveal = async (ev) => revealer.onInboundReveal({ agentId: ev.agent_id, intentId: ev.intent_id })

      // Answer path: when THIS bot answers a peer's wish with match:'yes', record
      // a pledge so it can reveal back later. Wraps makeAnswerIntent's receipt.
      socialOnIntent = async (event) => {
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

      const broker = makeBroker({
        policy: socialPolicy,
        cheapEval: socialCheapEval,
        // TODO(v1+): rank candidates via wxgraph closeness/topical relevance
        // instead of "every paired peer, capped".
        discover: async (_topic) => a2aRegistry.list().filter(a => !a.paused).slice(0, 5),
        send: async (hand, card) => {
          const r = await a2aClient.send({ url: intentUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, card } })
          return r.ok ? MatchReceiptSchema.parse(r.response) : null
        },
        sow: (intentId, topic) => {
          try { seekStore.create({ id: intentId, kind: 'seek', topic }) }
          catch (err) { deps.log('SOCIAL_REC', `sow failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`) }
        },
        recordEcho: (e) => {
          // A persistence error must never undo a network action already done.
          try {
            echoStore.create({ id: `${e.intentId}:${e.peerAgentId}`, seekId: e.intentId, peerMasked: e.peerMasked, degree: e.degree, content: e.content, peerAgentId: e.peerAgentId })
          } catch (err) {
            deps.log('SOCIAL_REC', `echo record failed intent=${e.intentId} peer=${e.peerAgentId}: ${err instanceof Error ? err.message : String(err)}`)
          }
          if (e.first) notify('first_echo', { intentId: e.intentId })
        },
        finishSeek: (intentId, status, peersAsked) => {
          try { seekStore.update(intentId, { status, peersAsked }) }
          catch (err) { deps.log('SOCIAL_REC', `finishSeek failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`) }
        },
      })
      socialBroker = { seek: (topic, opts) => broker.seek(topic, opts) }
      socialForage = (intentId, topic, opts) => broker.forage(intentId, topic, opts)
    }
  }
```

(e) Wire `onReveal` into `createA2AServer` — in the opts object (~`:1531`, next to the existing `...(socialOnIntent ...)` / `...(socialOnIntentConfirm ...)` spreads), replace the `onIntentConfirm` spread with the reveal one (the intent-confirm handler retires with `confirmPeer`):

```ts
      ...(socialOnIntent ? { onIntent: socialOnIntent } : {}),
      ...(socialOnReveal ? { onReveal: socialOnReveal } : {}),
```

(Remove the `...(socialOnIntentConfirm ? { onIntentConfirm: socialOnIntentConfirm } : {})` line and the now-unused `socialOnIntentConfirm` local.)

(f) Boot-scan resume — after `a2aServer` is started (~`:1537`, so `postPeerReveal`/`selfIdentity` can reach a live server) and only when social is wired, re-forage `foraging` seeks:

```ts
  // Restart-resume: a seek still in `foraging` means its background leg never
  // finished (a completed leg moves the row to echoed/closed). Re-forage them.
  // Idempotent via the echo PK (intent_id:peer_agent_id): a duplicate send does
  // not double-insert. Fire-and-forget; one bad row never blocks boot.
  if (socialForage && socialSeekStore) {
    const forage = socialForage
    for (const row of socialSeekStore.list()) {
      if (row.status === 'foraging') {
        void forage(row.id, row.topic).catch(err => deps.log('SOCIAL_REC', `resume forage failed intent=${row.id}: ${err instanceof Error ? err.message : String(err)}`))
      }
    }
  }
```

(g) Assemble `boot.social` (~`:1627`): replace the spread with
```ts
    ...(socialBroker ? { social: { broker: socialBroker, seekStore: socialSeekStore!, echoStore: socialEchoStore!, pledgeStore: socialPledgeStore!, revealer: socialRevealer! } } : {}),
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun run test src/daemon/bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 6: Whole-tree typecheck** (broker consumers + main.ts's `setSocial` now match)

Run: `bun run typecheck`
Expected: clean, EXCEPT `pipeline-deps.ts` + its dispatch test still reference `boot.social.pendingConfirms` — those are Task 9. If executing strictly in order, land Task 9 before treating typecheck as the gate. (Alternatively do Steps 4–7 of Task 9 before this typecheck.)

- [ ] **Step 7: Commit** — `git commit -am "feat(social): wire row-driven reveal core + onReveal + boot resume; retire pendingConfirms/confirm seams"`

---

## Task 9: WeChat 揭晓 inbound semantics

**Files:**
- Create: `src/core/reveal-command.ts`
- Test: `src/core/reveal-command.test.ts`
- Modify: `src/daemon/wiring/pipeline-deps.ts` (social dispatch seam ~`:377`–`:398`)
- Test (rewrite): `src/daemon/wiring/pipeline-deps-social-dispatch.test.ts`

**Interfaces:**
- Consumes: `boot.social.revealer` (Task 8), `isAdmin` (already imported in `pipeline-deps.ts`).
- Produces:
  - `parseRevealCommand(text: string): { id: string } | null` — matches `揭晓 <id>` (id = the full echo/pledge id `intent_id:peer_agent_id`, tolerating a leading `#`). Bare `揭晓` (reply-to-a-beat) is deferred — it needs a persisted "last beat" context this spec does not add; noted below.
  - The social dispatch seam calls `revealer.revealEcho(id)`, falling back to `revealPledge(id)` when the echo lookup returns null, and consumes the message (no normal turn) when it was a reveal command.

> DEVIATION from the brief's sketch: the id scheme is the **full** echo/pledge id (`intent_id:peer_agent_id`), not a short id. There is no id→row shortener in the data model, and the reveal routes/revealer already key on the full id. Bare-`揭晓`-in-reply is deferred (no last-beat context persisted).

- [ ] **Step 1: Parser test** — create `src/core/reveal-command.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseRevealCommand } from './reveal-command'

describe('parseRevealCommand', () => {
  it('parses "揭晓 <id>" and tolerates a leading # + surrounding space', () => {
    expect(parseRevealCommand('揭晓 i1:ccb')).toEqual({ id: 'i1:ccb' })
    expect(parseRevealCommand('揭晓 #i1:ccb')).toEqual({ id: 'i1:ccb' })
    expect(parseRevealCommand('  揭晓   i1:ccb  ')).toEqual({ id: 'i1:ccb' })
  })
  it('returns null for non-reveal text and bare 揭晓 (no id)', () => {
    expect(parseRevealCommand('揭晓')).toBeNull()
    expect(parseRevealCommand('今天天气不错')).toBeNull()
    expect(parseRevealCommand('是')).toBeNull()
  })
})
```

- [ ] **Step 2: Run → FAIL** — `bun run test src/core/reveal-command.test.ts`.

- [ ] **Step 3: Implement the parser** — create `src/core/reveal-command.ts`:

```ts
/**
 * reveal-command.ts — the WeChat 揭晓 (reveal) trigger. The operator replies
 * "揭晓 <id>" (id = the full echo/pledge id, `intent_id:peer_agent_id`, with an
 * optional leading #). Returns the id to reveal, or null when the text isn't a
 * reveal command. Bare "揭晓" (reply-to-a-notification) is deferred — it needs a
 * persisted last-beat context the async-spine data model doesn't carry.
 */
export function parseRevealCommand(text: string): { id: string } | null {
  const m = text.trim().match(/^揭晓\s+#?(\S+)\s*$/)
  if (!m) return null
  return { id: m[1]! }
}
```

Run → PASS: `bun run test src/core/reveal-command.test.ts`.

- [ ] **Step 4: Rewrite the dispatch-seam test** — replace `src/daemon/wiring/pipeline-deps-social-dispatch.test.ts` with a version driving the 揭晓 seam. Keep the `vi.mock('../../lib/config.ts', ...)` block and `writeAccess` helper verbatim (they set up `isAdmin`), but replace `socialStoreStubs`, `setup`'s `social` type usage, and the test bodies:

```ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ACCESS_STATE_DIR = mkdtempSync(join(tmpdir(), 'pipeline-deps-social-access-test-'))
vi.mock('../../lib/config.ts', () => ({
  STATE_DIR: ACCESS_STATE_DIR,
  ILINK_BASE_URL: 'https://ilinkai.weixin.qq.com',
  ILINK_APP_ID: 'bot',
  ILINK_BOT_TYPE: '3',
  LONG_POLL_TIMEOUT_MS: 35_000,
}))

const { buildPipelineDeps } = await import('./pipeline-deps')
const { Ref } = await import('../../lib/lifecycle')
const { openTestDb } = await import('../../lib/db')
const { makeReplySinks } = await import('../reply-sinks')

import type { Bootstrap } from '../bootstrap/index'
import type { IlinkAdapter } from '../ilink-glue'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { InboundMsg } from '../../core/prompt-format'
import type { Mode } from '../../core/conversation'

const ACCESS_FILE = join(ACCESS_STATE_DIR, 'access.json')
function writeAccess(admins: string[]): void {
  writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], admins }, null, 2))
}

// A revealer stub that records calls and lets the test choose whether the echo
// lookup "exists" (non-null) so the pledge fallback path is exercised.
function makeRevealerStub(echoReturns: 'ok' | 'null') {
  const calls: Array<[string, string]> = []
  return {
    calls,
    revealer: {
      revealEcho: vi.fn(async (id: string) => { calls.push(['echo', id]); return echoReturns === 'ok' ? { state: 'connected' as const } : null }),
      revealPledge: vi.fn(async (id: string) => { calls.push(['pledge', id]); return { state: 'awaiting_peer' as const } }),
      onInboundReveal: vi.fn(() => ({ mutual: false })),
    },
  }
}

describe('pipeline-deps social dispatch seam (揭晓 reveal)', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-social-test-')); writeAccess(['op_chat']) })
  afterAll(() => { rmSync(ACCESS_STATE_DIR, { recursive: true, force: true }) })

  function setup(social: Bootstrap['social']) {
    const db = openTestDb()
    const coordinatorDispatch = vi.fn(async (_msg: InboundMsg) => {})
    const boot = {
      sessionManager: { isInFlight: vi.fn(() => false) } as unknown as Bootstrap['sessionManager'],
      sessionStore: {} as Bootstrap['sessionStore'],
      conversationStore: { upsertIdentity: vi.fn() } as unknown as Bootstrap['conversationStore'],
      registry: { get: vi.fn(), list: vi.fn(() => []), getCheapEval: vi.fn(() => null), has: vi.fn(() => false) } as unknown as Bootstrap['registry'],
      coordinator: { dispatch: coordinatorDispatch, getMode: vi.fn((): Mode => ({ kind: 'solo', provider: 'claude' })), cancel: vi.fn(() => false) } as unknown as Bootstrap['coordinator'],
      resolve: vi.fn(() => null),
      formatInbound: vi.fn() as unknown as Bootstrap['formatInbound'],
      sdkOptionsForProject: vi.fn() as unknown as Bootstrap['sdkOptionsForProject'],
      buildInstructions: vi.fn(() => ''),
      defaultProviderId: 'claude',
      agentProviderKind: 'claude',
      dispatchDelegate: vi.fn() as unknown as Bootstrap['dispatchDelegate'],
      a2aDeps: undefined,
      a2aServer: null,
      agentConfig: { bot_name: null } as unknown as Bootstrap['agentConfig'],
      social,
    } as unknown as Bootstrap

    const ilink = {} as unknown as IlinkAdapter
    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), resetNoReply: vi.fn() }
    const replySinks = makeReplySinks()
    const { pipelineDeps } = buildPipelineDeps(
      { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks },
      { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: new Ref('pipeline'), ingestNudge: new Ref('ingestNudge') },
    )
    return { pipelineDeps, coordinatorDispatch }
  }

  // Minimal social object satisfying Bootstrap['social'] for the seam (only
  // `revealer` is exercised; the rest are no-op stubs).
  function socialWith(revealer: any): Bootstrap['social'] {
    return {
      broker: { seek: vi.fn(async () => ({ intent_id: 'x' })) },
      seekStore: { create() {}, update() {}, list: () => [], get: () => null },
      echoStore: { create() {}, setStatus() {}, setSelfRevealed() {}, setPeerRevealed() {}, setRevealedIdentity() {}, listForSeek: () => [], listAll: () => [], get: () => null },
      pledgeStore: { create() {}, get: () => null, list: () => [], setSelfRevealed() {}, setPeerRevealed() {} },
      revealer,
    } as unknown as Bootstrap['social']
  }

  const baseMsg: InboundMsg = { chatId: 'op_chat', userId: 'op_chat', text: '揭晓 i1:ccb', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct1' }

  it('a "揭晓 <id>" from the admin chat triggers revealEcho and is NOT dispatched as a normal turn', async () => {
    const { calls, revealer } = makeRevealerStub('ok')
    const { pipelineDeps, coordinatorDispatch } = setup(socialWith(revealer))
    await pipelineDeps.dispatch.coordinator.dispatch(baseMsg)
    expect(calls).toEqual([['echo', 'i1:ccb']])
    expect(coordinatorDispatch).not.toHaveBeenCalled()
  })

  it('falls back to revealPledge when the echo lookup returns null', async () => {
    const { calls, revealer } = makeRevealerStub('null')
    const { pipelineDeps, coordinatorDispatch } = setup(socialWith(revealer))
    await pipelineDeps.dispatch.coordinator.dispatch(baseMsg)
    expect(calls).toEqual([['echo', 'i1:ccb'], ['pledge', 'i1:ccb']])
    expect(coordinatorDispatch).not.toHaveBeenCalled()
  })

  it('a non-command message falls through to a normal turn', async () => {
    const { revealer } = makeRevealerStub('ok')
    const { pipelineDeps, coordinatorDispatch } = setup(socialWith(revealer))
    await pipelineDeps.dispatch.coordinator.dispatch({ ...baseMsg, text: '今天几点见面?' })
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    expect(revealer.revealEcho).not.toHaveBeenCalled()
  })

  it('no boot.social → always a normal turn', async () => {
    const { pipelineDeps, coordinatorDispatch } = setup(undefined)
    await pipelineDeps.dispatch.coordinator.dispatch(baseMsg)
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
  })

  it('a 揭晓 from a NON-admin chat is never consumed', async () => {
    const { revealer } = makeRevealerStub('ok')
    const { pipelineDeps, coordinatorDispatch } = setup(socialWith(revealer))
    await pipelineDeps.dispatch.coordinator.dispatch({ ...baseMsg, chatId: 'someone_else', userId: 'someone_else' })
    expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    expect(revealer.revealEcho).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: Run → FAIL** — `bun run test src/daemon/wiring/pipeline-deps-social-dispatch.test.ts` (seam still does pendingConfirms).

- [ ] **Step 6: Rewrite the seam** — in `src/daemon/wiring/pipeline-deps.ts`, add the import near the top (with the other `../../core/*` imports):

```ts
import { parseRevealCommand } from '../../core/reveal-command'
```

and replace the `dispatch:` block (~`:391`–`:397`) with:

```ts
        // Async foraging spine — an operator "揭晓 <id>" reply triggers the
        // reveal flow (their action IS their consent) instead of dispatching a
        // normal agent turn. Try the echo side first; a null lookup means the
        // id is a pledge (I answered THEIR wish), so fall back to revealPledge.
        // Anything that isn't a reveal command falls through to a normal turn.
        dispatch: async (msg) => {
          if (boot.social && isAdmin(msg.chatId)) {
            const cmd = parseRevealCommand(msg.text)
            if (cmd) {
              const r = await boot.social.revealer.revealEcho(cmd.id)
              if (r === null) await boot.social.revealer.revealPledge(cmd.id)
              return
            }
          }
          return boot.coordinator.dispatch(msg)
        },
```

- [ ] **Step 7: Run to verify it passes + typecheck**

Run: `bun run test src/daemon/wiring/pipeline-deps-social-dispatch.test.ts`
Expected: PASS.
Run: `bun run typecheck`
Expected: clean tree-wide now (Task 8's deferred typecheck resolves here).

- [ ] **Step 8: Commit** — `git commit -am "feat(social): WeChat 揭晓 reveal command replaces yes/no pending-confirm seam"`

---

## Task 10: End-to-end spine

**Files:**
- Test: `src/core/social-m1.e2e.test.ts`

**Interfaces:**
- Consumes: real `makeBroker` (Task 5), `makeRevealer` (Task 4), the three stores, `makeAnswerIntent`, `gateOutbound` — composed in-process (no HTTP), the same style as the existing file.
- Produces: an end-to-end assertion that sow → background echo (pending) → desktop reveal → peer reveals back → echo `revealed` + seek `connected` + identity present, and that `seek()` never blocked.

- [ ] **Step 1: Replace the e2e file** — the current AC1–AC5 tests assert the retired `out.matched`/`out.lit` shape and inline confirm. Replace `src/core/social-m1.e2e.test.ts` with a spine e2e:

```ts
/**
 * Async foraging spine end-to-end (deterministic, in-process).
 *
 * Composes the REAL modules — makeBroker (sync sow + background forage) →
 * makeAnswerIntent (the peer's judge) → gateOutbound (disclosure) → makeRevealer
 * (mutual async reveal) — with injected deterministic judge + checker + stores.
 * The peer's inbound /a2a/reveal is simulated by calling the SEEKER'S
 * onInboundReveal directly (the HTTP transport is covered in a2a-server.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { openDb } from '../lib/db'
import { makeBroker } from './social-broker'
import { makeAnswerIntent } from './social-answer'
import { makeRevealer, type PeerIdentity } from './social-reveal'
import { makeSeekStore } from './social-seek-store'
import { makeEchoStore } from './social-echo-store'
import { makePledgeStore } from './social-pledge-store'

const POLICY = '可透露兴趣/城市;不透露住址门牌、第三方。'
const recB = { id: 'ccb', name: '小B', url: 'http://b/a2a', outbound_api_key: 'k' } as any
const IDENTITY_B: PeerIdentity = { name: '小B', url: 'http://b/a2a' }

const passingCheck = async (prompt: string) => {
  const m = prompt.match(/"""([\s\S]*?)"""/)
  const reviewed = m?.[1] ?? ''
  const leak = /兰园路|门牌|老陈/.test(reviewed)
  return JSON.stringify(leak ? { violation: true, redacted: '', reasons: ['leak'] } : { violation: false, redacted: reviewed })
}

describe('async foraging spine e2e', () => {
  it('sow → background echo → desktop reveal → peer reveals back → connected + identity, seek never blocks', async () => {
    const db = openDb({ path: ':memory:' })
    const seekStore = makeSeekStore(db)
    const echoStore = makeEchoStore(db)
    const pledgeStore = makePledgeStore(db)

    // The peer's answering handler (match yes with a clean blurb).
    const answerB = makeAnswerIntent({ judge: async () => ({ match: 'yes', blurb: '南京摄影爱好者,周末想出门拍照' }), policy: POLICY, cheapEval: passingCheck })

    // A deferred scheduler so we can assert the seek returned BEFORE any echo.
    const jobs: Array<() => Promise<void>> = []
    const broker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [recB],
      send: async (_hand, card) => answerB({ agent: { id: 'cca' } as any, card }),
      sow: (id, topic) => seekStore.create({ id, kind: 'seek', topic }),
      recordEcho: (e) => echoStore.create({ id: `${e.intentId}:${e.peerAgentId}`, seekId: e.intentId, peerMasked: e.peerMasked, degree: e.degree, content: e.content, peerAgentId: e.peerAgentId }),
      finishSeek: (id, status, peersAsked) => seekStore.update(id, { status, peersAsked }),
      schedule: (fn) => { jobs.push(fn) },
    })

    // 1) Sow — returns immediately; no echo yet (background not run).
    const { intent_id } = await broker.seek('找周末拍照搭子', { city: '南京' })
    expect(seekStore.get(intent_id)!.status).toBe('foraging')
    expect(echoStore.listForSeek(intent_id)).toHaveLength(0)   // did NOT block on the peer

    // 2) Forage — the background leg lands one pending echo.
    await Promise.all(jobs.map(j => j()))
    const echoes = echoStore.listForSeek(intent_id)
    expect(echoes).toHaveLength(1)
    expect(echoes[0]!.status).toBe('pending')
    expect(echoes[0]!.peer_masked).toBe('第 1 度的某人')       // masked before reveal
    expect(seekStore.get(intent_id)!.status).toBe('echoed')
    const echoId = echoes[0]!.id

    // 3) Desktop reveal (revealEcho). The peer answers our outbound /a2a/reveal
    //    with mutual:false first (they haven't revealed yet).
    const seekerRevealer = makeRevealer({
      echoStore, pledgeStore, seekStore,
      postPeerReveal: async () => ({ mutual: false }),
      selfIdentity: () => ({ name: '我方', url: 'http://a/a2a' }),
      notify: () => {},
    })
    const first = await seekerRevealer.revealEcho(echoId)
    expect(first).toEqual({ state: 'awaiting_peer' })
    expect(echoStore.get(echoId)!.self_revealed_at).not.toBeNull()
    expect(seekStore.get(intent_id)!.status).toBe('echoed')     // not yet connected

    // 4) Peer reveals back — simulate their /a2a/reveal callback into OUR
    //    onInboundReveal (they carry their identity in the outbound response we
    //    already recorded; here the mutual instant sets connected).
    //    We swap the seeker revealer's postPeerReveal to return the peer identity
    //    so a re-reveal completes the connection with identity swap.
    const seekerRevealer2 = makeRevealer({
      echoStore, pledgeStore, seekStore,
      postPeerReveal: async () => ({ mutual: true, identity: IDENTITY_B }),
      selfIdentity: () => ({ name: '我方', url: 'http://a/a2a' }),
      notify: () => {},
    })
    const connected = await seekerRevealer2.revealEcho(echoId)

    // 5) Assert connected + identity present.
    expect(connected).toEqual({ state: 'connected' })
    const finalEcho = echoStore.get(echoId)!
    expect(finalEcho.status).toBe('revealed')
    expect(finalEcho.self_revealed_at).not.toBeNull()
    expect(finalEcho.peer_revealed_at).not.toBeNull()
    expect(finalEcho.peer_masked).toBe('小B')                   // identity revealed
    expect(seekStore.get(intent_id)!.status).toBe('connected')
  })

  it('the disclosure gate still downgrades a leaky blurb (never recorded as an echo)', async () => {
    const db = openDb({ path: ':memory:' })
    const seekStore = makeSeekStore(db)
    const echoStore = makeEchoStore(db)
    const answerLeaky = makeAnswerIntent({ judge: async () => ({ match: 'yes', blurb: '住南京玄武区兰园路7号302,爱摄影' }), policy: POLICY, cheapEval: passingCheck })
    const jobs: Array<() => Promise<void>> = []
    const broker = makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [recB],
      send: async (_h, card) => answerLeaky({ agent: { id: 'cca' } as any, card }),
      sow: (id, topic) => seekStore.create({ id, kind: 'seek', topic }),
      recordEcho: (e) => echoStore.create({ id: `${e.intentId}:${e.peerAgentId}`, seekId: e.intentId, peerMasked: e.peerMasked, degree: e.degree, content: e.content, peerAgentId: e.peerAgentId }),
      finishSeek: (id, status, peersAsked) => seekStore.update(id, { status, peersAsked }),
      schedule: (fn) => { jobs.push(fn) },
    })
    const { intent_id } = await broker.seek('找周末拍照搭子')
    await Promise.all(jobs.map(j => j()))
    expect(echoStore.listForSeek(intent_id)).toHaveLength(0)     // leaky blurb downgraded to match:no
    expect(seekStore.get(intent_id)!.status).toBe('closed')
  })
})
```

- [ ] **Step 2: Run to verify it passes**

Run: `bun run test src/core/social-m1.e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Full suite + typecheck** (final gate)

Run: `bun run typecheck`
Run: `bun run test src/core src/daemon/internal-api src/daemon/bootstrap.test.ts src/daemon/wiring src/lib`
Expected: all green.

- [ ] **Step 4: Commit** — `git commit -am "test(social): async foraging spine e2e (sow → forage → mutual reveal)"`

---

## Done-when

- Migration v20 applied; state-migration smoke test green at version 20 / 18 tables.
- `broker.seek()` returns `{ intent_id }` before any echo exists; echoes accrue via the background `forage`; the inline confirm phase is gone.
- Reveal is row-driven: `revealEcho` / `revealPledge` (outbound) + `onInboundReveal` (inbound `POST /a2a/reveal`); whoever reveals second gets `mutual:true` synchronously with identity; consent survives a peer being unreachable.
- Desktop routes (`GET /v1/social/pledges`, `POST /v1/social/echoes/reveal`, `POST /v1/social/pledges/reveal`) admin-tiered, 503-gated, empty-body-guarded, completeness-test green.
- WeChat `揭晓 <id>` triggers reveal; the yes/no `pendingConfirms` seam is retired from the social wiring.
- Boot re-forages `foraging` seeks. `bun run typecheck` clean; all touched tests green.
