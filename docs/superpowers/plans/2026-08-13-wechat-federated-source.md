# wechat-cc hearth federated source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let hearth federate to wechat-cc's `federated_query` by adding an authorized launcher: a grant-gated internal-api mint route that mints a short-lived admin-tier token, a slim MCP exposing only `federated_query`, and a `wechat-cc federated-source` CLI subcommand.

**Architecture:** Explicit owner grant (`federated-grant.json`, 0600) + operator-token + loopback gate a new `POST /v1/federation/mint` route that calls the existing `mintSessionToken('admin', …)`. The CLI run-mode reads `internal-api-info.json`, mints via that route with the operator token, and serves a slim stdio MCP (only `federated_query`) whose internal-api client uses the minted admin token as bearer. hearth registers the CLI as a source.

**Tech Stack:** Bun + TypeScript, `@modelcontextprotocol/sdk` (`McpServer`), `citty` (CLI), vitest for tests. Internal-api reuse: `InternalApiDeps.mintSessionToken`/`.stateDir`, `createInternalApiClient`, `registerFederatedQueryTool`.

## Global Constraints

- **Work in the worktree** `scratchpad/wc-fed-wt` (branch `feat/wechat-federated-source` off `dev`). NEVER checkout branches in the main wechat-cc working tree (a concurrent dmg session holds it).
- **Tests use vitest**, run with `bun --bun vitest run <path>` (NOT `bun test`). Mirror the imports/harness of an existing sibling test (e.g. `src/daemon/internal-api/routes-customer-review.test.ts`) — `import { describe, it, expect, vi } from 'vitest'`.
- **Security invariants (non-negotiable):**
  - The mint route returns a token ONLY when the grant exists; no grant → `403 federation_not_authorized`, and `mintSessionToken` is NOT called.
  - The token value is NEVER logged (audit logs the event + integration, never the token).
  - The slim MCP registers ONLY `federated_query` — no other tool.
  - Grant file is written mode `0600` (and `chmodSync` re-applied after write, since `writeFileSync` mode is create-only).
- **Least surprise:** the mint route is added to `route-tiers.ts` (`admin`) AND to the operator token's `routeAllow` set in `token-registry.ts` (mirror the `customer-review` operator-only precedent). Without the routeAllow entry the operator token gets `route_not_allowed`; without the admin tier a trusted token would pass — both gates are required.
- **Commits:** no `git add -A`; do not touch `package.json`/lockfiles. Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Non-goals:** durable/standing admin token, any wechat tool beyond `federated_query`, hearth code changes (registration is a sources.json step in the gate).

---

## File Structure
- Create `src/daemon/internal-api/federation-grant.ts` — grant helpers (Task 1)
- Create `src/daemon/internal-api/federation-grant.test.ts` (Task 1)
- Create `src/daemon/internal-api/routes-federation.ts` — mint route (Task 2)
- Create `src/daemon/internal-api/routes-federation.test.ts` (Task 2)
- Modify `src/daemon/internal-api/routes.ts` — spread `federationRoutes` (Task 2)
- Modify `src/daemon/internal-api/route-tiers.ts` — mint route tier (Task 2)
- Modify `src/daemon/internal-api/token-registry.ts` — operator routeAllow (Task 2)
- Create `src/mcp-servers/wechat/federated-source.ts` — slim MCP + mint client (Task 3)
- Create `src/mcp-servers/wechat/federated-source.test.ts` (Task 3)
- Modify `cli.ts` — `federated-source` subcommand (Task 4)
- Create `cli-federated-source.test.ts` (or colocated) (Task 4)

---

## Task 1: Grant helpers (`federation-grant.ts`)

**Files:** Create `src/daemon/internal-api/federation-grant.ts`, `src/daemon/internal-api/federation-grant.test.ts`

**Interfaces:**
- Produces:
  - `interface FederationGrant { integration: string; ts: number }`
  - `function grantPath(stateDir: string): string`
  - `function writeGrant(stateDir: string, ts: number, integration?: string): FederationGrant` (default integration `'hearth'`, file mode 0600)
  - `function readGrant(stateDir: string): FederationGrant | null` (missing/malformed → null)
  - `function revokeGrant(stateDir: string): boolean` (returns whether a file was removed)

- [ ] **Step 1: Write the failing test** (`federation-grant.test.ts`, vitest)

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grantPath, writeGrant, readGrant, revokeGrant } from './federation-grant'

