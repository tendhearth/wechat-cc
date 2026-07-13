# Daily Hunt (每日打猎) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner-only daily "hunt": the tick wakes the agent (≤1/day) to web-search interesting finds per its memory and share ≤2 as a postcard, through the calibration gate.

**Architecture:** `shouldSpeak` gains kind `'hunt'` + ledger gains `lastHuntAtIso`/`claimHunt`; `pushTickForChat` gains a hunt branch (agenda > hunt > gap, owner-only); pref `hunt` on chat_prefs + `/set 打猎`. NO new wiring (shared stores already flow into the tick).

**Tech Stack:** existing calibration / care-ledger / chat-prefs / mode-commands / tick-bodies patterns; vitest via `bun --bun vitest run <file>`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-daily-hunt-design.md`. Key rules:
  - hunt eligibility: pref `hunt !== false` (caller maps to level 'low'/'off'); deny reasons `care_off` / `paused_no_reply` (noReplyCount ≥ 2) / `hunt_cooldown` (<20h since `lastHuntAtIso`) / `invalid_timestamp`; `never_talked`/gap-days rules do NOT apply to hunt.
  - Branch order in tick: agenda-due > hunt > gap; hunt ONLY when `chatId === cfg.default_chat_id`.
  - `claimHunt` (lastHuntAtIso=now, noReplyCount+=1) strictly BEFORE dispatch.
  - Exactly-20h boundary allowed (consistent with agenda's `<` semantics).
- TDD; tsc clean per commit; explicit `git add` only (unrelated WIP may exist).

---

### Task 1: calibration `'hunt'` + ledger `claimHunt`

**Files:** Modify `src/daemon/companion/calibration.ts` (+test), `src/daemon/companion/care-ledger.ts` (+test)

**Interfaces:** `CareKind` gains `'hunt'`; `CareLedgerEntry` gains `lastHuntAtIso?: string`; `CareLedger` gains `claimHunt(chatId: string, nowIso: string): void`. `shouldSpeak` hunt rules per Global Constraints (validate `lastHuntAtIso` in the existing NaN fail-closed block; order: care_off → invalid_timestamp → paused_no_reply → hunt_cooldown → ok).
- [ ] Failing tests: hunt+off ⇒ care_off; noReplyCount 2 ⇒ paused_no_reply (1 ⇒ not); 19h59m since lastHuntAtIso ⇒ hunt_cooldown, exactly 20h ⇒ ok, unset ⇒ ok; hunt ignores lastInboundAtIso entirely (ok with it absent); malformed lastHuntAtIso ⇒ invalid_timestamp; agenda/gap behavior UNCHANGED (spot-assert one each). Ledger: claimHunt sets ts + increments count, persists round-trip, does NOT touch lastProactiveAtIso; claim() does not touch lastHuntAtIso.
- [ ] RED → implement → GREEN; tsc clean.
- [ ] Commit: `feat(hunt): calibration kind 'hunt' + ledger claimHunt` (explicit paths).

### Task 2: pref + `/set 打猎`

**Files:** Modify `src/daemon/chat-prefs.ts` (+test), `src/daemon/mode-commands.ts` (+test)

- `ChatPrefs.hunt?: boolean` (doc: 每日打猎开关, undefined ⇒ ON). `/set` key regex gains `hunt|打猎`, values `on|off|开|关` (EXACT split/stickers 2-state pattern); bare `/set` shows it (raw, 未设置); help line → `'/set — 本对话偏好(拆分回复、主动关心档位、表情包、每日打猎)'`.
- [ ] Failing tests mirroring the stickers ones (on/off/开/关 persist; bad value usage no-write; bare /set shows 打猎; split/care/stickers untouched).
- [ ] RED → GREEN; tsc clean. Commit: `feat(hunt): hunt pref + /set 打猎 toggle`.

### Task 3: tick hunt branch + `buildHuntText` + full verification

**Files:** Modify `src/daemon/wiring/tick-bodies.ts` (+test)

- Export pure `buildHuntText(opts: { nowIso: string }): string` — Chinese, mirrors buildGapCheckinText's structure: 每日打猎时间 — 回顾你记忆里主人的兴趣和最近关注,用网络工具(搜索/抓取)找新鲜的、他真会感兴趣的内容;**只挑真正值得的 1-2 条**,用 reply 分享,每条一句"为什么你会感兴趣"+ 链接;**如果今天没猎到值得分享的,可以不发**(不调 reply 直接结束);别分享你们最近已经聊过的东西。
- In `pushTickForChat`, insert the hunt branch between agenda and gap: only when `chatId === defaultChatId` AND no due agenda item; `huntLevel = deps.chatPrefs.get(chatId).hunt !== false ? 'low' : 'off'`; `shouldSpeak({kind:'hunt', level: huntLevel, nowIso, ledger, lastInboundAtIso})`; ok ⇒ `deps.careLedger.claimHunt(chatId, nowIso)` then dispatch `buildHuntText({nowIso})` via the existing `dispatchToChat`; deny ⇒ log `CARE skip ... kind=hunt reason=...` and FALL THROUGH to the gap branch (a cooling hunt must not block a legitimate gap check-in — note: gap will rarely co-trigger for the owner anyway).
- [ ] Failing tests (extend the existing tick fixture): (a) owner, no agenda, hunt unset(⇒ON), no lastHuntAtIso ⇒ dispatched text contains 打猎/值得, claimHunt'd (ledger lastHuntAtIso set) BEFORE dispatch; (b) same-day second tick (lastHuntAtIso 1h ago) ⇒ hunt skipped reason hunt_cooldown, falls to gap evaluation; (c) `/set 打猎 off` (prefs.hunt:false) ⇒ no hunt; (d) NON-owner care-enabled chat never hunts; (e) agenda due ⇒ agenda fires, hunt not attempted; (f) noReplyCount:2 ⇒ hunt paused; (g) e2e-silence invariant test still green.
- [ ] RED → GREEN. Then FULL verification: `bunx tsc --noEmit` clean; full `bun --bun vitest run` green (git-stash triage); e2e `bun --bun vitest run -c vitest.e2e.config.ts` all pass.
- [ ] Commit: `feat(hunt): daily hunt branch in the care tick (agenda > hunt > gap)`.

## Self-Review notes

Spec §2 rules → T1 (gate+ledger) / T2 (pref+command) / T3 (mount+text+order). Names flow: `claimHunt`/`lastHuntAtIso` T1→T3; `hunt` pref T2→T3. No wiring task needed (shared instances already reach the tick — verified in proactive-care Task 7). Branch order + fall-through-on-cooldown decision documented in T3. e2e invariant re-pinned in T3(g).
