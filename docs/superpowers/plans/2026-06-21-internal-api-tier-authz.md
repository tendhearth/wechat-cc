# Internal-API Per-Session Tier Authorization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the initiating session's tier at every internal-api route, using a provider-agnostic per-session token, so a `trusted` agent's shell-curl can't escalate to the admin-only daemon-control routes.

**Architecture:** A daemon-side token→tier registry replaces the single-token check. The boot file token is registered as `trusted`; each session spawn mints an env-only token carrying that session's tier, injected into the session's MCP children by every provider through one `SpawnContext.sessionToken` contract. The dispatcher resolves the caller's tier from the presented token and rejects calls below each route's declared minimum (default-deny).

**Tech Stack:** TypeScript, Bun, vitest, Node `http`, the existing internal-api / SessionManager / provider stack.

Spec: `docs/superpowers/specs/2026-06-21-internal-api-tier-authz-design.md`.

## Global Constraints

- Runtime: `bun`. Tests: `bun --bun vitest run <file>`. Typecheck: `tsc --noEmit`.
- Tiers: `type UserTier = 'admin' | 'trusted' | 'guest'` (`src/core/user-tier.ts:18`). Rank: `admin > trusted > guest`.
- Tokens: 32-byte random hex; compare timing-safe (`node:crypto` `timingSafeEqual`), matching the existing `authOk`.
- Default-deny: a route with no declared min tier resolves to `admin`.
- Commit after every green step. Never weaken a test to make it pass.
- Keep the existing daemon-wide file token file + per-boot rotation; only its *granted tier* changes (→ `trusted`).

---

## Phase 1 — Tier-aware auth at the route layer

Self-contained inside `src/daemon/internal-api/`. Delivers the headline behavior (file token → 403 on admin routes) before any provider work.

### Task 1.1: Token registry

**Files:**
- Create: `src/daemon/internal-api/token-registry.ts`
- Test: `src/daemon/internal-api/token-registry.test.ts`

**Interfaces:**
- Produces:
  - `type TokenInfo = { tier: UserTier; origin: 'file' | 'session'; sessionKey?: string }`
  - `interface TokenRegistry { registerFileToken(tokenHex: string): void; mint(tier: UserTier, sessionKey: string): string; resolve(tokenHex: string): TokenInfo | null; invalidateSession(sessionKey: string): void }`
  - `function makeTokenRegistry(randomHex?: () => string): TokenRegistry`

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/internal-api/token-registry.test.ts
import { describe, it, expect } from 'vitest'
import { makeTokenRegistry } from './token-registry'

