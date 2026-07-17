# CLI Social Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `wechat-cc social {seeks,echoes,pledges,reveal}` so the owner can see
their 觅食台 wishes/echoes/pledges from the terminal and reveal from there.

**Architecture:** Two proven CLI patterns, each used where it belongs. Reads
(`seeks`/`echoes`/`pledges`) go **direct to the daemon's SQLite** via the existing
core stores — mirroring `cmdAgentActivity` in `src/cli/agent.ts` — so they work
with the daemon down and respect the `cli↛daemon` dependency rule. `reveal` needs
network + notifications, so it goes **through the running daemon's internal-api** —
mirroring `mode set` in `cli.ts` (read `internal-api-info.json` → Bearer POST).

**Tech Stack:** TypeScript/Bun, citty (`defineCommand`), vitest. Spec:
`docs/superpowers/specs/2026-07-17-cli-social-surface-design.md`.

## Global Constraints

- **PRIVACY (load-bearing):** `echoes` output MUST be projected through
  `toPublicEcho(r: EchoRow): PublicEchoRow` from `../core/social-echo-store`.
  `peer_agent_id` / `relay_via` / `relay_token` must NEVER appear in output —
  human or `--json`. Printing a raw `EchoRow` re-opens the leak the 2026-07-17
  masking fix closed. A test asserts their absence.
- **`db.close()` in a `finally`** around every `openWechatDb` use — a leaked
  SQLite handle blocks `rmSync` on Windows (EBUSY). Copy the guard + comment from
  `cmdAgentActivity` (`src/cli/agent.ts:319-340`).
- **No CLI seeding.** No `social seek "..."` command — sowing is the bot's job.
- Tests: `bun run test <path>` (vitest — NOT `bun test`). Gates per task:
  the task's test file + `bun run typecheck` + `bun run depcheck` (the
  `cli-must-not-depend-on-daemon` rule must stay green — importing from
  `src/core/` is allowed, from `src/daemon/` is NOT).
- Default `--limit` is 20 (matches `agent activity`). Output plain text, one row
  per line, newest-first (stores already order `created_at DESC, rowid DESC`);
  `--json` prints a JSON envelope.

---

## Task 1: Read commands — `src/cli/social.ts` (seeks / echoes / pledges)

**Files:**
- Create: `src/cli/social.ts`
- Test: `src/cli/social.test.ts`

**Interfaces:**
- Consumes: `openWechatDb(stateDir)` (`../lib/db`); `makeSeekStore` / `SeekRow`
  (`../core/social-seek-store`); `makeEchoStore` / `toPublicEcho` /
  `PublicEchoRow` (`../core/social-echo-store`); `makePledgeStore` / `PledgeRow`
  (`../core/social-pledge-store`).
- Produces (Task 3 wires these into `cli.ts`):
  - `cmdSocialSeeks(stateDir: string, opts: { limit: number; json: boolean }): void`
  - `cmdSocialEchoes(stateDir: string, opts: { limit: number; json: boolean; seek?: string }): void`
  - `cmdSocialPledges(stateDir: string, opts: { limit: number; json: boolean }): void`

- [ ] **Step 1: Write the failing tests** — create `src/cli/social.test.ts`.
Mirror `src/cli/agent.test.ts`'s idiom exactly: a `tempState()` helper, a `seed()`
helper that opens the db / seeds / **closes it in `finally`**, and `captureLog`
to collect `console.log` lines. Read `src/cli/agent.test.ts` first and copy its
`tempState` + `captureLog` helpers verbatim (do not reinvent them).

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db'
import { makeSeekStore } from '../core/social-seek-store'
import { makeEchoStore } from '../core/social-echo-store'
import { makePledgeStore } from '../core/social-pledge-store'
import { cmdSocialSeeks, cmdSocialEchoes, cmdSocialPledges } from './social'

function tempState(): string {
  return mkdtempSync(join(tmpdir(), 'wechat-cc-cli-social-test-'))
}

// captureLog: copy the helper from src/cli/agent.test.ts verbatim.

