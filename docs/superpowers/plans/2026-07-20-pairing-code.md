# Implementation Plan — 配对码 + 中继碰头 (pairing-code rendezvous)

REQUIRED SUB-SKILL: subagent-driven-development

> Contract: `docs/superpowers/specs/2026-07-20-pairing-code-design.md` (approved 2026-07-20).
> Branch: `design/pairing-code` off `dev`. All-additive; no typecheck-red window.

## Goal

Turn edge-building between two WeChat friends' bots from "manual JSON surgery" into a
"Bluetooth-pairing" gesture: friend A says 「配对」 → gets a 6-digit code → passes it in their
existing WeChat chat → friend B says 「配对 483921」 → both bots derive the SAME deterministic
rendezvous mailbox from the code, exchange sealed name-cards over the already-deployed
content-blind relay, and each writes a complete `A2AAgentRecord` for the other (transport
`mailbox`, keys crossed). No relay change, no new dependency.

## Architecture

Five moving parts, all layered so the pure/testable pieces have no network:

1. **`src/core/pairing-crypto.ts`** — deterministic rendezvous identity from the code.
   `HKDF-SHA256(ikm=code, salt='wcc-pair-v1', info='rendezvous') → 64 bytes → 32B Ed25519 seed +
   32B X25519 seed`, each wrapped into a node:crypto key via a fixed PKCS#8 DER prefix + raw seed.
   Produces a `RendezvousIdentity` that is a structural superset of `MailboxIdentity`, so it drops
   straight into the existing `sealEnvelope` / `openEnvelope` / `signFetch` primitives.

2. **`src/core/self-agent-id.ts`** — the stable-unique self slug resolver (spec §2). Fixes the
   "both peers self-report `wechat-cc` → registry key collision" gap. Precedence
   `env > config.self_agent_id > cc-<8hex sha256(mailbox_addr)> (generated + persisted)`, legacy
   `wechat-cc` when no mailbox is configured. Swaps `wire-social.ts`'s `SOCIAL_SELF_ID` constant.

3. **`A2AAgentRecord.url` optional-for-mailbox** (spec §6) — `z.string().url().optional()` + an
   object-level `superRefine` that still requires `url` for `push`/`ws`. Pure-NAT peers have no
   public url.

4. **`src/core/pairing.ts`** — the deps-injected pairing engine. `start()` (mint code, derive
   rendezvous, seal+drop own card, arm a bounded ~10s×10min poller) / `accept(code)` (derive, fetch,
   find the initiator card, drop own card, write the peer record) + the shared
   `writePeerFromCard(card, myMintedKey)` (registry overwrite-by-`self_id`, bearer crossing).
   Testable without a network via injected `MailboxClient`, `A2ARegistry`, clock, and scheduler.

5. **Surfaces** — `wire-pairing.ts` builds the engine from real daemon deps and exposes
   `boot.pairing`; the WeChat 「配对」/「配对 <code>」 command mirrors 揭晓/回信 in `pipeline-deps.ts`;
   internal-api `POST /v1/pair/start` + `/v1/pair/accept` (tier `trusted`); CLI
   `wechat-cc pair [code]`.

### Rendezvous data flow (no ack; shared box; TTL cleanup)

```
Initiator                          Rendezvous box (derived addr)          Acceptor
  start(): mint keyI, nonceI
  seal CardI{role:initiator,        ── drop CardI ──▶  [ CardI ]
    bearer:keyI} to rv.enc_pub
  arm poller (fetch since=0)                                            accept(code):
                                                                          fetch since=0 → CardI
                                                                          self-pair? reject
                                                                          write peer(id=CardI.self_id,
                                                                            out=CardI.bearer=keyI,
                                                                            in=keyA)
                                    ◀── drop CardA ──   seal CardA{role:acceptor,
                                       [CardI, CardA]      bearer:keyA} to rv.enc_pub
  poll tick → sees CardA (role≠mine,
    nonce≠mine) → write peer(
    id=CardA.self_id,
    out=CardA.bearer=keyA, in=keyI)
  notify owner; stop poller
```

Result: A.outbound_api_key == B.inbound_api_key (keyI) and B.outbound_api_key == A.inbound_api_key
(keyA). Both records `transport:'mailbox'`, url optional.

## Tech Stack

- TypeScript, `node:crypto` only (HKDF, Ed25519/X25519, sha256, randomInt/randomBytes) — **no new npm dependency**.
- Reuse: `sealEnvelope`/`openEnvelope`/`signFetch` (`mailbox-crypto.ts`), `MailboxClient`
  (`mailbox-client.ts`), `A2ARegistry` (`a2a-registry.ts`), `A2AAgentRecord`/`AgentConfig`
  (`lib/agent-config.ts`), `makeRelayServer` (`relay/server.ts`, in-process test relay), citty (`cli.ts`).
- Test: vitest via `bun run test <path>` **from repo ROOT** (`cd apps/desktop` no-ops). zod v4 under
  vitest: `import z from 'zod'` (default export) — never `import { z }`.

## Global Constraints

**LOCKED decisions (from the approved spec — do NOT re-litigate):**

1. Code = 6 digits, one-shot, 10-min TTL. HKDF **fixed params** (`salt='wcc-pair-v1'`, `info='rendezvous'`, ikm=code) — **relayUrl is NOT in the derivation** (configured URL strings need not be byte-identical; mixing it in would silently mismatch). Rendezvous relay = own `mailbox_relays[0]`; same-relay precondition documented (install default = built-in brain relay ⇒ satisfied by default).
2. **NO ack** during pairing (shared box; ack is a global delete that both sides would trample — rely on the 10-min TTL to clean up). Card carries `role` (initiator/acceptor) + a random `nonce`; each side ignores its own card. Initiator polls ~10s up to 10 min, **bounded, not restart-persistent**. Only one active initiator code at a time (a new 「配对」 supersedes the old).
3. Card fields per spec §5 verbatim. **Bearer crossing:** the receiver stores `card.bearer` as the peer's `outbound_api_key` and its OWN freshly-minted key as `inbound_api_key`.
4. Registry record: `id = peer.self_id`, `transport='mailbox'`, `url` optional (superRefine: `url` required unless `transport==='mailbox'`). Re-pair with the same `self_id` = **full overwrite** (natural key-rotation entry).
5. `self_agent_id`: `env WECHAT_A2A_SELF_ID > config.self_agent_id > generated cc-<8hex sha256(mailbox_addr)> persisted to config`. `wire-social`'s `SOCIAL_SELF_ID` uses the resolver. Legacy default `wechat-cc` when no mailbox configured.
6. Entrances: WeChat text command (admin-gated, pipeline seam like 揭晓) + CLI `wechat-cc pair [code]` via internal-api routes **tier = trusted**. Self-pair (same `self_id`) rejected.
7. **NO new npm dependency** (node:crypto + existing modules only); `depcheck` green.

**Scope guard (OUT):** async discovery (seek→echo over mailbox); PAKE / offline-brute hardening; QR / desktop-button skin; multi-relay negotiation; pairing revocation (use existing peer remove); non-admin pairing.

**Gates (every task, verbatim):**
- `bun run test <path>` from repo ROOT for each touched suite → green.
- `bun run typecheck` clean. `bun run depcheck` green.
- **All-additive — expect NO typecheck-red window.** If one emerges, sequence to a green checkpoint honestly.
- Do NOT touch `apps/desktop` or `main.js`. Do NOT regress social/penpal/mailbox suites.
- **Adding the CLI subcommand ⇒ update `cli.test.ts`'s exhaustive subcommand list** (the v1.3.3 release broke on exactly this).
- TDD per step: write failing test → run it, see it fail → minimal impl → run, see it pass → commit.

**Verified before authoring (node:crypto acceptance of the DER-prefix technique):**
```
ED_PKCS8_PREFIX = 302e020100300506032b657004220420   (ed25519 pkcs8 header + 04 20 seed-octet-string)
X_PKCS8_PREFIX  = 302e020100300506032b656e04220420   (x25519  pkcs8 header + 04 20 seed-octet-string)
```
Ran against node: `createPrivateKey({key: PREFIX+seed, format:'der', type:'pkcs8'})` → Ed25519 sign/verify roundtrip `true`; X25519 ECDH match `true`; exported Ed25519 addr begins `MCowBQYDK2Vw…`, X25519 enc_pub begins `MCowBQYDK2Vu…`; HKDF(64) determinism `true`. Task 1 re-locks all four in a checked-in test.

---

## Phasing

- **Phase A — foundations (T1–T3):** rendezvous crypto; self-id resolver (merge-persist + grandfather rule); url-optional schema + guards for the 3 push-path `.url` consumers that a url-less mailbox peer would otherwise break. Independent; T2/T3 each touch `wire-social.ts` (disjoint lines), still additive.
- **Phase B — engine (T4–T5):** the pairing engine + the two-engine in-process-relay integration test.
- **Phase C — surfaces (T6–T9):** bootstrap wiring, WeChat command, internal-api routes+tiers, CLI (+ cli.test surface). Final gates.

---

## Task 1 — `pairing-crypto.ts`: deterministic rendezvous identity

### Interfaces
- **Produces:** `src/core/pairing-crypto.ts` exporting `RendezvousIdentity` + `deriveRendezvous(code: string): RendezvousIdentity`.
- **Consumes:** `node:crypto` (`hkdfSync`, `createPrivateKey`, `createPublicKey`, `sign`).
- `RendezvousIdentity` is a structural superset of `MailboxIdentity` (`{ addr; enc_pub; enc_priv; sign(m) }`), so it passes directly into `sealEnvelope(inner, id.enc_pub)`, `openEnvelope(id.enc_priv, env)`, `signFetch(id.sign, id.addr, ts)`.

### Step 1.1 — failing test

Create `src/core/pairing-crypto.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createPublicKey, verify } from 'node:crypto'
import { deriveRendezvous } from './pairing-crypto'
import { sealEnvelope, openEnvelope, signFetch } from './mailbox-crypto'

describe('pairing-crypto/deriveRendezvous', () => {
  it('is byte-for-byte deterministic for the same code', () => {
    const a = deriveRendezvous('483921')
    const b = deriveRendezvous('483921')
    expect(a.addr).toBe(b.addr)
    expect(a.enc_pub).toBe(b.enc_pub)
    expect(a.enc_priv).toBe(b.enc_priv)
    expect(a.sign('m')).toBe(b.sign('m'))
  })

  it('differs for a different code', () => {
    const a = deriveRendezvous('483921')
    const b = deriveRendezvous('483922')
    expect(a.addr).not.toBe(b.addr)
    expect(a.enc_pub).not.toBe(b.enc_pub)
  })

  it('produces an Ed25519 addr node:crypto accepts for sign/verify', () => {
    const id = deriveRendezvous('100200')
    const msg = signFetch(id.sign, id.addr, 1_700_000_000_000)
    // addr is the base64url SPKI-DER Ed25519 pubkey — reconstruct + verify the raw signature.
    const pub = createPublicKey({ key: Buffer.from(id.addr, 'base64url'), format: 'der', type: 'spki' })
    const raw = id.sign(`fetch:${id.addr}:1700000000000`)
    expect(verify(null, Buffer.from(`fetch:${id.addr}:1700000000000`, 'utf8'), pub, Buffer.from(raw, 'base64url'))).toBe(true)
    expect(typeof msg).toBe('string')
  })

  it('produces an X25519 enc keypair sealEnvelope/openEnvelope round-trip through', () => {
    const id = deriveRendezvous('654321')
    const env = sealEnvelope({ path: '/pair', bearer: '', body: { hi: 1 } }, id.enc_pub)
    const inner = openEnvelope(id.enc_priv, env)
    expect(inner).not.toBeNull()
    expect(inner!.body).toEqual({ hi: 1 })
  })
})
```

Run (expect fail — module absent):
```
bun run test src/core/pairing-crypto.test.ts
# Expected: FAIL — "Cannot find module './pairing-crypto'"
```

### Step 1.2 — minimal impl

Create `src/core/pairing-crypto.ts`:

```ts
/**
 * pairing-crypto.ts — derive a DETERMINISTIC rendezvous identity from a pairing
 * code (spec §4). Both peers run this on the SAME 6-digit code and get the SAME
 * Ed25519 mailbox address + X25519 encryption keypair, letting them use the
 * already-deployed content-blind relay as a shared meeting box with NO relay
 * change. FIXED HKDF params — the relay URL is deliberately NOT mixed in (two
 * peers' configured URL strings need not be byte-identical; §4).
 *
 * node:crypto has no "import a raw 32-byte Ed25519/X25519 seed" API, so we wrap
 * the seed in a fixed PKCS#8 DER prefix (the algorithm header + the `04 20`
 * OCTET STRING tag/length) and hand the concatenation to createPrivateKey.
 * Prefixes verified against node:crypto (see the plan's Global Constraints and
 * pairing-crypto.test.ts). The result is a structural superset of MailboxIdentity,
 * so it drops straight into sealEnvelope / openEnvelope / signFetch.
 */
import { hkdfSync, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto'

/** Same shape as MailboxIdentity — usable by sealEnvelope/openEnvelope/signFetch. */
export interface RendezvousIdentity { addr: string; enc_pub: string; enc_priv: string; sign(message: string): string }

// Domain-separation constants — FIXED on both sides (spec §4). Never add relayUrl.
const HKDF_SALT = Buffer.from('wcc-pair-v1')
const HKDF_INFO = Buffer.from('rendezvous')
const OKM_LEN = 64 // 32B Ed25519 seed + 32B X25519 seed

// PKCS#8 DER prefixes: algorithm header for the curve + `04 20` (OCTET STRING,
// length 32) framing the raw seed. Concatenated with a 32-byte seed → a valid
// PKCS#8 private key node:crypto imports.
const ED_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const X_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

export function deriveRendezvous(code: string): RendezvousIdentity {
  const okm = Buffer.from(hkdfSync('sha256', Buffer.from(code, 'utf8'), HKDF_SALT, HKDF_INFO, OKM_LEN))
  const edSeed = okm.subarray(0, 32)
  const xSeed = okm.subarray(32, 64)

  const edPriv = createPrivateKey({ key: Buffer.concat([ED_PKCS8_PREFIX, edSeed]), format: 'der', type: 'pkcs8' })
  const edPub = createPublicKey(edPriv)
  const addr = edPub.export({ type: 'spki', format: 'der' }).toString('base64url')

  const xPriv = createPrivateKey({ key: Buffer.concat([X_PKCS8_PREFIX, xSeed]), format: 'der', type: 'pkcs8' })
  const xPub = createPublicKey(xPriv)
  const enc_pub = xPub.export({ type: 'spki', format: 'der' }).toString('base64url')
  const enc_priv = xPriv.export({ type: 'pkcs8', format: 'der' }).toString('base64url')

  return {
    addr,
    enc_pub,
    enc_priv,
    sign: (message) => edSign(null, Buffer.from(message, 'utf8'), edPriv).toString('base64url'),
  }
}
```

Run (expect pass):
```
bun run test src/core/pairing-crypto.test.ts
# Expected: PASS — 4 tests
```

### Step 1.3 — commit
```
git add src/core/pairing-crypto.ts src/core/pairing-crypto.test.ts
git commit -m "feat(pairing): deterministic rendezvous identity from code (HKDF + PKCS#8 seed wrap)"
```

---

## Task 2 — `self_agent_id`: config field + resolver + wire-social swap

### Interfaces
- **Produces:**
  - `AgentConfig.self_agent_id?: string` (+ schema + `loadAgentConfig` passthrough) in `src/lib/agent-config.ts`.
  - `src/core/self-agent-id.ts` exporting `resolveSelfAgentId(config, stateDir, deps?): string`.
- **Consumes:** `loadMailboxIdentity` (`mailbox-crypto.ts`), `createHash` (`node:crypto`), `node:fs` (`existsSync`/`readFileSync`/`writeFileSync`/`renameSync`/`mkdirSync`).
- **Swaps:** `wire-social.ts:~122` `const SOCIAL_SELF_ID = process.env.WECHAT_A2A_SELF_ID || 'wechat-cc'` → `resolveSelfAgentId(configuredAgent, deps.stateDir)` (computed ONCE at that line, not lazily).
- **CRITICAL-1 fix — persistence MUST merge, not full-overwrite.** `saveAgentConfig` does `writeFileSync(JSON.stringify(config))` — a full-object overwrite that (a) drops any unmodeled/legacy disk field and (b) if handed a boot-snapshot config, wipes post-boot `a2a_agents` registry writes off disk. The resolver therefore persists via a private `persistSelfAgentId(stateDir, slug)` helper that does a **read-modify-write of the RAW config file** (mirroring `a2a-registry.persistAll`): read `agent-config.json`, set ONLY `self_agent_id`, atomic tmp+rename back. It never touches `a2a_agents` or any other key. (The engine-side lazy-re-entry clobber is fixed separately in Task 6 by memoizing `selfId` at wiring time.)
- **IMPORTANT-3 fix — grandfather rule (also written into spec §2).** Swapping the constant to the resolver would flip any no-env + `mailbox_relays`-configured daemon from claiming `wechat-cc` to `cc-<hash>` — and the install default HAS `mailbox_relays`. Existing peers filed it under `wechat-cc` → `verifyBearer` miss → silent 401 on established edges. So: when the config has EXISTING `a2a_agents` AND no `self_agent_id`/env, persist and return `wechat-cc` (freeze current behavior, zero breakage); mint the unique slug ONLY for a fresh daemon with no pre-existing peers. Changing `self_agent_id` later requires re-pairing existing edges (documented).
- **Resolved interaction (brief):** the generated slug needs the mailbox identity; `loadMailboxIdentity` is side-effectful (persists `mailbox-key.json`). Pairing requires `mailbox_relays` anyway, so the resolver only touches `loadMailboxIdentity` inside the `mailbox_relays?.length` + no-existing-peers branch; with no mailbox it returns the legacy `wechat-cc`. The resolver lives in `core` (not `lib`) so `lib/agent-config` keeps its no-`core`-imports posture; only the plain `self_agent_id?` field is added to `lib`.

### Step 2.1 — config field (failing test)

Add to `src/lib/agent-config.test.ts` (or the nearest existing config test — mirror its `parseAgentConfig`/`loadAgentConfig` idioms):

```ts
it('round-trips self_agent_id through loadAgentConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-selfid-'))
  writeFileSync(join(dir, 'agent-config.json'),
    JSON.stringify({ provider: 'claude', self_agent_id: 'cc-a3f92b1c' }))
  expect(loadAgentConfig(dir).self_agent_id).toBe('cc-a3f92b1c')
})

it('parseAgentConfig accepts an optional self_agent_id', () => {
  expect(parseAgentConfig({ self_agent_id: 'cc-deadbeef' }).self_agent_id).toBe('cc-deadbeef')
  expect(parseAgentConfig({}).self_agent_id).toBeUndefined()
})
```

Run (expect fail): `bun run test src/lib/agent-config.test.ts`

### Step 2.2 — config field impl

In `src/lib/agent-config.ts`:

Add to the `AgentConfig` interface (near `forward_budget?`):
```ts
  // Stable-unique self slug (spec §2): this daemon's own a2a id, crossed on the
  // pairing card and used as the registry id peers file this daemon under.
  // Additive/optional, same posture as mailbox_relays?/forward_budget?. Resolved
  // (and persisted here on first need) by resolveSelfAgentId in core/self-agent-id.ts.
  self_agent_id?: string
```

Add to `AgentConfigSchema` (near `forward_budget: ...`):
```ts
  self_agent_id: z.string().optional(),
```

Add to the `loadAgentConfig` return spread (near the `forward_budget` spread):
```ts
      ...(typeof parsed.self_agent_id === 'string' ? { self_agent_id: parsed.self_agent_id } : {}),
```

Run (expect pass): `bun run test src/lib/agent-config.test.ts`

### Step 2.3 — resolver (failing test)

Create `src/core/self-agent-id.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSelfAgentId } from './self-agent-id'
import type { AgentConfig } from '../lib/agent-config'

const base: AgentConfig = { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false }

describe('resolveSelfAgentId', () => {
  it('prefers the env override', () => {
    expect(resolveSelfAgentId(base, '/s', { env: { WECHAT_A2A_SELF_ID: 'from-env' } })).toBe('from-env')
  })

  it('uses config.self_agent_id when no env', () => {
    expect(resolveSelfAgentId({ ...base, self_agent_id: 'cc-cfg1234' }, '/s', { env: {} })).toBe('cc-cfg1234')
  })

  it('generates cc-<8hex sha256(mailbox_addr)> and persists it for a FRESH daemon (mailbox, no peers)', () => {
    const persist = vi.fn()
    const loadIdentity = vi.fn(() => ({ addr: 'AAAA_mailbox_addr' }))
    const cfg: AgentConfig = { ...base, mailbox_relays: ['https://brain.example/mailbox'] }
    const id = resolveSelfAgentId(cfg, '/s', { env: {}, loadIdentity, persist })
    expect(id).toMatch(/^cc-[0-9a-f]{8}$/)
    expect(resolveSelfAgentId(cfg, '/s', { env: {}, loadIdentity, persist })).toBe(id) // deterministic
    expect(persist).toHaveBeenCalledWith('/s', id)
  })

  it('GRANDFATHERS to wechat-cc when the config already has a2a_agents (no self_id/env)', () => {
    const persist = vi.fn()
    const loadIdentity = vi.fn()
    const cfg: AgentConfig = { ...base, mailbox_relays: ['https://brain.example/mailbox'],
      a2a_agents: [{ id: 'friend-1', name: 'F', url: 'https://f.example', inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: [], paused: false, transport: 'push' }] }
    expect(resolveSelfAgentId(cfg, '/s', { env: {}, loadIdentity, persist })).toBe('wechat-cc')
    expect(loadIdentity).not.toHaveBeenCalled()       // never mints a new identity for a grandfathered daemon
    expect(persist).toHaveBeenCalledWith('/s', 'wechat-cc')
  })

  it('keeps the legacy wechat-cc default when no mailbox is configured (never touches loadMailboxIdentity)', () => {
    const loadIdentity = vi.fn()
    expect(resolveSelfAgentId(base, '/s', { env: {}, loadIdentity })).toBe('wechat-cc')
    expect(loadIdentity).not.toHaveBeenCalled()
  })

  it('persistSelfAgentId MERGES — sets only self_agent_id, preserves a2a_agents + unmodeled disk fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfid-merge-'))
    // On-disk config carries a peer AND a legacy/unmodeled key the schema drops.
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      provider: 'claude',
      mailbox_relays: ['https://brain.example/mailbox'],
      a2a_agents: [{ id: 'cc-peer0001', name: 'peer', inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: [], transport: 'mailbox', mailbox_addr: 'A', mailbox_enc_pub: 'E', relays: ['https://brain.example/mailbox'] }],
      legacy_unmodeled_field: 'keep-me',
    }))
    // Grandfathered → persists 'wechat-cc' via the REAL merge helper (no persist stub).
    const id = resolveSelfAgentId({ ...base, mailbox_relays: ['https://brain.example/mailbox'], a2a_agents: [{ id: 'cc-peer0001' } as any] }, dir, { env: {} })
    expect(id).toBe('wechat-cc')
    const onDisk = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf8'))
    expect(onDisk.self_agent_id).toBe('wechat-cc')
    expect(onDisk.a2a_agents).toHaveLength(1)            // NOT wiped
    expect(onDisk.a2a_agents[0].id).toBe('cc-peer0001')
    expect(onDisk.legacy_unmodeled_field).toBe('keep-me') // unmodeled field survived
  })
})
```

Run (expect fail): `bun run test src/core/self-agent-id.test.ts`

### Step 2.4 — resolver impl

Create `src/core/self-agent-id.ts`:

```ts
/**
 * self-agent-id.ts — resolve this daemon's stable-unique self slug (spec §2).
 *
 * Fixes the dogfood gap where every daemon self-reported `wechat-cc`, so two
 * peers collided on the registry key. Precedence:
 *   1. WECHAT_A2A_SELF_ID env (back-compat with the manual escape hatch)
 *   2. config.self_agent_id (already generated + persisted)
 *   3. GRANDFATHER: config already has a2a_agents → persist+return 'wechat-cc'
 *      (freeze the id existing peers filed this daemon under — flipping to a
 *      unique slug would silently 401 every established edge; spec §2)
 *   4. mailbox configured + NO pre-existing peers (fresh daemon) → mint
 *      `cc-` + sha256(mailbox_addr)[:8hex], persist to agent-config.json
 *   5. legacy `wechat-cc` when NO mailbox is configured
 *
 * Step 4 only runs when mailbox_relays is configured AND there are no peers yet —
 * pairing (the sole caller that needs a real unique slug) requires a relay anyway,
 * and loadMailboxIdentity is side-effectful (writes mailbox-key.json), so neither a
 * push-only nor a grandfathered daemon may trip it.
 *
 * Persistence MERGES (read-modify-write of the raw config file, mirroring
 * a2a-registry.persistAll) — it sets ONLY self_agent_id and never touches
 * a2a_agents or unmodeled/legacy disk keys. This is load-bearing: callers may
 * pass a boot-snapshot config whose a2a_agents predates post-boot registry
 * writes; a full-object saveAgentConfig would wipe those peers off disk.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadMailboxIdentity } from './mailbox-crypto'
import type { AgentConfig } from '../lib/agent-config'

export interface ResolveSelfAgentIdDeps {
  env?: Record<string, string | undefined>
  loadIdentity?: (stateDir: string) => { addr: string }
  /** MERGE-persist: set only self_agent_id in the raw config file. Stubbable. */
  persist?: (stateDir: string, selfAgentId: string) => void
}

/** Read-modify-write the raw agent-config.json, setting ONLY self_agent_id.
 *  Preserves a2a_agents + every unmodeled key; atomic tmp+rename (0600). */
function persistSelfAgentId(stateDir: string, selfAgentId: string): void {
  const path = join(stateDir, 'agent-config.json')
  let raw: Record<string, unknown> = {}
  if (existsSync(path)) {
    try { raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> } catch { raw = {} }
  }
  raw.self_agent_id = selfAgentId
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function resolveSelfAgentId(config: AgentConfig, stateDir: string, deps: ResolveSelfAgentIdDeps = {}): string {
  const env = deps.env ?? process.env
  const fromEnv = env.WECHAT_A2A_SELF_ID
  if (fromEnv) return fromEnv
  if (config.self_agent_id) return config.self_agent_id
  const persist = deps.persist ?? persistSelfAgentId
  if (config.mailbox_relays?.length) {
    // Grandfather: keep the legacy shared id if this daemon already has edges.
    if (config.a2a_agents?.length) {
      persist(stateDir, 'wechat-cc')
      return 'wechat-cc'
    }
    const load = deps.loadIdentity ?? loadMailboxIdentity
    const addr = load(stateDir).addr
    const slug = 'cc-' + createHash('sha256').update(addr).digest('hex').slice(0, 8)
    persist(stateDir, slug)
    return slug
  }
  return 'wechat-cc'
}
```

Note: `cc-<8 lowercase hex>` satisfies the `A2AAgentRecord.id` regex `^[a-z0-9][a-z0-9-]{0,63}$`. The grandfather branch never mints a slug (so no `mailbox-key.json` side effect for an existing daemon that happened to have no key file yet).

Run (expect pass): `bun run test src/core/self-agent-id.test.ts`

### Step 2.5 — wire-social swap

In `src/daemon/bootstrap/wire-social.ts`:
- Add import near the other `../../core/*` imports:
  ```ts
  import { resolveSelfAgentId } from '../../core/self-agent-id'
  ```
- Replace line ~122:
  ```ts
        const SOCIAL_SELF_ID = process.env.WECHAT_A2A_SELF_ID || 'wechat-cc'
  ```
  with:
  ```ts
        // spec §2 — one stable-unique slug per daemon (env > config > generated).
        // Legacy 'wechat-cc' preserved when no mailbox_relays is configured.
        const SOCIAL_SELF_ID = resolveSelfAgentId(configuredAgent, deps.stateDir)
  ```

Regression: the existing bootstrap.social test (`src/daemon/bootstrap.test.ts:1054`) configures social WITHOUT `mailbox_relays` and without the env override, so `SOCIAL_SELF_ID` still resolves to `wechat-cc` — no behavior change. Run:
```
bun run test src/daemon/bootstrap.test.ts
# Expected: PASS (unchanged)
```

### Step 2.6 — commit
```
git add src/lib/agent-config.ts src/core/self-agent-id.ts src/core/self-agent-id.test.ts \
        src/lib/agent-config.test.ts src/daemon/bootstrap/wire-social.ts
git commit -m "feat(pairing): stable-unique self_agent_id resolver + config field; wire-social uses it"
```

---

## Task 3 — `A2AAgentRecord.url` optional for `transport:'mailbox'` (+ guard the 3 unguarded `.url` consumers)

### Interfaces
- **Produces:** `A2AAgentRecord` with `url` optional + object-level `superRefine` (url required unless `transport==='mailbox'`); guards at three `wire-social.ts` sites that currently pass a mailbox peer's `undefined` url into `intentUrl`/`revealUrl` (→ `TypeError` on `.replace`).
- **Consumers that ARE unchanged:** `a2a-registry.ts` (`validatePatch` only checks url when provided); `loadAgentConfig`'s `A2AAgentRecord.safeParse` filter; the letter path (`letterUrl` via `makeRoutePostLetter` already routes mailbox peers by `peerMailboxOf`); `postReveal` (`wire-social.ts:302` already short-circuits mailbox peers via `peerMailboxOf`).
- **IMPORTANT-2 fix — three consumers that BREAK on a url-less mailbox peer (correcting the earlier "consumers unchanged" claim, which was false).** `intentUrl`/`revealUrl` open with `agentUrl.replace(...)` → throw on `undefined`. A url-less mailbox peer (the entire point of this feature) reaches all three on the FIRST forage round:
  1. `wire-social.ts:~411` `broker.discover` — `a2aRegistry.list().filter(a => !a.paused)`: no transport filter.
  2. `wire-social.ts:~373` `forwardTargets` — same, no transport filter.
  3. `wire-social.ts:~288` `postPeerReveal` — calls `revealUrl(hand.url)` with NO `peerMailboxOf` short-circuit (unlike its sibling `postReveal:302`).
  Guard all three: filter `transport==='mailbox' && !url` peers OUT of `discover`/`forwardTargets`, and short-circuit `postPeerReveal` for mailbox peers (return `null`), each with a one-line comment that seek/reveal-over-mailbox is deferred (spec §10). This is scoped to THIS task because the url-optional schema is what first lets such a peer exist.

### Step 3.1 — failing test

Add to `src/lib/agent-config.test.ts`:

```ts
describe('A2AAgentRecord url-optional-for-mailbox', () => {
  const key = 'k'.repeat(16)
  const mailboxRec = { id: 'cc-a3f92b1c', name: 'peer', inbound_api_key: key, outbound_api_key: 'ob',
    capabilities: [], transport: 'mailbox' as const, mailbox_addr: 'A', mailbox_enc_pub: 'E', relays: ['https://r.example/mailbox'] }

  it('accepts a mailbox record with NO url', () => {
    expect(A2AAgentRecord.safeParse(mailboxRec).success).toBe(true)
  })
  it('rejects a push record with NO url', () => {
    const { transport, ...rest } = mailboxRec
    expect(A2AAgentRecord.safeParse({ ...rest, transport: 'push' }).success).toBe(false)
  })
  it('rejects a ws record with NO url', () => {
    const { transport, ...rest } = mailboxRec
    expect(A2AAgentRecord.safeParse({ ...rest, transport: 'ws' }).success).toBe(false)
  })
  it('still accepts a push record WITH a valid url (back-compat)', () => {
    expect(A2AAgentRecord.safeParse({ ...mailboxRec, transport: 'push', url: 'https://peer.example' }).success).toBe(true)
  })
  it('an old mailbox config with url set still parses', () => {
    expect(A2AAgentRecord.safeParse({ ...mailboxRec, url: 'https://peer.example' }).success).toBe(true)
  })
})
```
(Ensure `A2AAgentRecord` is imported from `../lib/agent-config` at the top of the test file.)

Run (expect fail — the current `url: z.string().url()` rejects the url-less mailbox record):
```
bun run test src/lib/agent-config.test.ts
```

### Step 3.2 — impl

In `src/lib/agent-config.ts`, change the `A2AAgentRecord` definition:
- `url: z.string().url(),` → `url: z.string().url().optional(),`
- append an object-level `superRefine` after the `z.object({...})` (before the `export type`):

```ts
export const A2AAgentRecord = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'agent id must match ^[a-z0-9][a-z0-9-]{0,63}$ (lowercase slug)'),
  name: z.string().min(1).max(128),
  url: z.string().url().optional(),
  inbound_api_key: z.string().min(16),
  outbound_api_key: z.string().min(1),
  capabilities: z.array(z.string()),
  paused: z.boolean().default(false),
  transport: z.enum(['push', 'ws', 'mailbox']).default('push'),
  mailbox_addr: z.string().optional(),
  mailbox_enc_pub: z.string().optional(),
  relays: z.array(z.string().url()).optional(),
  proto_version: z.number().int().optional(),
}).superRefine((rec, ctx) => {
  // url is optional ONLY for mailbox transport (pure-NAT peers have no public
  // url). push/ws still require a reachable url. spec §6.
  if (rec.transport !== 'mailbox' && !rec.url) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: `url is required for transport '${rec.transport}'` })
  }
})
```
`z.infer<typeof A2AAgentRecord>` still infers `url?: string`; `.safeParse` works through the `ZodEffects` wrapper; the `z.array(A2AAgentRecord)` in `AgentConfigSchema` (with its own duplicate-id `superRefine`) is unaffected.

Run (expect pass): `bun run test src/lib/agent-config.test.ts`
Also verify no registry regression: `bun run test src/core/a2a-registry.test.ts`

### Step 3.3 — guard the three `.url` consumers (failing test first)

**Regression test.** Add a case to the wire-social test suite (`src/daemon/bootstrap/wire-social.test.ts` or the nearest existing social-wiring test) that registers a url-less mailbox peer and drives one forage/answer round, asserting NO throw and that the peer is skipped by the push-path consumers:

```ts
it('a url-less mailbox peer never reaches intentUrl/revealUrl (skipped, no TypeError)', async () => {
  // Registry holds ONE peer: transport mailbox, url undefined (the pairing feature's output).
  const mailboxPeer = { id: 'cc-aaaa1111', name: 'Alice', inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o',
    capabilities: [], paused: false, transport: 'mailbox' as const, mailbox_addr: 'A', mailbox_enc_pub: 'E', relays: ['https://brain.example/mailbox'] }
  const a2aRegistry = { list: () => [mailboxPeer], get: (id: string) => id === mailboxPeer.id ? mailboxPeer : null, /* … */ } as any
  const wiring = await wireSocial(makeSocialDeps({ a2aRegistry, /* social_enabled + policy set */ }))
  // discover/forwardTargets must not surface the url-less mailbox peer to a push send.
  await expect(wiring.social!.broker.seek('anything')).resolves.toBeDefined() // no throw
  // postPeerReveal short-circuits for a mailbox peer → null, no revealUrl(undefined).
  // (Drive via the onReveal/broker seam the existing tests already use.)
})
```
Run (expect fail — the current unguarded sites throw / surface the peer): `bun run test src/daemon/bootstrap/wire-social.test.ts`

**Impl** in `src/daemon/bootstrap/wire-social.ts`:

1. `broker.discover` (~line 411):
   ```ts
   // url-less mailbox peers can't take a push /a2a/intent (intentUrl needs a url);
   // seek-over-mailbox is deferred (spec §10) — skip them here.
   discover: async (_topic) => a2aRegistry.list().filter(a => !a.paused && !(a.transport === 'mailbox' && !a.url)).slice(0, 5),
   ```
2. `forwardTargets` (~line 373):
   ```ts
   try { return a2aRegistry.list().filter(a => !a.paused && a.id !== excludeAgentId && !(a.transport === 'mailbox' && !a.url)).slice(0, 5) }
   ```
3. `postPeerReveal` (~line 281) — short-circuit a url-less mailbox peer the way `postReveal` already does:
   ```ts
   const hand = a2aRegistry.get(agentId)
   if (!hand) return null
   // reveal-over-mailbox is deferred (spec §10): a mailbox peer has no url for
   // revealUrl(). Mirror postReveal's peerMailboxOf short-circuit — skip cleanly.
   if (hand.transport === 'mailbox' && !hand.url) return null
   ```

Run (expect pass): `bun run test src/daemon/bootstrap/wire-social.test.ts`
Regression sweep: `bun run test src/daemon/bootstrap.test.ts`

### Step 3.4 — commit
```
git add src/lib/agent-config.ts src/lib/agent-config.test.ts \
        src/daemon/bootstrap/wire-social.ts src/daemon/bootstrap/wire-social.test.ts
git commit -m "feat(pairing): A2AAgentRecord.url optional for mailbox + guard 3 push-path .url consumers"
```

