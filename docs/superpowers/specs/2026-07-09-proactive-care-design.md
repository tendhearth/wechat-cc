# Design: proactive care (主动关心) + calibration engine (校准引擎)

Date: 2026-07-09
Status: approved design → writing-plans next
Roadmap: Phase 2 (2a + 2b). Builds ON the existing companion pushTick/agenda machinery. See `docs/design/roadmap.md`, `docs/design/companion-liveness-layer.md`.

## 1. Motivation

The companion segment's heart is an agent that **proactively cares** — with a
specific reason ("考完试了,考得怎么样?"), at the right frequency for THAT
person. Today's pushTick serves only the owner's chat, has no frequency/taste
regulation, and its intentions are task-flavored. Phase 2 adds: per-chat care,
a calibration gate all proactive sends pass through, and user-configurable
问候模式 (the user's explicit requirement: **users can configure and adjust
the greeting/care mode at any time**).

## 2. Scope decisions (locked)

- **对象**: per-chat infrastructure. Owner's chat (`default_chat_id`) defaults
  ON (`low`); every other chat defaults OFF, opt-in via `/set`.
- **形态**: BOTH (a) 记事式关心 (primary — agent self-authors care intentions
  into the existing per-chat `agenda.md` during normal chats) and (b) 间隔式
  兜底 (gap check-in when nothing due and no contact for N days).
- **校准**: three levels `off | low | high` + ONE learned signal (2 consecutive
  un-replied proactive sends ⇒ auto-pause gap check-ins until the user speaks
  again). Agenda-driven care is NOT paused by the signal (a specific reason is
  worth sending).
- **用户可配置 (INVARIANT, user-stated)**: the care mode is always adjustable
  by the user — via `/set 关心|care off|low|high` AND conversationally (the
  agent gets a tool to adjust it when the user says 别烦我 / 多关心我).
- **Reuse, don't rebuild**: at-most-once claim-before-dispatch, in-flight skip,
  per-chat tier resolution, mode-provider selection — all inherited from the
  existing pushTick. Zero-LLM silence when nothing is due/allowed stays true.

## 3. Per-chat care config (chat_prefs extension)

- `ChatPrefs` gains `care?: 'off' | 'low' | 'high'`.
- Effective level resolution (pure helper `careLevel(chatId, prefs, defaultChatId)`):
  unset + chatId === defaultChatId ⇒ `'low'`; unset otherwise ⇒ `'off'`;
  set ⇒ as set.
- `/set` command extends: `/set care off|low|high` (alias `关心`; values also
  accept `关|低|高`). `/set` (bare) now also shows care state.
