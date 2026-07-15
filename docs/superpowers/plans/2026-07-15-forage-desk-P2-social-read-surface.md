# 觅食台 P2 — Internal-API Social Read Surface + Inbound Toggle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the P1 seek/echo state + an inbound on/off toggle over the daemon's internal-api, so the desktop 觅食台 (P3) has something to read and operate — replacing the "hand-edit agent-config.json" instructions with real routes.

**Architecture:** Surface P1's `seekStore`/`echoStore` on `boot.social` and `InternalApiDeps.social`, then add read routes (`GET /v1/social/seeks`, `GET /v1/social/echoes`) that return the stored rows, plus an inbound toggle (`GET`/`POST /v1/social/inbound`) that reads/writes `agent-config.json`'s `a2a_listen` via the existing `loadAgentConfig`/`saveAgentConfig` helpers. No new persistence; all reads hit P1's stores.

**Tech Stack:** TypeScript, Bun, Vitest. The internal-api route table (`src/daemon/internal-api/*`).

## Global Constraints

- Reveal ("揭晓牵线") is **OUT OF SCOPE**: P1's `broker.seek` is synchronous — dual-confirm already happens inside the seek — so there is no "reveal a pending echo later" action yet. That waits for the async-foraging rework. P2 is **read + inbound toggle only**.
- New routes are **admin-tiered** (matching `POST /v1/social/seek: 'admin'` in `route-tiers.ts:99`) — the social surface is admin-only. Every new route MUST be added to the tier map or it is unreachable.
- Reuse existing patterns verbatim: route handlers return `{ status, body }` (see `routes-social.ts`); config mutation is load→mutate→save→read-back (see `routes-daemon-control.ts:77`, `saveAgentConfig` at `agent-config.ts:235`).
- Do not change `broker.seek`, the grounded judge, the disclosure gate, or P1's stores.
- P1 store shapes (already shipped, `src/core/social-seek-store.ts` / `social-echo-store.ts`): `SeekRow = { id, kind, topic, status, hop, peers_asked, created_at, updated_at }`, `SeekStore.list()`; `EchoRow = { id, seek_id, peer_masked, degree, content, status, created_at }`, `EchoStore.listAll()`.

---

## File Structure

- **Modify** `src/daemon/bootstrap/index.ts` — add `seekStore`/`echoStore` to the `boot.social` object (assembled at ~`:1621`; shape doc at ~`:390`; stores already constructed at ~`:1377`).
- **Modify** `src/daemon/internal-api/types.ts` — add `seekStore`/`echoStore` to `InternalApiDeps.social` (~`:205`).
- **Modify** `src/daemon/internal-api/routes-social.ts` — add the read routes + the inbound toggle.
- **Modify** `src/daemon/internal-api/route-tiers.ts` — tier the new routes `'admin'`.
- **Test** `src/daemon/internal-api.test.ts` (or the social route test file) — route tests.

---

## Task 1: Surface `seekStore` + `echoStore` on the social deps

**Files:**
- Modify: `src/daemon/bootstrap/index.ts` (social shape ~`:390`, assembly ~`:1621`)
- Modify: `src/daemon/internal-api/types.ts` (~`:205`)
- Test: `src/daemon/bootstrap.test.ts`

**Interfaces:**
- Consumes: `SeekStore` (`src/core/social-seek-store.ts`), `EchoStore` (`src/core/social-echo-store.ts`), already constructed as `seekStore`/`echoStore` in the social block.
- Produces: `boot.social` and `InternalApiDeps.social` gain `seekStore: SeekStore` and `echoStore: EchoStore`.

- [ ] **Step 1: Write the failing test** — add to `src/daemon/bootstrap.test.ts` (reuse the existing social-enabled fixture — the test at the block that asserts `boot.social!.broker.seek`):

```ts
it('exposes seekStore + echoStore on boot.social', async () => {
  // …build bootstrap with social enabled (reuse the social fixture)…
  expect(typeof boot.social!.seekStore.list).toBe('function')
  expect(typeof boot.social!.echoStore.listAll).toBe('function')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/daemon/bootstrap.test.ts`
Expected: FAIL — `boot.social.seekStore` is undefined.

- [ ] **Step 3: Thread the stores through**

