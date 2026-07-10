# Design: daily hunt (每日打猎 — 信息明信片)

Date: 2026-07-10
Status: approved design → implementation
Roadmap: Phase 3b (single-machine 打猎 from `docs/design/agent-social-network.md`'s postcard model). Builds on proactive-care (spec 2026-07-09).

## 1. What

Once a day, the owner's CC "hunts": an agent turn with network tools, guided by
its memory of the owner, searches the web for genuinely interesting finds and
shares **at most 1-2** as a postcard (reply in the owner chat) — or stays
silent if nothing is worth it. A gift, not a newsfeed.

## 2. Locked decisions

- **Source = agent's own web search** (AI-native; no RSS/source-management
  infra). Interests come **from memory** (snapshot/tools); steering is
  conversational ("多看看 AI 圈的" → memory), no config surface.
- **Owner-only, ≤1/day, ≤2 items.** v1 does not hunt for other chats.
- **Mount = third branch of `pushTickForChat`** (owner chat only): agenda-due →
  agenda; else hunt-eligible → hunt; else gap-eligible → gap. The 20m tick +
  a ≥20h hunt cooldown ⇒ effectively daily. Reuses ALL existing machinery
  (session acquire, provider-from-mode, tier, claim-before-dispatch, in-flight
  skip, per-chat try/catch). No new scheduler.
- **Calibration**: `shouldSpeak` gains `kind: 'hunt'` — caller maps the pref
  (`hunt !== false` ⇒ 'low', else 'off'); rules: `care_off` when off;
  `paused_no_reply` when `noReplyCount ≥ 2` (postcards to someone ignoring you
  = spam); `hunt_cooldown` when `lastHuntAtIso` within 20h; `never_talked`
  does NOT apply (it's the owner). Invalid timestamps fail closed (existing).
- **Ledger**: `CareLedgerEntry` gains `lastHuntAtIso?: string`; `CareLedger`
  gains `claimHunt(chatId, nowIso)` (sets `lastHuntAtIso`, increments
  `noReplyCount` — an un-replied postcard counts toward the pause signal).
  Claim strictly BEFORE dispatch (at-most-once, as everywhere).
- **Pref**: `ChatPrefs.hunt?: boolean` (default ON); `/set 打猎|hunt on|off`.
- **Prompt** (`buildHuntText`, exported pure): 每日打猎 — 根据记忆里主人的
  兴趣,用网络工具搜新鲜事;只挑真正值得的 1-2 条,用 reply 分享(一句为什么
  他会感兴趣 + 链接);没猎到值得的就不发(不调 reply 直接结束即可)。
- **Cost**: at most one LLM session + a few searches per day; zero when off /
  paused / cooling. No new wiring (chatPrefs + careLedger already shared).

## 3. Non-goals (v1)

Non-owner hunts; RSS/source lists; frequency tiers; hunt-content memory
(dedup of already-shared links is the agent's judgment via conversation
history); the networked (agent-to-agent) hunt from the social-network vision.

## 4. Testing

Calibration table for 'hunt' (off / cooldown boundary 20h / pause at 2 /
ok-path / invalid ts); ledger claimHunt (+persistence); `/set 打猎`; tick:
hunt fires for owner when eligible, NOT for non-owner chats, agenda beats
hunt, hunt beats gap, cooldown suppresses, pause suppresses, claim precedes
dispatch, e2e-silence invariant intact. Full suite + e2e green.