---

## Task 4 — `pairing.ts`: the deps-injected pairing engine

### Interfaces
- **Produces:** `src/core/pairing.ts`:
  ```ts
  export interface PairCard {
    v: 1; role: 'initiator' | 'acceptor'; nonce: string
    self_id: string; name: string; url?: string
    mailbox_addr: string; mailbox_enc_pub: string; relays: string[]
    bearer: string
  }
  export type PairResult =
    | { ok: true; peer: { self_id: string; name: string } }
    | { ok: false; reason: 'expired_or_wrong' | 'self_pair' | 'id_conflict' }
  export interface PairScheduleHandle { cancel(): void }
  export interface PairingDeps {
    client: MailboxClient
    registry: A2ARegistry
    self: { mailbox_addr: string; mailbox_enc_pub: string; relays: string[] } // own mailbox (card fields); relays[0] = rendezvous relay
    selfId: () => string
    name: () => string
    url?: () => string | undefined
    now: () => number
    mintKey: () => string   // >=16-char inbound key this daemon mints for the peer
    genCode: () => string   // 6-digit code
    genNonce: () => string
    notify: (msg: string) => void
    schedule: (fn: () => void, ms: number) => PairScheduleHandle
    pollIntervalMs?: number // default 10_000
    ttlMs?: number          // default 600_000
    log?: (msg: string) => void
  }
  export interface PairingEngine {
    start(): { code: string; expiresAt: number }
    accept(code: string): Promise<PairResult>
    stop(): void
  }
  export function makePairing(deps: PairingDeps): PairingEngine
  ```
- **Consumes:** `deriveRendezvous` (T1), `sealEnvelope`/`openEnvelope`/`signFetch` (`mailbox-crypto.ts`), `MailboxClient` (`mailbox-client.ts`), `A2ARegistry`/`A2AAgentRecord`.
- **Produced-for-C:** `boot.pairing = { start, accept }` (Task 6 wires `makePairing` with real deps).
- **IMPORTANT-3 consequence — `writePeerFromCard` must guard same-id-different-mailbox.** With the grandfather rule, a daemon can still self-report `wechat-cc`, so an incoming card's `self_id` may collide with an UNRELATED existing peer (someone else already filed under `wechat-cc`). Blind overwrite-by-`self_id` would clobber that peer. Guard: overwrite ONLY when the existing record's `mailbox_addr` equals the incoming card's (a true re-pair / key rotation). On same-id-different-`mailbox_addr`, REJECT the pairing (`reason:'id_conflict'`) WITHOUT writing or dropping a card; the surfaces show 「对方 bot 使用旧版共享身份且与你已有的朋友撞名——请让对方升级出唯一身份后重试」. A record with no `mailbox_addr` (a push peer under the same id) is likewise a mismatch → reject.
- **First-dropper-wins (minor b, also in spec §4):** cards are read in cursor-ascending order (the relay returns `items` ascending, no ack/deletion during pairing), and both `accept`'s `.find(role==='initiator')` and the poller's `.find(role==='acceptor')` take the FIRST match — so if a griefer who knows the code drops a rival card, the earliest legitimate drop wins. A same-id-different-`mailbox_addr` rival that sorts first surfaces as `id_conflict` (safe reject), not a silent clobber.
- **Minor a (symmetry):** the initiator poller's acceptor filter also excludes `c.self_id === deps.selfId()`, matching `accept`'s self-pair rejection.
- **Minor c (accepted):** a single `/fetch` returns ≤64 items (relay page size, no client pagination) — a code-holder could bury the real card past item 64. Same threat class as the §3 "third party who has the code" risk; accepted for v0, PAKE-era hardening.
- **Minor d (harmless):** the relay retains dropped envelopes ~7d, but the client-side TTL is 10 min — a sealed rendezvous card lingers server-side after the code expires. It's opaque ciphertext to a shared box nobody re-derives once the code is spent; harmless, no client action.

### Step 4.1 — failing unit test

Create `src/core/pairing.test.ts`. Uses a fake in-memory `MailboxClient` (a `Map<addr, string[]>` of dropped envelopes; `fetch` returns all since 0, no ack) and a fake `A2ARegistry`. A manual scheduler captures the latest armed callback so the test fires poll ticks deterministically.

```ts
import { describe, it, expect, vi } from 'vitest'
import { makePairing, type PairingDeps, type PairCard } from './pairing'
import type { MailboxClient } from './mailbox-client'
import type { A2ARegistry, A2AAgentRecord } from './a2a-registry'

// ── shared in-process relay (a Map keyed by rendezvous addr) ──
function makeFakeRelay() {
  const boxes = new Map<string, string[]>()
  const client: MailboxClient = {
    async drop(_url, to, env) { (boxes.get(to) ?? boxes.set(to, []).get(to)!).push(env); return true },
    async fetch(_url, mailbox, _since) {
      const items = (boxes.get(mailbox) ?? []).map((envelope, i) => ({ cursor: i + 1, envelope }))
      return { items, next_cursor: items.length }
    },
    async ack() { throw new Error('ack must NOT be called during pairing') },
  }
  return { client }
}

function makeFakeRegistry(): A2ARegistry & { records: Map<string, A2AAgentRecord> } {
  const records = new Map<string, A2AAgentRecord>()
  return {
    records,
    list: () => [...records.values()],
    get: (id) => records.get(id) ?? null,
    verifyBearer: () => null,
    add: (rec) => { if (records.has(rec.id)) throw new Error('exists'); records.set(rec.id, rec) },
    remove: (id) => { records.delete(id) },
    setPaused: () => {},
    update: (id) => records.get(id)!,
  }
}

// Manual scheduler: remembers the latest armed callback; tick() fires it.
function makeManualScheduler() {
  let armed: (() => void) | null = null
  let cancelled = false
  const schedule: PairingDeps['schedule'] = (fn) => { armed = fn; return { cancel() { cancelled = true; armed = null } } }
  return { schedule, tick: () => { if (armed && !cancelled) armed() }, get cancelled() { return cancelled } }
}

function baseDeps(over: Partial<PairingDeps>): PairingDeps {
  return {
    client: makeFakeRelay().client,
    registry: makeFakeRegistry(),
    self: { mailbox_addr: 'MB', mailbox_enc_pub: 'EP', relays: ['https://r.example/mailbox'] },
    selfId: () => 'cc-self0001',
    name: () => 'me',
    now: () => 1000,
    mintKey: () => 'minted-key-000000000000',
    genCode: () => '483921',
    genNonce: () => 'nonceX',
    notify: () => {},
    schedule: () => ({ cancel() {} }),
    ...over,
  }
}

describe('pairing engine', () => {
  it('start → accept → poller: both sides file a correct mailbox record with crossed keys', async () => {
    const relay = makeFakeRelay()
    const regA = makeFakeRegistry(); const regB = makeFakeRegistry()
    const sched = makeManualScheduler()
    let keyI = 'keyI-0000000000000000'; let keyA = 'keyA-0000000000000000'

    const A = makePairing(baseDeps({
      client: relay.client, registry: regA, schedule: sched.schedule,
      self: { mailbox_addr: 'A_MB', mailbox_enc_pub: 'A_EP', relays: ['https://r/mailbox'] },
      selfId: () => 'cc-aaaa1111', name: () => 'Alice', mintKey: () => keyI, genNonce: () => 'nA', genCode: () => '483921',
    }))
    const B = makePairing(baseDeps({
      client: relay.client, registry: regB,
      self: { mailbox_addr: 'B_MB', mailbox_enc_pub: 'B_EP', relays: ['https://r/mailbox'] },
      selfId: () => 'cc-bbbb2222', name: () => 'Bob', mintKey: () => keyA, genNonce: () => 'nB',
    }))

    const { code } = A.start()
    const res = await B.accept(code)
    expect(res).toEqual({ ok: true, peer: { self_id: 'cc-aaaa1111', name: 'Alice' } })

    // B filed A under A's self_id, keys crossed, transport mailbox, NO url.
    const bRec = regB.records.get('cc-aaaa1111')!
    expect(bRec.transport).toBe('mailbox')
    expect(bRec.url).toBeUndefined()
    expect(bRec.outbound_api_key).toBe(keyI) // = CardI.bearer
    expect(bRec.inbound_api_key).toBe(keyA)  // = B's minted key
    expect(bRec.mailbox_addr).toBe('A_MB'); expect(bRec.mailbox_enc_pub).toBe('A_EP')

    // Now A's poller sees CardA.
    sched.tick()
    await new Promise(r => setTimeout(r, 0)) // let the async tick settle
    const aRec = regA.records.get('cc-bbbb2222')!
    expect(aRec.outbound_api_key).toBe(keyA) // = CardA.bearer
    expect(aRec.inbound_api_key).toBe(keyI)  // = A's minted key
    // crossing proven:
    expect(aRec.outbound_api_key).toBe(bRec.inbound_api_key)
    expect(bRec.outbound_api_key).toBe(aRec.inbound_api_key)
  })

  it('accept with a code no initiator ever dropped → expired_or_wrong', async () => {
    const B = makePairing(baseDeps({}))
    expect(await B.accept('000000')).toEqual({ ok: false, reason: 'expired_or_wrong' })
  })

  it('rejects self-pair (same self_id) without dropping a card', async () => {
    const relay = makeFakeRelay()
    const A = makePairing(baseDeps({ client: relay.client, selfId: () => 'cc-same', genNonce: () => 'nA' }))
    const B = makePairing(baseDeps({ client: relay.client, selfId: () => 'cc-same' }))
    const { code } = A.start()
    expect(await B.accept(code)).toEqual({ ok: false, reason: 'self_pair' })
  })

  it('poller ignores the initiator OWN card (role/nonce filter), never self-files', async () => {
    const relay = makeFakeRelay(); const regA = makeFakeRegistry(); const sched = makeManualScheduler()
    const A = makePairing(baseDeps({ client: relay.client, registry: regA, schedule: sched.schedule, selfId: () => 'cc-aaaa' }))
    A.start()
    sched.tick() // only CardI (role initiator) is in the box — must be ignored
    await new Promise(r => setTimeout(r, 0))
    expect(regA.records.size).toBe(0)
  })

  it('poller past TTL → notifies timeout and stops (no re-arm)', async () => {
    const relay = makeFakeRelay(); const sched = makeManualScheduler(); const notify = vi.fn()
    let t = 1000
    const A = makePairing(baseDeps({ client: relay.client, schedule: sched.schedule, notify, now: () => t, ttlMs: 600_000 }))
    A.start()
    t = 1000 + 600_001
    sched.tick()
    await new Promise(r => setTimeout(r, 0))
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('过期'))
    expect(sched.cancelled).toBe(true)
  })

  it('re-pair overwrites an existing record for the same self_id AND same mailbox_addr', async () => {
    const relay = makeFakeRelay(); const regB = makeFakeRegistry()
    // A's card carries mailbox_addr 'A_MB' (its own self.mailbox_addr) → a true re-pair.
    regB.records.set('cc-aaaa1111', { id: 'cc-aaaa1111', name: 'stale', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'old', capabilities: [], paused: false, transport: 'mailbox', mailbox_addr: 'A_MB' })
    const A = makePairing(baseDeps({ client: relay.client, self: { mailbox_addr: 'A_MB', mailbox_enc_pub: 'A_EP', relays: ['https://r/mailbox'] }, selfId: () => 'cc-aaaa1111', name: () => 'Alice', mintKey: () => 'keyI-0000000000000000' }))
    const B = makePairing(baseDeps({ client: relay.client, registry: regB, selfId: () => 'cc-bbbb2222', mintKey: () => 'keyA-0000000000000000' }))
    const { code } = A.start()
    await B.accept(code)
    expect(regB.records.get('cc-aaaa1111')!.outbound_api_key).toBe('keyI-0000000000000000') // overwritten
  })

  it('rejects id_conflict on accept: same self_id, DIFFERENT mailbox_addr (unrelated wechat-cc peer) — no write, no card drop', async () => {
    const relay = makeFakeRelay(); const regB = makeFakeRegistry()
    // B already has an UNRELATED peer filed under the legacy shared id 'wechat-cc'.
    regB.records.set('wechat-cc', { id: 'wechat-cc', name: 'someone-else', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'ob', capabilities: [], paused: false, transport: 'mailbox', mailbox_addr: 'OTHER_MB' })
    // A is a grandfathered daemon still self-reporting 'wechat-cc' with a DIFFERENT mailbox.
    const A = makePairing(baseDeps({ client: relay.client, self: { mailbox_addr: 'A_MB', mailbox_enc_pub: 'A_EP', relays: ['https://r/mailbox'] }, selfId: () => 'wechat-cc', name: () => 'Alice' }))
    const B = makePairing(baseDeps({ client: relay.client, registry: regB, selfId: () => 'cc-bbbb2222' }))
    const { code } = A.start()
    const res = await B.accept(code)
    expect(res).toEqual({ ok: false, reason: 'id_conflict' })
    expect(regB.records.get('wechat-cc')!.name).toBe('someone-else') // untouched
    // No acceptor card dropped (only A's initiator card is in the box).
    // (Assert via the fake relay box length == 1 if the harness exposes it.)
  })

  it('rejects id_conflict in the poller: acceptor card collides with an unrelated same-id record', async () => {
    const relay = makeFakeRelay(); const regA = makeFakeRegistry(); const sched = makeManualScheduler(); const notify = vi.fn()
    // A already has an unrelated peer 'wechat-cc' with mailbox OTHER_MB.
    regA.records.set('wechat-cc', { id: 'wechat-cc', name: 'someone-else', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'ob', capabilities: [], paused: false, transport: 'mailbox', mailbox_addr: 'OTHER_MB' })
    const A = makePairing(baseDeps({ client: relay.client, registry: regA, schedule: sched.schedule, notify, selfId: () => 'cc-aaaa1111', name: () => 'Alice', genNonce: () => 'nA' }))
    // B is grandfathered 'wechat-cc' with a different mailbox → its acceptor card conflicts.
    const B = makePairing(baseDeps({ client: relay.client, self: { mailbox_addr: 'B_MB', mailbox_enc_pub: 'B_EP', relays: ['https://r/mailbox'] }, selfId: () => 'wechat-cc', name: () => 'Bob', genNonce: () => 'nB' }))
    const { code } = A.start()
    await B.accept(code)
    sched.tick()
    await new Promise(r => setTimeout(r, 0))
    expect(regA.records.get('wechat-cc')!.name).toBe('someone-else') // NOT clobbered
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('撞名'))
    expect(sched.cancelled).toBe(true)
  })
})
```
(If the id_conflict "no card drop" assertion is wanted, have `makeFakeRelay` also return its `boxes` map so the test can read box length.)

