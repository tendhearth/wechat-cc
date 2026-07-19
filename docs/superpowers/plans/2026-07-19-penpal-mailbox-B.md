# 内容盲信箱传输 (sub-project B) — Content-Blind Mailbox Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is a TDD unit: failing test → run-fail → minimal impl → run-pass → commit.

**Goal:** Give sub-project A's anonymous pen-pal channel a NAT/offline-tolerant transport for the **post-discovery** legs (reveal-completion + letters). Today letters ride `push` (HTTP POST to a public URL) or `ws` (YiHub) — two NAT-behind home machines can never reach each other. B adds a **content-blind shared mailbox relay** (standalone Bun + SQLite on a VPS): each daemon dials OUT to poll its own mailbox and drops sealed envelopes into a peer's mailbox, bypassing NAT and offline. Every mailbox-transported a2a message to a `transport: mailbox` peer is sealed to that peer's mailbox encryption pubkey with an ephemeral sender key and dropped into the relay — the relay sees only ciphertext + a mailbox address, never plaintext, bearer, or route. After a reveal crosses mailbox addresses, 2-hop letters go **relay-direct** (S seals → drops to Q's mailbox → Q polls); the intermediary W stops forwarding each letter (A's Task-9 W-forwarding demotes to a push-only fallback, but is NOT deleted). **v0 stays inside the spec's §9 boundary: discovery (seek → intent-forward W→Q → synchronous echo) remains push-only — B is NOT full NAT'd-stranger connectivity.** See the **Reachability envelope** below. See `docs/superpowers/specs/2026-07-19-penpal-mailbox-transport-B-design.md` (§3 architecture, §6 seams, §8 phasing, §9 non-goals) and the parent `docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md` (§2 invariants, §4.1 mailbox base).

**Architecture:** Three new pieces + two seams into A/existing code.
1. **Relay server** (`relay/`, standalone Bun entry, deploy to VPS, NOT part of the daemon): content-blind SQLite store `mailbox_item {to, cursor PK AUTOINCREMENT, envelope, expires_at}` behind three routes — `POST /drop` (open; address is the capability; rate-limit + 16 KB size cap + per-`to` depth cap + 7-day TTL), `POST /fetch` (Ed25519-signed ownership proof, returns one page of items since a cursor), `POST /ack` (signed, deletes acked items). The relay NEVER parses `envelope` (stores it as an opaque string).
2. **Mailbox identity + envelope** (`src/core/mailbox-crypto.ts`): per-daemon stable key file in the state dir (0600) holding an **Ed25519** keypair (its pubkey = the mailbox `addr` — used for the drop `to` field AND for fetch/ack signature verification) plus a **separate X25519** keypair (its pubkey = `enc_pub` — the sealed-box target). The envelope is a sealed-box built with an **ephemeral** X25519 sender key per drop (unlinkable) reusing `penpal-crypto` verbatim; inner plaintext = `{path, bearer, body}`.
3. **Client transport** (sender + poller): `makeMailboxSender` seals `{path,bearer,body}` → `POST /drop`; `makeMailboxPoller` (companion-scheduler jittered tick) fetches → opens → replays each `{path,bearer,body}` into the SAME inbound handlers (`onReveal`/`onLetter`) the HTTP routes call → acks. Seams: `A2AAgentRecord` gains `mailbox` transport + `mailbox_addr` + `mailbox_enc_pub` + `relays`; reveal crosses the peer's mailbox address (extend `PenpalHandle`); `postReveal`/`postLetter` in `wire-social.ts` branch to the mailbox sender when the target is a mailbox peer.

**Tech Stack:** TypeScript, Bun runtime, Vitest (`bun run test <path>` — NOT `bun test`). SQLite via `bun:sqlite` (relay) and the daemon's existing `src/lib/db.ts` (append-only migration for the one new pen-pal column). Cryptography: `node:crypto` built-ins ONLY (Ed25519 `sign`/`verify`, X25519 `diffieHellman`, AES-256-GCM, HKDF) — reuses `src/core/penpal-crypto.ts` for the sealed-box. No new npm dependency.

## Global Constraints

### LOCKED design decisions (copied verbatim from the brief + spec — do NOT re-litigate)

1. **Relay server** (standalone Bun + SQLite, deploy to VPS, separate from the daemon): content-blind store `mailbox_item {to TEXT, cursor INTEGER PK AUTOINCREMENT, envelope BLOB, expires_at}`. Endpoints:
   - `POST /drop {to, envelope}` → append, assign cursor, `expires_at = now + TTL(7d)`. OPEN (no auth — address is the capability). Rate-limit per source-IP + per `to`; envelope size cap (16 KB); per-`to` depth cap (drop oldest over N). Returns `{ok}`.
   - `POST /fetch {mailbox, since, ts, sig}` → verify `sig` over `fetch:{mailbox}:{ts}` with the `mailbox` pubkey + `ts` fresh (anti-replay window) → return `{items:[{cursor,envelope}], next_cursor}` (cursor > since, one page).
   - `POST /ack {mailbox, up_to_cursor, ts, sig}` → same sig check → delete `cursor <= up_to_cursor`. TTL sweeps the rest.
   - The relay NEVER parses `envelope`.
2. **Signing-key decision — RESOLVED.** `penpal-crypto` uses X25519, which is ECDH-only and **cannot sign**; the spec's "sign with the mailbox key" is impossible as literally written. Resolution: the **mailbox identity is an Ed25519 keypair** whose pubkey (`addr`) is BOTH the drop `to` field AND the fetch/ack signature-verification key, PLUS a **separate X25519 keypair** whose pubkey (`enc_pub`) is the sealed-box target the daemon publishes to peers. Both live in ONE state-dir key file. `node:crypto` supports Ed25519 detached sign/verify (algorithm `null`) with no new dependency.
3. **Mailbox key(s)**: per-daemon, stable, generated once into the state dir (0600, matching the hand-pairing / `notify-startup` tmp-then-rename idiom). Pubkeys = the mailbox address (`addr`) + encryption pubkey (`enc_pub`) advertised to peers.
4. **Envelope = sealed-box** to the peer's X25519 `enc_pub`, with an **EPHEMERAL** sender keypair per envelope (unlinkable): sender `deriveSharedKey(ephemeral_priv, peer_enc_pub)` + `sealLetter`; wire = `{eph_pub, nonce, ct, tag}` (all base64url); recipient `deriveSharedKey(my_x25519_priv, eph_pub)` + `openLetter`. Inner plaintext (JSON) = `{path, bearer, body}`. Reuse `penpal-crypto` verbatim.
5. **Sender**: `transport: 'mailbox'` branch in `postReveal`/`postLetter` (and any social `a2aClient.send`): seal `{path,bearer,body}` → `POST /drop` to each of the peer's `relays`. Extracted as `makeMailboxSender`.
6. **Poller**: `makeMailboxPoller` on the companion-scheduler pattern (interval 2 min, jitterRatio ~0.3). Each tick: for each configured relay `POST /fetch {my_addr, since_cursor, ts, sig}` → for each envelope `openEnvelope(my_x25519_priv)` → `{path,bearer,body}` → dispatch into the SAME inbound handler (reveal→onReveal, letter→onLetter) → `POST /ack`. Persist cursor per relay. Malformed/undecryptable envelope → silent drop, no crash.
7. **A2AAgentRecord**: add `'mailbox'` to the transport enum + `mailbox_addr` (Ed25519 address) + `mailbox_enc_pub` (X25519 sealing pubkey) + `relays: string[]`.
8. **Reveal crosses mailbox address**: extend the crossed `PenpalHandle` to carry `{addr, enc_pub, relays}`. 1-hop crosses directly; 2-hop W crosses it (W stays content-blind — it JSON-passes the whole handle). After reveal, letters go **relay-direct** to the peer's mailbox.
9. **Relay-direct letters supersede Task-9 for mailbox peers**: `postLetter` — if the target peer has a mailbox, seal+drop to their mailbox; ONLY if push-only (no mailbox) fall through to A's `makeLetterRelay` W-forwarding. Do NOT delete Task-9.

### Scope guard (v0 sub-project B ONLY — explicitly OUT; leave clean seams + a one-line note)

- NO per-connection rotating mailbox addresses (v1 unlinkability) — v0 is one stable per-daemon address.
- NO multi-relay redundancy / cross-relay sync — the client accepts a `relays` list but v0 drops to all + polls all with independent per-relay cursors; no fan-out reconciliation / dedup across relays beyond the app-layer seen-intent dedup.
- NO PoW anti-flood (v1) — v0 leans on "address is the capability" + rate-limit + size/depth/TTL caps.
- NO full seeks/echoes-over-mailbox broadcast optimization — the transport carries any `{path,bearer,body}`, but v0 wires + tests only the two message types with fire-and-forget-friendly handlers (reveal completion, letter). intent/notify over mailbox is a documented one-line seam, not built (their synchronous response-return path is out of scope).
- NO relay payment / allowlist / sealed-sender metadata hardening (v1).
- NO new npm dependency: `node:crypto` + Bun built-ins (`bun:sqlite`, `Bun.serve`) only; `bun run depcheck` MUST stay green.

### Gates — no silent red

- Every task states which gate it must pass: `bun run test <path>` (vitest), `bun run typecheck` (`tsc --noEmit`, whole project incl. `relay/`), `bun run depcheck` (depcruise over `src cli.ts setup.ts docs.ts log-viewer.ts`).
- **depcheck scope note:** `depcheck` does NOT scan `relay/` (not in its roots), so the relay can't regress it — but the relay is still node-builtin-only by construction. depcheck DOES scan `src/**`, so any new `src/core/mailbox-*.ts` must import only existing internal modules + `node:crypto` + `bun:sqlite`, never a new package.
- **typecheck note:** tsconfig `include` is `**/*.ts` + `src/**/*.ts`, so `relay/*.ts` IS typechecked. Keep it strict-clean.
- Do NOT touch `apps/desktop/**` or `main.js` (the Electron app). Do NOT regress A's pen-pal/social suites.
- **A test that legitimately changes (Task 9):** extending `PenpalHandle` with an optional `mailbox` field is additive/backward-compatible, so A's existing assertions stay green. The one legitimately-touched A behavior is `src/core/a2a-server.ts`'s `/a2a/reveal` `peer_handle` extraction (lines ~359-364), which today whitelists only `{pubkey, channel_id}` and would STRIP a crossed mailbox — it is widened to pass an optional `mailbox` through, and `src/core/a2a-server.test.ts` gains one FULL assertion (written in Task 9, not stubbed) that the mailbox survives the reveal round-trip. No existing assertion is deleted or inverted.
- **Transient-red sequencing — checked, NO red window.** Every cross-A type change in this plan is an ADDITIVE OPTIONAL field: Task 5 (`A2AAgentRecord.mailbox_*` optional), Task 9 (`PenpalHandle.mailbox?` optional + `A2AServerOpts.onReveal` handle return widened with an optional `mailbox?` + a NULLABLE `peer_mailbox` column via an additive migration). Widening a return type with an optional field does not break existing `{mutual, handle:{pubkey,channel_id}}` producers; adding `mailbox?` breaks no existing `PenpalHandle` constructor. Unlike A's reveal repoint (which changed a required crossing shape), NOTHING here forces a red window. **Task 9 is split from the behavioral C1 fix precisely to keep checkpoints clean: Task 9 = pure additive plumbing (green), Task 10 = the reveal-crossing enrichment + its regression test (green).** Every task's commit is a green checkpoint (test + typecheck + depcheck all green); the plan contains no `.skip`/red-parking.

### Store idiom

- Relay: `bun:sqlite` `Database` opened in `relay/mailbox-store.ts`; tests use `:memory:`.
- Daemon: the one new pen-pal column is an append-only migration in `src/lib/db.ts` (next index after v22 → **v23**); the cursor store is a state-dir JSON file (0600, tmp-then-rename) — no daemon-db migration for cursors (keeps the transport self-contained; single-threaded per tick).

### Resolved ambiguities

- **Fetch/ack signing (see LOCKED #2):** Ed25519 addr signs; the address IS the verify pubkey.
- **Relay-direct letter authentication:** over HTTP, `/a2a/letter` `verifyBearer`s the sender — but S↔Q are STRANGERS introduced by W and share NO registry credential, which is exactly why A routes their letters through W (S↔W and W↔Q are each paired). Relay-direct removes the hop-bearer and REPLACES it with two crypto layers: the **sealed-box to the recipient's mailbox `enc_pub`** (only the recipient can open the envelope) + A's existing **channel-key E2E** (`correspondent.receiveLetter` authenticates by `getByMyChannelId` + `openLetter` GCM — it already ignores `agent_id` for auth). So the poller's per-path auth is: **reveal envelopes → `registry.verifyBearer(body.agent_id, bearer)`** (reveal-completion legs are W↔endpoint, paired peers sharing a bearer); **letter envelopes → NO registry bearer** (route to `onLetter`, whose channel-key open is the auth). This mirrors, per message type, how each authenticates today.
- **Which reveals go over mailbox:** the 1-hop DIRECT reveal (`postPeerReveal`, needs a synchronous `{mutual,handle}` reply) is between already-registered peers with URLs → stays `push` (no drop-back reply channel needed). The **2-hop relay-reveal COMPLETION** (`postReveal`, fire-and-forget from W to a NAT-behind endpoint) is one-way and maps cleanly onto a mailbox drop the endpoint's poller replays into `onReveal`. v0 assumes W is reachable (it is the introducer with presence); a fully-NAT-behind W is out of scope.
- **`envelope` opacity:** the client serializes the `Envelope` object to a JSON string; the relay stores that string as an opaque BLOB and never `JSON.parse`s it. The 16 KB size cap is on the string's byte length.
- **Mailbox W-forward auth hole — RESOLVED (I1).** Over HTTP, `/a2a/letter` always `verifyBearer`s the sender, so W's `letterRelay.routeLetter` (which has NO crypto auth of its own — it forwards ciphertext by `channel_id`) was gated by that bearer. The mailbox dispatcher drops the registry bearer for letters (correct for the OWN-channel branch, where `correspondent.receiveLetter`'s AES-GCM open IS genuine auth). But an un-bearer'd mailbox drop must NEVER reach `routeLetter`, or anyone who learns W's mailbox address could make W forward junk into its relay legs. **Resolution:** the mailbox letter path uses a dedicated **own-channel-only** handler (`makeMailboxLetterHandler`: `getByMyChannelId` → `receiveLetter`, else DROP) — it never falls through to `routeLetter`. Relay-direct legitimate letters are always own-channel, so this costs nothing; W-forward over the mailbox transport is simply not offered in v0 (W forwards only over its authenticated HTTP `push` leg). This is why the poller consumes `SocialWiring.onMailboxLetter`, NOT the HTTP `onLetter`.

### Reachability envelope (the real v0 boundary — state it honestly, do not overclaim)

> **W must be reachable at all times; S and Q must each be reachable during discovery (seek → intent-forward → echo is push, synchronous); S and Q may be NAT'd / offline for reveal-completion and for letters.** B pierces NAT/offline only for the post-discovery legs (the fire-and-forget reveal-completion drop + relay-direct letters). Discovery stays push-only (spec §9); a fully-NAT'd-during-discovery stranger, or a fully-NAT'd W, is OUT of v0 scope. This is the honest connectivity claim — the plan does NOT deliver end-to-end NAT'd-stranger connectivity.

### Known limitations (honesty notes — carry into the PR description, not silently)

- **M1 (operational precondition):** Task 5 adds the `A2AAgentRecord` mailbox fields to the SCHEMA, but nothing auto-populates them from a pairing/registration flow (out of B's scope). A mailbox peer registered WITHOUT `mailbox_addr` / `mailbox_enc_pub` / `relays` silently degrades to `push` (`peerMailboxOf` → null) → a NAT'd peer's letters fail. Operators must populate all three at pairing; a wiring/CLI populator is a follow-up.
- **M2 (anti-replay + eviction, §10-accepted):** the fetch/ack signature freshness window (±5 min, no per-request jti, and the sig does NOT bind `since`) is harmless under TLS + content-blindness (a replay only re-fetches the caller's own mailbox) but is a known v0 limitation. Separately, the per-`to` depth cap's "drop oldest" means a flooder who leaks a mailbox address evicts UN-POLLED legitimate letters first — accepted in v0 (parent spec §10-11; per-connection addresses + PoW are the v1 mitigations).
- **M3 (letter-receipt idempotency):** the poller acks a page only AFTER dispatching it; if the `ack` HTTP call fails (network), the next tick re-fetches + re-dispatches the same items → `receiveLetter` would create DUPLICATE letter rows + duplicate owner notifications (reveal is idempotent; letters are not). **Fixed in Task 8** by making `receiveLetter` idempotent on `(channel_id, nonce)`: a nonce already stored inbound for that channel is skipped (no row, no notify). Re-delivery is then harmless regardless of ack success.

### Consistency of names across tasks (must match exactly)

```ts
// relay/mailbox-store.ts
export interface MailboxStore {
  drop(to: string, envelope: string, now: number): void
  fetchSince(mailbox: string, since: number, now: number, limit: number): { items: Array<{ cursor: number; envelope: string }>; next_cursor: number }
  ackUpTo(mailbox: string, upToCursor: number): void
  sweep(now: number): number                       // returns rows deleted
}
export function makeMailboxStore(db: import('bun:sqlite').Database, opts?: { ttlMs?: number; depthCap?: number }): MailboxStore

// relay/mailbox-auth.ts
export function verifyFetchSig(mailbox: string, ts: number, sig: string, now: number): boolean   // Ed25519 over `fetch:{mailbox}:{ts}` + ts window
export function verifyAckSig(mailbox: string, upToCursor: number, ts: number, sig: string, now: number): boolean  // over `ack:{mailbox}:{upToCursor}:{ts}`

// relay/rate-limit.ts
export interface RateLimiter { allow(key: string, now: number): boolean }
export function makeRateLimiter(opts: { capacity: number; refillPerSec: number }): RateLimiter

// src/core/mailbox-crypto.ts
export interface Envelope { eph_pub: string; nonce: string; ct: string; tag: string }   // all base64url
export interface EnvelopeInner { path: string; bearer: string; body: unknown }
export interface PeerMailbox { addr: string; enc_pub: string; relays: string[] }
export interface MailboxIdentity { addr: string; enc_pub: string; enc_priv: string; sign(message: string): string }
export function generateMailboxIdentity(): { addr: string; addr_priv: string; enc_pub: string; enc_priv: string }
export function loadMailboxIdentity(stateDir: string): MailboxIdentity   // gen-once, 0600 file, stable
export function sealEnvelope(inner: EnvelopeInner, peerEncPub: string): Envelope
export function openEnvelope(myEncPriv: string, env: Envelope): EnvelopeInner | null   // null on malformed/GCM failure
export function signFetch(sign: (m: string) => string, mailbox: string, ts: number): string
export function signAck(sign: (m: string) => string, mailbox: string, upToCursor: number, ts: number): string

// src/core/mailbox-client.ts
export interface MailboxClient {
  drop(relayUrl: string, to: string, envelope: string): Promise<boolean>
  fetch(relayUrl: string, mailbox: string, since: number, ts: number, sig: string): Promise<{ items: Array<{ cursor: number; envelope: string }>; next_cursor: number } | null>
  ack(relayUrl: string, mailbox: string, upToCursor: number, ts: number, sig: string): Promise<boolean>
}
export function makeMailboxClient(opts?: { timeoutMs?: number }): MailboxClient

// src/core/mailbox-sender.ts
export interface MailboxSender { send(inner: EnvelopeInner, peer: PeerMailbox): Promise<boolean> }
export function makeMailboxSender(deps: { client: MailboxClient }): MailboxSender

// src/core/mailbox-dispatch.ts
export interface EnvelopeDispatch { dispatch(inner: EnvelopeInner): Promise<void> }
export function makeEnvelopeDispatch(deps: {
  registry: import('./a2a-registry').A2ARegistry
  onReveal: import('./a2a-server').A2AServerOpts['onReveal']
  // MUST be an own-channel-ONLY handler (drops non-own-channel) — see makeMailboxLetterHandler
  // and the I1 resolution. NEVER pass the HTTP socialOnLetter (which falls through to routeLetter).
  onLetter: import('./a2a-server').A2AServerOpts['onLetter']
  log: (tag: string, line: string) => void
}): EnvelopeDispatch

// src/daemon/bootstrap/mailbox-letter-handler.ts  (I1 — the own-channel-only mailbox letter guard)
export function makeMailboxLetterHandler(deps: {
  getByMyChannelId: (channelId: string) => { id: string } | null | undefined
  receiveLetter: (ev: { channel_id: string; nonce: string; ct: string; tag: string }) => { ok: boolean; error?: string }
}): import('../../core/a2a-server').A2AServerOpts['onLetter']   // own-channel → receiveLetter; else { ok:false, error:'unknown_channel' } (never routeLetter)

// src/core/mailbox-cursor-store.ts
export interface CursorStore { get(relay: string): number; set(relay: string, cursor: number): void }
export function makeCursorStore(stateDir: string): CursorStore

// src/core/mailbox-poller.ts
export function makeMailboxPoller(deps: {
  identity: MailboxIdentity
  relays: string[]
  client: MailboxClient
  dispatch: EnvelopeDispatch
  cursors: CursorStore
  log: (tag: string, line: string) => void
}): { onTick(): Promise<void> }

// extended cross-A signatures (Tasks 9-11)
export interface PenpalHandle { pubkey: string; channel_id: string; mailbox?: PeerMailbox }   // penpal-crypto.ts — mailbox OPTIONAL
type PostLetterTarget = { agentId: string; relayVia: string | null; mailbox?: PeerMailbox }    // wire-social/correspondent/relay-letter postLetter target

// C1 fix (Task 10) — the crossing handle is enriched AT ITS SOURCE, in wire-social:
//   postPeerReveal + postReveal build myHandle as { pubkey: ch.my_pubkey, channel_id: ch.my_channel_id, ...(myMailbox ? {mailbox: myMailbox} : {}) }
//   where myMailbox = { addr: id.addr, enc_pub: id.enc_pub, relays: config.mailbox_relays } from loadMailboxIdentity(stateDir) — NOT from the channel row.
//   channel.openLocal's return is ALSO enriched (feeds onInboundReveal's synchronous mutual response).
// M3 fix (Task 8) — receiveLetter becomes idempotent on (channel_id, nonce):
export interface LetterStore { /* ...existing... */ hasInbound(channelId: string, nonce: string): boolean }   // added method; receiveLetter no-ops on a repeat
```

### File Structure

- **Create** (relay, standalone): `relay/mailbox-store.ts`, `relay/mailbox-auth.ts`, `relay/rate-limit.ts`, `relay/server.ts`, `relay/README.md` (Task 13 runbook) + `.test.ts` peers.
- **Create** (client): `src/core/mailbox-crypto.ts`, `src/core/mailbox-client.ts`, `src/core/mailbox-sender.ts`, `src/core/mailbox-dispatch.ts`, `src/core/mailbox-cursor-store.ts`, `src/core/mailbox-poller.ts`, `src/daemon/bootstrap/mailbox-dispatch-seam.ts`, `src/daemon/bootstrap/mailbox-letter-handler.ts`, `src/daemon/bootstrap/postletter-route.ts`, `src/daemon/bootstrap/wire-mailbox.ts` + `.test.ts` peers, `src/core/mailbox-e2e.test.ts`.
- **Modify:** `src/lib/agent-config.ts` (A2AAgentRecord + AgentConfig.mailbox_relays), `src/core/penpal-crypto.ts` (extend `PenpalHandle`), `src/lib/db.ts` (v23 migration), `src/core/penpal-channel-store.ts` (`peer_mailbox` column + `setPeerHandle` carries it + `peerMailboxOfRow`), `src/core/penpal-letter-store.ts` (`hasInbound` — M3), `src/core/penpal-correspondent.ts` (idempotent `receiveLetter` + `PostLetterTarget.mailbox`), `src/core/penpal-relay-letter.ts` (`PostLetterTarget.mailbox`), `src/core/a2a-server.ts` (`/a2a/reveal` `peer_handle` mailbox passthrough), `src/daemon/bootstrap/wire-social.ts` (**C1**: enrich the crossing handle in `postPeerReveal`/`postReveal` from `loadMailboxIdentity` — not the row; `openLocal` return enrichment; `postReveal`/`postLetter` mailbox branch; `onMailboxLetter`), `src/daemon/main.ts` (mount the poller lifecycle).

**Task ordering (13 tasks under 7 phase groups):** B1 relay = Tasks 1-3 · B2 keys+envelope = Task 4 · B3 sender+record = Tasks 5-6 · B4 poller = Tasks 7-8 · B5 reveal-crossing+relay-direct = Tasks 9-11 · B6 e2e = Task 12 · B7 deploy runbook = Task 13.

1. relay content-blind SQLite store · 2. relay Ed25519 fetch/ack sig-verify + rate-limit · 3. relay drop/fetch/ack HTTP surface · 4. mailbox-crypto (Ed25519 addr + X25519 enc + ephemeral sealed-box) · 5. `A2AAgentRecord` fields + mailbox HTTP client + `makeMailboxSender` · 6. wire-social `postReveal` mailbox branch · 7. envelope dispatcher (own-channel-only letter contract) · 8. poller + cursor store + `wire-mailbox` + main mount + **M3** idempotent `receiveLetter` + **I1** `makeMailboxLetterHandler` · 9. `PenpalHandle`/`peer_mailbox` column/store/server passthrough (pure additive plumbing — GREEN) · 10. **C1** reveal-crossing enrichment in `postPeerReveal`+`openLocal` + real-reveal regression test (1-hop & 2-hop → `peer_mailbox` on BOTH rows) · 11. relay-direct letters (`postLetter` seal→drop, Task-9 W-forward stays fallback) · 12. e2e (drive a REAL reveal → relay-direct letter; assert mailbox crossed both rows, delivered without touching `routeLetter`, relay content-blind) · 13. deploy runbook.

---

# B1 — Relay server (content-blind store-and-forward)

## Task 1: `relay/mailbox-store.ts` — content-blind SQLite store (drop/fetch/ack/sweep/depth-cap)

**Files:**
- Create: `relay/mailbox-store.ts`
- Create: `relay/mailbox-store.test.ts`

**Interfaces:**
- Consumes: `bun:sqlite` `Database` (Bun built-in, no new dep).
- Produces:
  ```ts
  export interface MailboxStore {
    drop(to: string, envelope: string, now: number): void
    fetchSince(mailbox: string, since: number, now: number, limit: number): { items: Array<{ cursor: number; envelope: string }>; next_cursor: number }
    ackUpTo(mailbox: string, upToCursor: number): void
    sweep(now: number): number
  }
  export function makeMailboxStore(db: Database, opts?: { ttlMs?: number; depthCap?: number }): MailboxStore
  ```
  Table: `mailbox_item (recipient TEXT NOT NULL, cursor INTEGER PRIMARY KEY AUTOINCREMENT, envelope BLOB NOT NULL, expires_at INTEGER NOT NULL)` + `idx_mailbox_item_to ON (recipient, cursor)`. (`recipient`, not the SQL reserved word `to`.) `drop` sets `expires_at = now + ttlMs` (default 7 days) and, after insert, deletes rows for `recipient` beyond the newest `depthCap` (default 256). `fetchSince` returns items with `cursor > since AND expires_at > now`, ordered ascending, capped at `limit`; `next_cursor` = the last returned cursor (or `since` when empty). The store treats `envelope` as opaque bytes — it never parses it.

**Step 1 — Failing test.** Create `relay/mailbox-store.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { Database } from 'bun:sqlite'
import { makeMailboxStore } from './mailbox-store'

const T0 = 1_000_000
function freshStore(opts?: { ttlMs?: number; depthCap?: number }) {
  return makeMailboxStore(new Database(':memory:'), opts)
}

describe('mailbox-store', () => {
  it('drop → fetchSince returns items in cursor order with next_cursor', () => {
    const s = freshStore()
    s.drop('boxA', 'env1', T0); s.drop('boxA', 'env2', T0); s.drop('boxB', 'other', T0)
    const page = s.fetchSince('boxA', 0, T0 + 1, 10)
    expect(page.items.map(i => i.envelope)).toEqual(['env1', 'env2'])
    expect(page.next_cursor).toBe(page.items[1]!.cursor)
    // content-blind: boxB's item is not visible to boxA
    expect(s.fetchSince('boxB', 0, T0 + 1, 10).items.map(i => i.envelope)).toEqual(['other'])
  })

  it('fetchSince(since) is exclusive; a page is capped at limit', () => {
    const s = freshStore()
    for (let i = 0; i < 5; i++) s.drop('boxA', `e${i}`, T0)
    const first = s.fetchSince('boxA', 0, T0 + 1, 2)
    expect(first.items.map(i => i.envelope)).toEqual(['e0', 'e1'])
    const next = s.fetchSince('boxA', first.next_cursor, T0 + 1, 2)
    expect(next.items.map(i => i.envelope)).toEqual(['e2', 'e3'])
  })

  it('ackUpTo deletes items at/below the cursor; leaves the rest', () => {
    const s = freshStore()
    s.drop('boxA', 'e0', T0); s.drop('boxA', 'e1', T0); s.drop('boxA', 'e2', T0)
    const page = s.fetchSince('boxA', 0, T0 + 1, 10)
    s.ackUpTo('boxA', page.items[1]!.cursor)
    expect(s.fetchSince('boxA', 0, T0 + 1, 10).items.map(i => i.envelope)).toEqual(['e2'])
  })

  it('sweep deletes expired items; TTL hides them from fetch even before sweep', () => {
    const s = freshStore({ ttlMs: 100 })
    s.drop('boxA', 'old', T0)
    expect(s.fetchSince('boxA', 0, T0 + 200, 10).items).toEqual([])   // expired → hidden
    expect(s.sweep(T0 + 200)).toBe(1)
    expect(s.sweep(T0 + 200)).toBe(0)
  })

  it('depth cap drops the oldest over N per recipient', () => {
    const s = freshStore({ depthCap: 3 })
    for (let i = 0; i < 5; i++) s.drop('boxA', `e${i}`, T0)
    expect(s.fetchSince('boxA', 0, T0 + 1, 10).items.map(i => i.envelope)).toEqual(['e2', 'e3', 'e4'])
  })
})
```

**Step 2 — Run-fail.** `bun run test relay/mailbox-store.test.ts` → expect `Cannot find module './mailbox-store'`.

**Step 3 — Minimal impl.** Create `relay/mailbox-store.ts`:
```ts
/**
 * mailbox-store.ts — the relay's content-blind store-and-forward table.
 * `envelope` is opaque bytes: the store never parses it. One monotonic cursor
 * per row (SQLite AUTOINCREMENT); fetch is a since-cursor page; ack deletes at
 * or below a cursor; TTL + a per-recipient depth cap bound storage.
 * See docs/superpowers/specs/2026-07-19-penpal-mailbox-transport-B-design.md §3.1.
 */
import type { Database } from 'bun:sqlite'

export interface MailboxStore {
  drop(to: string, envelope: string, now: number): void
  fetchSince(mailbox: string, since: number, now: number, limit: number): { items: Array<{ cursor: number; envelope: string }>; next_cursor: number }
  ackUpTo(mailbox: string, upToCursor: number): void
  sweep(now: number): number
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000   // 7 days
const DEFAULT_DEPTH_CAP = 256

export function makeMailboxStore(db: Database, opts: { ttlMs?: number; depthCap?: number } = {}): MailboxStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const depthCap = opts.depthCap ?? DEFAULT_DEPTH_CAP
  db.run(`CREATE TABLE IF NOT EXISTS mailbox_item (
    recipient TEXT NOT NULL,
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    envelope BLOB NOT NULL,
    expires_at INTEGER NOT NULL
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_mailbox_item_to ON mailbox_item(recipient, cursor)')

  const insert = db.query('INSERT INTO mailbox_item (recipient, envelope, expires_at) VALUES (?, ?, ?)')
  const trim = db.query(`DELETE FROM mailbox_item WHERE recipient = ?1 AND cursor NOT IN
    (SELECT cursor FROM mailbox_item WHERE recipient = ?1 ORDER BY cursor DESC LIMIT ?2)`)
  const selectSince = db.query('SELECT cursor, envelope FROM mailbox_item WHERE recipient = ? AND cursor > ? AND expires_at > ? ORDER BY cursor ASC LIMIT ?')
  const del = db.query('DELETE FROM mailbox_item WHERE recipient = ? AND cursor <= ?')
  const sweepQ = db.query('DELETE FROM mailbox_item WHERE expires_at <= ?')

  return {
    drop(to, envelope, now) {
      insert.run(to, envelope, now + ttlMs)
      trim.run(to, depthCap)
    },
    fetchSince(mailbox, since, now, limit) {
      const rows = selectSince.all(mailbox, since, now, limit) as Array<{ cursor: number; envelope: string }>
      const next_cursor = rows.length > 0 ? rows[rows.length - 1]!.cursor : since
      return { items: rows.map(r => ({ cursor: r.cursor, envelope: String(r.envelope) })), next_cursor }
    },
    ackUpTo(mailbox, upToCursor) { del.run(mailbox, upToCursor) },
    sweep(now) { return sweepQ.run(now).changes },
  }
}
```

**Step 4 — Run-pass.** `bun run test relay/mailbox-store.test.ts` → all green. `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**. `bun run depcheck` → **green** (relay/ is outside depcheck's roots; only `bun:sqlite` used).

**Step 5 — Commit.** `git add -A && git commit -m "feat(relay): content-blind mailbox SQLite store — drop/fetch/ack/sweep/depth-cap"`

- [ ] Task 1 complete

---

## Task 2: `relay/mailbox-auth.ts` + `relay/rate-limit.ts` — Ed25519 fetch/ack sig verify + token-bucket

**Files:**
- Create: `relay/mailbox-auth.ts`, `relay/rate-limit.ts`
- Create: `relay/mailbox-auth.test.ts`, `relay/rate-limit.test.ts`

**Interfaces:**
- Consumes: `node:crypto` (`verify`, `createPublicKey`). The signature format matches Task 4's `signFetch`/`signAck` exactly (Ed25519 detached over the same UTF-8 messages).
- Produces:
  ```ts
  export function verifyFetchSig(mailbox: string, ts: number, sig: string, now: number): boolean
  export function verifyAckSig(mailbox: string, upToCursor: number, ts: number, sig: string, now: number): boolean
  export interface RateLimiter { allow(key: string, now: number): boolean }
  export function makeRateLimiter(opts: { capacity: number; refillPerSec: number }): RateLimiter
  ```
  `mailbox` = the Ed25519 pubkey (spki-DER base64url) = the verify key. Messages: `fetch:{mailbox}:{ts}`, `ack:{mailbox}:{upToCursor}:{ts}`. Freshness window ±5 min (`Math.abs(now - ts) <= 300_000`); malformed pubkey/sig → `false` (never throw). Rate limiter = per-key token bucket (`capacity` tokens, `refillPerSec` refill), keyed by the caller (source-IP and per-`to`) at the server layer.

**Step 1 — Failing test.** Create `relay/mailbox-auth.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto'
import { verifyFetchSig, verifyAckSig } from './mailbox-auth'

// Build a real Ed25519 identity the way mailbox-crypto (Task 4) will.
function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const addr = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  const sign = (m: string) => edSign(null, Buffer.from(m, 'utf8'),
    createPrivateKey({ key: Buffer.from(privDer, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url')
  return { addr, sign }
}

describe('mailbox-auth', () => {
  it('accepts a fresh, correctly-signed fetch and ack', () => {
    const id = identity(); const now = 1_700_000_000_000
    expect(verifyFetchSig(id.addr, now, id.sign(`fetch:${id.addr}:${now}`), now)).toBe(true)
    expect(verifyAckSig(id.addr, 42, now, id.sign(`ack:${id.addr}:42:${now}`), now)).toBe(true)
  })
  it('rejects a wrong signer, a tampered cursor, and a stale ts', () => {
    const id = identity(); const other = identity(); const now = 1_700_000_000_000
    expect(verifyFetchSig(id.addr, now, other.sign(`fetch:${id.addr}:${now}`), now)).toBe(false)   // wrong signer
    expect(verifyAckSig(id.addr, 99, now, id.sign(`ack:${id.addr}:42:${now}`), now)).toBe(false)    // cursor tamper
    expect(verifyFetchSig(id.addr, now, id.sign(`fetch:${id.addr}:${now}`), now + 600_000)).toBe(false) // stale
  })
  it('never throws on garbage pubkey/sig', () => {
    expect(verifyFetchSig('not-a-key', 1, 'nope', 1)).toBe(false)
  })
})
```

**Step 2 — Run-fail.** `bun run test relay/mailbox-auth.test.ts` → expect `Cannot find module './mailbox-auth'`.

**Step 3 — Minimal impl.** Create `relay/mailbox-auth.ts`:
```ts
/**
 * mailbox-auth.ts — the relay's ownership proof for fetch/ack. The mailbox
 * address IS an Ed25519 pubkey; a fetch/ack must carry a detached signature
 * over a fixed message string, proving the caller holds the mailbox private
 * key. A freshness window bounds replay. (X25519 can't sign — hence Ed25519;
 * see the plan's Resolved-ambiguities.) See spec §3.1.
 */
import { verify as edVerify, createPublicKey } from 'node:crypto'

const FRESHNESS_MS = 5 * 60_000

function verifySig(mailbox: string, message: string, sig: string, ts: number, now: number): boolean {
  if (Math.abs(now - ts) > FRESHNESS_MS) return false
  try {
    const pub = createPublicKey({ key: Buffer.from(mailbox, 'base64url'), format: 'der', type: 'spki' })
    return edVerify(null, Buffer.from(message, 'utf8'), pub, Buffer.from(sig, 'base64url'))
  } catch { return false }
}

export function verifyFetchSig(mailbox: string, ts: number, sig: string, now: number): boolean {
  return verifySig(mailbox, `fetch:${mailbox}:${ts}`, sig, ts, now)
}
export function verifyAckSig(mailbox: string, upToCursor: number, ts: number, sig: string, now: number): boolean {
  return verifySig(mailbox, `ack:${mailbox}:${upToCursor}:${ts}`, sig, ts, now)
}
```
Create `relay/rate-limit.ts`:
```ts
/**
 * rate-limit.ts — a per-key token bucket. The relay keys drops by source-IP
 * AND by recipient mailbox; an empty bucket → the drop is refused (429). In
 * memory only (v0 single relay). See spec §3.1 (限流).
 */
export interface RateLimiter { allow(key: string, now: number): boolean }

export function makeRateLimiter(opts: { capacity: number; refillPerSec: number }): RateLimiter {
  const buckets = new Map<string, { tokens: number; ts: number }>()
  return {
    allow(key, now) {
      const b = buckets.get(key) ?? { tokens: opts.capacity, ts: now }
      const refill = ((now - b.ts) / 1000) * opts.refillPerSec
      const tokens = Math.min(opts.capacity, b.tokens + Math.max(0, refill))
      if (tokens < 1) { buckets.set(key, { tokens, ts: now }); return false }
      buckets.set(key, { tokens: tokens - 1, ts: now })
      return true
    },
  }
}
```
Create `relay/rate-limit.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { makeRateLimiter } from './rate-limit'

describe('rate-limit', () => {
  it('allows up to capacity then refuses, and refills over time', () => {
    const rl = makeRateLimiter({ capacity: 2, refillPerSec: 1 })
    expect(rl.allow('ip', 0)).toBe(true)
    expect(rl.allow('ip', 0)).toBe(true)
    expect(rl.allow('ip', 0)).toBe(false)       // bucket empty
    expect(rl.allow('ip', 1000)).toBe(true)      // +1 token after 1s
    expect(rl.allow('other', 0)).toBe(true)      // independent key
  })
})
```

**Step 4 — Run-pass.** `bun run test relay/mailbox-auth.test.ts relay/rate-limit.test.ts` → all green. `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**; depcheck **green** (node:crypto only, relay/ outside roots).

**Step 5 — Commit.** `git add -A && git commit -m "feat(relay): Ed25519 fetch/ack sig verify + per-key token-bucket rate limiter"`

- [ ] Task 2 complete

---

## Task 3: `relay/server.ts` — the drop/fetch/ack HTTP surface (content-blind)

**Files:**
- Create: `relay/server.ts`
- Create: `relay/server.test.ts`

**Interfaces:**
- Consumes: `makeMailboxStore` (Task 1), `verifyFetchSig`/`verifyAckSig` + `makeRateLimiter` (Task 2), `bun:sqlite` `Database`, `Bun.serve`.
- Produces:
  ```ts
  export interface RelayServer { fetchHandler(req: Request, ip: string): Promise<Response>; sweep(now: number): number }
  export function makeRelayServer(opts: { db: Database; now?: () => number; maxEnvelopeBytes?: number; fetchPageLimit?: number; rate?: { capacity: number; refillPerSec: number } }): RelayServer
  export function startRelay(opts?: { port?: number; dbPath?: string }): { stop(): void; port: number }   // Bun.serve entry
  ```
  `fetchHandler(req, ip)` is the pure, testable core (no `Bun.serve` needed) — `startRelay` wraps it in `Bun.serve` and a TTL sweep timer. Routes: `POST /drop {to, envelope}` → 400 on missing/oversize (`> maxEnvelopeBytes`, default 16384) or bad shape, 429 on rate-limit (per-IP AND per-`to`), else `store.drop` + `{ok:true}`. `POST /fetch {mailbox, since, ts, sig}` → 401 on bad sig, else `store.fetchSince(mailbox, since, now, fetchPageLimit=64)`. `POST /ack {mailbox, up_to_cursor, ts, sig}` → 401 on bad sig, else `store.ackUpTo` + `{ok:true}`. The handler NEVER `JSON.parse`s `envelope` — it passes the raw string straight to the store.

**Step 1 — Failing test.** Create `relay/server.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { Database } from 'bun:sqlite'
import { generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto'
import { makeRelayServer } from './server'

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const addr = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  const sign = (m: string) => edSign(null, Buffer.from(m, 'utf8'),
    createPrivateKey({ key: Buffer.from(privDer, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url')
  return { addr, sign }
}
const NOW = 1_700_000_000_000
function post(path: string, body: unknown): Request {
  return new Request(`http://relay${path}`, { method: 'POST', body: JSON.stringify(body) })
}

describe('relay/server', () => {
  it('drop → fetch(signed) → ack round-trip; relay never parses the envelope', async () => {
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW })
    const id = identity()
    // envelope is a deliberately NON-JSON opaque string — proves content-blindness.
    const drop = await srv.fetchHandler(post('/drop', { to: id.addr, envelope: '<<opaque-bytes>>' }), '1.1.1.1')
    expect(drop.status).toBe(200)
    const fReq = post('/fetch', { mailbox: id.addr, since: 0, ts: NOW, sig: id.sign(`fetch:${id.addr}:${NOW}`) })
    const fRes = await srv.fetchHandler(fReq, '1.1.1.1')
    const page = await fRes.json() as { items: Array<{ cursor: number; envelope: string }>; next_cursor: number }
    expect(page.items[0]!.envelope).toBe('<<opaque-bytes>>')
    const aReq = post('/ack', { mailbox: id.addr, up_to_cursor: page.next_cursor, ts: NOW, sig: id.sign(`ack:${id.addr}:${page.next_cursor}:${NOW}`) })
    expect((await srv.fetchHandler(aReq, '1.1.1.1')).status).toBe(200)
    const after = await (await srv.fetchHandler(post('/fetch', { mailbox: id.addr, since: 0, ts: NOW, sig: id.sign(`fetch:${id.addr}:${NOW}`) }), '1.1.1.1')).json() as { items: unknown[] }
    expect(after.items).toEqual([])
  })

  it('fetch/ack with a bad signature → 401', async () => {
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW })
    const id = identity()
    const res = await srv.fetchHandler(post('/fetch', { mailbox: id.addr, since: 0, ts: NOW, sig: 'bad' }), '1.1.1.1')
    expect(res.status).toBe(401)
  })

  it('drop over the size cap → 400; drop is open (no signature required)', async () => {
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW, maxEnvelopeBytes: 8 })
    const res = await srv.fetchHandler(post('/drop', { to: 'boxA', envelope: 'way-too-long-envelope' }), '1.1.1.1')
    expect(res.status).toBe(400)
    expect((await srv.fetchHandler(post('/drop', { to: 'boxA', envelope: 'ok' }), '1.1.1.1')).status).toBe(200)
  })

  it('rate-limit refuses drops over capacity per source-IP → 429', async () => {
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW, rate: { capacity: 1, refillPerSec: 0 } })
    expect((await srv.fetchHandler(post('/drop', { to: 'boxA', envelope: 'a' }), '9.9.9.9')).status).toBe(200)
    expect((await srv.fetchHandler(post('/drop', { to: 'boxA', envelope: 'b' }), '9.9.9.9')).status).toBe(429)
  })
})
```

**Step 2 — Run-fail.** `bun run test relay/server.test.ts` → expect `Cannot find module './server'`.

**Step 3 — Minimal impl.** Create `relay/server.ts`:
```ts
/**
 * server.ts — the content-blind mailbox relay (standalone Bun entry, deploy to
 * a VPS; NOT part of the wechat-cc daemon). Three routes: /drop (open — the
 * address is the capability — rate-limited + size/depth/TTL-capped), /fetch and
 * /ack (Ed25519-signed ownership proof). The relay stores `envelope` as an
 * opaque string and NEVER parses it. See spec §3.1.
 */
