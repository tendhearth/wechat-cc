# Memory Upgrades (2026-08 review) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four memory-architecture gaps identified in the 2026-08-23 review: (1) introspect's empty `recentInboundMessages`, (2) facts with no temporal validity/supersede semantics, (3) no automatic per-turn memory recall injection, (4) substring-scan cross-session search.

**Architecture:** All changes stay inside wechat-cc's existing layering: store-level changes are deterministic SQLite (guarded ALTER TABLE, FTS5); LLM judgment stays at the edges (one cheapEval per extraction batch for conflict resolution) with strict non-throwing parsing (the memory-gardener lesson); recall injection is a new inbound middleware gated to admin chats (knowledge kernel is owner-private, same trust class as `knowledge_search`).

**Tech Stack:** TypeScript + Bun, `bun:sqlite`, vitest (`bun run vitest run <file>`), FTS5 trigram tokenizer (already used by `chunks_fts`).

**Spec:** This plan's Background section (below) is the spec — it records the review findings each task implements.

## Global Constraints

- No new external dependencies; local SQLite + filesystem only.
- LLM output must NEVER corrupt a store: strict validation, non-throwing parsers, `[]`/no-op on garbage (pattern: `src/daemon/companion/ingest/extract.ts` header).
- Knowledge kernel data is owner-private: any new read path is admin-gated (pattern: `knowledge_search` MCP tool, `route-tiers.ts`).
- Facts watermarks stay monotonic; never regress on failure.
- All comments in code follow existing file style (English, "why" comments only).
- Test runner: `bun run vitest run <path>` from `wechat-cc/`.

## Background (spec)

1. **Introspect bug** — `src/daemon/wiring/tick-bodies.ts:561` hardcodes `recentInboundMessages: () => Promise.resolve([])`, so the 24h introspect prompt's `=== 用户最近发的消息 ===` section is always `(空)`. The `messages` table has the data (`makeMessagesStore.listRange`).
2. **Facts temporal validity** — `facts` table (`src/core/knowledge/store.ts:610-617`) has no `valid_from`/`invalidated_at`/`superseded_by`; `upsertFact` merges same `(contact,predicate,value)` but two different values for the same predicate coexist forever ("住在北京" + "住在上海" both active). Zep/Graphiti-style fact invalidation is the fix: detect same-predicate conflicts at record time, let one cheapEval judge exclusive-vs-coexisting, supersede losers (status='superseded', invalidated_at, superseded_by).
3. **Auto-recall** — retrieval during a live turn is entirely prompt-driven (agent must call `memory_read`/`knowledge_search`). Inject top-3 hybrid-search hits from the knowledge kernel into the inbound envelope (`<recall>` element) for admin chats, computed by a new middleware before dispatch. Soft-fail: timeout/error ⇒ no recall block, turn proceeds unchanged.
4. **Session search** — `src/daemon/sessions/searcher.ts` is a case-insensitive substring scan over every session jsonl (self-deferred "SQLite FTS upgrade tracked for v0.5"). Add an incrementally-maintained FTS5 trigram index in the main db; fall back to the existing scan for sub-3-char queries (trigram minimum).

---

### Task 1: Introspect gets real recent inbound messages

**Files:**
- Modify: `src/daemon/wiring/tick-bodies.ts` (introspectTick, ~:554-563; move `makeMessagesStore` construction above the agent)
- Test: `src/daemon/wiring/recent-inbound.test.ts` (new)
- Create: `src/daemon/wiring/recent-inbound.ts` (new, ~20 lines)