Run (expect fail): `bun run test src/core/pairing.test.ts`

### Step 4.2 — impl

Create `src/core/pairing.ts`:

```ts
/**
 * pairing.ts — the 配对码 engine (spec §4–§6). Deps-injected: no direct network,
 * clock, or scheduler, so it unit-tests against a fake relay + registry.
 *
 * start()  — initiator: mint a code + keyI, derive the rendezvous identity, seal
 *            its own card and drop it into the shared rendezvous box, then arm a
 *            bounded ~10s poller (≤10 min) waiting for the acceptor's card.
 * accept() — acceptor: derive the same identity, fetch the box, find the
 *            initiator card, reject self-pair, write the peer record, drop its
 *            own card back.
 * writePeerFromCard — shared: overwrite-by-self_id, bearer crossing (spec §5):
 *            outbound_api_key = card.bearer, inbound_api_key = the key WE minted.
 *
 * NO ack (shared box; ack is a global delete — §4). Cards carry role + nonce so
 * each side ignores its own. Only one active initiator code at a time (a new
 * start() supersedes). Not restart-persistent (§8).
 */
import { deriveRendezvous } from './pairing-crypto'
import { sealEnvelope, openEnvelope, signFetch, type Envelope } from './mailbox-crypto'
import type { MailboxClient } from './mailbox-client'
import type { A2ARegistry, A2AAgentRecord } from './a2a-registry'

export interface PairCard {
  v: 1
  role: 'initiator' | 'acceptor'
  nonce: string
  self_id: string
  name: string
  url?: string
  mailbox_addr: string
  mailbox_enc_pub: string
  relays: string[]
  bearer: string
}

export type PairResult =
  | { ok: true; peer: { self_id: string; name: string } }
  | { ok: false; reason: 'expired_or_wrong' | 'self_pair' | 'id_conflict' }

export interface PairScheduleHandle { cancel(): void }

export interface PairingDeps {
  client: MailboxClient
  registry: A2ARegistry
  self: { mailbox_addr: string; mailbox_enc_pub: string; relays: string[] }
  selfId: () => string
  name: () => string
  url?: () => string | undefined
  now: () => number
  mintKey: () => string
  genCode: () => string
  genNonce: () => string
  notify: (msg: string) => void
  schedule: (fn: () => void, ms: number) => PairScheduleHandle
  pollIntervalMs?: number
  ttlMs?: number
  log?: (msg: string) => void
}

export interface PairingEngine {
  start(): { code: string; expiresAt: number }
  accept(code: string): Promise<PairResult>
  stop(): void
}

interface ActiveInitiator {
  code: string
  nonce: string
  myKey: string
  expiresAt: number
  rvAddr: string
  rvEncPriv: string
  rvSign: (m: string) => string
  handle: PairScheduleHandle | null
}

export function makePairing(deps: PairingDeps): PairingEngine {
  const pollIntervalMs = deps.pollIntervalMs ?? 10_000
  const ttlMs = deps.ttlMs ?? 600_000
  const rendezvousRelay = deps.self.relays[0]!
  let active: ActiveInitiator | null = null

  function ownCard(role: PairCard['role'], nonce: string, bearer: string): PairCard {
    const u = deps.url?.()
    return {
      v: 1, role, nonce,
      self_id: deps.selfId(), name: deps.name(),
      ...(u ? { url: u } : {}),
      mailbox_addr: deps.self.mailbox_addr,
      mailbox_enc_pub: deps.self.mailbox_enc_pub,
      relays: deps.self.relays,
      bearer,
    }
  }

  // spec §5/§6: outbound_api_key = card.bearer (peer's key for us), inbound_api_key
  // = the key WE minted (peer stores it as THEIR outbound). Overwrite-by-self_id,
  // but ONLY on a true re-pair (same self_id AND same mailbox_addr). A same-id +
  // different/absent mailbox_addr is an UNRELATED peer colliding on a legacy
  // shared 'wechat-cc' id (grandfather rule, spec §2) — overwriting would clobber
  // it, so reject the pairing instead (id_conflict).
  function writePeerFromCard(card: PairCard, myMintedKey: string): { ok: true } | { ok: false; reason: 'id_conflict' } {
    const existing = deps.registry.get(card.self_id)
    if (existing && existing.mailbox_addr !== card.mailbox_addr) return { ok: false, reason: 'id_conflict' }
    const rec: A2AAgentRecord = {
      id: card.self_id,
      name: card.name,
      ...(card.url ? { url: card.url } : {}),
      inbound_api_key: myMintedKey,
      outbound_api_key: card.bearer,
      capabilities: [],
      paused: false,
      transport: 'mailbox',
      mailbox_addr: card.mailbox_addr,
      mailbox_enc_pub: card.mailbox_enc_pub,
      relays: card.relays,
    }
    if (existing) deps.registry.remove(rec.id) // full overwrite of the true re-pair (§6)
    deps.registry.add(rec)
    return { ok: true }
  }

  const ID_CONFLICT_MSG = '对方 bot 使用旧版共享身份且与你已有的朋友撞名——请让对方升级出唯一身份后重试'

  // Cards come back in cursor-ASCENDING order (relay returns items ascending; no
  // ack/deletion during pairing), so callers' `.find(...)` = FIRST-dropper-wins
  // (spec §4). Note: a single /fetch returns ≤64 items (no client pagination) —
  // a code-holder could bury the card past item 64; accepted for v0 (same threat
  // class as §3's "third party who has the code").
  function readCards(rvAddr: string, rvEncPriv: string, rvSign: (m: string) => string): Promise<PairCard[]> {
    const ts = deps.now()
    return deps.client.fetch(rendezvousRelay, rvAddr, 0, ts, signFetch(rvSign, rvAddr, ts)).then(res => {
      if (!res) return []
      const cards: PairCard[] = []
      for (const item of res.items) {
        let env: Envelope
        try { env = JSON.parse(item.envelope) as Envelope } catch { continue }
        const inner = openEnvelope(rvEncPriv, env)
        if (!inner) continue
        const card = inner.body as PairCard
        if (card && card.v === 1 && (card.role === 'initiator' || card.role === 'acceptor')) cards.push(card)
      }
      return cards
    })
  }

  function stop(): void {
    if (active?.handle) active.handle.cancel()
    active = null
  }

  function start(): { code: string; expiresAt: number } {
    stop() // supersede any prior active code (§8: one at a time)
    const code = deps.genCode()
    const rv = deriveRendezvous(code)
    const myKey = deps.mintKey()
    const nonce = deps.genNonce()
    const expiresAt = deps.now() + ttlMs
    const cur: ActiveInitiator = { code, nonce, myKey, expiresAt, rvAddr: rv.addr, rvEncPriv: rv.enc_priv, rvSign: rv.sign, handle: null }
    active = cur

    const env = sealEnvelope({ path: '/pair', bearer: '', body: ownCard('initiator', nonce, myKey) }, rv.enc_pub)
    void deps.client.drop(rendezvousRelay, rv.addr, JSON.stringify(env)).catch(e => deps.log?.(`pair drop failed: ${String(e)}`))

    const tick = (): void => {
      if (active !== cur) return // superseded
      if (deps.now() >= cur.expiresAt) {
        stop()
        deps.notify('配对码过期了,没等到朋友——要再来一次说“配对”')
        return
      }
      void readCards(cur.rvAddr, cur.rvEncPriv, cur.rvSign).then(cards => {
        if (active !== cur) return
        // Minor a: exclude our own card by self_id too (symmetry with accept's
        // self-pair reject), not just by nonce.
        const peer = cards.find(c => c.role === 'acceptor' && c.nonce !== cur.nonce && c.self_id !== deps.selfId())
        if (peer) {
          const write = writePeerFromCard(peer, cur.myKey)
          stop()
          deps.notify(write.ok ? `和 ${peer.name} 的 bot 连上了 ✓ 现在可以互相觅食/写信了` : ID_CONFLICT_MSG)
          return
        }
        cur.handle = deps.schedule(tick, pollIntervalMs)
      }).catch(e => {
        deps.log?.(`pair poll failed: ${String(e)}`)
        if (active === cur) cur.handle = deps.schedule(tick, pollIntervalMs)
      })
    }
    cur.handle = deps.schedule(tick, pollIntervalMs)
    return { code, expiresAt }
  }

  async function accept(code: string): Promise<PairResult> {
    const rv = deriveRendezvous(code)
    const cards = await readCards(rv.addr, rv.enc_priv, rv.sign)
    const initiator = cards.find(c => c.role === 'initiator')
    if (!initiator) return { ok: false, reason: 'expired_or_wrong' }
    if (initiator.self_id === deps.selfId()) return { ok: false, reason: 'self_pair' }

    const myKey = deps.mintKey()
    const write = writePeerFromCard(initiator, myKey)
    if (!write.ok) { deps.notify(ID_CONFLICT_MSG); return { ok: false, reason: 'id_conflict' } } // no card drop on conflict

    const env = sealEnvelope({ path: '/pair', bearer: '', body: ownCard('acceptor', deps.genNonce(), myKey) }, rv.enc_pub)
    await deps.client.drop(rendezvousRelay, rv.addr, JSON.stringify(env))

    deps.notify(`和 ${initiator.name} 的 bot 连上了 ✓ 现在可以互相觅食/写信了`)
    return { ok: true, peer: { self_id: initiator.self_id, name: initiator.name } }
  }

  return { start, accept, stop }
}
```

> Note on the poller re-arm: `tick` re-schedules itself only when no peer card is found yet and the
> code isn't superseded/expired — the manual scheduler in the test fires exactly one tick per
> `tick()` call, so assertions are deterministic. Real wiring (Task 6) injects a `setTimeout`-backed
> `schedule`.

Run (expect pass): `bun run test src/core/pairing.test.ts`

### Step 4.3 — commit
```
git add src/core/pairing.ts src/core/pairing.test.ts
git commit -m "feat(pairing): deps-injected pairing engine (start/accept/writePeerFromCard, bounded poller)"
```

---

## Task 5 — Integration: two engines vs. one in-process relay