describe('token-registry', () => {
  it('resolves a registered file token as trusted/file', () => {
    const r = makeTokenRegistry()
    r.registerFileToken('aa'.repeat(32))
    expect(r.resolve('aa'.repeat(32))).toEqual({ tier: 'trusted', origin: 'file' })
  })

  it('mint returns a token that resolves to its tier/session and is unique', () => {
    let n = 0
    const r = makeTokenRegistry(() => `0${n++}`.padStart(64, '0'))
    const t1 = r.mint('admin', 'claude/a/chat-1')
    const t2 = r.mint('guest', 'codex/a/chat-2')
    expect(t1).not.toBe(t2)
    expect(r.resolve(t1)).toEqual({ tier: 'admin', origin: 'session', sessionKey: 'claude/a/chat-1' })
    expect(r.resolve(t2)).toEqual({ tier: 'guest', origin: 'session', sessionKey: 'codex/a/chat-2' })
  })

  it('resolve returns null for an unknown token', () => {
    expect(makeTokenRegistry().resolve('ff'.repeat(32))).toBeNull()
  })

  it('invalidateSession drops every token for that sessionKey', () => {
    const r = makeTokenRegistry()
    const t = r.mint('admin', 'claude/a/chat-1')
    r.invalidateSession('claude/a/chat-1')
    expect(r.resolve(t)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/internal-api/token-registry.test.ts`
Expected: FAIL — `Cannot find module './token-registry'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/daemon/internal-api/token-registry.ts
import { randomBytes } from 'node:crypto'
import type { UserTier } from '../../core/user-tier'

export type TokenInfo = { tier: UserTier; origin: 'file' | 'session'; sessionKey?: string }

export interface TokenRegistry {
  /** Register the daemon-wide boot token. Always granted `trusted` — a shell-
   *  readable credential can't be trusted above the least-trusted reader. */
  registerFileToken(tokenHex: string): void
  /** Mint a fresh env-only session token for a (tier, sessionKey). */
  mint(tier: UserTier, sessionKey: string): string
  /** Timing-safe-ish lookup (Map get on the hex string; the hex is itself the
   *  secret and high-entropy). Returns null when unknown. */
  resolve(tokenHex: string): TokenInfo | null
  /** Drop all tokens minted for a session (called on release/evict/close). */
  invalidateSession(sessionKey: string): void
}

export function makeTokenRegistry(randomHex: () => string = () => randomBytes(32).toString('hex')): TokenRegistry {
  const map = new Map<string, TokenInfo>()
  return {
    registerFileToken(tokenHex) {
      map.set(tokenHex, { tier: 'trusted', origin: 'file' })
    },
    mint(tier, sessionKey) {
      const tok = randomHex()
      map.set(tok, { tier, origin: 'session', sessionKey })
      return tok
    },
    resolve(tokenHex) {
      return map.get(tokenHex) ?? null
    },
    invalidateSession(sessionKey) {
      for (const [tok, info] of map) {
        if (info.origin === 'session' && info.sessionKey === sessionKey) map.delete(tok)
      }
    },
  }
}
```

> Note on timing: the registry keys on the full 32-byte hex secret, so a `Map.get` does not leak a useful timing oracle (an attacker must already hold a full valid token to get a hit). The existing `authOk` used `timingSafeEqual` against ONE token; with N tokens that pattern doesn't scale, and a high-entropy map key is the standard substitute. Documented here intentionally.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/daemon/internal-api/token-registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/internal-api/token-registry.ts src/daemon/internal-api/token-registry.test.ts
git commit -m "feat(internal-api): token->tier registry"
```

---

### Task 1.2: Route min-tier table

**Files:**
- Create: `src/daemon/internal-api/route-tiers.ts`
- Test: `src/daemon/internal-api/route-tiers.test.ts`

**Interfaces:**
- Consumes: `UserTier`.
- Produces:
  - `const TIER_RANK: Record<UserTier, number>` (`guest:0, trusted:1, admin:2`)
  - `function tierMeets(have: UserTier, need: UserTier): boolean`
  - `const ROUTE_MIN_TIER: Record<string, UserTier>` keyed by `"METHOD /path"`
  - `function minTierFor(routeKey: string): UserTier` (default `'admin'`)

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/internal-api/route-tiers.test.ts
import { describe, it, expect } from 'vitest'
import { tierMeets, minTierFor, ROUTE_MIN_TIER } from './route-tiers'

describe('route-tiers', () => {
  it('tierMeets ranks admin > trusted > guest', () => {
    expect(tierMeets('admin', 'trusted')).toBe(true)
    expect(tierMeets('trusted', 'admin')).toBe(false)
    expect(tierMeets('guest', 'guest')).toBe(true)
  })

  it('daemon-control routes require admin', () => {
    expect(minTierFor('POST /v1/daemon/restart')).toBe('admin')
    expect(minTierFor('POST /v1/sessions/release')).toBe('admin')
    expect(minTierFor('POST /v1/model')).toBe('admin')
    expect(minTierFor('GET /v1/turns')).toBe('admin')
    expect(minTierFor('GET /v1/sessions')).toBe('admin')
  })

  it('reply/health/memory-read are guest; broadcast/a2a are trusted', () => {
    expect(minTierFor('GET /v1/health')).toBe('guest')
    expect(minTierFor('POST /v1/wechat/reply')).toBe('guest')
    expect(minTierFor('POST /v1/memory/read')).toBe('guest')
    expect(minTierFor('POST /v1/wechat/broadcast')).toBe('trusted')
    expect(minTierFor('GET /v1/a2a/list')).toBe('trusted')
  })

  it('an unlisted route defaults to admin (fail-closed)', () => {
    expect(minTierFor('POST /v1/some/new/route')).toBe('admin')
  })
})
```

- [ ] **Step 2: Run test — FAIL** (`Cannot find module './route-tiers'`).

Run: `bun --bun vitest run src/daemon/internal-api/route-tiers.test.ts`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/daemon/internal-api/route-tiers.ts
import type { UserTier } from '../../core/user-tier'

export const TIER_RANK: Record<UserTier, number> = { guest: 0, trusted: 1, admin: 2 }
export function tierMeets(have: UserTier, need: UserTier): boolean {
  return TIER_RANK[have] >= TIER_RANK[need]
}

// Min tier per route. Derived from the corresponding ToolKind's tier policy
// (user-tier.ts) where one exists; explicit for operator/infra routes.
// Anything NOT listed defaults to 'admin' via minTierFor (fail-closed).
export const ROUTE_MIN_TIER: Record<string, UserTier> = {
  // guest — liveness + read/reply
  'GET /v1/health': 'guest',
  'POST /v1/wechat/reply': 'guest',
  'POST /v1/wechat/reply_voice': 'guest',
  'POST /v1/memory/read': 'guest',
  'GET /v1/memory/list': 'guest',
  'POST /v1/share/page': 'guest',
  'POST /v1/share/resurface': 'guest',
  'GET /v1/companion/status': 'guest',
  // trusted — operator/agent ops (also reachable by the CLI, capped at trusted)
  'POST /v1/wechat/broadcast': 'trusted',
  'POST /v1/wechat/send_file': 'trusted',
  'POST /v1/wechat/edit_message': 'trusted',
  'POST /v1/memory/write': 'trusted',
  'POST /v1/memory/delete': 'trusted',
  'POST /v1/user/set_name': 'trusted',
  'POST /v1/voice/save_config': 'trusted',
  'GET /v1/voice/status': 'trusted',
  'POST /v1/companion/enable': 'trusted',
  'POST /v1/companion/disable': 'trusted',
  'POST /v1/companion/snooze': 'trusted',
  'POST /v1/conversation/set-mode': 'trusted',
  'GET /v1/projects/list': 'trusted',
  'POST /v1/projects/add': 'trusted',
  'POST /v1/projects/remove': 'trusted',
  'POST /v1/projects/switch': 'trusted',
  'GET /v1/a2a/list': 'trusted',
  'GET /v1/a2a/info': 'trusted',
  'GET /v1/a2a/activity': 'trusted',
  'POST /v1/a2a/preview': 'trusted',
  'POST /v1/a2a/install': 'trusted',
  'POST /v1/a2a/remove': 'trusted',
  'POST /v1/a2a/pause': 'trusted',
  'POST /v1/a2a/send': 'trusted',
  'POST /v1/a2a/test': 'trusted',
  'POST /v1/delegate': 'trusted',
  // admin — daemon-control (daemon_introspect / daemon_remediate)
  'GET /v1/turns': 'admin',
  'GET /v1/sessions': 'admin',
  'GET /v1/model': 'admin',
  'POST /v1/sessions/release': 'admin',
  'POST /v1/model': 'admin',
  'POST /v1/daemon/restart': 'admin',
}

export function minTierFor(routeKey: string): UserTier {
  return ROUTE_MIN_TIER[routeKey] ?? 'admin'
}
```

- [ ] **Step 4: Run test — PASS.**

Run: `bun --bun vitest run src/daemon/internal-api/route-tiers.test.ts`

- [ ] **Step 5: Add a coverage guard test** (every real route has an explicit tier — catches a new route silently defaulting to admin only if intended).

```ts
// append to src/daemon/internal-api/route-tiers.test.ts
import { makeRoutes } from './routes'
it('every registered route has an explicit min tier (no accidental default-deny)', () => {
  // Build the route table with empty deps; we only need its keys.
  const routes = makeRoutes({ deps: { stateDir: '/tmp', daemonPid: 1 } as never, getDelegate: () => null, maybePrefix: (_c, t) => t })
  for (const key of Object.keys(routes)) {
    expect(ROUTE_MIN_TIER[key], `route ${key} missing from ROUTE_MIN_TIER`).toBeDefined()
  }
})
```

Run: `bun --bun vitest run src/daemon/internal-api/route-tiers.test.ts`
Expected: PASS. If it FAILS listing a route, add that route to `ROUTE_MIN_TIER` with the correct tier (fail-closed default already protects it, but explicit is the contract).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/internal-api/route-tiers.ts src/daemon/internal-api/route-tiers.test.ts
git commit -m "feat(internal-api): per-route min-tier table + default-deny"
```

---

### Task 1.3: Enforce tier in the dispatcher

**Files:**
- Modify: `src/daemon/internal-api/index.ts` (the `createInternalApi` request handler: `authOk` → registry + tier check; register the file token; expose mint/invalidate on the returned object)
- Modify: `src/daemon/internal-api/types.ts` (extend `InternalApi` with `mintSessionToken` / `invalidateSession`)
- Test: `src/daemon/internal-api.test.ts` (new cases)

**Interfaces:**
- Consumes: `makeTokenRegistry` (1.1), `minTierFor`/`tierMeets` (1.2).
- Produces (on the `InternalApi` object returned by `createInternalApi`): `mintSessionToken(tier: UserTier, sessionKey: string): string`, `invalidateSession(sessionKey: string): void`.

- [ ] **Step 1: Write the failing test** (uses the real HTTP server, like the existing internal-api tests)

```ts
// add inside the existing describe in src/daemon/internal-api.test.ts
it('file token is trusted: 403 on an admin route, 200 on a trusted route', async () => {
  api = createInternalApi({ stateDir, daemonPid: 1, turns: makeTurnRecordStore(openTestDb()), listSessions: () => [] })
  const { port, tokenFilePath } = await api.start()
  const fileToken = readFileSync(tokenFilePath, 'utf8').trim()
  // admin route with the file (trusted) token → 403
  const r1 = await fetch(`http://127.0.0.1:${port}/v1/daemon/restart`, {
    method: 'POST', headers: { Authorization: `Bearer ${fileToken}`, 'content-type': 'application/json' }, body: '{}',
  })
  expect(r1.status).toBe(403)
  expect(await r1.json()).toMatchObject({ error: 'forbidden', required: 'admin' })
  // trusted route with the file token → not 403 (200/503 depending on wiring, just not forbidden)
  const r2 = await fetch(`http://127.0.0.1:${port}/v1/a2a/list`, { headers: { Authorization: `Bearer ${fileToken}` } })
  expect(r2.status).not.toBe(403)
})

it('a minted admin session token reaches an admin route; invalidate revokes it', async () => {
  api = createInternalApi({ stateDir, daemonPid: 1, requestRestart: () => {} })
  const { port } = await api.start()
  const adminTok = api.mintSessionToken('admin', 'claude/a/chat-1')
  const ok = await fetch(`http://127.0.0.1:${port}/v1/daemon/restart`, {
    method: 'POST', headers: { Authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' }, body: '{}',
  })
  expect(ok.status).toBe(200)
  api.invalidateSession('claude/a/chat-1')
  const revoked = await fetch(`http://127.0.0.1:${port}/v1/daemon/restart`, {
    method: 'POST', headers: { Authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' }, body: '{}',
  })
  expect(revoked.status).toBe(401) // unknown token now
})
```

- [ ] **Step 2: Run test — FAIL** (`api.mintSessionToken` undefined; restart route returns 200 to the file token today).

Run: `bun --bun vitest run src/daemon/internal-api.test.ts -t "file token is trusted"`

- [ ] **Step 3: Implement** — in `src/daemon/internal-api/index.ts`:

  1. Import: `import { makeTokenRegistry } from './token-registry'` and `import { minTierFor, tierMeets } from './route-tiers'`.
  2. In `createInternalApi`, after `const tokenPath = ...`, add `const registry = makeTokenRegistry()`.
  3. Where the file token is generated/loaded into `token` (the existing boot-token code that sets `token: Buffer`), after it's set, also `registry.registerFileToken(token.toString('hex'))`. (Re-register on rotation if the token is rewritten.)
  4. Replace the `authOk(req)` gate with a resolve + tier check:

```ts
// replace the `if (!authOk(req)) {...}` block
const presented = (() => {
  const m = /^Bearer\s+([0-9a-f]+)$/i.exec(req.headers.authorization ?? '')
  return m ? m[1]!.toLowerCase() : null
})()
const caller = presented ? registry.resolve(presented) : null
if (!caller) {
  deps.log?.('INTERNAL_API', `401 ${req.method} ${req.url}`, { event: 'auth_rejected', method: req.method, url: req.url })
  return send(res, 401, { error: 'unauthorized' }, origin)
}
```

  5. After the route is found (`const route = ROUTES[key]`, with `key = \`${method} ${url.pathname}\``), add the tier gate BEFORE body parsing:

```ts
const need = minTierFor(key)
if (!tierMeets(caller.tier, need)) {
  deps.log?.('INTERNAL_API', `403 ${key} caller=${caller.tier} need=${need}`, { event: 'tier_denied', path: key, caller: caller.tier, required: need })
  return send(res, 403, { error: 'forbidden', required: need }, origin)
}
```

  6. Delete the now-unused `authOk` function.
  7. On the returned `InternalApi` object, add: `mintSessionToken: (tier, sessionKey) => registry.mint(tier, sessionKey)` and `invalidateSession: (sessionKey) => registry.invalidateSession(sessionKey)`.

  In `src/daemon/internal-api/types.ts`, extend the `InternalApi` interface:

```ts
// add to interface InternalApi
mintSessionToken(tier: import('../../core/user-tier').UserTier, sessionKey: string): string
invalidateSession(sessionKey: string): void
```

- [ ] **Step 4: Run tests — PASS** (the two new cases + the existing internal-api suite).

Run: `bun --bun vitest run src/daemon/internal-api.test.ts`
Expected: PASS. Existing tests that used the file token on `GET /v1/health` / a2a still pass (those routes are ≤ trusted). If any existing test used the file token on an admin route (turns/sessions/model/release/restart), it now gets 403 — update that test to mint an admin token via `api.mintSessionToken('admin', 'test')` and use it. Expected such updates: the turns/sessions/model/release/restart tests added earlier.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/internal-api/index.ts src/daemon/internal-api/types.ts src/daemon/internal-api.test.ts
git commit -m "feat(internal-api): enforce per-route min tier; file token capped at trusted"
```

---

## Phase 2 — Provider-agnostic session-token seam

Mint a token per session and inject it into every provider's MCP children.

### Task 2.1: `SpawnContext.sessionToken`

**Files:**
- Modify: `src/core/agent-provider.ts` (the `SpawnContext` interface)
- Test: covered transitively (type-only); no standalone test.

**Interfaces:**
- Produces: `SpawnContext` gains `sessionToken?: string` (optional — older callers/tests omit it; providers treat absent as "no token to inject").

- [ ] **Step 1: Modify** `src/core/agent-provider.ts` — add to `interface SpawnContext`:

```ts
  /** Per-session internal-api token (env-only). Minted by the daemon from the
   *  session's resolved tier; each provider injects it into its stdio MCP
   *  children's env (WECHAT_SESSION_TOKEN) so route calls carry the tier. */
  sessionToken?: string
```

- [ ] **Step 2: Typecheck** — `tsc --noEmit` → clean (optional field, no callers break).
- [ ] **Step 3: Commit**

```bash
git add src/core/agent-provider.ts
git commit -m "feat(provider): SpawnContext.sessionToken contract"
```

### Task 2.2: Mint at spawn + invalidate on release

**Files:**
- Modify: `src/core/session-manager.ts` (`AcquireRequest` gains `sessionToken?`; `spawn()` forwards it into `SpawnContext`; `release()` is already present)
- Modify: `src/core/conversation-coordinator.ts` (mint a token from the resolved tier; pass it through `acquire`; invalidate on `handleTurnTimeout`/auth-fail release paths)
- Modify: `src/daemon/bootstrap/index.ts` (wire `mintSessionToken`/`invalidateSession` from the internal-api into the coordinator deps)
- Modify: `src/daemon/main.ts` (pass `internalApi.mintSessionToken`/`invalidateSession` into `buildBootstrap`)
- Test: `src/core/conversation-coordinator.test.ts` (mint called with the resolved tier + sessionKey; token forwarded to acquire)

**Interfaces:**
- Consumes: `InternalApi.mintSessionToken` / `invalidateSession` (1.3).
- Produces: `ConversationCoordinatorDeps` gains `mintSessionToken?(tier: UserTier, sessionKey: string): string` and `invalidateSession?(sessionKey: string): void`; `AcquireRequest` gains `sessionToken?: string`; the session-key string format is `\`${providerId}/${alias}/${chatId}\``.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/conversation-coordinator.test.ts — new case
it('mints a session token from the resolved tier and forwards it to acquire', async () => {
  const minted: Array<{ tier: string; key: string }> = []
  const acquire = vi.fn(async (req: AcquireRequest) => makeHandle(req.providerId, makeFakeSession({ events: [
    { kind: 'result', sessionId: 's', numTurns: 1, durationMs: 0 },
  ] })))
  const registry = createProviderRegistry()
  registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
  const c = createConversationCoordinator({
    resolveProject: () => ({ alias: 'a', path: '/p' }),
    manager: { acquire },
    conversationStore: makeMockStore(),
    registry, defaultProviderId: 'claude', format: () => 'x',
    permissionMode: 'strict', loadAccess: adminAccess, log: () => {},
    mintSessionToken: (tier, key) => { minted.push({ tier, key }); return `tok-${tier}` },
  })
  await c.dispatch(inbound('chat-1', 'hi'))
  expect(minted).toEqual([{ tier: 'admin', key: 'claude/a/chat-1' }]) // adminAccess → admin tier
  expect(acquire.mock.calls[0]![0].sessionToken).toBe('tok-admin')
})
```

- [ ] **Step 2: Run — FAIL** (`mintSessionToken` not a dep; `sessionToken` not forwarded).

Run: `bun --bun vitest run src/core/conversation-coordinator.test.ts -t "mints a session token"`

- [ ] **Step 3: Implement**

  - `src/core/session-manager.ts`: add `sessionToken?: string` to `AcquireRequest`; in `spawn()` where it calls `provider.spawn(project, { ... })`, add `sessionToken: req.sessionToken` to the SpawnContext object.
  - `src/core/conversation-coordinator.ts`:
    - In `ConversationCoordinatorDeps` add: `mintSessionToken?: (tier: UserTier, sessionKey: string) => string` and `invalidateSession?: (sessionKey: string) => void` (import `UserTier` from `./user-tier`).
    - In `dispatchSolo` (and `dispatchParallel` per-participant, and `dispatchChatroom` per-acquire), where the tier is resolved (`const tier = resolveEffectiveTier(...)`), compute `const sessionToken = deps.mintSessionToken?.(tier, \`${providerId}/${proj.alias}/${msg.chatId}\`)` and pass `sessionToken` into the `deps.manager.acquire({...})` call.
    - In `handleTurnTimeout` and `handleAuthFailed` (which call `deps.manager.release`), also call `deps.invalidateSession?.(\`${providerId}/${alias}/${chatId}\`)` so the token dies with the released session.
  - `src/daemon/bootstrap/index.ts`: `BootstrapDeps` gains optional `mintSessionToken?`/`invalidateSession?`; pass them into `createConversationCoordinator({ ..., mintSessionToken: deps.mintSessionToken, invalidateSession: deps.invalidateSession })`.
  - `src/daemon/main.ts`: in the `buildBootstrap({...})` call, add `mintSessionToken: internalApi.mintSessionToken, invalidateSession: internalApi.invalidateSession`.

- [ ] **Step 4: Run — PASS** (new case + existing coordinator suite; absent mint dep is a no-op for tests that omit it).

Run: `bun --bun vitest run src/core/conversation-coordinator.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/session-manager.ts src/core/conversation-coordinator.ts src/core/conversation-coordinator.test.ts src/daemon/bootstrap/index.ts src/daemon/main.ts
git commit -m "feat(coordinator): mint per-session token from tier, invalidate on release"
```

### Task 2.3: Claude injection (replaces WECHAT_SESSION_ADMIN)

**Files:**
- Modify: `src/daemon/bootstrap/index.ts` (`sdkOptionsForProject` — put `WECHAT_SESSION_TOKEN` + `WECHAT_SESSION_TIER` into the wechat AND delegate MCP env from `ctx`/tierProfile; remove the `WECHAT_SESSION_ADMIN` block)
- Test: there is no direct unit test for `sdkOptionsForProject`; covered by the integration test in Phase 3 (the MCP child registers admin tools only when tier=admin). Typecheck gates this task.

**Interfaces:**
- Consumes: the per-spawn `tierProfile` + the (new) `sessionToken`. NOTE: `sdkOptionsForProject` currently receives `(_alias, path, tierProfile, chatId)` — extend its signature to also receive `sessionToken` (thread it from the claude provider's spawn, which has `ctx.sessionToken`). Confirm the claude provider passes spawn opts into `sdkOptionsForProject`; if not, derive the tier name from `tierProfile` via a helper `tierName(tierProfile)` and read the token from `ctx`.

- [ ] **Step 1: Implement** — in `sdkOptionsForProject`, replace the `WECHAT_SESSION_ADMIN` derivation + `wechatEnv` block with:

```ts
// tier name from the profile (admin allows daemon_introspect; trusted/guest deny)
const tierName: 'admin' | 'trusted' | 'guest' =
  tierProfile.allow.has('daemon_introspect') ? 'admin'
  : tierProfile.deny.has('fs_write') ? 'guest'  // guest denies fs_write; trusted allows it
  : 'trusted'
const sessionEnv: Record<string, string> = {
  ...(sessionToken ? { WECHAT_SESSION_TOKEN: sessionToken } : {}),
  WECHAT_SESSION_TIER: tierName,
}
const wechatEnv = wechatStdioForClaude ? { ...wechatStdioForClaude.env, ...sessionEnv } : undefined
const delegateEnv = delegateStdioForClaude ? { ...delegateStdioForClaude.env, ...sessionEnv } : undefined
```

  and in the `mcpServers` object set `wechat: { type: 'stdio' as const, ...wechatStdioForClaude, env: wechatEnv! }` and `delegate: { type: 'stdio' as const, ...delegateStdioForClaude, env: delegateEnv! }`.

  Thread `sessionToken` into `sdkOptionsForProject` (add a parameter; the claude provider's `spawn` already calls it — pass `ctx.sessionToken`). If the call site is inside the claude provider, the simplest path is to make `sdkOptionsForProject` a closure over nothing and pass `(alias, path, tierProfile, chatId, sessionToken)`.

- [ ] **Step 2: Typecheck** — `tsc --noEmit` → clean.
- [ ] **Step 3: Commit**

```bash
git add src/daemon/bootstrap/index.ts
git commit -m "feat(bootstrap): inject WECHAT_SESSION_TOKEN+TIER for claude (drop WECHAT_SESSION_ADMIN)"
```

### Task 2.4: Codex injection

**Files:**
- Modify: `src/core/codex-agent-provider.ts` (in `spawn()`, where it builds `config.mcp_servers = opts.mcpServers`, merge `{WECHAT_SESSION_TOKEN, WECHAT_SESSION_TIER}` into each stdio server's `env`)
- Test: `src/core/codex-agent-provider.test.ts` (spawn with a `sessionToken` + an admin tierProfile → the wechat mcp server config carries the env)

**Interfaces:**
- Consumes: `SpawnContext.sessionToken` + `spawnOpts.tierProfile`.

- [ ] **Step 1: Write the failing test** (mirror an existing codex spawn test; assert the env merge)

```ts
// src/core/codex-agent-provider.test.ts — new case
it('merges WECHAT_SESSION_TOKEN/TIER into its stdio MCP servers env on spawn', async () => {
  const { provider, fake } = provider()  // existing helper returning a fake codex SDK
  await provider.spawn({ alias: 'a', path: '/p' }, {
    tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'c', sessionToken: 'tok-1',
  })
  const wechat = fake.startThreadCalls[0]!.config.mcp_servers.wechat
  expect(wechat.env).toMatchObject({ WECHAT_SESSION_TOKEN: 'tok-1', WECHAT_SESSION_TIER: 'admin' })
})
```

(Adapt to the existing codex test's fake shape — it already inspects `startThreadCalls[0].config`/`sandboxMode`. Use the same accessor for `mcp_servers`. The provider must be constructed with a wechat mcp server in `opts.mcpServers`.)

- [ ] **Step 2: Run — FAIL.**

Run: `bun --bun vitest run src/core/codex-agent-provider.test.ts -t "merges WECHAT_SESSION"`

- [ ] **Step 3: Implement** — in `spawn()`, where `config.mcp_servers` is set from `opts.mcpServers`, deep-merge the session env:

```ts
const tierName = spawnOpts.tierProfile.allow.has('daemon_introspect') ? 'admin'
  : spawnOpts.tierProfile.deny.has('fs_write') ? 'guest' : 'trusted'
const sessionEnv: Record<string, string> = {
  ...(spawnOpts.sessionToken ? { WECHAT_SESSION_TOKEN: spawnOpts.sessionToken } : {}),
  WECHAT_SESSION_TIER: tierName,
}
const mcpWithEnv = Object.fromEntries(Object.entries(opts.mcpServers ?? {}).map(([name, srv]) => [
  name, { ...(srv as Record<string, unknown>), env: { ...((srv as { env?: Record<string,string> }).env ?? {}), ...sessionEnv } },
]))
config.mcp_servers = mcpWithEnv as unknown as Record<string, never>
```

- [ ] **Step 4: Run — PASS** (new case + existing codex suite, incl. the sandbox tests).

Run: `bun --bun vitest run src/core/codex-agent-provider.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/codex-agent-provider.ts src/core/codex-agent-provider.test.ts
git commit -m "feat(codex): inject per-session token+tier into MCP children env on spawn"
```

### Task 2.5: Cursor injection

**Files:**
- Modify: `src/core/cursor-agent-provider.ts` (in `spawn`, merge the same `sessionEnv` into the wechat/delegate MCP server env passed to `Agent.create`)
- Test: `src/core/cursor-agent-provider.test.ts` (new case mirroring 2.4)

- [ ] **Step 1: Write the failing test** (mirror 2.4 against the cursor fake SDK's recorded `mcpServers`/options).
- [ ] **Step 2: Run — FAIL.**

Run: `bun --bun vitest run src/core/cursor-agent-provider.test.ts -t "session token"`

- [ ] **Step 3: Implement** the same `tierName` + `sessionEnv` merge into cursor's per-spawn MCP server env (the exact field name follows cursor's `Agent.create` options shape used in the existing provider).
- [ ] **Step 4: Run — PASS.**

Run: `bun --bun vitest run src/core/cursor-agent-provider.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/cursor-agent-provider.ts src/core/cursor-agent-provider.test.ts
git commit -m "feat(cursor): inject per-session token+tier into MCP children env on spawn"
```

---

## Phase 3 — MCP children use the token

### Task 3.1: wechat client prefers the session token

**Files:**
- Modify: `src/mcp-servers/wechat/client.ts` (`readToken`: prefer `WECHAT_SESSION_TOKEN` env; fall back to the file)
- Test: `src/mcp-servers/wechat/client.test.ts` (env wins over file)

**Interfaces:**
- Consumes: `WECHAT_SESSION_TOKEN` env.

- [ ] **Step 1: Write the failing test**

```ts
// src/mcp-servers/wechat/client.test.ts — new case
it('uses WECHAT_SESSION_TOKEN env over the token file when present', async () => {
  process.env.WECHAT_SESSION_TOKEN = 'sess-tok'
  const seen: string[] = []
  const client = createInternalApiClient({
    baseUrl: 'http://x', tokenFilePath: '/no/such/file',
    fetchImpl: async (_u, init) => { seen.push((init!.headers as Record<string,string>).Authorization); return new Response('{}', { headers: { 'content-type': 'application/json' } }) },
  })
  await client.request('GET', '/v1/health')
  delete process.env.WECHAT_SESSION_TOKEN
  expect(seen[0]).toBe('Bearer sess-tok')
})
```

- [ ] **Step 2: Run — FAIL** (reads the file, which doesn't exist → throws).

Run: `bun --bun vitest run src/mcp-servers/wechat/client.test.ts -t "WECHAT_SESSION_TOKEN"`

- [ ] **Step 3: Implement** — `readToken()`:

```ts
function readToken(): string {
  const fromEnv = process.env.WECHAT_SESSION_TOKEN
  if (fromEnv && fromEnv.trim()) { cachedToken = fromEnv.trim(); return cachedToken }
  const t = readFileSync(opts.tokenFilePath, 'utf8').trim()
  cachedToken = t
  return t
}
```

(The 401-rotation retry still re-reads via `readToken`, which re-checks env first — correct: a session token doesn't rotate, the file might.)

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/mcp-servers/wechat/client.ts src/mcp-servers/wechat/client.test.ts
git commit -m "feat(wechat-mcp): prefer per-session token env over the file token"
```

### Task 3.2: wechat registration gate on tier (replace WECHAT_SESSION_ADMIN)

**Files:**
- Modify: `src/mcp-servers/wechat/main.ts` (`SESSION_IS_ADMIN` derives from `WECHAT_SESSION_TIER === 'admin'` instead of `WECHAT_SESSION_ADMIN === '1'`)
- Modify: `src/mcp-servers/wechat/integration.test.ts` (boot env uses `WECHAT_SESSION_TIER`/`WECHAT_SESSION_TOKEN` instead of `WECHAT_SESSION_ADMIN`)

- [ ] **Step 1: Implement** — in `src/mcp-servers/wechat/main.ts` replace:

```ts
const SESSION_IS_ADMIN = process.env.WECHAT_SESSION_TIER === 'admin'
```

  (Comment update: the daemon bakes `WECHAT_SESSION_TIER` next to the secret `WECHAT_SESSION_TOKEN`; tier is non-secret, the token is the secret.)

- [ ] **Step 2: Update the integration test** — in `bootChain`, replace the `WECHAT_SESSION_ADMIN` handling: `delete baseEnv.WECHAT_SESSION_TIER`, and `...(opts.admin ? { WECHAT_SESSION_TIER: 'admin', WECHAT_SESSION_TOKEN: 'test-admin-tok' } : { WECHAT_SESSION_TIER: 'trusted' })`. The admin-gating assertions stay (admin → 7 tools, non-admin → 0).
- [ ] **Step 3: Run — PASS.**

Run: `bun --bun vitest run src/mcp-servers/wechat/integration.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/mcp-servers/wechat/main.ts src/mcp-servers/wechat/integration.test.ts
git commit -m "feat(wechat-mcp): gate admin tools on WECHAT_SESSION_TIER (drop WECHAT_SESSION_ADMIN)"
```

### Task 3.3: delegate child carries the token

**Files:**
- Modify: `src/mcp-servers/delegate/main.ts` (its internal-api client already reads the token file via the shared `createInternalApiClient`; confirm it picks up `WECHAT_SESSION_TOKEN` from 3.1 — if it constructs its own client, no change is needed since 3.1 fixed the shared helper)
- Test: none new if it reuses `createInternalApiClient` (covered by 3.1). If it reads the token differently, add a parallel case.

- [ ] **Step 1: Inspect** `src/mcp-servers/delegate/main.ts` — confirm it uses `createInternalApiClient` (then 3.1 already covers it). If yes, no code change; if it reads env/file directly, apply the same env-first preference.
- [ ] **Step 2: Run** the delegate test if present; otherwise typecheck.
- [ ] **Step 3: Commit** (only if changed)

```bash
git add src/mcp-servers/delegate/main.ts
git commit -m "feat(delegate-mcp): carry per-session token (env-first)"
```

---

## Phase 4 — CLI, cleanup, verification

### Task 4.1: CLI stays within trusted

**Files:**
- Verify: `src/cli/agent.ts`, `src/cli/doctor.ts` (the only internal-api callers) — confirm every route they hit is `≤ trusted` in `ROUTE_MIN_TIER`.
- Test: a small assertion that the CLI's route set is all `≤ trusted`.

- [ ] **Step 1: Enumerate** the CLI's internal-api routes: `grep -rhoE "/v1/[a-z/_-]+" src/cli/*.ts | sort -u`. Cross-check each against `ROUTE_MIN_TIER` — each must be `guest` or `trusted`.
- [ ] **Step 2: Write a guard test**

```ts
// src/cli/cli-routes.test.ts
import { describe, it, expect } from 'vitest'
import { ROUTE_MIN_TIER, tierMeets } from '../daemon/internal-api/route-tiers'
// The routes the operator CLI calls (keep in sync with src/cli/*.ts):
const CLI_ROUTES = ['GET /v1/a2a/list','GET /v1/a2a/info','GET /v1/a2a/activity','POST /v1/a2a/install','POST /v1/a2a/remove','POST /v1/a2a/pause','POST /v1/a2a/preview','POST /v1/a2a/test','GET /v1/health']
describe('CLI is capped at trusted', () => {
  it('every CLI route is reachable at trusted tier', () => {
    for (const r of CLI_ROUTES) expect(tierMeets('trusted', ROUTE_MIN_TIER[r] ?? 'admin'), `${r}`).toBe(true)
  })
})
```

  (Populate `CLI_ROUTES` from Step 1's actual grep output.)

- [ ] **Step 3: Run — PASS.** If a CLI route is `admin`, either lower its tier in `ROUTE_MIN_TIER` (if operator-appropriate) or remove that CLI command (out of scope — flag it).
- [ ] **Step 4: Commit**

```bash
git add src/cli/cli-routes.test.ts
git commit -m "test(cli): assert the CLI route set stays within trusted tier"
```

### Task 4.2: Remove WECHAT_SESSION_ADMIN remnants + full green

**Files:**
- Verify: `grep -rn WECHAT_SESSION_ADMIN src/` returns nothing (all replaced by `WECHAT_SESSION_TIER`/`WECHAT_SESSION_TOKEN`).

- [ ] **Step 1:** `grep -rn "WECHAT_SESSION_ADMIN" src/` → expect no matches. Remove any stragglers.
- [ ] **Step 2:** Run the full suite + typecheck.

```bash
tsc --noEmit && bun --bun vitest run --testTimeout=20000
```
Expected: typecheck clean; full suite green (fix any test that authenticated an admin route with the file token — mint an admin session token instead).

- [ ] **Step 3: Commit** (if any stragglers/test fixes)

```bash
git add -A
git commit -m "chore(authz): remove WECHAT_SESSION_ADMIN remnants; suite green"
```

### Task 4.3: Real-daemon shell-curl → 403 verification

Not a test file — a runtime verification, captured as evidence (per the verify skill).

- [ ] **Step 1:** Boot an isolated real daemon (fake account, dead `baseUrl`, own `WECHAT_CC_STATE_DIR`) as in the round-2 verification.
- [ ] **Step 2:** Read the file token from `<stateDir>/internal-token`. `curl -X POST .../v1/daemon/restart` with it → expect **403 forbidden required:admin** (proves the file token can't escalate). `curl .../v1/a2a/list` with it → not 403 (trusted route reachable).
- [ ] **Step 3:** Capture both responses in the report. Tear down the daemon + temp state.
- [ ] **Step 4:** No commit (verification only); record the evidence in the PR/notes.

---

## Self-Review

**Spec coverage:**
- §2 core model (file token=trusted, admin only from session token) → Tasks 1.1, 1.3, 2.2, 2.3.
- §3.1 registry → 1.1; §3.2 seam → 2.1/2.2 + 2.3/2.4/2.5; §3.3 route table+enforcement → 1.2/1.3; §3.4 lifecycle (mint/invalidate) → 2.2.
- §4 provider injection (claude/codex/cursor/gemini) → 2.3/2.4/2.5 (gemini is the contract only, 2.1).
- §5 route tier table → 1.2.
- §6 CLI capped at trusted + O1 (`WECHAT_SESSION_TIER` next to token) → 4.1 + 3.2.
- §7 delegate → 3.3; §8 migration (file token works, drop WECHAT_SESSION_ADMIN) → 3.1/3.2/4.2.
- §9 testing incl. real-daemon shell-curl→403 → 4.3 + per-task tests.

**Placeholder scan:** No "TBD"/"handle errors"/"similar to". One inspection-only step (3.3) gated on what the delegate child does — it carries the concrete branch ("if it uses createInternalApiClient, no change").

**Type consistency:** `mintSessionToken(tier, sessionKey)` / `invalidateSession(sessionKey)` consistent across 1.3 (InternalApi), 2.2 (coordinator deps), main.ts wiring. Session-key format `\`${providerId}/${alias}/${chatId}\`` used identically in 2.2 mint + invalidate. `WECHAT_SESSION_TOKEN` / `WECHAT_SESSION_TIER` names consistent across 2.3/2.4/2.5/3.1/3.2.

**Known follow-the-rule items** (not placeholders — concrete rules): §5 row finalization via the derivation rule (1.2 has the full explicit table already); the `tierName(tierProfile)` derivation appears 3× (2.3/2.4/2.5) — during implementation, extract it to a shared helper `tierNameFromProfile(tp): UserTier` in `user-tier.ts` and import it in all three (DRY), with a unit test (`admin`/`trusted`/`guest` profiles → correct name).
