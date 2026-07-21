# 派心愿 propose→confirm — Seek Creation with Owner Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is a TDD unit: failing test → run-fail → minimal impl → run-pass → commit. Run every gate from the **repo ROOT** with `bun run <script> <path>` (NOT `bun test`).

**Goal:** No wish may broadcast to a stranger agent without one explicit owner confirmation. Today the model calls `social_seek` and the broker immediately broadcasts a (redacted) intent to paired peers — no preview, no consent. This plan splits the broker's one-shot `seek()` into **propose → confirm → cancel**: the bot *proposes* (gates + persists the redacted wording as a `proposed` row, sends nothing), shows the owner the exact wording, and only the owner's **`派 <id>`** actually forages; **`取消 <id>`** voids it. The redacted string the owner approved is the byte-identical string that broadcasts (**WYSIWYG** — no second gate, which could drift). The one-shot `POST /v1/social/seek` route is **deleted** (no un-confirmed broadcast entry may exist in the codebase). Plus a small `wechat-cc social enable` one-toggle that closes the "how does a user turn social on" gap. See `docs/superpowers/specs/2026-07-20-p4-seek-confirm-design.md` (the contract).

**Architecture:** Additive migration + a broker split + three routes + one WeChat command + three CLI forms + one enable toggle.
1. **Store/migration** (`src/lib/db.ts`, `src/core/social-seek-store.ts`): migration **v24** adds two nullable columns (`redacted_topic`, `redacted_city`) to `social_seek`; the `status` union gains `proposed` + `cancelled` (TypeScript-only — the column has no CHECK constraint). `SeekStore` gains a `propose()` insert.
2. **Broker split** (`src/core/social-broker.ts`): `propose(topic, opts)` gates + persists a `proposed` row, returns the redacted preview, **never discovers/sends**. `confirmSeek(intentId)` loads the `proposed` row, flips it to `foraging`, and schedules the existing `forage()` **with the stored pre-gated text** — `forage()` is changed to accept pre-gated text and **skip re-gating** (WYSIWYG). `cancelSeek(intentId)` flips `proposed`→`cancelled` (idempotent). The old `seek()` survives as a thin deprecated alias through Tasks 2–6 (bridge to keep every caller green) and is **deleted in Task 7**.
3. **Routes** (`src/daemon/internal-api/routes-social.ts`, `route-tiers.ts`): DELETE `POST /v1/social/seek`; ADD `POST /v1/social/seek/{propose,confirm,cancel}` (all three **trusted** — RESOLVED per spec §3.3; flagged for release review). Repoint the `social_seek` MCP tool to `/propose`.
4. **WeChat command** (`src/core/seek-command.ts` + `pipeline-deps.ts` dispatch seam): `派 <id>` → confirm, `取消 <id>` → cancel; `<id>` = full intent_id or a unique prefix (≥6 chars); admin-only; deterministic parse mirroring `揭晓`/`配对`; every outcome rendered synchronously at the caller (no engine notify — the pairing lesson).
5. **CLI** (`src/cli/social.ts`, `src/cli/social-enable.ts`, `cli.ts`): `social propose|confirm|cancel` forms (through internal-api like `social reveal`) + `social enable [--status]` (merge-persist, copying `persistSelfAgentId`'s read-modify-write idiom).

**Tech Stack:** TypeScript, Bun runtime, Vitest (`bun run test <path>` — NOT `bun test`). SQLite via the daemon's `src/lib/db.ts` (one append-only migration). No cryptography beyond what already exists. **No new npm dependency.**

## Global Constraints

### LOCKED design decisions (copied verbatim from the brief + spec — do NOT re-litigate)

1. **WYSIWYG (铁律):** `confirmSeek` forages the STORED redacted string **verbatim** — the wording the owner approved at propose is the exact byte string that reaches `send`. A second `gateOutbound` at confirm/forage time is FORBIDDEN (it could drift). Tests MUST assert the exact stored string reaches the card.
2. **Gate-at-propose:** `propose()` runs `gateOutbound(topic)` (and `gateOutbound(city)` when a city is given). Blocked topic → return the reason, persist NOTHING. Passed → write a `proposed` row persisting `redacted_topic`/`redacted_city`, return `{ intent_id, redacted, redacted_city? }`. **No discover, no send.**
3. **One-shot route DELETED:** `POST /v1/social/seek` is removed — the codebase may not contain an un-confirmed broadcast entry point.
4. **Statuses additive:** `social_seek.status` gains `proposed` + `cancelled`; the column has no CHECK constraint, so this is a TypeScript-union-only change. Existing `foraging|echoed|connected|closed` semantics are untouched.
5. **Boot resume still re-forages ONLY `foraging` rows** (`proposed` rows sit across restarts awaiting confirmation — naturally correct). BUT resume is **NOT** a no-op change: `wire-social.ts:506` currently does `void forage(row.id, row.topic)` — the **RAW** `topic` column. That is safe TODAY only because `forage` re-gates internally; Task 2 DELETES that gate, so an unmodified resume would broadcast the un-redacted intent verbatim on every restart (C1). Resume MUST be reworked (Task 2, coupled to the de-gating) to pass `row.redacted_topic` (+ `row.redacted_city`) into the de-gated `forage`, and to RE-GATE any row whose `redacted_topic` is `null` (pre-v24 legacy rows + any bridge-sown rows) before foraging — never pass raw/null into `forage`.
6. **Sync results render at caller (no engine notify — the pairing lesson):** `派`/`取消` outcomes (success + every failure reason) are rendered by the dispatch seam's own reply, exactly as `配对` does. The broker's `notify` dep is NOT extended for this.
7. **Prefix-match ids:** `<id>` accepts a full `intent_id` OR a unique prefix (≥6 chars). Ambiguous prefix → ask for a longer one; no match → "不存在或已处理".
8. **Trusted tier ×3 (flagged):** all three new routes are `trusted` (RESOLVED, spec §3.3: internal-api is 127.0.0.1-only + 0600 file token = the owner; same precedent as `social reveal`/`pair`). Each carries a comment flagging it for the release security review.
9. **Desktop NOT wired:** no desktop button this pass (keep-desktop-ui-simple). The read routes already surface `proposed` rows; the write routes are ready to skin later.
10. **`social enable` = merge-persist:** read-modify-write the raw `agent-config.json` (copying `persistSelfAgentId`), setting `social_enabled: true` + defaults for `social_disclosure_policy` and `mailbox_relays` **only if absent** (never overwrite existing values). **No `disable`** (hand-edit config, rare).
11. **NO new npm dep.** `bun run depcheck` MUST stay green.
12. **All additive where possible.** The `seek()` alias is the green-bridge; it is deleted only in Task 7 after every caller is converted. NO `.skip`/red-parking anywhere.

### Enumerated existing `broker.seek()` / `POST /v1/social/seek` callers + tests that MUST change

The spec §5 回归 demands this list. **Twelve** code/test sites touch the old surface (the first pass under-counted at eight; the four additions — #3b, #9, #10, #11 — were confirmed against real code):

| # | File | Site | When | How |
|---|------|------|------|-----|
| 1 | `src/core/social-broker.test.ts` | 12 `broker.seek()` calls + double-gate assertions | Task 2 | REWRITTEN around `propose`/`confirmSeek`/`cancelSeek` + `forage`-pre-gated; a couple of `seek()`-alias smoke tests retained until Task 7 |
| 2 | `src/daemon/internal-api/routes-social.ts` | `POST /v1/social/seek` → `broker.seek()` | Task 3 | route DELETED; three new routes call `propose`/`confirmSeek`/`cancelSeek` |
| 3 | `src/daemon/internal-api/route-tiers.ts` (+ `route-tiers.test.ts`) | `'POST /v1/social/seek': 'admin'` | Task 3 | entry removed; three new `trusted` entries + a tier test |
| 3b | `src/daemon/internal-api/schema.ts` (+ `schema.test.ts`) | `SocialSeekRequest` (L398) + route→schema map entry `'POST /v1/social/seek'` (L562); hard-count `schema.test.ts:604` = 31 | Task 3 | REMOVE both schema decls; count **31 → 30**; the three new routes are inline-validated in the handler (routes.ts precedent — pair/inbound routes validate their body inline, no `REQUEST_SCHEMAS` entry) |
| 4 | `src/daemon/internal-api/types.ts` | `InternalApiDeps.social.broker: { seek }` | Task 3 | type → `{ propose, confirmSeek, cancelSeek }` |
| 5 | `src/mcp-servers/wechat/tools-social.ts` | `client.request('POST','/v1/social/seek', …)` | Task 3 | repoint to `/v1/social/seek/propose`; return `{intent_id, redacted, hint}`; rewrite description |
| 6 | `src/daemon/bootstrap/wire-social.ts` | `SocialWiring.social.broker: { seek }` + `socialBroker` construction + **`resumeForaging` (L499-510)** | Task 2 (resume rework, coupled to de-gating) + Task 3 (additive superset) → Task 7 (drop `seek`) | Task 2: rework resume to pass `redacted_topic`/`redacted_city`, re-gate null rows. Task 3: expose `{propose, confirmSeek, cancelSeek}` (+`seek` bridge until Task 7) |
| 7 | `src/core/social-m1.e2e.test.ts` | 3 `broker.seek()` calls (L93/165/229) | Task 7 | converted to `propose` + `confirmSeek` |
| 8 | `src/daemon/bootstrap.test.ts` | `typeof boot.social!.broker.seek` (L1088) + `broker.seek()` (L1368, L1426) | Task 7 | assert `propose`/`confirmSeek`; calls → `propose`+`confirmSeek` |
| 9 | `src/daemon/bootstrap.test.ts` | `POST /v1/social/seek` → 503 assertion (L1658/1667) | Task 3 | repoint to `POST /v1/social/seek/propose`, still asserting 503 (deps.social absent); the minted admin token still meets the new `trusted` tier; update the stale "social_seek is admin-tier" comment |
| 10 | `src/daemon/bootstrap.test.ts` | url-less-mailbox discover test `broker.seek()` (L1933) | Task 7 | convert to `propose` + `confirmSeek` (0-peer `foraging`→`closed` assertion unchanged) |
| 11 | `src/daemon/bootstrap.test.ts` | crash-mid-forage resume test (L1485-1494) — seeds via `seekStore.create` (redacted_topic=null) | Task 2 | this is the LEGACY/null-redacted resume case — extend it (or add a sibling) to assert the resumed card goes through the re-gate (see 2d) |

`src/core/user-tier.ts` (the `social_seek` ToolKind, ADMIN_ONLY) and `src/core/user-tier.test.ts` are **unchanged** — the MCP tool name (`social_seek`) and its admin-only classification stay; only the route it POSTs to changes. `src/lib/state-migration.test.ts` (L82 table list) is **unchanged** — v24 adds columns, not tables.

### Red-window verdict — AVOIDED (bridged by a deprecated `seek()` alias)

The broker split + the `broker` shape change would otherwise red every `seek()` caller mid-plan. Avoided: Task 2 keeps `seek()` as a thin deprecated alias (gate → `sow` a `foraging` row → schedule the now-pre-gated `forage`), so callers #1(smoke)/#7/#8 stay green untouched. Task 3 exposes `{propose, confirmSeek, cancelSeek}` **plus** the `seek` bridge on `boot.social.broker` (a structural superset — the tighter `InternalApiDeps` type asks for only the three, which is satisfied). Tasks 4–6 add new surfaces only. Task 7 converts the last callers (#7, #8, #10) and DELETES the `seek()` alias + its `wire-social`/`SocialWiring` exposure + the now-unused `sow` BrokerDep (see M2). Every task ends on a green checkpoint (test + typecheck + depcheck). No `.skip`, no red-parking.

**Safety coupling (C1) — the `forage` de-gating and the `resumeForaging` rework land in the SAME task (Task 2).** De-gating `forage` without fixing resume would leave the Task 2 commit test-green but semantically broken (a restart re-broadcasts the raw topic). So Task 2 edits `src/core/social-broker.ts` (core) AND `src/daemon/bootstrap/wire-social.ts` (`resumeForaging`) together — no committed checkpoint ever ships a raw-topic resume.

### Resolved ambiguities

- **`派` reply "已问 N 个" (spec §3.2) vs the non-blocking broker invariant — RESOLVED toward non-blocking.** `confirmSeek` follows the spec's literal "调度现有 `forage()`" (schedule, don't await): it flips the row to `foraging`, schedules the background `forage`, and returns `{ ok, intent_id }` **synchronously**. The peer count is only known after the background forage runs (`peers_asked` is written by `finishSeek`), so the `派` reply renders **`已发出,觅食中…`** WITHOUT a live N. Surfacing N would require blocking `confirmSeek` on the forage (violating the non-blocking invariant the whole spine is built on) — declined. The owner sees the count later via `social seeks` / echoes. (`discover` happens to be a local registry read today, but coupling `confirmSeek` to it would break the clean "schedule the existing forage" seam and re-introduce a network-shaped await; not worth it.)
- **`cancelSeek` on a non-`proposed` row:** idempotent no-op returning `{ ok: true }` (spec: "重复取消 = no-op ok"). A truly missing id → `{ ok: false, reason: 'not_found' }`. `confirmSeek` on a non-`proposed` row (already foraged / cancelled / missing) → `{ ok: false, reason: 'not_proposed' }` (spec: "明确的无伤害错误结果").
- **Prefix resolution scope:** `派`/`取消` resolve `<id>` against `proposed` rows only (the only rows either command can act on) — a prefix that is unique among proposed rows but collides with an old foraged/closed id still resolves cleanly.

### Consistency of names across tasks (must match exactly)

```ts
// src/core/social-seek-store.ts
export interface SeekRow {
  id: string; kind: 'seek' | 'fun'; topic: string
  status: 'proposed' | 'foraging' | 'echoed' | 'connected' | 'closed' | 'cancelled'
  redacted_topic: string | null; redacted_city: string | null
  hop: number; peers_asked: number; created_at: string; updated_at: string
}
export interface SeekStore {
  create(s: { id: string; kind: 'seek' | 'fun'; topic: string }): void            // unchanged (foraging)
  propose(s: { id: string; kind: 'seek' | 'fun'; topic: string; redactedTopic: string; redactedCity?: string | null }): void
  update(id: string, patch: { status?: SeekRow['status']; peersAsked?: number }): void
  list(): SeekRow[]
  get(id: string): SeekRow | null
}

// src/core/social-broker.ts — new BrokerDeps members (additive to the existing ones)
export interface BrokerDeps {
  // …existing: discover, send, policy, cheapEval, ttlMs?, sow, recordEcho, finishSeek, schedule?…
  /** Persist a `proposed` row carrying the redacted preview. */
  proposeRow: (intentId: string, r: { topic: string; redactedTopic: string; redactedCity?: string | null }) => void
  /** Read a seek's status + persisted redacted preview (for confirm/cancel). */
  readSeek: (intentId: string) => { status: SeekRow['status']; redactedTopic: string | null; redactedCity: string | null } | null
  /** Set a seek's status (proposed→foraging on confirm, proposed→cancelled on cancel). */
  markStatus: (intentId: string, status: SeekRow['status']) => void
}
export interface ProposeResult { ok: true; intent_id: string; redacted: string; redacted_city?: string }
                              // | { ok: false; reason: string }
export interface ConfirmResult { ok: boolean; intent_id?: string; reason?: string }
export interface CancelResult  { ok: boolean; reason?: string }

// broker methods (in the object returned by makeBroker):
//   forage(intentId, topic, opts?)          // topic + opts.city are PRE-GATED; NO gateOutbound
//   propose(topic, opts?): Promise<ProposeResult>
//   confirmSeek(intentId): Promise<ConfirmResult>
//   cancelSeek(intentId): Promise<CancelResult>
//   seek(topic, opts?): Promise<SeekOutcome>   // DEPRECATED alias, deleted in Task 7

// src/core/seek-command.ts
// The ref token is constrained to an id-like charset (hex + hyphen — intent_id
// is a randomUUID) so a token can NEVER contain 执行/跑 or CJK. This makes the
// seek parser structurally disjoint from admin-commands.ts's DELEGATE_RE
// (让/派 <hand> 执行/跑 <task>) even before middleware ordering is considered.
export type SeekCommand = { kind: 'confirm'; ref: string } | { kind: 'cancel'; ref: string }
export function parseSeekCommand(text: string): SeekCommand | null
export type SeekRefResolution = { ok: true; id: string } | { ok: false; reason: 'not_found' | 'ambiguous' }
export function resolveSeekRef(ref: string, rows: SeekRow[]): SeekRefResolution   // considers status==='proposed' rows only

// src/daemon/internal-api types + wire-social SocialWiring.social.broker (final shape after Task 7):
//   broker: { propose(topic, opts?), confirmSeek(id), cancelSeek(id) }

// src/cli/social-enable.ts
export const DEFAULT_SOCIAL_DISCLOSURE_POLICY: string   // 一条克制的默认披露策略文案
export const DEFAULT_MAILBOX_RELAYS: string[]           // ['https://brain.youdamaster.cc/mailbox']
export function cmdSocialEnable(stateDir: string, opts: { status: boolean }): void
```

### Gates — no silent red

Every task states its gates. Run from the repo ROOT:
- `bun run test <path…>` (vitest) — the exact paths each task lists.
- `bun run typecheck` (`tsc --noEmit`, whole project).
- `bun run depcheck` (depcruise over `src cli.ts setup.ts docs.ts log-viewer.ts`).
- `cli.test.ts`'s surface-list test changes ONLY if a TOP-LEVEL subcommand is added. **`social` already exists** and there is NO nested per-social-subcommand assertion, so adding `propose`/`confirm`/`cancel`/`enable` under `social` does NOT touch the surface list. Verified.
- Do NOT touch `apps/desktop/**` or `main.js`. Do NOT regress the pen-pal / pairing / social-M1 suites.

---

## Task 1 — Migration v24 + SeekStore (statuses + redacted columns)

**Gates:** `bun run test src/lib/db.test.ts src/core/social-seek-store.test.ts` · `bun run typecheck` · `bun run depcheck`

**Migration numbering (counted, not trusted-from-comments):** the `migrations` array in `src/lib/db.ts` currently ends with the `peer_mailbox` ALTER (last comment `v23`). `runMigrations` sets `user_version = index + 1`, so `peer_mailbox` is index 22 → `user_version` 23; the array length is 23 (indices 0–22). The new migration is appended at **index 23 → `user_version` 24 (v24)**.

- [ ] **1a. RED — store test for `propose` + new columns/statuses.** In `src/core/social-seek-store.test.ts` add:
  - `propose({ id:'p1', kind:'seek', topic:'找搭子', redactedTopic:'找搭子【已清理】', redactedCity:'南京' })` → `get('p1')` returns `status:'proposed'`, `redacted_topic:'找搭子【已清理】'`, `redacted_city:'南京'`.
  - `propose` without `redactedCity` → `redacted_city` is `null`.
  - `update('p1', { status:'foraging' })` then `get` → `status:'foraging'` (proposed→foraging).
  - `update('p1', { status:'cancelled' })` → `status:'cancelled'`.
  - `create({ id:'c1', kind:'seek', topic:'x' })` (unchanged path) → `status:'foraging'`, `redacted_topic:null`.

  Run: `bun run test src/core/social-seek-store.test.ts` → RED.

- [ ] **1b. RED — db migration test.** In `src/lib/db.test.ts` add a focused test: open a fresh `openTestDb()`, assert `PRAGMA table_info('social_seek')` includes columns `redacted_topic` and `redacted_city`, and `PRAGMA user_version >= 24`.

  Run: `bun run test src/lib/db.test.ts` → RED.

- [ ] **1c. GREEN — migration.** Append to the `migrations` array in `src/lib/db.ts` (after the `peer_mailbox` entry), following the house comment style:
  ```ts
  // v24 — 派心愿 propose→confirm (P4). Two nullable columns on social_seek hold
  // the redacted wording the owner approved at PROPOSE time; confirmSeek forages
  // this stored string verbatim (WYSIWYG — no second gate). The status union
  // also gains 'proposed'/'cancelled' but the column has no CHECK constraint, so
  // that is a TypeScript-only change (no SQL here). Nullable-TEXT ADD COLUMN is
  // safe on the STRICT table; social_seek is created unconditionally by v19.
  // See docs/superpowers/specs/2026-07-20-p4-seek-confirm-design.md.
  (db) => {
    db.exec(`
      ALTER TABLE social_seek ADD COLUMN redacted_topic TEXT;
      ALTER TABLE social_seek ADD COLUMN redacted_city TEXT;
    `)
  },
  ```

- [ ] **1d. GREEN — store.** In `src/core/social-seek-store.ts`: widen `SeekRow.status` to the six-member union above; add `redacted_topic: string | null` + `redacted_city: string | null` to `SeekRow`; add `propose` to `SeekStore` + its impl:
  ```ts
  const insProposed = db.query<unknown, [string, string, string, string, string | null, string, string]>(
    `INSERT INTO social_seek(id, kind, topic, status, redacted_topic, redacted_city, hop, peers_asked, created_at, updated_at)
     VALUES (?, ?, ?, 'proposed', ?, ?, 1, 0, ?, ?)`,
  )
  // …in the returned object:
  propose(s) {
    const now = new Date().toISOString()
    insProposed.run(s.id, s.kind, s.topic, s.redactedTopic, s.redactedCity ?? null, now, now)
  },
  ```
  `create`/`update`/`list`/`get` are unchanged (`SELECT *` already carries the new columns).

  Run: `bun run test src/lib/db.test.ts src/core/social-seek-store.test.ts` → GREEN. Then `bun run typecheck` (`SeekRow` widening ripples only into the broker/wire in later tasks — verify no unrelated break) · `bun run depcheck`.

- [ ] **1e. COMMIT** — `feat(social): P4 v24 migration + SeekStore.propose (proposed/cancelled + redacted cols)`.

---

## Task 2 — Broker split: propose / confirmSeek / cancelSeek + pre-gated forage (WYSIWYG)

**Gates:** `bun run test src/core/social-broker.test.ts src/daemon/bootstrap.test.ts` · `bun run typecheck` · `bun run depcheck`

The behavioral heart. `forage` stops gating (it now trusts a pre-gated string); gating moves entirely into `propose` (and, transitionally, into the `seek()` alias). The old `broker.test.ts` double-gate assertions no longer describe the code and are rewritten. **This task ALSO reworks `resumeForaging` in `wire-social.ts` in the same commit (C1 safety coupling — see Global Constraints §5 / red-window note):** de-gating `forage` without fixing resume would silently re-broadcast the RAW topic on every restart.

- [ ] **2a. RED — new broker suite.** Rewrite `src/core/social-broker.test.ts` around the split. `stubDeps` gains `proposeRow`/`readSeek`/`markStatus` (default no-op + an in-memory row map so `confirmSeek` can read back a proposed row). Cover:
  - **propose gates + persists, sends nothing:** `propose('找搭子')` with a passing `cheapEval` → `{ ok:true, intent_id, redacted:'找搭子' }`; `proposeRow` was called with `redactedTopic:'找搭子'`; `discover`/`send`/`schedule` counters all `0`.
  - **propose gate-reject → nothing persisted:** `cheapEval` returns `violation:true` → `{ ok:false, reason:… }`; `proposeRow` NOT called.
  - **propose gates city:** `propose('找搭子', { city:'Beijing' })` with a two-call `cheapEval` (topic clean, city `'<CITY>'`) → result `redacted_city:'<CITY>'`; `proposeRow` got `redactedCity:'<CITY>'`. City blocked → `redactedCity` omitted/null, propose still ok.
  - **WYSIWYG confirm:** seed a `proposed` row via `proposeRow` map with `redactedTopic:'寻找摄影伙伴【已清理】'`; `confirmSeek(id)` → `markStatus(id,'foraging')` called; the scheduled `forage` runs and the captured `send` card `topic` **=== `'寻找摄影伙伴【已清理】'`** (byte-identical to the stored string); **`cheapEval` was NOT called during confirm/forage** (spy count stays at its pre-confirm value — proves no re-gate).
  - **confirm carries stored redacted city verbatim** to `card.city`.
  - **confirm on a non-proposed row** (status `'foraging'` / missing) → `{ ok:false, reason:'not_proposed' }`; no `markStatus`, no `schedule`.
  - **cancel:** proposed → `{ ok:true }` + `markStatus(id,'cancelled')`. Second cancel on the now-cancelled row → `{ ok:true }` idempotent, no throw. Missing id → `{ ok:false, reason:'not_found' }`.
  - **forage-pre-gated preserved invariants:** first-echo `first:true`; one bad peer doesn't abort; a `recordEcho` throw never escapes; degree-2 relay echoes recorded (port the existing assertions, but drive them via `propose`+`confirmSeek` instead of `seek`).
  - **`seek()` alias smoke (bridge):** `seek('找搭子')` still returns `{ intent_id }`, sows a `foraging` row (via `sow`), schedules a forage whose card `topic` is the redacted string; gate-block → nothing sown/sent/scheduled. (Two or three assertions — just enough to prove the bridge is intact; deleted in Task 7.)

  Run: `bun run test src/core/social-broker.test.ts` → RED.

- [ ] **2b. GREEN — broker impl.** In `src/core/social-broker.ts`:
  - Add `proposeRow`/`readSeek`/`markStatus` to `BrokerDeps` (see Interfaces block).
  - Change `forage(intentId, topic, opts?)` to treat `topic` and `opts.city` as **already gated**: delete both `gateOutbound` calls; build the card with `topic` verbatim and `city: opts.city` verbatim (when present). Everything from `discover` onward is unchanged.
  - Add `propose(topic, opts?)`: `newIntentId()`; `gateOutbound(topic)` → `!ok` return `{ ok:false, reason: gated.violations.join('; ') || 'blocked' }`; if `opts.city`, `gateOutbound(city)` → keep `redactedCity` only when ok (else omit — safe degradation); `deps.proposeRow(intent, { topic, redactedTopic: gated.redacted, redactedCity })`; return `{ ok:true, intent_id: intent, redacted: gated.redacted, ...(redactedCity ? { redacted_city: redactedCity } : {}) }`.
  - Add `confirmSeek(intentId)`: `row = deps.readSeek(intentId)`; if `!row || row.status !== 'proposed'` → `{ ok:false, reason:'not_proposed' }`; `deps.markStatus(intentId, 'foraging')`; `schedule(() => forage(intentId, row.redacted_topic!, row.redacted_city ? { city: row.redacted_city } : undefined))`; return `{ ok:true, intent_id: intentId }`.
  - Add `cancelSeek(intentId)`: `row = deps.readSeek(intentId)`; if `!row` → `{ ok:false, reason:'not_found' }`; if `row.status !== 'proposed'` → `{ ok:true }` (idempotent); `deps.markStatus(intentId, 'cancelled')`; return `{ ok:true }`.
  - Keep `seek(topic, opts?)` as a **deprecated alias** (comment: `// DEPRECATED — deleted in P4 Task 7; bridges pre-split callers`). Reimplement it on the new pre-gated `forage`: `gateOutbound(topic)` → `!ok` return `{ intent_id }` (sow nothing); gate city; `deps.sow(intent, topic)`; `schedule(() => forage(intent, gated.redacted, redactedCity ? { city: redactedCity } : undefined))`; return `{ intent_id }`. (Gating that used to live in `forage` now lives here, so alias callers keep byte-for-byte behavior: a `foraging` row + a redacted broadcast.)

  Run: `bun run test src/core/social-broker.test.ts` → GREEN. `bun run typecheck` · `bun run depcheck`.

- [ ] **2c. RED — resume discriminator tests (C1).** In `src/daemon/bootstrap.test.ts` (the resume region, ~L1485) add TWO tests that exercise the REAL discriminator — the wording that actually goes out on resume — via a capturing peer. Register a stub A2A peer whose `send`/intent endpoint records the received `card.topic` (either a local mock server as the existing social tests use, or by injecting a capturing `a2aClient` into `wireSocial`), then call `boot.resumeForaging()` (or trigger the boot-scan) and assert:
  - **Redacted-row case (the real bug catcher):** a `foraging` row whose `redacted_topic = '寻找搭子【已清理】'` while `topic = '找搭子 联系我 138…'` (raw differs) → the captured outbound `card.topic` **=== `'寻找搭子【已清理】'`** (the STORED redacted string, NOT `row.topic`). This is the assertion the old crash-mid-forage test lacked — it seeds `redacted_topic=null` and never checks `card.topic`.
  - **Legacy/null-redacted case:** a `foraging` row with `redacted_topic = null` and a raw `topic` → resume RE-GATES (assert `gateOutbound`/`cheapEval` was invoked for that topic) and the captured `card.topic` === the gate's redacted output — never the raw string. A row whose re-gate is BLOCKED → no outbound send for it (safe-closed).

  Run: `bun run test src/daemon/bootstrap.test.ts` → RED.

- [ ] **2d. GREEN — resume rework.** In `src/daemon/bootstrap/wire-social.ts`, inside the `if (configuredAgent.social_enabled && …)` block (where `socialPolicy`/`socialCheapEval`/`gateOutbound`/`broker` are in scope), assign a per-row resume closure that knows how to gate, and have the outer `resumeForaging` call it:
  ```ts
  // inside the block, next to `socialForage = …`:
  socialResumeRow = async (row) => {
    // forage() is now DE-GATED (Task 2) — it broadcasts its argument verbatim.
    // A propose→confirm row carries redacted_topic (+ redacted_city): forage it
    // verbatim (WYSIWYG survives the restart). A legacy/bridge row has
    // redacted_topic=null (pre-v24 rows + seek()-alias sows) — RE-GATE here so a
    // RAW topic can never reach the de-gated forage. (M1 city fix: resume now
    // carries redacted_city too — the old "social_seek doesn't persist city"
    // comment is stale and removed.)
    if (row.redacted_topic != null) {
      await broker.forage(row.id, row.redacted_topic, row.redacted_city ? { city: row.redacted_city } : undefined)
      return
    }
    const gated = await gateOutbound(row.topic, { policy: socialPolicy, cheapEval: socialCheapEval })
    if (!gated.ok) return   // blocked at resume → nothing exposed (legacy rows have no persisted city to carry)
    await broker.forage(row.id, gated.redacted)
  }
  ```
  Add `let socialResumeRow: ((row: import('../../core/social-seek-store').SeekRow) => Promise<void>) | undefined` beside the other `let social…` declarations, and remove the now-dead `socialForage` `let`/assignment (it was ONLY consumed by the old `resumeForaging`, now superseded by `socialResumeRow`). Rewrite the outer `resumeForaging` to drive it (still `status === 'foraging'` ONLY):
  ```ts
  const resumeForaging = (): void => {
    if (socialResumeRow && socialSeekStore) {
      const resume = socialResumeRow
      for (const row of socialSeekStore.list()) {
        if (row.status === 'foraging') {
          void resume(row).catch(err => deps.log('SOCIAL_REC', `resume forage failed intent=${row.id}: ${err instanceof Error ? err.message : String(err)}`))
        }
      }
    }
  }
  ```
  Delete the stale M3 "social_seek doesn't persist `city`" comment.

  Run: `bun run test src/core/social-broker.test.ts src/daemon/bootstrap.test.ts` → GREEN. `bun run typecheck` · `bun run depcheck`.

- [ ] **2e. COMMIT** — `feat(social): P4 broker propose/confirmSeek/cancelSeek + pre-gated forage (WYSIWYG); resume forages stored redacted / re-gates legacy rows; seek() kept as bridge`.

---

## Task 3 — Routes (delete one-shot, add three, tiers) + MCP tool repoint + wire-social

**Gates:** `bun run test src/daemon/internal-api/routes-social.test.ts src/daemon/internal-api/route-tiers.test.ts src/daemon/internal-api/schema.test.ts src/daemon/bootstrap.test.ts` · `bun run typecheck` · `bun run depcheck`

- [ ] **3a. RED — route + tier + schema + 503 tests.** Create `src/daemon/internal-api/routes-social.test.ts` (there is none today) driving `socialRoutes(deps)` with a stub `deps.social.broker`:
  - `POST /v1/social/seek/propose` with `{ topic, city }` → calls `broker.propose(topic, { city })`, 200 with the propose result; `deps.social` undefined → 503 `social_not_wired`.
  - `POST /v1/social/seek/confirm` with `{ id }` → `broker.confirmSeek(id)`, 200; missing/empty `id` → 400 `missing_id`; `deps.social` undefined → 503.
  - `POST /v1/social/seek/cancel` with `{ id }` → `broker.cancelSeek(id)`, 200; missing id → 400; undefined social → 503.
  - Assert the OLD key is gone: `socialRoutes(deps)` has NO `'POST /v1/social/seek'` property.

  In `src/daemon/internal-api/route-tiers.test.ts` add: `minTierFor('POST /v1/social/seek/propose') === 'trusted'` (and confirm/cancel); `minTierFor('POST /v1/social/seek') === 'admin'` still holds ONLY as the fail-closed default (i.e. the explicit key is removed) — assert the key is absent from `ROUTE_MIN_TIER`.

  In `src/daemon/internal-api/schema.test.ts` update the hard-count (`schema lookup tables` → "REQUEST_SCHEMAS has 31 entries") from **31 → 30** and the accompanying tally comment (drop the "+ 1 social/seek" line).

  In `src/daemon/bootstrap.test.ts` (site #9, ~L1658-1667) repoint the "returns 503 when the social broker is not wired" test from `POST /v1/social/seek` to `POST /v1/social/seek/propose` (still asserting 503) and fix the now-stale comment (the route is `trusted`, not admin — the minted admin token still meets it; a `trusted` file token would also work).

  Run: `bun run test src/daemon/internal-api/routes-social.test.ts src/daemon/internal-api/route-tiers.test.ts src/daemon/internal-api/schema.test.ts src/daemon/bootstrap.test.ts` → RED.

- [ ] **3b. GREEN — routes.** In `src/daemon/internal-api/routes-social.ts` DELETE the `'POST /v1/social/seek'` handler and add:
  ```ts
  'POST /v1/social/seek/propose': async (_q, body) => {
    if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
    const { topic, city } = (body ?? {}) as { topic?: string; city?: string }
    if (typeof topic !== 'string' || topic.length === 0) return { status: 400, body: { error: 'missing_topic' } }
    const r = await deps.social.broker.propose(topic, city ? { city } : undefined)
    return { status: 200, body: r }
  },
  'POST /v1/social/seek/confirm': async (_q, body) => {
    if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
    const id = ((body ?? {}) as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) return { status: 400, body: { error: 'missing_id' } }
    return { status: 200, body: await deps.social.broker.confirmSeek(id) }
  },
  'POST /v1/social/seek/cancel': async (_q, body) => {
    if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
    const id = ((body ?? {}) as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) return { status: 400, body: { error: 'missing_id' } }
    return { status: 200, body: await deps.social.broker.cancelSeek(id) }
  },
  ```
  The three new routes are **inline-validated in the handler** (the `typeof topic`/`typeof id` guards above) — they get NO `REQUEST_SCHEMAS` entry, following the precedent of the pair/inbound routes (`routes.ts` validates their bodies inline). So in `src/daemon/internal-api/schema.ts` DELETE `SocialSeekRequest` (the `export const` at ~L398) and its route→schema map entry `'POST /v1/social/seek': SocialSeekRequest` (~L562). (The `schema.test.ts` 31→30 count was already flipped in 3a.)

- [ ] **3c. GREEN — tiers.** In `src/daemon/internal-api/route-tiers.ts` remove the `'POST /v1/social/seek': 'admin'` line and add, in the trusted block:
  ```ts
  // trusted (RESOLVED, P4 spec §3.3) — the CLI (social propose/confirm/cancel)
  // holds only the daemon-wide FILE token (→ trusted); an admin-tiered route
  // would 403 every CLI call. internal-api is 127.0.0.1 + 0600 file token = the
  // owner. confirm IS the real "broadcast to strangers" step, so FLAG all three
  // for the release security review. See docs/superpowers/specs/2026-07-20-p4-seek-confirm-design.md.
  'POST /v1/social/seek/propose': 'trusted',
  'POST /v1/social/seek/confirm': 'trusted',
  'POST /v1/social/seek/cancel': 'trusted',
  ```

- [ ] **3d. GREEN — types + wire-social.** In `src/daemon/internal-api/types.ts` change `social.broker` to:
  ```ts
  broker: {
    propose(topic: string, opts?: { city?: string }): Promise<import('../../core/social-broker').ProposeResult>
    confirmSeek(id: string): Promise<import('../../core/social-broker').ConfirmResult>
    cancelSeek(id: string): Promise<import('../../core/social-broker').CancelResult>
  }
  ```
  In `src/daemon/bootstrap/wire-social.ts`: expose the new methods on `socialBroker` (keep `seek` too, as a structural superset bridge until Task 7) and wire the three new `BrokerDeps` from the seek store:
  ```ts
  // new BrokerDeps wiring inside makeBroker({ … }):
  proposeRow: (intentId, r) => {
    try { seekStore.propose({ id: intentId, kind: 'seek', topic: r.topic, redactedTopic: r.redactedTopic, redactedCity: r.redactedCity ?? null }) }
    catch (err) { deps.log('SOCIAL_REC', `propose failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`) }
  },
  readSeek: (intentId) => {
    const row = seekStore.get(intentId)
    return row ? { status: row.status, redactedTopic: row.redacted_topic, redactedCity: row.redacted_city } : null
  },
  markStatus: (intentId, status) => {
    try { seekStore.update(intentId, { status }) }
    catch (err) { deps.log('SOCIAL_REC', `markStatus failed intent=${intentId} status=${status}: ${err instanceof Error ? err.message : String(err)}`) }
  },
  // …then:
  socialBroker = {
    seek: (topic, opts) => broker.seek(topic, opts),            // bridge (Task 7 deletes)
    propose: (topic, opts) => broker.propose(topic, opts),
    confirmSeek: (id) => broker.confirmSeek(id),
    cancelSeek: (id) => broker.cancelSeek(id),
  }
  ```
  Update `SocialWiring.social.broker` + `SocialDeps` typedefs to the superset shape, and the returned `social: { broker: socialBroker, … }` object (unchanged wiring; `seekStore` is already exposed for the dispatch seam in Task 4). `resumeForaging` was ALREADY reworked in Task 2 (2d) — no further change here beyond wiring the new `BrokerDeps`.

- [ ] **3e. GREEN — MCP tool repoint.** In `src/mcp-servers/wechat/tools-social.ts`: POST to `/v1/social/seek/propose`; return the propose result plus a `hint`; rewrite the tool description to instruct the model to relay the preview:
  ```ts
  description: '就某个话题向外部 A2A agent 网络"提案"一条觅食心愿——本工具只生成脱敏预览并暂存(proposed),不会立即广播。返回 { intent_id, redacted, hint }。请把 redacted 预览转述给主人,并让主人回「派 <id>」才真正发出、或「取消 <id>」作废。仅管理员可用。',
  // …
  const resp = await client.request<{ intent_id?: string; redacted?: string }>('POST', '/v1/social/seek/propose', { topic, city })
  const hint = '已生成脱敏预览并暂存;请向主人展示 redacted,并请主人回「派 ' + (resp.intent_id ?? '<id>') + '」发出,或「取消 ' + (resp.intent_id ?? '<id>') + '」作废。'
  return { content: [{ type: 'text', text: JSON.stringify({ ...resp, hint }) }] }
  ```

  Run: `bun run test src/daemon/internal-api/routes-social.test.ts src/daemon/internal-api/route-tiers.test.ts src/daemon/internal-api/schema.test.ts src/daemon/bootstrap.test.ts` → GREEN (bootstrap stays green: `boot.social!.broker.seek` still exists via the bridge; the 503 test now hits `/propose`). `bun run typecheck` · `bun run depcheck`.

- [ ] **3f. COMMIT** — `feat(social): P4 propose/confirm/cancel routes (trusted, flagged, inline-validated) + delete one-shot seek route + schema decls + repoint MCP tool`.

---

## Task 4 — 派 / 取消 WeChat command + dispatch seam (prefix match)

**Gates:** `bun run test src/core/seek-command.test.ts src/daemon/wiring/pipeline-deps-social-dispatch.test.ts` · `bun run typecheck` · `bun run depcheck`

- [ ] **4a. RED — pure parse + resolve + 派-collision guard (I2).** Create `src/core/seek-command.test.ts`:
  - `parseSeekCommand('派 abc123def')` → `{ kind:'confirm', ref:'abc123def' }`; leading `#` tolerated (`派 #abc123`); `取消 abc123` → `{ kind:'cancel', ref:'abc123' }`; bare `派` / non-command / `派多个 词` (single token only) → `null`.
  - **Delegate-collision guard:** the token is constrained to an id-like charset (`[0-9a-fA-F-]+`), so `parseSeekCommand('派 家里 跑 拉日志')` → `null` (multi-token AND non-id) and `parseSeekCommand('派 家里跑任务')` → `null` (single token but CJK / contains 跑 → not id-charset). A real id-ish token (`派 3f9a2b`) → confirm. This makes the parser structurally disjoint from `admin-commands.ts`'s `DELEGATE_RE` even if it were reached.
  - `resolveSeekRef` against a `SeekRow[]`: exact full-id match (any length) → `{ ok:true, id }`; unique ≥6-char prefix among `proposed` rows → `{ ok:true, id }`; prefix matching ≥2 proposed rows → `{ ok:false, reason:'ambiguous' }`; prefix <6 chars with no exact match → `{ ok:false, reason:'ambiguous' }` (nudge to a longer prefix); no match → `{ ok:false, reason:'not_found' }`; a prefix that only matches a NON-proposed row → `{ ok:false, reason:'not_found' }`.

  Run: `bun run test src/core/seek-command.test.ts` → RED.

- [ ] **4b. GREEN — pure module.** Create `src/core/seek-command.ts` (mirrors `pair-command.ts` / `reveal-command.ts`):
  ```ts
  import type { SeekRow } from './social-seek-store'
  export type SeekCommand = { kind: 'confirm'; ref: string } | { kind: 'cancel'; ref: string }
  // The ref is an intent_id (randomUUID) or a prefix of one — hex + hyphen ONLY.
  // Constraining the charset makes 派 <id> structurally disjoint from
  // admin-commands.ts's DELEGATE_RE (让/派 <hand> 执行/跑 <task>): a token
  // containing 执行/跑 or any CJK hand name can never match [0-9a-fA-F-]+.
  const REF = '#?([0-9a-fA-F-]+)'
  export function parseSeekCommand(text: string): SeekCommand | null {
    const t = text.trim()
    let m = t.match(new RegExp(`^派\\s+${REF}$`));   if (m) return { kind: 'confirm', ref: m[1]! }
    m = t.match(new RegExp(`^取消\\s+${REF}$`));      if (m) return { kind: 'cancel',  ref: m[1]! }
    return null
  }
  export type SeekRefResolution = { ok: true; id: string } | { ok: false; reason: 'not_found' | 'ambiguous' }
  export function resolveSeekRef(ref: string, rows: SeekRow[]): SeekRefResolution {
    const proposed = rows.filter(r => r.status === 'proposed')
    const exact = proposed.find(r => r.id === ref)
    if (exact) return { ok: true, id: exact.id }
    if (ref.length < 6) return { ok: false, reason: 'ambiguous' }   // too short to prefix-match safely
    const hits = proposed.filter(r => r.id.startsWith(ref))
    if (hits.length === 1) return { ok: true, id: hits[0]!.id }
    if (hits.length > 1)  return { ok: false, reason: 'ambiguous' }
    return { ok: false, reason: 'not_found' }
  }
  ```

- [ ] **4c. RED — dispatch seam test.** In `src/daemon/wiring/pipeline-deps-social-dispatch.test.ts` (extend; it already stubs `boot.social` + admin), add: with a `boot.social` whose `seekStore.list()` returns one `proposed` row and a spy `broker.confirmSeek`/`cancelSeek`:
  - admin sends `派 <6+ char prefix>` → `confirmSeek(fullId)` called; a reply containing `已发出,觅食中` was sent via `boot.sendAssistantText`; `boot.coordinator.dispatch` NOT called.
  - `取消 <id>` → `cancelSeek` called; reply `已作废`.
  - `派 <unknown>` → no confirmSeek; reply `这条心愿不存在或已处理`.
  - ambiguous prefix → reply asking for a longer prefix; no confirmSeek.
  - non-admin sends `派 …` → falls through to `boot.coordinator.dispatch` (no social action).
  - **Delegate coexistence (I2):** an admin `派 家里 跑 拉日志` — a delegate command — does NOT hit `confirmSeek`/`cancelSeek`; it falls through this seam (`parseSeekCommand` returns null on the non-id token) toward normal handling. **Middleware ordering makes this doubly safe:** `makeMwAdmin` runs BEFORE `makeMwDispatch` (see `src/daemon/inbound/build.ts` — admin at index ~60, dispatch last ~73), so `admin-commands.ts`'s `DELEGATE_RE` already consumes `派 <hand> 跑/执行 <task>` before it ever reaches this dispatch seam. This seam's id-charset parser is the belt to that suspenders. (This test drives the dispatch seam directly, so it asserts the belt: `派 家里 跑 …` → no seek action, dispatch called.)

  Run: `bun run test src/daemon/wiring/pipeline-deps-social-dispatch.test.ts` → RED.

- [ ] **4d. GREEN — dispatch wiring.** In `src/daemon/wiring/pipeline-deps.ts`, import `{ parseSeekCommand, resolveSeekRef }`, and inside the `dispatch.coordinator.dispatch` closure add a block **after** the `配对` block and **before** `return boot.coordinator.dispatch(msg)` (same guard idiom — `boot.social && isAdmin(msg.chatId)`, renders every outcome itself, no engine notify):
  ```ts
  if (boot.social && isAdmin(msg.chatId)) {
    const cmd = parseSeekCommand(msg.text)
    if (cmd) {
      const res = resolveSeekRef(cmd.ref, boot.social.seekStore.list())
      if (!res.ok) {
        if (boot.sendAssistantText) {
          const text = res.reason === 'ambiguous'
            ? '有多条心愿匹配这个开头,请给更长的编号(≥6 位)'
            : '这条心愿不存在或已处理'
          void boot.sendAssistantText(msg.chatId, text)
        }
        return
      }
      if (cmd.kind === 'confirm') {
        const r = await boot.social.broker.confirmSeek(res.id)
        if (boot.sendAssistantText) {
          void boot.sendAssistantText(msg.chatId, r.ok ? '已发出,觅食中…(稍后回来看回声)' : '这条心愿不存在或已处理')
        }
      } else {
        await boot.social.broker.cancelSeek(res.id)
        if (boot.sendAssistantText) void boot.sendAssistantText(msg.chatId, '已作废')
      }
      return
    }
  }
  ```
  Ensure `Bootstrap['social']` (in `src/daemon/bootstrap/types.ts` / `index.ts`) exposes `broker.confirmSeek`/`cancelSeek` + `seekStore` — it re-exports the `SocialWiring.social` shape widened in Task 3, so this is already satisfied; verify via typecheck.

  Run: `bun run test src/core/seek-command.test.ts src/daemon/wiring/pipeline-deps-social-dispatch.test.ts` → GREEN. `bun run typecheck` · `bun run depcheck`.

- [ ] **4e. COMMIT** — `feat(social): P4 派/取消 WeChat command + dispatch seam (prefix match, caller-rendered)`.

---

## Task 5 — CLI propose / confirm / cancel forms + seeks listing shows `proposed`

**Gates:** `bun run test cli.test.ts src/cli/social.test.ts` (create the latter if absent) · `bun run typecheck` · `bun run depcheck`

- [ ] **5a. RED — CLI command tests.** In `src/cli/social.test.ts` (new; mirror `cmdSocialReveal`'s injected-`fetch`/`readInfo`/`readToken` deps pattern) assert `cmdSocialPropose`/`cmdSocialConfirm`/`cmdSocialCancel` POST to `/v1/social/seek/{propose,confirm,cancel}` with the right body, print the returned preview/outcome, and fail cleanly when the daemon is down (missing `internal-api-info.json`). Also assert `cmdSocialSeeks` renders a `proposed` row (status column) — it already pads `status` to width 9 and `proposed`(8)/`cancelled`(9) both fit, so this is a no-code-change guard.

  Run: `bun run test src/cli/social.test.ts` → RED.

- [ ] **5b. GREEN — CLI functions.** In `src/cli/social.ts` add `cmdSocialPropose(stateDir, topic, opts:{ city?, json })`, `cmdSocialConfirm(stateDir, id, {json})`, `cmdSocialCancel(stateDir, id, {json})` — each reusing the exact `readInfo`/`readToken`/`post` daemon-call scaffold from `cmdSocialReveal` (they need the RUNNING daemon; the routes are trusted and the CLI holds the file token). `propose` prints `redacted` + a "回「派 <id>」发出" hint; `confirm` prints `已发出,觅食中…` / the failure reason; `cancel` prints `已作废`.

- [ ] **5c. GREEN — citty subcommands.** In `cli.ts` add `socialProposeCmd` (positional `topic`, `--city`, `--json`), `socialConfirmCmd` (positional `id`, `--json`), `socialCancelCmd` (positional `id`, `--json`), each dynamically importing from `./src/cli/social.ts`; register them under `socialCmd.subCommands` alongside `seeks/echoes/pledges/reveal`. Update the top-of-`cli.ts` USAGE block (the `wechat-cc social …` lines) to list them.

  **Surface-list check:** `cli.test.ts`'s `exposes the full migrated subcommand surface` test asserts TOP-LEVEL subcommands only; `social` is already present and there is no nested per-`social` assertion, so it does NOT change. (Optionally add nested-leaf `run`-stub parse tests via the existing `subLeaf` helper for `propose`/`confirm`/`cancel`.)

  Run: `bun run test cli.test.ts src/cli/social.test.ts` → GREEN. `bun run typecheck` · `bun run depcheck`.

- [ ] **5d. COMMIT** — `feat(social): P4 CLI social propose/confirm/cancel forms`.

---

## Task 6 — `wechat-cc social enable` (merge-persist + --status)

**Gates:** `bun run test src/cli/social-enable.test.ts cli.test.ts` · `bun run typecheck` · `bun run depcheck`

- [ ] **6a. RED — enable test.** Create `src/cli/social-enable.test.ts`:
  - On a state dir whose `agent-config.json` already has `{ bot_name:'x', a2a_agents:[…] }`, `cmdSocialEnable(dir,{status:false})` → the file now has `social_enabled:true` + the default `social_disclosure_policy` + default `mailbox_relays`, AND still has `bot_name`/`a2a_agents` (merge-persist preserved unmodeled/existing keys — same invariant `persistSelfAgentId` guarantees).
  - Defaults-only-if-absent: pre-seed `social_disclosure_policy:'我自己的策略'` + `mailbox_relays:['https://other/mailbox']` → after enable they are UNCHANGED (only `social_enabled` flips true).
  - `--status` prints the three current values (assert via captured stdout); no write on `--status`.
  - File mode is `0600` and write is atomic (tmp+rename) — assert the file exists and parses (mode assertion mirrors `self-agent-id`'s test if present).

  Run: `bun run test src/cli/social-enable.test.ts` → RED.

- [ ] **6b. GREEN — enable impl.** Create `src/cli/social-enable.ts`, copying `persistSelfAgentId`'s read-modify-write-tmp-rename idiom verbatim (do NOT use `saveAgentConfig`, which serializes the full modeled object and could drop unmodeled disk keys):
  ```ts
  export const DEFAULT_SOCIAL_DISCLOSURE_POLICY =
    '可以说我的兴趣、想找的同好或资源;不可透露我的真实姓名、住址、电话或任何联系方式,也不提及除我和收件方以外的任何第三方。'
  export const DEFAULT_MAILBOX_RELAYS = ['https://brain.youdamaster.cc/mailbox']

  export function cmdSocialEnable(stateDir: string, opts: { status: boolean }): void {
    const path = join(stateDir, 'agent-config.json')
    const raw = /* read + JSON.parse, {} on missing/parse-fail */
    if (opts.status) { /* print social_enabled / social_disclosure_policy / mailbox_relays and return */ return }
    raw.social_enabled = true
    if (raw.social_disclosure_policy == null) raw.social_disclosure_policy = DEFAULT_SOCIAL_DISCLOSURE_POLICY
    if (!Array.isArray(raw.mailbox_relays) || raw.mailbox_relays.length === 0) raw.mailbox_relays = DEFAULT_MAILBOX_RELAYS
    /* mkdirSync 0700; write tmp 0600; renameSync */
    console.log('社交已开启,重启 daemon 生效(wechat-cc restart 或桌面重启)')
  }
  ```
  No `disable` path.

- [ ] **6c. GREEN — citty subcommand.** In `cli.ts` add `socialEnableCmd` (`--status` boolean) dynamically importing `cmdSocialEnable`; register under `socialCmd.subCommands`; add the `wechat-cc social enable [--status]` USAGE line. Surface-list test unaffected (nested under `social`).

  Run: `bun run test src/cli/social-enable.test.ts cli.test.ts` → GREEN. `bun run typecheck` · `bun run depcheck`.

- [ ] **6d. COMMIT** — `feat(social): P4 wechat-cc social enable one-toggle (merge-persist + --status)`.

---

## Task 7 — e2e-ish full chain + regression sweep + delete the `seek()` bridge

**Gates:** `bun run test src/core/social-m1.e2e.test.ts src/daemon/bootstrap.test.ts src/core/social-broker.test.ts src/daemon/internal-api/routes-social.test.ts` · full `bun run test` · `bun run typecheck` · `bun run depcheck`

- [ ] **7a. RED — propose→派→echo e2e-ish.** In `src/core/social-m1.e2e.test.ts` add a new case wiring a broker over real stores (as the existing e2e does) plus the `proposeRow`/`readSeek`/`markStatus` deps backed by the seek store: `propose('找周末拍照搭子', { city:'南京' })` → assert a `proposed` row exists, `redacted_topic` persisted, `echoStore.listForSeek` empty, NO peer contacted yet; then `confirmSeek(intent_id)` → row flips to `foraging`, run the deferred jobs → the stub peer's echo lands, `card.topic` sent === the stored `redacted_topic` (WYSIWYG at the integration level). Then `cancelSeek` on a fresh proposed row → `cancelled`, never foraged.

  Run: `bun run test src/core/social-m1.e2e.test.ts` → RED (new case).

- [ ] **7b. GREEN — convert existing seek() callers.** Update the 3 pre-existing `broker.seek()` calls in `src/core/social-m1.e2e.test.ts` (L93/165/229) to `const { intent_id } = (await broker.propose(...)) ; await broker.confirmSeek(intent_id)` (wiring the three new deps into those `makeBroker({…})` fixtures). In `src/daemon/bootstrap.test.ts`: L1088 `typeof boot.social!.broker.seek` → assert `typeof boot.social!.broker.propose === 'function'` and `confirmSeek`; L1368 and L1426 `broker.seek(…)` → `propose` + `confirmSeek`; **L1933** (site #10, the url-less-mailbox discover test) `const { intent_id } = await boot.social!.broker.seek('找摄影搭子')` → `const { intent_id } = await boot.social!.broker.propose('找摄影搭子'); await boot.social!.broker.confirmSeek(intent_id)` (the 0-peer `foraging`→`closed` poll assertion is unchanged — confirm schedules the same forage). (The "persists a social_seek row" test now observes a `proposed`→`foraging`→`closed` progression; poll for `proposed|foraging|closed`.)

- [ ] **7c. GREEN — delete the bridge + dead deps (M2).** Remove the deprecated `seek()` method from `src/core/social-broker.ts`; remove `seek` from `socialBroker` + `SocialWiring.social.broker` + `SocialDeps` in `src/daemon/bootstrap/wire-social.ts`; remove the `seek`-alias smoke tests from `src/core/social-broker.test.ts`. **M2 cleanup:** the `sow` `BrokerDep` was used ONLY by the alias (propose uses `proposeRow`, resume uses `broker.forage` directly) — remove `sow` from `BrokerDeps` + its `wire-social.ts` wiring. **Keep `SeekStore.create`** — it is still used by fixtures + the legacy-resume test (site #11) to seed `redacted_topic=null` rows, exactly the case 2d re-gates. Grep to confirm zero remaining `broker.seek(` / `\.broker\.seek` / `deps.sow`/`sow:` (broker) references and no exact `'POST /v1/social/seek'` (without a trailing segment) anywhere in `src`, `cli.ts`, tests.

  Run the task gate suite, then the FULL suite `bun run test`, then `bun run typecheck` · `bun run depcheck` — all GREEN.

- [ ] **7d. COMMIT** — `refactor(social): P4 convert last seek() callers to propose+confirm; delete deprecated seek() bridge; full regression green`.

---

## Verification checklist (end of plan)

- [ ] `POST /v1/social/seek` returns 404/unknown-route (deleted); `/propose`, `/confirm`, `/cancel` are `trusted`.
- [ ] A `social_seek` MCP call persists a `proposed` row and sends to ZERO peers; the owner's `派 <id>` is what forages; the stored redacted string is byte-identical to the broadcast card topic.
- [ ] `取消 <id>` voids; repeat is a no-op; unknown/ambiguous ids get the right one-line reply.
- [ ] Boot resume re-forages only `foraging` rows; `proposed` rows survive a restart untouched; a resumed forage broadcasts the STORED `redacted_topic` (asserted), and a legacy `redacted_topic=null` row is re-gated at resume — NEVER the raw topic (C1).
- [ ] `wechat-cc social enable` flips `social_enabled` while preserving every other config key; defaults apply only when absent; `--status` reads without writing.
- [ ] `bun run test` (full) · `bun run typecheck` · `bun run depcheck` all green; no `.skip`; no new npm dependency; `apps/desktop/**` untouched.