### Interfaces
- **Consumes:** `makePairing` (T4), `deriveRendezvous` (T1) [indirectly], `makeRelayServer` (`relay/server.ts`), the real `MailboxClient` shape adapted onto `srv.fetchHandler`.
- **Goal:** prove the full round-trip against the REAL relay code (envelope opacity, signed fetch, size/rate untouched) — not a `Map` fake.

### Step 5.1 — failing test

Create `src/core/pairing.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Database } from 'bun:sqlite'
import { makeRelayServer } from '../../relay/server'
import { makePairing, type PairingDeps } from './pairing'
import type { MailboxClient } from './mailbox-client'

const NOW = 1_700_000_000_000

// A MailboxClient that speaks to an in-process relay via its fetchHandler
// (same idiom as relay/server.test.ts). drop/fetch only — pairing never acks.
function inProcessClient(srv: ReturnType<typeof makeRelayServer>): MailboxClient {
  const req = (path: string, body: unknown) => new Request(`http://relay${path}`, { method: 'POST', body: JSON.stringify(body) })
  return {
    async drop(_url, to, envelope) { return (await srv.fetchHandler(req('/drop', { to, envelope }), '127.0.0.1')).ok },
    async fetch(_url, mailbox, since, ts, sig) {
      const r = await srv.fetchHandler(req('/fetch', { mailbox, since, ts, sig }), '127.0.0.1')
      if (!r.ok) return null
      return await r.json() as { items: Array<{ cursor: number; envelope: string }>; next_cursor: number }
    },
    async ack() { throw new Error('ack must not be called during pairing') },
  }
}

// A tiny in-memory A2ARegistry for the test (add/get/remove only).
function memRegistry() {
  const m = new Map<string, any>()
  return { m, list: () => [...m.values()], get: (id: string) => m.get(id) ?? null, verifyBearer: () => null,
    add: (r: any) => { if (m.has(r.id)) throw new Error('exists'); m.set(r.id, r) }, remove: (id: string) => { m.delete(id) },
    setPaused: () => {}, update: (id: string) => m.get(id) } as any
}

function makeScheduler() {
  let armed: (() => void) | null = null; let cancelled = false
  return { schedule: ((fn: () => void) => { armed = fn; return { cancel() { cancelled = true; armed = null } } }) as PairingDeps['schedule'],
    tick: () => armed && !cancelled && armed(), get cancelled() { return cancelled } }
}

describe('pairing integration (two engines, one in-process relay)', () => {
  it('start → accept → poll: both registries get a correct, url-less mailbox record; keys cross', async () => {
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW })
    const client = inProcessClient(srv)
    const regA = memRegistry(); const regB = memRegistry(); const sched = makeScheduler()
    const relays = ['https://brain.example/mailbox']

    const A = makePairing({
      client, registry: regA, self: { mailbox_addr: 'A_MB', mailbox_enc_pub: 'A_EP', relays },
      selfId: () => 'cc-aaaa1111', name: () => 'Alice', now: () => NOW,
      mintKey: () => 'A-inbound-key-0000000000', genCode: () => '246810', genNonce: () => 'nA',
      notify: () => {}, schedule: sched.schedule,
    })
    const B = makePairing({
      client, registry: regB, self: { mailbox_addr: 'B_MB', mailbox_enc_pub: 'B_EP', relays },
      selfId: () => 'cc-bbbb2222', name: () => 'Bob', now: () => NOW,
      mintKey: () => 'B-inbound-key-0000000000', genCode: () => 'unused', genNonce: () => 'nB',
      notify: () => {}, schedule: () => ({ cancel() {} }),
    })

    const { code } = A.start()
    const res = await B.accept(code)
    expect(res.ok).toBe(true)

    sched.tick()
    await new Promise(r => setTimeout(r, 0))

    const a = regA.m.get('cc-bbbb2222'); const b = regB.m.get('cc-aaaa1111')
    expect(a.transport).toBe('mailbox'); expect(a.url).toBeUndefined()
    expect(b.transport).toBe('mailbox'); expect(b.url).toBeUndefined()
    // self_id cross-reference
    expect(a.id).toBe('cc-bbbb2222'); expect(b.id).toBe('cc-aaaa1111')
    // bearer crossing
    expect(a.outbound_api_key).toBe(b.inbound_api_key) // B-inbound-key
    expect(b.outbound_api_key).toBe(a.inbound_api_key) // A-inbound-key
    // mailbox fields carried across
    expect(a.mailbox_addr).toBe('B_MB'); expect(b.mailbox_addr).toBe('A_MB')
    // records validate under the (url-optional) schema:
    const { A2AAgentRecord } = await import('../lib/agent-config')
    expect(A2AAgentRecord.safeParse(a).success).toBe(true)
    expect(A2AAgentRecord.safeParse(b).success).toBe(true)
  })

  // CRITICAL-1 regression: reproduce the exact clobber trace against a REAL
  // registry (writes agent-config.json) + the REAL resolver (persists
  // self_agent_id), memoizing selfId ONCE the way wire-pairing does. The peer
  // record registry.add wrote must SURVIVE on disk after accept() — and after a
  // second pairing (proving the resolver's merge-persist never wipes a2a_agents).
  it('the written peer record survives on disk after accept() and a second pairing', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const { createA2ARegistry } = await import('./a2a-registry')
    const { loadAgentConfig } = await import('../lib/agent-config')
    const { resolveSelfAgentId } = await import('./self-agent-id')

    const stateDir = mkdtempSync(join(tmpdir(), 'pair-disk-'))
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude', mailbox_relays: ['https://brain.example/mailbox'] }))
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW })
    const client = inProcessClient(srv)
    const relays = ['https://brain.example/mailbox']

    const registryB = createA2ARegistry({ stateDir })              // REAL — read-modify-writes agent-config.json
    const selfIdB = resolveSelfAgentId(loadAgentConfig(stateDir), stateDir) // resolved ONCE (persists self_agent_id via merge)
    const B = makePairing({
      client, registry: registryB, self: { mailbox_addr: 'B_MB', mailbox_enc_pub: 'B_EP', relays },
      selfId: () => selfIdB, name: () => 'Bob', now: () => NOW,
      mintKey: () => 'B-inbound-key-0000000000', genCode: () => 'x', genNonce: () => 'nB',
      notify: () => {}, schedule: () => ({ cancel() {} }),
    })
    const initiator = (id: string, code: string) => makePairing({
      client, registry: memRegistry(), self: { mailbox_addr: `${id}_MB`, mailbox_enc_pub: 'EP', relays },
      selfId: () => id, name: () => id, now: () => NOW,
      mintKey: () => `${id}-key-000000000000`, genCode: () => code, genNonce: () => `n-${id}`,
      notify: () => {}, schedule: () => ({ cancel() {} }),
    })

    const p1 = initiator('cc-aaaa1111', '135790'); { const { code } = p1.start(); expect((await B.accept(code)).ok).toBe(true) }
    const disk1 = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect(disk1.self_agent_id).toBe(selfIdB)
    expect(disk1.a2a_agents.map((a: any) => a.id)).toContain('cc-aaaa1111') // survived, not wiped

    const p2 = initiator('cc-cccc3333', '246802'); { const { code } = p2.start(); expect((await B.accept(code)).ok).toBe(true) }
    const disk2 = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect(disk2.a2a_agents.map((a: any) => a.id).sort()).toEqual(['cc-aaaa1111', 'cc-cccc3333']) // BOTH survive
  })
})
```

Run (expect fail first if any wiring is off, then pass):
```
bun run test src/core/pairing.integration.test.ts
```

### Step 5.2 — impl
No new production code — this test exercises T1+T3+T4 through the real relay. If it fails, fix the engine, not the test (systematic-debugging). Confirm `ack` is never hit (the fake throws).

### Step 5.3 — commit
```
git add src/core/pairing.integration.test.ts
git commit -m "test(pairing): two-engine round-trip against the in-process relay (crossed keys, url-less records)"
```

---

## Task 6 — Bootstrap wiring: `wire-pairing.ts` + `boot.pairing`

### Interfaces
- **Produces:** `src/daemon/bootstrap/wire-pairing.ts` exporting `wirePairing(deps): PairingEngine | undefined`; `BootstrapResult.pairing?: { start(): { code: string; expiresAt: number }; accept(code: string): Promise<PairResult> }` in `bootstrap/types.ts`; construction call in `bootstrap/index.ts`.
- **Consumes:** `makePairing` (T4), `loadMailboxIdentity` (own mailbox card fields), `resolveSelfAgentId` (T2), `a2aRegistry`, `resolveOperatorChatId` + `sendAssistantText` (notify), `randomInt`/`randomBytes` (`node:crypto`).
- **Gate:** built ONLY when `configuredAgent.mailbox_relays?.length` (rendezvous needs a relay). Undefined otherwise → the WeChat/CLI surfaces (T7/T8) stay inert (503 / no-op), same posture as `boot.social`/`boot.penpal`.
- **CRITICAL-1 fix (memoize `selfId`).** `resolveSelfAgentId` persists on its generate/grandfather branch. The engine calls `deps.selfId()` MULTIPLE times per pairing (self-pair check + `ownCard`, and per poll tick). If wired lazily (`selfId: () => resolveSelfAgentId(...)`), each call re-enters that persistence — and combined with a full-overwrite save would wipe the peer record `registry.add` just wrote. So resolve ONCE at wiring time and hand a constant closure: `const selfId = resolveSelfAgentId(...); selfId: () => selfId`. (The merge-persist fix in T2 is the second, independent half of the defense.)

### Step 6.1 — failing test

Add to `src/daemon/bootstrap.test.ts` a case mirroring the social one:

```ts
it('wires boot.pairing when mailbox_relays is configured', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-pairing-on-'))
  writeFileSync(join(stateDir, 'agent-config.json'),
    JSON.stringify({ provider: 'claude', mailbox_relays: ['https://brain.example/mailbox'] }))
  // ... construct bootstrap via the same harness the social test uses ...
  const boot = await buildBootstrap(/* harness deps, stateDir */)
  expect(boot.pairing).toBeDefined()
  expect(typeof boot.pairing!.start).toBe('function')
  expect(typeof boot.pairing!.accept).toBe('function')
})

it('leaves boot.pairing undefined with no mailbox_relays', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-pairing-off-'))
  writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
  const boot = await buildBootstrap(/* harness deps, stateDir */)
  expect(boot.pairing).toBeUndefined()
})
```
(Reuse the exact `buildBootstrap` harness/mocks the existing `bootstrap.social` test at `bootstrap.test.ts:1054` uses — same imports/fixtures.)

Run (expect fail): `bun run test src/daemon/bootstrap.test.ts`

### Step 6.2 — impl

Create `src/daemon/bootstrap/wire-pairing.ts`:

```ts
/**
 * wire-pairing.ts — construct the 配对码 engine from real daemon deps (spec §7:
 * "配对执行体在 daemon 内"). Built ONLY when mailbox_relays is configured — the
 * rendezvous uses the daemon's own mailbox_relays[0] as the meeting relay, so
 * with no relay the feature is inert (boot.pairing stays undefined, mirroring
 * boot.social/boot.penpal).
 */
import { randomBytes, randomInt } from 'node:crypto'
import { makePairing, type PairingEngine } from '../../core/pairing'
import { makeMailboxClient } from '../../core/mailbox-client'
import { loadMailboxIdentity } from '../../core/mailbox-crypto'
import { resolveSelfAgentId } from '../../core/self-agent-id'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { AgentConfig } from '../../lib/agent-config'

export interface PairingWireDeps {
  stateDir: string
  configuredAgent: AgentConfig
  a2aRegistry: A2ARegistry
  notify: (msg: string) => void
  log: (tag: string, msg: string) => void
}