import { Database } from 'bun:sqlite'
import { makeMailboxStore } from './mailbox-store'
import { verifyFetchSig, verifyAckSig } from './mailbox-auth'
import { makeRateLimiter } from './rate-limit'

export interface RelayServer { fetchHandler(req: Request, ip: string): Promise<Response>; sweep(now: number): number }

const DEFAULT_MAX_ENVELOPE = 16 * 1024
const DEFAULT_PAGE = 64
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function makeRelayServer(opts: {
  db: Database
  now?: () => number
  maxEnvelopeBytes?: number
  fetchPageLimit?: number
  rate?: { capacity: number; refillPerSec: number }
}): RelayServer {
  const store = makeMailboxStore(opts.db)
  const now = opts.now ?? (() => Date.now())
  const maxEnvelope = opts.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE
  const page = opts.fetchPageLimit ?? DEFAULT_PAGE
  const rl = makeRateLimiter(opts.rate ?? { capacity: 60, refillPerSec: 1 })

  async function body(req: Request): Promise<any | null> { try { return await req.json() } catch { return null } }

  return {
    sweep(t) { return store.sweep(t) },
    async fetchHandler(req, ip) {
      const url = new URL(req.url)
      const t = now()
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

      if (url.pathname === '/drop') {
        const b = await body(req)
        if (!b || typeof b.to !== 'string' || !b.to || typeof b.envelope !== 'string' || !b.envelope) return json({ error: 'invalid_body' }, 400)
        if (Buffer.byteLength(b.envelope, 'utf8') > maxEnvelope) return json({ error: 'too_large' }, 400)
        if (!rl.allow(`ip:${ip}`, t) || !rl.allow(`to:${b.to}`, t)) return json({ error: 'rate_limited' }, 429)
        store.drop(b.to, b.envelope, t)   // opaque — never parsed
        return json({ ok: true })
      }
      if (url.pathname === '/fetch') {
        const b = await body(req)
        if (!b || typeof b.mailbox !== 'string' || typeof b.since !== 'number' || typeof b.ts !== 'number' || typeof b.sig !== 'string') return json({ error: 'invalid_body' }, 400)
        if (!verifyFetchSig(b.mailbox, b.ts, b.sig, t)) return json({ error: 'unauthorized' }, 401)
        return json(store.fetchSince(b.mailbox, b.since, t, page))
      }
      if (url.pathname === '/ack') {
        const b = await body(req)
        if (!b || typeof b.mailbox !== 'string' || typeof b.up_to_cursor !== 'number' || typeof b.ts !== 'number' || typeof b.sig !== 'string') return json({ error: 'invalid_body' }, 400)
        if (!verifyAckSig(b.mailbox, b.up_to_cursor, b.ts, b.sig, t)) return json({ error: 'unauthorized' }, 401)
        store.ackUpTo(b.mailbox, b.up_to_cursor)
        return json({ ok: true })
      }
      return new Response('not found', { status: 404 })
    },
  }
}

