# 觅食台 P1 — Social State Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the social seek/echo state so the 觅食台 has real data to show — record what the bot sends out (seeks) and what comes back (echoes/matches), with reveal state.

**Architecture:** Two SQLite-backed stores (`makeSeekStore`, `makeEchoStore`) following the existing `makeHeartbeatStore` pattern, fed by one new appended migration. Wire the existing **synchronous** `broker.seek()` at the bootstrap social block: after a seek returns its `{intent_id, matched, lit}` outcome, record a seek row + one echo row per match, with reveal status derived from `lit`. Read/act side (internal-api) is P2; this plan is persistence + recording only.

**Tech Stack:** TypeScript, Bun (`bun:sqlite` via `src/lib/db.ts`), Vitest.

## Global Constraints

- Follow the existing store pattern verbatim: `makeXStore(db: Db)` returning methods that use `db.query<Row, Params>(sql)` with `.run()`/`.get()` — see `src/core/connection-heartbeat.ts`.
- Migrations: append a new `(db: Database) => void` entry to the END of `migrations[]` in `src/lib/db.ts`. **NEVER reorder or edit a published migration.** Version auto-advances by array index.
- Timestamps are ISO strings via `new Date().toISOString()` (product code — `Date.now()`/`new Date()` are fine here, unlike workflow scripts).
- **No behavior change** to the grounded judge, disclosure gate, dual-confirm, or `broker.seek()`'s return value — recording wraps it, never alters it.
- **OUT OF SCOPE (flagged, next step):** async/background foraging (the live "觅食中 · trickle-back" vibe). P1 records the *existing synchronous* seek's activity. The mockup's live-progress feel is the async-rework follow-up.
- Kind is `'seek'` for P1 (求物求人); the `'fun'` kind and richer creation come in the WeChat-flow plan (P4).

---

## File Structure

- **Modify** `src/lib/db.ts` — append one migration creating `social_seek` + `social_echo` tables.
- **Create** `src/core/social-seek-store.ts` — `makeSeekStore(db)` + `SeekRow` type.
- **Create** `src/core/social-echo-store.ts` — `makeEchoStore(db)` + `EchoRow` type.
- **Create** tests: `src/core/social-seek-store.test.ts`, `src/core/social-echo-store.test.ts`.
- **Modify** `src/daemon/bootstrap/index.ts` — in the social block (~1386, where `socialBroker` is assigned), construct the stores from `deps.db` and wrap `broker.seek()` to record. (Wire-level recording test extends `src/daemon/bootstrap.test.ts`.)

---

## Task 1: Migration — `social_seek` + `social_echo` tables

**Files:**
- Modify: `src/lib/db.ts` (append to `migrations[]`, after the last entry)

**Interfaces:**
- Produces: two tables. `social_seek(id PK, kind, topic, status, hop, peers_asked, created_at, updated_at)`, `social_echo(id PK, seek_id, peer_masked, degree, content, status, created_at)` + index on `social_echo(seek_id)`.

- [ ] **Step 1: Write the failing test**

Create `src/core/social-seek-store.test.ts` (the schema is exercised through the store; this first test just proves the tables exist after `openDb`):

```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'

describe('social state migration', () => {
  it('creates social_seek and social_echo tables', () => {
    const db = openDb(':memory:')
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('social_seek','social_echo')")
      .all()
      .map(r => r.name)
      .sort()
    expect(tables).toEqual(['social_echo', 'social_seek'])
  })
})
```

