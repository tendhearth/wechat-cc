# A2A proto_version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Advertise an A2A protocol version in the agent card, record it at install
time, and surface mismatch as a warning — the foundation for protocol evolution.

**Architecture:** One shared integer constant (`A2A_PROTO_VERSION = 1` in
`a2a-intent.ts`, the wire-schema home). The card advertises it; consumers apply a
**missing = 1** default (every existing peer's card lacks the field, so old peers
stay valid). The preview route computes and returns `proto_version` +
`proto_mismatch`; the install route best-effort-fetches the card to record the
version in the registry (fetch failure leaves it unset — offline-install semantics
unchanged). Mismatch warns, never refuses.

**Tech Stack:** TypeScript/Bun, zod v4, vitest. Spec:
`docs/superpowers/specs/2026-07-17-a2a-proto-version-design.md`.

## Global Constraints

- **Missing `proto_version` in a card means 1** — the backward-compat rule; never
  require the field anywhere.
- **Mismatch warns, never refuses** — no error path, no refusal logic.
- Tests use `bun run test <path>` (vitest via package script — NOT `bun test`, the
  native runner mishandles vitest timers). Typecheck `bun run typecheck`; dep
  boundaries `bun run depcheck`. All three green before each commit.
- zod v4 vitest gotcha: in TEST files import zod as `import z from 'zod'` (default
  import) if needed.
- New daemon wiring (none needed here) would go in `bootstrap/wire-*.ts`, not
  `bootstrap/index.ts` — this plan touches no bootstrap file.

---

## Task 1: Wire layer — constant, card, client type, registry field

**Files:**
- Modify: `src/core/a2a-intent.ts` (top, after the imports)
- Modify: `src/core/a2a-server.ts` (the `agentCard` object, ~`:142`)
- Modify: `src/core/a2a-client.ts` (the `AgentCard` interface, ~`:17`)
- Modify: `src/lib/agent-config.ts` (the `A2AAgentRecord` zod object)
- Test: `src/core/a2a-server.test.ts`, `src/lib/agent-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const A2A_PROTO_VERSION = 1` (from `a2a-intent.ts`);
  `AgentCard.proto_version?: number`; `A2AAgentRecord.proto_version` optional int.
  Task 2 imports `A2A_PROTO_VERSION` and reads `card.proto_version`.

- [ ] **Step 1: Write the failing card test** — in `src/core/a2a-server.test.ts`,
  find the existing test that fetches `/.well-known/agent.json` (grep
  `agent.json`) and add one assertion to it (or a sibling `it` in the same
  describe, matching file style):

```ts
    it('advertises the A2A protocol version in the agent card', async () => {
      const { server, baseUrl } = await startServer({})
      try {
        const card = await (await fetch(`${baseUrl}/.well-known/agent.json`)).json() as { proto_version?: number }
        expect(card.proto_version).toBe(1)
      } finally { await server.stop() }
    })
```