/** Bun.serve entry — used by the VPS runbook (Task 13), not by vitest. */
export function startRelay(opts: { port?: number; dbPath?: string } = {}): { stop(): void; port: number } {
  const db = new Database(opts.dbPath ?? 'mailbox.sqlite')
  db.run('PRAGMA journal_mode = WAL')
  const relay = makeRelayServer({ db })
  const server = Bun.serve({
    port: opts.port ?? 8787,
    fetch(req, srv) {
      const ip = srv.requestIP(req)?.address ?? 'unknown'
      return relay.fetchHandler(req, ip)
    },
  })
  const sweepTimer = setInterval(() => relay.sweep(Date.now()), 60 * 60_000)   // hourly TTL sweep
  return { stop() { clearInterval(sweepTimer); server.stop() }, port: server.port }
}

if (import.meta.main) {
  const { port } = startRelay({ port: Number(process.env.RELAY_PORT ?? 8787), dbPath: process.env.RELAY_DB ?? 'mailbox.sqlite' })
  console.log(`[relay] listening on :${port}`)
}
```

**Step 4 — Run-pass.** `bun run test relay/server.test.ts` → all green. `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**; depcheck **green** (relay/ outside roots; `bun:sqlite`/`node:crypto` only).

**Step 5 — Commit.** `git add -A && git commit -m "feat(relay): drop/fetch/ack HTTP surface — open drop + signed fetch/ack, content-blind"`

- [ ] Task 3 complete

---

# B2 — Mailbox identity + envelope (reuse penpal-crypto)

## Task 4: `src/core/mailbox-crypto.ts` — Ed25519 addr + X25519 enc identity + ephemeral sealed-box envelope

**Files:**
- Create: `src/core/mailbox-crypto.ts`
- Create: `src/core/mailbox-crypto.test.ts`

**Interfaces:**
- Consumes: `node:crypto` (`generateKeyPairSync`, `sign`, `createPrivateKey`, `readFileSync`/`writeFileSync` via `node:fs`), and `./penpal-crypto`'s `generateKeypair`, `deriveSharedKey`, `sealLetter`, `openLetter` **verbatim** for the X25519 sealed-box.
- Produces (see Consistency block): `MailboxIdentity`, `Envelope`, `EnvelopeInner`, `PeerMailbox`, `generateMailboxIdentity`, `loadMailboxIdentity`, `sealEnvelope`, `openEnvelope`, `signFetch`, `signAck`.
  - `sealEnvelope(inner, peerEncPub)`: mint an ephemeral X25519 keypair (`generateKeypair()`), `deriveSharedKey(eph_priv, peerEncPub)`, `sealLetter(key, JSON.stringify(inner))` → `{ eph_pub: eph.publicKey, nonce, ct, tag }`. The ephemeral key is unlinkable across drops.
  - `openEnvelope(myEncPriv, env)`: `deriveSharedKey(myEncPriv, env.eph_pub)`, `openLetter` → `JSON.parse` → `EnvelopeInner`; returns `null` on ANY failure (GCM tamper / wrong recipient / bad JSON) — never throws.
  - `loadMailboxIdentity(stateDir)`: read `mailbox-key.json` if present, else generate + write (0600, mkdir 0700, tmp-then-rename per `saveAgentConfig`/`notify-startup`). Stores `{ addr, addr_priv, enc_pub, enc_priv }`. `sign(m)` = Ed25519 detached over the UTF-8 message with `addr_priv`.

**Step 1 — Failing test.** Create `src/core/mailbox-crypto.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verify as edVerify, createPublicKey } from 'node:crypto'
import { generateMailboxIdentity, loadMailboxIdentity, sealEnvelope, openEnvelope, signFetch } from './mailbox-crypto'

describe('mailbox-crypto', () => {
  it('sealEnvelope → openEnvelope round-trips the inner {path,bearer,body}; wrong recipient → null', () => {
    const me = generateMailboxIdentity(); const other = generateMailboxIdentity()
    const inner = { path: '/a2a/letter', bearer: 'tok123', body: { channel_id: 'c', ct: 'x' } }
    const env = sealEnvelope(inner, me.enc_pub)
    expect(env.eph_pub).toBeTruthy(); expect(env.eph_pub).not.toBe(me.enc_pub)   // ephemeral, not the sender's identity
    expect(openEnvelope(me.enc_priv, env)).toEqual(inner)
    expect(openEnvelope(other.enc_priv, env)).toBeNull()                          // not for them
  })

  it('openEnvelope returns null (no throw) on a tampered envelope', () => {
    const me = generateMailboxIdentity()
    const env = sealEnvelope({ path: '/a2a/letter', bearer: 'b', body: 1 }, me.enc_pub)
    expect(openEnvelope(me.enc_priv, { ...env, ct: env.ct.slice(0, -2) + 'AA' })).toBeNull()
  })

  it('two seals of the same inner use different ephemeral keys (unlinkable)', () => {
    const me = generateMailboxIdentity()
    const a = sealEnvelope({ path: '/p', bearer: 'b', body: 0 }, me.enc_pub)
    const b = sealEnvelope({ path: '/p', bearer: 'b', body: 0 }, me.enc_pub)
    expect(a.eph_pub).not.toBe(b.eph_pub)
  })

  it('loadMailboxIdentity is gen-once + stable, and sign() verifies against addr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbx-'))
    const id1 = loadMailboxIdentity(dir); const id2 = loadMailboxIdentity(dir)
    expect(id2.addr).toBe(id1.addr); expect(id2.enc_pub).toBe(id1.enc_pub)   // stable across loads
    const now = 1_700_000_000_000
    const sig = signFetch(id1.sign, id1.addr, now)
    const pub = createPublicKey({ key: Buffer.from(id1.addr, 'base64url'), format: 'der', type: 'spki' })
    expect(edVerify(null, Buffer.from(`fetch:${id1.addr}:${now}`, 'utf8'), pub, Buffer.from(sig, 'base64url'))).toBe(true)
  })
})
```

**Step 2 — Run-fail.** `bun run test src/core/mailbox-crypto.test.ts` → expect `Cannot find module './mailbox-crypto'`.