**Interfaces:**
- Produces: `recentInboundTexts(store: MessagesStore, chatId: string, limit?: number): Promise<string[]>` — last `limit` (default 10) inbound (`direction==='in'`) message texts, ascending order, excluding empty texts and `kind==='command'`.
- Consumes: `MessagesStore.listRange` (`src/lib/messages-store.ts:31`), `openTestDb` (`src/lib/db.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/wiring/recent-inbound.test.ts
import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { recentInboundTexts } from './recent-inbound'

function rec(id: string, dir: 'in' | 'out', text: string, ts: string, kind = 'text') {
  return { id, chatId: 'chat1', ts, direction: dir, kind, text, source: 'live' } as const
}

describe('recentInboundTexts', () => {
  it('returns only inbound texts, ascending, capped to limit', async () => {
    const store = makeMessagesStore(openTestDb() as never)
    await store.append(rec('1', 'in', 'hello', '2026-08-01T00:00:01Z'))
    await store.append(rec('2', 'out', 'reply', '2026-08-01T00:00:02Z'))
    await store.append(rec('3', 'in', 'second', '2026-08-01T00:00:03Z'))
    await store.append(rec('4', 'in', '/health', '2026-08-01T00:00:04Z', 'command'))
    expect(await recentInboundTexts(store, 'chat1', 10)).toEqual(['hello', 'second'])
  })

  it('caps to the newest `limit` inbound messages', async () => {
    const store = makeMessagesStore(openTestDb() as never)
    for (let i = 0; i < 15; i++) {
      await store.append(rec(String(i), 'in', `m${i}`, `2026-08-01T00:00:${String(i).padStart(2, '0')}Z`))
    }
    const out = await recentInboundTexts(store, 'chat1', 10)
    expect(out).toHaveLength(10)
    expect(out[0]).toBe('m5')
    expect(out[9]).toBe('m14')
  })

  it('empty store → empty array', async () => {
    const store = makeMessagesStore(openTestDb() as never)
    expect(await recentInboundTexts(store, 'chat1')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run src/daemon/wiring/recent-inbound.test.ts`
Expected: FAIL — `recent-inbound` module not found.

- [ ] **Step 3: Implement `recent-inbound.ts`**

```ts
// src/daemon/wiring/recent-inbound.ts
/**
 * Introspect's "用户最近发的消息" feed. Reads a window from the canonical
 * messages table (spec D4) rather than any live poll state — the introspect
 * tick runs on a 24h cadence, so persisted history IS the right source.
 * Fetches limit*3 rows to survive interleaved 'out' bubbles (reply-splitting
 * writes several 'out' rows per 'in'), then keeps the newest `limit` inbound.
 */
import type { MessagesStore } from '../../lib/messages-store'

export async function recentInboundTexts(
  store: MessagesStore,
  chatId: string,
  limit = 10,
): Promise<string[]> {
  const rows = await store.listRange(chatId, { limit: limit * 3 })
  return rows
    .filter(r => r.direction === 'in' && r.kind !== 'command' && r.text.trim().length > 0)
    .slice(-limit)
    .map(r => r.text)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run src/daemon/wiring/recent-inbound.test.ts` → PASS.
(Note: the limit-cap test seeds 15 in-rows and no out-rows; limit*3=30 covers all, `.slice(-10)` gives m5..m14.)

- [ ] **Step 5: Wire into `introspectTick`**

In `src/daemon/wiring/tick-bodies.ts`: move the existing `const messagesStore = makeMessagesStore(deps.db)` (currently at ~:579, above threads extraction) UP to just before `makeIntrospectAgent` (~:557), and replace:

```ts
      // Matches legacy main.ts v0.4.1 — recentInboundForChat() also returned [].
      recentInboundMessages: () => Promise.resolve([] as string[]),
```

with:

```ts
      recentInboundMessages: () => recentInboundTexts(messagesStore, chatId),
```

Add the import `import { recentInboundTexts } from './recent-inbound'`. Delete the now-duplicate `makeMessagesStore` line at the threads-extraction site (reuse the hoisted one).

- [ ] **Step 6: Run the surrounding suites**

Run: `bun run vitest run src/daemon/wiring/ src/daemon/companion/introspect-prompt.test.ts`
Expected: PASS (tick-bodies.test.ts must still pass — if it stubbed the old `[]` behavior, update the stub to match the new wiring).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/wiring/recent-inbound.ts src/daemon/wiring/recent-inbound.test.ts src/daemon/wiring/tick-bodies.ts
git commit -m "fix(introspect): feed real recent inbound messages into the introspect prompt"
```

---

### Task 2: Facts temporal validity + conflict supersede

**Files:**
- Modify: `src/core/knowledge/store.ts` (facts.db schema + `upsertFact` + new methods; `FactRow` type)
- Modify: `src/core/knowledge/facts.ts` (`record` returns conflicts; new `supersede`)
- Modify: `src/daemon/companion/ingest/facts-inproc.ts` (serve `supersede_facts`)
- Modify: `src/daemon/companion/ingest/extract.ts` (conflict resolution via cheapEval)
- Test: `src/core/knowledge/store.test.ts`, `src/core/knowledge/facts.test.ts`, `src/daemon/companion/ingest/extract.test.ts` (extend existing)

**Interfaces:**
- Produces (store): `FactRow` gains `valid_from: number | null; invalidated_at: number | null; superseded_by: number | null`. `upsertFact` return changes `'inserted' | 'merged'` → `{ outcome: 'inserted' | 'merged'; id: number }`. New methods:
  - `activeFactsSharingPredicate(contact: string, predicate: string, excludeValue: string): FactRow[]`
  - `supersedeFactById(oldId: number, newId: number, now: number): boolean` (only if old row is `active`; sets `status='superseded', invalidated_at=now, superseded_by=newId, updated_at=now`)
- Produces (FactsApi): `record(batchId, facts, now)` result gains `conflicts: Array<{ id: number; predicate: string; value: string; against: Array<{ id: number; value: string }> }>`. New method `supersede(pairs: Array<{ supersede: number; by: number }>, now: number): { superseded: number }` — deterministic guard: both ids exist, same `contact`+`predicate`, old is active, ids differ; invalid pairs skipped silently.
- Produces (extract): `buildConflictPrompt(conflicts)` and `parseSupersedePairs(text): Array<{ supersede: number; by: number }>` exported for tests.

**Migration note:** facts.db has no version chain — schema is `CREATE TABLE IF NOT EXISTS` at open (`store.ts:609`). Use guarded ALTER: read `PRAGMA table_info(facts)`, `ALTER TABLE facts ADD COLUMN` each missing column, then one-time backfill `UPDATE facts SET valid_from = created_at WHERE valid_from IS NULL`.

- [ ] **Step 1: Write failing store tests** (extend `src/core/knowledge/store.test.ts`, follow the file's existing setup helper for a temp-dir store)

```ts
describe('facts temporal validity', () => {
  it('insert stamps valid_from = now and returns the row id', () => {
    const r = store.upsertFact({ contact: 'u1', kind: 'attribute', predicate: '住在', value: '北京' }, 1000)
    expect(r.outcome).toBe('inserted')
    const row = store.factsForContact('u1', 'active')[0]!
    expect(row.valid_from).toBe(1000)
    expect(row.invalidated_at).toBeNull()
    expect(row.superseded_by).toBeNull()
  })

  it('activeFactsSharingPredicate finds same-predicate different-value active facts', () => {
    const a = store.upsertFact({ contact: 'u1', kind: 'attribute', predicate: '住在', value: '北京' }, 1000)
    store.upsertFact({ contact: 'u1', kind: 'attribute', predicate: '住在', value: '上海' }, 2000)
    const hits = store.activeFactsSharingPredicate('u1', '住在', '上海')
    expect(hits.map(h => h.value)).toEqual(['北京'])
    expect(hits[0]!.id).toBe(a.id)
  })

  it('supersedeFactById flips status + stamps invalidated_at/superseded_by; refuses non-active', () => {
    const a = store.upsertFact({ contact: 'u1', predicate: '住在', value: '北京' }, 1000)
    const b = store.upsertFact({ contact: 'u1', predicate: '住在', value: '上海' }, 2000)
    expect(store.supersedeFactById(a.id, b.id, 3000)).toBe(true)
    expect(store.factsForContact('u1', 'active').map(f => f.value)).toEqual(['上海'])
    const dead = store.factsForContact('u1', 'superseded')[0]!
    expect(dead.invalidated_at).toBe(3000)
    expect(dead.superseded_by).toBe(b.id)
    expect(store.supersedeFactById(a.id, b.id, 4000)).toBe(false)  // already superseded
  })

  it('reopening an existing facts.db adds the new columns (guarded ALTER)', () => {
    // write with the OLD shape by inserting directly, then reopen — covered by
    // opening the same dir twice: first open creates, second open must not throw
    // and rows written before the columns existed read back with valid_from backfilled.
  })
})
```

(For the reopen test: insert a fact, `store.close()`, `openKnowledge(sameDir)` again, assert `factsForContact` returns `valid_from === created_at`.)

- [ ] **Step 2: Run to verify failure** — `bun run vitest run src/core/knowledge/store.test.ts` → FAIL (type errors on `.outcome`, missing methods).

- [ ] **Step 3: Implement store changes** (`src/core/knowledge/store.ts`)

After the facts.db `CREATE TABLE IF NOT EXISTS` block (~:617):

```ts
  // Temporal validity (2026-08 memory-upgrades) — guarded ALTER so a facts.db
  // created before these columns existed upgrades in place. valid_from
  // backfills from created_at exactly once (WHERE valid_from IS NULL).
  const factCols = new Set((factsDb.query('PRAGMA table_info(facts)').all() as Array<{ name: string }>).map(c => c.name))
  if (!factCols.has('valid_from')) factsDb.exec('ALTER TABLE facts ADD COLUMN valid_from INTEGER')
  if (!factCols.has('invalidated_at')) factsDb.exec('ALTER TABLE facts ADD COLUMN invalidated_at INTEGER')
  if (!factCols.has('superseded_by')) factsDb.exec('ALTER TABLE facts ADD COLUMN superseded_by INTEGER')
  if (!factCols.has('valid_from')) factsDb.exec('UPDATE facts SET valid_from = created_at WHERE valid_from IS NULL')
```

`upsertFact`: INSERT gains `valid_from` (= `now`); return `{ outcome: 'inserted', id: Number(insertResult.lastInsertRowid) }` / `{ outcome: 'merged', id: prev.id }` (bun:sqlite `.run()` returns `lastInsertRowid`). New methods:

```ts
    activeFactsSharingPredicate(contact, predicate, excludeValue) {
      return (factsDb.query(
        "SELECT * FROM facts WHERE contact=? AND predicate=? AND value<>? AND status='active' ORDER BY updated_at DESC",
      ).all(contact, predicate, excludeValue) as any[]).map(parseFactRow)
    },

    supersedeFactById(oldId, newId, now) {
      const c = factsDb.query(
        "UPDATE facts SET status='superseded', invalidated_at=?, superseded_by=?, updated_at=? WHERE id=? AND status='active'",
      ).run(now, newId, oldId === newId ? -1 : oldId) // (see note)
      return c.changes > 0
    },
```

(Careful with arg order — write it as `.run(now, newId, now, oldId)` matching the four placeholders; the snippet above is illustrative, the test locks the real behavior.) Update `KnowledgeStore` interface + `FactRow` accordingly, and fix the two existing `upsertFact` call sites' type usage (facts.ts, tests).

- [ ] **Step 4: Store tests pass** — `bun run vitest run src/core/knowledge/store.test.ts` → PASS.

- [ ] **Step 5: Write failing FactsApi tests** (extend `src/core/knowledge/facts.test.ts`)

```ts
it('record reports same-predicate conflicts without auto-superseding', () => {
  // seed: active fact 住在=北京 for contact c1, then record a batch containing 住在=上海
  const res = api.record(batchId, [{ kind: 'attribute', predicate: '住在', value: '上海' }], 2000) as any
  expect(res.conflicts).toHaveLength(1)
  expect(res.conflicts[0].against.map((a: any) => a.value)).toEqual(['北京'])
  // both still active — resolution is the judge's job, not record's
  expect(store.factsForContact('c1', 'active')).toHaveLength(2)
})

it('supersede applies valid pairs and skips invalid ones', () => {
  const res = api.supersede([
    { supersede: idBeijing, by: idShanghai },   // valid
    { supersede: 99999, by: idShanghai },        // unknown id — skipped
    { supersede: idOtherPredicate, by: idShanghai }, // predicate mismatch — skipped
  ], 3000) as any
  expect(res.superseded).toBe(1)
})
```

- [ ] **Step 6: Implement FactsApi changes** (`src/core/knowledge/facts.ts`)

In `record`: collect `conflicts` — for each upserted fact (using the returned `id`), call `store.activeFactsSharingPredicate(contact, predicate, value)`; if non-empty push `{ id, predicate, value, against: hits.map(h => ({ id: h.id, value: h.value })) }`. Return `{ recorded, merged, advanced_to, conflicts }`.

New `supersede(pairs, now)`:

```ts
    supersede(pairs, now) {
      let superseded = 0
      for (const p of pairs ?? []) {
        if (!p || typeof p.supersede !== 'number' || typeof p.by !== 'number' || p.supersede === p.by) continue
        const rows = factsById(store, [p.supersede, p.by]) // helper: SELECT by id via findFactRows? add store.factById(id)
        // guard: both exist, same contact+predicate, old is active
        ...
        if (store.supersedeFactById(p.supersede, p.by, now)) superseded++
      }
      return { superseded }
    },
```

Add `store.factById(id: number): FactRow | null` to the store (trivial SELECT) — the guard needs it; include a store test for it in Step 1's batch if missed. Add `supersede` to the `FactsApi` interface.

- [ ] **Step 7: FactsApi tests pass** — `bun run vitest run src/core/knowledge/facts.test.ts` → PASS.

- [ ] **Step 8: Write failing extract-side tests** (extend `src/daemon/companion/ingest/extract.test.ts`)

```ts
describe('conflict resolution', () => {
  it('parseSupersedePairs: tolerant parse, drops malformed, [] on garbage', () => {
    expect(parseSupersedePairs('[{"supersede":1,"by":2},{"supersede":"x"}]')).toEqual([{ supersede: 1, by: 2 }])
    expect(parseSupersedePairs('I refuse')).toEqual([])
  })

  it('runExtraction resolves conflicts with one judge call and calls supersede_facts', async () => {
    // stub `call`: extraction_batch → one batch then done; record_facts → JSON with conflicts;
    // capture supersede_facts input. stub cheapEval: extraction prompt → facts JSON;
    // conflict prompt (detect via prompt content) → '[{"supersede":11,"by":22}]'
    // assert call('supersede_facts', { pairs: [{ supersede: 11, by: 22 }] }) happened
  })

  it('judge eval throw → no supersede call, extraction still counts the batch', async () => { ... })
  it('no conflicts in record_facts response → no judge call', async () => { ... })
})
```

- [ ] **Step 9: Implement extract-side resolution** (`src/daemon/companion/ingest/extract.ts`)

```ts
export interface ConflictGroup {
  id: number
  predicate: string
  value: string
  against: Array<{ id: number; value: string }>
}

/** One judge call per batch: which same-predicate values are UPDATES (old
 *  superseded by new) vs COEXISTING (multi-valued predicate, keep both)? */
export function buildConflictPrompt(conflicts: ConflictGroup[]): string {
  const lines = conflicts.map(c =>
    `- 新事实 #${c.id}「${c.predicate} = ${c.value}」 vs 旧事实 ` +
    c.against.map(a => `#${a.id}「${c.predicate} = ${a.value}」`).join('、'),
  ).join('\n')
  return (
    `你是一个事实库管理器（不是聊天助手）。同一个人、同一谓词出现了不同的值。\n` +
    `判断每一组：新值是**替代**旧值（人搬家了、换工作了——旧值应作废），还是**并存**（爱好、朋友——都保留）。\n` +
    `只对确定是替代关系的组输出 {"supersede": 旧事实id, "by": 新事实id}。不确定就不输出（保守优先）。\n` +
    `**只输出 JSON 数组，不要解释，不要代码围栏。**没有替代关系就输出 []。\n\n` + lines
  )
}

export function parseSupersedePairs(text: string): Array<{ supersede: number; by: number }> {
  // reuse firstJsonArray; validate each element: both fields finite numbers; never throws
}
```

In `runExtraction`, after the successful `record_facts` call:

```ts
    let resp: { conflicts?: ConflictGroup[] } = {}
    try { resp = JSON.parse(recordResult) } catch { /* legacy shape — no conflicts */ }
    if (resp.conflicts && resp.conflicts.length > 0) {
      try {
        const pairs = parseSupersedePairs(await d.cheapEval(buildConflictPrompt(resp.conflicts)))
        if (pairs.length > 0) await d.call('supersede_facts', { pairs })
      } catch (e) {
        // judge/supersede failure is non-fatal: facts coexist (today's behavior);
        // the watermark has already advanced, nothing to retry.
        d.log?.('INGEST', `conflict resolution skipped for ${batch.batch_id}: ${String(e)}`)
      }
    }
```

(`record_facts` result is currently discarded — capture it: `const recordResult = await d.call('record_facts', ...)`.)

- [ ] **Step 10: Extend facts-inproc** (`src/daemon/companion/ingest/facts-inproc.ts`) — add:

```ts
    if (tool === 'supersede_facts') {
      return JSON.stringify(facts.supersede((b.pairs as any[] | undefined) ?? [], nowFn()))
    }
```

and update the header comment + error message. Extend its test file if one exists (grep `facts-inproc.test`).

- [ ] **Step 11: Full task suites pass**

Run: `bun run vitest run src/core/knowledge/ src/daemon/companion/ingest/`
Expected: PASS, including pre-existing tests (the `upsertFact` return-shape change touches `store.test.ts`/`facts.test.ts` assertions — update them to the `{ outcome, id }` shape).

- [ ] **Step 12: Commit**

```bash
git add src/core/knowledge/store.ts src/core/knowledge/facts.ts src/core/knowledge/store.test.ts src/core/knowledge/facts.test.ts src/daemon/companion/ingest/
git commit -m "feat(facts): temporal validity — valid_from/invalidated_at/superseded_by + judge-driven conflict supersede"
```

---

### Task 3: Auto-recall injection for admin chats

**Files:**
- Modify: `src/core/prompt-format.ts` (`InboundMsg.recall`, `<recall>` rendering)
- Create: `src/daemon/inbound/mw-recall.ts`
- Modify: `src/daemon/inbound/build.ts` (insert between welcome and llmHealth; add `recall` to `InboundPipelineDeps`)
- Modify: `src/daemon/wiring/pipeline-deps.ts` (wire recall fn from `boot.knowledge`)
- Test: `src/core/prompt-format.test.ts` (extend if exists, else create), `src/daemon/inbound/mw-recall.test.ts` (new), `src/daemon/inbound/build.test.ts` (extend deps fixture)

**Interfaces:**
- Produces: `InboundMsg` gains `recall?: string[]`. `RecallMwDeps = { recall?: (chatId: string, text: string) => Promise<string[]>; isAdmin: (chatId: string) => boolean; timeoutMs?: number; log: (tag: string, line: string) => void }`. `makeMwRecall(deps): Middleware`.
- Consumes: `boot.knowledge.{embedQuery, embedder, search, store}` (`src/daemon/bootstrap/types.ts:393-398`), `isAdmin` closure already in pipeline-deps scope.
- Constants: `RECALL_LIMIT = 3`, `RECALL_ITEM_MAX = 160` (chars per line), `RECALL_BLOCK_MAX = 800` (chars, joined), `RECALL_TIMEOUT_MS = 4000`, `RECALL_MIN_QUERY = 4` (chars of msg text).

- [ ] **Step 1: Write failing prompt-format tests**

```ts
it('renders a <recall> element before the body when msg.recall is set', () => {
  const out = formatInbound({ ...base, text: 'hi', recall: ['[w_x 张三 2026-08-01] 上次说搬去上海'] })
  expect(out).toContain('<recall hint="自动检索的相关片段，可能不相关，仅供参考">')
  expect(out.indexOf('<recall')).toBeLessThan(out.indexOf('hi'))
  expect(out).toContain('上次说搬去上海')
})
it('omits <recall> entirely when recall is absent or empty', () => { ... })
it('escapes recall body (< & →  &lt; &amp;)', () => { ... })
it('caps the joined recall block at RECALL_BLOCK_MAX chars', () => { ... })
```

- [ ] **Step 2: Implement prompt-format change**

```ts
export const RECALL_BLOCK_MAX = 800

// inside formatInbound, above `const body = ...`:
  const recallLines = (m.recall ?? []).filter(r => r.trim().length > 0)
  const recallEl = recallLines.length
    ? `<recall hint="自动检索的相关片段，可能不相关，仅供参考">\n${escBody(recallLines.join('\n')).slice(0, RECALL_BLOCK_MAX)}\n</recall>`
    : ''
  const body = [recallEl, quoteEl, escBody(m.text), ...attachmentLines].filter(Boolean).join('\n')
```

Run: `bun run vitest run src/core/prompt-format.test.ts` → PASS.

- [ ] **Step 3: Write failing mw-recall tests**

```ts
// src/daemon/inbound/mw-recall.test.ts — follow mw-milestone.test.ts fixture style
it('attaches recall items for an admin chat before calling next', async () => {
  // deps.recall resolves ['a','b']; assert ctx.msg.recall === ['a','b'] and next was called
})
it('no recall fn wired → passthrough, msg.recall undefined', ...)
it('non-admin chat → passthrough, recall fn NOT called', ...)
it('recall fn throws → passthrough (no recall), logged, next still called', ...)
it('recall fn slower than timeoutMs → passthrough without recall', async () => {
  // deps.timeoutMs = 10, recall = () => new Promise(r => setTimeout(() => r(['late']), 100))
})
it('short text (<4 chars) → recall fn not called', ...)
it('empty result array → msg.recall stays undefined', ...)
```

- [ ] **Step 4: Implement mw-recall**

```ts
// src/daemon/inbound/mw-recall.ts
/**
 * Auto-recall (2026-08 memory-upgrades) — inject top-K knowledge-kernel hits
 * into the inbound envelope so a live turn starts with relevant memory even
 * when the agent doesn't call knowledge_search/memory_read itself.
 *
 * Admin-gated: the kernel indexes the owner's whole WeChat archive, the same
 * private-data trust class as the admin-only knowledge_search MCP tool — a
 * guest/trusted chat must never receive recall from it.
 *
 * Soft-fail by design: timeout, embedder error, or an empty result all mean
 * "no recall block this turn", never a failed turn.
 */
import type { Middleware } from './types'

export const RECALL_TIMEOUT_MS = 4000
export const RECALL_MIN_QUERY = 4

export interface RecallMwDeps {
  /** Undefined ⇔ knowledge kernel not wired — middleware is inert. */
  recall?: (chatId: string, text: string) => Promise<string[]>
  isAdmin: (chatId: string) => boolean
  timeoutMs?: number
  log: (tag: string, line: string) => void
}

export function makeMwRecall(deps: RecallMwDeps): Middleware {
  const timeoutMs = deps.timeoutMs ?? RECALL_TIMEOUT_MS
  return async (ctx, next) => {
    const { msg } = ctx
    if (deps.recall && deps.isAdmin(msg.chatId) && msg.text.trim().length >= RECALL_MIN_QUERY) {
      try {
        const items = await Promise.race([
          deps.recall(msg.chatId, msg.text),
          new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('recall_timeout')), timeoutMs)),
        ])
        if (items.length > 0) (msg as { recall?: string[] }).recall = items
      } catch (err) {
        deps.log('RECALL', `skip for ${msg.chatId}: ${err instanceof Error ? err.message : err}`)
      }
    }
    await next()
  }
}
```

Run: `bun run vitest run src/daemon/inbound/mw-recall.test.ts` → PASS.

- [ ] **Step 5: Insert into pipeline + wire deps**

`build.ts`: add `recall: RecallMwDeps` to `InboundPipelineDeps`; insert `makeMwRecall(d.recall)` after `makeMwWelcome` and before `makeMwLlmHealth` (recall must not run for consumed messages — every consumer above returns without next(); and must complete before dispatch formats the envelope). Update `build.test.ts` fixture.

`pipeline-deps.ts` (inside `pipelineDeps`):

```ts
    recall: {
      isAdmin,
      log,
      ...(boot.knowledge?.embedQuery && boot.knowledge.embedder
        ? {
            recall: async (_chatId: string, text: string) => {
              const k = boot.knowledge!
              const vec = await k.embedQuery!(text)
              const { results } = k.search(k.store, {
                queryVector: vec, queryText: text,
                model_id: k.embedder!.model_id, limit: 3,
              })
              return results.map(r => {
                const ts = new Date(r.time * (r.time < 1e12 ? 1000 : 1)).toISOString().slice(0, 10)
                return `[${ts} ${r.sender}] ${r.text.slice(0, 160)}`
              })
            },
          }
        : {}),
    },
