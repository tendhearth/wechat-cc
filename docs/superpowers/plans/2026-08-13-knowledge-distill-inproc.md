# knowledge-distill in-process — re-point off retired plugins — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Re-point `distillOwnerKnowledge` (builds the owner's always-on `knowledge.md` "social state" digest) off the retired `find_facts`/`top_contacts` MCP plugin tools onto the in-process Knowledge Kernel (`FactsApi.findFacts` + `GraphQueryApi.topContacts`).

**Why:** The Knowledge-Kernel facts/graph migration retired the wxfacts/wxperson/wxgraph plugins. `distillOwnerKnowledge` (in `src/daemon/companion/knowledge-distill.ts`, called from `tick-bodies.ts:247`) still calls those plugins over the ingest bridge — `bridge.hasTool('find_facts')` / `hasTool('top_contacts')` now return false, so the digest silently drops open obligations + key/neglected relationships and `knowledge.md` goes empty. This is the 4th retirement-broken consumer (after routes/tools, companion-ingest, and the grounded judge) — same fix pattern: read the in-proc kernel directly.

**Architecture:** `distillOwnerKnowledge` takes the in-process `knowledge` object (`{ facts?, graph? }`) instead of a `DistillBridge`, calls `facts.findFacts('obligation', …)` + `graph.topContacts('closeness'|'neglected', 5, 'person')` directly (they return objects, no JSON parse), and formats the same markdown with the same cap + graceful degrade. `tick-bodies.ts` passes `deps.boot.knowledge` (already in scope from the companion-ingest wiring).

**Tech Stack:** TypeScript/Bun. Branch `feat/distill-inproc` (base dev `87e3e7c4`). Tests: `knowledge-distill.test.ts` is bun:test; `tick-bodies` is exercised by vitest suites.

## Global Constraints
- **Graceful degrade preserved:** a missing/failed source drops its subsection; all-empty ⇒ `''` (caller omits the section). No throw escapes `distillOwnerKnowledge`. Same `KNOWLEDGE_DISTILL_CAP` (1500) char cap on the final body.
- **In-proc read is the daemon acting for its own owner** — no tier/bridge; `topContacts`/`findFacts` are synchronous in-proc calls (wrap in `safe()` for degrade, no bridge JSON parse).
- **Preserve the exact digest format** (`## 你的社交状态（算出来的，非主观）`, `**未了义务**`, `**亲近的人**`, `**好久没联系**`, same line shapes) — this feeds the owner's always-injected memory; don't churn the copy.
- **TDD**; `bunx tsc --noEmit` clean; never `git add -A`; never touch package.json/bun.lock; commits end `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Source of truth
Read: `src/daemon/companion/knowledge-distill.ts` (current), `src/daemon/wiring/tick-bodies.ts:241-252` (the call site), `src/core/knowledge/facts.ts` (`findFacts(kind,predicate,query,status,limit)→{results:FactRow[]}`, `FactRow.predicate/value`), `src/core/knowledge/graph-query.ts` (`GraphQueryApi.topContacts(by,limit?,kind?)→Contact[]`), `src/core/knowledge/graph.ts` (`Contact` has `display`+`username`+`closeness`).

---

## Task 1: Re-point distillOwnerKnowledge to the in-proc kernel

**Files:** Modify `src/daemon/companion/knowledge-distill.ts` + `src/daemon/companion/knowledge-distill.test.ts`; modify `src/daemon/wiring/tick-bodies.ts` (the `distillOwnerKnowledge(...)` call ~:247).

**Interfaces:**
- Consumes: `FactsApi.findFacts` (`src/core/knowledge/facts.ts`), `GraphQueryApi.topContacts` (`src/core/knowledge/graph-query.ts`), `Contact` (`display`, `username`).
- Produces:
  ```ts
  export interface DistillKnowledge {
    facts?: import('../../core/knowledge/facts').FactsApi
    graph?: import('../../core/knowledge/graph-query').GraphQueryApi
  }
  export async function distillOwnerKnowledge(knowledge: DistillKnowledge | undefined): Promise<string>
  ```
  (Drop the old `DistillBridge` interface + `parseCall`; keep `KNOWLEDGE_DISTILL_CAP` + `contactNames` — but `contactNames` now takes `Contact[]`, reading `c.display || c.username`, no JSON.)

- [ ] **Step 1: Rewrite the tests** `knowledge-distill.test.ts` for the in-proc shape (bun:test — `import { test, expect } from 'bun:test'`):
```ts
import { test, expect } from 'bun:test'
import { distillOwnerKnowledge } from './knowledge-distill'

const facts = { findFacts: () => ({ results: [
  { predicate: '欠', value: '老王 200 元', kind: 'obligation' },
  { predicate: '答应', value: '给小李看简历', kind: 'obligation' },
] }) } as any
const graph = { topContacts: (by: string) => by === 'closeness'
  ? [{ display: '小A', username: 'wxid_a' }, { display: '小B', username: 'wxid_b' }]
  : [{ display: '老陈', username: 'wxid_c' }] } as any