**Step 3 — Minimal impl.** Create `src/core/mailbox-crypto.ts`:
```ts
/**
 * mailbox-crypto.ts — the per-daemon mailbox identity + the content-blind
 * envelope. Two keys in ONE state-dir file (0600):
 *   - Ed25519 (addr): the mailbox address = the drop `to` field AND the
 *     fetch/ack signature key. (X25519 can't sign — see the plan's
 *     Resolved-ambiguities; this is why the identity is Ed25519.)
 *   - X25519 (enc): the sealed-box target the daemon publishes to peers.
 * The envelope is a sealed-box to the peer's enc pubkey with an EPHEMERAL
 * X25519 sender key per drop (unlinkable), reusing penpal-crypto verbatim.
 * Inner plaintext = {path, bearer, body}. See spec §3.2.
 */
import { generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeypair, deriveSharedKey, sealLetter, openLetter } from './penpal-crypto'

export interface Envelope { eph_pub: string; nonce: string; ct: string; tag: string }
export interface EnvelopeInner { path: string; bearer: string; body: unknown }
export interface PeerMailbox { addr: string; enc_pub: string; relays: string[] }
export interface MailboxIdentity { addr: string; enc_pub: string; enc_priv: string; sign(message: string): string }

const KEY_FILE = 'mailbox-key.json'

export function generateMailboxIdentity(): { addr: string; addr_priv: string; enc_pub: string; enc_priv: string } {
  const ed = generateKeyPairSync('ed25519')
  const x = generateKeypair()   // penpal-crypto's X25519 keypair, base64url DER
  return {
    addr: ed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    addr_priv: ed.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    enc_pub: x.publicKey,
    enc_priv: x.privateKey,
  }
}

function toIdentity(k: { addr: string; addr_priv: string; enc_pub: string; enc_priv: string }): MailboxIdentity {
  const priv = createPrivateKey({ key: Buffer.from(k.addr_priv, 'base64url'), format: 'der', type: 'pkcs8' })
  return {
    addr: k.addr, enc_pub: k.enc_pub, enc_priv: k.enc_priv,
    sign: (message) => edSign(null, Buffer.from(message, 'utf8'), priv).toString('base64url'),
  }
}

export function loadMailboxIdentity(stateDir: string): MailboxIdentity {
  const file = join(stateDir, KEY_FILE)
  try {
    return toIdentity(JSON.parse(readFileSync(file, 'utf8')) as { addr: string; addr_priv: string; enc_pub: string; enc_priv: string })
  } catch {
    const k = generateMailboxIdentity()
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(k, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, file)
    return toIdentity(k)
  }
}

export function sealEnvelope(inner: EnvelopeInner, peerEncPub: string): Envelope {
  const eph = generateKeypair()
  const key = deriveSharedKey(eph.privateKey, peerEncPub)
  const sealed = sealLetter(key, JSON.stringify(inner))
  return { eph_pub: eph.publicKey, nonce: sealed.nonce, ct: sealed.ct, tag: sealed.tag }
}

export function openEnvelope(myEncPriv: string, env: Envelope): EnvelopeInner | null {
  try {
    const key = deriveSharedKey(myEncPriv, env.eph_pub)
    const pt = openLetter(key, { nonce: env.nonce, ct: env.ct, tag: env.tag })
    const inner = JSON.parse(pt) as EnvelopeInner
    if (typeof inner.path !== 'string' || typeof inner.bearer !== 'string') return null
    return inner
  } catch { return null }
}

export function signFetch(sign: (m: string) => string, mailbox: string, ts: number): string {
  return sign(`fetch:${mailbox}:${ts}`)
}
export function signAck(sign: (m: string) => string, mailbox: string, upToCursor: number, ts: number): string {
  return sign(`ack:${mailbox}:${upToCursor}:${ts}`)
}
```

**Step 4 — Run-pass.** `bun run test src/core/mailbox-crypto.test.ts` → all green. `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**; `bun run depcheck` → **green** (imports only `node:crypto`, `node:fs`, `node:path`, `./penpal-crypto` — no new package).

**Step 5 — Commit.** `git add -A && git commit -m "feat(mailbox): per-daemon Ed25519 addr + X25519 enc identity + ephemeral sealed-box envelope"`

- [ ] Task 4 complete

---

# B3 — Mailbox sender + A2AAgentRecord fields

## Task 5: `A2AAgentRecord` mailbox fields + `mailbox-client.ts` + `makeMailboxSender`

**Files:**
- Modify: `src/lib/agent-config.ts`
- Create: `src/core/mailbox-client.ts`, `src/core/mailbox-sender.ts`
- Create: `src/lib/agent-config.mailbox.test.ts`, `src/core/mailbox-client.test.ts`, `src/core/mailbox-sender.test.ts`

**Interfaces:**
- Consumes: `Envelope`/`EnvelopeInner`/`PeerMailbox`/`sealEnvelope` (Task 4); `zod` (already a dep) for the record schema; `fetch` (Bun built-in) for the client.
- Produces:
  - `A2AAgentRecord`: `transport: z.enum(['push', 'ws', 'mailbox'])`; new optional `mailbox_addr: z.string().optional()`, `mailbox_enc_pub: z.string().optional()`, `relays: z.array(z.string().url()).optional()`. `AgentConfig` gains `mailbox_relays?: string[]` (this daemon's OWN relay list, advertised + polled) with a `loadAgentConfig` passthrough mirroring the existing optional fields.
  - `MailboxClient` + `makeMailboxClient` (see Consistency block): pure HTTP, timeout-bounded, mirrors `a2a-client.ts`. `drop`/`ack` return `boolean`; `fetch` returns the page or `null` on any failure.
  - `MailboxSender` + `makeMailboxSender`: `send(inner, peer)` = `sealEnvelope(inner, peer.enc_pub)` → `JSON.stringify` → `client.drop(relay, peer.addr, envelopeStr)` to EACH `peer.relays` (v0: all; success = at least one drop ok). Never throws.

**Step 1 — Failing test.** Create `src/lib/agent-config.mailbox.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { A2AAgentRecord } from './agent-config'

describe('A2AAgentRecord mailbox fields', () => {
  it('accepts transport:mailbox with addr/enc_pub/relays', () => {
    const rec = A2AAgentRecord.parse({
      id: 'peer', name: 'Peer', url: 'http://x/a2a', inbound_api_key: '0123456789abcdef', outbound_api_key: 'k',
      capabilities: [], transport: 'mailbox', mailbox_addr: 'ED', mailbox_enc_pub: 'X', relays: ['https://relay.example/'],
    })
    expect(rec.transport).toBe('mailbox'); expect(rec.mailbox_addr).toBe('ED'); expect(rec.relays).toEqual(['https://relay.example/'])
  })
  it('still accepts a push record with no mailbox fields (backward compatible)', () => {
    const rec = A2AAgentRecord.parse({ id: 'p', name: 'P', url: 'http://x/a2a', inbound_api_key: '0123456789abcdef', outbound_api_key: 'k', capabilities: [] })
    expect(rec.transport).toBe('push'); expect(rec.mailbox_addr).toBeUndefined()
  })
})
```
Create `src/core/mailbox-sender.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { makeMailboxSender } from './mailbox-sender'
import { generateMailboxIdentity, openEnvelope } from './mailbox-crypto'
import type { MailboxClient } from './mailbox-client'

describe('makeMailboxSender', () => {
  it('seals the inner to the peer enc_pub and drops the opaque envelope to each relay', async () => {
    const peer = generateMailboxIdentity()
    const dropped: Array<{ relay: string; to: string; envelope: string }> = []
    const client: MailboxClient = {
      drop: async (relay, to, envelope) => { dropped.push({ relay, to, envelope }); return true },
      fetch: async () => null, ack: async () => true,
    }
    const ok = await makeMailboxSender({ client }).send(
      { path: '/a2a/letter', bearer: 'b', body: { hi: 1 } },
      { addr: peer.addr, enc_pub: peer.enc_pub, relays: ['https://r1/', 'https://r2/'] },
    )
    expect(ok).toBe(true)
    expect(dropped.map(d => d.relay)).toEqual(['https://r1/', 'https://r2/'])
    expect(dropped[0]!.to).toBe(peer.addr)
    // the relay-visible payload is an opaque string; only the peer can open it
    const env = JSON.parse(dropped[0]!.envelope)
    expect(openEnvelope(peer.enc_priv, env)).toEqual({ path: '/a2a/letter', bearer: 'b', body: { hi: 1 } })
  })
  it('returns false when every relay drop fails, and never throws', async () => {
    const peer = generateMailboxIdentity()
    const client: MailboxClient = { drop: async () => false, fetch: async () => null, ack: async () => true }
    expect(await makeMailboxSender({ client }).send({ path: '/p', bearer: 'b', body: 0 }, { addr: peer.addr, enc_pub: peer.enc_pub, relays: ['https://r/'] })).toBe(false)
  })
})
```
Create `src/core/mailbox-client.test.ts` (full body — stubs the global `fetch`):
```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeMailboxClient } from './mailbox-client'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
function stubFetch(impl: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = (vi.fn(async (u: any, i: any) => impl(String(u), i)) as unknown) as typeof fetch
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('makeMailboxClient', () => {
  it('drop posts {to,envelope} to /drop and returns true on 200', async () => {
    const seen: Array<{ url: string; body: any }> = []
    stubFetch((url, init) => { seen.push({ url, body: JSON.parse(String(init.body)) }); return ok({ ok: true }) })
    expect(await makeMailboxClient().drop('https://r/', 'boxA', 'ENV')).toBe(true)
    expect(seen[0]!.url).toBe('https://r/drop'); expect(seen[0]!.body).toEqual({ to: 'boxA', envelope: 'ENV' })
  })
  it('fetch returns the parsed page, and null on a non-200', async () => {
    stubFetch((url) => url.endsWith('/fetch') ? ok({ items: [{ cursor: 3, envelope: 'e' }], next_cursor: 3 }) : ok({}))
    expect(await makeMailboxClient().fetch('https://r/', 'm', 0, 1, 's')).toEqual({ items: [{ cursor: 3, envelope: 'e' }], next_cursor: 3 })
    stubFetch(() => new Response('nope', { status: 401 }))
    expect(await makeMailboxClient().fetch('https://r/', 'm', 0, 1, 's')).toBeNull()
  })
  it('ack posts up_to_cursor to /ack; a network throw → false (never throws)', async () => {
    const seen: any[] = []
    stubFetch((url, init) => { seen.push(JSON.parse(String(init.body))); return ok({ ok: true }) })
    expect(await makeMailboxClient().ack('https://r/', 'm', 7, 2, 'sig')).toBe(true)
    expect(seen[0]).toEqual({ mailbox: 'm', up_to_cursor: 7, ts: 2, sig: 'sig' })
    globalThis.fetch = (vi.fn(async () => { throw new Error('econnrefused') }) as unknown) as typeof fetch
    expect(await makeMailboxClient().ack('https://r/', 'm', 7, 2, 'sig')).toBe(false)
  })
})
```

**Step 2 — Run-fail.** `bun run test src/core/mailbox-sender.test.ts src/lib/agent-config.mailbox.test.ts` → expect module-not-found + a zod parse error on `transport: 'mailbox'`.

**Step 3 — Minimal impl.**
Edit `src/lib/agent-config.ts` — the `A2AAgentRecord` schema:
```ts
export const A2AAgentRecord = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'agent id must match ^[a-z0-9][a-z0-9-]{0,63}$ (lowercase slug)'),
  name: z.string().min(1).max(128),
  url: z.string().url(),
  inbound_api_key: z.string().min(16),
  outbound_api_key: z.string().min(1),
  capabilities: z.array(z.string()),
  paused: z.boolean().default(false),
  transport: z.enum(['push', 'ws', 'mailbox']).default('push'),
  /** Mailbox transport (sub-project B): the peer's Ed25519 mailbox address (drop `to` + sig key). */
  mailbox_addr: z.string().optional(),
  /** The peer's X25519 encryption pubkey — the sealed-box target for envelopes. */
  mailbox_enc_pub: z.string().optional(),
  /** Relay URLs the peer's mailbox is reachable through. */
  relays: z.array(z.string().url()).optional(),
  /** Peer's A2A proto_version captured at install time; unset = unknown (treat as 1). */
  proto_version: z.number().int().optional(),
})
```
Add `mailbox_relays?: string[]` to the `AgentConfig` interface + `AgentConfigSchema` (`mailbox_relays: z.array(z.string().url()).optional()`) and a `loadAgentConfig` passthrough: `...(Array.isArray(parsed.mailbox_relays) ? { mailbox_relays: parsed.mailbox_relays } : {})`.
Create `src/core/mailbox-client.ts`:
```ts
/**
 * mailbox-client.ts — outbound HTTP to a relay (/drop, /fetch, /ack). Pure
 * HTTP, timeout-bounded, no app logic — the mailbox analogue of a2a-client.ts.
 * See spec §3.1.
 */
export interface MailboxClient {
  drop(relayUrl: string, to: string, envelope: string): Promise<boolean>
  fetch(relayUrl: string, mailbox: string, since: number, ts: number, sig: string): Promise<{ items: Array<{ cursor: number; envelope: string }>; next_cursor: number } | null>
  ack(relayUrl: string, mailbox: string, upToCursor: number, ts: number, sig: string): Promise<boolean>
}

const base = (u: string) => u.replace(/\/+$/, '')

export function makeMailboxClient(opts: { timeoutMs?: number } = {}): MailboxClient {
  const timeoutMs = opts.timeoutMs ?? 10_000
  async function post(url: string, body: unknown): Promise<Response | null> {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
    try { return await fetch(url, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
    catch { return null } finally { clearTimeout(t) }
  }
  return {
    async drop(relayUrl, to, envelope) { const r = await post(`${base(relayUrl)}/drop`, { to, envelope }); return !!r?.ok },
    async fetch(relayUrl, mailbox, since, ts, sig) {
      const r = await post(`${base(relayUrl)}/fetch`, { mailbox, since, ts, sig })
      if (!r?.ok) return null
      try { return await r.json() as { items: Array<{ cursor: number; envelope: string }>; next_cursor: number } } catch { return null }
    },
    async ack(relayUrl, mailbox, upToCursor, ts, sig) { const r = await post(`${base(relayUrl)}/ack`, { mailbox, up_to_cursor: upToCursor, ts, sig }); return !!r?.ok },
  }
}
```
Create `src/core/mailbox-sender.ts`:
```ts
/**
 * mailbox-sender.ts — the `transport: mailbox` send path: seal {path,bearer,body}
 * to the peer's enc_pub and drop the opaque envelope into each of the peer's
 * relays. The third dispatch arm alongside push (a2a-client) and ws (YiHub).
 * See spec §3.3 / §6.
 */
import { sealEnvelope, type EnvelopeInner, type PeerMailbox } from './mailbox-crypto'
import type { MailboxClient } from './mailbox-client'

export interface MailboxSender { send(inner: EnvelopeInner, peer: PeerMailbox): Promise<boolean> }

export function makeMailboxSender(deps: { client: MailboxClient }): MailboxSender {
  return {
    async send(inner, peer) {
      const envelope = JSON.stringify(sealEnvelope(inner, peer.enc_pub))
      const results = await Promise.all(peer.relays.map(r => deps.client.drop(r, peer.addr, envelope)))
      return results.some(Boolean)   // v0: success = dropped into at least one relay
    },
  }
}
```

**Step 4 — Run-pass.** `bun run test src/core/mailbox-sender.test.ts src/core/mailbox-client.test.ts src/lib/agent-config.mailbox.test.ts` → all green. `bun run typecheck` → clean. Re-run A's config suite: `bun run test src/lib/agent-config.test.ts` → still green (fields are additive/optional).

**Gates:** test **green**; typecheck **green**; depcheck **green**.

**Step 5 — Commit.** `git add -A && git commit -m "feat(mailbox): A2AAgentRecord mailbox fields + relay HTTP client + makeMailboxSender"`

- [ ] Task 5 complete

---

## Task 6: `wire-social.ts` — `postReveal`/`postLetter` mailbox dispatch branch

**Files:**
- Modify: `src/daemon/bootstrap/wire-social.ts`
- Create: `src/daemon/bootstrap/wire-social.mailbox.test.ts`

**Interfaces:**
- Consumes: `makeMailboxSender` + `MailboxClient` (Task 5), `PeerMailbox` (Task 4), the existing `a2aRegistry` + `a2aClient`.
- Produces (internal to `wireSocial`): a `mailboxSend(hand: A2AAgentRecord, inner: EnvelopeInner) => Promise<boolean>` helper that reads the peer's `{mailbox_addr, mailbox_enc_pub, relays}` off the registry record and dispatches via `makeMailboxSender`; `postReveal` branches to it when `hand.transport === 'mailbox'` (and mailbox fields present), else the existing `a2aClient.send`. **`postLetter`'s peer-mailbox branch is added in Task 11** (it needs the channel-crossed `PeerMailbox`, whose plumbing lands in Task 9 and whose actual crossing lands in Task 10/C1); Task 6 wires only the registry-record path (`postReveal`, and the seam helper `postLetter` will reuse).
  - `peerMailboxOf(hand): PeerMailbox | null` = `hand.transport === 'mailbox' && hand.mailbox_addr && hand.mailbox_enc_pub && hand.relays?.length ? { addr, enc_pub, relays } : null`.

**Step 1 — Failing test.** Create `src/daemon/bootstrap/wire-social.mailbox.test.ts` — test the extracted helper in isolation (the plan extracts `peerMailboxOf` + a `dispatchOrDrop` helper to a small pure module `src/daemon/bootstrap/mailbox-dispatch-seam.ts` so it's unit-testable without booting `wireSocial`):
```ts
import { describe, it, expect } from 'vitest'
import { peerMailboxOf } from './mailbox-dispatch-seam'
import type { A2AAgentRecord } from '../../lib/agent-config'

const base: A2AAgentRecord = { id: 'p', name: 'P', url: 'http://x/a2a', inbound_api_key: '0123456789abcdef', outbound_api_key: 'k', capabilities: [], paused: false, transport: 'push' }

describe('peerMailboxOf', () => {
  it('returns the PeerMailbox for a complete mailbox record', () => {
    expect(peerMailboxOf({ ...base, transport: 'mailbox', mailbox_addr: 'A', mailbox_enc_pub: 'E', relays: ['https://r/'] }))
      .toEqual({ addr: 'A', enc_pub: 'E', relays: ['https://r/'] })
  })
  it('returns null for push, or mailbox with missing fields', () => {
    expect(peerMailboxOf(base)).toBeNull()
    expect(peerMailboxOf({ ...base, transport: 'mailbox', mailbox_addr: 'A' })).toBeNull()
  })
})
```

**Step 2 — Run-fail.** `bun run test src/daemon/bootstrap/wire-social.mailbox.test.ts` → expect `Cannot find module './mailbox-dispatch-seam'`.

**Step 3 — Minimal impl.** Create `src/daemon/bootstrap/mailbox-dispatch-seam.ts`:
```ts
/**
 * mailbox-dispatch-seam.ts — the small pure helpers wire-social uses to decide
 * whether an outbound social a2a call goes over the mailbox transport, and to
 * seal+drop it if so. Extracted so it's unit-testable without booting wireSocial.
 * See spec §3.3 / §6 (the third dispatch arm).
 */
import type { A2AAgentRecord } from '../../lib/agent-config'
import type { PeerMailbox, EnvelopeInner } from '../../core/mailbox-crypto'
import type { MailboxSender } from '../../core/mailbox-sender'

/** The peer's mailbox routing, or null if this peer isn't a (complete) mailbox peer. */
export function peerMailboxOf(hand: A2AAgentRecord): PeerMailbox | null {
  if (hand.transport !== 'mailbox') return null
  if (!hand.mailbox_addr || !hand.mailbox_enc_pub || !hand.relays || hand.relays.length === 0) return null
  return { addr: hand.mailbox_addr, enc_pub: hand.mailbox_enc_pub, relays: hand.relays }
}

/** Seal+drop `inner` to `peer` via the mailbox sender. Returns ok. */
export function dropToMailbox(sender: MailboxSender, peer: PeerMailbox, inner: EnvelopeInner): Promise<boolean> {
  return sender.send(inner, peer)
}
```
Edit `src/daemon/bootstrap/wire-social.ts`: import `makeMailboxSender`, `makeMailboxClient`, `peerMailboxOf`; construct `const mailboxSender = makeMailboxSender({ client: makeMailboxClient() })` once inside the wiring block. In `postReveal`, before the `a2aClient.send`:
```ts
const postReveal = (agentId: string, body: { intent_id: string; relay_token?: string; peer_handle?: PenpalHandle }): void => {
  const hand = a2aRegistry.get(agentId)
  if (!hand) return
  const peer = peerMailboxOf(hand)
  if (peer) {
    void mailboxSender.send({ path: '/a2a/reveal', bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } }, peer)
      .catch(err => deps.log('SOCIAL_REC', `mailbox reveal drop failed intent=${body.intent_id} agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`))
    return
  }
  void a2aClient.send({ url: revealUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } })
    .catch(err => deps.log('SOCIAL_REC', `relay reveal post failed intent=${body.intent_id} agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`))
}
```
(The `postPeerReveal` synchronous 1-hop path is intentionally left on `a2aClient.send` — it needs a `{mutual,handle}` reply, which mailbox drop can't provide; see the plan's Resolved-ambiguities.)

**Step 4 — Run-pass.** `bun run test src/daemon/bootstrap/wire-social.mailbox.test.ts` → green. `bun run typecheck` → clean. Regression: `bun run test src/daemon/bootstrap/` → A's social wiring tests still green (the reveal branch only fires for `transport:'mailbox'` peers, which no existing test constructs).

**Gates:** test **green**; typecheck **green**; depcheck **green**.

**Step 5 — Commit.** `git add -A && git commit -m "feat(mailbox): wire-social postReveal mailbox-transport branch (seal+drop)"`

- [ ] Task 6 complete

---

# B4 — Mailbox poller (fetch → open → replay-dispatch → ack)

## Task 7: `src/core/mailbox-dispatch.ts` — replay a decrypted envelope into the SAME inbound handlers

**Files:**
- Create: `src/core/mailbox-dispatch.ts`
- Create: `src/core/mailbox-dispatch.test.ts`

**Interfaces:**
- Consumes: `EnvelopeInner` (Task 4), `A2ARegistry.verifyBearer` (real signature: `verifyBearer(agentId, bearer): A2AAgentRecord | null`), `A2AServerOpts['onReveal' | 'onLetter']` (the exact handler types the HTTP server calls).
- Produces: `EnvelopeDispatch` + `makeEnvelopeDispatch` (see Consistency block). `dispatch(inner)` routes by `inner.path`:
  - `/a2a/reveal` → require `registry.verifyBearer(body.agent_id, inner.bearer)`; on failure → drop (log + return). On success call `onReveal({ agent_id: verified.id, intent_id, relay_token?, peer_handle? })`; the returned `{mutual,handle}` is discarded (fire-and-forget; the row-driven reveal reconciles either way).
  - `/a2a/letter` → NO registry bearer (S↔Q strangers share none — the sealed-box + channel-key E2E is the auth; see Resolved-ambiguities). Call `onLetter({ agent_id, channel_id, nonce, ct, tag })` directly. **I1 contract:** the `onLetter` passed here MUST be the own-channel-ONLY handler (`makeMailboxLetterHandler`, built + wired in Task 8) — `getByMyChannelId`→`receiveLetter`, else DROP. It must NEVER be the HTTP `socialOnLetter`, which falls through to `letterRelay.routeLetter` (an un-bearer'd mailbox drop must not make W forward junk). The dispatcher enforces shape only; the own-channel guarantee lives in the handler (channelStore isn't a core dispatcher concern). Task 7's test passes an own-channel-only stub to lock the contract.
  - Any other path (intent/notify/…) → v0 no-op with a debug log (documented seam — their synchronous response return-path is out of scope §9). Malformed `body` shape → drop, no throw.

**Step 1 — Failing test.** Create `src/core/mailbox-dispatch.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { makeEnvelopeDispatch } from './mailbox-dispatch'
import type { A2ARegistry } from './a2a-registry'
import type { A2AAgentRecord } from '../lib/agent-config'