```

- [ ] **Step 6: Run inbound + wiring suites**

Run: `bun run vitest run src/daemon/inbound/ src/core/prompt-format.test.ts`
Expected: PASS (pipeline.integration.test.ts fixture needs the new `recall` dep — add `{ isAdmin: () => false, log: noop }`).

- [ ] **Step 7: Commit**

```bash
git add src/core/prompt-format.ts src/daemon/inbound/mw-recall.ts src/daemon/inbound/mw-recall.test.ts src/daemon/inbound/build.ts src/daemon/wiring/pipeline-deps.ts src/core/prompt-format.test.ts src/daemon/inbound/build.test.ts
git commit -m "feat(recall): auto-inject top-3 knowledge hits into admin-chat turns via mw-recall"
```

---

### Task 4: FTS5 cross-session search

**Files:**
- Create: `src/daemon/sessions/fts-index.ts` (+ test `fts-index.test.ts`)
- Modify: `src/lib/db.ts` (one new migration: `session_turns_fts` + `session_fts_state`)
- Modify: `src/daemon/sessions/searcher.ts` (FTS path + scan fallback)
- Test: `src/daemon/sessions/searcher.test.ts` (extend)

**Interfaces:**
- Produces (db migration): `CREATE VIRTUAL TABLE session_turns_fts USING fts5(text, alias UNINDEXED, session_id UNINDEXED, turn_index UNINDEXED, tokenize='trigram')` and `CREATE TABLE session_fts_state (path TEXT PRIMARY KEY, session_id TEXT NOT NULL, alias TEXT NOT NULL, lines_indexed INTEGER NOT NULL, byte_size INTEGER NOT NULL) STRICT`.
- Produces (fts-index): `refreshSessionFtsIndex(db: Db, sessions: Array<{ alias: string; session_id: string; path: string }>): void` — per file: stat size; if size < stored `byte_size` (rewritten/truncated) delete that path's fts rows + state and reindex from 0; if grown, index only lines ≥ `lines_indexed`; store each line's first `FTS_LINE_MAX = 2000` chars. `ftsSearchSessions(db, query, limit): Array<{ alias: string; session_id: string; turn_index: number }>` — phrase-literal quoting (same `'"' + q.replace(/"/g, '""') + '"'` pattern as `store.ts` keywordSearch).
- Consumes (searcher): existing `SearchHit` shape unchanged; `resolveProjectJsonlPath`, `makeSessionStore`.
- Behavior contract: query length < 3 (trigram minimum) → legacy substring scan; otherwise FTS index refresh + FTS query, snippets computed by reading the matched line from the jsonl (same slice logic as today).

- [ ] **Step 1: Add the db migration** — append to the migrations array in `src/lib/db.ts` (next version number after the current tail; find with `grep -n "version:" src/lib/db.ts | tail -1`). FTS5 virtual tables can't be STRICT; the state table is. Run the whole db suite: `bun run vitest run src/lib/db.test.ts` (migration-count assertions may need the new version).

- [ ] **Step 2: Write failing fts-index tests**

```ts
// src/daemon/sessions/fts-index.test.ts — openTestDb() + temp dir jsonl fixtures
it('indexes a jsonl file line-by-line and finds CJK + ascii matches', ...)
it('incremental: appending lines only indexes the new lines (state advances)', ...)
it('truncated/rewritten file (smaller byte_size) → reindexed from scratch', ...)
it('caps stored text at FTS_LINE_MAX chars but still matches within the cap', ...)
it('phrase-literal quoting: query with " and FTS operators does not throw', ...)
it('missing file → skipped, state untouched', ...)
```

- [ ] **Step 3: Implement fts-index.ts** — pure functions over `Db` + `node:fs` (`statSync`, `readFileSync`); wrap each file's rows in one transaction (`db.exec('BEGIN')`/`COMMIT` or bun:sqlite `db.transaction`). Run → PASS.

- [ ] **Step 4: Write failing searcher tests** (extend `searcher.test.ts`)

```ts
it('≥3-char query uses the FTS index and returns the same SearchHit shape', ...)
it('2-char query falls back to the substring scan (still finds hits)', ...)
it('FTS results honor `limit`', ...)
it('re-search after new turns appended finds the new content (incremental refresh)', ...)
```

- [ ] **Step 5: Rewrite `searchAcrossSessions`** — keep the legacy scan as a private `scanSessions()` fallback; main path: build session list from the store (as today), call `refreshSessionFtsIndex`, run `ftsSearchSessions`, then for each hit read the matched line from the file (skip if file/line vanished — index may be ahead of a deleted transcript) and produce the `SearchHit` (`snippet` = 140-char window around the first case-insensitive match in the raw line, matching today's slice logic; `session_has_reply_tool` computed per session file once, as today). Update the file's header comment (the "v0.5 FTS upgrade" note is now the implementation). Run → PASS.

- [ ] **Step 6: Full sessions suite** — `bun run vitest run src/daemon/sessions/ src/lib/db.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db.ts src/daemon/sessions/fts-index.ts src/daemon/sessions/fts-index.test.ts src/daemon/sessions/searcher.ts src/daemon/sessions/searcher.test.ts
git commit -m "feat(sessions): FTS5 trigram cross-session search with incremental jsonl indexing"
```

---

### Final verification

- [ ] Run the full unit suite: `bun run vitest run` (default config; e2e configs excluded as usual). All green.
- [ ] `bun run tsc --noEmit` if the repo has a typecheck script (check `package.json`); otherwise vitest's transform coverage suffices.
- [ ] Update `docs/architecture.md`'s memory section pointers if the doc lists `recentInboundMessages` as a known gap.
