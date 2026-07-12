# Agent Social M1 — Intent Brokering (Known-Peer Layer) — Design

**Date**: 2026-07-12
**Status**: Design approved (brainstorm 2026-07-12); implementation pending (writing-plans next)
**Builds on**:
- `docs/design/agent-social-network.md` — the CC-to-CC vision, the two-layer
  architecture, and the invariants this spec must not violate.
- A2A infra: `src/core/a2a-{server,client,registry,delegate,events-store}.ts`,
  `src/lib/a2a-pairing.ts` — the transport, registry, and pairing this reuses.
- The 2026-07-12 CC-to-CC spike: two wechat-cc instances held a 2-turn
  conversation over real `/a2a/exec`, each answering with its own
  OpenAI-compatible model (Kimi), after wiring `openai` as a bare delegate
  peer (`bootstrap/delegate.ts`, dev merge `663395a`).

## Goal

Give two **paired friends'** CCs the first genuinely useful, safe social
primitive: **intent brokering**. My agent takes an intent ("I'm looking for a
photography buddy"), privately finds which friends' agents might match, they
exchange *derived intent* (never raw data) under each owner's disclosure
policy, and — only when **both** humans confirm — surfaces the match.

Scheduling is the most trivial instance of this; M1 deliberately builds the
general **intent → discover → gated exchange → dual-confirm** mechanism, using
`kind: "seek"` (looking for a person/thing) as the first intent type. Later
intent types (offer / ask / reconnect) then fall out as data, not new
machinery.

This is the **known-peer ("熟人") layer** from the vision doc. The strangers
(pseudonymous gossip) layer is explicitly out of scope.

## Why this shape

- The existing `/a2a/exec` is a **bare, memory-less, no-consent** delegate
  (clean-slate by design: no wechat tools so a peer can't impersonate the
  owner; no delegate-mcp so it can't recurse). The answering side of intent
  brokering needs the **opposite**: read access to its owner's *derived*
  facts (to judge a match), a **disclosure gate** on everything it emits, and
  a path to **surface to its human** for the commit. So M1 adds a **new,
  separate A2A capability** rather than overloading exec — keeping the social
  surface's trust model, permissions, and audit trail distinct from the
  master/slave exec path.
- The value even between **already-connected** friends is real: it surfaces a
  **latent** match neither party knew about ("you both want a photography
  buddy"). So M1 needs no contact-exchange — being paired means being WeChat
  friends already; the deliverable is the *reveal + a warm opener*.

## Invariants (inherited from the vision doc — MUST hold)

1. **Exchange intent / availability / decisions — never raw data.** An intent
   card and a match receipt carry short, policy-filtered natural language, not
   chat excerpts, not the owner's fact store.
2. **Never disclose third parties.** Nothing about *other* friends (mutual
   contacts, group-chat content) may ever leave. This is a **code-level hard
   rule**, not merely policy text — the disclosure failure mode is
   catastrophic ("破这条,agent 就成数据泄漏后门").
3. **Low interruption.** A non-match is a silent no-op. The human is only ever
   interrupted for a genuine, confirmable match — the "postcard is a gift, not
   a task reminder."
4. **Autonomy boundary (consent model = b).** The agent negotiates
   *autonomously within policy*; the **commit** (revealing the match / the
   intro) requires **both** humans' explicit confirmation.

## Non-goals (M1 scope-out; deferred to v1+)

- Pairing (M1 assumes two friends are **already paired**; reuse existing
  `a2a-pairing`, do not rebuild).
- The strangers / pseudonym gossip layer.
- Friend-of-friend / multi-hop brokering (M1 is direct paired peers only).
- Sophisticated symmetric-disclosure *tit-for-tat* negotiation — M1 does the
  simple version: each side is filtered by its **own** policy gate; no
  negotiated "you reveal as much as I reveal" protocol yet.
- Contact/identity exchange (moot: paired = already WeChat friends).
- Calendar / reminder writes.
- Other intent kinds (`offer` / `ask` / `reconnect`); M1 ships `seek` only.
- Scoring / ranked matches — M1 match is `yes`/`no`.

## Architecture

### The flow (one happy path)

```
① 意图     Owner A tells their CC "找个周末一起拍照的摄影搭子".
           A's CC records an Intent { kind:"seek", topic, ... }.
② 发现     A's CC picks candidate paired friends via wxgraph (TARGETED, never
           broadcast — broadcasting an intent leaks it to everyone).
③ 闸门查询  A's CC sends an Intent Card to each candidate's /a2a/intent.
           The card is filtered by A's disclosure policy before it leaves.
④ 本地判断  B's CC reads B's OWN derived facts (wxfacts/wxperson) to judge the
   +同意    match, and returns a Match Receipt — filtered by B's disclosure
           policy. Steps ③④ are AUTONOMOUS (within policy).
⑤ 对称披露  On match, EACH CC surfaces to its own human:
   +人确认   「小B 也想找摄影搭子,牵个线?」. Only when BOTH confirm does the
           match "light up" (mutual reveal + a suggested opener). This is the
           commit — it needs both yeses.
```

### New A2A capability: `POST /a2a/intent`

Added to `a2a-server.ts` alongside `/a2a/notify`, `/a2a/exec`, `/a2a/pair`:
- Auth: same Bearer-against-registry check as `/a2a/exec`
  (`registry.verifyBearer(agent_id, token)`).
- Advertised in the Agent Card only when the `onIntent` handler is wired.
- Body = an **Intent Card** (below). Response = a **Match Receipt** (below).
- Handler is an injected `onIntent?: (event: IntentEvent) => Promise<MatchReceipt>`
  callback (mirrors `onExec`), wired in bootstrap to the social handler.

### Module layout

**New files:**

| File | Responsibility |
|---|---|
| `src/core/a2a-intent.ts` | Intent Card + Match Receipt types + zod schemas; pure. |
| `src/core/a2a-disclosure.ts` | `gateOutbound(payload, policy, cheapEval)` — the disclosure gate: a checker pass that redacts/blocks any policy violation before a payload leaves. Plus the code-level third-party hard rule. |
| `src/core/social-answer.ts` | The **answering** side: given an inbound Intent Card + the owner's disclosure policy, spawn a one-shot agent turn that (a) has read access to the owner's derived facts via the wx* plugin MCP tools, (b) judges match, (c) emits a Match Receipt, then runs it through `gateOutbound`. |
| `src/core/social-broker.ts` | The **initiating** side: `discoverCandidates(intent)` (wxgraph-ranked, capped, targeted); send Intent Cards via `A2AClient`; correlate receipts by `intent_id`; drive the dual-confirm. Holds the ephemeral pending-intent state. |
| `src/mcp-servers/wechat/tools-social.ts` | The MCP tool the operator's own agent calls to *raise* an intent (`social_seek(topic, ...)`), gated to admin tier. |

**Modified files:**

| File | Change |
|---|---|
| `src/core/a2a-server.ts` | Add `/a2a/intent` route + `onIntent?` opt + advertise the `intent` capability. |
| `src/lib/agent-config.ts` | Add `social_disclosure_policy?: string` and `social_enabled?: boolean`. |
| `src/daemon/bootstrap/index.ts` | Wire `onIntent → social-answer`; construct `social-broker`; register `tools-social`. |
| `src/core/capability-matrix.ts` | Gate `social_seek` (admin auto; trusted/guest forbidden). |

**Deliberately unchanged:** `a2a-delegate.ts` / the bare exec path — the
social capability is separate.

## Data model

### Intent Card (③ — outbound; already policy-filtered)

```jsonc
{
  "intent_id": "uuid",          // correlates the receipt
  "kind": "seek",               // M1: only "seek"
  "topic": "找周末一起拍照的摄影搭子",  // NL, policy-filtered — the intent, not raw data
  "city": "南京",               // optional, policy-filtered
  "expires_at": "ISO-8601"      // intents are ephemeral; the peer drops stale ones
}
```

### Match Receipt (④ — the peer's answer; already policy-filtered)

```jsonc
{
  "intent_id": "uuid",
  "match": "yes",               // M1: "yes" | "no"
  "blurb": "我主人也爱摄影,周末常出去拍"  // only on "yes"; NL, policy-filtered; NO contact info
}
```

Neither card carries any contact/identity — contact is moot (paired = already
friends); the reveal happens in ⑤ after both confirmations.

### Disclosure policy (per owner)

`agent-config.social_disclosure_policy` — a natural-language allow/deny, e.g.:

> 可向已配对好友透露:兴趣爱好、大致意向、所在城市。不透露:具体住址、
> 收入、健康状况、任何第三方(其他好友)的信息。

Enforcement is **defence-in-depth**:
1. The answering/initiating agent is prompted with the policy and instructed
   to include only compliant content.
2. **Every outbound payload** (Intent Card and Match Receipt) then passes
   through `gateOutbound`, a cheap-model checker that flags/redacts any
   violation before the payload leaves the process. A leak is the catastrophic
   failure mode, so the belt-and-suspenders second pass is mandatory, not
   optional.
3. The **third-party hard rule** is enforced in code (not left to the
   policy text or the LLM): the gate strips/blocks any content that names or
   describes a contact other than the two peers.

### Pending-intent state (initiating side)

In-memory map `intent_id → { intent, sent_to[], receipts[], status, expires_at }`.
Ephemeral; M1 does not persist across restart. Cleared on `expires_at`.

## Consent model (= b, locked in brainstorm)

- Steps ③④ (compose card / judge + receipt), **so long as output stays within
  the disclosure policy**, are **autonomous** — no human in the loop.
- Step ⑤ (the commit — revealing the match) requires **both** humans' explicit
  confirmation. Model the confirm as a seam
  `confirmWithOwner(summary) → Promise<boolean>`:
  - Production: surfaced via the operator's WeChat 1:1 chat (`sendAssistantText`
    + capture the reply).
  - Tests: an injected callback.
- Anything an agent would emit that **exceeds** its policy is withheld, not
  auto-sent — it may (v1+) escalate to a human ask; in M1 it is simply dropped
  by the gate.

## Discovery (targeted, not broadcast)

`discoverCandidates(intent)`:
- Rank paired peers by relevance using wxgraph (closeness / topical fit) and a
  cheap relevance eval on the intent topic; cap at a small N.
- If wxgraph is unavailable, fall back to all paired peers (small N in M1).
- Rationale: broadcasting "I'm looking for X" to every friend is itself an
  intent leak; targeting bounds the exposure.

## Verification / Acceptance Criteria

Verified with a two-instance harness in the spirit of `cc2cc-spike.ts`
(no WeChat login; the `confirmWithOwner` seam is an injected callback; each
instance has a persona, a small derived-fact set, and a disclosure policy).

| # | Scenario | Assertion |
|---|---|---|
| AC1 | **Happy path**: A raises `seek "找摄影搭子"` → targeted Intent Card to B → B's agent judges against B's OWN facts (likes photography) → `match:"yes"` + blurb → both confirm → mutual light-up + opener. | Full chain works; `match:"yes"`; blurb present; **both confirmations collected before any reveal**. |
| AC2 | **Non-match**: intent "找一起打篮球的" → B (photography only) → `match:"no"`. | Clean no-op; **no human is interrupted**; nothing lights up. |
| AC3 | **Disclosure gate**: B's facts intentionally include a forbidden item (home address / income / a third party), in a scenario where a naive agent might leak it into the blurb. | No outbound payload (Intent Card or Receipt) contains any forbidden content — `gateOutbound` redacts/blocks it. |
| AC4 | **Third-party hard rule**: an intent whose natural answer would mention a mutual friend. | Third-party info never leaves — enforced at code level, independent of the LLM. |
| AC5 | **No commit without dual confirm**: one side declines (or never answers) the `confirmWithOwner`. | No light-up, no opener, nothing sent; the other side is not left hanging. |

Optional stretch (VERIFY-AGAINST-REAL, mirrors the plugin suite): run the
answering agent against the user's **real** derived facts (wxfacts/wxperson
mounted) to confirm it judges a match plausibly.

## Open questions (flag for the plan, not blocking)

- **Which provider runs the answering/gate agents?** The daemon's configured
  provider (claude/Kimi/…). The gate's checker should use `cheapEval` for cost.
- **Confirm-capture over WeChat**: the exact 1:1 chat prompt/reply-capture
  mechanism reuses existing coordinator plumbing; details in the plan.
- **Intent de-dup / rate limits**: guard against an agent spamming a peer with
  intents (a courtesy + anti-abuse budget). Minimal cap in M1; fuller in v1.