const rec = (id: string): A2AAgentRecord => ({ id, name: id, url: 'http://x/a2a', inbound_api_key: 'k', outbound_api_key: 'k', capabilities: [], paused: false, transport: 'push' })
const registry = (verify: (id: string, b: string) => A2AAgentRecord | null): A2ARegistry =>
  ({ verifyBearer: verify, list: () => [], get: () => null, add() {}, remove() {}, setPaused() {}, update: (() => { throw new Error('x') }) as any })
const log = () => {}

describe('makeEnvelopeDispatch', () => {
  it('reveal: verifyBearer(body.agent_id, bearer) then calls onReveal with the verified id', async () => {
    const onReveal = vi.fn(async () => ({ mutual: false }))
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ registry: registry((id, b) => b === 'good' ? rec(id) : null), onReveal, onLetter, log })
    await d.dispatch({ path: '/a2a/reveal', bearer: 'good', body: { agent_id: 'w', intent_id: 'i1', relay_token: 'rt' } })
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'w', intent_id: 'i1', relay_token: 'rt' }))
  })
  it('reveal with a bad bearer is dropped (onReveal not called)', async () => {
    const onReveal = vi.fn(async () => ({ mutual: false }))
    const d = makeEnvelopeDispatch({ registry: registry(() => null), onReveal, onLetter: async () => ({ ok: true }), log })
    await d.dispatch({ path: '/a2a/reveal', bearer: 'bad', body: { agent_id: 'w', intent_id: 'i1' } })
    expect(onReveal).not.toHaveBeenCalled()
  })
  it('letter: calls onLetter WITHOUT a registry bearer check (channel-key auth)', async () => {
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ registry: registry(() => null), onReveal: async () => ({ mutual: false }), onLetter, log })
    await d.dispatch({ path: '/a2a/letter', bearer: 'ignored', body: { agent_id: 's', channel_id: 'c', nonce: 'n', ct: 'x', tag: 't' } })
    expect(onLetter).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'c', ct: 'x' }))
  })
  it('unknown path is a no-op; malformed body never throws', async () => {
    const d = makeEnvelopeDispatch({ registry: registry(() => null), onReveal: async () => ({ mutual: false }), onLetter: async () => ({ ok: true }), log })
    await expect(d.dispatch({ path: '/a2a/intent', bearer: 'b', body: {} })).resolves.toBeUndefined()
    await expect(d.dispatch({ path: '/a2a/letter', bearer: 'b', body: null })).resolves.toBeUndefined()
  })
})
```

**Step 2 — Run-fail.** `bun run test src/core/mailbox-dispatch.test.ts` → expect `Cannot find module './mailbox-dispatch'`.

**Step 3 — Minimal impl.** Create `src/core/mailbox-dispatch.ts`:
```ts
/**
 * mailbox-dispatch.ts — replay a decrypted envelope's {path,bearer,body} into
 * the SAME inbound handlers the HTTP routes call. Per-message auth mirrors the
 * HTTP server: reveal envelopes are verifyBearer-gated (reveal-completion legs
 * are paired W↔endpoint); letter envelopes are NOT (S↔Q strangers — the
 * sealed-box + A's channel-key E2E in onLetter is the auth). Returns discard —
 * mailbox is one-way, the row-driven reveal reconciles. See spec §3.3 / §5.
 */
import type { A2ARegistry } from './a2a-registry'
import type { A2AServerOpts } from './a2a-server'
import type { EnvelopeInner } from './mailbox-crypto'

export interface EnvelopeDispatch { dispatch(inner: EnvelopeInner): Promise<void> }

export function makeEnvelopeDispatch(deps: {
  registry: A2ARegistry
  onReveal: A2AServerOpts['onReveal']
  onLetter: A2AServerOpts['onLetter']
  log: (tag: string, line: string) => void
}): EnvelopeDispatch {
  return {
    async dispatch(inner) {
      const b = inner.body
      if (!b || typeof b !== 'object') return
      const body = b as Record<string, unknown>
      try {
        if (inner.path === '/a2a/reveal') {
          if (typeof body.agent_id !== 'string' || typeof body.intent_id !== 'string' || !body.intent_id) return
          const agent = deps.registry.verifyBearer(body.agent_id, inner.bearer)
          if (!agent) { deps.log('MAILBOX', `reveal drop: bearer rejected for agent_id=${body.agent_id}`); return }
          if (!deps.onReveal) return
          const ph = body.peer_handle as { pubkey?: unknown; channel_id?: unknown; mailbox?: unknown } | undefined
          const peerHandle = (ph && typeof ph.pubkey === 'string' && typeof ph.channel_id === 'string')
            ? { pubkey: ph.pubkey, channel_id: ph.channel_id, ...(ph.mailbox && typeof ph.mailbox === 'object' ? { mailbox: ph.mailbox as any } : {}) } : undefined
          await deps.onReveal({
            agent_id: agent.id, intent_id: body.intent_id,
            ...(typeof body.relay_token === 'string' && body.relay_token ? { relay_token: body.relay_token } : {}),
            ...(peerHandle ? { peer_handle: peerHandle } : {}),
          })
          return
        }
        if (inner.path === '/a2a/letter') {
          if (typeof body.channel_id !== 'string' || typeof body.nonce !== 'string' || typeof body.ct !== 'string' || typeof body.tag !== 'string') return
          if (!deps.onLetter) return
          // No registry bearer: relay-direct letters are stranger↔stranger; the
          // sealed-box (only we could open the envelope) + channel-key E2E open
          // inside onLetter is the authentication. agent_id is routing metadata.
          await deps.onLetter({ agent_id: typeof body.agent_id === 'string' ? body.agent_id : 'mailbox', channel_id: body.channel_id, nonce: body.nonce, ct: body.ct, tag: body.tag })
          return
        }
        deps.log('MAILBOX', `unhandled envelope path=${inner.path} (v0 seam — not wired)`)
      } catch (err) {
        deps.log('MAILBOX', `dispatch failed path=${inner.path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}
```

**Step 4 — Run-pass.** `bun run test src/core/mailbox-dispatch.test.ts` → all green. `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**; depcheck **green**.

**Step 5 — Commit.** `git add -A && git commit -m "feat(mailbox): envelope dispatcher — replay reveal/letter into existing inbound handlers"`

- [ ] Task 7 complete

---

## Task 8: poller + cursor store + `wire-mailbox` + main mount + **M3** idempotent letters + **I1** own-channel letter guard

**Files:**
- Create: `src/core/mailbox-cursor-store.ts`, `src/core/mailbox-poller.ts`, `src/daemon/bootstrap/mailbox-letter-handler.ts`, `src/daemon/bootstrap/wire-mailbox.ts`
- Modify: `src/core/penpal-letter-store.ts` (add `hasInbound` — **M3**), `src/core/penpal-correspondent.ts` (idempotent `receiveLetter` — **M3**), `src/daemon/main.ts` (mount the poller lifecycle)
- Create: `src/core/mailbox-cursor-store.test.ts`, `src/core/mailbox-poller.test.ts`, `src/daemon/bootstrap/mailbox-letter-handler.test.ts`, `src/core/penpal-correspondent.idempotent.test.ts`

**Interfaces:**
- Consumes: `MailboxIdentity`/`Envelope`/`openEnvelope`/`signFetch`/`signAck`/`sealEnvelope` (Task 4), `MailboxClient` (Task 5), `EnvelopeDispatch` (Task 7), `startCompanionScheduler` (`src/daemon/companion/scheduler.ts` — `{ intervalMs, jitterRatio, shouldRun, onTick, log, name }`), `loadMailboxIdentity`, the existing `channelStore`/`correspondent`/`letterStore` from wire-social's social block, the state dir.
- Produces:
  - `CursorStore` + `makeCursorStore(stateDir)`: per-relay cursor in `mailbox-cursors.json` (0600, tmp-then-rename). `get` → 0 if absent.
  - `makeMailboxPoller(deps)` → `{ onTick() }`: for each relay, `client.fetch(relay, identity.addr, cursors.get(relay), ts, signFetch(...))`; for each item `openEnvelope(identity.enc_priv, JSON.parse(item.envelope))` → non-null `await dispatch.dispatch(inner)` (malformed/undecryptable → skip); after the page `client.ack(relay, addr, next_cursor, signAck(...))` + `cursors.set(relay, next_cursor)`. Never throws (per-relay try/catch). **M3 makes re-delivery harmless** (see below), so a page-level ack is safe.
  - **M3:** `LetterStore` gains `hasInbound(channelId, nonce): boolean` (a `SELECT 1 ... WHERE channel_id=? AND nonce=? AND direction='in' LIMIT 1`). `correspondent.receiveLetter` becomes idempotent: after `getByMyChannelId` + before `openLetter`, if `letterStore.hasInbound(ch.id, ev.nonce)` → return `{ ok: true }` WITHOUT creating a row or notifying. (A re-fetched page after an `ack` network failure then no-ops instead of duplicating letter rows + owner pings.)
  - **I1:** `makeMailboxLetterHandler({ getByMyChannelId, receiveLetter })` → the own-channel-ONLY `onLetter` the poller uses: `getByMyChannelId(ev.channel_id)` present → `receiveLetter(ev)`, else `{ ok: false, error: 'unknown_channel' }` — it NEVER calls `routeLetter`. `wire-social` builds `socialOnMailboxLetter = makeMailboxLetterHandler({ getByMyChannelId: channelStore.getByMyChannelId, receiveLetter: correspondent.receiveLetter })` and exposes it on `SocialWiring.onMailboxLetter`.
  - `registerMailboxPoller(deps)`: builds identity (`loadMailboxIdentity(stateDir)`), a `MailboxClient`, the `EnvelopeDispatch` (from `wiring.onReveal` + **`wiring.onMailboxLetter`** + `a2aRegistry`), the poller, and returns a `startCompanionScheduler`-wrapped registrar (interval 120_000 ms, jitterRatio 0.3, `shouldRun`, `onTick = poller.onTick`, name `'mailbox'`). Mounted in `main.ts` next to the companion registrars.

**Step 1 — Failing tests.** Create `src/daemon/bootstrap/mailbox-letter-handler.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMailboxLetterHandler } from './mailbox-letter-handler'

describe('makeMailboxLetterHandler (I1 own-channel guard)', () => {
  it('routes an own-channel letter to receiveLetter', async () => {
    const receiveLetter = vi.fn(() => ({ ok: true }))
    const h = makeMailboxLetterHandler({ getByMyChannelId: (c) => c === 'mine' ? { id: 'r1' } : null, receiveLetter })
    expect(await h!({ agent_id: 'x', channel_id: 'mine', nonce: 'n', ct: 'c', tag: 't' })).toEqual({ ok: true })
    expect(receiveLetter).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'mine', ct: 'c' }))
  })
  it('DROPS a non-own-channel letter — never forwards (routeLetter is unreachable)', async () => {
    const receiveLetter = vi.fn(() => ({ ok: true }))
    const h = makeMailboxLetterHandler({ getByMyChannelId: () => null, receiveLetter })
    expect(await h!({ agent_id: 'attacker', channel_id: 'not-mine', nonce: 'n', ct: 'c', tag: 't' })).toEqual({ ok: false, error: 'unknown_channel' })
    expect(receiveLetter).not.toHaveBeenCalled()
  })
})
```
Create `src/core/penpal-correspondent.idempotent.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { freshTestDb } from '../lib/db'
import { makeChannelStore } from './penpal-channel-store'
import { makeLetterStore } from './penpal-letter-store'
import { makeCorrespondent } from './penpal-correspondent'
import { generateKeypair, deriveSharedKey, sealLetter } from './penpal-crypto'

describe('receiveLetter idempotency (M3)', () => {
  it('a re-delivered letter (same channel_id+nonce) creates no duplicate row and does not re-notify', () => {
    const db = freshTestDb()
    const channelStore = makeChannelStore(db); const letterStore = makeLetterStore(db)
    const me = generateKeypair(); const peer = generateKeypair()
    channelStore.create({ id: 'r1', seekId: 's', myPrivkey: me.privateKey, myPubkey: me.publicKey, myChannelId: 'mc', degree: 0, peerAgentId: 'q' })
    channelStore.setPeerHandle('r1', { pubkey: peer.publicKey, channel_id: 'pc' })
    const sealed = sealLetter(deriveSharedKey(peer.privateKey, me.publicKey), 'hello')
    const notify = vi.fn()
    const c = makeCorrespondent({ channelStore, letterStore, postLetter: async () => true, notifyInbound: notify })
    const ev = { channel_id: 'mc', nonce: sealed.nonce, ct: sealed.ct, tag: sealed.tag }
    expect(c.receiveLetter(ev)).toEqual({ ok: true })
    expect(c.receiveLetter(ev)).toEqual({ ok: true })          // re-delivery
    expect(letterStore.listForChannel('r1').filter(l => l.direction === 'in')).toHaveLength(1)   // no dup
    expect(notify).toHaveBeenCalledTimes(1)                     // no re-notify
  })
})
```
Create `src/core/mailbox-poller.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { makeMailboxPoller } from './mailbox-poller'
import { loadMailboxIdentity, sealEnvelope } from './mailbox-crypto'   // real identity + real seal — no testkit
import { makeCursorStore } from './mailbox-cursor-store'
import type { MailboxClient } from './mailbox-client'

describe('makeMailboxPoller', () => {
  it('fetch → open → dispatch → ack, advancing the per-relay cursor; malformed envelopes are skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbxp-'))
    const me = loadMailboxIdentity(dir)                      // real identity with enc_priv
    const good = JSON.stringify(sealEnvelope({ path: '/a2a/letter', bearer: 'b', body: { channel_id: 'c' } }, me.enc_pub))
    const acked: number[] = []
    const client: MailboxClient = {
      drop: async () => true,
      fetch: async (_r, _m, since) => since === 0
        ? { items: [{ cursor: 1, envelope: 'not-json' }, { cursor: 2, envelope: good }], next_cursor: 2 }
        : { items: [], next_cursor: since },
      ack: async (_r, _m, upTo) => { acked.push(upTo); return true },
    }
    const dispatched: unknown[] = []
    const poller = makeMailboxPoller({
      identity: me, relays: ['https://r/'], client, cursors: makeCursorStore(dir),
      dispatch: { dispatch: async (inner) => { dispatched.push(inner) } }, log: () => {},
    })
    await poller.onTick()
    expect(dispatched).toEqual([{ path: '/a2a/letter', bearer: 'b', body: { channel_id: 'c' } }])   // malformed skipped
    expect(acked).toEqual([2])
    await poller.onTick()                                     // cursor persisted → since=2 → no-op
    expect(acked).toEqual([2])
  })
  it('a relay fetch failure does not throw and does not advance the cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbxp2-'))
    const me = loadMailboxIdentity(dir)
    const client: MailboxClient = { drop: async () => true, fetch: async () => null, ack: async () => true }
    const poller = makeMailboxPoller({ identity: me, relays: ['https://r/'], client, cursors: makeCursorStore(dir), dispatch: { dispatch: async () => {} }, log: () => {} })
    await expect(poller.onTick()).resolves.toBeUndefined()
    expect(makeCursorStore(dir).get('https://r/')).toBe(0)
  })
})
```
(Also add `src/core/mailbox-cursor-store.test.ts`: `set('r', 5)` then a fresh `makeCursorStore(dir).get('r')` → 5; unknown relay → 0; file mode is `0o600`.)

**Step 2 — Run-fail.** `bun run test src/core/mailbox-poller.test.ts src/daemon/bootstrap/mailbox-letter-handler.test.ts src/core/penpal-correspondent.idempotent.test.ts` → expect module-not-found + (for the idempotent test) a duplicate-row failure until `receiveLetter` is guarded.

**Step 3 — Minimal impl.** Create `src/core/mailbox-cursor-store.ts`:
```ts
/**
 * mailbox-cursor-store.ts — per-relay fetch high-water cursor, persisted to a
 * state-dir JSON file (0600, tmp-then-rename). Survives a daemon restart so the
 * poller resumes after the last acked item. See spec §3.3.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface CursorStore { get(relay: string): number; set(relay: string, cursor: number): void }

const FILE = 'mailbox-cursors.json'

export function makeCursorStore(stateDir: string): CursorStore {
  const path = join(stateDir, FILE)
  const read = (): Record<string, number> => { try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, number> } catch { return {} } }
  return {
    get(relay) { return read()[relay] ?? 0 },
    set(relay, cursor) {
      const all = read(); all[relay] = cursor
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, path)
    },
  }
}
```
Create `src/core/mailbox-poller.ts`:
```ts
/**
 * mailbox-poller.ts — one scheduler tick: for each configured relay, fetch our
 * mailbox since the persisted cursor (Ed25519-signed), open each sealed
 * envelope with our X25519 mailbox key, replay {path,bearer,body} into the
 * existing inbound handlers, then ack + persist the cursor. Malformed /
 * undecryptable envelopes are silently skipped (GCM failure = not for us /
 * tampered). Never throws. See spec §3.3 / §5.
 */
