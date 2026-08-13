# Agent-Social Phase 2 — grounded judge in-process (re-point off retired plugins) — Design

**Date**: 2026-08-13
**Status**: Design approved (brainstorm 2026-08-13); writing-plans next.
**Builds on**: agent-social M1 (intent brokering, merged dev) + the Knowledge Kernel facts/person in-process slice (merged dev `b3b9730d`). North star: `docs/design/2026-07-12-knowledge-kernel-architecture.md` §3 ("judge 从 spawn 带 pluginMcp 的 agent → 直查 Query 面 person_brief 喂 cheapEval").

## Goal

Re-point the agent-social **grounded judge** off its spawn-a-plugins-agent
mechanism and onto an **in-process Query-face grounding fetch fed to
cheapEval**. The judge decides whether an inbound peer "seek" Intent Card
matches the owner; "grounded" means it reads the owner's own derived facts to
decide. Today it does this by spawning a constrained `_social_judge` agent
session (SOCIAL_JUDGE_PROFILE, plugins-only) that calls the `wx*` plugin MCP
fact tools. **The Knowledge Kernel facts/person slice (just merged) retired the
`wxfacts`/`wxperson`/`wxgraph` plugins, so those fact tools no longer exist — the
grounded judge is now fact-blind on `dev`** (it falls back to a blind cheapEval
that sees only the topic text and conservatively returns `no`). This slice fixes
that by reading the owner's facts **in-process** via the kernel's `FactsApi` +
search, exactly as the north star prescribed.

This is both a **correctness fix** (un-break the judge after the plugin
retirement — the third consumer to re-point, after the routes/tools and
companion-ingest) and the clean simplification the north star called for:
provider-independent, no agent spawn (saves ≈15–26s/judge), no
`SOCIAL_JUDGE_PROFILE` tier hack, no dependency on plugin readiness.

## Scope

**In:**

1. **`src/daemon/social/owner-grounding.ts`** (new) — `makeOwnerGrounding({
   knowledge }) → (card: IntentCard) => Promise<string>`. Given the card's
   `topic` (+ optional `city`), fetch the owner's relevant derived facts
   **in-process** and format them as a compact grounding text blob:
   - `knowledge.facts.findFacts(null, null, topic, 'active', N)` — the owner's
     structured facts whose predicate/value substring-match the topic (always
     available when the kernel is wired; no embedder needed).
   - When an embedder is available (`knowledge.embedQuery` + `knowledge.search`):
     also `knowledge.search(store, { queryText: topic, queryVector: await
     embedQuery(topic), model_id, limit: M })` — the owner's topically-relevant
     own messages (semantic recall the substring match misses).
   - Format into a short, labelled text block (facts as `predicate: value`
     lines; message snippets). Cap length. **Graceful degrade:** knowledge
     absent, or every sub-fetch empty/throwing → return `''` (the judge then
     reasons from the topic alone, honestly blind — same behavior as today's
     fallback but without the false "plugin-grounded" claim).

2. **`src/core/social-judge.ts`** (modify) — `makeJudge` gains an injected
   grounding step. Its `systemPrompt` changes from "用 wx* 工具读主人资料" (call
   tools) to "根据以下提供的主人资料判断" (reason over pre-fetched facts). The
   grounding text is fetched (via an injected `ground: (card) => Promise<string>`
   dep) and appended to the `userPrompt` before the single LLM call. The
   `runTurn` seam collapses to a plain cheapEval call (no spawn). The defensive
   `parseVerdict` + fail-closed-to-`no` logic is preserved verbatim. `ground`
   throwing degrades to empty grounding, never to a crash or a spurious match.