const tmp = () => mkdtempSync(join(tmpdir(), 'fed-grant-'))

describe('federation-grant', () => {
  it('writeGrant creates a 0600 grant, readGrant round-trips', () => {
    const dir = tmp()
    const g = writeGrant(dir, 1234, 'hearth')
    expect(g).toEqual({ integration: 'hearth', ts: 1234 })
    expect(statSync(grantPath(dir)).mode & 0o777).toBe(0o600)
    expect(readGrant(dir)).toEqual({ integration: 'hearth', ts: 1234 })
  })
  it('readGrant returns null when missing or malformed', () => {
    const dir = tmp()
    expect(readGrant(dir)).toBeNull()
    writeFileSync(grantPath(dir), '{ not json', { mode: 0o600 })
    expect(readGrant(dir)).toBeNull()
  })
  it('writeGrant forces 0600 even if the file pre-exists at looser perms', () => {
    const dir = tmp()
    writeFileSync(grantPath(dir), '{}', { mode: 0o644 })
    writeGrant(dir, 1)
    expect(statSync(grantPath(dir)).mode & 0o777).toBe(0o600)
  })
  it('revokeGrant removes an existing grant, false when none', () => {
    const dir = tmp()
    expect(revokeGrant(dir)).toBe(false)
    writeGrant(dir, 1)
    expect(revokeGrant(dir)).toBe(true)
    expect(readGrant(dir)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `cd <worktree> && bun --bun vitest run src/daemon/internal-api/federation-grant.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/daemon/internal-api/federation-grant.ts`**

```ts
// Federation consent grant — the explicit, revocable record that the owner
// authorized hearth to obtain admin-tier tokens (design option B). The mint
// route (routes-federation.ts) requires this to exist; the CLI --authorize
// writes it. 0600, owner-only — same trust posture as the operator token.
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const GRANT_FILE = 'federated-grant.json'

export interface FederationGrant { integration: string; ts: number }

export function grantPath(stateDir: string): string {
  return join(stateDir, GRANT_FILE)
}

export function writeGrant(stateDir: string, ts: number, integration = 'hearth'): FederationGrant {
  const grant: FederationGrant = { integration, ts }
  const p = grantPath(stateDir)
  writeFileSync(p, JSON.stringify(grant, null, 2) + '\n', { mode: 0o600 })
  chmodSync(p, 0o600) // writeFileSync mode is create-only; force it on overwrite too
  return grant
}

export function readGrant(stateDir: string): FederationGrant | null {
  const p = grantPath(stateDir)
  if (!existsSync(p)) return null
  try {
    const g = JSON.parse(readFileSync(p, 'utf8')) as Partial<FederationGrant>
    if (typeof g?.integration === 'string' && typeof g?.ts === 'number') {
      return { integration: g.integration, ts: g.ts }
    }
    return null
  } catch {
    return null
  }
}

export function revokeGrant(stateDir: string): boolean {
  const p = grantPath(stateDir)
  if (!existsSync(p)) return false
  unlinkSync(p)
  return true
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd <worktree> && bun --bun vitest run src/daemon/internal-api/federation-grant.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/internal-api/federation-grant.ts src/daemon/internal-api/federation-grant.test.ts
git commit -m "feat(federation): consent grant helpers (0600, owner-only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Grant-gated mint route (SECURITY-CRITICAL)

**Files:**
- Create `src/daemon/internal-api/routes-federation.ts`, `src/daemon/internal-api/routes-federation.test.ts`
- Modify `src/daemon/internal-api/routes.ts` (spread the table)
- Modify `src/daemon/internal-api/route-tiers.ts` (tier for the route)
- Modify `src/daemon/internal-api/token-registry.ts` (operator routeAllow)

**Interfaces:**
- Consumes: `readGrant` from `./federation-grant`; `InternalApiDeps` (`.stateDir`, `.mintSessionToken`, `.log`) and `RouteTable` from `./types`.
- Produces: `function federationRoutes(deps: InternalApiDeps): RouteTable` exposing `POST /v1/federation/mint`.

- [ ] **Step 1: Write the failing test** (`routes-federation.test.ts`, vitest — mirror `routes-customer-review.test.ts`'s deps-stub style)

```ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { federationRoutes } from './routes-federation'
import { writeGrant } from './federation-grant'
import type { InternalApiDeps } from './types'

function depsWith(stateDir: string, mint = vi.fn(() => 'minted-admin-token')): InternalApiDeps {
  // Only the fields the route touches; cast through unknown like sibling tests do.
  return { stateDir, mintSessionToken: mint, log: vi.fn() } as unknown as InternalApiDeps
}

describe('POST /v1/federation/mint', () => {
  it('mints an admin token when the grant exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-mint-'))
    writeGrant(dir, 1)
    const mint = vi.fn(() => 'minted-admin-token')
    const routes = federationRoutes(depsWith(dir, mint))
    const out = await routes['POST /v1/federation/mint']!(new URLSearchParams(), {})
    expect(out.status).toBe(200)
    expect((out.body as { token: string }).token).toBe('minted-admin-token')
    expect(mint).toHaveBeenCalledWith('admin', 'hearth-federated')
  })
  it('refuses with 403 federation_not_authorized when no grant, and does NOT mint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-mint-nogrant-'))
    const mint = vi.fn(() => 'should-not-happen')
    const routes = federationRoutes(depsWith(dir, mint))
    const out = await routes['POST /v1/federation/mint']!(new URLSearchParams(), {})
    expect(out.status).toBe(403)
    expect((out.body as { error: string }).error).toBe('federation_not_authorized')
    expect(mint).not.toHaveBeenCalled()
  })
  it('never puts the token into the log payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-mint-log-'))
    writeGrant(dir, 1)
    const log = vi.fn()
    const deps = { stateDir: dir, mintSessionToken: () => 'SECRET-TOKEN', log } as unknown as InternalApiDeps
    await federationRoutes(deps)['POST /v1/federation/mint']!(new URLSearchParams(), {})
    for (const call of log.mock.calls) expect(JSON.stringify(call)).not.toContain('SECRET-TOKEN')
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `cd <worktree> && bun --bun vitest run src/daemon/internal-api/routes-federation.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/daemon/internal-api/routes-federation.ts`**