(Adapt the harness call to the file's existing `startServer` helper signature —
read the neighboring tests first.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/core/a2a-server.test.ts`
Expected: FAIL — `proto_version` is `undefined`.

- [ ] **Step 3: Implement the wire layer.**

(a) `src/core/a2a-intent.ts` — after the existing imports, before
`IntentCardSchema`:

```ts
/**
 * A2A wire-protocol version, advertised in the agent card
 * (GET /.well-known/agent.json → `proto_version`).
 *
 * Rules:
 * - Single integer; bumped ONLY on an incompatible wire change.
 * - A card WITHOUT the field means version 1 (every pre-versioning peer).
 * - Mismatch = best-effort interop + warn; never refuse (refusal/downgrade
 *   semantics get designed when a real v2 exists).
 */
export const A2A_PROTO_VERSION = 1
```

(b) `src/core/a2a-server.ts` — add `A2A_PROTO_VERSION` to the existing
`a2a-intent` import (the file already imports `IntentCardSchema` etc. from
`./a2a-intent`), then in the `agentCard` object add one line after `version`:

```ts
  const agentCard = {
    name: opts.daemonInfo.name,
    description: 'WeChat bridge for AI agents — notify the operator via WeChat chat.',
    version: opts.daemonInfo.version,
    proto_version: A2A_PROTO_VERSION,
    auth: { type: 'bearer', required: true },
```

(c) `src/core/a2a-client.ts` — the `AgentCard` interface gains one optional
field after `version`:

```ts
export interface AgentCard {
  name: string
  description?: string
  version?: string
  /** A2A wire-protocol version; ABSENT on pre-versioning peers ⇒ treat as 1. */
  proto_version?: number
  auth?: { type: string; required: boolean }
```

(d) `src/lib/agent-config.ts` — `A2AAgentRecord` gains one optional field after
`transport`:

```ts
  transport: z.enum(['push', 'ws']).default('push'),
  /** Peer's A2A proto_version captured at install time; unset = unknown (treat as 1). */
  proto_version: z.number().int().optional(),
```

- [ ] **Step 4: Write the failing registry round-trip test** — in
`src/lib/agent-config.test.ts`, find the existing `a2a_agents` save/load test
(grep `a2a_agents`) and add a sibling `it` in its describe, matching the file's
existing save→load fixture style:

```ts
  it('round-trips an a2a agent record with proto_version', () => {
    // Mirror the neighboring a2a_agents test's setup: same saveAgentConfig/
    // loadAgentConfig fixture, one agent record + proto_version: 1.
    // Assert loadAgentConfig(...).a2a_agents![0].proto_version === 1, and that
    // a record WITHOUT the field loads with proto_version undefined.
  })
```

(The comment above is intent — write the real test by copying the neighboring
test's exact fixture shape and adding `proto_version: 1` to the record + the two
assertions. The neighboring test has the exact valid record fields, including a
≥16-char `inbound_api_key`.)

- [ ] **Step 5: Run to verify both pass**

Run: `bun run test src/core/a2a-server.test.ts src/lib/agent-config.test.ts`
Expected: PASS (all, including the two new tests).

- [ ] **Step 6: Gates + commit**

Run: `bun run typecheck` (clean) and `bun run depcheck` (no violations), then:

```bash
git add src/core/a2a-intent.ts src/core/a2a-server.ts src/core/a2a-client.ts src/lib/agent-config.ts src/core/a2a-server.test.ts src/lib/agent-config.test.ts
git commit -m "feat(a2a): A2A_PROTO_VERSION=1 in agent card + client type + registry field"
```

---

## Task 2: Surface layer — preview mismatch flag + install best-effort record

**Files:**
- Modify: `src/daemon/internal-api/schema.ts` (`A2APreviewResponse`, ~`:338`)
- Modify: `src/daemon/internal-api/routes-a2a.ts` (`POST /v1/a2a/preview` +
  `POST /v1/a2a/install`)
- Test: `src/daemon/internal-api.test.ts`

**Interfaces:**
- Consumes: `A2A_PROTO_VERSION` (from `../../core/a2a-intent`), `AgentCard.proto_version?`
  and `A2AAgentRecord.proto_version` (Task 1).
- Produces: preview success response gains `proto_version: number` +
  `proto_mismatch: boolean` (both REQUIRED in the success branch — the route
  always computes them); install records `proto_version` when the best-effort
  card fetch succeeds.

- [ ] **Step 1: Write the failing tests** — in `src/daemon/internal-api.test.ts`,
find the existing preview/install tests (grep `a2a/preview` and `a2a/install`)
and add, in their describe blocks, following the file's existing stub idiom (the
preview tests stub `deps.a2a.client.fetchAgentCard`):

```ts
    it('preview surfaces proto_version + proto_mismatch (missing field defaults to 1)', async () => {
      // Stub fetchAgentCard to return a card WITHOUT proto_version.
      // POST /v1/a2a/preview → 200; body.proto_version === 1; body.proto_mismatch === false.
    })

    it('preview flags a mismatching proto_version', async () => {
      // Stub fetchAgentCard → { name: 'x', proto_version: 99 }.
      // POST /v1/a2a/preview → 200; body.proto_version === 99; body.proto_mismatch === true.
    })

    it('install records the peer proto_version via best-effort card fetch', async () => {
      // Stub fetchAgentCard → { name: 'x', proto_version: 1 }; spy on registry.add.
      // POST /v1/a2a/install → ok:true; registry.add called with proto_version: 1.
    })

    it('install still succeeds (proto_version unset) when the card fetch fails', async () => {
      // Stub fetchAgentCard to REJECT; POST /v1/a2a/install → ok:true;
      // registry.add called with proto_version undefined (field absent).
    })
```

(The comments are intent — write the real bodies by copying the neighboring
preview/install tests' exact harness setup, stubs, tokens, and fetch calls.)

- [ ] **Step 2: Run to verify they fail**

Run: `bun run test src/daemon/internal-api.test.ts`
Expected: the 4 new tests FAIL (missing response fields / registry.add lacks the
field); everything else green.

- [ ] **Step 3: Implement.**

(a) `src/daemon/internal-api/schema.ts` — the `A2APreviewResponse` success
branch gains two required fields:

```ts
export const A2APreviewResponse = z.union([
  z.object({
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    proto_version: z.number(),
    proto_mismatch: z.boolean(),
    auth: z.object({ type: z.string(), required: z.boolean() }).optional(),
    capabilities: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      endpoint: z.string().optional(),
      method: z.string().optional(),
    })).optional(),
  }),
  z.object({ error: z.string() }),
])
```

(b) `src/daemon/internal-api/routes-a2a.ts` — import the constant
(`import { A2A_PROTO_VERSION } from '../../core/a2a-intent'`), then:

preview:

```ts
    'POST /v1/a2a/preview': async (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated via A2APreviewRequest schema.
      const { url } = body as A2APreviewRequestT
      try {
        const card = await deps.a2a.client.fetchAgentCard(url)
        // Missing proto_version on the card means a pre-versioning peer ⇒ 1.
        const proto_version = card.proto_version ?? 1
        return { status: 200, body: { ...card, proto_version, proto_mismatch: proto_version !== A2A_PROTO_VERSION } }
      } catch (err) {
        return { status: 200, body: { error: errMsg(err) } }
      }
    },
