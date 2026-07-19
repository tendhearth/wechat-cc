# 匿名笔友通道 (sub-project A) — E2E Pen-Pal Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is a TDD unit: failing test → run-fail → minimal impl → run-pass → commit.

**Goal:** Turn the shipped `揭晓/reveal` machinery from **"cross real identity"** into **"open an anonymous end-to-end pen-pal channel"**. At the ①→② opt-in (owner chooses to start writing to a postcard), each side mints a **fresh per-connection X25519 keypair + opaque channel id**. The mutual dual-confirm reveal crosses a `PenpalHandle { pubkey, channel_id }` **instead of** `PeerIdentity { name, url }` — real identity NEVER enters the system. Once a channel is open, the two bots exchange **AES-256-GCM–sealed letters** over the existing a2a send/client path (direct 1-hop) or the relay path (2-hop; the intermediary routes ciphertext only, content-blind). The owner sees incoming letters in WeChat ("第 2 度的某人给你写信了:…") and replies with `回信 <channel> <text>`. This is sub-project A only (§4.4 + §5 + §4.2 of the design spec, on the EXISTING transport). See `docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md`.

**Architecture:** Row-driven, no long-lived in-memory state — the `penpal_channel` / `penpal_letter` rows **are** the channel state machine, exactly as `social_echo` / `social_pledge` / `social_relay` are the reveal state machine. A single focused crypto core `src/core/penpal-crypto.ts` (Node built-in `crypto` only: X25519 keypair → `diffieHellman` shared secret → HKDF-SHA256 → AES-256-GCM) holds all cryptography behind a four-function surface. The repoint is a **type swap** along the existing reveal seam: `PeerIdentity` → `PenpalHandle`, the "swap the real name into `peer_masked`" step becomes "finalize a `penpal_channel` row with the peer's pubkey (label stays masked forever)", and the intermediary crosses the two endpoints' **pubkeys** (which each endpoint generated and presented) instead of identities resolved from its registry. Letters ride a new `/a2a/letter` inbound route (tiered like `/a2a/reveal`) + the generic `a2a-client.send`; a `makeCorrespondent` core seals outbound / opens+persists inbound. The WeChat surface is a thin `回信` command parsed in the pipeline-deps dispatch seam next to `揭晓`.

**Tech Stack:** TypeScript, Bun runtime, Vitest (`bun run test <path>` — NOT `bun test`). SQLite via `bun:sqlite` (`src/lib/db.ts`, append-only migrations). Stores follow the `makeXStore(db: Db)` idiom. Crypto is Node built-in `node:crypto` (X25519 / `diffieHellman` / `hkdfSync` / `createCipheriv('aes-256-gcm')`). A2A HTTP server/client (`src/core/a2a-server.ts` / `a2a-client.ts`); social wiring in `src/daemon/bootstrap/wire-social.ts`.

## Global Constraints

**LOCKED design decisions (copied verbatim from the brief — do NOT re-litigate):**

