# 觅食台 — Agent 页重构 Design (secret-exchange / forager social surface)

**Date:** 2026-07-15
**Status:** Design approved (concept + visual mockup) — pending written-spec review
**Mockup:** https://claude.ai/code/artifact/28adff51-a8aa-48d3-bf13-48aee7087c9f
**Base branch:** `dev`

## Why (the reframe)

The current desktop **Agent (A2A)** page is a low-level "register A2A endpoints" tool: manual `url + api-key` pairing, an inbound server toggled by hand-editing `agent-config.json`, and the actual social value — seek → grounded-judge match → dual-confirm → connect — is invisible. But **if you can already reach someone directly on WeChat, you don't need a bot for it.** A2A's real value is reaching **through** the network to people/things you can't see directly (six-degrees), with a privacy/proxy layer: "secret transactions" — playful things among friends + anonymous exchange with strangers. Your bot forages the social graph on your behalf (travel-frog), anonymously, and reveals identities only on mutual dual-confirm.

## What we're building

Redesign the desktop **Agent** page into a **觅食台 (Forager's Desk / secret-exchange desk)** — a dashboard for "you send your bot out to quietly find people/things; it brings back matches." Hero use cases (熟人 / known-peer layer): **① 求物求人** (practical seeks) + **② 朋友间小乐趣** (playful anonymous). **③ 陌生匿名集市** (stranger anon net) is deferred to a later phase.

## Page structure (three blocks, main→supporting)

1. **我派出去的心愿** (active seeks — the star). Each = an anonymous foraging wish (求物求人 / 小乐趣). Shows: kind chip, 🔒 anonymous, and a forage-status ribbon: *觅食中 · 已走到第 N 度 · 问了 M 个朋友的 bot* → *有回音* → *已牵线*. Multi-hop-ready: a **degree progress bar** (第 1 度 lit; 第 2/3 度 rendered as dashed "待开").
2. **带回来的明信片** (matches / echoes — the signature moment). Anonymous match cards: "三度外的某人(朋友 → 的朋友 → 的朋友)", a postmark ("从第 N 度带回"), and the reveal climax: **揭晓牵线** / 再等等. Identities revealed only when **both** sides tap 揭晓 (dual-confirm).
3. **你的觅食网** (the network — folded substrate). An **inbound toggle** ("让朋友的 bot 能找到我" — replaces config-file editing), the connected friend-bots, "＋ 连一个朋友的 bot", and a "第 2、3 度即将开放" upgrade hint. Pairing/keys are demoted to this collapsed section — no longer the page's subject.

## Seek lifecycle

- **Create (WeChat-first):** the owner tells the bot in WeChat "帮我悄悄找个 X / 匿名问下 Y" → the bot confirms the wish (what it will say on your behalf, how anonymous) → sows it. The desktop 觅食台 is the dashboard, with an optional manual "撒一个新心愿".
- **Forage:** the bot asks paired peers' bots, anonymously (1 hop today; see below).
- **Match:** a peer's grounded judge decides a fit (shipped this session).
- **Echo:** the match returns as a **postcard** on your 觅食台.
- **Reveal:** mutual dual-confirm → 牵线 (identities + contact exchanged).

## Privacy model (the crux of "secret transaction")

- Seeks propagate **anonymously** — no owner identity attached — gated by the fail-closed disclosure gate + the owner's `social_disclosure_policy` (what the bot may reveal on your behalf).
- Identities / contact are revealed **only** on mutual dual-confirm (reuse the M1 dual-confirm + pending-confirms).
- The grounded judge (shipped) decides matches from `wx*` facts without leaking them.

## 1-hop now / multi-hop-ready

Backend M1 today: the broker's `discover` = direct paired peers, capped at 5 (**1 hop**). This design ships 1-hop, but the **wire protocol and the UI carry a hop count / TTL** so multi-hop — peers re-forwarding to their peers, with loop / spam / anonymity / TTL controls — upgrades painlessly later. The degree bar shows "第 1 度" now; "第 2/3 度" render as "待开". Multi-hop propagation is a **separate future project** (its own design), not in scope here.

## Maps to existing vs. new

**Existing (M1 backend, shipped):** broker (discover / send / dual-confirm), `POST /v1/social/seek`, `/v1/a2a/*` (list / info / activity / install / remove / pause / send), the provider-agnostic grounded judge, the fail-closed disclosure gate, pending-confirms, `social_disclosure_policy`.

**New:**
- **Internal-api social surface for the desktop:** read active seeks (with forage status + hop / peer-count), incoming echoes / matches (masked identity + degree), a **reveal** action (drive dual-confirm from the desktop), and network + inbound status. Likely extends `/v1/a2a/activity` and/or adds `/v1/social/*` read+act routes (tiered `trusted`/`admin` per existing `route-tiers.ts`).
- **Inbound toggle:** a route to enable/disable `a2a_listen` from the UI (replacing config-file editing), rebinding the inbound server without a manual restart — or, if a restart is unavoidable, guiding it clearly in-UI.
- **WeChat seek-creation-with-confirm flow:** natural-language "帮我找 X" → create an anonymous seek, with a "confirm the wish + anonymity level" step. Part of this may already exist via `social_seek` tooling; the anonymity framing + confirm step are the additions.
- **The 觅食台 page:** rewrite `apps/desktop/src/modules/a2a-agents.js` into the forage-desk (new HTML structure + styles matching the mockup; warm-storybook palette, degree bar, postcard/reveal treatment, folded network + toggle).

## Scope / decomposition

Decomposes into three plans; **(A) + (B) are the MVP** — make the shipped M1 visible, operable, and humane:
- **(A) Internal-api social read/act surface + inbound toggle.**
- **(B) The desktop 觅食台 page** (frontend, per the mockup), consuming (A).
- **(C) The WeChat seek-creation-with-confirm flow** (enriches creation; can follow A+B).

## Coordination (important)

This heavily touches the **other session's actively-developed desktop domain** (`apps/desktop`) **and** the social backend. Implement in an **isolated worktree** and land as a **reviewable PR** the other session can see — or hand this spec to that session. Do not disturb their in-flight desktop work. `desktop-e2e` is persistently red and non-required; don't regress it further, and don't block on it.

## Testing

- **Frontend:** desktop module tests for forage-desk rendering (seek cards, forage-status states, postcard/reveal, folded network + toggle, empty states), mirroring the existing `modules/*.test.ts` pattern; update the shim structural-anchor list for the new page.
- **Backend:** internal-api route tests for the new social read/act routes + the inbound toggle (mirroring `routes-a2a` / `routes-social` tests).
- The grounded-judge and dual-confirm paths are already covered (M1 + this session's grounded-judge work).

## Non-goals

Multi-hop propagation; the stranger (陌生) anon net (③); real transport / relay infrastructure for cross-machine reachability (assumed present for this UX; a separate infra concern to land before any real rollout).