In `src/daemon/bootstrap/index.ts`:
- The `boot.social` shape (the `social?: { broker; pendingConfirms }` type doc ~`:390`): add `seekStore: import('../../core/social-seek-store').SeekStore` and `echoStore: import('../../core/social-echo-store').EchoStore`.
- The assembly (~`:1621`, `...(socialBroker ? { social: { broker: socialBroker, pendingConfirms: socialPendingConfirms! } } : {})`): add `seekStore, echoStore` (the locals already exist from ~`:1377`). It becomes `{ broker: socialBroker, pendingConfirms: socialPendingConfirms!, seekStore, echoStore }`.

In `src/daemon/internal-api/types.ts` (`InternalApiDeps.social` ~`:205`): add the same two fields, typed the same way.

`main.ts:288`'s `internalApi.setSocial(boot.social)` passes the whole object unchanged — no edit needed.

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/daemon/bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/bootstrap/index.ts src/daemon/internal-api/types.ts src/daemon/bootstrap.test.ts
git commit -m "feat(social): expose seekStore/echoStore on the social deps (觅食台 P2)"
```

---

## Task 2: Read routes — `GET /v1/social/seeks` + `GET /v1/social/echoes`

**Files:**
- Modify: `src/daemon/internal-api/routes-social.ts`
- Modify: `src/daemon/internal-api/route-tiers.ts`
- Test: `src/daemon/internal-api.test.ts` (mirror an existing social/a2a route test)

**Interfaces:**
- Consumes: `deps.social.seekStore.list()` → `SeekRow[]`, `deps.social.echoStore.listAll()` → `EchoRow[]` (Task 1).
- Produces: `GET /v1/social/seeks` → `{ seeks: SeekRow[] }`; `GET /v1/social/echoes` → `{ echoes: EchoRow[] }`; `503 { error: 'social_not_wired' }` when `deps.social` is absent.

- [ ] **Step 1: Write the failing test** — add to the internal-api route tests (mirror how the existing `POST /v1/social/seek` / a2a route tests build the app + a `deps.social` stub). Provide a `deps.social` whose `seekStore.list()` returns one row and assert the route echoes it, and assert 503 without `deps.social`:

```ts
it('GET /v1/social/seeks returns the stored seeks (503 when social not wired)', async () => {
  const row = { id: 'k1', kind: 'seek', topic: '找个会修老相机的', status: 'foraging', hop: 1, peers_asked: 0, created_at: 't', updated_at: 't' }
  // app with deps.social = { broker, pendingConfirms, seekStore: { list: () => [row], … }, echoStore: { listAll: () => [], … } }
  const ok = await callRoute('GET', '/v1/social/seeks')   // use the test's existing route-call helper
  expect(ok).toEqual({ seeks: [row] })
  // app with deps.social = undefined
  const resp = await callRoute503('GET', '/v1/social/seeks')
  expect(resp.status).toBe(503)
})
```

> Use the SAME test harness the existing social/a2a route tests use (grep the file for `/v1/social/seek` or `/v1/a2a/list` to copy the app-construction + call idiom, including the admin token/tier setup, since these routes are admin-tiered).

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/daemon/internal-api.test.ts`
Expected: FAIL — route not defined (404 / no match).

- [ ] **Step 3: Add the routes** — in `src/daemon/internal-api/routes-social.ts`, inside the returned `RouteTable`, after `'POST /v1/social/seek'`:

```ts
    'GET /v1/social/seeks': async () => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      return { status: 200, body: { seeks: deps.social.seekStore.list() } }
    },
    'GET /v1/social/echoes': async () => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      return { status: 200, body: { echoes: deps.social.echoStore.listAll() } }
    },
```

In `src/daemon/internal-api/route-tiers.ts`, next to `'POST /v1/social/seek': 'admin'`:

```ts
  'GET /v1/social/seeks': 'admin',
  'GET /v1/social/echoes': 'admin',
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/daemon/internal-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/internal-api/routes-social.ts src/daemon/internal-api/route-tiers.ts src/daemon/internal-api.test.ts
git commit -m "feat(social): GET /v1/social/seeks + /echoes read routes (觅食台 P2)"
```

---

## Task 3: Inbound toggle — `GET` + `POST /v1/social/inbound`

**Files:**
- Modify: `src/daemon/internal-api/routes-social.ts`
- Modify: `src/daemon/internal-api/route-tiers.ts`
- Test: `src/daemon/internal-api.test.ts`

