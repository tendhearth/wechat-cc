# /chat redesign — structured debate that ends in a verdict

**Date:** 2026-06-27
**Status:** approved (design); implementation plan to follow
**Related:** two deep-research reports (academic multi-agent-debate evidence;
2026 shipping products/frameworks), [[architecture-conventions]] (provider
config in capabilities; no per-provider hardcoding).

## Problem

`/chat` (chatroom mode) is a sequential, LLM-moderator-driven round-robin: a
moderator LLM decides who speaks each round (up to N=4), one agent speaks, the
moderator re-evaluates, the next speaks, etc. Two failures, both real and
observed on a live run:

**Quality is low** — root cause is "process without a result":
1. No final synthesis/verdict — the user gets a transcript that *stops at round
   N*, not a better answer.
2. Blind alternation — round 1 has only one speaker; agents don't actually
   engage the other's concrete content early (same failure mode as `/both`,
   where a model fabricated the other's lines because it couldn't see them).
3. Brittle moderator — the moderator emits hand-parsed JSON with a long
   steering `prompt` field; on a live run it **truncated mid-string** →
   `[CHATROOM_MOD] parse failed` → degraded fallback steering.
4. Problem drift — 4 fixed rounds add noise (research: agents converge in ~2
   turns; accuracy peaks ~3-4 rounds then declines on generative tasks).

**Efficiency is low** — fully sequential: speak → moderator eval → speak →
moderator eval … = 4 serial agent turns (16–50s each) + 4 moderator LLM calls
= the observed 2–4+ minutes.

The user's requirement: keep `/chat` a *genuine discussion / cross-talk with a
live feel* (it may be somewhat slower than `/parallel`), but **answer quality
must be high and it must be efficient**. `/parallel` is settled and unchanged.

## Design — three beats, parallel where possible, ends in a judged verdict

```
① Opening (PARALLEL, ~1 turn of latency)
   All panel agents answer the question concurrently. Stream each as it lands
   ([Claude] / [Codex] "typing" simultaneously). Each opening is a full stance.
   (= reuse the existing /parallel fan-out.)

② Cross-talk (PARALLEL, ~1 turn) — the real 交锋, the live-feel + quality core
   Each agent is given the OTHERS' complete openings and prompted to engage
   specifically: "where are they wrong / what did they miss; concede what's
   right." All rebut concurrently. Genuine, pointed (they see real positions,
   no fabrication). Stream each.

   Optional ②b (only if still materially split): a cheap STRUCTURED
   "converged?" check (tool-call boolean + the open disagreement). If
   converged → skip to ③. If not → ONE more targeted exchange on that specific
   disagreement only. Hard cap (≤1 extra round). Never unbounded.

③ Verdict (synthesis with a stance) — the deliverable
   One synthesis pass produces a JUDGED answer, not "two views to consider":
     ✅ 共识 (what they agree on)
     ⚠️ 分歧 (where they differ, WHICH side is more right and WHY)
     👉 结论/建议 (the actionable answer)
   This is what makes quality high — the discussion resolves into an answer
   better than any single agent's. Synthesis MERGES; it does not pick one.
```

### Why this satisfies all three requirements