```ts
// Federation mint route — hands hearth a SHORT-LIVED admin-tier token so it
// can reach federated_query (POST /v1/knowledge/search, admin-gated). Two
// gates guard this beyond the route layer's operator-routeAllow + admin-tier:
// the caller must be the operator token (added to routeAllow in
// token-registry.ts), AND the explicit owner grant must exist (design
// option B — operator alone cannot mint admin data-tokens). The token value
// is never logged.
import type { InternalApiDeps, RouteTable } from './types'
import { readGrant } from './federation-grant'

const FEDERATION_SESSION_KEY = 'hearth-federated'

export function federationRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/federation/mint': async () => {
      const grant = readGrant(deps.stateDir)
      if (!grant) {
        deps.log?.('INTERNAL_API', '403 /v1/federation/mint federation_not_authorized', {
          event: 'federation.mint_denied',
        })
        return { status: 403, body: { error: 'federation_not_authorized' } }
      }
      const token = deps.mintSessionToken('admin', FEDERATION_SESSION_KEY)
      deps.log?.('INTERNAL_API', 'federation.mint ok', {
        event: 'federation.mint', integration: grant.integration,
      })
      return { status: 200, body: { token } }
    },
  }
}
```

- [ ] **Step 4: Wire the route + gates**

1. `src/daemon/internal-api/routes.ts`: add `import { federationRoutes } from './routes-federation'` (with the other `routes-*` imports) and add `...federationRoutes(deps),` in the returned object next to `...customerReviewRoutes(deps),` (~line 706).
2. `src/daemon/internal-api/route-tiers.ts`: add `'POST /v1/federation/mint': 'admin',` to the `ROUTE_TIERS` map (in the admin section; it's admin-gated).
3. `src/daemon/internal-api/token-registry.ts`: in `registerOperatorToken`'s `routeAllow: new Set([...])`, add `'POST /v1/federation/mint',` (so the operator token passes the route-allow gate — mirrors the `customer-review` operator-only entries already there).

- [ ] **Step 5: Run route test + the route-tier test to confirm no regression**

Run: `cd <worktree> && bun --bun vitest run src/daemon/internal-api/routes-federation.test.ts src/daemon/internal-api/route-tiers.test.ts`
Expected: PASS. (`route-tiers.test.ts` asserts `minTierFor` mappings — confirm the new admin entry doesn't break its expectations; if that test enumerates all routes, add the new one there per its pattern.)

- [ ] **Step 6: Commit**

```bash
git add src/daemon/internal-api/routes-federation.ts src/daemon/internal-api/routes-federation.test.ts src/daemon/internal-api/routes.ts src/daemon/internal-api/route-tiers.ts src/daemon/internal-api/token-registry.ts
git commit -m "feat(federation): grant-gated POST /v1/federation/mint (operator + grant)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Slim federated MCP + mint client (`federated-source.ts`)

**Files:** Create `src/mcp-servers/wechat/federated-source.ts`, `src/mcp-servers/wechat/federated-source.test.ts`

**Interfaces:**
- Consumes: `createInternalApiClient`, `InternalApiClient` from `./client`; `registerFederatedQueryTool` from `./tools-federated`; `McpServer` + `StdioServerTransport` from the SDK (mirror `main.ts`'s exact import paths).
- Produces:
  - `interface ApiInfo { baseUrl: string; tokenFilePath: string; operatorTokenFilePath: string }`
  - `function readApiInfo(infoPath: string): ApiInfo`
  - `async function mintAdminToken(baseUrl: string, operatorToken: string, fetchImpl?: typeof fetch): Promise<string>`
  - `function buildFederatedServer(client: InternalApiClient): McpServer` (registers ONLY `federated_query`)
  - `async function runFederatedSource(infoPath: string, opts?: { fetchImpl?: typeof fetch }): Promise<void>` (read info → mint → set `WECHAT_SESSION_TOKEN`/`_TIER` env → build client + slim server → connect stdio)

- [ ] **Step 1: Write the failing test** (vitest; mirror the SDK Client/InMemoryTransport harness — check how any existing MCP test in this repo imports it, else use `@modelcontextprotocol/sdk/client/index.js` + `.../inMemory.js`)

```ts
import { describe, it, expect, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildFederatedServer, mintAdminToken } from './federated-source'
import type { InternalApiClient } from './client'

// A fake InternalApiClient whose request() returns fake semantic results in the
// shape registerFederatedQueryTool expects ({ results: SemanticSearchResultItem[] }).
function fakeClient(): InternalApiClient {
  return {
    request: vi.fn(async () => ({ results: [
      { text: 'hi from wechat about atlas', conversation: 'chat1', sender: 'A', time: 1_700_000_000 },
    ] })),
  } as unknown as InternalApiClient
}

describe('buildFederatedServer', () => {
  it('exposes ONLY federated_query and returns hearth-shaped hits', async () => {
    const server = buildFederatedServer(fakeClient())
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toEqual(['federated_query'])
    const res: any = await client.callTool({ name: 'federated_query', arguments: { question: 'atlas' } })
    const parsed = JSON.parse(res.content[0].text)
    expect(Array.isArray(parsed.hits)).toBe(true)
    expect(typeof parsed.hits[0].claim_text).toBe('string')
    await client.close()
  })
})

describe('mintAdminToken', () => {
  it('POSTs to /v1/federation/mint with the operator token and returns the token', async () => {
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      expect(url).toContain('/v1/federation/mint')
      expect(init.headers.Authorization).toBe('Bearer op-token')
      return new Response(JSON.stringify({ token: 'admin-tok' }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await mintAdminToken('http://127.0.0.1:1/', 'op-token', fetchImpl)).toBe('admin-tok')
  })
  it('throws on non-200 (e.g. 403 no grant)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'federation_not_authorized' }), { status: 403 })) as unknown as typeof fetch
    await expect(mintAdminToken('http://x', 'op', fetchImpl)).rejects.toThrow(/mint failed: 403/)
  })
})
```

- [ ] **Step 2: Run to verify fail** — `bun --bun vitest run src/mcp-servers/wechat/federated-source.test.ts` → FAIL.

- [ ] **Step 3: Write `src/mcp-servers/wechat/federated-source.ts`**

```ts
// Authorized launcher for hearth's wechat federated source. Mints a short-lived
// admin-tier token via POST /v1/federation/mint (operator token), then serves a
// SLIM stdio MCP exposing ONLY federated_query — no other wechat/admin tool.
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js' // match main.ts's import
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createInternalApiClient, type InternalApiClient } from './client'
import { registerFederatedQueryTool } from './tools-federated'

export interface ApiInfo { baseUrl: string; tokenFilePath: string; operatorTokenFilePath: string }

export function readApiInfo(infoPath: string): ApiInfo {
  const j = JSON.parse(readFileSync(infoPath, 'utf8')) as Partial<ApiInfo>
  if (!j.baseUrl || !j.tokenFilePath || !j.operatorTokenFilePath) {
    throw new Error(`internal-api-info.json missing fields at ${infoPath}`)
  }
  return { baseUrl: j.baseUrl, tokenFilePath: j.tokenFilePath, operatorTokenFilePath: j.operatorTokenFilePath }
}

export async function mintAdminToken(baseUrl: string, operatorToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/federation/mint`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`federation mint failed: ${res.status} ${detail.slice(0, 120)}`)
  }
  const j = (await res.json()) as { token?: string }
  if (!j.token) throw new Error('federation mint: no token in response')
  return j.token
}

export function buildFederatedServer(client: InternalApiClient): McpServer {
  const server = new McpServer({ name: 'wechat-federated', version: '0.1.0' }, { capabilities: { tools: {} } })
  registerFederatedQueryTool(server, client)
  return server
}

export async function runFederatedSource(infoPath: string, opts?: { fetchImpl?: typeof fetch }): Promise<void> {
  const info = readApiInfo(infoPath)
  const operatorToken = readFileSync(info.operatorTokenFilePath, 'utf8').trim()
  const adminToken = await mintAdminToken(info.baseUrl, operatorToken, opts?.fetchImpl)
  // The internal-api client's bearer prefers WECHAT_SESSION_TOKEN (carries the
  // admin tier); WECHAT_SESSION_TIER is the non-secret companion. Set both
  // before building the client so federated_query's calls authenticate as admin.
  process.env.WECHAT_SESSION_TOKEN = adminToken
  process.env.WECHAT_SESSION_TIER = 'admin'
  const client = createInternalApiClient({ baseUrl: info.baseUrl, tokenFilePath: info.tokenFilePath })
  const server = buildFederatedServer(client)
  process.stderr.write(`[wechat-federated] ready (base=${info.baseUrl})\n`)
  await server.connect(new StdioServerTransport())
}
```
(Verify the exact SDK import path for `McpServer` against `src/mcp-servers/wechat/main.ts` — it imports `McpServer`; use the identical specifier. Same for `InternalApiClient`'s `request` shape used by the fake in the test — check `tools-federated.ts` uses `client.request<...>('POST', '/v1/knowledge/search', { query })`.)

- [ ] **Step 4: Run to verify pass** — `bun --bun vitest run src/mcp-servers/wechat/federated-source.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-servers/wechat/federated-source.ts src/mcp-servers/wechat/federated-source.test.ts
git commit -m "feat(federation): slim federated_query-only MCP + admin-token minting

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `wechat-cc federated-source` CLI subcommand

**Files:** Modify `cli.ts`; Create `cli-federated-source.test.ts` (colocate with other cli tests — check where existing cli command tests live and match)

**Interfaces:**
- Consumes: `writeGrant`/`readGrant`/`revokeGrant`/`grantPath` from `src/daemon/internal-api/federation-grant`; `runFederatedSource` from `src/mcp-servers/wechat/federated-source`.
- Produces: a citty `defineCommand` `federatedSourceCmd` wired into the CLI root, resolving the state dir from the info.json path.

**Default info path:** `join(homedir(), '.claude', 'channels', 'wechat', 'internal-api-info.json')`; state dir = its `dirname`. Allow an override via `--info-path <p>` (for tests + non-default installs).

- [ ] **Step 1: Write the failing test** (vitest) — drive the command's action functions against a temp state dir. Extract the verb logic into small exported functions so they're testable without spawning stdio:

```ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { federatedSourceAuthorize, federatedSourceDeauthorize, federatedSourceStatus } from './cli-federated-source' // or wherever you place the verb fns

const tmp = () => mkdtempSync(join(tmpdir(), 'cli-fed-'))

describe('federated-source verbs', () => {
  it('authorize writes a grant, status reports it, deauthorize removes it', () => {
    const dir = tmp()
    const info = join(dir, 'internal-api-info.json')
    require('node:fs').writeFileSync(info, JSON.stringify({ baseUrl: 'http://x', tokenFilePath: 't', operatorTokenFilePath: 'o' }))
    const out: string[] = []
    const print = (s: string) => out.push(s)
    federatedSourceAuthorize(info, 1000, print)
    expect(federatedSourceStatus(info, print)).toBe(true)   // grant present
    federatedSourceDeauthorize(info, print)
    expect(federatedSourceStatus(info, print)).toBe(false)
    expect(out.join('\n')).toMatch(/authorized|revoked|not/i)
  })
})
```

- [ ] **Step 2: Run to verify fail** — FAIL (module/functions not found).

- [ ] **Step 3: Implement**

Create the verb functions (in a small `cli-federated-source.ts` module, or inline in cli.ts + exported) that compute `stateDir = dirname(infoPath)` and call the grant helpers, printing owner-facing lines (including how to revoke and, on --status, the grant state + daemon baseUrl). Then wire a citty `defineCommand` — mirror an existing `defineCommand` in `cli.ts` (e.g. the `status`/`doctor` commands): `meta: { name: 'federated-source', description: 'Expose wechat as a hearth federated source' }`, boolean args `authorize` / `deauthorize` / `status` + string `info-path`, and a `run({ args })` that: if `authorize` → `federatedSourceAuthorize(infoPath, Date.now(), console.log)`; `deauthorize` → deauthorize; `status` → status; else (run mode) → `await runFederatedSource(infoPath)`. Register `federatedSourceCmd` in the CLI root's `subCommands` map (find where the other `defineCommand`s are attached to the root and add it the same way). Default `infoPath` = the homedir path above when `--info-path` is absent.

- [ ] **Step 4: Run to verify pass** — `bun --bun vitest run <the cli test>` → PASS. Also smoke the command help: `bun cli.ts federated-source --help` shows the subcommand.

- [ ] **Step 5: Typecheck + depcheck + commit**

Run: `bun run typecheck` (no new errors from these files) and `bun run depcheck` (no new dependency-layer violations — federation-grant is in internal-api, federated-source imports sibling client/tools-federated, cli imports both; if depcruise flags a layer rule, resolve per the repo's existing layering).

```bash
git add cli.ts cli-federated-source.ts cli-federated-source.test.ts
git commit -m "feat(federation): wechat-cc federated-source CLI (authorize/deauthorize/status/run)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Post-task gate (controller-run) — VERIFY-AGAINST-REAL + hearth registration
After Task 4, against the LIVE daemon (pid confirmed running) + the real hearth at `~/Documents/hearth` + real `~/Documents/tendhearth/vault`:
1. `bun <worktree>/cli.ts federated-source --authorize` → grant written.
2. Add a `wechat` source to the real `~/.hearth/sources.json` (alongside `files`): `{ id:'wechat', transport:{ kind:'stdio', command:'bun', args:['<worktree>/cli.ts','federated-source'] }, query_tool:'federated_query' }`. (Use `bun <worktree>/cli.ts` so it runs from the built branch.)
3. Owner `federatedQuery(vault, "<a term in BOTH docs and wechat>", { stateDir: ~/.hearth, consumer: null })` → assert hits from BOTH `files` and `wechat` (each `verified_by` its source), raw wechat messages NOT in the vault. Report raw hits.
4. Revoke: `federated-source --deauthorize` → re-run the query → `wechat` now fails closed (mint 403 → fail-open empty), `files` still answers. Then re-`--authorize` to leave it working (or leave revoked per user preference).
Report the raw evidence; do not fabricate.

## Self-Review
- Spec coverage: §A(mint route)→Task 2; §B(CLI)→Task 4; §C(slim MCP)→Task 3; grant→Task 1; §D(hearth registration)→gate. Authorization option B (grant + operator + tier) enforced across Tasks 1–2.
- Type consistency: `FederationGrant`/grant helpers (T1) consumed by the route (T2) + CLI (T4); `ApiInfo`/`mintAdminToken`/`buildFederatedServer`/`runFederatedSource` (T3) consumed by the CLI (T4). `InternalApiDeps.mintSessionToken('admin', 'hearth-federated')` signature matches the route + test.
- Security invariants asserted structurally: no-grant → mint-not-called (T2 test spy), token-never-logged (T2 test), slim MCP exposes only `federated_query` (T3 test asserts ListTools === ['federated_query']).
- No placeholders; framework boilerplate (citty command registration, McpServer/SDK import specifiers) is pinned to a named precedent file to mirror rather than guessed.
```