**Interfaces:**
- Consumes: `loadAgentConfig(deps.stateDir)` / `saveAgentConfig(deps.stateDir, cfg)` (`src/lib/agent-config.ts:235`), the `a2a_listen?: { host: string; port: number }` field on `AgentConfig` (see `bootstrap/index.ts:1467-1470`).
- Produces: `GET /v1/social/inbound` → `{ enabled: boolean, host?: string, port?: number }`; `POST /v1/social/inbound` body `{ enabled: boolean }` → writes/removes `a2a_listen`, returns `{ enabled: boolean, restart_required: true }`.

- [ ] **Step 1: Write the failing test** — add a test that POSTs `{enabled:true}` then GETs and sees it enabled, using a temp state dir (mirror `routes-daemon-control` tests that call `saveAgentConfig`):

```ts
it('POST /v1/social/inbound {enabled:true} persists a2a_listen; GET reflects it', async () => {
  // temp stateDir with a minimal agent-config.json (reuse the daemon-control test setup)
  const post = await callRoute('POST', '/v1/social/inbound', { enabled: true })
  expect(post).toEqual({ enabled: true, restart_required: true })
  const cfg = loadAgentConfig(stateDir)
  expect(cfg.a2a_listen).toEqual({ host: '127.0.0.1', port: 8717 })
  const get = await callRoute('GET', '/v1/social/inbound')
  expect(get).toEqual({ enabled: true, host: '127.0.0.1', port: 8717 })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/daemon/internal-api.test.ts`
Expected: FAIL — route not defined.

- [ ] **Step 3: Add the routes** — in `routes-social.ts` (import `loadAgentConfig, saveAgentConfig` from `'../../lib/agent-config'` at the top):

```ts
    'GET /v1/social/inbound': async () => {
      const l = loadAgentConfig(deps.stateDir).a2a_listen
      return { status: 200, body: l ? { enabled: true, host: l.host, port: l.port } : { enabled: false } }
    },
    'POST /v1/social/inbound': async (_q, body) => {
      const enabled = !!(body as { enabled?: unknown }).enabled
      const cfg = loadAgentConfig(deps.stateDir)
      const updated = enabled
        ? { ...cfg, a2a_listen: { host: '127.0.0.1', port: 8717 } }
        : (() => { const { a2a_listen, ...rest } = cfg; return rest })()
      saveAgentConfig(deps.stateDir, updated)
      return { status: 200, body: { enabled, restart_required: true } }
    },
```

In `route-tiers.ts`:

```ts
  'GET /v1/social/inbound': 'admin',
  'POST /v1/social/inbound': 'admin',
```

> `restart_required: true` because the A2A server binds `a2a_listen` at boot (`bootstrap/index.ts:1467`); a live rebind is the async-rework's concern, not P2. The desktop shows the toggle + a "restart to apply" hint (P3). Port `8717` matches the current in-UI instruction; host `127.0.0.1` — real cross-machine reachability (a tunnel) is a separate infra concern (spec non-goal).

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/daemon/internal-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Full green check + commit**

Run: `bun run typecheck` (0), `bun run test` (green), `bun run depcheck` (0).

```bash
git add src/daemon/internal-api/routes-social.ts src/daemon/internal-api/route-tiers.ts src/daemon/internal-api.test.ts
git commit -m "feat(social): GET/POST /v1/social/inbound toggle (觅食台 P2)

Replaces hand-editing agent-config.json's a2a_listen with an admin route;
restart_required until the async rework can live-rebind."
```

---

## Follow-ons (out of scope; documented)

- **P3** — desktop 觅食台 page consuming these routes (the OTHER session's desktop domain; hand off with the mockup + spec).
- **P4** — WeChat seek-creation-with-confirm flow.
- **Reveal action + async foraging** — the "揭晓牵线" route + the async broker rework (record seek → background forage → trickle echoes → reveal later). Biggest follow-up; its own design.

## Self-Review notes (author)

- **Spec coverage:** spec's "internal-api social surface (read seeks/echoes + inbound status)" → Tasks 2-3; store exposure it presumed → Task 1. Reveal action explicitly deferred (Global Constraints) because P1 is synchronous.
- **Placeholder scan:** route bodies + tier entries are complete code; the test steps point at the existing social/a2a and daemon-control test harnesses to copy (concrete same-file references, not vague TODOs) because the app-construction/token idiom already exists there and must be matched exactly.
- **Type consistency:** `seekStore.list()`/`echoStore.listAll()` match the P1 `SeekStore`/`EchoStore` interfaces; `a2a_listen: {host,port}` matches the shape read at `bootstrap/index.ts:1469-1470`.