- `ChatPrefsStore` gains `list(): string[]` (chat ids with any stored prefs) —
  needed by the tick to enumerate opted-in chats (backed by the store's `all()`).

## 4. Conversational adjustment (agent tool)

- New wechat MCP tool `set_chat_pref({ chat_id, care?, split? })` → new
  internal-api route `POST /v1/chat-prefs` (writes via the shared ChatPrefsStore,
  returns the updated prefs as read-back).
- Route tier: `trusted`. Tool classification: `classifyToolUse` maps
  `mcp__wechat__set_chat_pref` → `memory_write` (trusted+admin allowed; guests
  still have the `/set` command for their own chat — acceptable v1 asymmetry).
- Prompt (care section, §7) tells the agent: when the user expresses a presence
  preference ("别烦我" / "多关心我一点"), adjust via this tool and confirm.

## 5. Calibration gate — `shouldSpeak` (pure)

New `src/daemon/companion/calibration.ts`:

```ts
type CareKind = 'agenda' | 'gap'
interface CareLedgerEntry { lastProactiveAtIso?: string; noReplyCount: number }
shouldSpeak(args: {
  kind: CareKind
  level: 'off' | 'low' | 'high'
  nowIso: string
  ledger: CareLedgerEntry
  lastInboundAtIso?: string   // latest user message in this chat (undefined = never)
}): { ok: true } | { ok: false; reason: string }
```

Rules:
- `off` ⇒ never.
- `agenda`: allowed at low/high, subject to a per-chat cooldown of ≥20h since
  `lastProactiveAtIso` (max ~1 proactive/day/chat).
- `gap`: requires BOTH (days since lastInbound ≥ N) AND (days since
  lastProactive ≥ N), N = 7 (low) / 2 (high); AND `noReplyCount < 2` (the
  learned pause). No lastInbound ever ⇒ no gap check-in (never cold-open a
  chat that never talked to us).
- Every deny returns a `reason` string (logged — calibration must be debuggable).

## 6. Care ledger (the learning signal's state)

- New store `src/daemon/companion/care-ledger.ts`: per-chat
  `{ lastProactiveAtIso?, noReplyCount }` in `<stateDir>/care_ledger.json`
  (state-store, `debounceMs: 0`, same pattern as chat-prefs).
- Writes:
  - Tick, immediately BEFORE dispatching a proactive send (the at-most-once
    claim): set `lastProactiveAtIso = now`, `noReplyCount += 1`.
  - Inbound pipeline: ANY user message in a chat resets that chat's
    `noReplyCount` to 0 (hook alongside the existing inbound side-effects,
    e.g. where `recordInbound` is wired; exact site verified in planning).
- Interpretation: `noReplyCount ≥ 2` = the last 2+ proactive sends got no
  user message after them ⇒ gap check-ins pause until they speak.

## 7. Prompt — the care section

- `prompt-builder` gains a care section, included per-spawn when the chat's
  effective care level ≠ off (the existing `buildInstructions` seam;
  provider-agnostic like all prompt sections):
  - During normal conversation, when the user mentions upcoming events /
    worries / feelings, author a care intention into `agenda.md`
    (`- [ ] due:YYYY-MM-DD 关心…` — the EXISTING format, no new syntax).
  - Keep care natural and specific; at most one care intention per topic.
  - When the user expresses presence preferences, adjust via `set_chat_pref`.
- The gap-check-in dispatch text (a sibling of `buildPushTickText`) explicitly
  allows choosing silence: "如果实在没有自然的话头,可以这次不发" (the agent
  ending the turn without calling reply = silence; harmless).

## 8. Tick — from single-chat to care-enabled chats

`pushTick` generalizes:
1. Enumerate candidate chats: `default_chat_id` ∪ chats from
   `chatPrefs.list()` whose effective care level ≠ off.
2. Per chat (sequentially — ticks are cheap and rare):
   - Read that chat's `agenda.md`; due item? → `shouldSpeak('agenda', …)` →
     claim (markResolved + ledger) → dispatch (existing flow, that chat's
     mode/provider/tier).
   - No due item? → `shouldSpeak('gap', …)` (needs lastInbound from the
     messages store) → claim (ledger only) → dispatch the gap text.
   - Deny → log the reason, move on. In-flight session ⇒ skip (existing).
3. Owner chat's existing behavior is the special case that falls out of the
   general loop (agenda for default_chat_id, level low by default).

Non-owner chats dispatch with THAT chat's resolved tier (guest/trusted) — the
reply tool is guest-allowed, so care works even for guest-tier friends the
owner opted in; capability stays tier-appropriate automatically.

## 9. Cost & safety invariants

- **Zero LLM when silent**: enumeration + agenda parse + shouldSpeak are pure
  string/JSON ops; the agent only wakes when a send was already approved.
- **At-most-once** per intention/claim (inherited; ledger write is the claim
  for gap check-ins).
- The calibration gate is THE single chokepoint for proactive sends — future
  proactive features (news/打猎 postcards, Phase 3) must route through
  `shouldSpeak` with their own `kind`.
- 用户可配置 invariant: every knob above is per-chat user state, never
  hardcoded product policy.

## 10. Testing (TDD)

- `careLevel` + `shouldSpeak` unit tables (every rule + boundary: exactly 20h,
  exactly N days, noReplyCount 1→2 transition, never-inbound).
- care-ledger store unit tests (claim increments, inbound resets, persistence).
- `/set care` command tests (aliases, show, unknown value).
- `set_chat_pref` route tests (write + read-back, tier) + tool registration.
- Tick integration: fake stores/ilink — multi-chat enumeration; agenda claim
  + dispatch; gap fires only past thresholds; pause after 2 no-replies;
  inbound reset re-enables; owner default-on/others default-off.
- Full suite + e2e green (existing e2e must be unaffected: no care prefs set
  in harness ⇒ only default_chat_id behavior, which the harness doesn't
  configure either ⇒ ticks stay silent).

## 11. Non-goals (v1)

- Quiet hours / time-of-day preference; content-style learning; more learned
  signals; cross-instance care; news/information sharing (Phase 3); changing
  the 20m scheduler cadence.

## 12. Open items for planning

- Exact inbound hook site for the noReplyCount reset (side-effects wiring).
- How to query "latest inbound ts for chat" from the messages store (exists?
  add a small query if not).
- Whether `buildInstructions` has per-chat context available to gate the care
  section per-chat (it's per-spawn keyed by chat — verify) — else include the
  section whenever any care-enabled chat exists and let text scope it.
