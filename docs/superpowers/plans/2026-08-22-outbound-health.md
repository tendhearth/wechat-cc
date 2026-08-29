# Outbound Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Passive outbound-send health tracking (ok/degraded/unknown) surfaced in `GET /v1/health` and `wechat-cc doctor`, with episode-recovery logging — so a dead ilink send path is visible instead of silently rotting proactive features.

**Architecture:** A pure in-memory state machine (`outbound-health.ts`) is fed by the single send chokepoint in `ilink-glue.ts` (wire-call outcomes only — routing errors excluded). The adapter exposes `outboundHealth()`; main.ts hands it to the internal API as a health dep; the health route adds a sibling `outbound` field (NOT inside `subsystems[]`); the doctor CLI probes the running daemon's health endpoint and prints one warning line when degraded.

**Tech Stack:** TypeScript on bun, vitest (`bun --bun vitest run` — NEVER plain `bunx vitest`), zod schemas, existing `__e2e__` fake-ilink harness.

**Spec:** `docs/superpowers/specs/2026-08-22-outbound-health-design.md`

## Global Constraints

- Test runner: `bun --bun vitest run <files>`; imports from 'vitest', never 'bun:test'.
- Full-suite regression tolerates exactly the 2 known env failures in `src/daemon/bootstrap.test.ts`; anything else is real.
- Degraded threshold: **2** consecutive logical send failures (`degradedAfter` default 2). Backoff/threshold counts LOGICAL sends (one `sendMessage` call = one count), not the 3 internal wire retries.
- Only WIRE failures count (errors thrown by `ilinkSendMessage`). Client-side errors — `'empty text'` early return, `assertChatRoutable` throw, `resolveAccount` throw — must NOT touch the tracker. The account-expired notify path uses `sendReplyOnce` (not the adapter), so it is excluded by construction — do not add special-casing for it.
- `lastError` truncated to ≤200 chars.
- Exactly ONE log line on the ok/unknown→degraded transition and ONE on recovery; no per-failure spam from the tracker (the existing `[RETRY_FAIL]` lines already record each failure).
- Log copy, verbatim:
  - degraded: `` `degraded — ${n} consecutive failures, last: ${error}` `` with tag `OUTBOUND`
  - recovered: `` `recovered after ${durationHuman}, ${n} failures — last error was: ${error}` `` with tag `OUTBOUND`
- Doctor warning line, verbatim: `` `⚠️ 外发链路故障（连续 ${n} 次失败，最近错误 ${err}）。多为微信端会话闲置过期——给 bot 随便发条消息即可恢复；恢复后积压的提醒会自动补投。` `` — printed only when `outbound.state === 'degraded'`; `ok`/`unknown` print nothing.
- The health field is a SIBLING of `subsystems`, never an entry inside it.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. `git add` explicit paths only.

---

### Task 1: Tracker state machine

**Files:**
- Create: `src/daemon/ilink/outbound-health.ts`
- Test: `src/daemon/ilink/outbound-health.test.ts`

**Interfaces:**
- Produces (Tasks 2–4 rely on these exact shapes):