import { openEnvelope, signFetch, signAck, type MailboxIdentity, type Envelope } from './mailbox-crypto'
import type { MailboxClient } from './mailbox-client'
import type { EnvelopeDispatch } from './mailbox-dispatch'
import type { CursorStore } from './mailbox-cursor-store'

export function makeMailboxPoller(deps: {
  identity: MailboxIdentity
  relays: string[]
  client: MailboxClient
  dispatch: EnvelopeDispatch
  cursors: CursorStore
  log: (tag: string, line: string) => void
}): { onTick(): Promise<void> } {
  return {
    async onTick() {
      for (const relay of deps.relays) {
        try {
          const ts = Date.now()
          const since = deps.cursors.get(relay)
          const page = await deps.client.fetch(relay, deps.identity.addr, since, ts, signFetch(deps.identity.sign, deps.identity.addr, ts))
          if (!page || page.items.length === 0) continue
          for (const item of page.items) {
            let env: Envelope
            try { env = JSON.parse(item.envelope) as Envelope } catch { continue }   // relay stored an opaque string; skip non-JSON
            const inner = openEnvelope(deps.identity.enc_priv, env)
            if (!inner) continue   // undecryptable = not for us / tampered — silent drop
            await deps.dispatch.dispatch(inner)
          }
          const ackTs = Date.now()
          await deps.client.ack(relay, deps.identity.addr, page.next_cursor, ackTs, signAck(deps.identity.sign, deps.identity.addr, page.next_cursor, ackTs))
          deps.cursors.set(relay, page.next_cursor)
        } catch (err) {
          deps.log('MAILBOX', `poll relay=${relay} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },
  }
}
```
Then the **M3** + **I1** impls:
- Edit `src/core/penpal-letter-store.ts`: add to the `LetterStore` interface `hasInbound(channelId: string, nonce: string): boolean` and implement `return !!db.query("SELECT 1 FROM penpal_letter WHERE channel_id = ? AND nonce = ? AND direction = 'in' LIMIT 1").get(channelId, nonce)`.
- Edit `src/core/penpal-correspondent.ts` `receiveLetter` — guard before opening:
  ```ts
  receiveLetter(ev) {
    const ch = deps.channelStore.getByMyChannelId(ev.channel_id)
    if (!ch || ch.status !== 'open' || !ch.peer_pubkey) return { ok: false, error: 'unknown_channel' }
    if (deps.letterStore.hasInbound(ch.id, ev.nonce)) return { ok: true }   // M3: idempotent re-delivery — no dup row, no re-notify
    try {
      const pt = openLetter(deriveSharedKey(ch.my_privkey, ch.peer_pubkey), { nonce: ev.nonce, ct: ev.ct, tag: ev.tag })
      deps.letterStore.create({ id: randomUUID(), channelId: ch.id, direction: 'in', sealedCiphertext: ev.ct, nonce: ev.nonce, tag: ev.tag, plaintext: pt })
      deps.notifyInbound(ch.id, pt.slice(0, 40))
      return { ok: true }
    } catch { return { ok: false, error: 'open_failed' } }
  }
  ```
Create `src/daemon/bootstrap/mailbox-letter-handler.ts` (**I1**):
```ts
/**
 * mailbox-letter-handler.ts — the OWN-CHANNEL-ONLY letter handler the mailbox
 * poller uses. Unlike the HTTP socialOnLetter, it NEVER falls through to
 * letterRelay.routeLetter: a mailbox drop carries no verified bearer, so it
 * must not be able to make W forward junk into its relay legs. Relay-direct
 * legitimate letters are always own-channel. See the plan's I1 resolution.
 */
import type { A2AServerOpts } from '../../core/a2a-server'

export function makeMailboxLetterHandler(deps: {
  getByMyChannelId: (channelId: string) => { id: string } | null | undefined
  receiveLetter: (ev: { channel_id: string; nonce: string; ct: string; tag: string }) => { ok: boolean; error?: string }
}): A2AServerOpts['onLetter'] {
  return async (ev) => deps.getByMyChannelId(ev.channel_id)
    ? deps.receiveLetter({ channel_id: ev.channel_id, nonce: ev.nonce, ct: ev.ct, tag: ev.tag })
    : { ok: false, error: 'unknown_channel' }
}
```
In `wire-social.ts`, alongside `socialOnLetter`, build the mailbox-safe handler and export it on the wiring:
```ts
const socialOnMailboxLetter = makeMailboxLetterHandler({
  getByMyChannelId: (c) => channelStore.getByMyChannelId(c),
  receiveLetter: (ev) => correspondent.receiveLetter(ev),
})
// ...added to the returned SocialWiring:  onMailboxLetter: socialOnMailboxLetter
```
(Add `onMailboxLetter?: A2AServerOpts['onLetter']` to the `SocialWiring` interface.)
Create `src/daemon/bootstrap/wire-mailbox.ts` — constructs identity + client + dispatch + poller and returns the scheduler registrar (matching `registerCompanionPush` in `src/daemon/companion/lifecycle.ts`):
```ts
/**
 * wire-mailbox.ts — mounts the mailbox poller on the companion-scheduler tick
 * (~2 min jitter). Gated on social_enabled + a configured mailbox_relays list;
 * inert otherwise. New daemon wiring goes here, not index.ts. See spec §3.3.
 */
import { loadMailboxIdentity } from '../../core/mailbox-crypto'
import { makeMailboxClient } from '../../core/mailbox-client'
import { makeEnvelopeDispatch } from '../../core/mailbox-dispatch'
import { makeMailboxPoller } from '../../core/mailbox-poller'
import { makeCursorStore } from '../../core/mailbox-cursor-store'
import { startCompanionScheduler } from '../companion/scheduler'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { A2AServerOpts } from '../../core/a2a-server'

export function registerMailboxPoller(deps: {
  stateDir: string
  a2aRegistry: A2ARegistry
  onReveal: A2AServerOpts['onReveal']
  onMailboxLetter: A2AServerOpts['onLetter']   // I1: MUST be the own-channel-only handler, NOT socialOnLetter
  relays: string[]
  shouldRun: () => boolean
  log: (tag: string, line: string) => void
}): () => Promise<void> {
  const identity = loadMailboxIdentity(deps.stateDir)
  const poller = makeMailboxPoller({
    identity, relays: deps.relays, client: makeMailboxClient(),
    dispatch: makeEnvelopeDispatch({ registry: deps.a2aRegistry, onReveal: deps.onReveal, onLetter: deps.onMailboxLetter, log: deps.log }),
    cursors: makeCursorStore(deps.stateDir), log: deps.log,
  })
  return startCompanionScheduler({
    name: 'mailbox', intervalMs: 120_000, jitterRatio: 0.3,
    shouldRun: deps.shouldRun, onTick: () => poller.onTick(), log: deps.log,
  })
}
```
Edit `src/daemon/main.ts`: alongside the existing `lc.register(registerCompanionPush(...))` block, register the poller when `social_enabled` + `mailbox_relays` are set:
```ts
if (config.social_enabled && (config.mailbox_relays?.length ?? 0) > 0 && wired.mailboxPollerDeps) {
  lc.register(registerMailboxPoller(wired.mailboxPollerDeps))
}
```
(`wired.mailboxPollerDeps` = `{ stateDir, a2aRegistry, onReveal: socialWiring.onReveal, onMailboxLetter: socialWiring.onMailboxLetter!, relays: config.mailbox_relays!, shouldRun: () => reader().social_enabled === true, log }`, assembled in the wiring layer next to the other companion deps.)

**Step 4 — Run-pass.** `bun run test src/core/mailbox-poller.test.ts src/core/mailbox-cursor-store.test.ts src/daemon/bootstrap/mailbox-letter-handler.test.ts src/core/penpal-correspondent.idempotent.test.ts` → all green. `bun run typecheck` → clean. Regression: `bun run test src/core/penpal-correspondent.test.ts` → green (dedup is additive; A's existing tests use unique nonces).

**Gates:** test **green**; typecheck **green**; depcheck **green** (`main.ts`/`bootstrap` import only internal modules). Regression: `bun run test src/daemon/` for the main/bootstrap suites → green (poller registration is gated off unless `mailbox_relays` set).

**Step 5 — Commit.** `git add -A && git commit -m "feat(mailbox): poller + cursor store + scheduler mount; idempotent receiveLetter (M3) + own-channel letter guard (I1)"`

- [ ] Task 8 complete

---

# B5 — Reveal crosses mailbox address + relay-direct letters

## Task 9: additive plumbing — `PenpalHandle.mailbox` + `peer_mailbox` column + a2a-server passthrough (GREEN checkpoint)

> Pure additive/optional plumbing — no behavior yet. Splitting this from the behavioral C1 fix (Task 10) keeps a clean green checkpoint (see Global Constraints → Transient-red sequencing).

**Files:**
- Modify: `src/core/penpal-crypto.ts` (extend `PenpalHandle`), `src/lib/db.ts` (v23 migration), `src/core/penpal-channel-store.ts` (`peer_mailbox` column + `setPeerHandle` carries it + `peerMailboxOfRow`), `src/core/a2a-server.ts` (`/a2a/reveal` `peer_handle` mailbox passthrough + widen `onReveal` handle return type)
- Create: `src/core/penpal-channel-store.mailbox.test.ts`
- Modify (extend, don't invert): `src/core/a2a-server.test.ts`

**Interfaces:**
- Consumes: `PeerMailbox` (Task 4). `PenpalHandle` becomes `{ pubkey: string; channel_id: string; mailbox?: PeerMailbox }` (mailbox OPTIONAL → additive, A stays green). `social-relay-reveal.ts` needs NO change: it crosses the whole `PenpalHandle` as JSON (`upstream_handle`/`downstream_handle`), so the optional `mailbox` rides along automatically — W stays content-blind (spec §3.4).
- Produces:
  - `penpal_channel` gains `peer_mailbox TEXT` (JSON of `PeerMailbox`, nullable). `setPeerHandle(id, handle)` now also writes `peer_mailbox = handle.mailbox ? JSON.stringify(handle.mailbox) : null`. `ChannelRow` gains `peer_mailbox: string | null`; exported `peerMailboxOfRow(row): PeerMailbox | null` parses it (consumed by Task 11's relay-direct letter path).
  - `a2a-server.ts` `/a2a/reveal` `peer_handle` extraction widens to also pass an optional `mailbox` field through to `onReveal` (today it whitelists only pubkey+channel_id and would strip it). `onReveal`'s return `handle?` type widens similarly.

**Step 1 — Failing test.** Create `src/core/penpal-channel-store.mailbox.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { freshTestDb } from '../lib/db'   // the in-memory all-migrations helper
import { makeChannelStore } from './penpal-channel-store'

describe('penpal-channel-store peer_mailbox', () => {
  it('setPeerHandle persists a crossed mailbox and get() returns it', () => {
    const store = makeChannelStore(freshTestDb())
    store.create({ id: 'r1', seekId: 's1', myPrivkey: 'pk', myPubkey: 'pub', myChannelId: 'mc', degree: 1, peerAgentId: 'q' })
    store.setPeerHandle('r1', { pubkey: 'ppub', channel_id: 'pc', mailbox: { addr: 'A', enc_pub: 'E', relays: ['https://r/'] } })
    const row = store.get('r1')!
    expect(row.peer_pubkey).toBe('ppub'); expect(row.status).toBe('open')
    expect(JSON.parse(row.peer_mailbox!)).toEqual({ addr: 'A', enc_pub: 'E', relays: ['https://r/'] })
  })
  it('setPeerHandle with no mailbox leaves peer_mailbox null (push peer)', () => {
    const store = makeChannelStore(freshTestDb())
    store.create({ id: 'r2', seekId: 's', myPrivkey: 'pk', myPubkey: 'pub', myChannelId: 'mc', degree: 0, peerAgentId: 'q' })
    store.setPeerHandle('r2', { pubkey: 'ppub', channel_id: 'pc' })
    expect(store.get('r2')!.peer_mailbox).toBeNull()
  })
})
```
Extend `src/core/a2a-server.test.ts` (ADD a real, self-contained case — NOT a stub):
```ts
it('/a2a/reveal passes a crossed mailbox through peer_handle to onReveal', async () => {
  const agent = { id: 'w', name: 'w', url: 'http://x/a2a', inbound_api_key: 'secret-key-0000000', outbound_api_key: 'k', capabilities: [], paused: false, transport: 'push' as const }
  const registry = { verifyBearer: (id: string, b: string) => (id === 'w' && b === 'secret-key-0000000') ? agent : null } as any
  let seen: any = null
  const server = createA2AServer({
    host: '127.0.0.1', port: 0, registry,
    onNotify: async () => {}, onReveal: async (ev) => { seen = ev; return { mutual: false } },
    daemonInfo: { name: 'test', version: '0' },
  })
  await server.start()
  try {
    const res = await fetch(`${server.baseUrl()}/a2a/reveal`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-key-0000000', 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'w', intent_id: 'i1', peer_handle: { pubkey: 'P', channel_id: 'C', mailbox: { addr: 'A', enc_pub: 'E', relays: ['https://r/'] } } }),
    })
    expect(res.status).toBe(200)
    expect(seen.peer_handle).toEqual({ pubkey: 'P', channel_id: 'C', mailbox: { addr: 'A', enc_pub: 'E', relays: ['https://r/'] } })
  } finally { await server.stop() }
})
```

**Step 2 — Run-fail.** `bun run test src/core/penpal-channel-store.mailbox.test.ts src/core/a2a-server.test.ts` → the channel test fails (`peer_mailbox` column absent); the a2a-server case fails (`seen.peer_handle.mailbox` is `undefined` — today's whitelist strips it).

**Step 3 — Minimal impl.**
- `src/core/penpal-crypto.ts`: `export interface PenpalHandle { pubkey: string; channel_id: string; mailbox?: { addr: string; enc_pub: string; relays: string[] } }` (inline the `PeerMailbox` shape to avoid a cross-module import cycle; it structurally matches `mailbox-crypto`'s `PeerMailbox`).
- `src/lib/db.ts`: append migration **v23**: `ALTER TABLE penpal_channel ADD COLUMN peer_mailbox TEXT` (nullable, no default — additive, safe on existing rows).
- `src/core/penpal-channel-store.ts`: add `peer_mailbox: string | null` to `ChannelRow`; `setPeerHandle` writes `peer_pubkey`, `peer_channel_id`, `status='open'`, AND `peer_mailbox = handle.mailbox ? JSON.stringify(handle.mailbox) : null`; export `export function peerMailboxOfRow(row: ChannelRow): PeerMailbox | null { return row.peer_mailbox ? JSON.parse(row.peer_mailbox) as PeerMailbox : null }`.
- `src/core/a2a-server.ts` (`/a2a/reveal`, ~lines 359-364): widen the `peer_handle` extraction:
  ```ts
  const ph = body.peer_handle
  const peerHandle = (ph && typeof ph === 'object'
    && typeof (ph as any).pubkey === 'string' && (ph as any).pubkey
    && typeof (ph as any).channel_id === 'string' && (ph as any).channel_id)
    ? {
        pubkey: (ph as any).pubkey, channel_id: (ph as any).channel_id,
        ...((ph as any).mailbox && typeof (ph as any).mailbox === 'object'
          && typeof (ph as any).mailbox.addr === 'string' && typeof (ph as any).mailbox.enc_pub === 'string' && Array.isArray((ph as any).mailbox.relays)
          ? { mailbox: { addr: (ph as any).mailbox.addr, enc_pub: (ph as any).mailbox.enc_pub, relays: (ph as any).mailbox.relays } } : {}),
      }
    : undefined
  ```
  and widen `A2AServerOpts.onReveal`'s handle type to `{ pubkey: string; channel_id: string; mailbox?: { addr: string; enc_pub: string; relays: string[] } }`.

**Step 4 — Run-pass.** `bun run test src/core/penpal-channel-store.mailbox.test.ts src/core/a2a-server.test.ts` → all green. `bun run typecheck` → clean. Regression: `bun run test src/core/penpal-channel-store.test.ts src/core/social-relay-reveal.test.ts src/core/social-reveal.test.ts` → green (additive column + optional field; no revealer logic changed yet). Full-schema smoke test (the v-migration smoke test, per MEMORY's v19 note) updated for v23 if it pins the column set.

**Gates:** test **green**; typecheck **green**; depcheck **green**. This is a clean GREEN checkpoint — no behavior wired yet, only additive plumbing.

**Step 5 — Commit.** `git add -A && git commit -m "feat(mailbox): additive plumbing — PenpalHandle.mailbox + peer_mailbox column + a2a-server passthrough"`

- [ ] Task 9 complete

---

## Task 10: **C1** — enrich the crossing handle at its SOURCE (`postPeerReveal`/`postReveal` + `openLocal`) with a real-reveal regression guard

> **This is the C1 fix.** Task 9 added the column + passthrough, but the mailbox address must actually CROSS. The crossing handle is built in TWO places in `wire-social.ts`, and BOTH must be enriched from the daemon's mailbox identity (NOT from the bare channel row, which never held the mailbox):
> 1. `postPeerReveal` / `postReveal` rebuild `myHandle` from `{pubkey: ch.my_pubkey, channel_id: ch.my_channel_id}` — the OUTBOUND crossing handle. `openLocal`'s enriched return is discarded here, so enriching only `openLocal` (the original Task-9 mistake) left `peer_mailbox` null → letters fell to the Task-9 W-forward → push to a NAT'd peer → fail.
> 2. `channel.openLocal`'s RETURN — used by `onInboundReveal` as the synchronous mutual response handle (the reveal-second, 1-hop path).

**Files:**
- Modify: `src/daemon/bootstrap/mailbox-dispatch-seam.ts` (add `buildCrossedHandle`), `src/daemon/bootstrap/wire-social.ts` (load `mailboxIdentity` once; enrich `postPeerReveal`, `postReveal`, and `channel.openLocal`)
- Create: `src/daemon/bootstrap/reveal-crossing.mailbox.test.ts` (the regression guard — drives a REAL reveal on both 1-hop and 2-hop)

**Interfaces:**
- Consumes: `loadMailboxIdentity` (Task 4), `PeerMailbox`/`PenpalHandle`, `makeRevealer` + `makeRelayReconciler` + `makeChannelStore` (A, real).
- Produces:
  ```ts
  // mailbox-dispatch-seam.ts — the single home for building THIS daemon's crossing handle.
  export function buildCrossedHandle(ch: { my_pubkey: string; my_channel_id: string }, myMailbox: PeerMailbox | undefined): PenpalHandle {
    return { pubkey: ch.my_pubkey, channel_id: ch.my_channel_id, ...(myMailbox ? { mailbox: myMailbox } : {}) }
  }
  ```
  `wire-social` computes `const myMailbox = (config.mailbox_relays?.length) ? { addr: mailboxIdentity.addr, enc_pub: mailboxIdentity.enc_pub, relays: config.mailbox_relays } : undefined` (from `loadMailboxIdentity(deps.stateDir)`), and:
  - `postPeerReveal`: `const myHandle = ch ? buildCrossedHandle(ch, myMailbox) : undefined`.
  - `postReveal`: peer_handle it forwards for W's `completeUpstream`/`completeDownstream` is already the endpoint's own crossed handle (enriched at its source above) — no change beyond ensuring W passes it through verbatim (it does: it JSON-round-trips the handle).
  - `channel.openLocal`: both branches return `buildCrossedHandle({ my_pubkey, my_channel_id }, myMailbox)`.

**Step 1 — Failing test.** Create `src/daemon/bootstrap/reveal-crossing.mailbox.test.ts` — a REAL reveal round-trip using `makeRevealer` on two sides (S & Q), plus a 2-hop relay-reconciler assertion:
```ts
import { describe, it, expect, vi } from 'vitest'
import { freshTestDb } from '../../lib/db'
import { makeChannelStore } from '../../core/penpal-channel-store'
import { makeEchoStore } from '../../core/social-echo-store'
import { makePledgeStore } from '../../core/social-pledge-store'
import { makeSeekStore } from '../../core/social-seek-store'
import { makeRelayStore } from '../../core/social-relay-store'
import { makeRevealer } from '../../core/social-reveal'
import { makeRelayReconciler } from '../../core/social-relay-reveal'
import { generateKeypair } from '../../core/penpal-crypto'
import { randomUUID } from 'node:crypto'
import { buildCrossedHandle } from './mailbox-dispatch-seam'

const S_MBX = { addr: 'S_ADDR', enc_pub: 'S_ENC', relays: ['https://rs/'] }
const Q_MBX = { addr: 'Q_ADDR', enc_pub: 'Q_ENC', relays: ['https://rq/'] }

// A channel port over a real store whose openLocal enriches with `myMbx` via buildCrossedHandle.
function port(store: ReturnType<typeof makeChannelStore>, myMbx: typeof S_MBX) {
  return {
    openLocal(rowId: string, ctx: { seekId: string; degree: number; peerAgentId?: string | null; relayVia?: string | null }) {
      const existing = store.get(rowId)
      if (existing) return buildCrossedHandle({ my_pubkey: existing.my_pubkey, my_channel_id: existing.my_channel_id }, myMbx)
      const kp = generateKeypair(); const mcid = randomUUID()
      store.create({ id: rowId, seekId: ctx.seekId, myPrivkey: kp.privateKey, myPubkey: kp.publicKey, myChannelId: mcid, degree: ctx.degree, relayVia: ctx.relayVia ?? null, peerAgentId: ctx.peerAgentId ?? null })
      return buildCrossedHandle({ my_pubkey: kp.publicKey, my_channel_id: mcid }, myMbx)
    },
    finalize(rowId: string, peerHandle: any) { store.setPeerHandle(rowId, peerHandle) },
  }
}

describe('C1 — the mailbox address actually crosses on a real reveal', () => {
  it('1-hop: after mutual reveal, BOTH channel rows carry the peer mailbox', async () => {
    const sDb = freshTestDb(), qDb = freshTestDb()
    const sCh = makeChannelStore(sDb), qCh = makeChannelStore(qDb)
    const intentId = 'i1'

    // Q side: an echo where Q already self-revealed and is waiting for S.
    const qEchoes = makeEchoStore(qDb), qPledges = makePledgeStore(qDb), qSeeks = makeSeekStore(qDb)
    qSeeks.create({ id: intentId, kind: 'seek', topic: 't' })
    qEchoes.create({ id: `${intentId}:s`, seekId: intentId, peerMasked: '某人', degree: 1, content: 'c', peerAgentId: 's', relayVia: null, relayToken: null })
    qEchoes.setSelfRevealed(`${intentId}:s`, new Date().toISOString())
    const qPort = port(qCh, Q_MBX)
    qPort.openLocal(`${intentId}:s`, { seekId: intentId, degree: 1, peerAgentId: 's' })   // Q minted its channel at self-reveal
    const qRevealer = makeRevealer({ echoStore: qEchoes, pledgeStore: qPledges, seekStore: qSeeks, channel: qPort as any, notify: () => {}, postPeerReveal: async () => null })

    // S side: an echo toward Q; S reveals second, posting its enriched handle to Q's inbound.
    const sEchoes = makeEchoStore(sDb), sPledges = makePledgeStore(sDb), sSeeks = makeSeekStore(sDb)
    sSeeks.create({ id: intentId, kind: 'seek', topic: 't' })
    sEchoes.create({ id: `${intentId}:q`, seekId: intentId, peerMasked: '某人', degree: 1, content: 'c', peerAgentId: 'q', relayVia: null, relayToken: null })
    const sPort = port(sCh, S_MBX)
    const sRevealer = makeRevealer({
      echoStore: sEchoes, pledgeStore: sPledges, seekStore: sSeeks, channel: sPort as any, notify: () => {},
      // THE C1 PATH: S's crossing handle is built from S's row + S's mailbox (buildCrossedHandle inside sPort.openLocal
      // is discarded on the outbound path — the wire handle is rebuilt here from the row, exactly like wire-social).
      postPeerReveal: async (_agentId, iid) => {
        const row = sCh.get(`${intentId}:q`)!
        const sHandle = buildCrossedHandle({ my_pubkey: row.my_pubkey, my_channel_id: row.my_channel_id }, S_MBX)
        return qRevealer.onInboundReveal({ agentId: 's', intentId: iid, peerHandle: sHandle })
      },
    })

    const out = await sRevealer.revealEcho(`${intentId}:q`)
    expect(out).toEqual({ state: 'connected' })
    expect(JSON.parse(sCh.get(`${intentId}:q`)!.peer_mailbox!)).toEqual(Q_MBX)   // S learned Q's mailbox
    expect(JSON.parse(qCh.get(`${intentId}:s`)!.peer_mailbox!)).toEqual(S_MBX)   // Q learned S's mailbox
  })

  it('2-hop: W crosses the enriched handle to the far endpoint verbatim (content-blind)', () => {
    const wDb = freshTestDb(); const relayStore = makeRelayStore(wDb)
    const relayToken = 'rt'; const intentId = 'i2'
    relayStore.create({ id: `${intentId}:${relayToken}`, intentId, relayToken, upstreamAgentId: 's', downstreamAgentId: 'q' })
    const forwarded: any[] = []
    const reconciler = makeRelayReconciler({
      relayStore,
      completeUpstream: (id, iid, rt, h) => forwarded.push({ to: id, handle: h }),
      completeDownstream: (id, iid, h) => forwarded.push({ to: id, handle: h }),
      nudge: () => {}, notify3way: () => {},
    })
    // S reveals to W carrying its enriched handle; then Q reveals to W carrying its enriched handle.
    reconciler.onRelayReveal({ callerAgentId: 's', intentId, relayToken, peerHandle: buildCrossedHandle({ my_pubkey: 'sp', my_channel_id: 'sc' }, S_MBX) })
    reconciler.onRelayReveal({ callerAgentId: 'q', intentId, relayToken, peerHandle: buildCrossedHandle({ my_pubkey: 'qp', my_channel_id: 'qc' }, Q_MBX) })
    // W forwards each endpoint the OTHER's handle, mailbox intact (W never opened it).
    expect(forwarded.find(f => f.to === 'q')!.handle.mailbox).toEqual(S_MBX)
    expect(forwarded.find(f => f.to === 's')!.handle.mailbox).toEqual(Q_MBX)
  })
})
```
(Adjust store-constructor arg names to the real signatures if they differ; the shape — two real channel stores + `makeRevealer` on both sides + `makeRelayReconciler` for the 2-hop — is the regression guard the review requires.)

**Step 2 — Run-fail.** `bun run test src/daemon/bootstrap/reveal-crossing.mailbox.test.ts` → `Cannot find module './mailbox-dispatch-seam'` export `buildCrossedHandle` (until added). With a naive `buildCrossedHandle` that omits the mailbox (the C1 bug), the two `peer_mailbox` assertions fail — this is the guard.

**Step 3 — Minimal impl.**
- Add `buildCrossedHandle` to `src/daemon/bootstrap/mailbox-dispatch-seam.ts` (signature above).
- `src/daemon/bootstrap/wire-social.ts`: `const mailboxIdentity = loadMailboxIdentity(deps.stateDir)` (once, top of the social block); `const myMailbox = (configuredAgent.mailbox_relays?.length) ? { addr: mailboxIdentity.addr, enc_pub: mailboxIdentity.enc_pub, relays: configuredAgent.mailbox_relays } : undefined`. Replace the `myHandle` construction in `postPeerReveal` with `buildCrossedHandle(ch, myMailbox)`; replace both `openLocal` return objects with `buildCrossedHandle({ my_pubkey, my_channel_id }, myMailbox)`. `postReveal` needs no change (it forwards the peer_handle it is given, which W stored verbatim from the endpoints' enriched crossings).

**Step 4 — Run-pass.** `bun run test src/daemon/bootstrap/reveal-crossing.mailbox.test.ts` → both cases green. `bun run typecheck` → clean. Regression: `bun run test src/core/social-reveal.test.ts src/core/social-relay-reveal.test.ts src/daemon/bootstrap/` → green (crossing is additive; push-only peers get `myMailbox=undefined` → identical handle to today).

**Gates:** test **green**; typecheck **green**; depcheck **green**.

**Step 5 — Commit.** `git add -A && git commit -m "fix(mailbox): C1 — enrich the crossing handle at its source so peer_mailbox actually crosses (both rows); real-reveal guard"`

- [ ] Task 10 complete

---

## Task 11: relay-direct letters — `postLetter` mailbox branch (A's Task-9 W-forward stays fallback)

**Files:**
- Modify: `src/core/penpal-correspondent.ts` (pass the channel's `PeerMailbox` into `postLetter` — via `peerMailboxOfRow`), `src/core/penpal-relay-letter.ts` (extend the `postLetter` target type — W passes `mailbox: undefined`), `src/daemon/bootstrap/wire-social.ts` (`postLetter` closure: mailbox target → seal+drop, else existing push/W)
- Create: `src/daemon/bootstrap/postletter-route.test.ts`

**Interfaces:**
- Consumes: `peerMailboxOfRow` (Task 9), `makeMailboxSender` (Task 5), `PeerMailbox`/`EnvelopeInner` (Task 4).
- Produces: the shared `postLetter` target type widens to `{ agentId: string; relayVia: string | null; mailbox?: PeerMailbox }` across `penpal-correspondent.ts`, `penpal-relay-letter.ts`, and the `wire-social.ts` `postLetter` closure (kept identical in all three — the "consistency of names" rule). `correspondent.sendLetter` reads `peerMailboxOfRow(ch)` and sets `mailbox` on the target when present. The `wire-social` `postLetter` closure:
  ```ts
  const postLetter = async (target, body) => {
    if (target.mailbox) {
      return mailboxSender.send({ path: '/a2a/letter', bearer: /* per-connection or self id */ SOCIAL_SELF_ID, body: { agent_id: SOCIAL_SELF_ID, ...body } }, target.mailbox)
    }
    const hand = a2aRegistry.get(target.relayVia ?? target.agentId)   // A's existing push/W path (Task-9 fallback)
    if (!hand) return false
    const r = await a2aClient.send({ url: letterUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } })
    return r.ok
  }
  ```
  `makeLetterRelay` (A's Task-9 W-forwarding) is UNCHANGED and still routes ciphertext for peers WITHOUT a mailbox — it just now receives a `mailbox: undefined` target field (harmless). The rule (spec §3.5 / brief #9): **if the channel has a crossed `peer_mailbox` → relay-direct; else → Task-9 W-forward.**

**Step 1 — Failing test.** Create `src/daemon/bootstrap/postletter-route.test.ts` — a pure test of the routing decision extracted as `routePostLetter(target, deps)` (put the closure body in a small pure fn `src/daemon/bootstrap/postletter-route.ts` for testability):
```ts
import { describe, it, expect, vi } from 'vitest'
import { makeRoutePostLetter } from './postletter-route'

describe('postLetter routing', () => {
  it('a target WITH a mailbox is sealed+dropped (relay-direct), NOT sent over push', async () => {
    const send = vi.fn(async () => true)
    const push = vi.fn(async () => true)
    const route = makeRoutePostLetter({ mailboxSend: send, pushSend: push, selfId: 'wechat-cc' })
    const ok = await route({ agentId: 'q', relayVia: null, mailbox: { addr: 'A', enc_pub: 'E', relays: ['https://r/'] } }, { channel_id: 'pc', nonce: 'n', ct: 'x', tag: 't' })
    expect(ok).toBe(true); expect(send).toHaveBeenCalledOnce(); expect(push).not.toHaveBeenCalled()
  })
  it('a push-only target (no mailbox) falls through to the Task-9 push/W path', async () => {
    const send = vi.fn(async () => true); const push = vi.fn(async () => true)
    const route = makeRoutePostLetter({ mailboxSend: send, pushSend: push, selfId: 'wechat-cc' })
    await route({ agentId: 'q', relayVia: 'w', mailbox: undefined }, { channel_id: 'pc', nonce: 'n', ct: 'x', tag: 't' })
    expect(push).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled()
  })
})
```

**Step 2 — Run-fail.** `bun run test src/daemon/bootstrap/postletter-route.test.ts` → expect `Cannot find module './postletter-route'`.

**Step 3 — Minimal impl.** Create `src/daemon/bootstrap/postletter-route.ts`:
```ts
/**
 * postletter-route.ts — the letter routing decision: a channel with a crossed
 * peer mailbox goes relay-direct (seal+drop, W exits the loop); a push-only
 * peer falls through to A's Task-9 push/W-forward. See spec §3.5 / brief #9.
 */
import type { PeerMailbox } from '../../core/mailbox-crypto'

export type PostLetterBody = { channel_id: string; nonce: string; ct: string; tag: string }
export type PostLetterTarget = { agentId: string; relayVia: string | null; mailbox?: PeerMailbox }

export function makeRoutePostLetter(deps: {
  mailboxSend: (inner: { path: string; bearer: string; body: unknown }, peer: PeerMailbox) => Promise<boolean>
  pushSend: (target: PostLetterTarget, body: PostLetterBody) => Promise<boolean>
  selfId: string
}): (target: PostLetterTarget, body: PostLetterBody) => Promise<boolean> {
  return (target, body) => target.mailbox
    ? deps.mailboxSend({ path: '/a2a/letter', bearer: deps.selfId, body: { agent_id: deps.selfId, ...body } }, target.mailbox)
    : deps.pushSend(target, body)
}
```
Edit `src/core/penpal-correspondent.ts` `sendLetter`: after resolving `agentId`, set the target's mailbox from the channel row: `const mailbox = peerMailboxOfRow(ch); return deps.postLetter({ agentId, relayVia: ch.relay_via, ...(mailbox ? { mailbox } : {}) }, {...})`. Widen `CorrespondentDeps.postLetter`'s target type to include `mailbox?: PeerMailbox`. Edit `src/core/penpal-relay-letter.ts`'s `LetterRelayDeps.postLetter` target type identically (W always passes no mailbox — it forwards ciphertext to a push peer). Edit `wire-social.ts`'s `postLetter` closure to use `makeRoutePostLetter({ mailboxSend: mailboxSender.send, pushSend: existingPushLetter, selfId: SOCIAL_SELF_ID })` where `existingPushLetter` is the current registry-lookup + `a2aClient.send` body.

**Step 4 — Run-pass.** `bun run test src/daemon/bootstrap/postletter-route.test.ts src/core/penpal-correspondent.test.ts src/core/penpal-relay-letter.test.ts` → all green. `bun run typecheck` → clean. Regression: A's Task-9 relay suite green (push-only peers unchanged).

**Gates:** test **green**; typecheck **green**; depcheck **green**.

**Step 5 — Commit.** `git add -A && git commit -m "feat(mailbox): relay-direct letters — postLetter seals to peer mailbox, Task-9 W-forward stays fallback"`

- [ ] Task 11 complete

---

# B6 — End-to-end (two NAT-simulated daemons + in-process relay)

## Task 12: e2e — drive a REAL reveal → relay-direct letter; assert crossing, relay-direct delivery, content-blindness

**Files:**
- Create: `src/core/mailbox-e2e.test.ts`

**Interfaces:**
- Consumes EVERYTHING composed: `makeRelayServer` (Task 3, driven through `fetchHandler` — no socket), two real `loadMailboxIdentity` identities + two real `makeChannelStore`/`makeLetterStore`, `makeRevealer` on both sides (real reveal, Task 10 crossing), `makeCorrespondent` + `makeRoutePostLetter` (Task 11 relay-direct), `makeMailboxSender`/`makeMailboxPoller`/`makeMailboxLetterHandler` (I1). This is the C1-catching e2e: it drives the ACTUAL reveal (not a hand-built drop), then a relay-direct letter, and asserts (a) the mailbox crossed onto BOTH channel rows, (b) the letter is delivered relay-direct WITHOUT touching W's `routeLetter`, (c) the relay stored only ciphertext.

**Step 1 — Failing test.** Create `src/core/mailbox-e2e.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { makeRelayServer } from '../../relay/server'
import { loadMailboxIdentity, openEnvelope } from './mailbox-crypto'
import { makeMailboxSender } from './mailbox-sender'
import { makeMailboxPoller } from './mailbox-poller'
import { makeEnvelopeDispatch } from './mailbox-dispatch'
import { makeCursorStore } from './mailbox-cursor-store'
import { freshTestDb } from '../lib/db'
import { makeChannelStore } from './penpal-channel-store'
import { makeLetterStore } from './penpal-letter-store'
import { makeCorrespondent } from './penpal-correspondent'
import { makeEchoStore } from './social-echo-store'
import { makePledgeStore } from './social-pledge-store'
import { makeSeekStore } from './social-seek-store'
import { makeRevealer } from './social-reveal'
import { generateKeypair } from './penpal-crypto'
import { makeMailboxSender as _s } from './mailbox-sender'
import { makeRoutePostLetter } from '../daemon/bootstrap/postletter-route'
import { makeMailboxLetterHandler } from '../daemon/bootstrap/mailbox-letter-handler'
import { buildCrossedHandle } from '../daemon/bootstrap/mailbox-dispatch-seam'
import type { MailboxClient } from './mailbox-client'

function inProcClient(relay: ReturnType<typeof makeRelayServer>): MailboxClient {
  const post = (p: string, b: unknown) => relay.fetchHandler(new Request(`http://relay${p}`, { method: 'POST', body: JSON.stringify(b) }), '127.0.0.1')
  return {
    drop: async (_r, to, envelope) => (await post('/drop', { to, envelope })).ok,
    fetch: async (_r, mailbox, since, ts, sig) => { const r = await post('/fetch', { mailbox, since, ts, sig }); return r.ok ? await r.json() as any : null },
    ack: async (_r, mailbox, up, ts, sig) => (await post('/ack', { mailbox, up_to_cursor: up, ts, sig })).ok,
  }
}
function port(store: ReturnType<typeof makeChannelStore>, mbx: { addr: string; enc_pub: string; relays: string[] }) {
  return {
    openLocal(rowId: string, ctx: any) {
      const ex = store.get(rowId)
      if (ex) return buildCrossedHandle({ my_pubkey: ex.my_pubkey, my_channel_id: ex.my_channel_id }, mbx)
      const kp = generateKeypair(); const mcid = randomUUID()
      store.create({ id: rowId, seekId: ctx.seekId, myPrivkey: kp.privateKey, myPubkey: kp.publicKey, myChannelId: mcid, degree: ctx.degree, relayVia: ctx.relayVia ?? null, peerAgentId: ctx.peerAgentId ?? null })
      return buildCrossedHandle({ my_pubkey: kp.publicKey, my_channel_id: mcid }, mbx)
    },
    finalize(rowId: string, h: any) { store.setPeerHandle(rowId, h) },
  }
}

describe('mailbox e2e — real reveal → relay-direct letter (NAT-simulated: only the relay is shared)', () => {
  it('crosses the mailbox on both rows, then delivers a letter relay-direct without touching routeLetter; relay sees only ciphertext', async () => {
    const relayDb = new Database(':memory:')
    const relay = makeRelayServer({ db: relayDb })
    const client = inProcClient(relay)
    const sDir = mkdtempSync(join(tmpdir(), 's-')); const qDir = mkdtempSync(join(tmpdir(), 'q-'))
    const s = loadMailboxIdentity(sDir); const q = loadMailboxIdentity(qDir)
    const S_MBX = { addr: s.addr, enc_pub: s.enc_pub, relays: ['https://relay/'] }
    const Q_MBX = { addr: q.addr, enc_pub: q.enc_pub, relays: ['https://relay/'] }
    const intentId = 'i1'

    // --- Q side (already self-revealed, awaiting S) ---
    const qDb = freshTestDb(); const qCh = makeChannelStore(qDb); const qLetters = makeLetterStore(qDb)
    const qEch = makeEchoStore(qDb), qPld = makePledgeStore(qDb), qSk = makeSeekStore(qDb)
    qSk.create({ id: intentId, kind: 'seek', topic: 't' })
    qEch.create({ id: `${intentId}:s`, seekId: intentId, peerMasked: '某人', degree: 1, content: 'c', peerAgentId: 's', relayVia: null, relayToken: null })
    qEch.setSelfRevealed(`${intentId}:s`, new Date().toISOString())
    const qPort = port(qCh, Q_MBX); qPort.openLocal(`${intentId}:s`, { seekId: intentId, degree: 1, peerAgentId: 's' })
    const qRevealer = makeRevealer({ echoStore: qEch, pledgeStore: qPld, seekStore: qSk, channel: qPort as any, notify: () => {}, postPeerReveal: async () => null })
    const qNotify = vi.fn()
    const qCorr = makeCorrespondent({ channelStore: qCh, letterStore: qLetters, postLetter: async () => true, notifyInbound: qNotify })

    // --- S side (reveals second; crossing handle built from the row, the C1 path) ---
    const sDb = freshTestDb(); const sCh = makeChannelStore(sDb); const sLetters = makeLetterStore(sDb)
    const sEch = makeEchoStore(sDb), sPld = makePledgeStore(sDb), sSk = makeSeekStore(sDb)
    sSk.create({ id: intentId, kind: 'seek', topic: 't' })
    sEch.create({ id: `${intentId}:q`, seekId: intentId, peerMasked: '某人', degree: 1, content: 'c', peerAgentId: 'q', relayVia: null, relayToken: null })
    const sPort = port(sCh, S_MBX)
    const sRevealer = makeRevealer({
      echoStore: sEch, pledgeStore: sPld, seekStore: sSk, channel: sPort as any, notify: () => {},
      postPeerReveal: async (_a, iid) => {
        const row = sCh.get(`${intentId}:q`)!
        return qRevealer.onInboundReveal({ agentId: 's', intentId: iid, peerHandle: buildCrossedHandle({ my_pubkey: row.my_pubkey, my_channel_id: row.my_channel_id }, S_MBX) })
      },
    })

    // (1) Drive the REAL reveal.
    expect(await sRevealer.revealEcho(`${intentId}:q`)).toEqual({ state: 'connected' })
    expect(JSON.parse(sCh.get(`${intentId}:q`)!.peer_mailbox!)).toEqual(Q_MBX)   // (a) crossed on S's row
    expect(JSON.parse(qCh.get(`${intentId}:s`)!.peer_mailbox!)).toEqual(S_MBX)   // (a) crossed on Q's row

    // (2) S sends a letter — routed relay-direct (target.mailbox set), NEVER over pushSend (the W-forward stand-in).
    const pushSpy = vi.fn(async () => true)   // stands in for letterRelay.routeLetter / push
    const sSender = makeMailboxSender({ client })
    const sPostLetter = makeRoutePostLetter({ mailboxSend: sSender.send, pushSend: pushSpy, selfId: 's' })
    const sCorr = makeCorrespondent({
      channelStore: sCh, letterStore: sLetters,
      postLetter: (target, body) => sPostLetter(target as any, body),   // sendLetter sets target.mailbox from peerMailboxOfRow
      notifyInbound: () => {},
    })
    expect(await sCorr.sendLetter(`${intentId}:q`, 'hallo penpal')).toEqual({ ok: true })
    expect(pushSpy).not.toHaveBeenCalled()   // (b) relay-direct — W's routeLetter/push untouched

    // The relay row is opaque — no plaintext leaked.
    const raw = relayDb.query('SELECT envelope FROM mailbox_item').get() as { envelope: string }
    expect(raw.envelope).not.toContain('hallo penpal')
    expect(openEnvelope(q.enc_priv, JSON.parse(raw.envelope))).toBeTruthy()   // only Q can open

    // (3) Q polls → own-channel letter handler → receiveLetter opens it.
    const poller = makeMailboxPoller({
      identity: q, relays: ['https://relay/'], client, cursors: makeCursorStore(qDir),
      dispatch: makeEnvelopeDispatch({
        registry: { verifyBearer: () => null } as any,
        onReveal: async () => ({ mutual: false }),
        onLetter: makeMailboxLetterHandler({ getByMyChannelId: (c) => qCh.getByMyChannelId(c), receiveLetter: (ev) => qCorr.receiveLetter(ev) }),
        log: () => {},
      }),
      log: () => {},
    })
    await poller.onTick()
    const inbound = qLetters.listForChannel(`${intentId}:s`).filter(l => l.direction === 'in')
    expect(inbound.map(l => l.plaintext)).toEqual(['hallo penpal'])   // delivered + decrypted, relay-direct, no W
    expect(qNotify).toHaveBeenCalledTimes(1)
    await poller.onTick()                                             // re-poll: acked → idempotent (M3)
    expect(qLetters.listForChannel(`${intentId}:s`).filter(l => l.direction === 'in')).toHaveLength(1)
  })
})
```
(Adjust store-constructor arg names / `listForChannel` to the real A signatures if they differ; the composition — real reveal + relay-direct letter + in-process relay + own-channel handler — is the required shape. Remove the stray `_s` import if unused.)

**Step 2 — Run-fail.** `bun run test src/core/mailbox-e2e.test.ts` → on a branch with the C1 bug (mailbox not crossed) the `peer_mailbox` assertions fail; with `pushSend` wrongly taken, `pushSpy` fires. On the correctly-implemented branch (Tasks 1-11 merged) it compiles and passes.

**Step 3 — (no new impl).** Composition-only; if it surfaces an integration gap, fix the offending module under its OWN task's test first (systematic-debugging), then re-run this.

**Step 4 — Run-pass.** `bun run test src/core/mailbox-e2e.test.ts` → green. `bun run typecheck` → clean.

**Gates:** test **green**; typecheck **green**; depcheck **green**. Full suite: `bun run test` → green (no A regression).

**Step 5 — Commit.** `git add -A && git commit -m "test(mailbox): e2e — real reveal→relay-direct letter, both rows crossed, W untouched, relay content-blind"`

- [ ] Task 12 complete

---

# B7 — Deploy runbook (real-machine, outside CI)

## Task 13: `relay/README.md` — VPS deploy + client config runbook (DOC/checklist, manually verified)

**Files:**
- Create: `relay/README.md`

**Interfaces:** none (documentation). This is NOT a code task — no vitest. It is a checklist + exact commands, verified by hand on the VPS (`brain.youdamaster.cc`) and the client daemon. Note in the doc that it is manually verified and out of CI.

**Step 1 — Write the runbook.** Create `relay/README.md` with these sections and exact commands:

````md
# Mailbox relay — deploy runbook (v0, single relay)

> Standalone content-blind mailbox relay for wechat-cc sub-project B. NOT part of
> the daemon. Node-builtin-only (Bun + bun:sqlite). Manually verified on the VPS
> (outside CI). See docs/superpowers/specs/2026-07-19-penpal-mailbox-transport-B-design.md.

## 0. Prereqs
- A VPS with a public HTTPS name (v0: `brain.youdamaster.cc`), Bun ≥ 1.1 installed.
- A TLS terminator in front (Caddy/nginx) — the relay itself serves plain HTTP on `RELAY_PORT`.

## 1. Copy + run the relay
```bash
# on the VPS
git clone <repo> wechat-cc && cd wechat-cc
RELAY_PORT=8787 RELAY_DB=/var/lib/mailbox/mailbox.sqlite bun relay/server.ts
```
Expected: `[relay] listening on :8787`. The SQLite file + WAL are created on first drop.

## 2. Front it with HTTPS (Caddy example)
```
mailbox.youdamaster.cc {
  reverse_proxy 127.0.0.1:8787
}
```
`caddy reload`. Confirm: `curl -sS https://mailbox.youdamaster.cc/drop -d '{}' -H 'content-type: application/json'` → `{"error":"invalid_body"}` (400) — proves the route is reachable and validating.

## 3. Run it as a service (systemd)
```ini
# /etc/systemd/system/mailbox-relay.service
[Service]
Environment=RELAY_PORT=8787 RELAY_DB=/var/lib/mailbox/mailbox.sqlite
ExecStart=/usr/local/bin/bun /opt/wechat-cc/relay/server.ts
Restart=always
```
```bash
systemctl daemon-reload && systemctl enable --now mailbox-relay && systemctl status mailbox-relay
```

## 4. Point a client daemon at the relay
Add the relay to the daemon's own advertised list (edit `agent-config.json` in the state dir, or via the CLI once wired):
```json
{ "social_enabled": true, "mailbox_relays": ["https://mailbox.youdamaster.cc"] }
```
Restart the daemon. On boot it generates `mailbox-key.json` (0600) in the state dir and the poller starts (log tag `SCHED mailbox scheduler started`). Advertise `{mailbox_addr, mailbox_enc_pub, relays}` to peers by registering them with `transport: "mailbox"`.

## 5. Manual end-to-end verification (two machines behind NAT)
1. On daemon A: `cat "$STATE_DIR/mailbox-key.json" | jq .addr` → note A's mailbox address; confirm the file is `-rw-------` (0600).
2. Register A on B (and B on A) as `transport: mailbox` with each other's `mailbox_addr` + `mailbox_enc_pub` + `relays`.
3. Complete a reveal (FoF or direct) so the channel opens and crosses mailbox addresses.
4. Send a letter from A to B; within ~2 min (poll interval + jitter) B's owner sees `📬 …给你写信了`.
5. On the relay: `sqlite3 /var/lib/mailbox/mailbox.sqlite 'SELECT recipient, length(envelope) FROM mailbox_item'` → rows exist keyed by mailbox address, and `SELECT envelope FROM mailbox_item LIMIT 1` is opaque base64url JSON (no plaintext, no channel id, no bearer). **Content-blindness confirmed.**
6. Confirm ack: after B polls, the row is gone (or TTL-swept after 7 days if B never polls).

## 6. Operational notes
- **Precondition (M1):** a mailbox peer MUST be registered with all three of `mailbox_addr`, `mailbox_enc_pub`, `relays` populated (from the peer's `mailbox-key.json` + its `mailbox_relays`). A record missing any of them silently degrades to `push` and a NAT'd peer's letters will FAIL — v0 has no pairing flow that auto-populates these.
- **Reachability envelope (v0):** the mailbox pierces NAT/offline only for reveal-completion + letters. Discovery (seek→echo) is push-only, so both endpoints must be reachable during discovery, and W must be reachable at all times. B is NOT full NAT'd-stranger connectivity.
- **TTL:** items expire after 7 days (hourly sweep). A long-offline peer may lose letters — acceptable (best-effort async).
- **Rate-limit / caps:** 16 KB envelope cap, per-IP + per-mailbox token bucket, per-mailbox depth cap 256 (oldest dropped). **Note (M2):** "drop oldest" means a flooder who leaks a mailbox address evicts UN-POLLED legitimate letters first — §10-accepted in v0. Tune in `server.ts` if a legitimate peer is throttled.
- **Anti-replay (M2):** fetch/ack sigs carry a ±5-min freshness window, no per-request jti, and don't bind `since` — harmless under TLS + content-blindness (a replay only re-reads the caller's own mailbox), a known v0 limitation.
- **v1 (NOT in v0):** multi-relay redundancy, per-connection rotating addresses, PoW anti-flood, sealed-sender metadata hardening. Single relay = single point of failure for the mailbox path (push/ws peers unaffected).
- **Metadata:** the relay operator can see "which address polls / who drops to whom" (content-blind, not metadata-blind). v0 accepts a self-hosted/trusted operator (parent spec §11).
````

**Step 2 — Verify (manual).** Run sections 1-5 on the VPS + two NAT-behind daemons; confirm the content-blindness check in §5.5. Record the result in the PR description (not a CI gate).

**Gates:** none automated. `bun run typecheck` + `bun run depcheck` unaffected (doc only). Manual verification is the acceptance signal.

**Step 3 — Commit.** `git add -A && git commit -m "docs(relay): VPS deploy + client config runbook (manual, out of CI)"`

- [ ] Task 13 complete

---

## Done criteria

- All 13 tasks' checkboxes ticked; `bun run test`, `bun run typecheck`, `bun run depcheck` green on the branch. Every task's commit is a green checkpoint (no red-parking / `.skip`).
- **C1 closed:** the mailbox address actually crosses on a REAL reveal — Task 10's regression guard asserts `peer_mailbox` lands on BOTH channel rows (1-hop) and W forwards the enriched handle verbatim (2-hop); Task 12's e2e re-proves it end-to-end and asserts the letter is delivered relay-direct WITHOUT touching `routeLetter`.
- **I1 closed:** un-bearer'd mailbox letters can never reach `routeLetter` (own-channel-only `makeMailboxLetterHandler`). **M3 closed:** `receiveLetter` is idempotent on `(channel_id, nonce)` — re-delivery after an ack failure is a no-op.
- A's pen-pal/social suites unchanged except the one additive `a2a-server` reveal-passthrough assertion + the v23 full-schema smoke update (both additive; no existing assertion inverted).
- The relay is content-blind (Tasks 3 + 12 assert ciphertext-only storage); W exits the letter loop for mailbox peers (Task 11) while A's Task-9 W-forward remains the push-only fallback (unchanged, not deleted).
- Reachability envelope stated honestly (Global Constraints): B pierces NAT only for reveal-completion + letters; discovery stays push-only (§9). M1/M2 limitations recorded for the PR description.
- v0 non-goals (rotating addresses, multi-relay redundancy, PoW, seeks/echoes broadcast, relay payment/allowlist) left as clean seams with one-line notes, not built.
