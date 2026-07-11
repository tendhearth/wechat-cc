# Connection-Owner Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each machine honestly answer "am I the one holding the single WeChat bot connection?" — via an on-demand probe, a truthful 3-state hero, and a last-activity heartbeat — replacing today's false-positive "已连接".

**Architecture:** A pure classifier maps an ilink `getUpdates` result to one of three connection states (`connected` / `recovering` / `taken_over`). A `connection probe` CLI command runs the classifier against the bound bot's real token (errcode `-14` = not this machine; reuses `markExpired`). The desktop hero stops deriving "connected" from `daemon.alive || accountCount>0` and instead reflects daemon liveness + expired state + probe result, with a「测试本机连接」button. A heartbeat (`lastUpdateOkAt`) recorded by the poll loop drives the "上次活动 X 前" line.

**Tech Stack:** TypeScript (bun), citty CLI, SQLite (`src/lib/db`), vanilla-JS desktop frontend, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-06-07-connection-owner-detection-design.md`

---

## File Structure

- `src/lib/ilink.ts` — **modify**: add optional `timeoutMs` to `ilinkGetUpdates` so the probe can use a short (5 s) long-poll cap instead of the 35 s default.
- `src/daemon/connection-probe.ts` — **create**: `classifyProbeResult()` (pure) + `probeConnection()` (runner with injected deps). One responsibility: turn an ilink call into a connection verdict.
- `src/daemon/connection-probe.test.ts` — **create**: unit tests for both.
- `cli.ts` — **modify**: add `connectionProbeCmd` + `connectionCmd`, register `connection:` in `SUBCOMMANDS`.
- `apps/desktop/src/view.js` — **modify**: rewrite `dashboardHero()` to return a 3-state verdict.
- `apps/desktop/src/view.test.ts` — **modify**: cover the 3 states.
- `apps/desktop/src/modules/dashboard.js` — **modify**: render the 3 states + drive the「测试本机连接」/「重新扫码绑定」affordances.
- `apps/desktop/src/index.html` — **modify**: add the `#dash-test-conn` button to the hero.
- `apps/desktop/src/main.js` — **modify**: wire `#dash-test-conn` click → invoke `connection probe` → refresh hero.
- `apps/desktop/src/mock.js` — **modify**: mock `connection probe` for browser/dev mode.
- `apps/desktop/test-shim.ts` — **modify**: same mock for the Playwright shim.
- `apps/desktop/playwright/overview.spec.ts` — **modify**: assert hero copy + button per state.
- `src/daemon/poll-loop.ts` — **modify**: record `lastUpdateOkAt` on each successful poll.
- `src/cli/doctor.ts` — **modify**: surface `lastUpdateOkAt` per account in the report.

---

## Task 1: Short-timeout option for `ilinkGetUpdates`

**Files:**
- Modify: `src/lib/ilink.ts:108-121`
- Test: `src/lib/ilink.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/ilink.test.ts`:

```ts
import { ilinkGetUpdates } from './ilink'

it('ilinkGetUpdates passes a custom timeoutMs through to the abort cap', async () => {
  let seenSignalAbortedFast = false
  const orig = globalThis.fetch
  // Fake fetch that never resolves until aborted; record how quickly abort fires.
  globalThis.fetch = ((_url: string, init: any) =>
    new Promise((_resolve, reject) => {
      const start = Date.now()
      init.signal.addEventListener('abort', () => {
        seenSignalAbortedFast = Date.now() - start < 1000
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })) as any
  try {
    const resp = await ilinkGetUpdates('https://x.test', 'tok', '', 200)
    expect(resp).toEqual({ ret: 0, msgs: [], get_updates_buf: '' })
    expect(seenSignalAbortedFast).toBe(true)
  } finally {
    globalThis.fetch = orig
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/ilink.test.ts`
Expected: FAIL — `ilinkGetUpdates` currently takes 3 args; the 4th is ignored so the abort waits 35 s and the test times out / `seenSignalAbortedFast` is false.

- [ ] **Step 3: Add the optional param**

In `src/lib/ilink.ts`, change the signature and the `ilinkPost` call:

```ts
export async function ilinkGetUpdates(baseUrl: string, token: string, buf: string, timeoutMs: number = LONG_POLL_TIMEOUT_MS): Promise<GetUpdatesResp> {
  try {
    const raw = await ilinkPost(baseUrl, 'ilink/bot/getupdates', {
      get_updates_buf: buf,
      base_info: ILINK_BASE_INFO,
    }, token, timeoutMs)
    return JSON.parse(raw) as GetUpdatesResp
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: buf }
    }
    throw err
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/ilink.test.ts`
Expected: PASS. Existing callers (3-arg) still compile because the param is defaulted.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ilink.ts src/lib/ilink.test.ts
git commit -m "feat(ilink): optional timeoutMs on ilinkGetUpdates for short probe polls"
```

---

## Task 2: `classifyProbeResult` — pure verdict function

**Files:**
- Create: `src/daemon/connection-probe.ts`
- Test: `src/daemon/connection-probe.test.ts`

The verdict union and classifier. `-14` (any of `errcode`/`ret`) → `taken_over`; thrown network error → `inconclusive`; anything else (incl. empty long-poll abort) → `connected`.

- [ ] **Step 1: Write the failing test**

Create `src/daemon/connection-probe.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { classifyProbeResult } from './connection-probe'

describe('classifyProbeResult', () => {
  it('errcode -14 → taken_over with the server errmsg', () => {
    expect(classifyProbeResult({ resp: { errcode: -14, errmsg: 'session timeout' } }))
      .toEqual({ state: 'taken_over', detail: 'session timeout' })
  })
  it('ret -14 (alt field) → taken_over', () => {
    expect(classifyProbeResult({ resp: { ret: -14 } }).state).toBe('taken_over')
  })
  it('empty successful poll → connected', () => {
    expect(classifyProbeResult({ resp: { ret: 0, msgs: [] } }).state).toBe('connected')
  })
  it('thrown network error → inconclusive carrying the message', () => {
    expect(classifyProbeResult({ error: new Error('fetch failed') }))
      .toEqual({ state: 'inconclusive', detail: 'fetch failed' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/daemon/connection-probe.test.ts`
Expected: FAIL with "Cannot find module './connection-probe'".

- [ ] **Step 3: Write the classifier**

Create `src/daemon/connection-probe.ts`:

```ts
/**
 * connection-probe.ts — answer "does THIS machine currently hold the ilink
 * bot connection?" by doing one short getUpdates and reading the result.
 *
 * The only ground-truth signal ilink gives is errcode=-14 ("session timeout"
 * — token rebound on another device). No -14 within the short poll window
 * means the server accepted our session (we are the live connection, or it
 * long-polled with nothing to send). See the design doc's "待验证" note on
 * multi-reader semantics.
 */
import type { GetUpdatesResp } from '../lib/ilink'

export type ConnectionState = 'connected' | 'taken_over' | 'inconclusive'

export interface ProbeVerdict {
  state: ConnectionState
  detail?: string
}

export function classifyProbeResult(input: { resp?: GetUpdatesResp; error?: unknown }): ProbeVerdict {
  if (input.error) {
    return { state: 'inconclusive', detail: input.error instanceof Error ? input.error.message : String(input.error) }
  }
  const resp = input.resp ?? {}
  if (resp.errcode === -14 || resp.ret === -14) {
    return { state: 'taken_over', ...(resp.errmsg ? { detail: resp.errmsg } : {}) }
  }
  return { state: 'connected' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/daemon/connection-probe.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/connection-probe.ts src/daemon/connection-probe.test.ts
git commit -m "feat(connection): classifyProbeResult — map getUpdates to a connection verdict"
```

---

## Task 3: `probeConnection` — run the probe against a bound account

**Files:**
- Modify: `src/daemon/connection-probe.ts`
- Test: `src/daemon/connection-probe.test.ts`

Injected deps make it unit-testable with no network and no real db. On `taken_over` it calls `markExpired` (same path the passive poll loop uses), keeping a single source of truth.

- [ ] **Step 1: Write the failing test**

Append to `src/daemon/connection-probe.test.ts`:

```ts
import { probeConnection, type ProbeDeps } from './connection-probe'

function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    account: { id: 'b-im-bot', botId: 'b@im.bot', baseUrl: 'https://x.test', token: 'tok' },
    getUpdates: async () => ({ ret: 0, msgs: [] }),
    markExpired: () => true,
    probeTimeoutMs: 5000,
    ...over,
  }
}

describe('probeConnection', () => {
  it('connected result does not mark expired', async () => {
    let marked = false
    const r = await probeConnection(deps({ markExpired: () => (marked = true) }))
    expect(r).toEqual({ id: 'b-im-bot', state: 'connected' })
    expect(marked).toBe(false)
  })
  it('-14 marks the bot expired and reports taken_over', async () => {
    let markedId = ''
    const r = await probeConnection(deps({
      getUpdates: async () => ({ errcode: -14, errmsg: 'session timeout' }),
      markExpired: (id) => { markedId = id; return true },
    }))
    expect(r).toEqual({ id: 'b-im-bot', state: 'taken_over', detail: 'session timeout' })
    expect(markedId).toBe('b-im-bot')
  })
  it('thrown error → inconclusive, does not mark expired', async () => {
    let marked = false
    const r = await probeConnection(deps({
      getUpdates: async () => { throw new Error('ECONNREFUSED') },
      markExpired: () => (marked = true),
    }))
    expect(r.state).toBe('inconclusive')
    expect(marked).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/daemon/connection-probe.test.ts`
Expected: FAIL — `probeConnection`/`ProbeDeps` not exported.

- [ ] **Step 3: Implement the runner**

Append to `src/daemon/connection-probe.ts`:

```ts
export interface ProbeAccount { id: string; botId: string; baseUrl: string; token: string }

export interface ProbeDeps {
  account: ProbeAccount
  /** Bound to ilinkGetUpdates(baseUrl, token, '', timeoutMs) by the caller. */
  getUpdates: (baseUrl: string, token: string, timeoutMs: number) => Promise<GetUpdatesResp>
  /** Reuse SessionStateStore.markExpired — single source of truth with the poll loop. */
  markExpired: (botId: string, reason?: string) => boolean
  probeTimeoutMs: number
}

export interface ProbeResult { id: string; state: ConnectionState; detail?: string }

export async function probeConnection(deps: ProbeDeps): Promise<ProbeResult> {
  const { account } = deps
  let verdict: ProbeVerdict
  try {
    const resp = await deps.getUpdates(account.baseUrl, account.token, deps.probeTimeoutMs)
    verdict = classifyProbeResult({ resp })
  } catch (error) {
    verdict = classifyProbeResult({ error })
  }
  if (verdict.state === 'taken_over') {
    deps.markExpired(account.botId, `connection probe errcode=-14: ${verdict.detail ?? ''}`)
  }
  return { id: account.id, state: verdict.state, ...(verdict.detail ? { detail: verdict.detail } : {}) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/daemon/connection-probe.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/connection-probe.ts src/daemon/connection-probe.test.ts
git commit -m "feat(connection): probeConnection runner — marks expired on -14"
```

---

## Task 4: `connection probe` CLI command

**Files:**
- Modify: `cli.ts` (near `accountCmd` ~1012 for definition; `SUBCOMMANDS` ~1855 for registration)
- Test: `cli.test.ts`

Reads bound accounts (same dir-walk the daemon uses: `STATE_DIR/accounts/<id>/{account.json,token}`), probes each, prints JSON `{ accounts: ProbeResult[] }`. Marks expired through the daemon's SQLite store so the dashboard's `expiredBots` reflects it on next doctor poll.

- [ ] **Step 1: Write the failing test**

Add to `cli.test.ts` (follow the existing spawn-based pattern in that file; mirror how other `--json` commands are asserted):

```ts
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

describe('connection probe CLI', () => {
  it('prints a JSON envelope with an accounts array', () => {
    const r = spawnSync('bun', ['cli.ts', 'connection', 'probe', '--json'], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, WECHAT_CC_STATE_DIR: '/tmp/wechat-cc-probe-empty' },
    })
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(Array.isArray(out.accounts)).toBe(true)
  })
})
```

(Note: `WECHAT_CC_STATE_DIR` points at an empty dir so no real network call fires — the accounts list is empty and the command returns `{accounts: []}`. Confirm the env var name matches `src/lib/config.ts STATE_DIR`; if the override var differs, use that one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test cli.test.ts -t "connection probe"`
Expected: FAIL — `connection` is not a known subcommand (citty exits non-zero / prints usage).

- [ ] **Step 3: Implement the command**

In `cli.ts`, near the other `defineCommand`s, add:

```ts
const connectionProbeCmd = defineCommand({
  meta: { name: 'probe', description: 'Test whether THIS machine holds the live WeChat connection' },
  args: { json: { type: 'boolean', description: 'machine-readable output' } },
  async run({ args }) {
    const { STATE_DIR } = await import('./src/lib/config')
    const { ilinkGetUpdates } = await import('./src/lib/ilink')
    const { probeConnection } = await import('./src/daemon/connection-probe')
    const { openWechatDb } = await import('./src/lib/db')
    const { makeSessionStateStore } = await import('./src/daemon/session-state')
    const { readFileSync, existsSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')

    const dir = join(STATE_DIR, 'accounts')
    const ids = existsSync(dir) ? readdirSync(dir).filter(n => !n.includes('.superseded.')) : []
    const db = openWechatDb()
    const store = makeSessionStateStore(db)
    const PROBE_TIMEOUT_MS = 5000
    const accounts = []
    try {
      for (const id of ids) {
        const acctDir = join(dir, id)
        const metaPath = join(acctDir, 'account.json')
        const tokenPath = join(acctDir, 'token')
        if (!existsSync(metaPath) || !existsSync(tokenPath)) continue
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
        const token = readFileSync(tokenPath, 'utf8').trim()
        const result = await probeConnection({
          account: { id, botId: meta.botId, baseUrl: meta.baseUrl, token },
          getUpdates: (baseUrl, tok, timeoutMs) => ilinkGetUpdates(baseUrl, tok, '', timeoutMs),
          markExpired: (botId, reason) => store.markExpired(botId, reason),
          probeTimeoutMs: PROBE_TIMEOUT_MS,
        })
        accounts.push(result)
      }
    } finally {
      db.close()
    }
    const out = { accounts }
    if (args.json) console.log(JSON.stringify(out, null, 2))
    else for (const a of accounts) console.log(`${a.id}: ${a.state}${a.detail ? ` (${a.detail})` : ''}`)
  },
})

const connectionCmd = defineCommand({
  meta: { name: 'connection', description: 'Inspect this machine\'s WeChat connection' },
  subCommands: { probe: connectionProbeCmd },
})
```

Then register it in the `SUBCOMMANDS` object (~line 1855, alongside `account: accountCmd`):

```ts
  connection: connectionCmd,
```

(Verify `openWechatDb` closes cleanly — see the Windows EBUSY note in project memory: always `db.close()`. The `finally` block above does this.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test cli.test.ts -t "connection probe"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli.ts cli.test.ts
git commit -m "feat(cli): connection probe — on-demand check of this machine's WeChat connection"
```

---

## Task 5: Rewrite `dashboardHero` to a 3-state verdict (修假绿)

**Files:**
- Modify: `apps/desktop/src/view.js:330-353`
- Test: `apps/desktop/src/view.test.ts`

New contract: `dashboardHero({ daemonAlive, accountCount, expiredCount, lastProbe })` → `{ state, tone, headline, meta }` where `state ∈ 'connected'|'recovering'|'taken_over'`. Rules, in order:
1. `lastProbe?.state === 'taken_over'` OR `expiredCount > 0` → `taken_over`.
2. `lastProbe?.state === 'connected'` OR (`daemonAlive` AND `accountCount > 0`) → `connected`.
3. otherwise → `recovering`.

This kills the worst false-positive: a bound account with **no running daemon** is no longer "connected" — it falls to `recovering`. An expired/taken-over account is surfaced honestly.

- [ ] **Step 1: Write the failing test**

Replace the existing `dashboardHero` tests in `apps/desktop/src/view.test.ts` (search for `dashboardHero(`) with:

```ts
describe('dashboardHero 3-state', () => {
  it('daemon alive + accounts, no expiry → connected', () => {
    const h = dashboardHero({ daemonAlive: true, accountCount: 1, expiredCount: 0 })
    expect(h.state).toBe('connected')
    expect(h.tone).toBe('ok')
  })
  it('bound account but daemon NOT alive → recovering (was falsely "connected")', () => {
    const h = dashboardHero({ daemonAlive: false, accountCount: 1, expiredCount: 0 })
    expect(h.state).toBe('recovering')
    expect(h.tone).not.toBe('ok')
  })
  it('expired account → taken_over regardless of daemon', () => {
    const h = dashboardHero({ daemonAlive: true, accountCount: 1, expiredCount: 1 })
    expect(h.state).toBe('taken_over')
  })
  it('probe verdict taken_over wins even with no expiry recorded yet', () => {
    const h = dashboardHero({ daemonAlive: true, accountCount: 1, expiredCount: 0, lastProbe: { state: 'taken_over' } })
    expect(h.state).toBe('taken_over')
  })
  it('probe verdict connected promotes a daemon-down machine', () => {
    const h = dashboardHero({ daemonAlive: false, accountCount: 1, expiredCount: 0, lastProbe: { state: 'connected' } })
    expect(h.state).toBe('connected')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun run test src/view.test.ts -t "dashboardHero"`
Expected: FAIL — old signature `dashboardHero(daemon, accountCount)` returns `{headline:'running'...}` with no `.state`.

- [ ] **Step 3: Rewrite the function**

Replace `apps/desktop/src/view.js:330-353` with:

```js
// Connection verdict for the overview hero. Three honest states:
//   connected   — this machine holds the live WeChat connection
//   recovering  — transient: daemon down / not yet polling (auto-recovers)
//   taken_over  — terminal: another device rebound the bot (errcode=-14);
//                 needs a re-scan to reclaim, does NOT self-heal.
// Inputs come from the doctor report + the last probe result (if any).
export function dashboardHero({ daemonAlive, accountCount, expiredCount = 0, lastProbe = null }) {
  if (lastProbe?.state === 'taken_over' || expiredCount > 0) {
    return { state: 'taken_over', tone: 'warn', headline: '本机未连接', meta: '连接在其他设备 · 重新扫码可接管' }
  }
  if (lastProbe?.state === 'connected' || (daemonAlive && accountCount > 0)) {
    return { state: 'connected', tone: 'ok', headline: 'AI 正在陪伴中', meta: '连接正常' }
  }
  return { state: 'recovering', tone: 'warn', headline: '暂时失联', meta: '正在恢复连接…' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && bun run test src/view.test.ts -t "dashboardHero"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/view.js apps/desktop/src/view.test.ts
git commit -m "feat(desktop): dashboardHero 3-state verdict — kill false 'connected'"
```

---

## Task 6: Render the 3 states in the dashboard hero

**Files:**
- Modify: `apps/desktop/src/modules/dashboard.js:13-25` (`renderDashboard`) and `:149-180` (`renderRestartButton`)

`renderDashboard` calls `dashboardHero` with the new object and uses the returned `headline`/`meta` directly (no more inline ternary copy). It also stashes the latest probe on a module slot so the next render keeps the verdict. Button visibility: `taken_over` shows「重新扫码绑定」(routes to wizard bind); `recovering` shows restart; `connected` shows stop.

- [ ] **Step 1: Update `renderDashboard` hero block**

Replace `apps/desktop/src/modules/dashboard.js:14-25` with:

```js
  const expiredCount = (report.expiredBots || []).length
  const hero = dashboardHero({
    daemonAlive: !!report.checks.daemon.alive,
    accountCount: report.checks.accounts.count,
    expiredCount,
    lastProbe: _lastProbe,
  })
  const card = document.getElementById("hero-card")
  if (!card) return
  card.classList.toggle("warn", hero.tone !== "ok")
  document.getElementById("hero-headline").textContent = hero.headline
  document.getElementById("hero-meta").textContent = hero.meta
  const stopBtn = document.getElementById("dash-stop")
  const restartBtn = document.getElementById("dash-restart")
  const rebindBtn = document.getElementById("dash-rebind")
  if (stopBtn) stopBtn.hidden = hero.state !== "connected"
  if (restartBtn) restartBtn.hidden = hero.state !== "recovering"
  if (rebindBtn) rebindBtn.hidden = hero.state !== "taken_over"
```

- [ ] **Step 2: Add the `_lastProbe` module slot**

Near the other module-level `let _…` slots in `dashboard.js` (e.g. by `let _lastRestart = null`), add:

```js
// Latest connection-probe verdict ({ state, detail } | null). Set by the
// 「测试本机连接」button handler (main.js), read on the next renderDashboard
// so the hero keeps the probe result across the 5 s doctor tick.
export let _lastProbe = null
export function setLastProbe(p) { _lastProbe = p }
```

(Export the setter so `main.js` can push the probe result in. Reset it to `null` in `__resetDiagnoseCardState()` so tests don't leak state.)

- [ ] **Step 3: Update `renderRestartButton` to the new signature**

In `renderRestartButton` (`dashboard.js:152`), replace the `dashboardHero(...)` call and `showOnlineControls`:

```js
  const hero = dashboardHero({
    daemonAlive: !!report.checks.daemon?.alive,
    accountCount: report.checks.accounts?.count ?? 0,
    expiredCount: (report.expiredBots || []).length,
    lastProbe: _lastProbe,
  })
  const showOnlineControls = hero.state === "connected"
```

Keep the rest of that function unchanged (it already hides/shows `#dash-restart` and `#dash-stop` from `showOnlineControls` and `btn.hidden = showOnlineControls`).

- [ ] **Step 4: Run the desktop unit suite**

Run: `cd apps/desktop && bun run test`
Expected: PASS. (If a `renderDashboard`/`renderRestartButton` test asserted the old copy, update it to the new headline/meta.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/modules/dashboard.js
git commit -m "feat(desktop): render 3-state hero + rebind affordance on takeover"
```

---

## Task 7: 「测试本机连接」button + wiring

**Files:**
- Modify: `apps/desktop/src/index.html` (hero controls — near `#dash-stop`/`#dash-restart`)
- Modify: `apps/desktop/src/main.js` (wire the click)

- [ ] **Step 1: Add the buttons to the hero**

In `apps/desktop/src/index.html`, next to the existing `#dash-stop` / `#dash-restart` buttons in the hero card, add:

```html
<button id="dash-test-conn" class="btn ghost">测试本机连接</button>
<button id="dash-rebind" class="btn" hidden>重新扫码绑定</button>
```

- [ ] **Step 2: Wire the click in `main.js`**

In `apps/desktop/src/main.js`, where other dashboard buttons are wired (search for `dash-restart` / `dash-stop` `addEventListener`), add:

```js
document.getElementById("dash-test-conn")?.addEventListener("click", async () => {
  const btn = document.getElementById("dash-test-conn")
  btn.disabled = true
  btn.textContent = "测试中…"
  try {
    const res = await invoke("wechat_cli_json", { args: ["connection", "probe", "--json"] })
    const parsed = typeof res === "string" ? JSON.parse(res) : res
    // Verdict precedence: any taken_over wins, else any connected, else inconclusive.
    const states = (parsed.accounts || []).map(a => a.state)
    const verdict = states.includes("taken_over") ? "taken_over"
      : states.includes("connected") ? "connected" : "inconclusive"
    setLastProbe(verdict === "inconclusive" ? null : { state: verdict })
    setPending(verdict === "taken_over" ? "本机未连接：连接在其他设备"
      : verdict === "connected" ? "本机已连接 ✓" : "网络异常，稍后重试")
    setTimeout(() => setPending(""), 3000)
    await doctorPoller.refresh()
  } catch (err) {
    setPending(`测试失败：${formatInvokeError(err)}`)
    setTimeout(() => setPending(""), 3000)
  } finally {
    btn.disabled = false
    btn.textContent = "测试本机连接"
  }
})

document.getElementById("dash-rebind")?.addEventListener("click", () => routeToWizardBind())
```

(Use the same `invoke`, `setPending`, `setLastProbe`, `doctorPoller`, `formatInvokeError`, `routeToWizardBind` references already in scope in `main.js`. Import `setLastProbe` from `./modules/dashboard.js` alongside the existing dashboard imports.)

- [ ] **Step 3: Manual smoke via dev-server**

Run (dev-server already serves mock mode):
```bash
node -e "/* reuse /tmp/shot4173.mjs pattern: goto 4173, click #dash-test-conn, screenshot */"
```
Expected: button exists, clicking shows a pending toast. (Real assertion lives in Task 10's Playwright spec; this is just a sanity check.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/index.html apps/desktop/src/main.js
git commit -m "feat(desktop): 测试本机连接 button + rebind button wiring"
```

---

## Task 8: Heartbeat — record & display `lastUpdateOkAt`

**Files:**
- Modify: `src/daemon/poll-loop.ts:300-303` (on successful poll)
- Modify: `src/cli/doctor.ts` (surface per-account `lastUpdateOkAt`)
- Modify: `apps/desktop/src/modules/dashboard.js` (show "上次活动 X 前" in the connected current-user card)

Store the heartbeat in the existing SQLite db so the separate doctor CLI process can read it. Add a tiny table.

- [ ] **Step 1: Add a heartbeat table + store helpers (test-first)**

Create `src/daemon/connection-heartbeat.ts` with `makeHeartbeatStore(db)` exposing `recordOk(botId, iso)` and `lastOk(botId): string | null`, backed by `connection_heartbeat(bot_id TEXT PRIMARY KEY, last_update_ok_at TEXT)`. Mirror the prepared-statement style of `session-state.ts`. Add the `CREATE TABLE IF NOT EXISTS` to the same migration path that creates `session_state` (find it via `grep -rn "session_state(" src/lib`). Write `src/daemon/connection-heartbeat.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { openWechatDb } from '../lib/db'
import { makeHeartbeatStore } from './connection-heartbeat'

describe('heartbeat store', () => {
  it('records and reads back the last ok timestamp; null when unknown', () => {
    const db = openWechatDb(':memory:')
    const s = makeHeartbeatStore(db)
    expect(s.lastOk('b@im.bot')).toBeNull()
    s.recordOk('b@im.bot', '2026-06-07T01:00:00.000Z')
    expect(s.lastOk('b@im.bot')).toBe('2026-06-07T01:00:00.000Z')
    db.close()
  })
})
```

Run: `bun run test src/daemon/connection-heartbeat.test.ts` → FAIL then implement → PASS. (Confirm `openWechatDb(':memory:')` is supported; if it requires a path, use a tmp file and clean up.)

- [ ] **Step 2: Record on successful poll**

In `src/daemon/poll-loop.ts`, in the success branch after `if (resp.sync_buf !== undefined) { syncBuf = resp.sync_buf }` (~line 301), add a heartbeat write through an injected `recordOk` dep (thread it through the loop's deps object like the existing `ilink` dep). Add a unit assertion in `src/daemon/poll-loop.test.ts` that a successful `getUpdates` calls `recordOk(account.botId, <iso>)` and an `expired` result does not.

- [ ] **Step 3: Surface in the doctor report**

In `src/cli/doctor.ts`, extend each `accounts.items` entry (or add a parallel `heartbeats: Record<botId, string>` field on `DoctorReport`) read via a new `deps.readHeartbeats()` that opens the db and calls `lastOk` per account. Update the `DoctorOutput` zod schema accordingly. Add a doctor test asserting the field is present (may be `null`).

- [ ] **Step 4: Display in the connected card**

In `apps/desktop/src/modules/dashboard.js`, in the `currentSub` computation (`:56-59`), when the hero state is `connected` and a heartbeat exists, render `连接正常 · 上次活动 ${formatRelativeTime(hb)}`; otherwise keep `已连接`. Do NOT show a stale heartbeat in `taken_over`/`recovering`.

- [ ] **Step 5: Run suites + commit**

Run: `bun run test && cd apps/desktop && bun run test`
Expected: PASS.
```bash
git add src/daemon/connection-heartbeat.ts src/daemon/connection-heartbeat.test.ts src/daemon/poll-loop.ts src/daemon/poll-loop.test.ts src/cli/doctor.ts apps/desktop/src/modules/dashboard.js
git commit -m "feat(connection): lastUpdateOkAt heartbeat — record on poll, show 上次活动"
```

---

## Task 9: Mock + shim support for `connection probe`

**Files:**
- Modify: `apps/desktop/src/mock.js`
- Modify: `apps/desktop/test-shim.ts`

So browser/dev mode and Playwright can exercise the button without a real bot.

- [ ] **Step 1: Add the mock branch**

In `apps/desktop/src/mock.js`, alongside the other `command === "wechat_cli_json"` branches, add:

```js
if (command === "wechat_cli_json" && args.args?.[0] === "connection" && args.args?.[1] === "probe") {
  // Dev/browser mock: pretend this machine is NOT the owner so the takeover
  // UI is exercisable. Override per-test in the shim.
  return { accounts: [{ id: "mock-bot", state: "taken_over", detail: "session timeout" }] }
}
```

- [ ] **Step 2: Mirror in the shim**

In `apps/desktop/test-shim.ts`, add the same `connection probe` response (follow how the shim already dispatches `wechat_cli_json` args). Make the state overridable via an env or seeded field if the shim supports per-test seeding (check existing seed mechanism).

- [ ] **Step 3: Sanity check dev-server**

Reload `http://127.0.0.1:4173` headless, click `#dash-test-conn`, confirm hero flips to「本机未连接」. (Formalized in Task 10.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/mock.js apps/desktop/test-shim.ts
git commit -m "test(desktop): mock connection probe for dev + shim"
```

---

## Task 10: Playwright — hero states + button

**Files:**
- Modify: `apps/desktop/playwright/overview.spec.ts`

- [ ] **Step 1: Write the specs**

Add to `apps/desktop/playwright/overview.spec.ts` (follow the file's existing fixture/seed pattern):

```ts
test('test-connection button is present on the overview hero', async ({ page }) => {
  await gotoOverview(page) // use the spec's existing navigation helper
  await expect(page.locator('#dash-test-conn')).toBeVisible()
})

test('probe verdict taken_over flips hero to 本机未连接 + shows rebind', async ({ page }) => {
  await gotoOverview(page)
  await page.locator('#dash-test-conn').click()
  await expect(page.locator('#hero-headline')).toHaveText('本机未连接')
  await expect(page.locator('#dash-rebind')).toBeVisible()
})
```

(The shim mock from Task 9 returns `taken_over`, so the second assertion holds. If the shim is seeded `connected` by default for the overview fixture, override the probe response for this test or adjust the expectation.)

- [ ] **Step 2: Run the browser e2e**

Run: `cd apps/desktop && bun run test:e2e:browser overview.spec.ts`
Expected: PASS.

- [ ] **Step 3: Full regression**

Run: `cd apps/desktop && bun run test:e2e:browser`
Expected: all specs PASS (confirm the hero-copy change didn't break other overview assertions; update any that asserted the old "AI 正在陪伴中 / 一切正常，连接稳定" pairing).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/playwright/overview.spec.ts
git commit -m "test(desktop): e2e for 3-state hero + test-connection button"
```

---

## Task 11: Verify whole feature + typecheck

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: no errors (per project memory, vitest alone won't catch missing interface fields — this is the gate that does).

- [ ] **Step 2: Full unit + e2e**

Run: `bun run test && cd apps/desktop && bun run test && bun run test:e2e:browser`
Expected: all PASS.

- [ ] **Step 3: Live validation (manual, documents the open caveat)**

On a **non-owner** machine: `bun cli.ts connection probe --json` → expect a `taken_over` account (matches the 2026-06-07 spec evidence: errcode -14 in ~1.6 s). On the **owner** machine (company computer): same command → expect `connected`. Record the owner-side result in the spec's "待验证" section to close the multi-reader caveat.

- [ ] **Step 4: Final commit (if any cleanup)**

```bash
git add -A && git commit -m "chore(connection): typecheck + verification pass"
```

---

## Self-Review Notes

- **Spec coverage:** 3-state model (Task 5/6) ✓; active probe button (Task 7) + CLI (Task 4) ✓; 修假绿 (Task 5/6, daemon-down no longer green) ✓; heartbeat (Task 8) ✓; terminal-state short copy「本机未连接 · 连接在其他设备 · 重新扫码可接管」(Task 5) ✓; reuse `markExpired` single source of truth (Task 3) ✓; stop auto-probing / terminal (no timer added; only manual probe + passive loop) ✓; open multi-reader validation (Task 11 Step 3) ✓.
- **Type consistency:** `ConnectionState`, `ProbeVerdict`, `ProbeResult`, `ProbeDeps`, `dashboardHero({...})`, `setLastProbe`/`_lastProbe` used consistently across tasks.
- **Known soft spots to confirm during execution (not placeholders — explicit verifications):** exact `STATE_DIR` override env var name (Task 4 Step 1); the migration site that creates `session_state` for adding the heartbeat table (Task 8 Step 1); `openWechatDb(':memory:')` support (Task 8 Step 1); the overview spec's existing nav/seed helper names (Task 10).