export function wirePairing(deps: PairingWireDeps): PairingEngine | undefined {
  const relays = deps.configuredAgent.mailbox_relays
  if (!relays?.length) return undefined

  const mailbox = loadMailboxIdentity(deps.stateDir) // idempotent read; persists on first ever use
  // CRITICAL-1: resolve the slug ONCE. resolveSelfAgentId persists on its
  // generate/grandfather branch; calling it per-card (lazily) would re-enter that
  // save on every ownCard()/tick and race registry.add's disk writes. Memoize.
  const selfId = resolveSelfAgentId(deps.configuredAgent, deps.stateDir)
  const engine = makePairing({
    client: makeMailboxClient(),
    registry: deps.a2aRegistry,
    self: { mailbox_addr: mailbox.addr, mailbox_enc_pub: mailbox.enc_pub, relays },
    selfId: () => selfId,
    name: () => deps.configuredAgent.bot_name ?? 'wechat-cc',
    now: () => Date.now(),
    mintKey: () => randomBytes(24).toString('hex'), // 48 chars, >= 16
    genCode: () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
    genNonce: () => randomBytes(8).toString('hex'),
    notify: deps.notify,
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); if (typeof t.unref === 'function') t.unref(); return { cancel: () => clearTimeout(t) } },
    log: (m) => deps.log('PAIR', m),
  })
  deps.log('BOOT', `pairing: wired (rendezvous relay ${relays[0]})`)
  return engine
}
```

In `src/daemon/bootstrap/types.ts`, add to `BootstrapResult` (near `penpal?`):
```ts
  /**
   * 配对码 (spec §7) — the daemon-side pairing engine. Present only when
   * mailbox_relays is configured. The WeChat 「配对」 dispatch seam (pipeline-deps)
   * and internal-api /v1/pair/* routes read this; undefined ⇒ inert (no-op / 503).
   */
  pairing?: {
    start(): { code: string; expiresAt: number }
    accept(code: string): Promise<import('../../core/pairing').PairResult>
  }
```

In `src/daemon/bootstrap/index.ts`, after `socialWiring` is built and near where `sendAssistantText`/`resolveOperatorChatId` exist, construct the engine and add it to the returned object:
```ts
  const pairingEngine = wirePairing({
    stateDir,
    configuredAgent,
    a2aRegistry,
    notify: (msg) => { const op = resolveOperatorChatId(); if (op && sendAssistantText) void sendAssistantText(op, msg) },
    log,
  })
```
and in the return object (near the `...(socialWiring.social ? ...)` spreads):
```ts
    ...(pairingEngine ? { pairing: { start: () => pairingEngine.start(), accept: (c: string) => pairingEngine.accept(c) } } : {}),
```
Add the import at the top: `import { wirePairing } from './wire-pairing'`.
(Use the exact local names for `stateDir`, `configuredAgent`, `a2aRegistry`, `resolveOperatorChatId`, `sendAssistantText`, `log` already in scope in `buildBootstrap`.)

Run (expect pass): `bun run test src/daemon/bootstrap.test.ts`

### Step 6.3 — commit
```
git add src/daemon/bootstrap/wire-pairing.ts src/daemon/bootstrap/types.ts src/daemon/bootstrap/index.ts src/daemon/bootstrap.test.ts
git commit -m "feat(pairing): wire boot.pairing from real daemon deps (gated on mailbox_relays)"
```

---

## Task 7 — WeChat 「配对」/「配对 <code>」 command (parse + pipeline dispatch)

### Interfaces
- **Produces:** `src/core/pair-command.ts` exporting `parsePairCommand(text): { kind: 'start' } | { kind: 'accept'; code: string } | null`; a dispatch block in `src/daemon/wiring/pipeline-deps.ts` mirroring the 揭晓/回信 seams (admin-gated, reads `boot.pairing`).
- **Consumes:** `boot.pairing` (T6), `isAdmin`, `boot.sendAssistantText`.

### Step 7.1 — parser (failing test)

Create `src/core/pair-command.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parsePairCommand } from './pair-command'

describe('parsePairCommand', () => {
  it('bare 配对 → start', () => { expect(parsePairCommand('配对')).toEqual({ kind: 'start' }) })
  it('配对 with trailing space → start', () => { expect(parsePairCommand('配对  ')).toEqual({ kind: 'start' }) })
  it('配对 <6 digits> → accept', () => { expect(parsePairCommand('配对 483921')).toEqual({ kind: 'accept', code: '483921' }) })
  it('trims + tolerates inner spacing', () => { expect(parsePairCommand('  配对   483921 ')).toEqual({ kind: 'accept', code: '483921' }) })
  it('non-command → null', () => {
    expect(parsePairCommand('配对一下吧')).toBeNull()
    expect(parsePairCommand('配对 12345')).toBeNull()   // 5 digits
    expect(parsePairCommand('配对 4839210')).toBeNull() // 7 digits
    expect(parsePairCommand('揭晓 x')).toBeNull()
    expect(parsePairCommand('')).toBeNull()
  })
})
```

Run (expect fail): `bun run test src/core/pair-command.test.ts`

### Step 7.2 — parser impl

Create `src/core/pair-command.ts`:

```ts
/**
 * pair-command.ts — the WeChat 配对 trigger (spec §7). Deterministic pipeline-layer
 * parse, mirroring reveal-command.ts / penpal-letter-command.ts (never relies on
 * the model noticing). Bare "配对" → start; "配对 <6 digits>" → accept.
 */
export function parsePairCommand(text: string): { kind: 'start' } | { kind: 'accept'; code: string } | null {
  const t = text.trim()
  if (/^配对$/.test(t)) return { kind: 'start' }
  const m = t.match(/^配对\s+(\d{6})$/)
  if (m) return { kind: 'accept', code: m[1]! }
  return null
}
```

Run (expect pass): `bun run test src/core/pair-command.test.ts`

### Step 7.3 — pipeline dispatch (failing test)

Add a case to the existing pipeline-deps dispatch test suite (mirror its 揭晓/回信 coverage): with `boot.pairing` stubbed and an admin chat, a 「配对」 message calls `boot.pairing.start()` and sends the code via `sendAssistantText` (NOT a normal turn); 「配对 483921」 calls `accept('483921')`; a non-admin chat falls through to `coordinator.dispatch`.

```ts
it('admin 配对 → start(), replies with the code, no normal turn', async () => {
  const start = vi.fn(() => ({ code: '483921', expiresAt: 0 }))
  const sendAssistantText = vi.fn()
  const coordDispatch = vi.fn()
  const deps = buildPipelineDeps({ boot: { pairing: { start, accept: vi.fn() }, sendAssistantText, coordinator: { dispatch: coordDispatch, /*…*/ } }, isAdmin: () => true })
  await deps.dispatch.coordinator.dispatch({ chatId: 'admin', text: '配对' } as any)
  expect(start).toHaveBeenCalled()
  expect(sendAssistantText).toHaveBeenCalledWith('admin', expect.stringContaining('483921'))
  expect(coordDispatch).not.toHaveBeenCalled()
})

it('admin 配对 <code> → accept()', async () => {
  const accept = vi.fn(async () => ({ ok: true, peer: { self_id: 'cc-x', name: 'Bob' } }))
  const deps = buildPipelineDeps({ boot: { pairing: { start: vi.fn(), accept }, sendAssistantText: vi.fn(), coordinator: { dispatch: vi.fn() } }, isAdmin: () => true })
  await deps.dispatch.coordinator.dispatch({ chatId: 'admin', text: '配对 483921' } as any)
  expect(accept).toHaveBeenCalledWith('483921')
})
```
(Match the actual pipeline-deps test harness shape; the point is: parse + admin gate + boot.pairing dispatch + reply, mirroring the 揭晓 test.)

Run (expect fail): `bun run test src/daemon/wiring/pipeline-deps.test.ts`

### Step 7.4 — pipeline dispatch impl

In `src/daemon/wiring/pipeline-deps.ts`:
- Add import: `import { parsePairCommand } from '../../core/pair-command'`
- In the `dispatch.coordinator.dispatch` closure, insert a block AFTER the `boot.penpal` block and BEFORE `return boot.coordinator.dispatch(msg)`:

```ts
          // 配对 (spec §7) — admin-gated, deterministic parse, mirrors 揭晓/回信.
          // Inert (falls through to a normal turn) until boot.pairing is wired
          // (Task 6, i.e. mailbox_relays configured).
          if (boot.pairing && isAdmin(msg.chatId)) {
            const pair = parsePairCommand(msg.text)
            if (pair) {
              if (pair.kind === 'start') {
                const { code } = boot.pairing.start()
                if (boot.sendAssistantText) void boot.sendAssistantText(msg.chatId, `配对码 ${code},发给朋友,10 分钟内有效`)
              } else {
                const r = await boot.pairing.accept(pair.code)
                if (boot.sendAssistantText) {
                  const text = r.ok
                    ? `和 ${r.peer.name} 的 bot 连上了 ✓ 现在可以互相觅食/写信了`
                    : r.reason === 'self_pair'
                      ? '这是你自己的码,换个朋友的码试试'
                      : r.reason === 'id_conflict'
                        ? '对方 bot 使用旧版共享身份且与你已有的朋友撞名——请让对方升级出唯一身份后重试'
                        : '码不对或已过期,让朋友重新生成一个'
                  void boot.sendAssistantText(msg.chatId, text)
                }
              }
              return
            }
          }
```

Run (expect pass): `bun run test src/daemon/wiring/pipeline-deps.test.ts`

### Step 7.5 — commit
```
git add src/core/pair-command.ts src/core/pair-command.test.ts src/daemon/wiring/pipeline-deps.ts src/daemon/wiring/pipeline-deps.test.ts
git commit -m "feat(pairing): WeChat 配对/配对<code> command (deterministic parse + admin-gated dispatch)"
```

---

## Task 8 — internal-api routes `/v1/pair/start` + `/v1/pair/accept` (tier trusted)

### Interfaces
- **Produces:** `src/daemon/internal-api/routes-pair.ts` (`pairRoutes(deps)`); `InternalApiDeps.pairing?` + `setPairing` (types.ts, lifecycle.ts, index.ts); `ROUTE_MIN_TIER` entries; `routes.ts` spread; `main.ts` late-bind.
- **Consumes:** `boot.pairing` (T6), the `deps.pairing` gate pattern from `routes-social.ts`, the `setSocial` late-bind pattern.
- **Tier (spec §7, surfaced for review):** both routes `trusted` — internal-api is 127.0.0.1-only with a 0600 file token owned by the operator; the CLI holds only the daemon-wide FILE token (`registerFileToken → trusted`), same class as `POST /v1/a2a/send` / `POST /v1/social/echoes/reveal`.

### Step 8.1 — tier test (failing)

Add to `src/daemon/internal-api/route-tiers.test.ts`:
```ts
it('pair routes require trusted', () => {
  expect(minTierFor('POST /v1/pair/start')).toBe('trusted')
  expect(minTierFor('POST /v1/pair/accept')).toBe('trusted')
})
```
Run (expect fail): `bun run test src/daemon/internal-api/route-tiers.test.ts`

### Step 8.2 — tier impl

In `src/daemon/internal-api/route-tiers.ts`, add to the `trusted` block of `ROUTE_MIN_TIER`:
```ts
  // trusted — 配对码 (spec §7). Same trust class as a2a/send + social reveal:
  // internal-api is 127.0.0.1 + 0600 file token; the CLI holds the FILE token
  // (trusted). Acts on an operator-driven pairing, not a world-open broadcast.
  'POST /v1/pair/start': 'trusted',
  'POST /v1/pair/accept': 'trusted',
```
Run (expect pass): `bun run test src/daemon/internal-api/route-tiers.test.ts`

### Step 8.3 — routes (failing test)

Create `src/daemon/internal-api/routes-pair.test.ts` (mirror `routes-social` idioms):
```ts
import { describe, it, expect, vi } from 'vitest'
import { pairRoutes } from './routes-pair'

const deps = (pairing?: any) => ({ pairing } as any)

describe('pairRoutes', () => {
  it('503 when pairing not wired', async () => {
    const r = await pairRoutes(deps()).['POST /v1/pair/start']({} as any, null)
    expect(r.status).toBe(503)
  })
  it('start returns the code', async () => {
    const start = vi.fn(() => ({ code: '483921', expiresAt: 123 }))
    const r = await pairRoutes(deps({ start, accept: vi.fn() }))['POST /v1/pair/start']({} as any, null)
    expect(r.status).toBe(200); expect((r.body as any).code).toBe('483921')
  })
  it('accept validates the code and returns the result', async () => {
    const accept = vi.fn(async () => ({ ok: true, peer: { self_id: 'cc-x', name: 'Bob' } }))
    const r = await pairRoutes(deps({ start: vi.fn(), accept }))['POST /v1/pair/accept']({} as any, { code: '483921' })
    expect(accept).toHaveBeenCalledWith('483921'); expect(r.status).toBe(200)
  })
  it('accept 400 on a missing/invalid code', async () => {
    const r = await pairRoutes(deps({ start: vi.fn(), accept: vi.fn() }))['POST /v1/pair/accept']({} as any, { code: 'nope' })
    expect(r.status).toBe(400)
  })
})
```
Run (expect fail): `bun run test src/daemon/internal-api/routes-pair.test.ts`

### Step 8.4 — routes impl

Create `src/daemon/internal-api/routes-pair.ts`:
```ts
/**
 * internal-api 配对码 routes (spec §7). Mirrors routes-social.ts: 503 when the
 * engine isn't wired (no mailbox_relays), else delegate to boot.pairing. Both
 * tier=trusted (see route-tiers.ts). start() mints+returns a code; accept()
 * takes a 6-digit code.
 */