> Check `openDb`'s real signature first (`grep -n "export function openDb" src/lib/db.ts`) — if it takes a state-dir path rather than `:memory:`, use the same in-memory idiom the existing db tests use (`grep -rl "openDb(" src --include="*.test.ts"` and copy their setup).

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/core/social-seek-store.test.ts`
Expected: FAIL — `expect([]).toEqual(['social_echo','social_seek'])` (tables don't exist yet).

- [ ] **Step 3: Append the migration**

At the END of the `migrations: Migration[]` array in `src/lib/db.ts` (after the last published entry — do not renumber), add:

```ts
  // agent-social 觅食台 state (M2 P1): persisted seeks + echoes so the
  // desktop forager's-desk has queryable state. See
  // docs/superpowers/specs/2026-07-15-forage-desk-agent-page-design.md.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS social_seek (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,          -- 'seek' | 'fun'
        topic        TEXT NOT NULL,
        status       TEXT NOT NULL,          -- 'foraging' | 'echoed' | 'connected' | 'closed'
        hop          INTEGER NOT NULL DEFAULT 1,
        peers_asked  INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS social_echo (
        id           TEXT PRIMARY KEY,
        seek_id      TEXT NOT NULL,
        peer_masked  TEXT NOT NULL,          -- e.g. "第 1 度的某人"
        degree       INTEGER NOT NULL DEFAULT 1,
        content      TEXT NOT NULL,
        status       TEXT NOT NULL,          -- 'pending' | 'revealed' | 'declined'
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_social_echo_seek ON social_echo(seek_id);
    `)
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/core/social-seek-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts src/core/social-seek-store.test.ts
git commit -m "feat(social): migration for social_seek + social_echo state (觅食台 P1)"
```

---

## Task 2: `makeSeekStore`

**Files:**
- Create: `src/core/social-seek-store.ts`
- Test: `src/core/social-seek-store.test.ts` (extend Task 1's file)

**Interfaces:**
- Consumes: `Db` (`src/lib/db.ts`), the `social_seek` table (Task 1).
- Produces:
  ```ts
  export interface SeekRow {
    id: string; kind: 'seek' | 'fun'; topic: string
    status: 'foraging' | 'echoed' | 'connected' | 'closed'
    hop: number; peers_asked: number; created_at: string; updated_at: string
  }
  export interface SeekStore {
    create(s: { id: string; kind: 'seek' | 'fun'; topic: string }): void
    update(id: string, patch: { status?: SeekRow['status']; peersAsked?: number }): void
    list(): SeekRow[]                 // newest first
    get(id: string): SeekRow | null
  }
  export function makeSeekStore(db: Db): SeekStore
  ```

- [ ] **Step 1: Write the failing test** — append to `src/core/social-seek-store.test.ts`:

```ts
import { makeSeekStore } from './social-seek-store'

describe('makeSeekStore', () => {
  it('creates, lists newest-first, and updates status + peers', () => {
    const db = openDb(':memory:')
    const s = makeSeekStore(db)
    s.create({ id: 'k1', kind: 'seek', topic: '找个会修老相机的' })
    s.create({ id: 'k2', kind: 'fun', topic: '谁也在追这剧' })
    expect(s.list().map(r => r.id)).toEqual(['k2', 'k1'])   // newest first
    expect(s.get('k1')!.status).toBe('foraging')
    s.update('k1', { status: 'echoed', peersAsked: 5 })
    const r = s.get('k1')!
    expect(r.status).toBe('echoed'); expect(r.peers_asked).toBe(5)
    expect(r.updated_at >= r.created_at).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/core/social-seek-store.test.ts`
Expected: FAIL — `Cannot find module './social-seek-store'`.

- [ ] **Step 3: Implement** — create `src/core/social-seek-store.ts`:

```ts
/**
 * social-seek-store.ts — persisted "wishes" the owner's bot has sown into the
 * peer network (觅食台 P1). Mirrors the makeHeartbeatStore pattern.
 */
import type { Db } from '../lib/db'

export interface SeekRow {
  id: string; kind: 'seek' | 'fun'; topic: string
  status: 'foraging' | 'echoed' | 'connected' | 'closed'
  hop: number; peers_asked: number; created_at: string; updated_at: string
}
export interface SeekStore {
  create(s: { id: string; kind: 'seek' | 'fun'; topic: string }): void
  update(id: string, patch: { status?: SeekRow['status']; peersAsked?: number }): void
  list(): SeekRow[]
  get(id: string): SeekRow | null
}

export function makeSeekStore(db: Db): SeekStore {
  const ins = db.query<unknown, [string, string, string, string]>(
    `INSERT INTO social_seek(id, kind, topic, status, hop, peers_asked, created_at, updated_at)
     VALUES (?, ?, ?, 'foraging', 1, 0, ?, ?)`,
  )
  const selOne = db.query<SeekRow, [string]>('SELECT * FROM social_seek WHERE id = ?')
  const selAll = db.query<SeekRow, []>('SELECT * FROM social_seek ORDER BY created_at DESC')
  const updStatus = db.query<unknown, [string, string, string]>(
    'UPDATE social_seek SET status = ?, updated_at = ? WHERE id = ?',
  )
  const updPeers = db.query<unknown, [number, string, string]>(
    'UPDATE social_seek SET peers_asked = ?, updated_at = ? WHERE id = ?',
  )
  return {
    create(s) {
      const now = new Date().toISOString()
      ins.run(s.id, s.kind, s.topic, now, now)
    },
    update(id, patch) {
      const now = new Date().toISOString()
      if (patch.status !== undefined) updStatus.run(patch.status, now, id)
      if (patch.peersAsked !== undefined) updPeers.run(patch.peersAsked, now, id)
    },
    list() { return selAll.all() },
    get(id) { return selOne.get(id) ?? null },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/core/social-seek-store.test.ts`
Expected: PASS (3 tests: migration + create/list/update).

- [ ] **Step 5: Commit**

```bash
git add src/core/social-seek-store.ts src/core/social-seek-store.test.ts
git commit -m "feat(social): makeSeekStore — persisted wishes (觅食台 P1)"
```

---

## Task 3: `makeEchoStore`

**Files:**
- Create: `src/core/social-echo-store.ts`
- Test: `src/core/social-echo-store.test.ts`

**Interfaces:**
- Consumes: `Db`, the `social_echo` table (Task 1).
- Produces:
  ```ts
  export interface EchoRow {
    id: string; seek_id: string; peer_masked: string; degree: number
    content: string; status: 'pending' | 'revealed' | 'declined'; created_at: string
  }
  export interface EchoStore {
    create(e: { id: string; seekId: string; peerMasked: string; degree: number; content: string }): void
    setStatus(id: string, status: EchoRow['status']): void
    listForSeek(seekId: string): EchoRow[]
    listAll(): EchoRow[]              // newest first
    get(id: string): EchoRow | null
  }
  export function makeEchoStore(db: Db): EchoStore
  ```

- [ ] **Step 1: Write the failing test** — create `src/core/social-echo-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeEchoStore } from './social-echo-store'

describe('makeEchoStore', () => {
  it('creates pending echoes, lists by seek + all, and updates status', () => {
    const db = openDb(':memory:')
    const e = makeEchoStore(db)
    e.create({ id: 'e1', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: '我认识个老师傅' })
    e.create({ id: 'e2', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: '我家布偶生了一窝' })
    expect(e.get('e1')!.status).toBe('pending')
    expect(e.listForSeek('k1').map(r => r.id).sort()).toEqual(['e1', 'e2'])
    e.setStatus('e1', 'revealed')
    expect(e.get('e1')!.status).toBe('revealed')
    expect(e.listAll().length).toBe(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/core/social-echo-store.test.ts`
Expected: FAIL — `Cannot find module './social-echo-store'`.

- [ ] **Step 3: Implement** — create `src/core/social-echo-store.ts`:

```ts
/**
 * social-echo-store.ts — persisted "postcards" that came back for a seek
 * (觅食台 P1). Masked peer identity until dual-confirm reveal.
 */
import type { Db } from '../lib/db'

export interface EchoRow {
  id: string; seek_id: string; peer_masked: string; degree: number
  content: string; status: 'pending' | 'revealed' | 'declined'; created_at: string
}
export interface EchoStore {
  create(e: { id: string; seekId: string; peerMasked: string; degree: number; content: string }): void
  setStatus(id: string, status: EchoRow['status']): void
  listForSeek(seekId: string): EchoRow[]
  listAll(): EchoRow[]
  get(id: string): EchoRow | null
}

export function makeEchoStore(db: Db): EchoStore {
  const ins = db.query<unknown, [string, string, string, number, string, string]>(
    `INSERT INTO social_echo(id, seek_id, peer_masked, degree, content, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  )
  const selOne = db.query<EchoRow, [string]>('SELECT * FROM social_echo WHERE id = ?')
  const selBySeek = db.query<EchoRow, [string]>('SELECT * FROM social_echo WHERE seek_id = ? ORDER BY created_at DESC')
  const selAll = db.query<EchoRow, []>('SELECT * FROM social_echo ORDER BY created_at DESC')
  const updStatus = db.query<unknown, [string, string]>('UPDATE social_echo SET status = ? WHERE id = ?')
  return {
    create(e) { ins.run(e.id, e.seekId, e.peerMasked, e.degree, e.content, new Date().toISOString()) },
    setStatus(id, status) { updStatus.run(status, id) },
    listForSeek(seekId) { return selBySeek.all(seekId) },
    listAll() { return selAll.all() },
    get(id) { return selOne.get(id) ?? null },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/core/social-echo-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/social-echo-store.ts src/core/social-echo-store.test.ts
git commit -m "feat(social): makeEchoStore — persisted match postcards (觅食台 P1)"
```

---

## Task 4: Record around `broker.seek()` at the wiring

**Files:**
- Modify: `src/daemon/bootstrap/index.ts` (the social block where `socialBroker` is assigned, ~1386)
- Test: `src/daemon/bootstrap.test.ts` (extend — assert recording)

**Interfaces:**
- Consumes: `makeSeekStore` (Task 2), `makeEchoStore` (Task 3), `makeBroker`/`SeekOutcome` (`src/core/social-broker.ts`), `deps.db`.
- Produces: `socialBroker.seek()` behaves identically but now persists a `social_seek` row + one `social_echo` row per match. `seekStore`/`echoStore` become available in the social block for P2 to read.

- [ ] **Step 1: Write the failing test** — add to `src/daemon/bootstrap.test.ts` (mirror the existing social-enabled bootstrap fixtures — set `provider: 'claude'`, `social_enabled` + a disclosure policy, a bundled plugin; grep the file for the knowledge-orchestration / social fixtures to copy the setup). After building bootstrap, invoke a seek through the wired broker and assert a `social_seek` row exists:

```ts
it('a wired social seek persists a social_seek row', async () => {
  // …build bootstrap with social enabled (reuse the social fixture setup)…
  // Drive one seek; discover returns [] in the fixture, so the outcome is empty —
  // recording must STILL persist the seek row (foraging→closed).
  await boot.social!.broker.seek('找个会修老相机的')
  const rows = db.query("SELECT topic, status FROM social_seek").all() as Array<{topic:string;status:string}>
  expect(rows.some(r => r.topic.includes('相机') && r.status === 'closed')).toBe(true)
})
```

> Exact accessor for the wired broker + the test db handle: grep `bootstrap.test.ts` for how existing tests reach `broker.seek` / the db (e.g. the returned bootstrap object's shape). If the broker isn't exposed on the bootstrap return, expose `seekStore`/`echoStore`/`broker` on the social sub-object as part of this task and note it in Produces.

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/daemon/bootstrap.test.ts`
Expected: FAIL — no `social_seek` row (recording not wired yet).

- [ ] **Step 3: Implement the recording wrapper** — in `src/daemon/bootstrap/index.ts`, in the social block, replace the raw `socialBroker = makeBroker({...})` assignment with a recording wrapper. Add the imports at the top (`import { makeSeekStore } from '../../core/social-seek-store'` and `import { makeEchoStore } from '../../core/social-echo-store'`), then:

```ts
const seekStore = makeSeekStore(deps.db)
const echoStore = makeEchoStore(deps.db)
const rawBroker = makeBroker({ /* the existing deps, unchanged */ })
socialBroker = {
  async seek(topic, opts) {
    const outcome = await rawBroker.seek(topic, opts)
    // Record the wish + whatever came back. P1 records the synchronous
    // outcome; async/background foraging is a later rework.
    seekStore.create({ id: outcome.intent_id, kind: 'seek', topic })
    const status = outcome.lit.length ? 'connected' : outcome.matched.length ? 'echoed' : 'closed'
    seekStore.update(outcome.intent_id, { status, peersAsked: outcome.matched.length })
    for (const m of outcome.matched) {
      const echoId = `${outcome.intent_id}:${m.hand}`
      echoStore.create({ id: echoId, seekId: outcome.intent_id, peerMasked: '第 1 度的某人', degree: 1, content: m.blurb ?? '' })
      if (outcome.lit.includes(m.hand)) echoStore.setStatus(echoId, 'revealed')
    }
    return outcome
  },
}
```

Keep `makeBroker`'s deps exactly as they were — only the wrapper is new. If P2 needs the stores, expose them where the social sub-object is assembled (out of scope to consume here; just make them reachable).

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/daemon/bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Full green check + commit**

Run: `bun run typecheck` (0 errors), `bun run test` (full suite green), `bun run depcheck` (0 violations — the new `core/` stores import only `lib/db`, no boundary issue).

```bash
git add src/daemon/bootstrap/index.ts src/daemon/bootstrap.test.ts
git commit -m "feat(social): persist seeks + echoes around broker.seek (觅食台 P1)

Wrap the wired broker so each seek records a social_seek row + one
social_echo per match, reveal status from lit. broker.seek's return is
unchanged. Gives the 觅食台 real queryable state (P2 reads it). Async
background foraging is a separate follow-up."
```

---

## Follow-ons (out of scope; documented)

- **P2** — internal-api social read/act surface (`/v1/social/*` reads of seeks/echoes/network + a reveal action + inbound toggle), consuming these stores.
- **P3** — the desktop 觅食台 page (per the mockup), consuming P2. (The other session's desktop domain — coordinate.)
- **P4** — WeChat seek-creation-with-confirm flow (kind `'fun'`, anonymity level).
- **Async foraging rework** — make `broker.seek` async/persistent (record → background forage → trickle echoes over time → reveal later), delivering the mockup's live "觅食中" feel. Biggest single follow-up; its own design.

## Self-Review notes (author)

- **Spec coverage:** persistence layer the spec's "read active seeks + incoming echoes" assumed → Tasks 1–4. Reveal state (dual-confirm) → echo `status` + `lit`-derived recording. 1-hop-now/multi-hop-ready → `hop`/`degree` columns default 1, carried for later. Async foraging → explicitly deferred (Global Constraints + Follow-ons).
- **Placeholder scan:** stores + migration are complete code; Task 4's test setup points at the exact existing fixtures to copy (not a vague TODO) because the social-enabled bootstrap fixture already exists in `bootstrap.test.ts`.
- **Type consistency:** `SeekRow`/`EchoRow`/`makeSeekStore`/`makeEchoStore`/`SeekStore`/`EchoStore` names + signatures match across tasks; `outcome.{intent_id,matched,lit}` matches `SeekOutcome` in `social-broker.ts:15`.