1. **Crypto = Node built-in `crypto` ONLY. NO new dependency** (depcheck must stay green). Per-connection **X25519** keypair (`crypto.generateKeyPairSync('x25519')`); shared secret via `crypto.diffieHellman`; derive an AES key via **HKDF-SHA256** (`crypto.hkdfSync`); encrypt each letter with **AES-256-GCM** (`crypto.createCipheriv('aes-256-gcm', …)`) with a fresh 12-byte random nonce; authenticate. Store pubkeys as base64url. All crypto in ONE focused module `src/core/penpal-crypto.ts` with a tiny, well-tested surface (`generateKeypair()`, `deriveSharedKey(myPriv, peerPub)`, `sealLetter(key, plaintext)→{nonce,ct,tag}`, `openLetter(key, sealed)→plaintext`). Unit-test round-trip + tamper-detection.
2. **Per-connection pseudonym = a FRESH X25519 keypair per pen-pal relationship**, generated at the ①→② opt-in (owner chooses to start writing to a postcard). Private key stays LOCAL; the pubkey is the handle crossed at reveal. Unlinkable across connections (no stable identity, no global reputation — later sub-projects).
3. **REPOINT reveal**: the mutual-reveal crosses a `PenpalHandle { pubkey, channel_id }` (base64url pubkey + an opaque channel id) INSTEAD of the real `PeerIdentity { name/agent_id }`. **Real identity must NEVER cross.** PRESERVE: mutual dual-confirm, relay-proxied 2-hop, and the 3-way warmth ping ("我俩朋友接上头了~") — warmth fires at channel-open, content-free. Existing tests that assert real-identity crossing MUST be UPDATED to assert pubkey/handle crossing (expected, not a regression). The `揭晓/reveal` behavior CHANGES semantics — update those tests, and do NOT leave a second identity-crossing path alive.
4. **Data model (migration v22):** new tables — `penpal_channel` (id, seek_id/echo_id link, my_privkey, my_pubkey, peer_pubkey nullable-until-reveal, degree, relay_via nullable, created_at, status) and `penpal_letter` (id, channel_id, direction in/out, sealed_ciphertext, nonce, created_at, read_at). Mirror the existing social store/migration style + the full-schema smoke-test bump.
5. **Letters:** a letter = E2E ciphertext + nonce, routed to the peer over the EXISTING a2a send/client path (direct 1-hop peer) or the relay path (2-hop; intermediary routes CIPHERTEXT, content-blind). Inbound intake is the A2A-server route `POST /a2a/letter`, tiered like `/a2a/reveal` (see §Resolved ambiguities #5) + an outbound send in the client. Ongoing = repeated letters. Persist a correspondence thread locally (decrypt on receipt, store plaintext locally for the owner; store only ciphertext on the wire).
6. **Content-blindness:** intermediary/relay sees only ciphertext + routing metadata; never plaintext. Warmth at channel-open only.
7. **Surface (v0, THIN — WeChat only):** incoming letter → bot notifies owner ("第 2 度的某人给你写信了:<decrypted preview>"); owner replies `回信 <channel> <text>` (mirror `reveal-command.ts` parse+wire) → E2E letter out. CLI/desktop surfaces DEFERRED. Keep it minimal.

**Scope guard (v0 sub-project A ONLY — explicitly OUT):** NO mailbox transport / relay server / poll (sub-project B). NO per-intermediary forward budget / anti-abuse (sub-project C) — leave a clean seam + one-line note where it'd hook. NO real-identity reveal anywhere. NO CLI/desktop letter UI. NO 3+ hops (cap stays 2). NO new npm dependency. Do NOT touch `apps/desktop/**` or `main.js`.

**Known deferred limitation (record in spec §11):** 2-hop confidentiality against a *malicious* introducer is NOT cryptographically guaranteed in v0 — W crosses the two endpoints' pubkeys, so a hostile W could key-substitute and MITM the channel. v0 leans on the real-friend gate (§4.5): W is a mutual real friend of both endpoints = trusted-but-honest. Transcript / pubkey-binding hardening (e.g. each endpoint echoing the pubkey it received so a substitution is detectable, or an out-of-band fingerprint) is v1+. **Direct 1-hop is fine** — pubkeys cross over Bearer-authenticated A2A with no relay in the middle.

**Gates — no silent red. Every task states which gate is expected to pass or fail and why:**
- `bun run test <path>` (vitest) for every touched suite — must be **green** at task end (a task's OWN suites always end green).
- `bun run depcheck` (= `depcruise`, rules in `.dependency-cruiser.cjs`: `no-orphans`, `core-must-not-depend-on-runtime`, `no-circular`) — must stay **green** on every task EXCEPT where a brand-new `src/core/` file has no importer yet (`no-orphans` fires until its first consumer lands one task later — each such task calls this out). `penpal-crypto.ts`, the stores, and `makeCorrespondent` live in `src/core/` and import ONLY `src/lib/**` + `node:crypto` — never `src/daemon/**`. No new npm dependency (Node built-in only), so the package-json check stays green.
- `bun run typecheck` — **RED is intrinsic only for Tasks 3–5** (the type-removal window: `selfIdentity`/`PeerIdentity`/`identityOf` are removed from `src/core/**` while `wire-social.ts` still references them). **Task 6 is the A3-closing wiring task that makes the whole tree GREEN again** ("reveal now crosses pubkeys, all social e2e green, letters not built yet") — an independently reviewable checkpoint. Tasks 7 onward (new letter files + additive a2a-server opts) keep typecheck **green**. Run `bun run typecheck` after Tasks 1, 2, **6**, 7, 11, 12.

**Store idiom (mirror `social-echo-store.ts` / `social-pledge-store.ts`):** `makeXStore(db: Db)` returns an object literal of methods; prepared statements via `db.query<Row, Params>(sql)`; tables `STRICT`; list order `ORDER BY created_at DESC, rowid DESC`. `Db` is `import type { Db } from '../lib/db'`.

**Migrations** live in `src/lib/db.ts` `const migrations: Migration[]` — append a new `(db) => { db.exec(...) }` at the END (after the v21 entry that closes `~:531`), never edit a shipped one. Nullable-TEXT `ADD COLUMN` is safe on STRICT tables.

**Resolved ambiguities (design decisions this plan commits to — full detail in §Resolved ambiguities at the bottom):**
- **`channel_id` is minted per side.** `PenpalHandle.channel_id` = MY inbound address (peer addresses letters TO me by it). On crossing, each side learns the peer's handle = `{ peer_pubkey, peer_channel_id }` and stores both. Outbound letters are addressed by `peer_channel_id`; inbound letters are looked up by `my_channel_id`.
- **`PenpalHandle` (not `PeerIdentity`) is the crossed type.** `selfIdentity()`/`identity?` become a per-connection `ChannelPort` + `handle?`; `RevealEvent.peer_name` → `RevealEvent.peer_handle`. `peer_masked` NEVER receives a real name — it stays `第 N 度的某人` forever; the connected beat is content-free.
- **The intermediary crosses pubkeys the ENDPOINTS presented, not registry identities.** `social_relay` gains two nullable columns (`upstream_handle`, `downstream_handle`) in the v22 migration so W can persist the first leg's presented handle to hand to the second. `identityOf(agentId)` is REMOVED from the reconciler deps.
- **Consistency of names across tasks (must match exactly):**
  - `PenpalHandle = { pubkey: string; channel_id: string }` (Task 1, exported from `penpal-crypto.ts`).
  - crypto surface: `generateKeypair(): { publicKey: string; privateKey: string }`, `deriveSharedKey(myPriv: string, peerPub: string): Buffer`, `sealLetter(key: Buffer, plaintext: string): SealedLetter`, `openLetter(key: Buffer, sealed: SealedLetter): string`, `SealedLetter = { nonce: string; ct: string; tag: string }` (all base64url) (Task 1).
  - `ChannelStore` = `create` / `get` / `getByMyChannelId` / `setPeerHandle` / `setStatus` / `list` (Task 2); `LetterStore` = `create` / `listForChannel` / `get` / `markRead` (Task 2).
  - `ChannelPort = { openLocal(rowId, ctx): PenpalHandle; finalize(rowId, peerHandle): void }` (Task 3, exported from `social-reveal.ts`).
  - `postPeerReveal(agentId, intentId, relayToken?) → { mutual, handle? } | null`; `onInboundReveal({ agentId, intentId, relayToken?, peerHandle? }) → { mutual, handle? }` (Task 3).
  - `RevealEvent` gains `peer_handle?: PenpalHandle` (replacing `peer_name`) (Task 4).
  - `makeRelayReconciler(deps)` deps lose `identityOf`; `onRelayReveal` event gains `peerHandle?`; `completeUpstream(up, intent, tok, downstreamHandle)` / `completeDownstream(down, intent, upstreamHandle)` / `notify3way(intent, upstreamHandle, downstreamHandle)` carry `PenpalHandle` (Task 5). `RelayStore` gains `setUpstreamHandle`/`setDownstreamHandle` (Task 5) + `getByEndpointChannelId` (Task 9).
  - `LetterEvent = { agent_id, channel_id, nonce, ct, tag }`; `onLetter?: (LetterEvent) => Promise<{ ok, error? }>`; `letterUrl()` (Task 7).
  - `makeCorrespondent(deps) → { sendLetter, receiveLetter }` (Task 8).
  - `makeLetterRelay(deps) → { routeLetter }` (Task 9).
  - `parseLetterCommand(text) → { channel: string; text: string } | null` (Task 10); `boot.penpal = { sendLetter }` (Task 10 seam / Task 11 construction).

**Forward-budget seam (sub-project C, OUT of scope):** the relay letter path (Task 9) routes through the intermediary (W). The one-line hook for a future per-intermediary forward budget is: **in `routeLetter`, before re-sending downstream, consult a `budget.consume(relay_token)` gate.** Leave a `// TODO(sub-project C): forward-budget gate here` comment; do NOT implement it.

---

## File Structure

- **Create** `src/core/penpal-crypto.ts` + `src/core/penpal-crypto.test.ts` (Task 1).
- **Modify** `src/lib/db.ts` — append migration v22 (Task 2).
- **Modify** `src/lib/state-migration.test.ts` — v21→v22, 20→22 tables (Task 2).
- **Create** `src/core/penpal-channel-store.ts` + `src/core/penpal-channel-store.test.ts` (Task 2).
- **Create** `src/core/penpal-letter-store.ts` + `src/core/penpal-letter-store.test.ts` (Task 2).
- **Modify** `src/core/social-reveal.ts` + `src/core/social-reveal.test.ts` — `PenpalHandle` repoint, `ChannelPort`, channel open on mutual (Task 3).
- **Modify** `src/core/a2a-server.ts` + `src/core/a2a-server.test.ts` — `RevealEvent.peer_handle`; the `/a2a/reveal` route reads/forwards it (Task 4).
- **Modify** `src/core/social-relay-reveal.ts` + `src/core/social-relay-reveal.test.ts` — cross pubkeys, drop `identityOf`, persist leg handles (Task 5).
- **Modify** `src/core/social-relay-store.ts` + `src/core/social-relay-store.test.ts` — `upstream_handle` / `downstream_handle` columns + setters (Task 5).
- **Modify** `src/daemon/bootstrap/wire-social.ts` — reveal-repoint ONLY: `ChannelPort`, drop `identityOf`/`selfIdentity`, delete name-swap, content-free warmth, `peer_handle` in `postPeerReveal`/`postReveal` (Task 6 — **GREEN checkpoint**).
- **Modify** `src/daemon/bootstrap.test.ts` (`:1224` I1 test) + `src/core/social-m1.e2e.test.ts` + (verify) `src/cli/social.ts` — deliberate reveal-semantics updates + drop stale `PeerIdentity` imports (Task 6).
- **Modify** `src/core/a2a-server.ts` + `src/core/a2a-server.test.ts` — `LetterEvent` + `POST /a2a/letter` route + `onLetter` opt (Task 7).
- **Modify** `src/core/a2a-delegate.ts` + `src/core/a2a-delegate.test.ts` — `letterUrl()` (Task 7).
- **Create** `src/core/penpal-correspondent.ts` + `src/core/penpal-correspondent.test.ts` (Task 8).
- **Create** `src/core/penpal-relay-letter.ts` + `src/core/penpal-relay-letter.test.ts` (Task 9); **Modify** `src/core/social-relay-store.ts` + `.test.ts` — `getByEndpointChannelId` (Task 9).
- **Create** `src/core/penpal-letter-command.ts` + `src/core/penpal-letter-command.test.ts` (Task 10).
- **Modify** `src/daemon/wiring/pipeline-deps.ts` + `src/daemon/wiring/pipeline-deps-social-dispatch.test.ts` — `回信` dispatch seam (Task 10).
- **Modify** `src/daemon/bootstrap/types.ts` — optional `penpal` on the boot object (Task 10).
- **Modify** `src/daemon/bootstrap/wire-social.ts` + `src/daemon/bootstrap.test.ts` — construct correspondent + `onLetter` + letter relay, expose `penpal` / set `boot.penpal`, wire `onLetter` into the a2a server (Task 11).
- **Create** `src/core/penpal.e2e.test.ts` — direct + relay full round-trip (Task 12).

**Task ordering (12 tasks):** 1 crypto · 2 v22 migration + stores · 3 repoint social-reveal (1-hop) · 4 a2a-server `RevealEvent.peer_handle` · 5 repoint relay reveal + relay-store handles · **6 wire reveal repoint → GREEN checkpoint** · 7 `/a2a/letter` route + `onLetter` + `letterUrl` · 8 `makeCorrespondent` · 9 content-blind 2-hop letter relay · 10 `回信` command + dispatch seam · 11 final wiring (correspondent/`onLetter`/`boot.penpal`) · 12 e2e (direct + relay).

---

# A1 — Crypto module + data model

## Task 1: `penpal-crypto.ts` — X25519 + HKDF-SHA256 + AES-256-GCM

**Files:**
- Create: `src/core/penpal-crypto.ts`
- Create: `src/core/penpal-crypto.test.ts`

**Interfaces:**
- Consumes: `node:crypto` built-ins only (`generateKeyPairSync`, `createPrivateKey`, `createPublicKey`, `diffieHellman`, `hkdfSync`, `randomBytes`, `createCipheriv`, `createDecipheriv`).
- Produces:
  ```ts
  export interface PenpalHandle { pubkey: string; channel_id: string }   // pubkey = spki-DER base64url
  export interface SealedLetter { nonce: string; ct: string; tag: string }  // all base64url
  export function generateKeypair(): { publicKey: string; privateKey: string }  // both base64url (spki / pkcs8 DER)
  export function deriveSharedKey(myPriv: string, peerPub: string): Buffer        // 32-byte AES key
  export function sealLetter(key: Buffer, plaintext: string): SealedLetter
  export function openLetter(key: Buffer, sealed: SealedLetter): string           // throws on tamper
  ```

**Step 1 — Failing round-trip + tamper test.** Create `src/core/penpal-crypto.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { generateKeypair, deriveSharedKey, sealLetter, openLetter } from './penpal-crypto'

describe('penpal-crypto — X25519 + HKDF + AES-256-GCM', () => {
  it('two parties derive the SAME symmetric key from crossed pubkeys', () => {
    const a = generateKeypair()
    const b = generateKeypair()
    const kAB = deriveSharedKey(a.privateKey, b.publicKey)
    const kBA = deriveSharedKey(b.privateKey, a.publicKey)
    expect(kAB.equals(kBA)).toBe(true)
    expect(kAB).toHaveLength(32)          // AES-256 key
  })

  it('keys are fresh + unlinkable across connections', () => {
    const a = generateKeypair(); const b = generateKeypair()
    expect(a.publicKey).not.toBe(b.publicKey)
    expect(a.privateKey).not.toBe(b.privateKey)
    // base64url only (no +/=): unlinkable opaque handles
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('seal → open round-trips a letter (incl. unicode)', () => {
    const a = generateKeypair(); const b = generateKeypair()
    const key = deriveSharedKey(a.privateKey, b.publicKey)
    const sealed = sealLetter(key, '你好,笔友 👋 见字如面')
    expect(sealed.nonce).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(sealed.ct).not.toContain('见字如面')     // ciphertext, not plaintext
    const opened = openLetter(deriveSharedKey(b.privateKey, a.publicKey), sealed)
    expect(opened).toBe('你好,笔友 👋 见字如面')
  })

  it('a fresh nonce per seal → identical plaintext yields different ciphertext', () => {
    const a = generateKeypair(); const b = generateKeypair()
    const key = deriveSharedKey(a.privateKey, b.publicKey)
    expect(sealLetter(key, 'x').nonce).not.toBe(sealLetter(key, 'x').nonce)
  })

  it('tamper detection — a flipped ciphertext byte throws (GCM auth)', () => {
    const a = generateKeypair(); const b = generateKeypair()
    const key = deriveSharedKey(a.privateKey, b.publicKey)
    const sealed = sealLetter(key, 'secret')
    const buf = Buffer.from(sealed.ct, 'base64url'); buf[0]! ^= 0xff
    const tampered = { ...sealed, ct: buf.toString('base64url') }
    expect(() => openLetter(key, tampered)).toThrow()
  })

  it('wrong key cannot open (no cross-connection leakage)', () => {
    const a = generateKeypair(); const b = generateKeypair(); const c = generateKeypair()
    const sealed = sealLetter(deriveSharedKey(a.privateKey, b.publicKey), 'private')
    expect(() => openLetter(deriveSharedKey(a.privateKey, c.publicKey), sealed)).toThrow()
  })
})
```

**Step 2 — Run-fail.** `bun run test src/core/penpal-crypto.test.ts` → expect `Cannot find module './penpal-crypto'`.

**Step 3 — Minimal impl.** Create `src/core/penpal-crypto.ts`:

```ts
/**
 * penpal-crypto.ts — the ONLY cryptography module for the anonymous pen-pal
 * channel. Node built-in `node:crypto` exclusively (no new dependency):
 *   - per-connection X25519 keypair (unlinkable across connections)
 *   - shared secret via crypto.diffieHellman
 *   - AES-256 key via HKDF-SHA256 (crypto.hkdfSync)
 *   - each letter sealed with AES-256-GCM + a fresh 12-byte random nonce, authenticated.
 * Keys + ciphertext are stored/transmitted as base64url (URL-safe, no padding).
 * The private key NEVER leaves the machine; only the spki-DER pubkey is crossed
 * at reveal (the PenpalHandle). See docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md.
 */
import {
  generateKeyPairSync, createPrivateKey, createPublicKey, diffieHellman,
  hkdfSync, randomBytes, createCipheriv, createDecipheriv,
} from 'node:crypto'

/** A per-connection pseudonym crossed at reveal: an ephemeral pubkey + the
 *  opaque channel id the holder listens on. Contains NO real identity. */
export interface PenpalHandle { pubkey: string; channel_id: string }

/** An AES-256-GCM sealed letter; every field base64url. */
export interface SealedLetter { nonce: string; ct: string; tag: string }

// Domain-separation constants for HKDF — fixed on both sides so the derived key matches.
const HKDF_SALT = Buffer.alloc(0)
const HKDF_INFO = Buffer.from('wechat-cc penpal channel v1')
const KEY_LEN = 32   // AES-256
const NONCE_LEN = 12 // GCM standard

/** Fresh per-connection X25519 keypair. base64url of the DER encodings
 *  (spki for the public handle, pkcs8 for the local-only private key). */
export function generateKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  }
}

/** ECDH(my private, peer public) → HKDF-SHA256 → 32-byte AES key. Symmetric:
 *  deriveSharedKey(aPriv, bPub) === deriveSharedKey(bPriv, aPub). */
export function deriveSharedKey(myPriv: string, peerPub: string): Buffer {
  const privateKey = createPrivateKey({ key: Buffer.from(myPriv, 'base64url'), format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey({ key: Buffer.from(peerPub, 'base64url'), format: 'der', type: 'spki' })
  const shared = diffieHellman({ privateKey, publicKey })
  return Buffer.from(hkdfSync('sha256', shared, HKDF_SALT, HKDF_INFO, KEY_LEN))
}

/** AES-256-GCM seal with a fresh random nonce; returns base64url {nonce,ct,tag}. */
export function sealLetter(key: Buffer, plaintext: string): SealedLetter {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { nonce: nonce.toString('base64url'), ct: ct.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
}

/** AES-256-GCM open; throws if the tag doesn't authenticate (tamper / wrong key). */
export function openLetter(key: Buffer, sealed: SealedLetter): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64url'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'))
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64url')), decipher.final()])
  return pt.toString('utf8')
}
```

**Step 4 — Run-pass.** `bun run test src/core/penpal-crypto.test.ts` → all green. `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**. **Do NOT run `bun run depcheck` this task** — `penpal-crypto.ts` has no importer yet, so `no-orphans` will fire; expected, resolves in Task 2 (which imports `PenpalHandle`). Defer depcheck to Task 2.

**Step 5 — Commit.** `git add -A && git commit -m "feat(penpal): penpal-crypto — X25519 + HKDF + AES-256-GCM sealed letters"`

- [ ] Task 1 complete

---

## Task 2: Migration v22 + `penpal_channel` / `penpal_letter` stores + smoke bump

**Files:**
- Modify: `src/lib/db.ts` (append to `migrations`, after the v21 entry closing `~:531`)
- Modify: `src/lib/state-migration.test.ts` (`~:64`–`:80`)
- Create: `src/core/penpal-channel-store.ts` + `src/core/penpal-channel-store.test.ts`
- Create: `src/core/penpal-letter-store.ts` + `src/core/penpal-letter-store.test.ts`

**Interfaces:**
- Consumes: `Db` from `../lib/db`; `PenpalHandle` from `./penpal-crypto`.
- Produces: `PRAGMA user_version` → 22; two new STRICT tables `penpal_channel`, `penpal_letter`; two nullable `ADD COLUMN`s on `social_relay` (`upstream_handle`, `downstream_handle`); table count 20→22. Stores:
  ```ts
  export interface ChannelRow {
    id: string; seek_id: string; my_privkey: string; my_pubkey: string; my_channel_id: string
    peer_pubkey: string | null; peer_channel_id: string | null
    degree: number; relay_via: string | null; peer_agent_id: string | null
    status: 'pending' | 'open'; created_at: string
  }
  export interface ChannelStore {
    create(c: { id: string; seekId: string; myPrivkey: string; myPubkey: string; myChannelId: string; degree: number; relayVia?: string | null; peerAgentId?: string | null }): void
    get(id: string): ChannelRow | null
    getByMyChannelId(channelId: string): ChannelRow | null
    setPeerHandle(id: string, handle: PenpalHandle): void   // sets peer_pubkey + peer_channel_id + status='open'
    setStatus(id: string, status: ChannelRow['status']): void
    list(): ChannelRow[]
  }
  export interface LetterRow {
    id: string; channel_id: string; direction: 'in' | 'out'
    sealed_ciphertext: string; nonce: string; tag: string
    plaintext: string; created_at: string; read_at: string | null
  }
  export interface LetterStore {
    create(l: { id: string; channelId: string; direction: 'in' | 'out'; sealedCiphertext: string; nonce: string; tag: string; plaintext: string }): void
    listForChannel(channelId: string): LetterRow[]
    get(id: string): LetterRow | null
    markRead(id: string, at: string): void
  }
  ```
  > **Column notes:** GCM cannot open without the auth tag, which the brief's `sealed_ciphertext, nonce` list omitted — this plan adds a `tag` column (base64url). The `plaintext` column always holds **local-only** text and **never goes on the wire**; only `sealed_ciphertext`/`nonce`/`tag` cross (spec §5). `sealed_ciphertext` holds the base64url `ct` (the `ct` ⇄ `sealed_ciphertext` mapping).

**Step 1 — Failing smoke test.** Edit `src/lib/state-migration.test.ts` (`:64`). Rename the block to `= 22 and the 22 tables`, bump the expectation, add a comment line, insert `'penpal_channel'` + `'penpal_letter'` into the sorted list (they sort BEFORE `session_state`: `observations` < `penpal_channel` < `penpal_letter` < `session_state`):

```ts
  it('opens a fresh db with PRAGMA user_version = 22 and the 22 tables', () => {
    const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    // v19 (agent-social 觅食台 state): social_seek + social_echo tables added.
    // v20 (async foraging spine): social_echo reveal columns + social_pledge table added.
    // v21 (forwarding hop): social_echo relay columns + social_relay + social_seen_intent tables added.
    // v22 (匿名笔友通道 A): penpal_channel + penpal_letter tables + social_relay handle columns added.
    expect(v).toBe(22)
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toEqual([
      'a2a_events', 'activity', 'connection_heartbeat', 'conversations', 'events', 'handled_messages', 'message_attempts', 'messages',
      'milestones', 'observations', 'penpal_channel', 'penpal_letter', 'session_state', 'sessions', 'social_echo', 'social_pledge', 'social_relay', 'social_seek', 'social_seen_intent', 'thread_extract_state', 'threads', 'turn_records',
    ])
  })
```

**Step 2 — Run-fail.** `bun run test src/lib/state-migration.test.ts` → red (`user_version` is 21, tables list mismatch).

**Step 3 — Minimal impl (migration).** In `src/lib/db.ts`, append a new entry to `migrations` AFTER the v21 entry (which closes at `~:531`, the `]` on `:532`):

```ts
  // v22 — 匿名笔友通道 (sub-project A). The E2E pen-pal channel: penpal_channel
  // holds the per-connection X25519 keypair (my_privkey LOCAL-only) + the peer's
  // crossed handle (pubkey + channel id), nullable until mutual reveal opens the
  // channel. penpal_letter is the local correspondence thread — sealed ct+nonce+tag
  // on the wire, decrypted plaintext kept locally for the owner. social_relay gains
  // two nullable handle columns so the intermediary (W) can persist each endpoint's
  // presented pubkey handle to hand to the OTHER leg — W crosses pubkeys the
  // endpoints supplied, never a real identity. Nullable-TEXT ADD COLUMN is safe on
  // STRICT; social_relay is created unconditionally by v21, so the ALTER is safe
  // even in the user_version=9 test harnesses.
  // See docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md.
  (db) => {
    db.exec(`
      ALTER TABLE social_relay ADD COLUMN upstream_handle TEXT;
      ALTER TABLE social_relay ADD COLUMN downstream_handle TEXT;
      CREATE TABLE IF NOT EXISTS penpal_channel (
        id                TEXT PRIMARY KEY,        -- = the echo/pledge/relay-leg id it opened from
        seek_id           TEXT NOT NULL,           -- the local seek (or intent) this channel belongs to
        my_privkey        TEXT NOT NULL,           -- LOCAL-only X25519 private (pkcs8 DER base64url)
        my_pubkey         TEXT NOT NULL,           -- crossed to the peer (spki DER base64url)
        my_channel_id     TEXT NOT NULL,           -- my inbound address; peer addresses letters TO me by it
        peer_pubkey       TEXT,                    -- crossed FROM the peer (nullable until reveal)
        peer_channel_id   TEXT,                    -- peer's inbound address (nullable until reveal)
        degree            INTEGER NOT NULL DEFAULT 1,
        relay_via         TEXT,                    -- the intermediary agent id for a 2-hop channel (nullable)
        peer_agent_id     TEXT,                    -- direct peer's agent id (nullable for relay channels)
        status            TEXT NOT NULL,           -- 'pending' | 'open'
        created_at        TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_penpal_channel_mychan ON penpal_channel(my_channel_id);
      CREATE TABLE IF NOT EXISTS penpal_letter (
        id                TEXT PRIMARY KEY,
        channel_id        TEXT NOT NULL,
        direction         TEXT NOT NULL,           -- 'in' | 'out'
        sealed_ciphertext TEXT NOT NULL,           -- base64url AES-GCM ct (the ONLY thing on the wire)
        nonce             TEXT NOT NULL,           -- base64url 12-byte GCM nonce
        tag               TEXT NOT NULL,           -- base64url GCM auth tag
        plaintext         TEXT NOT NULL,           -- decrypted, kept LOCAL for the owner's thread
        created_at        TEXT NOT NULL,
        read_at           TEXT                     -- nullable; set when the owner has seen it
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_penpal_letter_channel ON penpal_letter(channel_id);
    `)
  },
```

**Step 4 — Run-pass (smoke).** `bun run test src/lib/state-migration.test.ts` → green. `bun run typecheck` → clean.

**Step 5 — Failing store tests.** Create `src/core/penpal-channel-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeChannelStore } from './penpal-channel-store'