import type { InternalApiDeps, RouteTable } from './types'

export function pairRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/pair/start': async () => {
      if (!deps.pairing) return { status: 503, body: { error: 'pairing_not_wired' } }
      return { status: 200, body: deps.pairing.start() }
    },
    'POST /v1/pair/accept': async (_q, body) => {
      if (!deps.pairing) return { status: 503, body: { error: 'pairing_not_wired' } }
      const code = ((body ?? {}) as { code?: unknown }).code
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { status: 400, body: { error: 'invalid_code' } }
      const result = await deps.pairing.accept(code)
      return { status: 200, body: result }
    },
  }
}
```

Add the dep + setter:
- `src/daemon/internal-api/types.ts` — add to `InternalApiDeps` (near `social?`):
  ```ts
  /** 配对码 (spec §7) — late-bound by main.ts from bootstrap.pairing. Undefined
   *  (⇒ /v1/pair/* 503) until mailbox_relays is configured AND late-bind runs. */
  pairing?: {
    start(): { code: string; expiresAt: number }
    accept(code: string): Promise<import('../../core/pairing').PairResult>
  }
  ```
  and to the lifecycle interface (near `setSocial`):
  ```ts
  setPairing(pairing: NonNullable<InternalApiDeps['pairing']>): void
  ```
- `src/daemon/internal-api/index.ts` — add near `setSocial(social) {...}`:
  ```ts
    setPairing(pairing) { deps.pairing = pairing },
  ```
  (match the exact mutation style `setSocial` uses).
- `src/daemon/internal-api/lifecycle.ts` — add near `setSocial`:
  ```ts
    setPairing: (pairing) => api.setPairing(pairing),
  ```
- `src/daemon/internal-api/routes.ts` — add import `import { pairRoutes } from './routes-pair'` and spread near `...socialRoutes(deps),`:
  ```ts
    ...pairRoutes(deps),
  ```
- `src/daemon/main.ts` — near `if (boot.social) internalApi.setSocial(boot.social)` (line ~289):
  ```ts
    if (boot.pairing) internalApi.setPairing(boot.pairing)
  ```

Run (expect pass): `bun run test src/daemon/internal-api/routes-pair.test.ts`

### Step 8.5 — commit
```
git add src/daemon/internal-api/routes-pair.ts src/daemon/internal-api/routes-pair.test.ts \
        src/daemon/internal-api/route-tiers.ts src/daemon/internal-api/route-tiers.test.ts \
        src/daemon/internal-api/types.ts src/daemon/internal-api/index.ts \
        src/daemon/internal-api/lifecycle.ts src/daemon/internal-api/routes.ts src/daemon/main.ts
git commit -m "feat(pairing): internal-api /v1/pair/start + /v1/pair/accept (tier trusted, late-bound)"
```

---

## Task 9 — CLI `wechat-cc pair [code]` (+ cli.test surface) + final gates

### Interfaces
- **Produces:** `src/cli/pair.ts` (`cmdPairStart`/`cmdPairAccept`, daemon-call idiom copied from `cmdSocialReveal`); `pairCmd` in `cli.ts`; `pair` entry in `SUBCOMMANDS`; **`pair` added to the `cli.test.ts` sorted subcommand list**.
- **Consumes:** `/v1/pair/start` + `/v1/pair/accept` (T8), `internal-api-info.json` + token-file idiom.

### Step 9.1 — cli.test surface (failing test FIRST — the v1.3.3 lesson)

In `cli.test.ts`, add `'pair'` to the sorted array in the `exposes the full migrated subcommand surface` test (alphabetical position between `observations` and `plugin`):
```ts
      'observations',
      'pair',
      'plugin',
```
Run (expect fail — `pair` isn't in `SUBCOMMANDS` yet):
```
bun run test cli.test.ts
# Expected: FAIL — arrays differ (expected 'pair', missing from cittyRoot.subCommands)
```

### Step 9.2 — CLI command impl

Create `src/cli/pair.ts` (copy the `readInfo`/`readToken`/`post` idiom verbatim from `src/cli/social.ts:cmdSocialReveal`):
```ts
/**
 * pair.ts — `wechat-cc pair [code]` (spec §7). Both forms call the RUNNING
 * daemon over internal-api (127.0.0.1 + file token, tier trusted): no args →
 * POST /v1/pair/start (prints the code); <code> → POST /v1/pair/accept.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

interface PairDeps {
  fetch?: typeof fetch
  readInfo?: () => { baseUrl: string; tokenFilePath: string } | null
  readToken?: (p: string) => string
  fail?: (msg: string) => never
}

function resolve(stateDir: string, deps: PairDeps) {
  const fail = deps.fail ?? ((msg: string): never => { console.error(`pair: ${msg}`); throw new Error(msg) })
  const readInfo = deps.readInfo ?? (() => {
    const p = join(stateDir, 'internal-api-info.json')
    if (!existsSync(p)) return null
    try {
      const j = JSON.parse(readFileSync(p, 'utf8')) as { baseUrl?: string; tokenFilePath?: string }
      return j.baseUrl && j.tokenFilePath ? { baseUrl: j.baseUrl, tokenFilePath: j.tokenFilePath } : null
    } catch { return null }
  })
  const readToken = deps.readToken ?? ((p: string) => readFileSync(p, 'utf8').trim())
  const info = readInfo()
  if (!info) fail('daemon not running (internal-api-info.json missing — start the daemon first)')
  const token = readToken(info!.tokenFilePath)
  const doFetch = deps.fetch ?? fetch
  const post = (path: string, body: unknown) => doFetch(`${info!.baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  })
  return { post, fail }
}

export async function cmdPairStart(stateDir: string, opts: { json: boolean }, deps: PairDeps = {}): Promise<void> {
  const { post, fail } = resolve(stateDir, deps)
  let resp: Response
  try { resp = await post('/v1/pair/start', {}) } catch (e) { return void fail(`could not reach the daemon: ${e instanceof Error ? e.message : String(e)}`) }
  if (resp.status === 503) fail('pairing not available — configure mailbox_relays first')
  if (!resp.ok) fail(`daemon returned ${resp.status}`)
  const body = await resp.json() as { code: string; expiresAt: number }
  if (opts.json) { console.log(JSON.stringify(body)); return }
  console.log(`配对码 ${body.code} — 发给朋友,10 分钟内有效`)
}

export async function cmdPairAccept(stateDir: string, code: string, opts: { json: boolean }, deps: PairDeps = {}): Promise<void> {
  const { post, fail } = resolve(stateDir, deps)
  if (!/^\d{6}$/.test(code)) fail('code must be 6 digits')
  let resp: Response
  try { resp = await post('/v1/pair/accept', { code }) } catch (e) { return void fail(`could not reach the daemon: ${e instanceof Error ? e.message : String(e)}`) }
  if (resp.status === 503) fail('pairing not available — configure mailbox_relays first')
  if (!resp.ok) fail(`daemon returned ${resp.status}`)
  const body = await resp.json() as { ok: boolean; peer?: { name: string }; reason?: string }
  if (opts.json) { console.log(JSON.stringify(body)); return }
  console.log(body.ok ? `和 ${body.peer!.name} 的 bot 连上了 ✓`
    : body.reason === 'self_pair' ? '这是你自己的码,换个朋友的码'
    : body.reason === 'id_conflict' ? '对方 bot 使用旧版共享身份且与你已有的朋友撞名——请让对方升级出唯一身份后重试'
    : '码不对或已过期,让朋友重新生成一个')
}
```

In `cli.ts`, define the command (mirror `socialRevealCmd`; optional positional `code`) and register it. Place the definition near the social command block:
```ts
const pairCmd = defineCommand({
  // Disambiguated from `hand invite`/`hand join` (worker-hand pairing) — this is
  // FRIEND pairing (edge-building between two people's bots).
  meta: { name: 'pair', description: '配对码 — 和朋友的 bot 建边:无参生成码,带 6 位码接受(≠ hand invite/join 的干活手配对;需运行中的 daemon)' },
  args: {
    code: { type: 'positional', required: false, description: '朋友的 6 位配对码', valueHint: 'code' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    try {
      if (args.code) {
        const { cmdPairAccept } = await import('./src/cli/pair.ts')
        await cmdPairAccept(STATE_DIR, String(args.code), { json: Boolean(args.json) })
      } else {
        const { cmdPairStart } = await import('./src/cli/pair.ts')
        await cmdPairStart(STATE_DIR, { json: Boolean(args.json) })
      }
    } catch { process.exit(1) }
  },
})
```
Add to the `SUBCOMMANDS` object (alphabetical placement is irrelevant to citty but keep it tidy):
```ts
  // 配对码 — automatic edge-building (spec §7).
  pair: pairCmd,
```

Run (expect pass now): `bun run test cli.test.ts`

### Step 9.3 — CLI unit test (optional but recommended)

Create `src/cli/pair.test.ts` driving `cmdPairStart`/`cmdPairAccept` with injected `fetch`/`readInfo`/`readToken`/`fail` (mirror any existing `src/cli/*.test.ts`): assert the correct path/body, 503 handling, and the 6-digit guard. Run: `bun run test src/cli/pair.test.ts`.

### Step 9.4 — commit
```
git add src/cli/pair.ts src/cli/pair.test.ts cli.ts cli.test.ts
git commit -m "feat(pairing): wechat-cc pair [code] CLI subcommand (+cli.test surface list)"
```

### Step 9.5 — FINAL GATES (run all, must be green)
```
bun run typecheck            # clean — no red window (all-additive)
bun run depcheck             # green — node:crypto + existing modules only, no new dep
bun run test src/core/pairing-crypto.test.ts src/core/self-agent-id.test.ts \
  src/lib/agent-config.test.ts src/core/pairing.test.ts src/core/pairing.integration.test.ts \
  src/core/pair-command.test.ts src/daemon/bootstrap.test.ts src/daemon/bootstrap/wire-social.test.ts \
  src/daemon/wiring/pipeline-deps.test.ts src/daemon/internal-api/routes-pair.test.ts \
  src/daemon/internal-api/route-tiers.test.ts cli.test.ts
# Regression sweep — must NOT go red (esp. the .url-consumer guards + self-id/merge-persist):
bun run test src/core/a2a-registry.test.ts relay/server.test.ts
```
Manual e2e acceptance (spec §9, out-of-CI): against the live brain relay + the ws test bench, run one real 配对 between two daemons and confirm both `agent-config.json` files gained a correct `a2a_agents` mailbox record with crossed keys.

---

## Task dependency graph

```
T1 pairing-crypto ─────────┐
T2 self-agent-id (merge-   ─┼─> T4 engine (id_conflict guard) ─> T5 integration (+survives-on-disk)
   persist + grandfather)   │
T3 url-optional + guard 3  ─┘                                        │
   .url consumers                                                    │
T6 wire-pairing (memoized selfId; needs T4) ────────────────────────┤
T7 WeChat command (needs T6) ───────────────────────────────────────┤
T8 internal-api routes (needs T6) ──────────────────────────────────┤
T9 CLI + cli.test + final gates (needs T8)
```

T1/T2/T3 are independent and can be parallelized. T3 now touches `wire-social.ts` (the 3 `.url` guards) in addition to the schema — still additive (guards + an optional field), no typecheck-red window; the T2 `wire-social.ts` `SOCIAL_SELF_ID` swap and the T3 guards are disjoint lines committed separately. T6/T7/T8 all consume `boot.pairing` (T6) but T7 and T8 are independent of each other. T9 closes with the full-suite + typecheck + depcheck gates.

**Task count: 9 (unchanged).** The three blocker fixes landed as additional steps/guards inside existing tasks — merge-persist + grandfather + survives-on-disk test in T2/T5, the id_conflict guard + minor-a/b/c/d in T4, the 3 `.url` guards + regression test in T3 — not new tasks.