```

install — inside the existing `try`, before `deps.a2a.registry.add({...})`, add
the best-effort fetch, and thread the field into the add:

```ts
        // Best-effort proto_version capture: fetch the peer's card; on ANY
        // failure leave the field unset (offline installs keep working —
        // unset = unknown = treated as 1). Mismatch warns, never refuses.
        let proto_version: number | undefined
        try {
          const card = await deps.a2a.client.fetchAgentCard(url)
          proto_version = card.proto_version ?? 1
          if (proto_version !== A2A_PROTO_VERSION) {
            deps.log?.('A2A', `peer "${id}" advertises proto_version=${proto_version}, ours=${A2A_PROTO_VERSION} — best-effort interop`)
          }
        } catch { /* unreachable/offline peer: install proceeds, version unknown */ }

        const inboundKey = `wc_${randomBytes(16).toString('hex')}`
        deps.a2a.registry.add({
          id, name, url,
          inbound_api_key: inboundKey,
          outbound_api_key,
          capabilities: [],
          paused: false,
          transport: 'push',
          ...(proto_version !== undefined ? { proto_version } : {}),
        })
```

(NOTE: the install handler is currently a sync arrow `(_q, body) => {` — make it
`async` since it now awaits the fetch; the RouteTable handler type already
allows async handlers, as preview shows.)

- [ ] **Step 4: Run to verify all pass**

Run: `bun run test src/daemon/internal-api.test.ts`
Expected: PASS (all, incl. the 4 new). Then check the response-schema test file
if one asserts `A2APreviewResponse` shape (grep `A2APreviewResponse` in
`src/daemon/internal-api/schema.test.ts`) — if a fixture there parses a preview
response, extend the fixture with the two new fields.

- [ ] **Step 5: Gates + commit**

Run: `bun run typecheck` (clean), `bun run depcheck` (no violations), plus the
broad daemon suite once: `bun run test src/daemon src/core src/lib` (all green).

```bash
git add src/daemon/internal-api/schema.ts src/daemon/internal-api/routes-a2a.ts src/daemon/internal-api.test.ts
git commit -m "feat(a2a): preview surfaces proto_version+mismatch; install best-effort-records peer version"
```

---

## Done-when

- Agent card serves `proto_version: 1`; a card lacking the field is treated as 1
  everywhere.
- Preview response carries required `proto_version` + `proto_mismatch` in its
  success branch; install records the version when reachable and installs
  unchanged when not; mismatch logs a warning, nothing refuses.
- `bun run test src/daemon src/core src/lib` + typecheck + depcheck all green.