```ts
export type OutboundState = 'unknown' | 'ok' | 'degraded'
export interface OutboundHealth {
  state: OutboundState
  consecutiveFailures: number
  lastOkAt: string | null
  lastFailAt: string | null
  lastError: string | null
  episodeStartedAt: string | null
}
export interface OutboundHealthTracker {
  recordSuccess(nowIso: string): void
  recordFailure(nowIso: string, error: string): void
  snapshot(): OutboundHealth
}
export function makeOutboundHealthTracker(deps: {
  log: (tag: string, line: string) => void
  degradedAfter?: number
}): OutboundHealthTracker
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeOutboundHealthTracker } from './outbound-health'

const T0 = '2026-08-22T10:00:00.000Z'
const T1 = '2026-08-22T10:01:00.000Z'
const T2 = '2026-08-22T10:05:00.000Z'

describe('outbound health tracker', () => {
  it('starts unknown with empty fields', () => {
    const t = makeOutboundHealthTracker({ log: () => {} })
    expect(t.snapshot()).toEqual({
      state: 'unknown', consecutiveFailures: 0,
      lastOkAt: null, lastFailAt: null, lastError: null, episodeStartedAt: null,
    })
  })

  it('one failure stays below the default threshold (no state flip, no log)', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordFailure(T0, 'errcode=-2: prepare failed')
    const s = t.snapshot()
    expect(s.state).toBe('unknown')          // never sent ok, threshold not reached
    expect(s.consecutiveFailures).toBe(1)
    expect(s.lastFailAt).toBe(T0)
    expect(s.lastError).toBe('errcode=-2: prepare failed')
    expect(log).not.toHaveBeenCalled()
  })

  it('second failure flips to degraded with exactly one OUTBOUND log line and episode start', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordFailure(T0, 'e1')
    t.recordFailure(T1, 'e2')
    const s = t.snapshot()
    expect(s.state).toBe('degraded')
    expect(s.consecutiveFailures).toBe(2)
    expect(s.episodeStartedAt).toBe(T0)      // episode began at FIRST failure of the run
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('OUTBOUND', 'degraded — 2 consecutive failures, last: e2')
  })

  it('third failure while degraded logs nothing more', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordFailure(T0, 'e1'); t.recordFailure(T1, 'e2'); t.recordFailure(T2, 'e3')
    expect(log).toHaveBeenCalledTimes(1)
    expect(t.snapshot().consecutiveFailures).toBe(3)
  })

  it('success from degraded closes the episode with duration and count', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordFailure(T0, 'e1'); t.recordFailure(T1, 'boom')
    t.recordSuccess(T2)
    const s = t.snapshot()
    expect(s.state).toBe('ok')
    expect(s.consecutiveFailures).toBe(0)
    expect(s.lastOkAt).toBe(T2)
    expect(s.episodeStartedAt).toBeNull()
    expect(log).toHaveBeenCalledTimes(2)     // degraded line + recovered line
    expect(log).toHaveBeenLastCalledWith('OUTBOUND', 'recovered after 5m, 2 failures — last error was: boom')
  })

  it('success from unknown/ok logs nothing', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordSuccess(T0)
    t.recordSuccess(T1)
    expect(t.snapshot().state).toBe('ok')
    expect(log).not.toHaveBeenCalled()
  })

  it('failure run below threshold cleared by success does not log', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log })
    t.recordFailure(T0, 'e1')
    t.recordSuccess(T1)
    expect(t.snapshot().state).toBe('ok')
    expect(log).not.toHaveBeenCalled()
  })

  it('respects a custom degradedAfter', () => {
    const log = vi.fn()
    const t = makeOutboundHealthTracker({ log, degradedAfter: 1 })
    t.recordFailure(T0, 'e1')
    expect(t.snapshot().state).toBe('degraded')
  })

  it('truncates lastError to 200 chars', () => {
    const t = makeOutboundHealthTracker({ log: () => {} })
    t.recordFailure(T0, 'x'.repeat(500))
    expect(t.snapshot().lastError!.length).toBe(200)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun --bun vitest run src/daemon/ilink/outbound-health.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
/**
 * Outbound send health — passive tracker fed by the ilink-glue sendMessage
 * chokepoint (spec 2026-08-22-outbound-health-design). Pure state machine,
 * zero I/O, time injected. In-memory only: a restart resets to 'unknown'
 * and the next in-flight send (e.g. a reminder retry) re-establishes state
 * within minutes — deliberate trade against persistence complexity.
 *
 * Counts LOGICAL sends (one adapter.sendMessage call), not the 3 internal
 * wire retries; only wire failures reach here (routing errors are excluded
 * at the hook). Exactly one log line per transition — the per-failure
 * record already exists as [RETRY_FAIL] lines.
 */
export type OutboundState = 'unknown' | 'ok' | 'degraded'

export interface OutboundHealth {
  state: OutboundState
  consecutiveFailures: number
  lastOkAt: string | null
  lastFailAt: string | null
  lastError: string | null
  episodeStartedAt: string | null
}

export interface OutboundHealthTracker {
  recordSuccess(nowIso: string): void
  recordFailure(nowIso: string, error: string): void
  snapshot(): OutboundHealth
}

const DEFAULT_DEGRADED_AFTER = 2
const MAX_ERROR_LEN = 200

/** Human-ish duration for the recovery log: 90000ms → "1m", 5h → "5h". */
function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000 * 10) / 10}h`
}

