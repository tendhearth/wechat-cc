# Proactive Care (主动关心) + Calibration Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-chat proactive care — agenda-driven check-ins + gap fallback — gated by a pure calibration engine (`shouldSpeak`) with three user-configurable levels and one learned pause signal.

**Architecture:** Extends the EXISTING companion pushTick/agenda machinery (at-most-once, in-flight skip, per-chat tier). New pure pieces: `calibration.ts` (gate), `care-ledger.ts` (learned-signal state). Config rides the existing chat-prefs store (`care` key + `/set care` + a new `set_chat_pref` MCP tool/route). The prompt gains a care section gated per-chat (requires threading `chatId` through the `buildInstructions` seam).

**Tech Stack:** TypeScript, vitest via `bun --bun vitest run <file>`, existing state-store / chat-prefs / agenda / tick-bodies / prompt-builder.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-proactive-care-design.md`. Binding invariants:
  - 问候模式永远用户可配置 (per-chat state, never hardcoded policy).
  - Levels `off|low|high`; owner chat (`default_chat_id`) unset ⇒ `low`; others unset ⇒ `off`.
  - `shouldSpeak` is THE single chokepoint; every deny carries a `reason`.
  - agenda care: cooldown ≥20h since lastProactive; NOT paused by no-reply signal.
  - gap check-in: needs days-since-lastInbound ≥ N AND days-since-lastProactive ≥ N (N=7 low, N=2 high), `noReplyCount < 2`, and NEVER fires for a chat with no inbound history (no cold-opens).
  - Ledger claim (lastProactiveAt=now, noReplyCount+=1) happens BEFORE dispatch (at-most-once); ANY inbound resets that chat's noReplyCount to 0.
  - Zero LLM when silent; existing e2e unaffected (harness sets no care prefs and no default_chat_id ⇒ ticks silent).
  - EXACTLY ONE instance each of chat-prefs and care-ledger per daemon (stale-cache hazard).
- TDD every task; `bunx tsc --noEmit` clean before each commit; explicit `git add <files>` only (tree may hold unrelated WIP).

---

## File Structure

- Create `src/daemon/companion/calibration.ts` + test — `careLevel`, `shouldSpeak` (pure).
- Create `src/daemon/companion/care-ledger.ts` + test — ledger store.
- Modify `src/daemon/chat-prefs.ts` (+test) — `care` key + `list()`.
- Modify `src/daemon/mode-commands.ts` (+test) — `/set care|关心`.
- Modify `src/mcp-servers/wechat/tools-companion.ts`, `src/daemon/internal-api/routes.ts`, `src/daemon/internal-api/route-tiers.ts`, `src/core/user-tier.ts` (+tests) — `set_chat_pref` tool + `POST /v1/chat-prefs` + classification.
- Modify `src/core/prompt-builder.ts` (+test), `src/core/session-manager.ts`, `src/daemon/bootstrap/index.ts` — care section + chatId through the seam.
- Modify `src/lib/messages-store.ts` (+test) — `latestInboundTs`.
- Modify `src/daemon/wiring/tick-bodies.ts` (+test) — multi-chat loop + gap branch.
- Modify `src/daemon/main.ts`, `src/daemon/wiring/index.ts`, `src/daemon/inbound/mw-activity.ts` (or side-effects wiring) — instances + inbound reset.

---

### Task 1: calibration — `careLevel` + `shouldSpeak` (pure)

**Files:** Create `src/daemon/companion/calibration.ts`, `src/daemon/companion/calibration.test.ts`

**Interfaces (later tasks compile against these exact names):**
```ts
export type CareLevel = 'off' | 'low' | 'high'
export type CareKind = 'agenda' | 'gap'
export interface CareLedgerEntry { lastProactiveAtIso?: string; noReplyCount: number }
export function careLevel(chatId: string, prefs: { care?: CareLevel }, defaultChatId: string | undefined): CareLevel
export function shouldSpeak(args: { kind: CareKind; level: CareLevel; nowIso: string; ledger: CareLedgerEntry; lastInboundAtIso?: string }): { ok: true } | { ok: false; reason: string }
```

- [ ] **Step 1: failing test** — table-driven, covering: `careLevel` (unset+owner⇒low, unset+other⇒off, explicit wins); `off` never; agenda allowed at low+high; agenda cooldown boundary (19h59m since lastProactive ⇒ deny `agenda_cooldown`, 20h01m ⇒ ok, no lastProactive ⇒ ok); gap N=7 low / N=2 high on BOTH gaps (inbound 8d ago but proactive 1d ago ⇒ deny `gap_proactive_recent`); `noReplyCount:2` ⇒ deny `paused_no_reply` (gap only — agenda still ok at count 2); no `lastInboundAtIso` ⇒ deny `never_talked`. Compute ISO strings with fixed dates (e.g. now `2026-07-09T12:00:00Z`), no `new Date()`.
- [ ] **Step 2:** run `bun --bun vitest run src/daemon/companion/calibration.test.ts` → FAIL (module not found).
- [ ] **Step 3: implement** —
```ts
const HOUR = 3_600_000
const DAY = 24 * HOUR
const AGENDA_COOLDOWN_MS = 20 * HOUR
const GAP_DAYS: Record<'low' | 'high', number> = { low: 7, high: 2 }
const PAUSE_AFTER_NO_REPLIES = 2
```
`careLevel`: `prefs.care ?? (chatId === defaultChatId ? 'low' : 'off')` (defaultChatId undefined ⇒ never owner). `shouldSpeak`: parse ISO with `Date.parse`; `off`⇒`{ok:false,reason:'care_off'}`; agenda: lastProactive within cooldown ⇒ `agenda_cooldown` else ok; gap: no lastInbound ⇒ `never_talked`; `noReplyCount >= PAUSE_AFTER_NO_REPLIES` ⇒ `paused_no_reply`; `now - lastInbound < N*DAY` ⇒ `gap_inbound_recent`; lastProactive set and `now - lastProactive < N*DAY` ⇒ `gap_proactive_recent`; else ok.
- [ ] **Step 4:** tests pass; `bunx tsc --noEmit` clean.
- [ ] **Step 5:** `git add src/daemon/companion/calibration.ts src/daemon/companion/calibration.test.ts && git commit -m "feat(care): calibration gate — careLevel + shouldSpeak (pure)"`

---

### Task 2: care-ledger store

**Files:** Create `src/daemon/companion/care-ledger.ts`, `src/daemon/companion/care-ledger.test.ts`

**Interfaces:**
```ts
export interface CareLedger {
  get(chatId: string): CareLedgerEntry            // missing ⇒ { noReplyCount: 0 }
  claim(chatId: string, nowIso: string): void      // lastProactiveAtIso=nowIso, noReplyCount+=1 (the at-most-once claim)
  resetNoReply(chatId: string): void               // noReplyCount=0 (keeps lastProactiveAtIso); no-op if entry missing
}
export function makeCareLedger(stateDir: string, deps?: { store?: StateStore }): CareLedger
```
File `<stateDir>/care_ledger.json`, `makeStateStore(..., { debounceMs: 0 })`, JSON-encoded entries — mirror `src/daemon/chat-prefs.ts` exactly (corrupt value ⇒ default entry).

- [ ] **Step 1: failing test** — get-missing default; claim sets ts + increments (twice ⇒ count 2); resetNoReply zeroes count but keeps ts; reset on missing entry doesn't create garbage (get still default); write-through round-trip via a FRESH `makeCareLedger(dir)`; corrupt value ⇒ default (injectable store seam like chat-prefs' test).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement per chat-prefs pattern. **Step 4:** pass + tsc clean.
- [ ] **Step 5:** `git add src/daemon/companion/care-ledger.ts src/daemon/companion/care-ledger.test.ts && git commit -m "feat(care): care ledger — proactive claims + no-reply learning signal state"`

---

### Task 3: chat-prefs `care` key + `list()` + `/set care`

**Files:** Modify `src/daemon/chat-prefs.ts` (+test), `src/daemon/mode-commands.ts` (+test)

**Interfaces:** `ChatPrefs` gains `care?: 'off' | 'low' | 'high'`. `ChatPrefsStore` gains `list(): string[]` (chat ids present in the underlying store — implement via `store.all()` keys). `/set` extends: bare `/set` also shows `care` state (`关心: off|low|high`, showing the RAW pref or `未设置`); `/set care off|low|high` with alias `关心` and value aliases `关→off 低→low 高→high`. Unknown value ⇒ usage reply, no write. The usage/help strings must mention both keys (`split`, `care`).

- [ ] **Step 1: failing tests** — chat-prefs: `list()` empty then contains ids after set; `care` round-trips and merges alongside `split` (set split then care ⇒ both present). mode-commands: `/set care high` persists `{care:'high'}` and confirms; `/set 关心 关` ⇒ `{care:'off'}`; `/set care maybe` ⇒ usage, no write; bare `/set` output contains both `split` and `care`(or 关心). Update the test fake chatPrefs to expose `list` if the dep type requires it (mode-commands only needs get/set — keep its dep shape minimal: do NOT add list to ModeCommandsDeps).
- [ ] **Step 2:** run both test files → new tests FAIL.
- [ ] **Step 3: implement** — chat-prefs: add field + `list(): string[] { return Object.keys(store.all()) }`. mode-commands: extend the `/set` block — parse `^(split|拆分|care|关心)\s+(\S+)$`; route split values as today; care values map `on/开→ERROR (usage — care is 3-level)`, accept only `off|low|high|关|低|高`. Keep replies concise Chinese, mirror existing style. Update `/help` line to `'/set — 本对话偏好(拆分回复、主动关心档位)'`.
- [ ] **Step 4:** both files pass; tsc clean. **Step 5:** `git add src/daemon/chat-prefs.ts src/daemon/chat-prefs.test.ts src/daemon/mode-commands.ts src/daemon/mode-commands.test.ts && git commit -m "feat(care): care level in chat-prefs + /set care|关心 command"`

---

### Task 4: `set_chat_pref` tool + `POST /v1/chat-prefs` route + classification

**Files:** Modify `src/daemon/internal-api/routes.ts`, `src/daemon/internal-api/route-tiers.ts`, `src/daemon/internal-api/types.ts`, `src/mcp-servers/wechat/tools-companion.ts`, `src/core/user-tier.ts` (+ tests: `src/daemon/internal-api.test.ts`, `src/daemon/internal-api/route-tiers.test.ts` if it asserts counts, `src/core/user-tier.test.ts`)

**Interfaces:**
- `InternalApiDeps` gains `setChatPref?: (chatId: string, patch: { care?: 'off'|'low'|'high'; split?: boolean }) => { care?: string; split?: boolean }` (absent ⇒ route 503s `chat_prefs_not_wired`).
- Route `'POST /v1/chat-prefs'`: body `{ chat_id, care?, split? }`, INLINE-validated (no schema-table entry — keeps schema count tests untouched): `chat_id` non-empty string; `care` if present ∈ off|low|high; `split` if present boolean; at least one of care/split present. Returns `{ ok: true, prefs }` (read-back) or 400 with reason.
- `route-tiers.ts`: `'POST /v1/chat-prefs': 'trusted'`.
- `classifyToolUse`: `mcp__wechat__set_chat_pref` → `memory_write` (explicit mapping BEFORE the wechat fs_read fallback — a write must not classify as a read).
- Tool `set_chat_pref` in `registerCompanionTools` (mirror the existing tools' zod-input + `client.request('POST', ...)` + passthrough-error pattern; Chinese description: 调整本对话的主动关心档位/拆分偏好, mention it's for when the user expresses a preference).

- [ ] **Step 1: failing tests** — internal-api: 503 unwired; 400 missing chat_id / bad care value / empty patch; happy path calls the dep and returns read-back (vi.fn dep). user-tier: `classifyToolUse('mcp__wechat__set_chat_pref', {})` ⇒ `memory_write`. If a route-count test exists and breaks, bump its expected count (route-tiers count) — verify the test's intent is a tally, not a freeze.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement all five files. **Step 4:** pass + tsc clean.
- [ ] **Step 5:** `git add <the five source files + touched tests> && git commit -m "feat(care): set_chat_pref tool + POST /v1/chat-prefs (conversational settings)"`

---

### Task 5: prompt care section + chatId through the buildInstructions seam

**Files:** Modify `src/core/prompt-builder.ts` (+test), `src/core/session-manager.ts`, `src/daemon/bootstrap/index.ts` (+ its types if `BootstrapDeps` lives there)

**Interfaces:**
- `prompt-builder.ts`: new `export function careSection(): string` — instructs (Chinese, "when to use" framing like `daemonSelfHealSection`): during conversation, when the user mentions upcoming events/worries/feelings, author a care intention into `agenda.md` as `- [ ] due:YYYY-MM-DD 关心…` (existing format); keep care natural/specific, ≤1 per topic; when the user expresses presence preferences ("别烦我"/"多关心我"), adjust via `set_chat_pref` and confirm. `BuildSystemPromptArgs` gains `careEnabled?: boolean`; `buildSystemPrompt` appends `careSection()` when true (mirror `daemonOpsAvailable`).
- `session-manager.ts`: `buildInstructions?: (providerId, tierProfile) => string` → `(providerId, tierProfile, chatId: string) => string`; call site (~line 210) passes `req.chatId`.
- `bootstrap/index.ts`: `BootstrapDeps.buildInstructions` type matches; the implementation gains `careEnabled: (deps.careLevelFor?.(chatId) ?? 'off') !== 'off'`. `BootstrapDeps` gains optional `careLevelFor?: (chatId: string) => 'off'|'low'|'high'` (absent ⇒ care section never included — tests/embedded unaffected). Wire-up of the thunk itself happens in Task 7.

- [ ] **Step 1: failing tests** — prompt-builder: `careSection()` mentions `agenda.md`, `due:`, and `set_chat_pref`; `buildSystemPrompt({careEnabled:true,...})` contains the section, false/absent ⇒ byte-identical to before (assert absence). Check existing buildInstructions-related tests in session-manager.test.ts/bootstrap.test.ts for signature breakage and update their fakes to accept the third arg.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** affected suites (`prompt-builder`, `session-manager`, `bootstrap`) pass + tsc clean.
- [ ] **Step 5:** commit `feat(care): per-chat care prompt section (chatId through buildInstructions seam)`

---

### Task 6: messages `latestInboundTs` + tick generalization (the core)

**Files:** Modify `src/lib/messages-store.ts` (+test), `src/daemon/wiring/tick-bodies.ts` (+ `src/daemon/wiring/tick-bodies.test.ts` — check it exists; else create)

**Interfaces:**
- `MessagesStore` gains `latestInboundTs(chatId: string): Promise<string | null>` — same as `latestTs` but `AND direction='in'` (copy the prepared-statement pattern).
- `TickDeps` gains: `chatPrefs: { get(chatId): { care?: 'off'|'low'|'high' }; list(): string[] }`, `careLedger: CareLedger` (import type from `../companion/care-ledger`).
- New pure text builder in tick-bodies (exported for tests): `buildGapCheckinText(opts: { nowIso: string; chatId: string; daysSinceContact: number }): string` — Chinese; states this is a proactive gap check-in for this chat; instructs: look at what you know of them (memory), send ONE natural short greeting via reply if there's a natural hook; 如果实在没有自然的话头,可以这次不发 (ending the turn silently is fine).
- `pushTick` restructures:
  1. `cfg = loadCompanionConfig(...)`; candidates = ordered unique: `[cfg.default_chat_id (if set), ...deps.chatPrefs.list()]`.
  2. For each chat: `level = careLevel(chatId, deps.chatPrefs.get(chatId), cfg.default_chat_id)`; `off` ⇒ skip (log reason only for non-owner opted chats — avoid log spam).
  3. Agenda branch (existing logic, now per-chat path `memory/<chatId>/agenda.md`): due item exists ⇒ `shouldSpeak({kind:'agenda', level, nowIso, ledger: deps.careLedger.get(chatId), lastInboundAtIso})`; ok ⇒ claim BOTH (markResolved as today AND `deps.careLedger.claim(chatId, nowIso)`) ⇒ dispatch (existing session flow, per-chat tier/mode — reuse the current code, parameterized by chatId).
  4. No due item ⇒ gap branch: `lastInboundAtIso = await messagesStore.latestInboundTs(chatId) ?? undefined`; `shouldSpeak({kind:'gap', ...})`; ok ⇒ `deps.careLedger.claim(chatId, nowIso)` ⇒ dispatch `buildGapCheckinText(...)` (daysSinceContact computed from lastInbound).
  5. Deny ⇒ `deps.log('CARE', 'skip chat=... kind=... reason=...')`. In-flight ⇒ skip chat (existing check, per-chat).
  6. Chats processed sequentially; one chat's dispatch error must not abort the loop (per-chat try/catch, existing errMsg logging).

- [ ] **Step 1: failing tests** — messages-store: insert in+out rows, `latestInboundTs` returns latest `in` only, null when no inbound. tick-bodies (fake deps: in-memory chatPrefs/careLedger/messagesStore/ilink/boot with a recording sessionManager — mirror however existing tick/companion tests fake `boot`; if no precedent exists, build a minimal fake per `TickDeps`): (a) owner chat with due agenda item ⇒ dispatched + agenda marked + ledger claimed; (b) second chat care:high with no agenda + lastInbound 3d ago + no prior proactive ⇒ gap dispatched with text containing 天; (c) same chat noReplyCount:2 ⇒ NOT dispatched, log reason `paused_no_reply`; (d) chat with care unset (non-owner) ⇒ untouched; (e) no default_chat_id + no prefs ⇒ silent (harness/e2e invariant); (f) agenda within 20h cooldown ⇒ skipped with reason.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** target tests + `bun --bun vitest run src/daemon/` pass; tsc clean.
- [ ] **Step 5:** commit `feat(care): multi-chat care tick — agenda + gap check-in through the calibration gate`

---

### Task 7: wiring (single instances + inbound reset + careLevelFor) + full verification

**Files:** Modify `src/daemon/main.ts`, `src/daemon/wiring/index.ts` (WireMainOpts threading, mirroring chatPrefs), the `buildTickBodies(...)` call site, `src/daemon/inbound/mw-activity.ts` (+its test) or the side-effects wiring that feeds it.

- [ ] **Step 1:** main.ts: `const careLedger = makeCareLedger(stateDir)` next to `chatPrefs`. Thread BOTH into: (a) `buildTickBodies` deps (find its call site — likely wiring; add `chatPrefs, careLedger`); (b) the inbound path: extend `mw-activity`'s deps (it already receives `recordInbound(chatId, when)`) with `resetCareNoReply?: (chatId: string) => void`, called alongside recordInbound (optional ⇒ existing tests unaffected); wire `(c) => careLedger.resetNoReply(c)`. (c) bootstrap deps: `careLevelFor: (c) => careLevel(c, chatPrefs.get(c), loadCompanionConfig(stateDir).default_chat_id)` (import careLevel; note loadCompanionConfig is cheap file read — acceptable per-spawn; if bootstrap deps construction lacks stateDir access for it, compute via a thunk built in main.ts where both exist).
- [ ] **Step 2:** grep-verify single instances: `makeChatPrefs(` and `makeCareLedger(` each appear ONCE in production `src/` (tests excluded).
- [ ] **Step 3:** `bunx tsc --noEmit` clean; FULL suite `bun --bun vitest run` green (triage any failure against base via `git stash` — pre-existing only); e2e `bun --bun vitest run -c vitest.e2e.config.ts` all pass (harness sets no default_chat_id/prefs ⇒ ticks silent — invariant (e) of Task 6).
- [ ] **Step 4:** commit `feat(care): wire care ledger + careLevelFor + inbound no-reply reset`

---

## Self-Review notes (author)

- **Spec coverage:** §3→Task 3; §4→Task 4; §5→Task 1; §6→Tasks 2+7 (claim in 6, reset in 7); §7→Task 5 (+gap text in 6); §8→Task 6; §9 invariants→constraints + Task 6 test (e) + Task 7 single-instance grep; §12 open items→resolved (latestInboundTs added Task 6; buildInstructions extended Task 5; inbound hook = mw-activity Task 7).
- **Type consistency:** `CareLedgerEntry`/`CareLedger`/`careLevel`/`shouldSpeak` names flow Task 1→2→6→7; `ChatPrefsStore.list()` (Task 3) consumed by TickDeps' minimal structural type (Task 6); `careLevelFor` optional on BootstrapDeps (Task 5) wired Task 7.
- **Deliberate minimalism:** ModeCommandsDeps keeps `{get,set}` only (no list); route uses inline validation (no schema churn); mw-activity dep optional (no test churn).
- **Risk:** Task 6 is the big one (restructuring pushTick). Its per-chat try/catch + test (e) protect the e2e invariant. If tick-bodies has no existing test file, the new one builds the first fake harness for it — budget accordingly.