describe('makeChannelStore', () => {
  it('creates a pending channel, looks it up by id + my_channel_id, opens it on peer handle', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeChannelStore(db)
    s.create({ id: 'i1:ccb', seekId: 'i1', myPrivkey: 'PRIV', myPubkey: 'PUB', myChannelId: 'chan-A', degree: 1, peerAgentId: 'ccb' })
    const row = s.get('i1:ccb')!
    expect(row.status).toBe('pending')
    expect(row.peer_pubkey).toBeNull()
    expect(row.my_channel_id).toBe('chan-A')
    expect(s.getByMyChannelId('chan-A')!.id).toBe('i1:ccb')

    s.setPeerHandle('i1:ccb', { pubkey: 'PEERPUB', channel_id: 'chan-B' })
    const opened = s.get('i1:ccb')!
    expect(opened.status).toBe('open')
    expect(opened.peer_pubkey).toBe('PEERPUB')
    expect(opened.peer_channel_id).toBe('chan-B')
  })

  it('getByMyChannelId returns null for an unknown address', () => {
    const s = makeChannelStore(openDb({ path: ':memory:' }))
    expect(s.getByMyChannelId('nope')).toBeNull()
  })
})
```

Create `src/core/penpal-letter-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeLetterStore } from './penpal-letter-store'

