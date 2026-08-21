# Reminders Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the June `feat/reminders` tip commit `dcbaf94b` (multi-user precise-time reminders: db table + store + sweeper + 3 internal-api routes + 3 MCP tools) onto current dev with four adaptations: migration renumbered to v29, exponential retry backoff, session-caller own-chat scoping, SubsystemSupervisor wiring.

**Architecture:** Feature body is carried over from the June commit (extract via `git show dcbaf94b:<path>`), then edited. Store/sweeper live in `src/daemon/reminders/`; routes go in a new `routes-reminders.ts` following the current routes-* split; MCP tools follow the current inline `formatError` error posture (the June `passthroughErrorResult` helper no longer exists); wiring goes in main.ts step-4 block via `sup.start('reminders', ...)` like mailbox-poller.

**Tech Stack:** bun:sqlite via `src/lib/db.ts` Db wrapper, zod schemas, vitest (`bun --bun vitest run` — NEVER plain `bunx vitest`, it runs under Node and bun:sqlite fails).

**Spec:** `docs/superpowers/specs/2026-08-20-reminders-port-design.md`

## Global Constraints

- Test runner: `bun --bun vitest run <files>`; imports from `vitest`, never `bun:test`.
- Full-suite regression tolerates exactly the 2 known env failures in `src/daemon/bootstrap.test.ts` (dev-machine plugin-symlink state) — anything else is a real failure.
- Migration position contract (#79): `user_version` is a COUNT. The reminders migration MUST be appended as the 29th element (v29) at the END of the `migrations` array in `src/lib/db.ts`. Never insert mid-array.
- Session-origin callers (`caller.origin === 'session'`) are restricted to their own chat on ALL three reminder routes, regardless of tier. 403 body must NOT echo the requested chat_id: `{ error: 'reminder_scope_denied' }`.
- Retry backoff: after a failed delivery attempt, next attempt is eligible at `last_attempt_at + min(60min, 1min × 2^(attempts-1))`; total window `due_at + 24h` unchanged (then markFailed).
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `git add` explicit paths only.

---

### Task 1: Migration v29 + schema-pin test updates

**Files:**
- Modify: `src/lib/db.ts` (append migration at end of `migrations` array, after the v28 entry)
- Modify: `src/lib/state-migration.test.ts` (the "opens a fresh db with PRAGMA user_version = 28 and the 27 tables" test)
- Modify: `src/lib/migration-order.test.ts` (append one fingerprint line — file header explains: "append its fingerprint here, and change nothing above")

**Interfaces:**
- Produces: `reminders` table with columns `id, chat_id, due_at, text, created_at, status, attempts, last_error, last_attempt_at` (STRICT; status CHECK in `pending|sent|cancelled|failed`), indexes `reminders_status_due(status, due_at)` and `reminders_chat(chat_id, due_at)`. Tasks 2–4 depend on exactly these column names.

- [ ] **Step 1: Write the failing test** — in `src/lib/state-migration.test.ts`, update the fresh-db pin test: expected `user_version` 28→29, table count 27→28, and add `'reminders'` to whatever table-name list/assertion the test carries (read the test first; keep its existing assertion style).

- [ ] **Step 2: Run to verify it fails**

Run: `bun --bun vitest run src/lib/state-migration.test.ts`
Expected: FAIL — fresh db still reports user_version 28 / no `reminders` table.

- [ ] **Step 3: Append migration v29 to `src/lib/db.ts`** — at the END of the `migrations` array, directly after the v28 entry:

```ts
  // v29 — reminders (ported from the June feat/reminders branch, dcbaf94b;
  // spec docs/superpowers/specs/2026-08-20-reminders-port-design.md).
  // Per-chat, minute-precise, one-shot reminders delivered by the reminder
  // sweeper (src/daemon/reminders). Unlike the companion agenda (day-granular,
  // operator-only), due_at is a full ISO 8601 timestamp, any chat_id, and
  // pending rows survive restarts. attempts/last_error/last_attempt_at track
  // delivery retries — last_attempt_at drives the sweeper's exponential
  // backoff (June's every-60s retry violated the no-retry-storm rule).
  // The June branch numbered this v15; it lands here as v29 because
  // user_version is a COUNT (#79) — body is IF NOT EXISTS, replay-safe.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id              TEXT PRIMARY KEY NOT NULL,
        chat_id         TEXT NOT NULL,
        due_at          TEXT NOT NULL,            -- ISO 8601, full timestamp
        text            TEXT NOT NULL,
        created_at      TEXT NOT NULL,            -- ISO 8601
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','sent','cancelled','failed')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        last_attempt_at TEXT                      -- ISO 8601; drives retry backoff
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reminders_status_due ON reminders(status, due_at);
      CREATE INDEX IF NOT EXISTS reminders_chat ON reminders(chat_id, due_at);
    `)
  },
