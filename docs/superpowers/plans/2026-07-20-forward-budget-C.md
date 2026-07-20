# 中间人转发预算 (sub-project C) — Per-Sender Forward Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is a TDD unit: failing test → run-fail → minimal impl → run-pass → commit.

**Goal:** Give the intermediary (介绍人 / W)'s existing forwarding a quantity gate. Today's forward heart (`makeForwarder`, spec #2) already blocks loops (hop cap ≤2, never-forward-to-sender, seen-intent dedup) but nothing bounds how many *distinct* intents one upstream sender can push through W — a single friend (or a compromised friend CC) can flood W with 1000 different seeks and turn it into a free broadcast amplifier. C adds a **per-sender token-bucket forward budget**: each upstream sender gets N forwards/hour (default 30); once spent, W still judges + answers locally but stops amplifying — **silently**, with no signal back to the sender (fail-closed, no reputation, no metrics surface). The budget is **shared** across W's two forward-causing paths (seek-forwarder + letter-relay fallback) via one injected instance, so a sender's total amplification through W is capped regardless of which path they use. See `docs/superpowers/specs/2026-07-20-forward-budget-C-design.md` (§3 design, §4 seams, §6 phasing, §7 non-goals) and the parent `docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md` §7 (three-layer anti-abuse: real-friend gate → **this budget** → per-endpoint filtering [deferred]).

**Architecture:** One new daemon-core primitive + two small edits to existing consume points + one new wiring seam.
1. **`src/core/forward-budget.ts`** (new): `makeForwardBudget({perSender, windowMs, now?})` → `{ withinBudget(senderId): boolean }`. A per-key (`Map<senderId, {tokens, ts}>`) token bucket, refilling `perSender` tokens over `windowMs`, capped at capacity, never negative. It mirrors `relay/rate-limit.ts`'s `makeRateLimiter` *shape* (same Map/refill/cap-clamp math) but is an **independent copy living in daemon core** — it does NOT import from `relay/`. Note: this is NOT a lint/depcheck constraint — `.dependency-cruiser.cjs` has no src→relay rule, and `relay/*.ts` is under the same `tsconfig` so a cross-import would typecheck and depcheck clean. The real reason is deployment topology: `relay/` is a **separately-deployed standalone process** (its own Bun entrypoint, deployed to a VPS — see `relay/README.md`), so the daemon must not runtime-couple to `relay/` code even though nothing currently stops it at the tooling level. Unlike `relay/rate-limit.ts`'s `allow(key, now)` (time passed per call), C's `withinBudget(senderId)` takes no `now` argument — the clock is injected ONCE at construction via `opts.now ?? Date.now` (same closure-clock idiom as `src/daemon/activity/store.ts`), so production call sites stay simple and only tests thread a fake clock.
2. **Two consume points**, both gated the same way: `src/core/social-forwarder.ts`'s `makeForwarder` (the seek-forward main amplification path) gains an **optional** `ForwarderDeps.withinBudget?(senderId): boolean`, checked right after the existing `alreadySeen || hop>=cap` early-return and before the fan-out loop — over budget → return the local `receipt`, skip `forwardSend` entirely. `src/core/penpal-relay-letter.ts`'s `makeLetterRelay` (the letter-relay push-only fallback) gains the same **optional** `LetterRelayDeps.withinBudget?(senderId): boolean`, replacing the `// TODO(sub-project C)` line — over budget → `{ok:false, error:'unknown_channel'}` (the SAME response `routeLetter` already returns for "no matching relay leg" — see Global Constraints LOCKED #2 for why it is deliberately NOT a distinct `'over_budget'` string), `postLetter` never called. Both default to allow-all when the dep is omitted (see Global Constraints — this is the resolved optional-vs-required question).
3. **Wiring seam**: `src/daemon/bootstrap/forward-budget-seam.ts` (new) — `buildSharedForwardBudget(config, log, deps?)` constructs exactly ONE `makeForwardBudget` (sized from `resolveForwardBudget(config)`, a new `agent-config.ts` helper that reads `config.forward_budget ?? {per_sender:30, window_ms:3_600_000}`) and returns ONE `withinBudget` closure that also emits the required local log line on refusal. `wire-social.ts` calls this once and passes the SAME closure into both `makeForwarder({..., withinBudget})` and `makeLetterRelay({..., withinBudget})` — this is what makes the budget shared. The seam is its own tiny testable unit (same pattern as the existing `postletter-route.ts` / `mailbox-dispatch-seam.ts`), so the "shared bucket" property is asserted directly without having to invoke the whole (heavy, un-unit-tested-as-a-whole) `wireSocial()`.

**Tech Stack:** TypeScript, Bun runtime, Vitest (`bun run test <path>` — NOT `bun test`). No new dependency. In-memory only (`Map`, resets on daemon restart — accepted v0, same posture as `relay/rate-limit.ts`).

## Global Constraints

### LOCKED design decisions (copied verbatim from the brief + spec — do NOT re-litigate)

1. **`src/core/forward-budget.ts`**: `makeForwardBudget(opts: { perSender: number; windowMs: number; now?: () => number })` → `{ withinBudget(senderId: string): boolean }`. Token bucket per senderId (in-memory `Map`), refill = `perSender` tokens over `windowMs`, time via `opts.now ?? Date.now`. Clock is injected ONCE at construction (closure), NOT passed per-call — the test drives time by mutating a `let t` captured by the injected `now` closure. Cap-to-capacity (`Math.min(perSender, ...)`), `Math.max(0, refill)` (no negative refill on a backwards clock). NO new dependency. Lives in daemon core (`src/core/`), does NOT import from `relay/`.
2. **Over-budget = silent local-only**: forwarder → return the local `receipt`, no fan-out, `forwardSend` never called; relay-letter → `postLetter` never called. **NO signal to the sender** — this is enforced on the wire, not just in intent: `src/core/a2a-server.ts`'s `/a2a/letter` route echoes `onLetter`'s full result verbatim back to the caller over HTTP 200 (~lines 416-419), so the letter path's over-budget response MUST be `{ok:false, error:'unknown_channel'}` — byte-identical to the response `routeLetter` already returns for "no matching relay leg" — and must NOT use a distinct `error:'over_budget'` string (that would let a flooder read the throttle straight off the response). The forwarder path needs no equivalent disguise: its over-budget `receipt` is already indistinguishable from a legitimate no-downstream-match. A local log line only, emitted by the wiring seam (not by the pure core modules, and never put on the wire): `[forward-budget] over budget for <senderId>, local-only`.
3. **Shared budget**: ONE `makeForwardBudget` instance (wrapped once by `buildSharedForwardBudget`) injected into BOTH consume points → a sender's seek-forwards and letter-forwards draw from the SAME per-sender bucket. Task 5's wiring-seam test asserts this directly: exhaust via one simulated call path, the other simulated call path is then also refused for that sender.
4. **Config**: `AgentConfig.forward_budget?` optional `{ per_sender: number; window_ms: number }`, additive (zod `.optional()`, no `.default()` on the schema — mirrors `a2a_listen?`/`mailbox_relays?`, NOT the always-present-with-default style of `autoStart`/`closeStopsDaemon`). Absent → the field loads as `undefined`; the **default `{per_sender: 30, window_ms: 3_600_000}` (30/hour) is applied by a new `resolveForwardBudget(config)` helper in `agent-config.ts`**, consumed by the wiring seam — not baked into the parsed config object. This keeps the field genuinely optional/additive (no existing config's shape changes) while still giving "default 30/hour" one canonical, directly-testable home.
5. **In-memory** (resets on restart — accepted v0).

### RESOLVED: `withinBudget` is OPTIONAL on both `ForwarderDeps` and `LetterRelayDeps`, defaulting to allow-all

The brief asked us to pick between (a) optional-defaulting-to-allow-all, or (b) required + update every existing test construction. **Chosen: (a), optional.** Evidence from the real test suite (read before deciding):
- `src/core/social-forwarder.test.ts` constructs `makeForwarder({...})` **7 times** without `withinBudget`.
- `src/core/social-m1.e2e.test.ts` constructs it again (line ~199), also without `withinBudget`.
- `src/core/penpal-relay-letter.test.ts` constructs `makeLetterRelay({...})` **3 times** without `withinBudget`.
- `src/core/penpal.e2e.test.ts` constructs it again (line ~320), also without `withinBudget`.

That's 12 existing call sites across 4 files that would all need editing under the "required" option, for zero behavioral gain (every one of them exercises loop-prevention / dedup / fan-out logic that has nothing to do with the budget — they'd all just pass `withinBudget: () => true` to restore today's behavior, which is exactly what defaulting to allow-all gives for free). Optional-defaulting-to-allow-all is strictly additive: it touches zero existing test files, matches the interface's own existing `hopCap?: number` (defaults to `2` via `deps.hopCap ?? 2`) precedent in the very same file, and keeps the "no transient red window" guarantee trivial — nothing about the new field can break an existing caller because absence is a legal, fully-supported state. This is stated once here and does not need to be re-decided per task.

### Scope guard (v0 sub-project C ONLY — explicitly OUT; leave a note, no seam needed)

- NO global-W ceiling (v1 backstop).
- NO receiver/endpoint filtering (spec §7 layer 3, separate concern — low-disturbance curation partially covers it already).
- NO persisted budget counters (in-memory v0 accepted; restart resets, attacker cannot force a restart, hop≤2 bounds blast radius regardless).
- NO throttle signal to the sender / metrics surface (§2 fail-closed principle + YAGNI).
- NO per-key `Map` eviction (v0-accepted, same as `relay/rate-limit.ts` today).
- NO new npm dependency.

### Gates — no silent red

- Every task states which gate(s) it must pass: `bun run test <path>` (vitest — NOT `bun test`), `bun run typecheck` (`tsc --noEmit`), `bun run depcheck` (`depcruise --config .dependency-cruiser.cjs src cli.ts setup.ts docs.ts log-viewer.ts` — MUST stay green: no new dependency). Note: `depcheck` has no rule against `src/` importing `relay/*` (`.dependency-cruiser.cjs` doesn't forbid it, and `relay/*.ts` shares the project's `tsconfig`, so such an import would typecheck/depcheck clean) — "never import `relay/*` from `src/core/forward-budget.ts` / `src/daemon/bootstrap/forward-budget-seam.ts`" is a DESIGN rule enforced by review, not something a gate command catches. It matters because `relay/` is a separately-deployed standalone process (own entrypoint, its own VPS deploy — see `relay/README.md`), not because tooling would flag it.
- Do NOT touch `apps/desktop/**` or `main.js` (the Electron app).
- Do NOT regress sub-project A/B or the existing social suites. Every change in this plan is ADDITIVE (new optional interface field, new optional config field, new files) — **there is no transient typecheck-red window**; every task's commit leaves `test` + `typecheck` + `depcheck` all green. See the "RESOLVED: optional" section above for why existing `makeForwarder`/`makeLetterRelay` call sites need zero edits.

### Consistency of names across tasks (must match exactly)

```ts
// src/core/forward-budget.ts
export interface ForwardBudget { withinBudget(senderId: string): boolean }
export function makeForwardBudget(opts: { perSender: number; windowMs: number; now?: () => number }): ForwardBudget

// src/lib/agent-config.ts
export interface AgentConfig {
  // ...existing fields...
  forward_budget?: { per_sender: number; window_ms: number }
}
export const ForwardBudgetConfig: z.ZodObject<...>   // { per_sender: z.number().int().positive(); window_ms: z.number().int().positive() }
export const DEFAULT_FORWARD_BUDGET: { per_sender: number; window_ms: number }   // { per_sender: 30, window_ms: 3_600_000 }
export function resolveForwardBudget(config: AgentConfig): { per_sender: number; window_ms: number }   // config.forward_budget ?? DEFAULT_FORWARD_BUDGET

// src/core/social-forwarder.ts (extended)
export interface ForwarderDeps<T extends { id: string }> {
  // ...existing fields (answerLocally, forwardTargets, forwardSend, recordRelay, markSeen, hasSeen, hopCap?)...
  withinBudget?(senderId: string): boolean   // NEW, optional, defaults to allow-all
}

// src/core/penpal-relay-letter.ts (extended)
export interface LetterRelayDeps {
  // ...existing fields (relayStore, postLetter)...
  withinBudget?(senderId: string): boolean   // NEW, optional, defaults to allow-all
}

// src/daemon/bootstrap/forward-budget-seam.ts
export function buildSharedForwardBudget(
  config: import('../../lib/agent-config').AgentConfig,
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void,
  deps?: { now?: () => number },
): (senderId: string) => boolean
```

### File Structure

- **Create:** `src/core/forward-budget.ts` + `src/core/forward-budget.test.ts`, `src/daemon/bootstrap/forward-budget-seam.ts` + `src/daemon/bootstrap/forward-budget-seam.test.ts`.
- **Modify:** `src/lib/agent-config.ts` (`AgentConfig.forward_budget?`, `ForwardBudgetConfig` zod schema, `AgentConfigSchema` field, `loadAgentConfig` extraction, `DEFAULT_FORWARD_BUDGET` + `resolveForwardBudget`) + `src/lib/agent-config.test.ts`; `src/core/social-forwarder.ts` (`ForwarderDeps.withinBudget?` + gate) + `src/core/social-forwarder.test.ts`; `src/core/penpal-relay-letter.ts` (`LetterRelayDeps.withinBudget?` + gate, replaces the `// TODO(sub-project C)` line) + `src/core/penpal-relay-letter.test.ts`; `src/daemon/bootstrap/wire-social.ts` (construct `buildSharedForwardBudget` once, inject into both `makeForwarder` and `makeLetterRelay`).

**Task ordering (5 tasks, each an independently-green TDD deliverable):**
1. `forward-budget.ts` primitive · 2. `AgentConfig.forward_budget?` + `resolveForwardBudget` · 3. forwarder consume point · 4. relay-letter consume point · 5. wiring (shared instance + log + injection).

---

## Task 1: `src/core/forward-budget.ts` — the per-sender token bucket primitive

**Files:**
- Create: `src/core/forward-budget.ts`
- Create: `src/core/forward-budget.test.ts`

**Interfaces:**
- Consumes: nothing (no imports beyond the language itself — `Date.now` as the default clock).
- Produces:
  ```ts
  export interface ForwardBudget { withinBudget(senderId: string): boolean }
  export function makeForwardBudget(opts: { perSender: number; windowMs: number; now?: () => number }): ForwardBudget
  ```
  `withinBudget(senderId)` consumes one token if available (returns `true`) or refuses without consuming (returns `false`) if the sender's bucket is empty. Refill: `elapsed = now() - bucket.ts`; `refill = (elapsed / windowMs) * perSender`; `tokens = min(perSender, bucket.tokens + max(0, refill))`. A backwards clock yields `elapsed < 0` → `refill` clamped to `0` by `max(0, ...)` → no extra tokens minted (no-op). Each sender's bucket lives independently in one `Map<string, {tokens: number; ts: number}>` — no cross-sender interaction, no eviction (v0-accepted, matches `relay/rate-limit.ts`).

**Step 1 — Failing test.** Create `src/core/forward-budget.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { makeForwardBudget } from './forward-budget'

describe('makeForwardBudget', () => {
  it('allows up to perSender then refuses, and refills over injected time', () => {
    let t = 0
    const budget = makeForwardBudget({ perSender: 2, windowMs: 1000, now: () => t })
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)   // bucket empty
    t += 500                                          // half the window → +1 token
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)    // spent the refilled token
  })

  it('per-sender isolation: exhausting one sender does not affect another', () => {
    let t = 0
    const budget = makeForwardBudget({ perSender: 1, windowMs: 1000, now: () => t })
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)
    expect(budget.withinBudget('ccq')).toBe(true)     // independent bucket
  })

  it('a big time jump caps refill at capacity, never over-fills', () => {
    let t = 0
    const budget = makeForwardBudget({ perSender: 3, windowMs: 1000, now: () => t })
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)    // empty
    t += 1_000_000                                     // way past one window
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)    // capped at 3, not unlimited
  })

  it('a backwards clock is a no-op (no extra tokens minted)', () => {
    let t = 1000
    const budget = makeForwardBudget({ perSender: 1, windowMs: 1000, now: () => t })
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)    // empty
    t = 500                                            // clock moves BACKWARDS
    expect(budget.withinBudget('ccs')).toBe(false)    // still empty, no negative refill
  })

  it('defaults the clock to Date.now when now is omitted', () => {
    const budget = makeForwardBudget({ perSender: 1, windowMs: 1000 })
    expect(budget.withinBudget('ccs')).toBe(true)
    expect(budget.withinBudget('ccs')).toBe(false)
  })
})
```

**Step 2 — Run-fail.** `bun run test src/core/forward-budget.test.ts` → expect `Cannot find module './forward-budget'`.

**Step 3 — Minimal impl.** Create `src/core/forward-budget.ts`:
```ts
/**
 * forward-budget.ts — a per-sender token bucket bounding how many DISTINCT
 * intents an upstream sender may cause this daemon (as intermediary W) to
 * forward on their behalf, in a given time window (sub-project C). Mirrors
 * relay/rate-limit.ts's token-bucket SHAPE (per-key Map, `Math.max(0, refill)`,
 * cap-to-capacity) but is an INDEPENDENT daemon-core copy — it does not
 * import from relay/ (relay/ is a separate standalone process; see spec §3.1
 * "形态复刻...但住在 daemon core"). Unlike relay's `allow(key, now)`, the
 * consume signature carries no `now` argument: the clock is injected ONCE at
 * construction via `opts.now`, defaulting to `Date.now` — production call
 * sites never thread a clock through, while tests still drive it
 * deterministically (same idiom as src/daemon/activity/store.ts).
 * See docs/superpowers/specs/2026-07-20-forward-budget-C-design.md §3.1.
 */
export interface ForwardBudget {
  /** true + consumes one token if the sender has budget left this window;
   *  false (no consume) if the bucket is empty. */
  withinBudget(senderId: string): boolean
}

export function makeForwardBudget(opts: { perSender: number; windowMs: number; now?: () => number }): ForwardBudget {
  const now = opts.now ?? Date.now
  const buckets = new Map<string, { tokens: number; ts: number }>()
  return {
    withinBudget(senderId) {
      const t = now()
      const b = buckets.get(senderId) ?? { tokens: opts.perSender, ts: t }
      const refill = ((t - b.ts) / opts.windowMs) * opts.perSender
      const tokens = Math.min(opts.perSender, b.tokens + Math.max(0, refill))
      if (tokens < 1) { buckets.set(senderId, { tokens, ts: t }); return false }
      buckets.set(senderId, { tokens: tokens - 1, ts: t })
      return true
    },
  }
}
```

**Step 4 — Run-pass.** `bun run test src/core/forward-budget.test.ts` → all 5 tests green. `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**; depcheck **green** (no imports at all beyond built-ins — trivially satisfies "core, not relay/").

**Step 5 — Commit.** `git add -A && git commit -m "feat(social): per-sender forward-budget token bucket (sub-project C primitive)"`

- [ ] Task 1 complete

---

## Task 2: `AgentConfig.forward_budget?` + `resolveForwardBudget` default resolution

**Files:**
- Modify: `src/lib/agent-config.ts`, `src/lib/agent-config.test.ts`

**Interfaces:**
- Consumes: nothing new (zod `z` already imported).
- Produces:
  ```ts
  export interface AgentConfig { /* ...existing... */ forward_budget?: { per_sender: number; window_ms: number } }
  export const ForwardBudgetConfig: ReturnType<typeof z.object>   // { per_sender: z.number().int().positive(); window_ms: z.number().int().positive() }
  export const DEFAULT_FORWARD_BUDGET: { per_sender: number; window_ms: number }   // { per_sender: 30, window_ms: 3_600_000 }
  export function resolveForwardBudget(config: AgentConfig): { per_sender: number; window_ms: number }
  ```
  `forward_budget` is optional and additive on both the TS interface and the zod schema (no `.default()`) — absent stays `undefined` through `parseAgentConfig` AND `loadAgentConfig` (mirrors `a2a_listen?`/`mailbox_relays?`, not the always-present `autoStart`/`closeStopsDaemon` style). `resolveForwardBudget` is the one place "default 30/hour" lives; Task 5's wiring seam calls it — the field on `AgentConfig` itself never gets silently populated with a default at load time.

**Step 1 — Failing test.** Append to `src/lib/agent-config.test.ts` (add `resolveForwardBudget` to the existing top-of-file import list alongside `activeModel`, `withActiveModel`, etc.):
```ts
describe('agent-config — forward budget (sub-project C)', () => {
  it('parseAgentConfig accepts an explicit forward_budget', () => {
    const cfg = parseAgentConfig({ provider: 'claude', forward_budget: { per_sender: 10, window_ms: 60_000 } })
    expect(cfg.forward_budget).toEqual({ per_sender: 10, window_ms: 60_000 })
  })

  it('accepts config without forward_budget (backward compat) — field loads as undefined', () => {
    const cfg = parseAgentConfig({ provider: 'claude' })
    expect(cfg.forward_budget).toBeUndefined()
  })

  it('round-trips forward_budget through save → load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-budget-'))
    try {
      saveAgentConfig(dir, {
        provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false,
        forward_budget: { per_sender: 5, window_ms: 120_000 },
      })
      const loaded = loadAgentConfig(dir)
      expect(loaded.forward_budget).toEqual({ per_sender: 5, window_ms: 120_000 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('an old config on disk with no forward_budget field still parses, field undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-budget-old-'))
    try {
      writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
        provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false,
      }))
      const loaded = loadAgentConfig(dir)
      expect(loaded.forward_budget).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a malformed forward_budget on disk safe-drops (field loads as undefined, matching the a2a_listen? safeParse-drop convention) — resolveForwardBudget then falls back to the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-budget-malformed-'))
    try {
      writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
        provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false,
        forward_budget: { per_sender: 0, window_ms: 'not-a-number' },   // per_sender must be positive; window_ms must be a number
      }))
      const loaded = loadAgentConfig(dir)
      expect(loaded.forward_budget).toBeUndefined()   // safeParse.data is undefined on failure -> dropped, not thrown, no crash
      expect(resolveForwardBudget(loaded)).toEqual({ per_sender: 30, window_ms: 3_600_000 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('resolveForwardBudget', () => {
  it('returns the explicit config when set', () => {
    expect(resolveForwardBudget({
      provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false,
      forward_budget: { per_sender: 7, window_ms: 1000 },
    })).toEqual({ per_sender: 7, window_ms: 1000 })
  })
  it('falls back to the 30/hour default when absent', () => {
    expect(resolveForwardBudget({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false }))
      .toEqual({ per_sender: 30, window_ms: 3_600_000 })
  })
})
```

**Step 2 — Run-fail.** `bun run test src/lib/agent-config.test.ts` → expect a TS/import error (`resolveForwardBudget` not exported) and assertion failures (`forward_budget`/`resolveForwardBudget` don't exist yet).

**Step 3 — Minimal impl.** In `src/lib/agent-config.ts`:

Add to the `AgentConfig` interface (after `social_disclosure_policy?`):
```ts
  // Sub-project C (中间人转发预算): per-upstream-sender token-bucket budget on
  // how many DISTINCT intents this daemon will forward as intermediary W.
  // Optional/additive, same posture as mailbox_relays?/a2a_listen? — absent
  // means "use resolveForwardBudget's default", not "budget disabled".
  forward_budget?: { per_sender: number; window_ms: number }
```

Add a new zod sub-schema next to `A2AListen`/`YiHubListen`:
```ts
export const ForwardBudgetConfig = z.object({
  per_sender: z.number().int().positive(),
  window_ms: z.number().int().positive(),
})
export type ForwardBudgetConfig = z.infer<typeof ForwardBudgetConfig>
```

Add one line to `AgentConfigSchema`:
```ts
  forward_budget: ForwardBudgetConfig.optional(),
```

In `loadAgentConfig`, add the same safeParse pattern used for `a2aListen`:
```ts
    const forwardBudget = parsed.forward_budget != null
      ? ForwardBudgetConfig.safeParse(parsed.forward_budget).data
      : undefined
```
and add to the returned object (alongside the other `...(x ? {...} : {})` spreads):
```ts
      ...(forwardBudget ? { forward_budget: forwardBudget } : {}),
```

Add the default constant + resolver near `activeModel`/`withActiveModel` at the bottom of the file:
```ts
/** Sub-project C default: 30 forwards/hour per upstream sender. Applied by
 *  resolveForwardBudget when the operator hasn't set config.forward_budget —
 *  the config field itself stays undefined (additive/optional), this is the
 *  one canonical place the default value lives. */
export const DEFAULT_FORWARD_BUDGET: { per_sender: number; window_ms: number } = { per_sender: 30, window_ms: 3_600_000 }

/** `config.forward_budget` if the operator set one, else {@link DEFAULT_FORWARD_BUDGET}. */
export function resolveForwardBudget(config: AgentConfig): { per_sender: number; window_ms: number } {
  return config.forward_budget ?? DEFAULT_FORWARD_BUDGET
}
```

**Step 4 — Run-pass.** `bun run test src/lib/agent-config.test.ts` → all tests green (existing + 7 new). `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**; depcheck **green** (no new import; `zod` already a dependency).

**Step 5 — Commit.** `git add -A && git commit -m "feat(config): AgentConfig.forward_budget? + resolveForwardBudget default (sub-project C)"`

- [ ] Task 2 complete

---

## Task 3: forwarder consume point — `ForwarderDeps.withinBudget?` gate before fan-out

**Files:**
- Modify: `src/core/social-forwarder.ts`, `src/core/social-forwarder.test.ts`

**Interfaces:**
- Consumes: `makeForwardBudget` (Task 1, test-only — used in the isolation test to prove a REAL budget instance gates correctly at this layer; production wiring happens in Task 5).
- Produces:
  ```ts
  export interface ForwarderDeps<T extends { id: string }> {
    // ...existing fields unchanged...
    withinBudget?(senderId: string): boolean   // NEW, optional — defaults to allow-all
  }
  ```
  `makeForwarder`'s returned function gates immediately after the existing `if (alreadySeen || card.hop >= cap) return receipt` line and before the `for (const target of deps.forwardTargets(...))` loop: `if (!withinBudget(event.agent.id)) return receipt` where `withinBudget = deps.withinBudget ?? (() => true)`. Over budget → the function returns the LOCAL `receipt` from `answerLocally` unchanged (W still answers), `forwardSend`/`recordRelay` are never called (no fan-out, no relay row, no signal to the sender).

**Step 1 — Failing test.** Append to `src/core/social-forwarder.test.ts` (add `import { makeForwardBudget } from './forward-budget'` to the top):
```ts
  it('over-budget sender: answered locally, forwardSend NOT called (no fan-out, no signal)', async () => {
    const forwardSend = vi.fn(async (): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'yes', blurb: 'x' }))
    const withinBudget = vi.fn(() => false)
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [{ id: 'ccq' }], forwardSend, recordRelay: () => 'tok', markSeen: vi.fn(), hasSeen: () => false, withinBudget })
    const r = await fwd(event('ccs'))
    expect(withinBudget).toHaveBeenCalledWith('ccs')
    expect(forwardSend).not.toHaveBeenCalled()
    expect(r.forwarded).toBeUndefined()
    expect(r.match).toBe('no')   // still the local answer
  })

  it('within-budget sender: fans out as normal', async () => {
    const forwardSend = vi.fn(async (): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'yes', blurb: 'x' }))
    const withinBudget = vi.fn(() => true)
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [{ id: 'ccq' }], forwardSend, recordRelay: () => 'tok', markSeen: vi.fn(), hasSeen: () => false, withinBudget })
    const r = await fwd(event('ccs'))
    expect(forwardSend).toHaveBeenCalledTimes(1)
    expect(r.forwarded).toEqual([{ blurb: 'x', degree: 2, relay_token: 'tok' }])
  })

  it('withinBudget omitted — allow-all default, existing behavior unchanged', async () => {
    const forwardSend = vi.fn(async (): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'yes', blurb: 'x' }))
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [{ id: 'ccq' }], forwardSend, recordRelay: () => 'tok', markSeen: vi.fn(), hasSeen: () => false })
    const r = await fwd(event('ccs'))
    expect(forwardSend).toHaveBeenCalledTimes(1)
  })

  it('per-sender isolation reaches the forwarder layer: a real budget gates ccs but not ccq', async () => {
    const budget = makeForwardBudget({ perSender: 1, windowMs: 1000, now: () => 0 })
    const forwardSend = vi.fn(async (): Promise<MatchReceipt | null> => ({ intent_id: 'i1', match: 'yes', blurb: 'x' }))
    const fwd = makeForwarder({ answerLocally: async () => ({ intent_id: 'i1', match: 'no' }), forwardTargets: () => [{ id: 'ccq' }], forwardSend, recordRelay: () => 'tok', markSeen: vi.fn(), hasSeen: () => false, withinBudget: (s) => budget.withinBudget(s) })
    await fwd(event('ccs'))                         // spends ccs's only token
    await fwd(event('ccs', { intent_id: 'i2' }))     // ccs now over budget
    await fwd(event('ccq', { intent_id: 'i3' }))     // ccq is a different sender — untouched
    expect(forwardSend).toHaveBeenCalledTimes(2)     // i1 (ccs) + i3 (ccq); i2 (ccs, over budget) skipped
  })
```

**Step 2 — Run-fail.** `bun run test src/core/social-forwarder.test.ts` → expect TS errors (`withinBudget` not a known property of `ForwarderDeps`) and/or assertion failures (`forwardSend` still called when it shouldn't be).

**Step 3 — Minimal impl.** In `src/core/social-forwarder.ts`, add to `ForwarderDeps` (after `hopCap?: number`):
```ts
  /** Sub-project C: per-upstream-sender forward budget gate — false means the
   *  sender is over budget for this window; the forwarder answers locally
   *  and skips the fan-out (silent, no signal to the sender). OPTIONAL,
   *  defaults to allow-all so existing callers/tests that construct
   *  ForwarderDeps without it are unaffected (see the plan's Global
   *  Constraints "RESOLVED: optional" section for why). */
  withinBudget?(senderId: string): boolean
```
And in `makeForwarder`'s returned function, change:
```ts
    // Skip forwarding when: already seen (dedup), or at/over the hop ceiling.
    if (alreadySeen || card.hop >= cap) return receipt
```
to:
```ts
    // Skip forwarding when: already seen (dedup), or at/over the hop ceiling.
    if (alreadySeen || card.hop >= cap) return receipt
    // Sub-project C: per-sender forward budget — over budget → same local-only
    // shape as the hop/dedup skips above (still returns the local `receipt`).
    const withinBudget = deps.withinBudget ?? (() => true)
    if (!withinBudget(event.agent.id)) return receipt
```

**Step 4 — Run-pass.** `bun run test src/core/social-forwarder.test.ts` → all tests green (existing 7 + 4 new). `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**; depcheck **green**.

**Step 5 — Commit.** `git add -A && git commit -m "feat(social): forwarder consume point — ForwarderDeps.withinBudget gate (sub-project C)"`

- [ ] Task 3 complete

---

## Task 4: relay-letter consume point — replace the TODO with `LetterRelayDeps.withinBudget?` gate

**Files:**
- Modify: `src/core/penpal-relay-letter.ts`, `src/core/penpal-relay-letter.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  export interface LetterRelayDeps {
    // ...existing fields (relayStore, postLetter) unchanged...
    withinBudget?(senderId: string): boolean   // NEW, optional — defaults to allow-all
  }
  ```
  `routeLetter` gates on `event.agent_id` (the upstream sender of THIS letter) right where the `// TODO(sub-project C)` comment currently sits, replacing it: over budget → `deps.postLetter` never called, AND — **critically** — the response is `{ok: false, error: 'unknown_channel'}`, the SAME shape `routeLetter` already returns for "no matching relay leg" (the existing unknown-channel / loop-safety branches a few lines above). This is required by spec §2's "no signal to the sender" 铁律: `src/core/a2a-server.ts`'s `/a2a/letter` route (~lines 416-419) echoes `onLetter`'s full result back to the caller over HTTP 200 verbatim (`new Response(JSON.stringify(result), {status: 200})`) — a distinct `error: 'over_budget'` string would be directly readable by the sender, telling a flooder they've been detected. Reusing `unknown_channel` makes an over-budget drop indistinguishable, on the wire, from "W simply doesn't recognize this channel_id." (The forwarder path, Task 3, needs no equivalent fix: its over-budget return is already the same local `receipt` shape as a legitimate no-downstream-match — already indistinguishable.) Same optionality/default posture as `ForwarderDeps.withinBudget` (Task 3) — this is the SAME shared instance at wiring time (Task 5), but each consume point still defaults to allow-all independently when unwired, so existing tests are unaffected.

**Step 1 — Failing test.** Append to `src/core/penpal-relay-letter.test.ts`:
```ts
  it('over-budget sender: drops before postLetter, response is INDISTINGUISHABLE from "unknown channel" (no signal to the sender)', async () => {
    const db = openDb({ path: ':memory:' })
    const relayStore = makeRelayStore(db)
    relayStore.create({ id: 'i1:tok', intentId: 'i1', relayToken: 'tok', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    relayStore.setUpstreamHandle('i1:tok', { pubkey: 'Spub', channel_id: 'chan-s' })
    relayStore.setDownstreamHandle('i1:tok', { pubkey: 'Qpub', channel_id: 'chan-q' })

    const postLetter = vi.fn().mockResolvedValue(true)
    const withinBudget = vi.fn(() => false)
    const relay = makeLetterRelay({ relayStore, postLetter, withinBudget })

    const result = await relay.routeLetter({ agent_id: 'ccs', channel_id: 'chan-q', nonce: 'N', ct: 'CT', tag: 'TAG' })

    // MUST equal the SAME shape as the existing "no matching relay leg" drop
    // (see the 'is a safe no-op on an unknown channel_id' test above) — a
    // distinct 'over_budget' string would leak the throttle to the sender
    // once /a2a/letter echoes this result back over HTTP 200 (a2a-server.ts).
    expect(result).toEqual({ ok: false, error: 'unknown_channel' })
    expect(withinBudget).toHaveBeenCalledWith('ccs')
    expect(postLetter).not.toHaveBeenCalled()
  })

  it('within-budget sender: forwards as normal', async () => {
    const db = openDb({ path: ':memory:' })
    const relayStore = makeRelayStore(db)
    relayStore.create({ id: 'i1:tok', intentId: 'i1', relayToken: 'tok', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    relayStore.setUpstreamHandle('i1:tok', { pubkey: 'Spub', channel_id: 'chan-s' })
    relayStore.setDownstreamHandle('i1:tok', { pubkey: 'Qpub', channel_id: 'chan-q' })

    const postLetter = vi.fn().mockResolvedValue(true)
    const relay = makeLetterRelay({ relayStore, postLetter, withinBudget: () => true })

    const result = await relay.routeLetter({ agent_id: 'ccs', channel_id: 'chan-q', nonce: 'N', ct: 'CT', tag: 'TAG' })
    expect(result).toEqual({ ok: true })
    expect(postLetter).toHaveBeenCalledTimes(1)
  })

  it('withinBudget omitted — allow-all default, existing behavior unchanged', async () => {
    const db = openDb({ path: ':memory:' })
    const relayStore = makeRelayStore(db)
    relayStore.create({ id: 'i1:tok', intentId: 'i1', relayToken: 'tok', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
    relayStore.setUpstreamHandle('i1:tok', { pubkey: 'Spub', channel_id: 'chan-s' })
    relayStore.setDownstreamHandle('i1:tok', { pubkey: 'Qpub', channel_id: 'chan-q' })

    const postLetter = vi.fn().mockResolvedValue(true)
    const relay = makeLetterRelay({ relayStore, postLetter })

    const result = await relay.routeLetter({ agent_id: 'ccs', channel_id: 'chan-q', nonce: 'N', ct: 'CT', tag: 'TAG' })
    expect(result).toEqual({ ok: true })
    expect(postLetter).toHaveBeenCalledTimes(1)
  })
```

**Step 2 — Run-fail.** `bun run test src/core/penpal-relay-letter.test.ts` → expect TS errors (`withinBudget` not a known property of `LetterRelayDeps`) and the first new test failing (`routeLetter` still calls `postLetter` because the gate doesn't exist yet).

**Step 3 — Minimal impl.** In `src/core/penpal-relay-letter.ts`, add to `LetterRelayDeps` (after `postLetter(...)`):
```ts
  /** Sub-project C: same per-upstream-sender forward budget as the seek
   *  forwarder (ForwarderDeps.withinBudget) — shares ONE bucket, injected as
   *  the identical closure at wiring time (wire-social.ts). Keyed on
   *  event.agent_id (the upstream sender of THIS letter). OPTIONAL, defaults
   *  to allow-all — matches ForwarderDeps.withinBudget's optionality. */
  withinBudget?(senderId: string): boolean
```
Replace the TODO line:
```ts
      // TODO(sub-project C): budget.consume(relay_token) gate before re-posting
```
with:
```ts
      // Sub-project C: per-sender forward budget, gated on the upstream
      // sender of this letter (event.agent_id) — shares its bucket with the
      // seek-forwarder's withinBudget (same instance, injected at wiring).
      // Over budget → drop silently, no postLetter. The response is
      // DELIBERATELY the same 'unknown_channel' shape as "no matching relay
      // leg" (not a distinct 'over_budget' string) — /a2a/letter echoes this
      // result verbatim back to the caller over HTTP 200 (a2a-server.ts),
      // so a distinct error string would leak the throttle to the sender and
      // violate spec §2 "no signal to the sender". Indistinguishable from
      // "W doesn't know this channel" is the point.
      const withinBudget = deps.withinBudget ?? (() => true)
      if (!withinBudget(event.agent_id)) return { ok: false, error: 'unknown_channel' }
```

**Step 4 — Run-pass.** `bun run test src/core/penpal-relay-letter.test.ts` → all tests green (existing 3 + 3 new). `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**; depcheck **green**.

**Step 5 — Commit.** `git add -A && git commit -m "feat(social): relay-letter consume point — replace TODO with withinBudget gate (sub-project C)"`

- [ ] Task 4 complete

---

## Task 5: wiring — one shared `buildSharedForwardBudget`, injected into both consume points, with the over-budget log

**Files:**
- Create: `src/daemon/bootstrap/forward-budget-seam.ts`, `src/daemon/bootstrap/forward-budget-seam.test.ts`
- Modify: `src/daemon/bootstrap/wire-social.ts`

**Interfaces:**
- Consumes: `makeForwardBudget` (Task 1), `resolveForwardBudget` (Task 2), `ForwarderDeps.withinBudget` (Task 3), `LetterRelayDeps.withinBudget` (Task 4), `AgentConfig`, `BootstrapDeps['log']`.
- Produces:
  ```ts
  export function buildSharedForwardBudget(
    config: AgentConfig,
    log: (tag: string, line: string, fields?: Record<string, unknown>) => void,
    deps?: { now?: () => number },
  ): (senderId: string) => boolean
  ```
  Constructs exactly ONE `makeForwardBudget` sized from `resolveForwardBudget(config)` and returns ONE closure that calls its `withinBudget` and, on refusal, logs `[forward-budget] over budget for <senderId>, local-only` under tag `'SOCIAL_REC'` (the same tag `wire-social.ts` already uses for other social-record-failure lines) before returning `false`. `wire-social.ts` calls this ONCE inside the `social_enabled && social_disclosure_policy` branch and passes the returned closure, unchanged, as `withinBudget` into BOTH `makeLetterRelay({...})` and `makeForwarder({...})` — this single shared closure (closing over the single `makeForwardBudget` instance) is what makes the budget shared across the two consume points.

  This is deliberately its own tiny pure/testable seam (same pattern as `postletter-route.ts` / `mailbox-dispatch-seam.ts` — see those files) rather than something asserted by invoking the full `wireSocial()`, which needs a real `Db`, `ProviderRegistry`, `A2ARegistry`, `A2AClient`, etc. and is not exercised as a whole unit anywhere in the existing test suite (`wire-social.mailbox.test.ts` only tests the extracted `peerMailboxOf` helper, following the same "extract the seam, test the seam" convention this task follows too).

**Step 1 — Failing test.** Create `src/daemon/bootstrap/forward-budget-seam.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { buildSharedForwardBudget } from './forward-budget-seam'
import type { AgentConfig } from '../../lib/agent-config'

const baseConfig: AgentConfig = { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false }

describe('buildSharedForwardBudget', () => {
  it('uses the 30/hour default when config.forward_budget is absent', () => {
    let t = 0
    const log = vi.fn()
    const withinBudget = buildSharedForwardBudget(baseConfig, log, { now: () => t })
    for (let i = 0; i < 30; i++) expect(withinBudget('ccs')).toBe(true)
    expect(withinBudget('ccs')).toBe(false)   // 31st this window → over budget
    expect(log).toHaveBeenCalledWith('SOCIAL_REC', '[forward-budget] over budget for ccs, local-only')
  })

  it('honors an explicit config.forward_budget', () => {
    let t = 0
    const log = vi.fn()
    const cfg: AgentConfig = { ...baseConfig, forward_budget: { per_sender: 2, window_ms: 1000 } }
    const withinBudget = buildSharedForwardBudget(cfg, log, { now: () => t })
    expect(withinBudget('ccs')).toBe(true)
    expect(withinBudget('ccs')).toBe(true)
    expect(withinBudget('ccs')).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('SHARED instance: a sender exhausted via one call path is also refused via a second call path (same bucket)', () => {
    let t = 0
    const log = vi.fn()
    const cfg: AgentConfig = { ...baseConfig, forward_budget: { per_sender: 1, window_ms: 1000 } }
    const withinBudget = buildSharedForwardBudget(cfg, log, { now: () => t })
    // Simulate the seek-forwarder consume point spending ccs's only token...
    expect(withinBudget('ccs')).toBe(true)
    // ...then the letter-relay consume point (a DIFFERENT call site, but the
    // SAME returned function reference — exactly how wire-social.ts injects
    // it into both ForwarderDeps.withinBudget and LetterRelayDeps.withinBudget)
    // sees ccs already over budget, proving both consume points share ONE bucket.
    expect(withinBudget('ccs')).toBe(false)
  })

  it('does not log when the sender is within budget', () => {
    let t = 0
    const log = vi.fn()
    const withinBudget = buildSharedForwardBudget(baseConfig, log, { now: () => t })
    withinBudget('ccs')
    expect(log).not.toHaveBeenCalled()
  })
})
```

**Step 2 — Run-fail.** `bun run test src/daemon/bootstrap/forward-budget-seam.test.ts` → expect `Cannot find module './forward-budget-seam'`.

**Step 3 — Minimal impl.** Create `src/daemon/bootstrap/forward-budget-seam.ts`:
```ts
/**
 * forward-budget-seam.ts — the wiring-level construction of sub-project C's
 * per-sender forward budget. Builds exactly ONE makeForwardBudget instance
 * (sized from the operator's config, or the 30/hour default) and wraps its
 * withinBudget in the required local-only log line (spec §3.4) — the
 * returned closure is injected UNCHANGED into BOTH consume points
 * (ForwarderDeps.withinBudget + LetterRelayDeps.withinBudget in wire-social.ts)
 * so a sender's seek-forwards and letter-forwards draw from the SAME bucket.
 * Kept as its own tiny seam (same pattern as postletter-route.ts /
 * mailbox-dispatch-seam.ts) so the sharing property is unit-testable without
 * invoking the whole (untested-as-a-unit) wireSocial().
 */
import { makeForwardBudget } from '../../core/forward-budget'
import { resolveForwardBudget, type AgentConfig } from '../../lib/agent-config'

export function buildSharedForwardBudget(
  config: AgentConfig,
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void,
  deps?: { now?: () => number },
): (senderId: string) => boolean {
  const { per_sender, window_ms } = resolveForwardBudget(config)
  const budget = makeForwardBudget({ perSender: per_sender, windowMs: window_ms, now: deps?.now })
  return (senderId) => {
    const ok = budget.withinBudget(senderId)
    if (!ok) log('SOCIAL_REC', `[forward-budget] over budget for ${senderId}, local-only`)
    return ok
  }
}
```

Edit `src/daemon/bootstrap/wire-social.ts`:
1. Add the import near the other bootstrap-local imports (next to `makeMailboxLetterHandler` / `makeRoutePostLetter`):
   ```ts
   import { buildSharedForwardBudget } from './forward-budget-seam'
   ```
2. Construct the shared closure ONCE, before `const letterRelay = makeLetterRelay(...)` (i.e. right after the `letterStore`/`postLetter` block, before `const notifyInbound = ...`):
   ```ts
   // Sub-project C: ONE shared per-sender forward budget, injected into BOTH
   // consume points below (letterRelay + the seek forwarder further down) —
   // see forward-budget-seam.ts for why this must be a single instance.
   const withinForwardBudget = buildSharedForwardBudget(configuredAgent, deps.log)
   ```
3. Inject it into the existing `makeLetterRelay` call — this is an exact one-line change to the ALREADY-EXISTING call (`const letterRelay = makeLetterRelay({ relayStore, postLetter })`, currently on its own line just above `socialOnLetter = async (ev) => {...}`):
   ```ts
   // BEFORE:
   const letterRelay = makeLetterRelay({ relayStore, postLetter })
   // AFTER:
   const letterRelay = makeLetterRelay({ relayStore, postLetter, withinBudget: withinForwardBudget })
   ```
4. Inject it into the existing `makeForwarder` call (the `socialOnIntent = makeForwarder({...})` block). This call's REAL tail today (verbatim, from the current `wire-social.ts`) is:
   ```ts
       hasSeen: (intentId) => { try { return seenIntentStore.hasSeen(intentId) } catch { return false } },
       hopCap: 2,
     })
   ```
   Insert ONE line (`withinBudget: withinForwardBudget,`) between `hasSeen: (...) => {...},` and `hopCap: 2,` — every other field in the call (`answerLocally`, `forwardTargets`, `forwardSend`, `recordRelay`, `markSeen`, `hasSeen`) is untouched, existing code, NOT reproduced/retyped:
   ```ts
   // BEFORE (tail of the existing call):
       hasSeen: (intentId) => { try { return seenIntentStore.hasSeen(intentId) } catch { return false } },
       hopCap: 2,
     })
   // AFTER (tail of the existing call):
       hasSeen: (intentId) => { try { return seenIntentStore.hasSeen(intentId) } catch { return false } },
       withinBudget: withinForwardBudget,
       hopCap: 2,
     })
   ```
   This is a literal insert-one-line edit on the real file (e.g. via the Edit tool: `old_string` = the two-line `hasSeen...` + `hopCap: 2,` block shown above, `new_string` = the three-line block with `withinBudget: withinForwardBudget,` inserted) — nothing about `answerLocally`/`forwardTargets`/`forwardSend`/`recordRelay`/`markSeen`/`hasSeen`'s bodies is touched or re-typed.

**Step 4 — Run-pass.** `bun run test src/daemon/bootstrap/forward-budget-seam.test.ts` → all 4 tests green. Then the FULL regression sweep: `bun run test src/core/forward-budget.test.ts src/lib/agent-config.test.ts src/core/social-forwarder.test.ts src/core/penpal-relay-letter.test.ts src/core/social-m1.e2e.test.ts src/core/penpal.e2e.test.ts src/daemon/bootstrap/forward-budget-seam.test.ts` → all green (proves Tasks 1-5 together, plus the e2e tests that construct `makeForwarder`/`makeLetterRelay` without `withinBudget` still pass unmodified). `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**; depcheck **green** (`forward-budget-seam.ts` imports only `../../core/forward-budget` and `../../lib/agent-config`, both existing internal modules — no `relay/*`, no new dependency).

**Step 5 — Commit.** `git add -A && git commit -m "feat(social): wire ONE shared forward-budget instance into forwarder + relay-letter (sub-project C complete)"`

- [ ] Task 5 complete

---

## Final verification (whole-suite regression)

After Task 5's commit, run the full gate trio once more from repo root to confirm no other suite regressed:
```bash
bun run test
bun run typecheck
bun run depcheck
```
All three MUST be green. Do not proceed to PR/merge on red.