export function makeOutboundHealthTracker(deps: {
  log: (tag: string, line: string) => void
  degradedAfter?: number
}): OutboundHealthTracker {
  const threshold = deps.degradedAfter ?? DEFAULT_DEGRADED_AFTER
  const s: OutboundHealth = {
    state: 'unknown', consecutiveFailures: 0,
    lastOkAt: null, lastFailAt: null, lastError: null, episodeStartedAt: null,
  }
  // First failure timestamp of the current run — becomes episodeStartedAt
  // when the run crosses the threshold.
  let runStartedAt: string | null = null

  return {
    recordSuccess(nowIso) {
      if (s.state === 'degraded') {
        const dur = Date.parse(nowIso) - Date.parse(s.episodeStartedAt ?? nowIso)
        deps.log('OUTBOUND', `recovered after ${humanDuration(dur)}, ${s.consecutiveFailures} failures — last error was: ${s.lastError}`)
      }
      s.state = 'ok'
      s.consecutiveFailures = 0
      s.lastOkAt = nowIso
      s.episodeStartedAt = null
      runStartedAt = null
    },
    recordFailure(nowIso, error) {
      s.consecutiveFailures++
      s.lastFailAt = nowIso
      s.lastError = error.slice(0, MAX_ERROR_LEN)
      if (runStartedAt === null) runStartedAt = nowIso
      if (s.state !== 'degraded' && s.consecutiveFailures >= threshold) {
        s.state = 'degraded'
        s.episodeStartedAt = runStartedAt
        deps.log('OUTBOUND', `degraded — ${s.consecutiveFailures} consecutive failures, last: ${s.lastError}`)
      }
    },
    snapshot() {
      return { ...s }
    },
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun --bun vitest run src/daemon/ilink/outbound-health.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/ilink/outbound-health.ts src/daemon/ilink/outbound-health.test.ts
git commit -m "feat(ilink): outbound health tracker — passive state machine with episode logging

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Hook the sendMessage chokepoint + adapter surface

**Files:**
- Modify: `src/daemon/ilink-glue.ts` (the `adapter.sendMessage` implementation around line 158-195, the `IlinkAdapter` interface at line 51, tracker construction near the adapter)
- Test: `src/daemon/ilink-glue.outbound.test.ts` (new; if a simpler existing unit-test file for ilink-glue exists, add there instead — check first)

**Interfaces:**
- Consumes: `makeOutboundHealthTracker`, `OutboundHealth` from Task 1; existing `log` in scope in `makeIlinkAdapter`.
- Produces: `IlinkAdapter` gains `outboundHealth(): OutboundHealth`. Task 3 wires `() => ilink.outboundHealth()` into internal-api deps.

- [ ] **Step 1: Read the current `sendMessage`** in `src/daemon/ilink-glue.ts` (lines ~158-195). Key structure: early `'empty text'` return → `assertChatRoutable(chatId)` (throws for unroutable) → `resolveAccount(chatId)` → chunk loop calling `ilinkSendMessage(...)` → success return; one catch normalizes everything to `{ msgId, error }`. The hook must only count wire outcomes: set a flag when entering the wire loop.

- [ ] **Step 2: Write the failing test.** The wire call is a static import, so unit-test through the seam that already exists for tests — check how `src/daemon/__e2e__/fake-ilink-server.ts` + `harness.ts` boot a daemon against a fake server, and whether the fake server can be told to fail `sendmessage` (grep for `sendmessage` in `fake-ilink-server.ts`). Two acceptable shapes — pick whichever the existing harness supports with less new machinery, and say which you chose in your report:
  - (a) e2e-style: boot the harness, make the fake ilink server return `{"ret":-2,"errmsg":"prepare failed"}` for `ilink/bot/sendmessage` (add a toggle to the fake server if it lacks one), call `daemon.ilink.sendMessage(...)` twice, assert `daemon.ilink.outboundHealth().state === 'degraded'`; flip the fake back to success, send once, assert `state === 'ok'` and `consecutiveFailures === 0`.
  - (b) if `makeIlinkAdapter` accepts an injectable send fn (it does not today — do NOT add one just for this), fall back to (a).

  Additional assertions in the same test file:
  - `sendMessage(chatId, '')` (empty text) does not change the snapshot.
  - `sendMessage('unknown-chat-never-seen', 'hi')` (unroutable → client-side error) does not change the snapshot.

- [ ] **Step 3: Run to verify it fails** (adapter has no `outboundHealth`): `bun --bun vitest run <the new test file>`.

- [ ] **Step 4: Implement the hook.** In `makeIlinkAdapter`:

```ts
// near the adapter construction:
const outbound = makeOutboundHealthTracker({ log: (t, l) => log(t, l) })
```

In `sendMessage`, wrap the wire section:

```ts
    async sendMessage(chatId, text) {
      if (!text) return { msgId: `err:${Date.now()}`, error: 'empty text' }
      let reachedWire = false
      try {
        assertChatRoutable(chatId)
        const acct = resolveAccount(chatId)
        const ctxToken = ctxStore.get(chatId)
        const chunks = chunk(text, MAX_TEXT_CHUNK)
        reachedWire = true
        for (const part of chunks) {
          await ilinkSendMessage(acct.baseUrl, acct.token, botTextMessage(chatId, part, ctxToken))
        }
        outbound.recordSuccess(new Date().toISOString())
        // ... existing messagesStore.append block unchanged ...
        return { msgId: `sent:${Date.now()}` }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Only wire failures feed the health tracker — routing errors
        // (unroutable chat, unknown account) say nothing about the link.
        if (reachedWire) outbound.recordFailure(new Date().toISOString(), msg)
        return { msgId: `err:${Date.now()}`, error: msg }
      }
    },
```

Add to the `IlinkAdapter` interface and the adapter object:

```ts
  /** Passive outbound link health (spec 2026-08-22-outbound-health). */
  outboundHealth(): OutboundHealth
```
```ts
    outboundHealth: () => outbound.snapshot(),
```

Import `makeOutboundHealthTracker, type OutboundHealth` from `./ilink/outbound-health`.

- [ ] **Step 5: Run the new test + neighbors**: `bun --bun vitest run <new test file> src/daemon/ilink/` → PASS. Also `npx tsc --noEmit -p . 2>&1 | grep -v node_modules | head` → no new errors (other IlinkAdapter fakes in tests may now fail the interface — add a trivial `outboundHealth: () => ({ state: 'unknown', consecutiveFailures: 0, lastOkAt: null, lastFailAt: null, lastError: null, episodeStartedAt: null })` to any fake the compiler flags, or check whether fakes use `Pick<IlinkAdapter, ...>` and need nothing).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/ilink-glue.ts src/daemon/ilink-glue.outbound.test.ts
git commit -m "feat(ilink): sendMessage chokepoint feeds outbound health — wire failures only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
(Adjust the test path in `git add` if Step 2 landed the test elsewhere; include any fake-ilink-server toggle file you touched.)

---

### Task 3: /v1/health outbound field

**Files:**
- Modify: `src/daemon/internal-api/types.ts` (add `outbound?: () => OutboundHealth` to `InternalApiDeps`, near `subsystems` at line ~394)
- Modify: `src/daemon/internal-api/routes.ts` (the `'GET /v1/health'` handler at line ~76)
- Modify: `src/daemon/internal-api/schema.ts` (`HealthResponse` at line ~25)
- Modify: `src/daemon/main.ts` (the internal-api deps construction where `subsystems: () => sup.statuses()` is passed, line ~247)
- Test: extend `src/daemon/internal-api/schema.test.ts` and whichever test covers the health route (`grep -rn "'GET /v1/health'" src/daemon/internal-api/*.test.ts src/daemon/internal-api.test.ts` — add there)

**Interfaces:**
- Consumes: `OutboundHealth` from Task 1; `ilink.outboundHealth()` from Task 2.
- Produces: health body gains sibling field `outbound: { state, consecutive_failures, last_ok_at, last_error }` (snake_case on the wire, matching the route's existing style). Task 4 reads exactly this shape.

- [ ] **Step 1: Write the failing tests.** Schema test (in `schema.test.ts`, existing safeParse style):

```ts
it('HealthResponse accepts the outbound sibling field and stays optional', () => {
  expect(HealthResponse.safeParse({ ok: true, daemon_pid: 1 }).success).toBe(true)
  expect(HealthResponse.safeParse({ ok: true, daemon_pid: 1, outbound: {
    state: 'degraded', consecutive_failures: 3, last_ok_at: null, last_error: 'errcode=-2: prepare failed',
  } }).success).toBe(true)
  expect(HealthResponse.safeParse({ ok: true, daemon_pid: 1, outbound: { state: 'weird' } }).success).toBe(false)
})
```

Route test (in the file that already builds the health route table with stub deps):

```ts
it('GET /v1/health renders outbound from the dep and omits it when unwired', async () => {
  const withDep = makeRoutesUnderTest({ outbound: () => ({
    state: 'degraded', consecutiveFailures: 2, lastOkAt: null,
    lastFailAt: '2026-08-22T10:01:00.000Z', lastError: 'boom', episodeStartedAt: '2026-08-22T10:00:00.000Z',
  }) })
  const r = await withDep['GET /v1/health']!(new URLSearchParams(), undefined)
  expect((r.body as any).outbound).toEqual({
    state: 'degraded', consecutive_failures: 2, last_ok_at: null, last_error: 'boom',
  })
  const without = makeRoutesUnderTest({})
  const r2 = await without['GET /v1/health']!(new URLSearchParams(), undefined)
  expect((r2.body as any).outbound).toBeUndefined()
})
```

(`makeRoutesUnderTest` = whatever helper the existing health-route test already uses to build the table with minimal deps — reuse it, don't invent.)

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** types.ts:

```ts
  /** Passive outbound link health from ilink-glue (spec 2026-08-22-outbound-health). */
  outbound?: () => import('../ilink/outbound-health').OutboundHealth
```

routes.ts handler — add after `subsystems`:

```ts
        subsystems: deps.subsystems?.() ?? [],
        ...(deps.outbound ? { outbound: toWireOutbound(deps.outbound()) } : {}),
```

with a small helper near the handler:

```ts
function toWireOutbound(h: import('../ilink/outbound-health').OutboundHealth) {
  return {
    state: h.state,
    consecutive_failures: h.consecutiveFailures,
    last_ok_at: h.lastOkAt,
    last_error: h.lastError,
  }
}
```

schema.ts — inside `HealthResponse`:

```ts
  // Passive outbound link health (spec 2026-08-22-outbound-health) — sibling
  // of subsystems by design: subsystems is the supervisor's BOOT-time list,
  // outbound is a RUNTIME link signal. Optional for older daemons.
  outbound: z.object({
    state: z.enum(['unknown', 'ok', 'degraded']),
    consecutive_failures: z.number(),
    last_ok_at: z.string().nullable(),
    last_error: z.string().nullable(),
  }).optional(),
```

main.ts — beside `subsystems: () => sup.statuses(),`:

```ts
      outbound: () => ilink.outboundHealth(),
```

- [ ] **Step 4: Run**: `bun --bun vitest run src/daemon/internal-api/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/internal-api/types.ts src/daemon/internal-api/routes.ts \
  src/daemon/internal-api/schema.ts src/daemon/internal-api/schema.test.ts src/daemon/main.ts
git commit -m "feat(health): outbound link state as a sibling field on /v1/health

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
(Also add the route-test file you extended.)

---

### Task 4: Doctor warning line

**Files:**
- Modify: `src/cli/doctor.ts` (new exported async helper + one call in `printDoctor`'s caller path)
- Modify: `cli.ts` (doctor command at line ~255-257: after `printDoctor(report)`, await the probe and print)
- Test: extend `src/cli/doctor.test.ts`

**Interfaces:**
- Consumes: the wire shape from Task 3 (`outbound: { state, consecutive_failures, last_ok_at, last_error }`), `readDaemon`'s `DaemonSnapshot` (has optional `internal_api: { port, token_file_path }`).
- Produces: `probeOutboundWarning(daemon, fetchFn?, readToken?): Promise<string | null>` exported from doctor.ts.

- [ ] **Step 1: Write the failing tests** (in `doctor.test.ts`, injecting fetch — no real network):

```ts
import { probeOutboundWarning } from './doctor'

const daemonAlive = { alive: true, pid: 1, internal_api: { port: 12345, token_file_path: '/tmp/tok' } } as any

describe('probeOutboundWarning', () => {
  it('returns the warning line when outbound is degraded', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ ok: true, daemon_pid: 1, outbound: {
      state: 'degraded', consecutive_failures: 4, last_ok_at: null, last_error: 'errcode=-2: prepare failed',
    } }), { status: 200 })
    const line = await probeOutboundWarning(daemonAlive, fetchFn, () => 'tok')
    expect(line).toBe('⚠️ 外发链路故障（连续 4 次失败，最近错误 errcode=-2: prepare failed）。多为微信端会话闲置过期——给 bot 随便发条消息即可恢复；恢复后积压的提醒会自动补投。')
  })

  it('returns null for ok, unknown, missing field, dead daemon, or fetch failure', async () => {
    const okFetch = async () => new Response(JSON.stringify({ ok: true, daemon_pid: 1, outbound: { state: 'ok', consecutive_failures: 0, last_ok_at: null, last_error: null } }), { status: 200 })
    expect(await probeOutboundWarning(daemonAlive, okFetch, () => 'tok')).toBeNull()
    const noField = async () => new Response(JSON.stringify({ ok: true, daemon_pid: 1 }), { status: 200 })
    expect(await probeOutboundWarning(daemonAlive, noField, () => 'tok')).toBeNull()
    expect(await probeOutboundWarning({ alive: false, pid: null } as any, okFetch, () => 'tok')).toBeNull()
    const boom = async () => { throw new Error('conn refused') }
    expect(await probeOutboundWarning(daemonAlive, boom as any, () => 'tok')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** in doctor.ts:

```ts
/**
 * Probe the running daemon's /v1/health for outbound link state and return
 * the human warning line for `doctor` output — or null when there is
 * nothing to warn about (ok/unknown/unreachable: doctor only speaks on
 * anomalies). Never throws; a dead daemon or fetch error is null.
 */
export async function probeOutboundWarning(
  daemon: DaemonSnapshot,
  fetchFn: typeof fetch = fetch,
  readToken: (path: string) => string | null = (p) => { try { return readFileSync(p, 'utf8').trim() } catch { return null } },
): Promise<string | null> {
  if (!daemon.alive || !daemon.internal_api) return null
  const token = readToken(daemon.internal_api.token_file_path)
  if (!token) return null
  try {
    const res = await fetchFn(`http://127.0.0.1:${daemon.internal_api.port}/v1/health`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const body = await res.json() as { outbound?: { state?: string; consecutive_failures?: number; last_error?: string | null } }
    const ob = body.outbound
    if (!ob || ob.state !== 'degraded') return null
    return `⚠️ 外发链路故障（连续 ${ob.consecutive_failures ?? '?'} 次失败，最近错误 ${ob.last_error ?? '未知'}）。多为微信端会话闲置过期——给 bot 随便发条消息即可恢复；恢复后积压的提醒会自动补投。`
  } catch {
    return null
  }
}
```

(Confirm `DaemonSnapshot`'s `internal_api` field name/shape at doctor.ts:609-643 — it is `{ port, token_file_path }` from `readInternalApiInfo`. If `DaemonSnapshot`'s type doesn't declare `internal_api`, extend the type rather than casting.)

cli.ts doctor command (line ~255-257) — human mode only, `--json` output unchanged (deliberate: DoctorOutput schema untouched, YAGNI):

```ts
    const report = analyzeDoctor(defaultDoctorDeps())
    if (jsonMode) console.log(JSON.stringify(DoctorOutput.parse(report)))   // ← existing line, unchanged
    else {
      printDoctor(report)
      const warn = await probeOutboundWarning(report.checks.daemon)
      if (warn) console.log(warn)
    }
```

(Match the file's actual existing json/else structure — edit minimally; import `probeOutboundWarning` in cli.ts's existing doctor import line.)

- [ ] **Step 4: Run**: `bun --bun vitest run src/cli/doctor.test.ts` → PASS; `npx tsc --noEmit -p . 2>&1 | grep -v node_modules | head` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts src/cli/doctor.test.ts cli.ts
git commit -m "feat(doctor): warn when the outbound link is degraded, with the re-warm hint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end degraded→recovery + full regression

**Files:**
- Test: extend the Task 2 test file (or `src/daemon/__e2e__/` if Task 2 chose the harness) with one full-chain scenario through the HTTP health endpoint

**Interfaces:**
- Consumes: everything above, wired through the real daemon boot harness.

- [ ] **Step 1: Write the e2e** — boot the harness, force fake-server `sendmessage` failure, drive two `sendMessage` calls, then GET `/v1/health` over real HTTP with the harness's token and assert `body.outbound.state === 'degraded'` and `consecutive_failures === 2`; flip the fake to success, send once, GET again, assert `state === 'ok'`, `consecutive_failures === 0`, `last_ok_at` non-null. If Task 2's test already covers degraded/recovery at the adapter level, this task adds ONLY the HTTP-surface assertions (the route wiring is what Task 3 added and what this proves). Reuse Task 2's failure toggle.

- [ ] **Step 2: Run it** with the same invocation family as the harness file you extended.

- [ ] **Step 3: Full regression**

Run: `bun --bun vitest run`
Expected: PASS except exactly the 2 known `src/daemon/bootstrap.test.ts` env failures.

- [ ] **Step 4: Commit**

```bash
git add <the e2e test file>
git commit -m "test(outbound-health): degraded→recovery visible end-to-end on /v1/health

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