| Requirement | Mechanism |
|---|---|
| discussion / 交锋 / live feel | ② is real, pointed rebuttal (each sees the others' actual stance, no fabrication), streamed side-by-side — more alive than slow one-at-a-time moderated turns |
| high quality | genuine engagement catches real errors + ③ judged synthesis (a stance, not a transcript). Research: synthesis > selection; converge in ~2 turns; >2-3 rounds drifts |
| efficient | ① and ② run concurrently (≈2 parallel turns, not 4 serial) + the per-round moderator LLM call is gone (replaced by at most one structured "converged?" check) → roughly 2 parallel turns + 1 synthesis vs 4 serial turns + 4 evals |

### Conductor (replaces the moderator)

The control flow is **deterministic code** — the three beats are a fixed code
loop, not an LLM picking speakers each round (Magentic-One pattern: code loop
+ small structured state; AutoGen `speaker_selection_method` can be code).

- Speaker selection: **gone** — every panel agent speaks in ① and ②
  concurrently. No "who's next" LLM call, no `peerOf`/alternation (the current
  2-agent hardcoding — same smell as the removed `/both` ternary).
- LLM is used at exactly two points, both **structured (tool-call / small
  schema, not free-form JSON)** so they cannot parse-fail or truncate:
  1. the optional "converged? / what's the open disagreement?" check, and
  2. the final verdict synthesis.
- A tiny structured ledger holds: `{ openings, rebuttals, openDisagreement?,
  done }`. The loop reads it; no re-reading raw chat each round.

### Provider-agnostic & N-ready

The panel is `participants: ProviderId[]` (already the mode's shape). ① and ②
fan out over the panel — O(1) latency in N (concurrent), not N serial turns.
Adding gemini = it registers as a provider (capability) and is panel-eligible;
**no N-specific or per-provider code** (per [[architecture-conventions]]).
Default panel is **capped/curated** (2–3 most-relevant), not "all registered"
(Perplexity Model Council fixes it at 3). `/chat p1 p2 …` overrides explicitly.

### Output / UX

- Stream each agent's opening and rebuttal as it arrives, prefixed `[Provider]`
  (existing chatroom prefixing). The cross-talk visibly references the other.
- The **verdict is the deliverable** and is ALWAYS produced — even if a beat
  degrades, the user gets a judged answer, never a transcript that just stops.

### Graceful degradation

- A panel agent that fails/times out in ① or ② is dropped for that beat; the
  rest continue. With one survivor, ② is skipped and ③ summarizes the one
  answer (degrades to a single good reply, never dead air).
- Per-turn watchdog (existing) bounds each agent turn.

## What changes in the code

- `src/core/chatroom-moderator.ts` → becomes a thin **conductor**: drop
  per-round speaker selection (`peerOf`, alternation, `moderateRound`'s
  free-form JSON). Keep only: structured "converged?" check + verdict synthesis
  prompts, both via structured output.
- `src/core/conversation-coordinator.ts` `dispatchChatroom` → rewrite from the
  sequential moderator loop to the three-beat pipeline: ① fan-out (reuse the
  `dispatchParallel` machinery), ② parallel rebuttal, optional ②b, ③ verdict.
  Each beat streams; one `TurnRecord` per agent-turn as today.
- `chatroomHistories` state stays (shared context across the beats) but the
  per-round moderator-decision plumbing is removed.
- No change to `/parallel` (parallel mode) or the mode-command surface beyond
  what's needed (panel-cap default).

## Research grounding (citations)

- Parallel fan-out → dedicated synthesizer is the shipped consumer pattern:
  Perplexity **Model Council** (3 models in parallel + synthesizer flags
  agreement/contradiction), Microsoft 365 Copilot **Council** (parallel + a
  synthesis "cover letter"). Both cap/curate the panel.
- **Synthesis > selection**: Together **MoA** (a synthesizing aggregator beats
  an LLM-ranker that picks one) → ③ merges, the old moderator "pick one
  speaker" is the anti-pattern.
- **Orchestrator-worker / supervisor** is the canonical production N pattern
  (Anthropic multi-agent research system; AWS Bedrock supervisor; Google
  co-scientist; Magentic-One) — central control + parallel workers + synthesis.
- **Disagreement handling is structured, never free-form chat** (co-scientist
  Elo tournament + simulated debate; MS "Critique" sequential generate→review)
  → ②/②b is structured + disagreement-gated + capped, not an open chatroom.
- **Deterministic loop + small structured ledger** for routing/termination
  (Magentic-One Task/Progress Ledger + stall counter) → the conductor.
- Bounded rounds: agents converge in ~2 turns (99%); >3-4 rounds drifts.
- Cost honesty: multi-agent ~15× tokens; parallel ≈1.8× latency win → cap +
  stream, debate is opt-in (you typed `/chat`).
- **Do NOT** justify `/chat` as "two models → more correct": the cross-model-
  diversity-beats-multisample claim was REFUTED in verification. Justify it on
  coverage / transparency / the discussion experience the user explicitly wants.

## Testing (TDD targets)

- Conductor pure logic: three-beat sequence; optional ②b fires only when the
  structured converged-check says "not converged"; hard cap on extra rounds.
- Structured verdict/converged outputs never throw on a malformed/truncated
  model reply (the failure that bit us) — tolerant/structured parse + a
  guaranteed verdict.
- Graceful degradation: one agent throws in ① → other's opening + verdict still
  produced; both throw → a clear single fallback, never empty.
- Panel-cap default; `/chat p1 p2` override; N>2 fan-out (no 2-agent hardcode).

## Out of scope / deferred

- Per-role model assignment (strong model for ③) — a follow-up quality lever;
  uses the new codex/cursor model hot-reload but not required for v1.
- Full N-way targeted cross-talk graphs (who-rebuts-whom beyond "everyone
  rebuts everyone's openings") — v1 keeps ② as all-rebut-all on the openings,
  ②b on the single flagged disagreement.
- Streaming transport specifics (the daemon already streams chunked replies;
  per-beat streaming reuses that).

## Open questions

- Exact "converged?" signal for open-ended WeChat queries (semantic-agreement
  vs a synthesizer-flagged contradiction) — start with: ③'s synthesizer is the
  same model that flags whether a ②b round is warranted.
- Default panel size/curation when >2 providers are registered (fixed 2–3 vs
  question-typed selection) — start with cap=2 default, explicit override.