test('formats obligations + close + neglected from the in-proc kernel', async () => {
  const md = await distillOwnerKnowledge({ facts, graph })
  expect(md).toContain('未了义务'); expect(md).toContain('老王 200 元')
  expect(md).toContain('亲近的人'); expect(md).toContain('小A')
  expect(md).toContain('好久没联系'); expect(md).toContain('老陈')
})

test('undefined knowledge → empty string', async () => {
  expect(await distillOwnerKnowledge(undefined)).toBe('')
})

test('only facts present → obligations only, no relationship sections', async () => {
  const md = await distillOwnerKnowledge({ facts })
  expect(md).toContain('未了义务'); expect(md).not.toContain('亲近的人')
})

test('a throwing source drops its subsection, never throws', async () => {
  const md = await distillOwnerKnowledge({ graph: { topContacts: () => { throw new Error('x') } } as any })
  expect(md).toBe('')   // graph threw → no relationship section; no obligations → all-empty
})

test('caps at KNOWLEDGE_DISTILL_CAP', async () => {
  const big = { findFacts: () => ({ results: Array.from({ length: 100 }, (_, i) => ({ predicate: 'p', value: 'v'.repeat(40) + i, kind: 'obligation' })) }) } as any
  const md = await distillOwnerKnowledge({ facts: big })
  expect(md.length).toBeLessThanOrEqual(1500)
})
```

- [ ] **Step 2: Run, verify fail.** `bun test src/daemon/companion/knowledge-distill.test.ts` → FAIL.
- [ ] **Step 3: Implement** — rewrite `knowledge-distill.ts`:
  - `const safe = <T>(fn: () => T, dflt: T): T => { try { return fn() } catch { return dflt } }`.
  - `contactNames(list: unknown, limit: number)`: if `!Array.isArray(list)` → `[]`; map each `c` → `c.display || c.username` (string), filter falsy, cap at `limit`.
  - Obligations: `if (knowledge?.facts) { const res = safe(() => knowledge.facts!.findFacts('obligation', null, null, 'active', 20) as { results?: unknown[] }, null); const results = Array.isArray(res?.results) ? res!.results : []; ` … build `- ${predicate} ${value}`.trim() lines, slice(0,12), push `**未了义务**\n…` if any. }`
  - Relationships: `if (knowledge?.graph) { const close = contactNames(safe(() => knowledge.graph!.topContacts('closeness', 5, 'person'), []), 5); if (close.length) parts.push('**亲近的人**\n- ' + close.join('、')); const neglected = contactNames(safe(() => knowledge.graph!.topContacts('neglected', 5, 'person'), []), 5); if (neglected.length) parts.push('**好久没联系**\n- ' + neglected.join('、')); }`
  - `if (parts.length === 0) return ''`; body = `## 你的社交状态（算出来的，非主观）\n\n${parts.join('\n\n')}`; cap to `KNOWLEDGE_DISTILL_CAP`.
- [ ] **Step 4: Update `tick-bodies.ts`** (~:247): replace `distillOwnerKnowledge({ call: bridge.call, hasTool: … })` with `distillOwnerKnowledge(deps.boot.knowledge)`. (The surrounding try/catch + `fs.write('knowledge.md', digest)` stay.) Confirm `deps.boot.knowledge` is in scope here (it is — companion-ingest reads it in the same function). `bunx tsc --noEmit` clean.
- [ ] **Step 5:** Run `bun test src/daemon/companion/knowledge-distill.test.ts` (green) + `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts` (if it exists; else the ingest suites) + `bunx tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(knowledge): re-point owner-knowledge distill at in-proc kernel (KD T1)`.

---

## Task 2: VERIFY-AGAINST-REAL (owner machine)

**File:** `scratchpad/distill-verify.ts`.

On real kernel + real decrypted data: `openKnowledge` + `runSourceAdapter` + `rebuildGraphFromSource` + `makeFactsApi`(+ seed 1-2 obligation facts) + `makeGraphQueryApi`. Call `distillOwnerKnowledge({ facts: makeFactsApi(store), graph: makeGraphQueryApi(store) })` → print the digest; sanity-check it contains real top/neglected contacts (from the real graph) + the seeded obligation, formatted, capped — entirely in-process off any plugin.

- [ ] **Step 1:** Write + run (`bun scratchpad/distill-verify.ts`, or its absolute path). Acceptance: real digest assembles real relationships + obligations in-proc, no plugin/bridge. (Harness not committed.)

## Self-review
- Coverage: re-point + call site + tests (T1), real verify (T2). Fixes the silent knowledge.md regression from the plugin retirement.
- Risk: preserve the exact digest markdown format (feeds always-on memory); graceful degrade must stay airtight (no throw escapes); char cap prevents blow-up.