describe('makeLetterStore', () => {
  it('stores in/out letters per channel, newest-first, and marks read', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeLetterStore(db)
    s.create({ id: 'l1', channelId: 'c1', direction: 'in', sealedCiphertext: 'CT1', nonce: 'N1', tag: 'T1', plaintext: '你好' })
    s.create({ id: 'l2', channelId: 'c1', direction: 'out', sealedCiphertext: 'CT2', nonce: 'N2', tag: 'T2', plaintext: '回信了' })
    s.create({ id: 'l3', channelId: 'c2', direction: 'in', sealedCiphertext: 'CT3', nonce: 'N3', tag: 'T3', plaintext: '别的通道' })

    expect(s.listForChannel('c1').map(r => r.id)).toEqual(['l2', 'l1'])   // newest first
    expect(s.get('l1')!.plaintext).toBe('你好')
    expect(s.get('l1')!.read_at).toBeNull()
    s.markRead('l1', '2026-07-18T00:00:00.000Z')
    expect(s.get('l1')!.read_at).toBe('2026-07-18T00:00:00.000Z')
  })
})
```

**Step 6 — Run-fail.** `bun run test src/core/penpal-channel-store.test.ts src/core/penpal-letter-store.test.ts` → red (missing modules).

**Step 7 — Minimal impl (stores).** Create `src/core/penpal-channel-store.ts`:

```ts
/**
 * penpal-channel-store.ts — the per-connection pen-pal channel. Mirrors the
 * social store idiom (social-echo-store.ts). Holds this side's LOCAL X25519
 * keypair + channel id, plus the peer's crossed handle (pubkey + channel id),
 * nullable until the mutual reveal opens the channel. NO real identity is ever
 * stored — the peer is only ever a pubkey + an opaque channel address.
 */
import type { Db } from '../lib/db'
import type { PenpalHandle } from './penpal-crypto'

export interface ChannelRow {
  id: string; seek_id: string; my_privkey: string; my_pubkey: string; my_channel_id: string
  peer_pubkey: string | null; peer_channel_id: string | null
  degree: number; relay_via: string | null; peer_agent_id: string | null
  status: 'pending' | 'open'; created_at: string
}
export interface ChannelStore {
  create(c: { id: string; seekId: string; myPrivkey: string; myPubkey: string; myChannelId: string; degree: number; relayVia?: string | null; peerAgentId?: string | null }): void
  get(id: string): ChannelRow | null
  getByMyChannelId(channelId: string): ChannelRow | null
  setPeerHandle(id: string, handle: PenpalHandle): void
  setStatus(id: string, status: ChannelRow['status']): void
  list(): ChannelRow[]
}