describe('cmdSocialSeeks', () => {
  let stateDir: string
  function seed(fn: (s: ReturnType<typeof makeSeekStore>) => void): void {
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    try { fn(makeSeekStore(db)) } finally { db.close() }
  }
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('prints an empty note when there are no seeks', async () => {
    const out = await captureLog(() => cmdSocialSeeks(stateDir, { limit: 20, json: false }))
    expect(out.some(l => /没有|no seeks/i.test(l))).toBe(true)
  })

  it('prints seeks newest-first with topic + status', async () => {
    seed(s => {
      s.create({ id: 'i1', kind: 'seek', topic: '找摄影搭子' })
      s.create({ id: 'i2', kind: 'seek', topic: '找会修相机的' })
    })
    const out = await captureLog(() => cmdSocialSeeks(stateDir, { limit: 20, json: false }))
    expect(out[0]).toContain('找会修相机的')   // newest first
    expect(out[0]).toContain('foraging')
    expect(out.some(l => l.includes('找摄影搭子'))).toBe(true)
  })

  it('--json emits a parseable envelope', async () => {
    seed(s => { s.create({ id: 'i1', kind: 'seek', topic: '找摄影搭子' }) })
    const out = await captureLog(() => cmdSocialSeeks(stateDir, { limit: 20, json: true }))
    const parsed = JSON.parse(out.join('\n'))
    expect(parsed.seeks[0].topic).toBe('找摄影搭子')
  })
})

describe('cmdSocialEchoes', () => {
  let stateDir: string
  function seedEcho(fn: (s: ReturnType<typeof makeEchoStore>) => void): void {
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    try { fn(makeEchoStore(db)) } finally { db.close() }
  }
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  // THE PRIVACY LOCK — this is the reason toPublicEcho exists.
  it('NEVER prints peer_agent_id / relay_via / relay_token (human or json)', async () => {
    seedEcho(s => {
      s.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: '我认识个师傅', peerAgentId: 'ccb' })
      s.create({ id: 'i1:ccw:tok', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: '经W转发', peerAgentId: null, relayVia: 'ccw', relayToken: 'tok' })
    })
    const human = (await captureLog(() => cmdSocialEchoes(stateDir, { limit: 20, json: false }))).join('\n')
    const json = (await captureLog(() => cmdSocialEchoes(stateDir, { limit: 20, json: true }))).join('\n')
    for (const blob of [human, json]) {
      expect(blob).not.toContain('ccb')
      expect(blob).not.toContain('ccw')
      expect(blob).not.toContain('tok')
      expect(blob).not.toContain('peer_agent_id')
      expect(blob).not.toContain('relay_via')
      expect(blob).not.toContain('relay_token')
    }
    // The masked view IS shown:
    expect(human).toContain('第 1 度的某人')
    expect(human).toContain('第 2 度的某人')
  })

  it('--seek filters to one wish', async () => {
    seedEcho(s => {
      s.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'aaa', peerAgentId: 'ccb' })
      s.create({ id: 'i2:ccc', seekId: 'i2', peerMasked: '第 1 度的某人', degree: 1, content: 'bbb', peerAgentId: 'ccc' })
    })
    const out = (await captureLog(() => cmdSocialEchoes(stateDir, { limit: 20, json: false, seek: 'i1' }))).join('\n')
    expect(out).toContain('aaa')
    expect(out).not.toContain('bbb')
  })
})