```

- [ ] **Step 4: Run state-migration test to verify it passes**

Run: `bun --bun vitest run src/lib/state-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Update migration-order fingerprint** — run `bun --bun vitest run src/lib/migration-order.test.ts`; it will fail printing the expected fingerprint for n=29. Append exactly one line for v29 to the pinned list (per the file's own instructions), changing nothing above. Note the file's `foreign_keys ON` gotcha comment if present — follow the file, don't fight it. Re-run: PASS.

- [ ] **Step 6: Full db-layer check + commit**

Run: `bun --bun vitest run src/lib/`
Expected: PASS (all).

```bash
git add src/lib/db.ts src/lib/state-migration.test.ts src/lib/migration-order.test.ts
git commit -m "feat(db): migration v29 — reminders table (June v15 renumbered per #79 position contract)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Reminders store (carry-over + last_attempt_at)

**Files:**
- Create: `src/daemon/reminders/store.ts` (from `git show dcbaf94b:src/daemon/reminders/store.ts`, then edit)
- Create: `src/daemon/reminders/store.test.ts` (from `git show dcbaf94b:src/daemon/reminders/store.test.ts`, then edit)

**Interfaces:**
- Consumes: `reminders` table from Task 1; `Db` from `src/lib/db`.
- Produces (Tasks 3–4 rely on these exact signatures):

```ts
export interface ReminderRecord {
  id: string; chat_id: string; due_at: string; text: string; created_at: string
  status: ReminderStatus; attempts: number; last_error: string | null
  last_attempt_at: string | null
}
export interface RemindersStore {
  schedule(rec: { chat_id: string; due_at: string; text: string }): Promise<string>
  cancel(id: string, chatId: string): Promise<boolean>
  list(chatId: string): Promise<ReminderRecord[]>
  listDue(nowIso: string): Promise<ReminderRecord[]>
  markSent(id: string): Promise<void>
  markFailed(id: string, error: string): Promise<void>
  recordAttempt(id: string, error: string, nowIso: string): Promise<void>
}
export function makeRemindersStore(db: Db): RemindersStore
```

- [ ] **Step 1: Extract June files**

```bash
mkdir -p src/daemon/reminders
git show dcbaf94b:src/daemon/reminders/store.ts > src/daemon/reminders/store.ts
git show dcbaf94b:src/daemon/reminders/store.test.ts > src/daemon/reminders/store.test.ts
```

- [ ] **Step 2: Write the failing tests first** — edit `store.test.ts`: fix the test-runner import if it isn't `vitest` (it must be), keep the 8 June cases, and ADD two:

```ts
it('recordAttempt stamps last_attempt_at with the injected nowIso', async () => {
  const id = await store.schedule({ chat_id: 'u1', due_at: '2026-08-20T10:00:00.000Z', text: 'hi' })
  await store.recordAttempt(id, 'boom', '2026-08-20T10:01:00.000Z')
  const rec = (await store.list('u1')).find(r => r.id === id)!
  expect(rec.attempts).toBe(1)
  expect(rec.last_error).toBe('boom')
  expect(rec.last_attempt_at).toBe('2026-08-20T10:01:00.000Z')
})

it('a fresh reminder has last_attempt_at null', async () => {
  const id = await store.schedule({ chat_id: 'u1', due_at: '2026-08-20T10:00:00.000Z', text: 'hi' })
  const rec = (await store.list('u1')).find(r => r.id === id)!
  expect(rec.last_attempt_at).toBeNull()
})
```

(Adapt `store` setup to however the June tests build it — they open an in-memory/temp Db and run migrations; keep that harness.)

- [ ] **Step 3: Run to verify the new tests fail**

Run: `bun --bun vitest run src/daemon/reminders/store.test.ts`
Expected: the two new tests FAIL (recordAttempt has 2-arg signature, no last_attempt_at column mapping); June's 8 may also fail on the missing column in `COLS` — fine.

- [ ] **Step 4: Edit store.ts** — five mechanical edits to the June file:
  1. Header comment: `migration v15` → `migration v29`; add one line: `last_attempt_at drives the sweeper's exponential backoff (spec 2026-08-20 §2.2).`
  2. `ReminderRecord` + `Row` + `rowToRecord`: add `last_attempt_at: string | null`.
  3. `COLS`: append `, last_attempt_at`.
  4. `recordAttempt(id, error, nowIso)`: statement becomes

```ts
const stmtRecordAttempt = db.query<unknown, [string, string, string]>(
  'UPDATE reminders SET attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE id = ?',
)
```
```ts
async recordAttempt(id, error, nowIso) {
  stmtRecordAttempt.run(error.slice(0, 500), nowIso, id)
},
```
  5. Leave `listDue` SQL as-is (`status='pending' AND due_at <= ?`) — backoff filtering is sweep policy and lives in the sweeper (June's own separation comment), not in SQL.

- [ ] **Step 5: Run to verify all pass**

Run: `bun --bun vitest run src/daemon/reminders/store.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/reminders/store.ts src/daemon/reminders/store.test.ts
git commit -m "feat(reminders): port store from June branch + last_attempt_at for retry backoff

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Sweeper (carry-over + exponential backoff)

**Files:**
- Create: `src/daemon/reminders/sweeper.ts` (from `git show dcbaf94b:src/daemon/reminders/sweeper.ts`, then edit)
- Create: `src/daemon/reminders/sweeper.test.ts` (from `git show dcbaf94b:src/daemon/reminders/sweeper.test.ts`, then edit)

**Interfaces:**
- Consumes: `RemindersStore` from Task 2 (note the 3-arg `recordAttempt`).
- Produces (Task 6 relies on):

```ts
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000
export function backoffMs(attempts: number): number   // min(60min, 1min * 2^(attempts-1)); attempts>=1
export interface SweepResult { delivered: number; retried: number; failed: number; deferred: number }
export function runReminderSweep(deps: SweepDeps): Promise<SweepResult>
export interface ReminderSchedulerDeps {
  store: RemindersStore
  send: (chatId: string, text: string) => Promise<{ ok: boolean; error?: string }>
  log: (tag: string, line: string) => void
  intervalMs?: number
}
export function registerReminders(deps: ReminderSchedulerDeps): Lifecycle
```

- [ ] **Step 1: Extract June files**

```bash
git show dcbaf94b:src/daemon/reminders/sweeper.ts > src/daemon/reminders/sweeper.ts
git show dcbaf94b:src/daemon/reminders/sweeper.test.ts > src/daemon/reminders/sweeper.test.ts
```

- [ ] **Step 2: Write the failing backoff tests** — edit `sweeper.test.ts`: fix imports to `vitest` if needed, keep June's 6 cases but update every `recordAttempt` fake/assertion to the 3-arg signature, then ADD:

```ts
it('backoffMs doubles from 1min and caps at 60min', () => {
  expect(backoffMs(1)).toBe(60_000)
  expect(backoffMs(2)).toBe(120_000)
  expect(backoffMs(3)).toBe(240_000)
  expect(backoffMs(7)).toBe(3_600_000)   // 64min uncapped → capped
  expect(backoffMs(20)).toBe(3_600_000)
})

it('skips a failed reminder still inside its backoff window (no send attempt)', async () => {
  // rec failed once at 10:00 (attempts=1, last_attempt_at=10:00); backoff 1min.
  // Sweep at 10:00:30 → send must NOT be called; counted as deferred.
  const rec = makeRec({ attempts: 1, last_attempt_at: '2026-08-20T10:00:00.000Z' })
  const send = vi.fn()
  const result = await runReminderSweep({ store: storeWith([rec]), send, nowIso: '2026-08-20T10:00:30.000Z', log: noop })
  expect(send).not.toHaveBeenCalled()
  expect(result.deferred).toBe(1)
})

it('retries a failed reminder once its backoff has elapsed', async () => {
  const rec = makeRec({ attempts: 1, last_attempt_at: '2026-08-20T10:00:00.000Z' })
  const send = vi.fn().mockResolvedValue({ ok: true })
  const result = await runReminderSweep({ store: storeWith([rec]), send, nowIso: '2026-08-20T10:01:01.000Z', log: noop })
  expect(send).toHaveBeenCalledTimes(1)
  expect(result.delivered).toBe(1)
})
```

(`makeRec`/`storeWith`/`noop` — adapt to whatever fixture helpers the June test file already defines; extend them rather than inventing a parallel harness.)

- [ ] **Step 3: Run to verify they fail**

Run: `bun --bun vitest run src/daemon/reminders/sweeper.test.ts`
Expected: FAIL — `backoffMs` not exported, no deferred counting.

- [ ] **Step 4: Edit sweeper.ts** — three edits:
  1. Add after `RETRY_WINDOW_MS`:

```ts
/**
 * Exponential retry backoff: 1min, 2min, 4min, … capped at 60min. June's
 * flat every-sweep retry meant a disconnected hour produced 60 send attempts
 * per reminder — the no-retry-storm rule requires exponential spacing
 * (WeChat risk control). `attempts` is the count of failures so far (>=1).
 */
export function backoffMs(attempts: number): number {
  return Math.min(3_600_000, 60_000 * 2 ** (attempts - 1))
}
```
  2. In `runReminderSweep`, add `deferred: 0` to the result init, and insert the backoff gate at the TOP of the per-reminder loop, before calling `send`:

```ts
    // Backoff gate: a previously-failed reminder is only eligible again once
    // its exponential backoff has elapsed. Fresh reminders (attempts=0 /
    // last_attempt_at null) pass straight through.
    if (rec.attempts > 0 && rec.last_attempt_at) {
      const eligibleAt = Date.parse(rec.last_attempt_at) + backoffMs(rec.attempts)
      if (Number.isFinite(eligibleAt) && nowMs < eligibleAt) {
        result.deferred++
        continue
      }
    }
```
  3. The failure branch's `recordAttempt(rec.id, err)` → `recordAttempt(rec.id, err, deps.nowIso)`.

  Leave `registerReminders` (timer lifecycle) untouched.

- [ ] **Step 5: Run to verify all pass**

Run: `bun --bun vitest run src/daemon/reminders/`
Expected: PASS (store + sweeper).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/reminders/sweeper.ts src/daemon/reminders/sweeper.test.ts
git commit -m "feat(reminders): port sweeper + exponential backoff (1min→60min cap) per no-retry-storm rule

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: internal-api — schemas, routes-reminders.ts with own-chat scoping, route-tiers

**Files:**
- Modify: `src/daemon/internal-api/schema.ts` (add reminder schemas + REQUEST_SCHEMAS/RESPONSE_SCHEMAS entries)
- Modify: `src/daemon/internal-api/schema.test.ts` (add reminder schema cases)
- Create: `src/daemon/internal-api/routes-reminders.ts`
- Create: `src/daemon/internal-api/routes-reminders.test.ts`
- Modify: `src/daemon/internal-api/routes.ts` (spread `...remindersRoutes(deps)` into the table at the end, next to `...healthRoutes(deps)`)
- Modify: `src/daemon/internal-api/route-tiers.ts` (three entries)
- Modify: `src/daemon/internal-api/route-tiers.test.ts` (assert the three entries)

**Interfaces:**
- Consumes: `makeRemindersStore` (Task 2); `InternalApiDeps` (`deps.db?: Db`), `RouteTable`, `RouteHandler` (3rd arg `caller?: { tier, origin: 'file'|'session'|'operator', chatId? }`), `errMsg` — all from `./types`.
- Produces: routes `POST /v1/reminders/schedule`, `POST /v1/reminders/cancel`, `GET /v1/reminders/list`. Response bodies exactly as the schemas below (Task 5's tools display them raw).

- [ ] **Step 1: Add schemas to `schema.ts`** — June's block verbatim (it is already zod-current), placed with the other request/response schema groups:

```ts
// ── reminders (per-chat precise-time; spec 2026-08-20-reminders-port) ────────
// Caller supplies EITHER an absolute due_at (ISO 8601) OR a relative
// delay_seconds (the daemon computes due_at = now + delay using its own clock,
// avoiding timezone ambiguity). Exactly one must be present. Session-origin
// callers are scoped to their own chat in routes-reminders.ts.

export const ReminderScheduleRequest = z.object({
  chat_id: z.string().min(1),
  text: z.string().min(1).max(4000),
  due_at: z.string().datetime({ offset: true }).optional(),
  delay_seconds: z.number().int().min(1).max(60 * 60 * 24 * 365).optional(),
}).refine(
  b => (b.due_at === undefined) !== (b.delay_seconds === undefined),
  { message: 'provide exactly one of due_at or delay_seconds' },
)
export const ReminderScheduleResponse = z.union([
  z.object({ ok: z.literal(true), reminder_id: z.string(), due_at: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

export const ReminderCancelRequest = z.object({
  chat_id: z.string().min(1),
  reminder_id: z.string().min(1),
})
export const ReminderCancelResponse = z.union([
  z.object({ ok: z.literal(true), cancelled: z.boolean() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

export const ReminderListQuery = z.object({ chat_id: z.string().min(1) })
export const ReminderListResponse = z.union([
  z.object({ ok: z.literal(true), reminders: z.array(z.object({
    id: z.string(), due_at: z.string(), text: z.string(), status: z.string(),
  })) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

export type ReminderScheduleRequestT = z.infer<typeof ReminderScheduleRequest>
export type ReminderCancelRequestT = z.infer<typeof ReminderCancelRequest>
```

And register: in `REQUEST_SCHEMAS` add `'POST /v1/reminders/schedule': ReminderScheduleRequest,` and `'POST /v1/reminders/cancel': ReminderCancelRequest,`; in `RESPONSE_SCHEMAS` add all three response schemas keyed by route. (Check how existing GET-with-query routes register query validation — if `REQUEST_SCHEMAS` only validates POST bodies, mirror whatever `GET /v1/memory/list` does with its query params and validate `chat_id` inside the handler instead; do not invent a new validation lane.)

- [ ] **Step 2: Add schema tests** — in `schema.test.ts`, following the file's existing `safeParse` style:

```ts
describe('ReminderScheduleRequest', () => {
  it('accepts delay_seconds alone', () => {
    expect(ReminderScheduleRequest.safeParse({ chat_id: 'u1', text: 'hi', delay_seconds: 60 }).success).toBe(true)
  })
  it('accepts due_at alone', () => {
    expect(ReminderScheduleRequest.safeParse({ chat_id: 'u1', text: 'hi', due_at: '2026-08-20T10:00:00Z' }).success).toBe(true)
  })
  it('rejects both or neither', () => {
    expect(ReminderScheduleRequest.safeParse({ chat_id: 'u1', text: 'hi' }).success).toBe(false)
    expect(ReminderScheduleRequest.safeParse({ chat_id: 'u1', text: 'hi', due_at: '2026-08-20T10:00:00Z', delay_seconds: 60 }).success).toBe(false)
  })
})
```

Run: `bun --bun vitest run src/daemon/internal-api/schema.test.ts` → PASS.

- [ ] **Step 3: Write failing route tests** — `routes-reminders.test.ts`. Build the route table directly (`remindersRoutes({ db } as InternalApiDeps)` with a migrated temp Db — copy the Db fixture posture from `routes-memory.test.ts` or the nearest routes-* test that uses `deps.db`). Cases:

```ts
const sessionCaller = { tier: 'guest' as const, origin: 'session' as const, chatId: 'u1' }
const fileCaller = { tier: 'admin' as const, origin: 'file' as const }

it('schedule: session caller for own chat succeeds', async () => {
  const r = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'u1', text: 'hi', delay_seconds: 60 }, sessionCaller)
  expect(r.status).toBe(200)
  expect((r.body as any).ok).toBe(true)
})
it('schedule: session caller for ANOTHER chat is 403 without echoing the target', async () => {
  const r = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'victim', text: 'hi', delay_seconds: 60 }, sessionCaller)
  expect(r.status).toBe(403)
  expect(JSON.stringify(r.body)).not.toContain('victim')
})
it('cancel: session caller cannot cancel another chat\'s reminder', async () => {
  const s = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'u2', text: 'hi', delay_seconds: 60 }, fileCaller)
  const reminderId = (s.body as any).reminder_id as string
  const r = await routes['POST /v1/reminders/cancel']!(new URLSearchParams(), { chat_id: 'u2', reminder_id: reminderId }, sessionCaller)
  expect(r.status).toBe(403)
  // and the reminder is still pending
  const l = await routes['GET /v1/reminders/list']!(new URLSearchParams({ chat_id: 'u2' }), undefined, fileCaller)
  expect((l.body as any).reminders[0].status).toBe('pending')
})
it('list: session caller cannot list another chat', async () => {
  const r = await routes['GET /v1/reminders/list']!(new URLSearchParams({ chat_id: 'u2' }), undefined, sessionCaller)
  expect(r.status).toBe(403)
})
it('file-origin caller may target any chat_id', async () => {
  const r = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'anyone', text: 'hi', delay_seconds: 60 }, fileCaller)
  expect((r.body as any).ok).toBe(true)
})
it('session caller with no chatId is denied (fail closed)', async () => {
  const r = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'u1', text: 'hi', delay_seconds: 60 }, { tier: 'guest', origin: 'session' })
  expect(r.status).toBe(403)
})
it('schedule with delay_seconds computes due_at ≈ now + delay', async () => {
  const before = Date.now()
  const r = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'u1', text: 'hi', delay_seconds: 60 }, sessionCaller)
  const due = Date.parse((r.body as any).due_at)
  expect(due).toBeGreaterThanOrEqual(before + 55_000)
  expect(due).toBeLessThanOrEqual(Date.now() + 65_000)
})
```

Run: `bun --bun vitest run src/daemon/internal-api/routes-reminders.test.ts` → FAIL (module doesn't exist).

- [ ] **Step 4: Implement `routes-reminders.ts`**

```ts
/**
 * internal-api reminder routes (spec 2026-08-20-reminders-port-design §2.3,
 * ported from the June feat/reminders branch). Delivered by the reminder
 * sweeper (src/daemon/reminders), persisted in the daemon db.
 *
 * Scope rule (user ruling 2026-08-20): session-origin callers — ANY tier —
 * may only touch their own chat ("提醒我" semantics). The June version let
 * any session schedule timed messages to arbitrary chat_ids, which under the
 * guest path is a harassment/impersonation primitive. File/operator tokens
 * (the CLI) are unrestricted. The 403 never echoes the requested chat_id.
 */
import { makeRemindersStore } from '../reminders/store'
import type { InternalApiDeps, RouteTable } from './types'
import { errMsg } from './types'
import type { ReminderScheduleRequestT, ReminderCancelRequestT } from './schema'

type Caller = Parameters<NonNullable<RouteTable[string]>>[2]

function scopeDenied(chatId: string, caller: Caller): boolean {
  if (caller?.origin !== 'session') return false
  return !caller.chatId || caller.chatId !== chatId
}
const DENIED = { status: 403, body: { error: 'reminder_scope_denied' } }

export function remindersRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/reminders/schedule': async (_q, body, caller) => {
      if (!deps.db) return { status: 503, body: { error: 'db_not_wired' } }
      const { chat_id, text, due_at, delay_seconds } = body as ReminderScheduleRequestT
      if (scopeDenied(chat_id, caller)) return DENIED
      try {
        const dueIso = due_at !== undefined
          ? new Date(due_at).toISOString()
          : new Date(Date.now() + delay_seconds! * 1000).toISOString()
        const store = makeRemindersStore(deps.db)
        const id = await store.schedule({ chat_id, due_at: dueIso, text })
        deps.log?.('REMINDERS', `scheduled ${id} → ${chat_id} at ${dueIso}`)
        return { status: 200, body: { ok: true, reminder_id: id, due_at: dueIso } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/reminders/cancel': async (_q, body, caller) => {
      if (!deps.db) return { status: 503, body: { error: 'db_not_wired' } }
      const { chat_id, reminder_id } = body as ReminderCancelRequestT
      if (scopeDenied(chat_id, caller)) return DENIED
      try {
        const store = makeRemindersStore(deps.db)
        const cancelled = await store.cancel(reminder_id, chat_id)
        return { status: 200, body: { ok: true, cancelled } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'GET /v1/reminders/list': async (q, _body, caller) => {
      if (!deps.db) return { status: 503, body: { error: 'db_not_wired' } }
      const chatId = q.get('chat_id')
      if (!chatId) return { status: 400, body: { ok: false, error: 'chat_id required' } }
      if (scopeDenied(chatId, caller)) return DENIED
      try {
        const store = makeRemindersStore(deps.db)
        const reminders = (await store.list(chatId)).map(r => ({
          id: r.id, due_at: r.due_at, text: r.text, status: r.status,
        }))
        return { status: 200, body: { ok: true, reminders } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
  }
}
```

(If `deps.log` doesn't exist on `InternalApiDeps`, drop that line — check the type. If the `Caller` `Parameters<>` extraction fights the RouteHandler type, import `RouteHandler` and use `Parameters<RouteHandler>[2]`.)

Merge into the table in `routes.ts`: import `remindersRoutes` and add `...remindersRoutes(deps),` beside the other spreads at the bottom.

- [ ] **Step 5: Run route tests to verify they pass**

Run: `bun --bun vitest run src/daemon/internal-api/routes-reminders.test.ts`
Expected: PASS.

- [ ] **Step 6: route-tiers entries + test** — in `route-tiers.ts` under the guest section (scope is enforced server-side in the handler; tool visibility open to all tiers per spec §2.3):

```ts
  // reminders — scope (own chat only for session callers) is enforced in
  // routes-reminders.ts; the tier floor is guest ("提醒我" is harmless).
  'POST /v1/reminders/schedule': 'guest',
  'POST /v1/reminders/cancel': 'guest',
  'GET /v1/reminders/list': 'guest',
```

In `route-tiers.test.ts` add:

```ts
it('reminder routes are guest-reachable (scope enforced in-handler)', () => {
  expect(minTierFor('POST /v1/reminders/schedule')).toBe('guest')
  expect(minTierFor('POST /v1/reminders/cancel')).toBe('guest')
  expect(minTierFor('GET /v1/reminders/list')).toBe('guest')
})
```

Run: `bun --bun vitest run src/daemon/internal-api/`
Expected: PASS (all internal-api tests, including any route-coverage counting tests — if one asserts a total route count, bump it by 3).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/internal-api/schema.ts src/daemon/internal-api/schema.test.ts \
  src/daemon/internal-api/routes-reminders.ts src/daemon/internal-api/routes-reminders.test.ts \
  src/daemon/internal-api/routes.ts src/daemon/internal-api/route-tiers.ts src/daemon/internal-api/route-tiers.test.ts
git commit -m "feat(internal-api): /v1/reminders routes — session callers scoped to own chat (403 no-echo)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: MCP tools (current error posture, own-chat copy)

**Files:**
- Modify: `src/mcp-servers/wechat/main.ts` (three `server.registerTool` blocks, placed with the other tool registrations; use the file's existing `client`, `z`, `logErr`, `formatError` imports)

**Interfaces:**
- Consumes: Task 4's routes via `client.request('POST'|'GET', path, body?)` (existing helper in the file).
- Produces: tools `schedule_reminder`, `cancel_reminder`, `list_reminders`.

- [ ] **Step 1: Add the three tools** — June's blocks adapted twice: (a) error handling uses the file's current inline posture (June's `passthroughErrorResult` no longer exists), (b) descriptions rewritten for own-chat scope (no "ANY user"):

```ts
// ─── reminders(每聊天、分钟级、一次性)────────────────────────────────
// 与 companion/agenda(operator-only、天粒度)不同:这是给「当前聊天」设的
// 精确时间提醒,由 daemon 的 sweeper 直接投递,跨重启存活。chat_id 必须是
// 当前对话的 chat_id —— 服务端按会话身份校验,给别的聊天设提醒会被 403。

server.registerTool(
  'schedule_reminder',
  {
    title: 'Schedule a precise-time reminder',
    description:
      '给当前聊天的用户设一个精确时间的提醒，到点由 daemon 直接发出（不依赖本会话存活，跨重启）。' +
      'chat_id=当前对话的 chat_id（服务端校验，只能给本聊天设）。' +
      '二选一：delay_seconds（相对秒数，首选，免时区计算）或 due_at（绝对 ISO 8601 时间）。' +
      'text=到点要发的内容。返回 { ok, reminder_id, due_at }。适合"X 小时后/几点提醒我"。' +
      '若到点时投递失败会按指数退避自动重试最多 24 小时。',
    inputSchema: {
      chat_id: z.string(),
      text: z.string().min(1).max(4000),
      delay_seconds: z.number().int().min(1).max(60 * 60 * 24 * 365).optional(),
      due_at: z.string().optional(),
    },
  },
  async ({ chat_id, text, delay_seconds, due_at }) => {
    try {
      const payload: Record<string, unknown> = { chat_id, text }
      if (delay_seconds !== undefined) payload.delay_seconds = delay_seconds
      if (due_at !== undefined) payload.due_at = due_at
      const r = await client.request<unknown>('POST', '/v1/reminders/schedule', payload)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      logErr(`schedule_reminder failed: ${formatError(err)}`)
      return { content: [{ type: 'text', text: `schedule_reminder failed: ${formatError(err)}` }], isError: true }
    }
  },
)

server.registerTool(
  'cancel_reminder',
  {
    title: 'Cancel a pending reminder',
    description: '取消当前聊天一个还未触发的提醒。reminder_id 来自 schedule_reminder / list_reminders；chat_id=当前对话的 chat_id。返回 { ok, cancelled }。',
    inputSchema: { chat_id: z.string(), reminder_id: z.string() },
  },
  async ({ chat_id, reminder_id }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/reminders/cancel', { chat_id, reminder_id })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      logErr(`cancel_reminder failed: ${formatError(err)}`)
      return { content: [{ type: 'text', text: `cancel_reminder failed: ${formatError(err)}` }], isError: true }
    }
  },
)

server.registerTool(
  'list_reminders',
  {
    title: "List this chat's reminders",
    description: '列出当前聊天的所有提醒（含 pending/sent/cancelled/failed）。chat_id=当前对话的 chat_id。返回 { ok, reminders:[{id,due_at,text,status}] }。',
    inputSchema: { chat_id: z.string() },
  },
  async ({ chat_id }) => {
    try {
      const r = await client.request<unknown>('GET', `/v1/reminders/list?chat_id=${encodeURIComponent(chat_id)}`)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      logErr(`list_reminders failed: ${formatError(err)}`)
      return { content: [{ type: 'text', text: `list_reminders failed: ${formatError(err)}` }], isError: true }
    }
  },
)
```

(Match the file's real import names — if the error-branch helper differs from `logErr`/`formatError`, mirror the `ping` tool's catch block exactly. If a tool-count test exists for the wechat MCP server, bump it by 3.)

- [ ] **Step 2: Typecheck + any MCP-server tests**

Run: `bunx tsc --noEmit 2>&1 | head -20` (or the repo's typecheck script if one exists in package.json) and `bun --bun vitest run src/mcp-servers/`
Expected: clean / PASS.

- [ ] **Step 3: Commit**

```bash
git add src/mcp-servers/wechat/main.ts
git commit -m "feat(mcp): schedule/cancel/list reminder tools — own-chat copy, current error posture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Supervisor wiring + full regression

**Files:**
- Modify: `src/daemon/main.ts` (step-4 lifecycle block, directly after the `mailbox-poller` block; `db`, `ilink`, `sup`, `lc`, `log` are all in scope there)

**Interfaces:**
- Consumes: `registerReminders` + `makeRemindersStore` (Tasks 2–3); `sup.start<T>(name, fn): Promise<T | undefined>`; `ilink.sendMessage(chatId, text)` which resolves `{ msgId, error? }` and NEVER rejects.
- Produces: `reminders` appears in `GET /v1/health` `subsystems` when started (supervisor does this automatically); degraded on throw.

- [ ] **Step 1: Wire it** — add after the mailbox-poller registration:

```ts
    // Reminder sweeper (spec 2026-08-20-reminders-port) — multi-user
    // precise-time delivery. Optional subsystem: a broken sweeper degrades,
    // never blocks boot. Store is db-backed so pending reminders survive
    // restarts; send goes through the live ilink adapter and checks .error
    // (sendMessage never rejects). Sub-second ticks — no holdBusy needed
    // (an idle self-restart mid-sweep just re-sweeps next boot).
    const remindersLc = await sup.start('reminders', () => registerReminders({
      store: makeRemindersStore(db),
      send: async (chatId, text) => {
        const r = await ilink.sendMessage(chatId, text) as { msgId?: string; error?: string }
        return r.error ? { ok: false, error: r.error } : { ok: true }
      },
      log: (t, l) => log(t, l),
    }))
    if (remindersLc) lc.register(remindersLc)
```

With imports at the top of main.ts:

```ts
import { registerReminders } from './reminders/sweeper'
import { makeRemindersStore } from './reminders/store'
```

(Match the surrounding `sup.start` blocks' exact style; if `log` is wrapped differently there, mirror the mailbox-poller block.)

- [ ] **Step 2: Verify boot-time behavior via existing harness** — check whether `src/daemon/main.ts` wiring has a boot test (e.g. `bootstrap.test.ts` / degraded-boot e2e listing subsystems). If health `subsystems` has a pinned expected list anywhere, add `reminders`. Run the touched test files.

- [ ] **Step 3: Full regression**

Run: `bun --bun vitest run`
Expected: PASS except exactly the 2 known `src/daemon/bootstrap.test.ts` env failures (plugin-symlink dev-machine state). Any OTHER failure is real — fix before committing.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/main.ts
git commit -m "feat(daemon): wire reminder sweeper as optional subsystem (supervisor, degraded-boot safe)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: e2e — schedule→deliver through a live daemon boot

**Files:**
- Create: `src/daemon/reminders/reminders.e2e.test.ts` (copy the harness posture of the nearest daemon-level e2e that boots the pipeline with a fake ilink — e.g. the degraded-boot or onboarding e2e; reuse their fixture helpers rather than inventing a new boot harness)

**Interfaces:**
- Consumes: the full wired stack from Task 6.

- [ ] **Step 1: Write the e2e** — one scenario, minute-precision shrunk via `intervalMs` injection if the harness exposes it, otherwise drive `runReminderSweep` directly against the booted daemon's real db and a captured fake `send`:

```ts
// Shape (adapt to the chosen harness's fixtures):
// 1. boot daemon harness (fake ilink capturing sendMessage calls)
// 2. POST /v1/reminders/schedule { chat_id: FIXTURE_CHAT, text: '提醒:喝水', delay_seconds: 1 } with a session token for FIXTURE_CHAT
// 3. wait past due, run one sweep (injected interval or direct runReminderSweep with the daemon db)
// 4. assert the fake ilink captured exactly one sendMessage(FIXTURE_CHAT, '提醒:喝水')
// 5. assert the row is status='sent' and a second sweep sends nothing (no double delivery)
```

The double-delivery assertion (step 5) is the falsification half — it must actually run a second sweep and assert the capture count is still 1.

- [ ] **Step 2: Run it**

Run: `bun --bun vitest run src/daemon/reminders/reminders.e2e.test.ts` (add `--config vitest.e2e.config.ts` only if the harness file you copied lives under the e2e config's include globs — mirror the copied test's own invocation)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/reminders/reminders.e2e.test.ts
git commit -m "test(reminders): e2e schedule→sweep→deliver + no double delivery

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
