# Agent-Social Phase 2 — grounded judge in-process — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Re-point the agent-social grounded judge from spawning a plugins-only agent (broken by the wxfacts/wxperson retirement) to fetching the owner's facts in-process via the Knowledge Kernel and feeding them to cheapEval.

**Architecture:** A new `owner-grounding.ts` fetches the owner's topic-relevant facts (`knowledge.facts.findFacts` + optional semantic `knowledge.search`) as text. `social-judge.ts`'s `makeJudge` injects that grounding into the prompt and calls cheapEval directly (no spawn). `wire-social.ts` wires it with the in-process `knowledge` threaded through `SocialDeps` from bootstrap, and `grounded-judge.ts` (the spawn machinery) is deleted.

**Tech Stack:** TypeScript/Bun (`bun test`; some daemon tests use vitest — match each file). Branch `feat/social-judge-inproc` (base dev `b3b9730d`).

## Global Constraints
- **Fail-closed safety preserved.** The judge fails to `{ match: 'no' }` on ANY parse/fetch/LLM error (a missed match is a cheap no-op; a spurious match or a crash is not). `ground()` throwing → empty grounding, never a crash, never a spurious `yes`. The disclosure gate (`gateOutbound` in `social-answer.ts`) remains the sole authority on what leaves the machine — do NOT touch it.
- **In-proc read is the daemon acting for its own owner** — no tier check, no MCP, no spawn (mirror companion-ingest's direct `boot.knowledge` use). Privacy is enforced downstream by the unchanged disclosure gate.
- **Honest degradation:** knowledge absent / no facts → grounding `''`, judge reasons from topic, logged honestly — never a false "plugin-grounded" claim.
- **Cap injected grounding** so a large fact store can't blow the cheapEval context (char cap + row caps).
- **Conditional dead-code removal:** delete `SOCIAL_JUDGE_PROFILE` / `buildClaudeJudgeOptions` ONLY if truly unreferenced after `grounded-judge.ts` is deleted (grep first).
- **TDD**; `bunx tsc --noEmit` clean before each commit; never `git add -A`; never touch package.json/bun.lock; commits end `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Source of truth
Spec: `docs/superpowers/specs/2026-08-13-social-judge-inproc-design.md`. Read: `src/core/social-judge.ts` (makeJudge), `src/daemon/social/grounded-judge.ts` (being deleted), `src/daemon/bootstrap/wire-social.ts:253-295` (the judge block), `src/core/knowledge/facts.ts` (`FactsApi.findFacts`), `src/core/knowledge/search.ts` (`semanticSearch`), `src/core/a2a-intent.ts` (`IntentCard`: `topic`, `city?`).

---

## Task 1: owner-grounding.ts — in-process fact fetch

**Files:** Create `src/daemon/social/owner-grounding.ts` + `owner-grounding.test.ts`.

**Interfaces:**
- Consumes: the bootstrap `knowledge` object (optional fields) — `{ facts?: FactsApi; search?: typeof semanticSearch; store?: KnowledgeStore; embedQuery?: (t: string) => Promise<number[]>; embedder?: { model_id: string } }`. `FactsApi.findFacts(kind, predicate, query, status, limit) => { results: FactRow[] }` where `FactRow` has `predicate,value,kind,confidence`. `semanticSearch(store, { queryText, queryVector, model_id, limit }) => { results: Array<{ text, conversation, time }> }`.
- Produces:
  ```ts
  export interface GroundingKnowledge {
    facts?: import('../../core/knowledge/facts').FactsApi
    search?: typeof import('../../core/knowledge/search').semanticSearch
    store?: import('../../core/knowledge/store').KnowledgeStore
    embedQuery?: (t: string) => Promise<number[]>
    embedder?: { model_id: string }
  }
  export function makeOwnerGrounding(knowledge: GroundingKnowledge | undefined): (card: { topic: string; city?: string }) => Promise<string>
  ```

- [ ] **Step 1: Write failing tests** `owner-grounding.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { makeOwnerGrounding } from './owner-grounding'

const factsFixture = { results: [
  { predicate: '爱好', value: '摄影', kind: 'entity', confidence: 'high' },
  { predicate: '所在城市', value: '南京', kind: 'attribute', confidence: 'med' },
] }

test('formats structured facts into labelled grounding text', async () => {
  const ground = makeOwnerGrounding({ facts: { findFacts: () => factsFixture } as any })
  const text = await ground({ topic: '摄影' })
  expect(text).toContain('摄影')
  expect(text).toContain('南京')
  expect(text.length).toBeGreaterThan(0)
})

test('adds semantic message recall when embedder + search present', async () => {
  const ground = makeOwnerGrounding({
    facts: { findFacts: () => ({ results: [] }) } as any,
    store: {} as any,
    embedder: { model_id: 'm' },
    embedQuery: async () => [0.1, 0.2],
    search: (() => ({ results: [{ text: '上周去紫金山拍了银河', conversation: 'c', time: 1 }] })) as any,
  })
  const text = await ground({ topic: '摄影' })
  expect(text).toContain('紫金山')
})

test('empty stores → empty string', async () => {
  const ground = makeOwnerGrounding({ facts: { findFacts: () => ({ results: [] }) } as any })
  expect(await ground({ topic: 'x' })).toBe('')
})

test('undefined knowledge → empty string (honest blind)', async () => {
  expect(await makeOwnerGrounding(undefined)({ topic: 'x' })).toBe('')
})

test('a throwing sub-fetch degrades to empty, never throws', async () => {
  const ground = makeOwnerGrounding({ facts: { findFacts: () => { throw new Error('boom') } } as any })
  expect(await ground({ topic: 'x' })).toBe('')
})

test('caps very large fact sets (char cap)', async () => {
  const many = { results: Array.from({ length: 500 }, (_, i) => ({ predicate: 'p' + i, value: 'v'.repeat(50), kind: 'e', confidence: 'low' })) }
  const ground = makeOwnerGrounding({ facts: { findFacts: () => many } as any })
  const text = await ground({ topic: 'x' })
  expect(text.length).toBeLessThanOrEqual(2200)   // cap ~2000 + label slack
})
```

- [ ] **Step 2: Run, verify fail.** `bun test src/daemon/social/owner-grounding.test.ts` → FAIL.
- [ ] **Step 3: Implement** `owner-grounding.ts`:
```ts
import type { KnowledgeStore } from '../../core/knowledge/store'
import type { FactsApi } from '../../core/knowledge/facts'
import type { semanticSearch as SemSearch } from '../../core/knowledge/search'

export interface GroundingKnowledge {
  facts?: FactsApi
  search?: typeof SemSearch
  store?: KnowledgeStore
  embedQuery?: (t: string) => Promise<number[]>
  embedder?: { model_id: string }
}

const FACT_LIMIT = 40
const MSG_LIMIT = 6
const CHAR_CAP = 2000

const safe = async <T>(fn: () => Promise<T> | T, dflt: T): Promise<T> => {
  try { return await fn() } catch { return dflt }
}

export function makeOwnerGrounding(knowledge: GroundingKnowledge | undefined) {
  return async (card: { topic: string; city?: string }): Promise<string> => {
    if (!knowledge) return ''
    const parts: string[] = []

    // 1) structured facts (substring match on topic; always available)
    if (knowledge.facts) {
      const rows = await safe(() => knowledge.facts!.findFacts(null, null, card.topic, 'active', FACT_LIMIT), { results: [] as any[] })
      const lines = (rows?.results ?? []).map((f: any) => `- ${f.predicate}: ${f.value}`)
      if (lines.length) parts.push('主人相关事实：\n' + lines.join('\n'))
    }

    // 2) semantic message recall (only when embedder + search + store present)
    if (knowledge.search && knowledge.store && knowledge.embedQuery && knowledge.embedder) {
      const snippets = await safe(async () => {
        const qv = await knowledge.embedQuery!(card.topic)
        const res = knowledge.search!(knowledge.store!, { queryText: card.topic, queryVector: qv, model_id: knowledge.embedder!.model_id, limit: MSG_LIMIT } as any)
        return (res?.results ?? []).map((r: any) => `- ${(r.text || '').replace(/\s+/g, ' ').slice(0, 80)}`)
      }, [] as string[])
      if (snippets.length) parts.push('主人相关消息：\n' + snippets.join('\n'))
    }

    const text = parts.join('\n\n')
    return text.length > CHAR_CAP ? text.slice(0, CHAR_CAP) : text
  }
}
```
- [ ] **Step 4: Run, verify pass + `bunx tsc --noEmit` clean.**
- [ ] **Step 5: Commit** `feat(social): in-process owner grounding for the judge (SJ T1)`.

---

## Task 2: social-judge.ts — inject grounding, drop the tool-call premise

**Files:** Modify `src/core/social-judge.ts` + `src/core/social-judge.test.ts` (if present; else add).

**Interfaces:**
- Consumes: `ground: (card: IntentCard) => Promise<string>` (T1's return), `runTurn` (now a plain cheapEval-backed `(sys, user) => Promise<string>`).
- Produces: `makeJudge({ runTurn, ground, policy }) => (card) => Promise<JudgeVerdict>` — `ground` optional (absent = empty grounding, preserving current callers/tests).

- [ ] **Step 1: Write/extend failing tests** — with an injected `ground` returning fixture facts, assert the text passed to `runTurn` contains the grounding; `ground` throwing → `runTurn` still called with empty grounding and a valid verdict returned (not a crash); keep the existing parse/fail-closed tests. Example:
```ts
test('injects grounding text into the judge turn', async () => {
  let seenUser = ''
  const judge = makeJudge({
    runTurn: async (_s, u) => { seenUser = u; return '{"match":"yes","blurb":"我也爱摄影"}' },
    ground: async () => '主人相关事实：\n- 爱好: 摄影',
    policy: 'p',
  })
  const v = await judge({ intent_id: 'i', kind: 'seek', topic: '摄影', expires_at: 'x', hop: 1 } as any)
  expect(seenUser).toContain('摄影')
  expect(v.match).toBe('yes')
})

test('ground throwing degrades to empty grounding, still a verdict', async () => {
  const judge = makeJudge({
    runTurn: async () => '{"match":"no"}',
    ground: async () => { throw new Error('x') },
    policy: 'p',
  })
  const v = await judge({ intent_id: 'i', kind: 'seek', topic: 't', expires_at: 'x', hop: 1 } as any)
  expect(v.match).toBe('no')
})
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Change `systemPrompt` from "用 wx* 工具读主人资料" to "根据以下提供的主人资料判断是否匹配"; add optional `ground` to `JudgeDeps`; in the returned judge: `const grounding = deps.ground ? await deps.ground(card).catch(() => '') : ''`; build the user text as `userPrompt(card) + (grounding ? '\n\n' + grounding : '')`; keep `parseVerdict` + the outer try/catch → `{match:'no'}` verbatim. (The `ground().catch(()=>'')` is defence-in-depth on top of T1's own safe-wrap.)
- [ ] **Step 4: Run, verify pass + tsc clean.**
- [ ] **Step 5: Commit** `feat(social): judge grounds on injected in-proc facts, not tool calls (SJ T2)`.

---

## Task 3: wire-social re-point + delete grounded-judge

**Files:** Modify `src/daemon/bootstrap/wire-social.ts` (the `SocialDeps` type + the judge block ~`:253-295`), `src/daemon/bootstrap/index.ts` (the `wireSocial({...})` call ~`:955` — thread `knowledge`). Delete `src/daemon/social/grounded-judge.ts` + `grounded-judge.test.ts`. Conditionally remove `SOCIAL_JUDGE_PROFILE` (`src/core/user-tier.ts`) + `buildClaudeJudgeOptions` (`src/core/claude-agent-provider.ts`) if unreferenced. Update `src/daemon/bootstrap.test.ts` (the "grounded judge path (not cheapEval)" test) + `src/daemon/bootstrap/wire-social.forage.test.ts` (the `pluginMcp: {}` short-circuit test).

- [ ] **Step 1:** Add `knowledge?: import('...owner-grounding').GroundingKnowledge` to `SocialDeps`. At the `wireSocial({...})` call in `index.ts`, pass `knowledge: knowledge` (the `boot.knowledge` object already assembled — confirm the in-scope variable name; it holds `facts`/`search`/`store`/`embedQuery`/`embedder`).
- [ ] **Step 2:** In `wire-social.ts`, DELETE the `makeGroundedJudgeRunTurn` import + the whole block building `groundedRunTurn`/`socialRunTurn`/provider adapters (`:263-289`). Replace with:
```ts
const { makeOwnerGrounding } = await import('../social/owner-grounding')
const ground = makeOwnerGrounding(deps.knowledge)
const socialRunTurn = async (systemPrompt: string, userPrompt: string) => socialCheapEval(`${systemPrompt}\n\n${userPrompt}`)
const socialJudge = makeJudge({ runTurn: socialRunTurn, ground, policy: socialPolicy })
deps.log('BOOT', deps.knowledge?.facts
  ? 'social: in-process grounded judge (kernel facts + search, no spawn, provider-agnostic)'
  : 'social: judge reasons from topic only — knowledge not wired (kernel off?). Not plugin-grounded.')
```
  (Keep `makeAnswerIntent({ judge: socialJudge, policy: socialPolicy, cheapEval: socialCheapEval })` unchanged.)
- [ ] **Step 3:** `git rm src/daemon/social/grounded-judge.ts src/daemon/social/grounded-judge.test.ts`. Grep the repo for `grounded-judge`, `makeGroundedJudgeRunTurn`, `SOCIAL_JUDGE_PROFILE`, `buildClaudeJudgeOptions`. Remove now-dead `SOCIAL_JUDGE_PROFILE` + `buildClaudeJudgeOptions` (and their imports/tests) ONLY if no live reference remains; if a straggler references them, leave and note in the report.
- [ ] **Step 4:** Fix the two stale tests to the in-proc behavior: `bootstrap.test.ts`'s grounded-judge test (a claude-default daemon now grounds in-process, not via a plugin spawn — assert the in-proc path / drop the plugin-spawn assertion), and `wire-social.forage.test.ts` (its `pluginMcp: {}` comment/assumption about `makeGroundedJudgeRunTurn` short-circuiting is obsolete — update so the suite reflects the judge no longer depending on `pluginMcp`). Run BOTH files (they are vitest — `bun --bun vitest run <file>`).
- [ ] **Step 5:** `bunx tsc --noEmit` clean; run `bun --bun vitest run src/daemon/bootstrap/wire-social.forage.test.ts src/daemon/bootstrap/wire-social.busy.test.ts src/daemon/bootstrap/social-finish-seek.test.ts` + `bun test src/core/social-judge.test.ts`. Green.
- [ ] **Step 6: Commit** `feat(social): wire in-proc judge + delete grounded-judge spawn machinery (SJ T3)`.

---

## Task 4: VERIFY-AGAINST-REAL (owner machine)

**File:** `scratchpad/social-judge-verify.ts`.

On the real kernel + real decrypted data:
- `openKnowledge` + `runSourceAdapter` + `runIndexer` (real embed optional — reuse the cached bge model at `scratchpad/bgemodel` via the persistent embedder if available; else structured-facts-only path) + `rebuildGraphFromSource`. Populate a few facts via `makeFactsApi(store).record` for a topic the owner actually engages with (or run the real extraction if a cheapEval is handy — else hand-seed 2-3 plausible facts).
- `makeOwnerGrounding({ facts, search, store, embedQuery, embedder })` for that topic → print the grounding text (real facts/messages, labelled, capped).
- Build a matching `IntentCard` on the topic; run `makeJudge({ runTurn: <real cheapEval OR a stub that echoes the prompt>, ground, policy })` → confirm the grounding reaches the prompt and (with a real cheapEval) a coherent `{match, blurb}` grounded in the owner's real facts, entirely off any plugin/spawn.

- [ ] **Step 1:** Write + run (`bun scratchpad/social-judge-verify.ts`). Acceptance gate: in-proc grounding returns real owner facts for a real topic and reaches the judge, no plugin/spawn involved. (If no cheapEval provider is reachable, assert the grounding-text + prompt-injection path on real data and note the LLM-verdict step needs a live provider.)

## Self-review
- Coverage: in-proc grounding fetch (T1), judge injection + drop tool-call premise (T2), wire + delete spawn machinery + fix stale tests (T3), real verify (T4). Fixes the fact-blind judge left by the plugin retirement; removes the spawn/provider/tier-hack complexity.
- Risk: T2 must preserve fail-closed-to-`no` on every error path (tests pin it); T3 dead-code removal is conditional on a grep (don't delete referenced symbols); grounding char-cap prevents context blow-up.
- Privacy unchanged: disclosure `gateOutbound` remains the sole outbound authority; the in-proc read only widens what the judge reasons over.