describe('cmdSocialPledges', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('prints pledges with topic (empty note when none)', async () => {
    const empty = await captureLog(() => cmdSocialPledges(stateDir, { limit: 20, json: false }))
    expect(empty.some(l => /没有|no pledges/i.test(l))).toBe(true)

    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    try { makePledgeStore(db).create({ id: 'i9:cca', intentId: 'i9', seekerAgentId: 'cca', topic: '找球友' }) }
    finally { db.close() }

    const out = (await captureLog(() => cmdSocialPledges(stateDir, { limit: 20, json: false }))).join('\n')
    expect(out).toContain('找球友')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/cli/social.test.ts`
Expected: FAIL — module `./social` does not exist.

- [ ] **Step 3: Implement** — create `src/cli/social.ts`:

```ts
/**
 * wechat-cc social <subcommand> — 觅食台 read surface.
 *
 * Subcommands (read-only; work with the daemon DOWN):
 *   seeks     List my wishes + status (foraging/echoed/connected/closed)
 *   echoes    List postcards that came back (MASKED — see below)
 *   pledges   List wishes of others I answered
 *
 * `reveal` lives in cli.ts — it needs the running daemon (network + notify).
 *
 * PRIVACY: echoes are projected through toPublicEcho() before printing.
 * The raw EchoRow carries peer_agent_id / relay_via / relay_token — server-side
 * only, hidden until a mutual reveal. Printing a raw row would re-open the leak
 * that GET /v1/social/echoes was fixed to close.
 *
 * See docs/superpowers/specs/2026-07-17-cli-social-surface-design.md.
 */
import { openWechatDb } from '../lib/db'
import { makeSeekStore } from '../core/social-seek-store'
import { makeEchoStore, toPublicEcho, type PublicEchoRow } from '../core/social-echo-store'
import { makePledgeStore } from '../core/social-pledge-store'

export interface SocialReadOpts { limit: number; json: boolean }

/**
 * Close the db handle before returning — a leaked SQLite handle blocks the
 * file from being deleted on Windows (EBUSY). Same guard as cmdAgentActivity.
 */
function withDb<T>(stateDir: string, fn: (db: ReturnType<typeof openWechatDb>) => T): T {
  const db = openWechatDb(stateDir)
  try { return fn(db) } finally { db.close() }
}

export function cmdSocialSeeks(stateDir: string, opts: SocialReadOpts): void {
  const rows = withDb(stateDir, db => makeSeekStore(db).list()).slice(0, opts.limit)
  if (opts.json) { console.log(JSON.stringify({ seeks: rows }, null, 2)); return }
  if (rows.length === 0) { console.log('还没有心愿(no seeks)'); return }
  for (const r of rows) {
    console.log(`${r.created_at}  ${r.status.padEnd(9)} ${r.kind}  ${r.topic}  [${r.id}]`)
  }
}

export function cmdSocialEchoes(stateDir: string, opts: SocialReadOpts & { seek?: string }): void {
  const rows: PublicEchoRow[] = withDb(stateDir, db => {
    const store = makeEchoStore(db)
    const raw = opts.seek ? store.listForSeek(opts.seek) : store.listAll()
    // MUST project — never print a raw EchoRow (peer_agent_id/relay_*).
    return raw.map(toPublicEcho)
  }).slice(0, opts.limit)
  if (opts.json) { console.log(JSON.stringify({ echoes: rows }, null, 2)); return }
  if (rows.length === 0) { console.log('还没有回声(no echoes)'); return }
  for (const r of rows) {
    const waiting = r.self_revealed_at && !r.peer_revealed_at ? ' (已揭晓,等对方)' : ''
    console.log(`${r.created_at}  ${r.status.padEnd(8)} 第${r.degree}度  ${r.peer_masked}: ${r.content}${waiting}  [${r.id}]`)
  }
}

export function cmdSocialPledges(stateDir: string, opts: SocialReadOpts): void {
  const rows = withDb(stateDir, db => makePledgeStore(db).list()).slice(0, opts.limit)
  if (opts.json) { console.log(JSON.stringify({ pledges: rows }, null, 2)); return }
  if (rows.length === 0) { console.log('还没有应答(no pledges)'); return }
  for (const r of rows) {
    const both = r.self_revealed_at && r.peer_revealed_at
    const state = both ? 'connected' : r.self_revealed_at ? '已揭晓,等对方' : r.peer_revealed_at ? '对方已揭晓,待你' : 'pending'
    console.log(`${r.created_at}  ${state}  ${r.topic}  [${r.id}]`)
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/cli/social.test.ts`
Expected: PASS (all, incl. the privacy lock).

- [ ] **Step 5: Gates + commit**

Run: `bun run typecheck` (clean) and `bun run depcheck` (no violations — proves
`src/cli/social.ts` imports only from `src/core/` + `src/lib/`, never `src/daemon/`).

```bash
git add src/cli/social.ts src/cli/social.test.ts
git commit -m "feat(cli): social read commands — seeks/echoes/pledges (echoes masked via toPublicEcho)"
```

---

## Task 2: `reveal` — daemon-backed, with echo→pledge fallback

**Files:**
- Modify: `src/cli/social.ts` (append)
- Test: `src/cli/social.test.ts` (append a describe)

**Interfaces:**
- Consumes: `STATE_DIR/internal-api-info.json` (`{ baseUrl, tokenFilePath }`),
  written by the daemon at start; the shipped routes
  `POST /v1/social/echoes/reveal` and `POST /v1/social/pledges/reveal`, each
  taking `{ id }` and returning `{ outcome: { state } }` on 200 or
  `{ error: 'not_found' }` on 404.
- Produces (Task 3 wires this): `cmdSocialReveal(stateDir: string, id: string, opts: { json: boolean }): Promise<void>`.
  It is **async** (does fetch) and **exits non-zero on failure** via the injected
  exit — see the deps note below.

> **Testability note (resolve this ambiguity as follows):** `mode set` in `cli.ts`
> calls `process.exit(1)` inline, which is untestable. Do NOT copy that part.
> Give `cmdSocialReveal` an optional deps parameter so tests inject a fake:
> `cmdSocialReveal(stateDir, id, opts, deps?: { fetch?: typeof fetch; readInfo?: () => { baseUrl: string; tokenFilePath: string } | null; readToken?: (p: string) => string; fail?: (msg: string) => never })`.
> Defaults use the real `fetch`, real fs reads, and a `fail` that prints + throws
> `new Error(msg)`; `cli.ts` (Task 3) catches and maps to `process.exit(1)`.

- [ ] **Step 1: Write the failing tests** — append to `src/cli/social.test.ts`:

```ts
describe('cmdSocialReveal', () => {
  const info = { baseUrl: 'http://127.0.0.1:9', tokenFilePath: '/tmp/tok' }
  const baseDeps = { readInfo: () => info, readToken: () => 'tokhex' }

  it('reveals an echo and prints the outcome state', async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ outcome: { state: 'connected' } }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialReveal('/nope', 'i1:ccb', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(calls[0]).toContain('/v1/social/echoes/reveal')
    expect(out.join('\n')).toContain('connected')
  })

  it('falls back to pledges/reveal when the echo route 404s', async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string) => {
      calls.push(String(url))
      return String(url).includes('/echoes/')
        ? new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
        : new Response(JSON.stringify({ outcome: { state: 'awaiting_peer' } }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialReveal('/nope', 'i9:cca', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(calls[0]).toContain('/echoes/reveal')
    expect(calls[1]).toContain('/pledges/reveal')
    expect(out.join('\n')).toContain('awaiting_peer')
  })

  it('fails clearly when neither route knows the id', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })) as unknown as typeof fetch
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdSocialReveal('/nope', 'bogus', { json: false }, { ...baseDeps, fetch: fakeFetch, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/没找到|not found/i)
  })

  it('fails clearly when the daemon is not running', async () => {
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdSocialReveal('/nope', 'i1:ccb', { json: false }, { readInfo: () => null, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/daemon/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/cli/social.test.ts`
Expected: the 4 new tests FAIL — `cmdSocialReveal` is not exported.

- [ ] **Step 3: Implement** — append to `src/cli/social.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RevealDeps {
  fetch?: typeof fetch
  readInfo?: () => { baseUrl: string; tokenFilePath: string } | null
  readToken?: (p: string) => string
  fail?: (msg: string) => never
}

/**
 * `reveal` cannot read the db directly: it performs A2A network calls and fires
 * notification beats, so it must go through the RUNNING daemon's internal-api —
 * same pattern as `mode set` in cli.ts. Echo-or-pledge is auto-detected exactly
 * like the WeChat 揭晓 command: try echoes/reveal, fall back on 404.
 */
export async function cmdSocialReveal(
  stateDir: string,
  id: string,
  opts: { json: boolean },
  deps: RevealDeps = {},
): Promise<void> {
  const doFetch = deps.fetch ?? fetch
  const fail = deps.fail ?? ((msg: string): never => { console.error(`social reveal: ${msg}`); throw new Error(msg) })
  const readInfo = deps.readInfo ?? (() => {
    const p = join(stateDir, 'internal-api-info.json')
    if (!existsSync(p)) return null
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { baseUrl?: string; tokenFilePath?: string }
      return parsed.baseUrl && parsed.tokenFilePath ? { baseUrl: parsed.baseUrl, tokenFilePath: parsed.tokenFilePath } : null
    } catch { return null }
  })
  const readToken = deps.readToken ?? ((p: string) => readFileSync(p, 'utf8').trim())

  const info = readInfo()
  if (!info) fail('daemon not running (internal-api-info.json missing or malformed — start the daemon first)')

  let token: string
  try { token = readToken(info!.tokenFilePath) }
  catch (err) { return void fail(`could not read token file: ${err instanceof Error ? err.message : String(err)}`) }

  async function post(path: string): Promise<Response> {
    return doFetch(`${info!.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify({ id }),
    })
  }

  let resp: Response
  try { resp = await post('/v1/social/echoes/reveal') }
  catch (err) { return void fail(`could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`) }

  // 404 ⇒ not an echo id; it may be a pledge (a wish of someone else I answered).
  if (resp.status === 404) {
    try { resp = await post('/v1/social/pledges/reveal') }
    catch (err) { return void fail(`could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`) }
    if (resp.status === 404) fail(`没找到「${id}」这条(既不是回声也不是应答,可能已过期或已牵线)`)
  }
  if (!resp.ok) fail(`daemon returned ${resp.status}`)

  const body = await resp.json() as { outcome?: { state?: string } }
  const state = body.outcome?.state ?? 'unknown'
  if (opts.json) { console.log(JSON.stringify({ ok: true, id, state })); return }
  const note = state === 'connected' ? '🤝 牵上线了'
    : state === 'awaiting_peer' ? '已揭晓,等对方回揭'
    : state === 'peer_unreachable' ? '揭晓已发出,但对面暂时够不着 — 可稍后重试(你的同意已保存)'
    : state
  console.log(`${state} — ${note}`)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/cli/social.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Gates + commit**

Run: `bun run typecheck` (clean), `bun run depcheck` (no violations).

```bash
git add src/cli/social.ts src/cli/social.test.ts
git commit -m "feat(cli): social reveal via internal-api with echo->pledge fallback"
```

---

## Task 3: Wire the `social` subcommand tree into `cli.ts`

**Files:**
- Modify: `cli.ts` (add the command tree + register it on the main command)
- Modify: `cli.ts` help text block (the usage list near `wechat-cc agent activity`)
- Test: `src/cli/cli-routes.test.ts` (it asserts the CLI's subcommand surface —
  read it first; extend its expected list)

**Interfaces:**
- Consumes: `cmdSocialSeeks` / `cmdSocialEchoes` / `cmdSocialPledges` /
  `cmdSocialReveal` from `./src/cli/social.ts` (Tasks 1-2).
- Produces: `wechat-cc social {seeks,echoes,pledges,reveal}`.

- [ ] **Step 1: Read the reference + the route test.** Read the `agentCmd` tree in
`cli.ts` (`const agentActivityCmd = defineCommand({...})` … `const agentCmd =
defineCommand({ subCommands: {...} })`) and how it is registered on the root
command's `subCommands`. Read `src/cli/cli-routes.test.ts` to see how the
subcommand surface is asserted.

- [ ] **Step 2: Write the failing route test** — extend `src/cli/cli-routes.test.ts`'s
expected-subcommand assertion to include `social` (match the file's existing
shape — if it lists subcommand names, add `'social'`).

Run: `bun run test src/cli/cli-routes.test.ts`
Expected: FAIL — `social` is not registered.

- [ ] **Step 3: Implement** — in `cli.ts`, add the tree next to `agentCmd` (all four
leaves + the parent), using lazy `await import` for the handler module exactly as
`agentActivityCmd` does:

```ts
// ── 觅食台 social surface — wechat-cc social {seeks,echoes,pledges,reveal} ──
// Reads go straight to the daemon's SQLite (work with the daemon down);
// reveal needs the running daemon (network + notify). See
// docs/superpowers/specs/2026-07-17-cli-social-surface-design.md.

const socialSeeksCmd = defineCommand({
  meta: { name: 'seeks', description: 'List my wishes (心愿) + status — newest first' },
  args: {
    limit: { type: 'string', description: 'Max rows (default 20)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const n = args.limit ? Number.parseInt(args.limit, 10) : 20
    const limit = Number.isFinite(n) && n > 0 ? n : 20
    const { cmdSocialSeeks } = await import('./src/cli/social.ts')
    cmdSocialSeeks(STATE_DIR, { limit, json: Boolean(args.json) })
  },
})

const socialEchoesCmd = defineCommand({
  meta: { name: 'echoes', description: 'List postcards that came back (回声) — masked until a mutual reveal' },
  args: {
    seek: { type: 'string', description: 'Only echoes for this wish (intent id)' },
    limit: { type: 'string', description: 'Max rows (default 20)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const n = args.limit ? Number.parseInt(args.limit, 10) : 20
    const limit = Number.isFinite(n) && n > 0 ? n : 20
    const { cmdSocialEchoes } = await import('./src/cli/social.ts')
    cmdSocialEchoes(STATE_DIR, { limit, json: Boolean(args.json), ...(args.seek ? { seek: args.seek } : {}) })
  },
})

const socialPledgesCmd = defineCommand({
  meta: { name: 'pledges', description: "List others' wishes I answered (应答) " },
  args: {
    limit: { type: 'string', description: 'Max rows (default 20)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const n = args.limit ? Number.parseInt(args.limit, 10) : 20
    const limit = Number.isFinite(n) && n > 0 ? n : 20
    const { cmdSocialPledges } = await import('./src/cli/social.ts')
    cmdSocialPledges(STATE_DIR, { limit, json: Boolean(args.json) })
  },
})

const socialRevealCmd = defineCommand({
  meta: { name: 'reveal', description: '揭晓 — reveal your side of an echo or pledge (calls the running daemon)' },
  args: {
    id: { type: 'positional', required: true, description: 'Echo id or pledge id', valueHint: 'id' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { cmdSocialReveal } = await import('./src/cli/social.ts')
    try {
      await cmdSocialReveal(STATE_DIR, args.id, { json: Boolean(args.json) })
    } catch {
      // cmdSocialReveal's default `fail` already printed the message.
      process.exit(1)
    }
  },
})

const socialCmd = defineCommand({
  meta: { name: 'social', description: '觅食台 — list wishes/echoes/pledges and reveal (揭晓)' },
  subCommands: {
    seeks: socialSeeksCmd,
    echoes: socialEchoesCmd,
    pledges: socialPledgesCmd,
    reveal: socialRevealCmd,
  },
})
```

Then register it on the root command's `subCommands` map alongside `agent:
agentCmd` — add `social: socialCmd,`.

- [ ] **Step 4: Add the usage lines** — in `cli.ts`'s help text block (near the
`wechat-cc agent activity <id> [--limit N]` line at ~`:157`), add:

```
  wechat-cc social seeks [--limit N] [--json]
  wechat-cc social echoes [--seek <id>] [--limit N] [--json]
  wechat-cc social pledges [--limit N] [--json]
  wechat-cc social reveal <id> [--json]
```

- [ ] **Step 5: Run + gates**

Run: `bun run test src/cli/cli-routes.test.ts src/cli/social.test.ts` → PASS.
Run: `bun run typecheck` (clean), `bun run depcheck` (clean).
Run the broad CLI + core suites once: `bun run test src/cli src/core` → green
(report totals).

- [ ] **Step 6: Commit**

```bash
git add cli.ts src/cli/cli-routes.test.ts
git commit -m "feat(cli): register the social subcommand tree + usage"
```

---

## Done-when
- `wechat-cc social seeks|echoes|pledges` print newest-first rows with the daemon
  stopped; `--json` parses; empty states print a note.
- `echoes` output contains no `peer_agent_id` / `relay_via` / `relay_token` in
  either mode (asserted).
- `wechat-cc social reveal <id>` reveals an echo, falls back to pledge on 404,
  errors clearly on unknown id / daemon down; prints the outcome state.
- `bun run test src/cli src/core` + typecheck + depcheck green.