export function makeChannelStore(db: Db): ChannelStore {
  const ins = db.query<unknown, [string, string, string, string, string, number, string | null, string | null, string]>(
    `INSERT INTO penpal_channel(id, seek_id, my_privkey, my_pubkey, my_channel_id, degree, relay_via, peer_agent_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
  const selOne = db.query<ChannelRow, [string]>('SELECT * FROM penpal_channel WHERE id = ?')
  const selByChan = db.query<ChannelRow, [string]>('SELECT * FROM penpal_channel WHERE my_channel_id = ?')
  const selAll = db.query<ChannelRow, []>('SELECT * FROM penpal_channel ORDER BY created_at DESC, rowid DESC')
  const updPeer = db.query<unknown, [string, string, string]>(`UPDATE penpal_channel SET peer_pubkey = ?, peer_channel_id = ?, status = 'open' WHERE id = ?`)
  const updStatus = db.query<unknown, [string, string]>('UPDATE penpal_channel SET status = ? WHERE id = ?')
  return {
    create(c) { ins.run(c.id, c.seekId, c.myPrivkey, c.myPubkey, c.myChannelId, c.degree, c.relayVia ?? null, c.peerAgentId ?? null, new Date().toISOString()) },
    get(id) { return selOne.get(id) ?? null },
    getByMyChannelId(channelId) { return selByChan.get(channelId) ?? null },
    setPeerHandle(id, handle) { updPeer.run(handle.pubkey, handle.channel_id, id) },
    setStatus(id, status) { updStatus.run(status, id) },
    list() { return selAll.all() },
  }
}
```

Create `src/core/penpal-letter-store.ts`:

```ts
/**
 * penpal-letter-store.ts — the LOCAL correspondence thread for a channel. The
 * wire only ever carries sealed_ciphertext + nonce + tag; the decrypted
 * plaintext is kept here for the owner (spec §5). Mirrors social-pledge-store.ts.
 */
import type { Db } from '../lib/db'

export interface LetterRow {
  id: string; channel_id: string; direction: 'in' | 'out'
  sealed_ciphertext: string; nonce: string; tag: string
  plaintext: string; created_at: string; read_at: string | null
}
export interface LetterStore {
  create(l: { id: string; channelId: string; direction: 'in' | 'out'; sealedCiphertext: string; nonce: string; tag: string; plaintext: string }): void
  listForChannel(channelId: string): LetterRow[]
  get(id: string): LetterRow | null
  markRead(id: string, at: string): void
}

export function makeLetterStore(db: Db): LetterStore {
  const ins = db.query<unknown, [string, string, string, string, string, string, string, string]>(
    `INSERT INTO penpal_letter(id, channel_id, direction, sealed_ciphertext, nonce, tag, plaintext, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selByChan = db.query<LetterRow, [string]>('SELECT * FROM penpal_letter WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC')
  const selOne = db.query<LetterRow, [string]>('SELECT * FROM penpal_letter WHERE id = ?')
  const updRead = db.query<unknown, [string, string]>('UPDATE penpal_letter SET read_at = ? WHERE id = ?')
  return {
    create(l) { ins.run(l.id, l.channelId, l.direction, l.sealedCiphertext, l.nonce, l.tag, l.plaintext, new Date().toISOString()) },
    listForChannel(channelId) { return selByChan.all(channelId) },
    get(id) { return selOne.get(id) ?? null },
    markRead(id, at) { updRead.run(at, id) },
  }
}
```

**Step 8 — Run-pass.** `bun run test src/core/penpal-channel-store.test.ts src/core/penpal-letter-store.test.ts src/lib/state-migration.test.ts` → green.

**Gates:** test **green**; typecheck **green**; **`bun run depcheck` green** (the stores now import `penpal-crypto`, clearing its orphan; all three files are `src/core/` → `src/lib/` + `node:crypto`, no runtime edge).

**Step 9 — Commit.** `git commit -am "feat(penpal): v22 migration + penpal_channel/penpal_letter stores"`

- [ ] Task 2 complete

---

# A2 — Repoint reveal (1-hop first)

## Task 3: `PenpalHandle` repoint in `social-reveal.ts` — cross pubkeys, open channel

**Files:**
- Modify: `src/core/social-reveal.ts`
- Modify: `src/core/social-reveal.test.ts`

**Interfaces:**
- Consumes: `PenpalHandle` from `./penpal-crypto`; `EchoStore` / `PledgeStore` / `SeekStore`.
- Produces (signature changes — LOAD-BEARING):
  - `ChannelPort = { openLocal(rowId, ctx): PenpalHandle; finalize(rowId, peerHandle): void }` — a small channel port so the revealer stays pure (no DB knowledge; backed by `makeChannelStore` in Task 6). `openLocal` is called at the ①→② opt-in (my consent) — idempotent: mint a keypair + channel id and a pending channel row keyed by `rowId` if absent, return THIS side's `PenpalHandle`. `finalize` is called at the mutual instant: store the peer's crossed handle, status→open.
    ```ts
    export interface ChannelPort {
      openLocal(rowId: string, ctx: { seekId: string; degree: number; peerAgentId?: string | null; relayVia?: string | null }): PenpalHandle
      finalize(rowId: string, peerHandle: PenpalHandle): void
    }
    ```
  - `RevealerDeps`: **drop `selfIdentity`**; add `channel: ChannelPort`; change `postPeerReveal(agentId, intentId, relayToken?)` return to `Promise<{ mutual: boolean; handle?: PenpalHandle } | null>` (was `identity?: PeerIdentity`).
  - `Revealer.onInboundReveal({ agentId, intentId, relayToken?, peerHandle? }) → { mutual: boolean; handle?: PenpalHandle }`.
  - **`PeerIdentity` is REMOVED from `social-reveal.ts`.** Re-export `PenpalHandle` from here + export `ChannelPort`. (`social-relay-reveal.ts`, `wire-social.ts`, `cli/social.ts` still import `PeerIdentity` → they break; fixed in Tasks 5/6. This is the intrinsic-red window.)

> **The revealer wires two calls into the existing flow:** call `deps.channel.openLocal(rowId, {...})` right where it writes `setSelfRevealed` (my consent), and `deps.channel.finalize(rowId, resp.handle/peerHandle)` right where it USED to call `echoStore.setRevealedIdentity(...)`. The masked label is left untouched — `第 N 度的某人` is permanent (LOCKED §3). Every `notify('connected', …)` drops `peerName`/name fields — content-free warmth (LOCKED §3/§6).

**Step 1 — Update the failing tests (reveal semantics CHANGE — deliberate, not a regression).** Rewrite `src/core/social-reveal.test.ts`. Swap `PeerIdentity` fixtures for `PenpalHandle` + a fake `ChannelPort`:

```ts
import { makeRevealer } from './social-reveal'
import type { PenpalHandle, ChannelPort } from './social-reveal'   // ChannelPort re-exported from here

const SELF_HANDLE: PenpalHandle = { pubkey: 'SELF_PUB', channel_id: 'self-chan' }
const PEER_HANDLE: PenpalHandle = { pubkey: 'PEER_PUB', channel_id: 'peer-chan' }

function fixture(postPeerReveal: any) {
  const db = openDb({ path: ':memory:' })
  const echoStore = makeEchoStore(db)
  const pledgeStore = makePledgeStore(db)
  const seekStore = makeSeekStore(db)
  const notify = vi.fn()
  const opened: string[] = []; const finalized: Array<[string, PenpalHandle]> = []
  const channel: ChannelPort = {
    openLocal: (rowId) => { opened.push(rowId); return SELF_HANDLE },
    finalize: (rowId, h) => { finalized.push([rowId, h]) },
  }
  const revealer = makeRevealer({ echoStore, pledgeStore, seekStore, postPeerReveal, channel, notify })
  return { db, echoStore, pledgeStore, seekStore, notify, revealer, opened, finalized }
}
```

Then rewrite each `it(...)` in full (mirror the existing structure 1:1, only swapping identity→handle + masked-stays-masked):
- "I reveal, peer already consented → mutual" (`:22`): `post` returns `{ mutual: true, handle: PEER_HANDLE }`; expect `post` called `('ccb', 'i1')`; assert `opened` contains `'i1:ccb'`; assert `finalized` contains `['i1:ccb', PEER_HANDLE]`; **assert `echo.peer_masked` STAYS `'第 1 度的某人'`** (NO name swap); assert `notify('connected', objectContaining({ intentId: 'i1' }))` with NO `peerName`.
- "second revealer gets mutual synchronously" (`:96`): call `onInboundReveal({ agentId: 'ccb', intentId: 'i1', peerHandle: PEER_HANDLE })` → returns `{ mutual: true, handle: SELF_HANDLE }`; assert `finalized` got `['i1:ccb', PEER_HANDLE]`; masked unchanged.
- "peer reveals before me" (`:85`): `onInboundReveal({ agentId: 'ccb', intentId: 'i1', peerHandle: PEER_HANDLE })` → `{ mutual: false }`; `peer_revealed_at` set; **but `finalize` NOT called** (M2 below) — the peer's handle can't be persisted against a channel row that doesn't exist yet.
- relay-branch tests (`:178`+): `post` returns `{ mutual: true, handle: PEER_HANDLE }`; assert `finalized` got the relay row id + `PEER_HANDLE`; masked unchanged.
- Delete every "identity swapped in / `.toBe('小B')` / `.toBe('小Q')`" masked assertion — replace with "masked stays `第 N 度的某人`".

**Step 2 — Run-fail.** `bun run test src/core/social-reveal.test.ts` → red.

**Step 3 — Minimal impl.** Edit `src/core/social-reveal.ts`:
- Remove `export interface PeerIdentity`; add `export type { PenpalHandle } from './penpal-crypto'` and `export interface ChannelPort {...}` (as above).
- `RevealerDeps`: drop `selfIdentity`; add `channel: ChannelPort`; `postPeerReveal` return `{ mutual: boolean; handle?: PenpalHandle } | null`.
- `Revealer.onInboundReveal` param gains `peerHandle?: PenpalHandle`; return `{ mutual, handle? }`.
- `revealEcho`: where it does `if (!echo.self_revealed_at) deps.echoStore.setSelfRevealed(...)`, ALSO call `deps.channel.openLocal(echoId, { seekId: echo.seek_id, degree: echo.degree, peerAgentId: echo.peer_agent_id, relayVia: echo.relay_via })`. On `resp.mutual`: replace `if (resp.identity) deps.echoStore.setRevealedIdentity(echoId, resp.identity.name)` with `if (resp.handle) deps.channel.finalize(echoId, resp.handle)`; drop `peerName` from `notify('connected', …)`.
- `onInboundReveal` (echo + pledge branches): the mutual-return path returns `{ mutual: true, handle: deps.channel.openLocal(rowId, {...}) }` (idempotent openLocal mints/returns MY handle at the mutual instant), and calls `if (peerHandle) deps.channel.finalize(rowId, peerHandle)`. The pre-mutual path (peer revealed before me) marks `peer_revealed_at` + fires `await_reveal` and does **NOT** call `finalize` (no channel row yet — M2). Remove `selfIdentity()`; the identity handed back is now the channel handle.
- `revealPledge`: same treatment (openLocal at self-reveal, finalize on mutual, content-free notify).

> **M2 (explicit):** when the answerer receives the seeker's reveal BEFORE revealing itself, it has no channel row yet — so the seeker's presented `peerHandle` cannot be stored against a row. It is intentionally re-delivered later via the mutual response (`{ mutual: true, handle }`) when the answerer reveals second. Do NOT attempt to persist a handle against a non-existent row; the pre-mutual path only marks `peer_revealed_at`.
> **M3 (record):** `EchoStore.setRevealedIdentity` + the `social_echo` masked-swap it performs become **deliberately-retained dead code** after this repoint (nothing calls it in the reveal path anymore). Harmless; leave it + its own unit test (`social-echo-store.test.ts:31`) in place for a later cleanup pass — do NOT delete it in this plan.

**Step 4 — Run-pass.** `bun run test src/core/social-reveal.test.ts` → green.

**Gates:** test **green**. `bun run typecheck` **RED — expected** (intrinsic-red window: `a2a-server.ts`, `social-relay-reveal.ts`, `wire-social.ts`, `cli/social.ts` still reference the removed `PeerIdentity`/`selfIdentity`/`identity`). Do NOT chase it here — clears at Task 6. `bun run depcheck` **green**.

**Step 5 — Commit.** `git commit -am "refactor(penpal): repoint social-reveal to cross PenpalHandle + open channel (1-hop)"`

- [ ] Task 3 complete

---

## Task 4: `a2a-server` — `RevealEvent.peer_handle` replaces `peer_name`

**Files:**
- Modify: `src/core/a2a-server.ts` (`RevealEvent` `~:74`, `/a2a/reveal` route `~:294`, `onReveal` opt type `~:113`)
- Modify: `src/core/a2a-server.test.ts` (reveal route tests)

**Interfaces:**
- Consumes: `PenpalHandle` from `./penpal-crypto`.
- Produces: `RevealEvent = { agent_id, intent_id, relay_token?, peer_handle?: PenpalHandle }` (drop `peer_name`). `onReveal` return `{ mutual: boolean; handle?: PenpalHandle }` (drop `identity`). The `/a2a/reveal` route parses `body.peer_handle` (object `{ pubkey, channel_id }`, both non-empty strings, else dropped to `undefined`) and forwards it; `agent_id` still comes from the verified Bearer `agent.id`.

**Step 1 — Update reveal-route tests** in `src/core/a2a-server.test.ts`: any post of `peer_name` → `peer_handle: { pubkey, channel_id }`; any assertion on a returned `identity` → `handle`. Add: a malformed `peer_handle` (missing `channel_id`) reaches `onReveal` as `peer_handle: undefined` (route does NOT 400 — it's optional metadata).

**Step 2 — Run-fail.** `bun run test src/core/a2a-server.test.ts` → red.

**Step 3 — Minimal impl.** In `a2a-server.ts`:
- `RevealEvent`: replace `peer_name?: string` with `peer_handle?: import('./penpal-crypto').PenpalHandle`.
- `onReveal` opt return: `{ mutual: boolean; handle?: { pubkey: string; channel_id: string } }`.
- In the `/a2a/reveal` handler (`~:326`), replace the `peerName` parse with:
  ```ts
  const ph = body.peer_handle
  const peerHandle = (ph && typeof ph === 'object'
    && typeof (ph as any).pubkey === 'string' && (ph as any).pubkey
    && typeof (ph as any).channel_id === 'string' && (ph as any).channel_id)
    ? { pubkey: (ph as any).pubkey, channel_id: (ph as any).channel_id } : undefined
  const result = await opts.onReveal({ agent_id: agent.id, intent_id: body.intent_id, relay_token: relayToken, ...(peerHandle ? { peer_handle: peerHandle } : {}) })
  ```
  Widen the `body` destructure type to include `peer_handle?: unknown`.

**Step 4 — Run-pass.** `bun run test src/core/a2a-server.test.ts` → green.

**Gates:** test **green**. `bun run typecheck` **RED — expected** (still the intrinsic-red window; `wire-social.ts` unfixed). `bun run depcheck` **green**.

**Step 5 — Commit.** `git commit -am "refactor(penpal): a2a-server RevealEvent crosses peer_handle not peer_name"`

- [ ] Task 4 complete

---

# A3 — Repoint relay reveal (2-hop) + wire the whole reveal path GREEN

## Task 5: `social-relay-reveal.ts` — cross pubkeys, drop `identityOf`, persist leg handles

**Files:**
- Modify: `src/core/social-relay-reveal.ts`
- Modify: `src/core/social-relay-reveal.test.ts`
- Modify: `src/core/social-relay-store.ts` + `src/core/social-relay-store.test.ts`

**Interfaces:**
- Consumes: `PenpalHandle` from `./penpal-crypto`; `RelayStore` (extended).
- Produces:
  - `RelayStore` gains `setUpstreamHandle(id, handle: PenpalHandle)` / `setDownstreamHandle(id, handle: PenpalHandle)`; `RelayRow` gains `upstream_handle: string | null` / `downstream_handle: string | null` (each a `JSON.stringify(PenpalHandle)`; the reconciler decodes with `JSON.parse`). Columns already exist from v22 (Task 2).
  - `RelayReconcilerDeps`: **REMOVE `identityOf`.** `onRelayReveal` event gains `peerHandle?: PenpalHandle` (the handle the CALLING endpoint presented). `completeUpstream(up, intent, tok, downstreamHandle: PenpalHandle)` / `completeDownstream(down, intent, upstreamHandle: PenpalHandle)`; `notify3way(intent, upstreamHandle: PenpalHandle, downstreamHandle: PenpalHandle)` (content-free warmth — W's owner is told it connected a pair, NO real names, which W never had).
  - `RelayReconciler.onRelayReveal({ callerAgentId, intentId, relayToken?, peerHandle? }) → { mutual: boolean; handle?: PenpalHandle } | null`.

> **Why W persists handles (the core content-blindness change):** the old reconciler resolved BOTH identities from W's registry at the crossing instant. Pubkeys are ephemeral + endpoint-generated → W CANNOT look them up: it must **persist each leg's presented handle when that leg reveals** and hand the OTHER leg's stored handle to whoever reveals second. So `onRelayReveal` records `peerHandle` onto the row on the marking path, and reads the opposite leg's stored handle on the crossing path.

**Step 1 — `social-relay-store` test + impl.** In `social-relay-store.test.ts` add: `setUpstreamHandle(id, {pubkey:'P',channel_id:'C'})` then `get(id).upstream_handle === JSON.stringify({pubkey:'P',channel_id:'C'})`. Add `setUpstreamHandle`/`setDownstreamHandle` (store `JSON.stringify(handle)`) + the two nullable columns on `RelayRow`. Run-fail → impl → run-pass.

**Step 2 — Update the failing reconciler tests** in `src/core/social-relay-reveal.test.ts`: remove the `identityOf` dep + `idOf` fixture. Each endpoint's reveal now carries `peerHandle`. Assert:
- Marking path (only this leg revealed): the presented `peerHandle` is persisted (`setUpstreamHandle`/`setDownstreamHandle` called); nudge unchanged.
- Crossing path: `completeUpstream`/`completeDownstream` receive the OTHER leg's STORED handle (decoded); `onRelayReveal` returns `{ mutual: true, handle: <other leg's stored handle> }`.
- `notify3way` fires exactly once with the two handles (content-free).
- Transient-miss guard: the old `!sIdentity || !qIdentity` becomes `!storedOtherHandle` (the other leg revealed but its handle wasn't persisted — shouldn't happen; fail-safe returns `{ mutual: false }` without marking).

**Step 3 — Run-fail.** `bun run test src/core/social-relay-reveal.test.ts` → red.

**Step 4 — Minimal impl.** Rewrite `makeRelayReconciler`:
- Drop `identityOf`. Change `completeUpstream`/`completeDownstream`/`notify3way` to `PenpalHandle`. Add `peerHandle?: PenpalHandle` to the event.
- Marking path (`otherLegRevealed === false`): persist the caller's `peerHandle` (`isUpstreamLeg ? setUpstreamHandle : setDownstreamHandle`) alongside `setUpstream/DownstreamRevealed`, then nudge.
- Crossing path (`otherLegRevealed === true`): persist the caller's `peerHandle` on its leg, read the OTHER leg's stored handle (decode), cross:
  - `isUpstreamLeg` (caller = S): store S's handle as `upstream_handle`; row has `downstream_handle` (Q's). `completeDownstream(Q, intent, S_handle)`; return `{ mutual: true, handle: Q_handle }`.
  - else (caller = Q): store Q's handle as `downstream_handle`; row has `upstream_handle` (S's). `completeUpstream(S, intent, relay_token, Q_handle)`; return `{ mutual: true, handle: S_handle }`.
  - `notify3way(intent, S_handle, Q_handle)`.
- Idempotency + caller-binding branches unchanged (swap the identity type for handle).

**Step 5 — Run-pass.** `bun run test src/core/social-relay-reveal.test.ts src/core/social-relay-store.test.ts` → green.

**Gates:** test **green**. `bun run typecheck` **RED — expected** (last of the intrinsic-red window; `wire-social.ts` still references `identityOf`/`selfIdentity`/`PeerIdentity`). `bun run depcheck` **green**.

**Step 6 — Commit.** `git commit -am "refactor(penpal): relay reconciler crosses pubkeys, persists leg handles (content-blind 2-hop)"`

- [ ] Task 5 complete

---

## Task 6: wire the reveal repoint in `wire-social.ts` — **GREEN CHECKPOINT**

> **This task closes A3 and makes the whole tree GREEN again — an independently reviewable checkpoint: "reveal now crosses pubkeys, all social e2e green, letters not built yet."** It does reveal-repoint wiring ONLY — no letters, no correspondent, no `onLetter`. Those land in Task 11.

**Files:**
- Modify: `src/daemon/bootstrap/wire-social.ts`
- Modify: `src/daemon/bootstrap.test.ts` (`:1224` I1 test)
- Modify: `src/core/social-m1.e2e.test.ts`
- Modify: `src/cli/social.ts` (only if it imports the removed `PeerIdentity` — verify + drop)

**Interfaces:**
- Consumes: `makeChannelStore` (Task 2), `generateKeypair` + `PenpalHandle` (Task 1), `randomUUID` (`node:crypto`), the repointed `makeRevealer` / `makeRelayReconciler`.
- Produces: `wire-social.ts` constructs a `ChannelStore` + a `ChannelPort`, passes `channel` into `makeRevealer` (drops `selfIdentity`), rebuilds the relay reconciler without `identityOf`, deletes the direct name-swap block, makes warmth content-free, and carries `peer_handle` in `postPeerReveal`/`postReveal`. **No `PeerIdentity`/`selfIdentity`/`identityOf` reference remains anywhere in the tree.**

**Step 1 — Update the deliberate reveal-semantics tests (call-out — these ASSERT real-identity crossing today; the repoint makes those assertions wrong BY DESIGN, per LOCKED §3):**

- **Sweep first:** `grep -rn "peer_masked" src --include='*.test.ts'` — enumerate every name-swap assertion so none is left behind. Expected hits + disposition:
  - `src/core/social-reveal.test.ts` — already updated in Task 3 ✓.
  - `src/core/social-m1.e2e.test.ts:111` (`.toBe('小B')`), `:229` (`.toBe('小Q')`) — **update here** (below).
  - `src/daemon/bootstrap.test.ts:1276` (`.toBe('小B')`) — **update here** (below, the I1 test).
  - `src/core/social-echo-store.test.ts:31` (`.toBe('小B')`) — **KEEP**: `setRevealedIdentity` store unit test (retained dead code, M3), unrelated to the reveal path.
  - `src/daemon/internal-api.test.ts:2738,2807` (`peer_masked: 'p***'`) — **KEEP**: fixture data, not a name-swap assertion.
  - `src/core/social-m1.e2e.test.ts:75,196` (`.toBe('第 … 度的某人')`) — **KEEP** (already assert masked-stays-masked).

- **`src/daemon/bootstrap.test.ts:1224`** — the test `it('first-revealer echo gets peer_masked swapped to the real name on inbound-completed mutual')` asserts `expect(echo.peer_masked).toBe('小B')` (`:1276`). The name-swap deletion makes that FALSE. Rewrite it (rename → `it('first-revealer echo stays masked and opens a penpal_channel on inbound-completed mutual')`) to assert instead:
  - `echo.peer_masked` STAYS `'第 1 度的某人'` (or whatever the seeded mask is) — NO real name;
  - a `penpal_channel` row exists for that echo id (`makeChannelStore(<boot's db>).get('<intent>:<peer>')`) with `status === 'open'` and a **non-null `peer_pubkey`** (the crossed handle);
  - the connected beat / notify carries NO peer name (content-free).

- **`src/core/social-m1.e2e.test.ts`** — constructs `makeRevealer` directly with `selfIdentity: () => S` / asserts `peer_masked` becomes `'小B'` / `'小Q'` and the connected beat carries `peerName:'小S'`. Update to the repointed shape: pass a real `channel` port (back it with `makeChannelStore` over each side's in-memory db, or an inline fake that records `openLocal`/`finalize`); the reveal exchange now carries `handle` not `identity`. Assert:
  - `:111` / `:229` masked assertions → masked STAYS `第 N 度的某人`;
  - after mutual, the seeker's `penpal_channel` row is `open` with a non-null `peer_pubkey`/`peer_channel_id`;
  - the connected beat is content-free (drop the `peerName:'小S'` / `objectContaining({ peerName })` assertions);
  - 3-way warmth still fires once (relay case), now with handles.

**Step 2 — Run-fail.** `bun run test src/daemon/bootstrap.test.ts src/core/social-m1.e2e.test.ts` → red.

**Step 3 — Minimal impl (`wire-social.ts`):**
- Construct `const channelStore = makeChannelStore(deps.db)`.
- Build the `ChannelPort`:
  ```ts
  const channel: ChannelPort = {
    openLocal(rowId, ctx) {
      const existing = channelStore.get(rowId)
      if (existing) return { pubkey: existing.my_pubkey, channel_id: existing.my_channel_id }
      const kp = generateKeypair(); const myChannelId = randomUUID()
      channelStore.create({ id: rowId, seekId: ctx.seekId, myPrivkey: kp.privateKey, myPubkey: kp.publicKey, myChannelId, degree: ctx.degree, relayVia: ctx.relayVia ?? null, peerAgentId: ctx.peerAgentId ?? null })
      return { pubkey: kp.publicKey, channel_id: myChannelId }
    },
    finalize(rowId, peerHandle) { channelStore.setPeerHandle(rowId, peerHandle) },
  }
  ```
- Pass `channel` into `makeRevealer` (drop `selfIdentity`).
- **`postPeerReveal` must carry THIS side's handle** so the peer can `finalize` it — reconstruct the channel row id and read its handle. **rowId rule (I2 — must match `openLocal`'s keying in `revealEcho`/`revealPledge`/relay EXACTLY, or the channel silently never opens and no letter can ever send):**
  ```ts
  // Direct echo / pledge → `${intentId}:${agentId}`; relay echo → `${intentId}:${agentId}:${relayToken}`.
  const rowId = relayToken ? `${intentId}:${agentId}:${relayToken}` : `${intentId}:${agentId}`
  const ch = channelStore.get(rowId)
  const myHandle = ch ? { pubkey: ch.my_pubkey, channel_id: ch.my_channel_id } : undefined
  const r = await a2aClient.send({ url: revealUrl(hand.url), bearer: hand.outbound_api_key,
    body: { agent_id: SOCIAL_SELF_ID, intent_id: intentId, ...(relayToken ? { relay_token: relayToken } : {}), ...(myHandle ? { peer_handle: myHandle } : {}) } })
  if (!r.ok) return null
  return r.response as { mutual: boolean; handle?: PenpalHandle }
  ```
  > This rowId formula is the SAME string `openLocal` was called with inside `revealEcho` (`echoId` = `${intent}:${peerAgentId}` for a direct echo; `${intent}:${relayVia}:${relayToken}` for a relay echo) and `revealPledge` (`pledgeId` = `${intent}:${seekerAgentId}`). `postPeerReveal`'s `agentId` argument IS `echo.relay_via ?? echo.peer_agent_id` (echoes) or `pledge.seeker_agent_id` — i.e. the POST target, which for a relay echo equals `relay_via`. So `${intentId}:${agentId}:${relayToken}` reconstructs the relay echo id exactly. This formula MUST stay in lockstep with `social-reveal.ts` `onInboundReveal`'s `rowId` (`~:81`), which is identical. A mismatch silently means `channelStore.get(rowId)` misses, `myHandle` is `undefined`, the peer never finalizes, and no letter can ever send — Task 12's e2e asserts both channels open with non-null `peer_pubkey`/`peer_channel_id` precisely to catch this.
- Rebuild `makeRelayReconciler` deps: drop `identityOf`; `completeUpstream`/`completeDownstream` post `peer_handle` (the crossed handle) via `postReveal`; `notify3way` → content-free "🎉 你把两位笔友牵上线了" (NO names). `postReveal`'s body gains an optional `peer_handle`.
- `socialOnReveal`: pass `peerHandle: ev.peer_handle` into both `relayReconciler.onRelayReveal({ ..., peerHandle: ev.peer_handle })` and `revealer.onInboundReveal({ ..., peerHandle: ev.peer_handle })`. **DELETE the old direct name-swap block** (`if (result.mutual && !ev.relay_token && !ev.peer_name) { … echoStore.setRevealedIdentity … }` at `~:222`) — that was the last real-identity-crossing path; the channel is finalized inside the revealer's `channel.finalize` now.
- Fix the `notify` `connected` beat: drop the name → `'🤝 你俩接上头了~ 可以写信了'`.
- `selfIdentity()` helper + its `PeerIdentity` import: remove.
- `src/cli/social.ts`: if it imports `PeerIdentity` from `social-reveal`, drop it (the CLI reveal fallback at `~:83` uses the outcome `state`, not identity — verify it needs no other change).

**Step 4 — Run-pass + GREEN CHECKPOINT.** Run, in order:
- `bun run typecheck` → **CLEAN** (all `PeerIdentity`/`selfIdentity`/`identityOf` references gone). This is the checkpoint's headline gate.
- `bun run test src/daemon/bootstrap.test.ts src/core/social-reveal.test.ts src/core/social-relay-reveal.test.ts src/core/social-m1.e2e.test.ts src/core/social-relay-store.test.ts` → **all green**.
- `bun run depcheck` → **green**.

**Gates:** typecheck **green (checkpoint)**; all social suites **green**; depcheck **green**. If any is red, STOP — the checkpoint is the contract.

**Step 5 — Commit.** `git commit -am "feat(penpal): wire reveal repoint — reveal crosses pubkeys, all social e2e green (A3 checkpoint)"`

- [ ] Task 6 complete — **tree GREEN, reveal fully repointed, letters not built yet**

---

# A4 — E2E letter round-trip (direct peer)

## Task 7: `a2a-server` `POST /a2a/letter` + `onLetter` + `letterUrl()`

**Files:**
- Modify: `src/core/a2a-server.ts` (add `LetterEvent`, `onLetter` opt, the `/a2a/letter` route + agent-card advertisement)
- Modify: `src/core/a2a-server.test.ts`
- Modify: `src/core/a2a-delegate.ts` + `src/core/a2a-delegate.test.ts` (`letterUrl()`)

**Interfaces:**
- Produces:
  - `LetterEvent = { agent_id: string; channel_id: string; nonce: string; ct: string; tag: string }` — inbound intake; `agent_id` is the verified Bearer id (routing metadata only). No plaintext ever.
  - `A2AServerOpts.onLetter?: (event: LetterEvent) => Promise<{ ok: boolean; error?: string }>` — gated + advertised in the card only when wired (mirror `onReveal`).
  - `letterUrl(agentUrl)` in `a2a-delegate.ts` (mirror `revealUrl` exactly — tolerate `/a2a`, `/a2a/notify`, `/a2a/exec`, `/a2a/intent`, `/a2a/reveal`, or already `/a2a/letter`).

**Step 1 — Failing tests.** In `a2a-delegate.test.ts` add `letterUrl` cases (mirror the `revealUrl` block). In `a2a-server.test.ts` add `describe('POST /a2a/letter')`: wired + valid Bearer + `{ agent_id, channel_id, nonce, ct, tag }` → `onLetter` invoked with the verified `agent.id` + fields → `{ ok: true }` 200; not wired → 501 `letter_not_supported`; missing/blank `channel_id`/`nonce`/`ct`/`tag` → 400 `invalid_body`; bad Bearer → 401. (Mirror `/a2a/reveal` tiering.)

**Step 2 — Run-fail.** `bun run test src/core/a2a-server.test.ts src/core/a2a-delegate.test.ts` → red.

**Step 3 — Minimal impl.** Add `letterUrl` to `a2a-delegate.ts` (copy `revealUrl`, s/reveal/letter/). In `a2a-server.ts`: add `LetterEvent` + `onLetter?` opt + card block (`...(opts.onLetter ? [{ name: 'letter', endpoint: '/a2a/letter', method: 'POST', request_schema: { agent_id: 'string', channel_id: 'string', nonce: 'string', ct: 'string', tag: 'string' } }] : [])`); add the `/a2a/letter` route after `/a2a/reveal`, copying its body-parse → auth (`verifyBearer`) → dispatch → error shape; validate `channel_id`/`nonce`/`ct`/`tag` non-empty strings → else 400; call `opts.onLetter({ agent_id: agent.id, channel_id, nonce, ct, tag })`; return its `{ ok }` at 200; 500 `letter_failed` on throw.

**Step 4 — Run-pass.** `bun run test src/core/a2a-server.test.ts src/core/a2a-delegate.test.ts` → green.

**Gates:** test **green**; `bun run typecheck` **green** (additive opt, no removals — the tree is clean since Task 6); depcheck **green**.

**Step 5 — Commit.** `git commit -am "feat(penpal): a2a-server /a2a/letter inbound route + letterUrl (ciphertext-only)"`

- [ ] Task 7 complete

## Task 8: `penpal-correspondent.ts` — seal outbound / open + persist inbound

**Files:**
- Create: `src/core/penpal-correspondent.ts` + `src/core/penpal-correspondent.test.ts`

**Interfaces:**
- Consumes: `ChannelStore`, `LetterStore`, `deriveSharedKey` / `sealLetter` / `openLetter` from `penpal-crypto`, `randomUUID`.
- Produces:
  ```ts
  export interface CorrespondentDeps {
    channelStore: ChannelStore
    letterStore: LetterStore
    /** Outbound: POST the sealed letter to the peer over a2a. relayVia routes a
     *  2-hop channel through the intermediary (Task 9). channel_id = the PEER's
     *  inbound address. Returns ok. */
    postLetter(target: { agentId: string; relayVia: string | null }, body: { channel_id: string; nonce: string; ct: string; tag: string }): Promise<boolean>
    /** Owner notification on an inbound letter (preview of the decrypted text). */
    notifyInbound(channelRowId: string, preview: string): void
  }
  export interface Correspondent {
    sendLetter(channelRowId: string, plaintext: string): Promise<{ ok: boolean; error?: string }>
    receiveLetter(event: { channel_id: string; nonce: string; ct: string; tag: string }): { ok: boolean; error?: string }
  }
  export function makeCorrespondent(deps: CorrespondentDeps): Correspondent
  ```

**Step 1 — Failing test.** `src/core/penpal-correspondent.test.ts` composes REAL crypto + REAL stores across two in-memory dbs (A and B). Open a channel on both sides by hand (create + `setPeerHandle` with crossed keypairs). Then:
- `A.sendLetter(rowId, '你好')` → asserts an OUT letter persisted on A with `plaintext:'你好'`; `postLetter` called with `channel_id === B's my_channel_id`; capture the sealed body.
- Feed it into `B.receiveLetter({ channel_id: <B's my_channel_id>, ... })` → B opens to `'你好'`, persists an IN letter, `notifyInbound` fired with a preview.
- Tamper the `ct` → `receiveLetter` → `{ ok: false, error: 'open_failed' }`, persists NOTHING.
- Unknown `channel_id` → `{ ok: false, error: 'unknown_channel' }`.

**Step 2 — Run-fail → Step 3 — impl:**
```ts
sendLetter(channelRowId, plaintext) {
  const ch = deps.channelStore.get(channelRowId)
  if (!ch || ch.status !== 'open' || !ch.peer_pubkey || !ch.peer_channel_id) return Promise.resolve({ ok: false, error: 'channel_not_open' })
  const key = deriveSharedKey(ch.my_privkey, ch.peer_pubkey)
  const sealed = sealLetter(key, plaintext)
  // Relay (degree-2) letters post to the intermediary (relay_via) so the 2-hop
  // path stays content-blind; direct letters post to peer_agent_id.
  const agentId = ch.relay_via ?? ch.peer_agent_id
  if (!agentId) return Promise.resolve({ ok: false, error: 'no_route' })
  deps.letterStore.create({ id: randomUUID(), channelId: channelRowId, direction: 'out', sealedCiphertext: sealed.ct, nonce: sealed.nonce, tag: sealed.tag, plaintext })
  return deps.postLetter({ agentId, relayVia: ch.relay_via }, { channel_id: ch.peer_channel_id, nonce: sealed.nonce, ct: sealed.ct, tag: sealed.tag })
    .then(ok => ok ? { ok: true } : { ok: false, error: 'send_failed' })
}
receiveLetter(ev) {
  const ch = deps.channelStore.getByMyChannelId(ev.channel_id)
  if (!ch || ch.status !== 'open' || !ch.peer_pubkey) return { ok: false, error: 'unknown_channel' }
  try {
    const pt = openLetter(deriveSharedKey(ch.my_privkey, ch.peer_pubkey), { nonce: ev.nonce, ct: ev.ct, tag: ev.tag })
    deps.letterStore.create({ id: randomUUID(), channelId: ch.id, direction: 'in', sealedCiphertext: ev.ct, nonce: ev.nonce, tag: ev.tag, plaintext: pt })
    deps.notifyInbound(ch.id, pt.slice(0, 40))
    return { ok: true }
  } catch { return { ok: false, error: 'open_failed' } }
}
```
(The OUT letter is persisted before the network post; sealing is local so this ordering is safe and keeps a lost post observable.)

**Step 4 — Run-pass.** `bun run test src/core/penpal-correspondent.test.ts` → green.

**Gates:** test **green**; typecheck **green**; depcheck **green** (all core → lib/crypto; correspondent's first importer is Task 11 — if `no-orphans` fires this task, that is expected and clears at Task 11; note it).

**Step 5 — Commit.** `git commit -am "feat(penpal): makeCorrespondent — seal outbound / open+persist inbound letters"`

- [ ] Task 8 complete

---

# A5 — Relay-routed letter (2-hop, content-blind)

## Task 9: intermediary routes ciphertext letters by channel

**Files:**
- Create: `src/core/penpal-relay-letter.ts` + `src/core/penpal-relay-letter.test.ts`
- Modify: `src/core/social-relay-store.ts` + `src/core/social-relay-store.test.ts` (`getByEndpointChannelId`)

**Interfaces:**
- Produces:
  - `RelayStore.getByEndpointChannelId(channelId: string): RelayRow | null` — scans the two stored handle columns (each contains a `channel_id`) to find the relay leg a `channel_id` belongs to.
  - `makeLetterRelay(deps) → { routeLetter(event: LetterEvent): Promise<{ ok, error? }> }` — the intermediary's content-blind letter router. When an inbound `/a2a/letter` arrives at W whose `channel_id` is NOT one of W's own channels (W is not an endpoint for it), W finds the relay leg by `channel_id`, resolves the FAR endpoint's agent id + its `channel_id`, and re-sends the SAME sealed body onward. W never derives a key, never opens — it only moves ciphertext.

> **channel_id → far peer mapping (no extra column):** at reveal-crossing (Task 5) W already persisted `upstream_handle` + `downstream_handle`, each a `PenpalHandle` containing a `channel_id`. So `getByEndpointChannelId(chId)` matches `chId` against the two stored handles; the FAR endpoint is the other leg (its agent id = `upstream_agent_id`/`downstream_agent_id`, its address = the other handle's `channel_id`). W re-posts with `channel_id = <far endpoint's channel_id>`.
> **Forward-budget seam (sub-project C, OUT):** `// TODO(sub-project C): budget.consume(relay_token) gate before re-posting` — leave the comment, do NOT implement.

**Step 1 — Failing test.** Add `getByEndpointChannelId` test to `social-relay-store.test.ts` (create a relay row, set both handles, look up by each handle's channel_id → returns the row; unknown → null). In `penpal-relay-letter.test.ts`: build a relay row on W with both handles stored (S↔W↔Q). `routeLetter({ channel_id: <Q's channel>, nonce, ct, tag })` → asserts W re-posts the **byte-identical** `{ nonce, ct, tag }` to Q's agent addressed to `<Q's channel_id>`, returns `{ ok: true }`; unknown channel → `{ ok: false, error: 'unknown_channel' }`. (Content-blindness is asserted structurally: outbound bytes equal inbound bytes; this module imports no crypto.)

**Step 2 — Run-fail → Step 3 — impl** `getByEndpointChannelId` (scan `upstream_handle`/`downstream_handle`) + `makeLetterRelay.routeLetter` (look up leg, resolve far agent + channel_id, re-post identical sealed body via `deps.postLetter`).

**Step 4 — Run-pass.** `bun run test src/core/penpal-relay-letter.test.ts src/core/social-relay-store.test.ts` → green.

**Gates:** test **green**; typecheck **green**; depcheck **green** (first importer of `penpal-relay-letter` is Task 11 — `no-orphans` may fire this task; expected, clears at Task 11).

**Step 5 — Commit.** `git commit -am "feat(penpal): content-blind 2-hop letter relay (ciphertext passthrough)"`

- [ ] Task 9 complete

---

# A6 — WeChat surface

## Task 10: `回信 <channel> <text>` command + pipeline dispatch seam

**Files:**
- Create: `src/core/penpal-letter-command.ts` + `src/core/penpal-letter-command.test.ts`
- Modify: `src/daemon/wiring/pipeline-deps.ts` (dispatch seam `~:389`) + `src/daemon/wiring/pipeline-deps-social-dispatch.test.ts`
- Modify: `src/daemon/bootstrap/types.ts` (optional `penpal` on the boot object)

**Interfaces:**
- Produces: `parseLetterCommand(text) → { channel: string; text: string } | null` (mirror `reveal-command.ts`). `boot.penpal?: { sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string }> }` (optional on the boot type; the dispatch guards on it; REAL construction is Task 11).

**Step 1 — Failing parser test** (mirror `reveal-command.test.ts`): `回信 c1 你好啊` → `{ channel: 'c1', text: '你好啊' }`; leading `#`; multi-word/newline body preserved; bare `回信` → null; `回信 c1` (no body) → null; non-command → null.

**Step 2 — Run-fail → Step 3 — impl:**
```ts
export function parseLetterCommand(text: string): { channel: string; text: string } | null {
  const m = text.trim().match(/^回信\s+#?(\S+)\s+([\s\S]+?)\s*$/)
  if (!m) return null
  return { channel: m[1]!, text: m[2]! }
}
```
**Step 4 — Run-pass** parser green.

**Step 5 — Failing dispatch test.** In `pipeline-deps-social-dispatch.test.ts` add (mirror the `揭晓` harness with `fakePenpal = { sendLetter: vi.fn(async () => ({ ok: true })) }` on `boot.penpal`): a `回信 <channel> <text>` from the ADMIN chat calls `boot.penpal.sendLetter(channel, text)` and is NOT dispatched as a normal turn; a `回信` from a NON-admin chat is never consumed; a `回信` whose `sendLetter` returns `{ ok: false }` replies with a gentle "没找到这条笔友通道 / 发送失败".

**Step 6 — Run-fail → Step 7 — impl.** In `pipeline-deps.ts` dispatch (`~:389`), AFTER the `parseRevealCommand` block and BEFORE the normal-turn fallthrough, add a `parseLetterCommand` branch guarded by `boot.penpal && isAdmin(msg.chatId)`; on match `const r = await boot.penpal.sendLetter(cmd.channel, cmd.text)`; on `!r.ok && boot.sendAssistantText` reply the gentle failure; `return`. Add the `parseLetterCommand` import + `penpal?: {...}` to the boot type in `bootstrap/types.ts`.

**Step 8 — Run-pass.** `bun run test src/core/penpal-letter-command.test.ts src/daemon/wiring/pipeline-deps-social-dispatch.test.ts` → green.

**Gates:** test **green**; typecheck **green** (`penpal` is optional on the boot type; dispatch guards on it); depcheck **green**.

**Step 9 — Commit.** `git commit -am "feat(penpal): WeChat 回信 command + dispatch seam"`

- [ ] Task 10 complete

---

# Integration

## Task 11: final wiring — correspondent + `onLetter` + `penpal` on the boot object

**Files:**
- Modify: `src/daemon/bootstrap/wire-social.ts`
- Modify: `src/daemon/bootstrap.test.ts`
- Modify: the a2a-server construction seam (wherever `onReveal` is threaded into `createA2AServer` — mirror it for `onLetter`; verify: `wire-a2a-server`/`index.ts`)

**Interfaces:**
- Consumes: `makeLetterStore` (Task 2), `makeCorrespondent` (Task 8), `makeLetterRelay` (Task 9), `letterUrl` (Task 7), the `channelStore` already built in Task 6.
- Produces: `SocialWiring.social` gains `penpal: { sendLetter }`; the boot object's `penpal` (Task 10 type) is populated from it; the a2a server gets an `onLetter` handler. This is the task that clears the deferred `no-orphans` on `penpal-correspondent` (Task 8) + `penpal-relay-letter` (Task 9).

**Step 1 — Failing wiring test.** In `bootstrap.test.ts`, extend the social wiring assertion (`~:1086`) to also assert `typeof boot.social!.penpal.sendLetter === 'function'` when social is enabled. (Optionally add a full-stack letter round-trip through the real `/a2a/letter` endpoint — but the deterministic version lives in Task 12's e2e, so a shape assertion here is sufficient.)

**Step 2 — Run-fail → Step 3 — impl (`wire-social.ts`):**
- `const letterStore = makeLetterStore(deps.db)`.
- `const postLetter = async (target, body) => { const hand = a2aRegistry.get(target.relayVia ?? target.agentId); if (!hand) return false; const r = await a2aClient.send({ url: letterUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } }); return r.ok }`.
- `const notifyInbound = (rowId, preview) => { const op = resolveOperatorChatId(); if (!op || !sendAssistantText) return; const ch = channelStore.get(rowId); const mask = ch ? \`第 ${ch.degree} 度的某人\` : '某人'; void sendAssistantText(op, \`📬 ${mask}给你写信了:${preview}\\n(回信 ${rowId} <你的话>)\`) }`.
- `const correspondent = makeCorrespondent({ channelStore, letterStore, postLetter, notifyInbound })`.
- `const letterRelay = makeLetterRelay({ relayStore, postLetter })`.
- `const onLetter = async (ev) => { const mine = channelStore.getByMyChannelId(ev.channel_id); return mine ? correspondent.receiveLetter(ev) : letterRelay.routeLetter(ev) }`.
- Thread `onLetter` into `createA2AServer` opts (mirror `onReveal`). Expose `penpal: { sendLetter: (channel, text) => correspondent.sendLetter(channel, text) }` on the returned `social` object; wire it onto `boot.penpal` in the bootstrap assembly.

**Step 4 — Run-pass.** `bun run test src/daemon/bootstrap.test.ts` → green. `bun run typecheck` → **clean**. `bun run depcheck` → green.

**Gates:** test **green**; typecheck **green**; depcheck **green**.

**Step 5 — Commit.** `git commit -am "feat(penpal): wire correspondent + /a2a/letter onLetter + boot.penpal"`

- [ ] Task 11 complete

## Task 12: penpal e2e — direct + relay full round-trip

**Files:**
- Create: `src/core/penpal.e2e.test.ts`

**Interfaces:** Consumes REAL modules end-to-end (crypto + stores + revealer + relay reconciler + correspondent + letter relay), like `social-m1.e2e.test.ts`.

**Step 1 — Failing e2e.**
- **Direct (1-hop):** two in-memory dbs (A seeker, B answerer), each with a `ChannelPort` over its own `makeChannelStore`. Drive: A `revealEcho` (opens A's channel, POSTs A's handle) → B `onInboundReveal({ ..., peerHandle: A_handle })` (B not yet revealed → `{ mutual: false }`, no finalize) → B `revealPledge` (opens B's channel, POSTs B's handle) → A `onInboundReveal({ ..., peerHandle: B_handle })` mutual. **Assert BOTH channels `status:'open'` with non-null `peer_pubkey` AND non-null `peer_channel_id`** (I2 — the rowId-lockstep guard). Assert `peer_masked` unchanged. Then A `sendLetter('你好')` → route the sealed body into B `receiveLetter` → B decrypts `'你好'` + persists IN letter; B `sendLetter('见字如面')` back → A decrypts. **Assert the wire body NEVER contains plaintext** (`ct` !== plaintext; the JSON of the posted body has no `你好`/`见字如面`).
- **Relay (2-hop, content-blind):** three dbs (S, W, Q). Drive the S→W→Q reveal through `makeRelayReconciler` (handles crossed + persisted via W). **Assert S's and Q's channels are `open` with non-null `peer_pubkey`/`peer_channel_id`** (I2). Then S `sendLetter` → the sealed body hits W's `onLetter` → `letterRelay.routeLetter` re-posts **byte-identical** to Q → Q `receiveLetter` decrypts. Assert the routed `ct` bytes are identical in and out (W held no key); W's `notify3way` fired once, content-free.

**Step 2 — Run-fail → Step 3 — wire the test harness** (no product code — everything exists) → **Step 4 — Run-pass** `bun run test src/core/penpal.e2e.test.ts` → green.

**Step 5 — Final gates.** `bun run test src/core src/lib src/daemon` (touched suites), `bun run typecheck`, `bun run depcheck` → all green.

**Gates:** e2e **green**; full typecheck **green**; depcheck **green**.

**Step 6 — Commit.** `git commit -am "test(penpal): e2e — anonymous E2E letters, direct + content-blind 2-hop"`

- [ ] Task 12 complete

---

## Resolved ambiguities (design decisions committed by this plan)

1. **`channel_id` semantics — minted per side.** The brief's `PenpalHandle { pubkey, channel_id }` didn't say whose channel id it is. **Resolution:** `channel_id` = the holder's OWN inbound address. Each side mints `my_channel_id = randomUUID()` at opt-in, crosses `{ my_pubkey, my_channel_id }`, and stores the peer's `{ peer_pubkey, peer_channel_id }` on crossing. Outbound letters are addressed by `peer_channel_id`; inbound by `my_channel_id` (`getByMyChannelId`). Mirrors the pubkey exchange 1:1 (fully symmetric, row-driven) and gives a stable, opaque, per-connection address that leaks nothing.

2. **GCM auth tag needs a home the brief's column list omitted.** §4 names `sealed_ciphertext, nonce` on `penpal_letter`. GCM cannot open without the tag. **Resolution:** add a `tag` column (base64url). `sealed_ciphertext` = base64url `ct`. On the wire, a letter is `{ channel_id, nonce, ct, tag }` — ciphertext + nonce + tag, no plaintext. `penpal_letter.plaintext` holds the locally-decrypted text for the owner's thread; it never goes on the wire (spec §5: "store plaintext locally for the owner; store only ciphertext on the wire").

3. **The intermediary must PERSIST endpoint handles (registry lookup is impossible for ephemeral pubkeys).** The old relay reconciler resolved both identities from W's registry at the crossing instant. Pubkeys are endpoint-generated + ephemeral, so W can't look them up. **Resolution:** v22 adds two nullable columns to `social_relay` (`upstream_handle`, `downstream_handle`, each a `JSON.stringify(PenpalHandle)`); the reconciler persists each leg's presented handle on the marking path and hands the opposite stored handle to the second revealer. `identityOf` is removed from the reconciler deps — the concrete "no second identity-crossing path alive" guarantee (LOCKED §3). W sees pubkeys (public handles), never real identity, and never letter plaintext.

4. **`PeerIdentity` is fully retired from the reveal path.** `selfIdentity()` → a per-connection `ChannelPort.openLocal(rowId)` returning `PenpalHandle`; `identity?` fields → `handle?`; `RevealEvent.peer_name` → `RevealEvent.peer_handle`; the wire-social direct name-swap block is deleted (Task 6). `peer_masked` (`第 N 度的某人`) is never overwritten — anonymity is permanent by design (spec §1/§3); "认识" happens off-system inside the letters. `EchoStore.setRevealedIdentity` + its column survive as deliberately-retained dead code (M3) for a later cleanup.

5. **`/a2a/letter` (A2A-server route), not `/v1/a2a/letter` (internal-api).** The brief's §5 wrote `POST /v1/a2a/letter`, but the inbound peer intake belongs on the A2A server (Bearer-auth'd, capability-gated, tiered like `/a2a/reveal`), exactly where `/a2a/reveal` lives — not the dashboard internal-api. The v0 owner surface is WeChat-only (`回信`), so no `/v1/social/...` letter route is added. (A deferred desktop letter UI would add a `/v1/social/letters` READ route then.)

6. **Letter-relay channel→peer mapping reuses the persisted handles.** No extra column: W indexes the far peer by scanning the stored `upstream_handle`/`downstream_handle` (`getByEndpointChannelId`), since each handle contains its `channel_id`. The sub-project-C forward-budget gate has a single marked seam in `routeLetter` (a `// TODO`, not implemented).

7. **2-hop confidentiality vs. a malicious introducer is a KNOWN v0 limitation (not a bug).** W crosses the endpoints' pubkeys, so a hostile W could key-substitute + MITM. v0 relies on the real-friend gate (§4.5: W is a mutual real friend = trusted-but-honest). Pubkey-binding / transcript hardening is v1+ (record in spec §11 deferred). Direct 1-hop has no such exposure (pubkeys cross over Bearer-authenticated A2A, no middle party).