3. **`src/daemon/bootstrap/wire-social.ts` + `WireSocialDeps`** (modify) —
   replace the entire `makeGroundedJudgeRunTurn` / provider-adapter block with:
   `const ground = makeOwnerGrounding({ knowledge })`, `const judge = makeJudge({
   runTurn: cheapEval-backed, ground, policy })`. Thread the in-process
   `knowledge` (the `boot.knowledge` object: `facts`, `search`, `embedQuery`,
   `store`) into `WireSocialDeps` from the bootstrap call site (same pattern as
   companion-ingest getting `deps.boot.knowledge?.facts`). Update the BOOT log
   lines to describe in-proc grounding (and the honest "knowledge not wired →
   judge reasons from topic only" degrade case).

4. **Delete** `src/daemon/social/grounded-judge.ts` (+ its test) — the spawn
   machinery is gone. Remove `SOCIAL_JUDGE_PROFILE` (`user-tier.ts`) and
   `buildClaudeJudgeOptions` (`claude-agent-provider.ts`) **iff** no other
   reference survives (they exist only to support the deleted spawn path —
   verify with a repo grep; if a straggler remains, leave it and note why).
   Update the tests that asserted the old spawn path (`bootstrap.test.ts`'s
   "grounded judge path (not cheapEval)" test, `wire-social.forage.test.ts`'s
   `pluginMcp: {}` short-circuit assumption) to the in-process behavior.

**Out (later / not this slice):**
- **discover → rank_contacts** (Phase 2 part 2): needs a peer↔wechat-contact
  link that `A2AAgentRecord` lacks today; deferred to its own slice.
- Any change to disclosure gating (`gateOutbound`), the broker, the confirm
  capture, or the intent protocol — untouched. This slice only changes HOW the
  judge reads the owner's facts.
- The agent-social **live end-to-end** verification (needs a running daemon +
  WeChat login + a real openai/cheapEval provider) — env-blocked; stays pending.

## Architecture

### In-process grounding (the new core)
The judge is the daemon acting **for its own owner**: reading the owner's derived
facts to answer a peer on the owner's behalf. So the grounding fetch calls the
in-proc `FactsApi`/search **directly** — no tier check, no MCP, no spawn (the
daemon is trusted with its own owner's kernel, exactly like `companion-ingest`).
**Privacy is unchanged and still enforced downstream:** the judge's `blurb`
crosses the wire only after `social-answer.ts`'s mandatory `gateOutbound`
disclosure pass — the in-proc read widens what the judge can *reason over*, never
what leaves the machine.

### Degradation ladder (honest, no false grounding)
1. knowledge wired + facts present → full in-proc grounding.
2. knowledge wired + embedder up → + semantic message recall.
3. knowledge wired but no matching facts → minimal/empty grounding; judge reasons
   from topic (may still `yes` on an obvious topic, or `no`).
4. knowledge not wired at all (social on before kernel ready) → `ground` returns
   `''`; judge == today's cheapEval-on-topic fallback, but logged honestly
   ("reasoning from topic only"), not falsely advertised as plugin-grounded.

### What gets simpler
The judge is now provider-agnostic: one `cheapEval` call, no openai/claude spawn
adapters, no `SOCIAL_JUDGE_PROFILE`, no plugin-readiness gate, no ≈15–26s session
per judgment. `grounded-judge.ts` (the largest social file) is deleted.

## Verification
- **owner-grounding (unit):** a fake `knowledge` whose `facts.findFacts`/`search`
  return fixtures → grounding text contains the facts/snippets, labelled and
  length-capped; empty stores → `''`; a throwing sub-fetch → `''` (never
  throws); embedder-absent path skips semantic recall but still returns the
  structured facts.
- **social-judge (unit):** with an injected `ground` returning fixture facts, the
  judge composes the grounding into the prompt and returns the parsed verdict;
  `ground` throwing → grounding empty, still a valid verdict (not a crash, not a
  spurious `yes`); the existing parse/fail-closed tests stay green.
- **wire-social (unit/integration):** the judge path builds with in-proc
  `knowledge` and no `pluginMcp`; the BOOT log reflects in-proc grounding;
  knowledge-absent → honest degrade log; no reference to the deleted
  `grounded-judge` remains. Update the two stale tests to the new behavior.
- **VERIFY-AGAINST-REAL (owner machine):** with the real kernel on real
  decrypted data, `makeOwnerGrounding` for a real topic (e.g. a hobby the owner
  actually has) returns real facts/messages; a hand-built `IntentCard` on that
  topic drives `makeJudge` to a coherent `yes` + a grounded `blurb`, off any
  plugin/spawn.

## Non-goals / risks
- **Faithful preservation of the judge's safety invariants:** fail-closed-to-`no`
  on any parse/fetch error (a missed match is a cheap no-op; a spurious match or
  a crash is not); the disclosure gate remains the sole authority on what leaves.
- **Dead-code removal is conditional:** only delete `SOCIAL_JUDGE_PROFILE` /
  `buildClaudeJudgeOptions` if truly unreferenced after the grounded-judge
  deletion — verify, don't assume.
- `owner-grounding` must cap the injected text so a large fact store can't blow
  the cheapEval context; pick a sane N/M + char cap.
