# Knowledge Kernel — facts + person layers in-process (Relay 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the facts (agent-driven structured-fact extraction) and person (unified per-contact brief) layers off their `..`-reading + sibling-importing Python plugins into in-process TS kernel modules, reading the kernel source/graph in-process, and retire the wxfacts + wxperson plugins.

**Architecture:** A `facts.db` (claim table + per-contact extraction watermark) opened in the knowledge root alongside source/semantic/graph, with low-level methods on `KnowledgeStore` (parallel to graph). `facts.ts` (`makeFactsApi(store)`) ports wxfacts's candidate-feed + record + query orchestration, reading 1:1 text from source and resolving names via the in-process graph. `person.ts` (`makePersonApi(store)`) is a stateless Query composite over graph + facts + source recent messages. Query/Ingest routes + admin agent tools + prompt bullets mirror the graph slice EXACTLY. facts is agent-driven → **no knowledge-cycle wiring**.

**Tech Stack:** TypeScript/Bun (`bun test`). Host repo `wechat-cc` branch `feat/knowledge-facts-person-inproc` (base dev `f31270d2`). Plugins repo `wechat-cc-plugins` (retire wxfacts/wxperson, Python).

## Global Constraints
- **Faithful port — pin the semantics.** Port `wxfacts/store.py`'s merge EXACTLY: UNIQUE(contact,predicate,value) → on conflict MERGE (ordered-union `source_msg_keys`, `confidence` = max by `{low:0,med:1,high:2}`, `related_contact`/`time_ref` fill-if-absent, **status untouched**); watermark monotonic on the `(ts, local_id)` tuple. Tests assert these, not just "runs".
- **Candidate-feed cursor:** order each conversation by `(ts, local_id)` where `local_id` is parsed from `msg_key` (the integer after the last `:` — `msg_key = "<table>:<local_id>"`). **No source schema change.**
- **Source stays immutable ground-truth** — facts/person only READ source; person writes nothing.
- **Admin-only** — all facts/person Query/Ingest routes + tools are admin-tier, fail-closed (mirror graph). Route-tiers defaults unlisted routes to `'admin'`, but list them explicitly.
- **Exhaustive `Record<ToolKind>` maps** — adding `facts_query`/`person_query` ToolKinds means every `Record<ToolKind, X>` (esp. `TOOL_KIND_TO_CLAUDE_BUILTINS` in `claude-agent-provider.ts`) MUST gain entries or tsc won't compile. This is the "wired everywhere" signal.
- **TDD**; `bun test <file>`; `bunx tsc --noEmit` clean before each commit; never `git add -A`; never touch package.json/bun.lock; commits end `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Source of truth
Spec: `docs/superpowers/specs/2026-08-12-knowledge-facts-person-inproc-design.md`. Port source (read these — they are the reviewed algorithm): `wechat-cc-plugins/packages/wxfacts/wxfacts/{store,facts,source}.py`, `wechat-cc-plugins/packages/wxperson/wxperson/brief.py`. Wiring template (mirror EXACTLY): the graph slice — `src/core/knowledge/graph-query.ts`, `src/daemon/internal-api/{types,routes-knowledge,route-tiers}.ts`, `src/mcp-servers/wechat/tools-graph.ts`, `src/mcp-servers/wechat/main.ts`, `src/core/{user-tier,claude-agent-provider,prompt-builder}.ts`, `src/daemon/bootstrap/index.ts`.

---

## Task 1: facts.db store layer (tables + methods + source reads)

**Files:**
- Modify: `src/core/knowledge/store.ts` (open `facts.db`; add `Fact`/`FactRow` types + facts methods to the `KnowledgeStore` interface and its `openKnowledge` implementation; add two source reads)
- Test: `src/core/knowledge/store.test.ts`

**Interfaces:**
- Consumes: `openKnowledge(root)` (existing), the existing `messages` table (`msg_key, conversation, sender, time, text, is_group, kind`).
- Produces (add to `KnowledgeStore`):
  ```ts
  export interface Fact {           // agent-supplied claim (record_facts)
    contact?: string; kind?: string; predicate: string; value: string
    related_contact?: string; time_ref?: string
    confidence?: string             // 'low'|'med'|'high', default 'med'
    source_msg_keys?: string[]
  }
  export interface FactRow {         // stored row
    id: number; contact: string; kind: string | null; predicate: string; value: string
    related_contact: string | null; time_ref: string | null; confidence: string
    source_msg_keys: string[]; status: string; created_at: number; updated_at: number
  }
  // on KnowledgeStore:
  upsertFact(fact: Fact & { contact: string }, now: number): 'inserted' | 'merged'
  factWatermark(contact: string): [number, number]
  advanceFactWatermark(contact: string, ts: number, localId: number, now: number): void
  allFactWatermarks(): Map<string, [number, number]>
  factsForContact(contact: string, status: string): FactRow[]
  findFactRows(kind: string | null, predicate: string | null, query: string | null, status: string, limit: number): FactRow[]
  setFactStatusById(id: number, status: string, now: number): boolean
  factCountsByKind(): Record<string, number>
  // source reads:
  oneToOneTextMessages(): Array<{ msg_key: string; conversation: string; sender: string; time: number; text: string }>
  recentMessages(conversation: string, limit: number): Array<{ sender: string; time: number; text: string }>
  ```

- [ ] **Step 1: Write failing tests** in `store.test.ts` (append a `describe('facts store')`). Cover the merge semantics precisely:

```ts
import { openKnowledge } from './store'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function freshStore() {
  return openKnowledge(mkdtempSync(join(tmpdir(), 'kk-facts-')))
}

test('upsertFact inserts then merges on (contact,predicate,value)', () => {
  const s = freshStore()
  const f = { contact: 'wxid_a', kind: 'entity', predicate: 'works_at', value: 'Acme',
              confidence: 'low', source_msg_keys: ['Msg_x:1'] }
  expect(s.upsertFact(f, 1000)).toBe('inserted')
  // merge: higher confidence wins, msg_keys ordered-union, related/time_ref fill, status untouched
  expect(s.upsertFact({ ...f, confidence: 'high', related_contact: 'wxid_b',
                        time_ref: '2025', source_msg_keys: ['Msg_x:1', 'Msg_y:2'] }, 2000)).toBe('merged')
  const rows = s.factsForContact('wxid_a', 'active')
  expect(rows.length).toBe(1)
  expect(rows[0]!.confidence).toBe('high')                       // max(low,high)
  expect(rows[0]!.source_msg_keys).toEqual(['Msg_x:1', 'Msg_y:2']) // ordered union, no dupes
  expect(rows[0]!.related_contact).toBe('wxid_b')
  expect(rows[0]!.status).toBe('active')
  s.close()
})

test('merge does not downgrade confidence and keeps existing related/time_ref', () => {
  const s = freshStore()
  s.upsertFact({ contact: 'c', predicate: 'p', value: 'v', confidence: 'high',
                 related_contact: 'r1', time_ref: 't1', source_msg_keys: ['a:1'] }, 1)
  s.upsertFact({ contact: 'c', predicate: 'p', value: 'v', confidence: 'low',
                 source_msg_keys: ['b:2'] }, 2)                    // lower conf, no related/time_ref
  const r = s.factsForContact('c', 'active')[0]!
  expect(r.confidence).toBe('high')                               // not downgraded
  expect(r.related_contact).toBe('r1')                            // kept
  expect(r.time_ref).toBe('t1')
  expect(r.source_msg_keys).toEqual(['a:1', 'b:2'])
  s.close()
})

test('watermark is monotonic on the (ts, local_id) tuple', () => {
  const s = freshStore()
  expect(s.factWatermark('c')).toEqual([0, 0])
  s.advanceFactWatermark('c', 100, 5, 1)
  expect(s.factWatermark('c')).toEqual([100, 5])
  s.advanceFactWatermark('c', 100, 3, 2)                          // earlier tuple → no regress
  expect(s.factWatermark('c')).toEqual([100, 5])
  s.advanceFactWatermark('c', 100, 9, 3)                          // same ts, later local_id → advance
  expect(s.factWatermark('c')).toEqual([100, 9])
  s.close()
})

test('findFactRows filters by kind/predicate/substring/status; setFactStatusById; countsByKind', () => {
  const s = freshStore()
  s.upsertFact({ contact: 'c', kind: 'obligation', predicate: 'owes', value: '200 to Bob',
                 source_msg_keys: [] }, 1)
  s.upsertFact({ contact: 'c', kind: 'entity', predicate: 'likes', value: 'tea', source_msg_keys: [] }, 1)
  expect(s.findFactRows('obligation', null, null, 'active', 50).length).toBe(1)
  expect(s.findFactRows(null, null, 'Bob', 'active', 50).length).toBe(1)   // substring on value
  expect(s.factCountsByKind()).toEqual({ obligation: 1, entity: 1 })
  const id = s.factsForContact('c', 'active').find((r) => r.kind === 'obligation')!.id
  expect(s.setFactStatusById(id, 'resolved', 9)).toBe(true)
  expect(s.findFactRows('obligation', null, null, 'active', 50).length).toBe(0)
  expect(s.findFactRows('obligation', null, null, 'resolved', 50).length).toBe(1)
  s.close()
})

test('oneToOneTextMessages excludes groups and non-text; recentMessages is newest-first', () => {
  const s = freshStore()
  s.putSourceMessages([
    { msg_key: 'Msg_a:1', conversation: 'wxid_a', sender: 'wxid_a', time: 10, type: '1',
      text: 'hi', server_id: '1', local_type: 1, is_group: false, kind: 'text' },
    { msg_key: 'Msg_a:2', conversation: 'wxid_a', sender: 'me', time: 20, type: '1',
      text: 'yo', server_id: '2', local_type: 1, is_group: false, kind: 'text' },
    { msg_key: 'Grp_x:1', conversation: 'x@chatroom', sender: 'wxid_a', time: 15, type: '1',
      text: 'grp', server_id: '3', local_type: 1, is_group: true, kind: 'text' },
    { msg_key: 'Msg_a:3', conversation: 'wxid_a', sender: 'wxid_a', time: 30, type: '34',
      text: '', server_id: '4', local_type: 34, is_group: false, kind: 'voice' },
  ])
  const oto = s.oneToOneTextMessages()
  expect(oto.map((m) => m.msg_key).sort()).toEqual(['Msg_a:1', 'Msg_a:2'])  // no group, no voice
  const recent = s.recentMessages('wxid_a', 5)
  expect(recent.map((m) => m.text)).toEqual(['yo', 'hi'])                    // newest-first by time
  s.close()
})
```

- [ ] **Step 2: Run tests, verify they fail.** `bun test src/core/knowledge/store.test.ts` → FAIL (methods undefined).

- [ ] **Step 3: Implement.** In `store.ts`: after the `graph.db` open block (near `:404`), add:

```ts
// ---- facts.db (facts + person slice) ------------------------------------
const factsDb = openSqlite(join(root, 'facts.db'))
factsDb.exec(`
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY, contact TEXT, kind TEXT, predicate TEXT, value TEXT,
    related_contact TEXT, time_ref TEXT, confidence TEXT, source_msg_keys TEXT,
    status TEXT, created_at INTEGER, updated_at INTEGER,
    UNIQUE(contact, predicate, value));
  CREATE TABLE IF NOT EXISTS extraction_state (
    contact TEXT PRIMARY KEY, last_ts INTEGER, last_local_id INTEGER DEFAULT 0,
    updated_at INTEGER);`)
```

Add a module-level confidence rank + row parser:
```ts
const CONF_RANK: Record<string, number> = { low: 0, med: 1, high: 2 }
function parseFactRow(r: any): FactRow {
  return { ...r, source_msg_keys: r.source_msg_keys ? JSON.parse(r.source_msg_keys) : [] }
}
```

Implement the methods on the returned store object (mirror the Python in `store.py` line-for-line):
```ts
upsertFact(fact, now) {
  const keys = [...(fact.source_msg_keys ?? [])]
  const conf = fact.confidence || 'med'
  const cur = factsDb.query('SELECT * FROM facts WHERE contact=? AND predicate=? AND value=?')
    .get(fact.contact, fact.predicate, fact.value) as any
  if (!cur) {
    factsDb.query(`INSERT INTO facts(contact,kind,predicate,value,related_contact,time_ref,
      confidence,source_msg_keys,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(fact.contact, fact.kind ?? null, fact.predicate, fact.value,
           fact.related_contact ?? null, fact.time_ref ?? null, conf,
           JSON.stringify(keys), 'active', now, now)
    return 'inserted'
  }
  const prev = parseFactRow(cur)
  const merged = [...new Set([...prev.source_msg_keys, ...keys])]              // ordered union
  const best = (CONF_RANK[conf] ?? 1) > (CONF_RANK[prev.confidence ?? 'med'] ?? 1) ? conf : prev.confidence
  factsDb.query(`UPDATE facts SET kind=?, related_contact=?, time_ref=?, confidence=?,
    source_msg_keys=?, updated_at=? WHERE id=?`)                              // status untouched
    .run(fact.kind ?? prev.kind, fact.related_contact ?? prev.related_contact,
         fact.time_ref ?? prev.time_ref, best, JSON.stringify(merged), now, prev.id)
  return 'merged'
},
factWatermark(contact) {
  const r = factsDb.query('SELECT last_ts,last_local_id FROM extraction_state WHERE contact=?')
    .get(contact) as any
  return r ? [r.last_ts, r.last_local_id] : [0, 0]
},
advanceFactWatermark(contact, ts, localId, now) {
  const [pt, pl] = this.factWatermark(contact)
  const nt = ts > pt || (ts === pt && localId > pl) ? [ts, localId] : [pt, pl]   // monotonic tuple
  factsDb.query(`INSERT INTO extraction_state(contact,last_ts,last_local_id,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(contact) DO UPDATE SET last_ts=excluded.last_ts,
    last_local_id=excluded.last_local_id, updated_at=excluded.updated_at`)
    .run(contact, nt[0], nt[1], now)
},
allFactWatermarks() {
  const m = new Map<string, [number, number]>()
  for (const r of factsDb.query('SELECT contact,last_ts,last_local_id FROM extraction_state').all() as any[])
    m.set(r.contact, [r.last_ts, r.last_local_id])
  return m
},
factsForContact(contact, status) {
  return (factsDb.query('SELECT * FROM facts WHERE contact=? AND status=? ORDER BY updated_at DESC')
    .all(contact, status) as any[]).map(parseFactRow)
},
findFactRows(kind, predicate, query, status, limit) {
  let sql = 'SELECT * FROM facts WHERE status=?'; const args: any[] = [status]
  if (kind) { sql += ' AND kind=?'; args.push(kind) }
  if (predicate) { sql += ' AND predicate=?'; args.push(predicate) }
  if (query) { sql += " AND (predicate LIKE '%'||?||'%' OR value LIKE '%'||?||'%')"; args.push(query, query) }
  sql += ' ORDER BY updated_at DESC LIMIT ?'; args.push(limit)
  return (factsDb.query(sql).all(...args) as any[]).map(parseFactRow)
},
setFactStatusById(id, status, now) {
  const c = factsDb.query('UPDATE facts SET status=?, updated_at=? WHERE id=?').run(status, now, id)
  return c.changes > 0
},
factCountsByKind() {
  const out: Record<string, number> = {}
  for (const r of factsDb.query('SELECT kind, COUNT(*) n FROM facts GROUP BY kind').all() as any[])
    out[r.kind] = r.n
  return out
},
oneToOneTextMessages() {
  return sourceDb.query(`SELECT msg_key, conversation, sender, time, text FROM messages
    WHERE is_group=0 AND kind='text'`).all() as any[]
},
recentMessages(conversation, limit) {
  return sourceDb.query(`SELECT sender, time, text FROM messages WHERE conversation=?
    ORDER BY time DESC LIMIT ?`).all(conversation, limit) as any[]
},
```
Also close `factsDb` in the store's `close()` method (add `factsDb.close()` alongside the others).

- [ ] **Step 4: Run tests, verify pass + tsc.** `bun test src/core/knowledge/store.test.ts` → PASS. `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit.**
```bash
git add src/core/knowledge/store.ts src/core/knowledge/store.test.ts
git commit -m "$(printf 'feat(knowledge): facts.db store + source reads (FP T1)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: facts.ts orchestration — `makeFactsApi(store)`

**Files:**
- Create: `src/core/knowledge/facts.ts`
- Test: `src/core/knowledge/facts.test.ts`
- **Read `wxfacts/facts.py` + `wxfacts/source.py` first** (the ported orchestration + batch-id encoding).

**Interfaces:**
- Consumes: `KnowledgeStore` (T1 facts methods + `oneToOneTextMessages`, `allContacts`, `allSourceContacts`), `resolveName(contacts, name)` from `./graph`.
- Produces:
  ```ts
  export interface FactsApi {
    nextBatch(contact: string | null, limit: number): object
    record(batchId: string, facts: Fact[], now: number): object
    contactFacts(name: string): object
    findFacts(kind: string | null, predicate: string | null, query: string | null, status: string | null, limit: number | null): object
    setFactStatus(id: number, status: string, now: number): object
    extractionStatus(): object
  }
  export function makeFactsApi(store: KnowledgeStore): FactsApi
  ```

- [ ] **Step 1: Write failing tests** `facts.test.ts`:

```ts
import { openKnowledge } from './store'
import { makeFactsApi } from './facts'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'

function seed() {
  const s = openKnowledge(mkdtempSync(join(tmpdir(), 'kk-facts2-')))
  s.putSourceMessages([
    { msg_key: 'Msg_a:1', conversation: 'wxid_a', sender: 'wxid_a', time: 10, type: '1', text: 'a1', server_id: '1', local_type: 1, is_group: false, kind: 'text' },
    { msg_key: 'Msg_a:2', conversation: 'wxid_a', sender: 'me', time: 20, type: '1', text: 'a2', server_id: '2', local_type: 1, is_group: false, kind: 'text' },
    { msg_key: 'Msg_b:1', conversation: 'wxid_b', sender: 'wxid_b', time: 5, type: '1', text: 'b1', server_id: '3', local_type: 1, is_group: false, kind: 'text' },
  ])
  return s
}

test('nextBatch picks the max-backlog contact and returns its candidates in order', () => {
  const s = seed(); const api = makeFactsApi(s)
  const batch = api.nextBatch(null, 40) as any
  expect(batch.contact).toBe('wxid_a')                       // 2 msgs > wxid_b's 1
  expect(batch.messages.map((m: any) => m.text)).toEqual(['a1', 'a2'])
  expect(typeof batch.batch_id).toBe('string')
  s.close()
})

test('record advances the watermark so the batch drops out of the backlog', () => {
  const s = seed(); const api = makeFactsApi(s)
  const batch = api.nextBatch('wxid_a', 40) as any
  const rec = api.record(batch.batch_id, [
    { predicate: 'said', value: 'hello', source_msg_keys: ['Msg_a:1'] }], 100) as any
  expect(rec.recorded).toBe(1)
  const again = api.nextBatch('wxid_a', 40) as any
  expect(again.done).toBe(true)                              // caught up
  const cf = api.contactFacts('wxid_a') as any
  expect(cf.by_kind).toBeDefined()                           // the recorded fact is queryable
  s.close()
})

test('nextBatch respects (ts, local_id) cursor — a same-second later local_id is still fed', () => {
  const s = openKnowledge(mkdtempSync(join(tmpdir(), 'kk-facts3-')))
  s.putSourceMessages([
    { msg_key: 'Msg_c:1', conversation: 'wxid_c', sender: 'wxid_c', time: 50, type: '1', text: 'first', server_id: '1', local_type: 1, is_group: false, kind: 'text' },
    { msg_key: 'Msg_c:2', conversation: 'wxid_c', sender: 'wxid_c', time: 50, type: '1', text: 'second', server_id: '2', local_type: 1, is_group: false, kind: 'text' },
  ])
  const api = makeFactsApi(s)
  const b1 = api.nextBatch('wxid_c', 1) as any                // covers (50,1)
  expect(b1.messages.map((m: any) => m.text)).toEqual(['first'])
  api.record(b1.batch_id, [], 1)                              // advance-only
  const b2 = api.nextBatch('wxid_c', 40) as any               // same-second (50,2) NOT skipped
  expect(b2.messages.map((m: any) => m.text)).toEqual(['second'])
  s.close()
})

test('find_facts obligation query; set_fact_status; extraction_status counts', () => {
  const s = seed(); const api = makeFactsApi(s)
  const b = api.nextBatch('wxid_a', 40) as any
  api.record(b.batch_id, [{ kind: 'obligation', predicate: 'owes', value: '50', source_msg_keys: [] }], 1)
  const found = api.findFacts('obligation', null, null, 'active', 50) as any
  expect(found.results.length).toBe(1)
  const st = api.extractionStatus() as any
  expect(st.facts_by_kind.obligation).toBe(1)
  s.close()
})
```

- [ ] **Step 2: Run, verify fail.** `bun test src/core/knowledge/facts.test.ts` → FAIL.

- [ ] **Step 3: Implement** `facts.ts` (port of `facts.py`; `local_id` parsed from `msg_key`):

```ts
import type { KnowledgeStore, Fact } from './store'
import { resolveName } from './graph'

const localIdOf = (msgKey: string): number => {
  const i = msgKey.lastIndexOf(':')
  return i < 0 ? 0 : Number(msgKey.slice(i + 1)) || 0
}
const encodeBatchId = (contact: string, ts: number, localId: number) =>
  JSON.stringify({ c: contact, u: ts, l: localId })
const decodeBatchId = (b: string): [string, number, number] => {
  const d = JSON.parse(b); return [d.c, Number(d.u), Number(d.l ?? 0)]
}

export interface FactsApi { /* as in Interfaces block */ }

export function makeFactsApi(store: KnowledgeStore): FactsApi {
  const displayMap = () => new Map(store.allSourceContacts().map((c) => [c.username, c.display]))
  const grouped = () => {
    const g = new Map<string, Array<{ msg_key: string; conversation: string; sender: string; time: number; text: string; local_id: number }>>()
    for (const m of store.oneToOneTextMessages()) {
      const row = { ...m, local_id: localIdOf(m.msg_key) }
      if (!g.has(m.conversation)) g.set(m.conversation, [])
      g.get(m.conversation)!.push(row)
    }
    for (const rows of g.values())
      rows.sort((x, y) => x.time - y.time || x.local_id - y.local_id)   // total order
    return g
  }
  const resolveContact = (name: string): string => {
    const { username } = resolveName(store.allContacts(), name)
    return username ?? name                                             // fall back to raw (may be a username)
  }
  const backlog = (rows: any[], contact: string) => {
    const [wt, wl] = store.factWatermark(contact)
    return rows.filter((m) => m.time > wt || (m.time === wt && m.local_id > wl))
  }

  return {
    nextBatch(contact, limit) {
      const g = grouped()
      let picked = contact ? resolveContact(contact) : null
      let msgs: any[]
      if (picked) {
        msgs = backlog(g.get(picked) ?? [], picked)
      } else {
        let best = 0
        for (const [c, rows] of g) { const n = backlog(rows, c).length; if (n > best) { picked = c; best = n } }
        msgs = picked ? backlog(g.get(picked)!, picked) : []
      }
      msgs = msgs.slice(0, limit)
      if (msgs.length === 0) return { done: true }
      const last = msgs[msgs.length - 1]
      const dm = displayMap()
      return {
        batch_id: encodeBatchId(picked!, last.time, last.local_id),
        contact: picked, display: dm.get(picked!) ?? picked,
        covers_until_ts: last.time,
        messages: msgs.map((m) => ({ msg_key: m.msg_key, sender: dm.get(m.sender) ?? m.sender, time: m.time, text: m.text })),
      }
    },
    record(batchId, facts, now) {
      const [contact, ts, localId] = decodeBatchId(batchId)
      let inserted = 0, merged = 0
      for (const f of facts ?? []) {
        const withContact = { ...f, contact: f.contact ?? contact }
        if (store.upsertFact(withContact, now) === 'inserted') inserted++; else merged++
      }
      store.advanceFactWatermark(contact, ts, localId, now)
      return { recorded: inserted, merged, advanced_to: store.factWatermark(contact)[0] }
    },
    contactFacts(name) {
      const un = resolveContact(name)
      const by_kind: Record<string, any[]> = {}
      for (const f of store.factsForContact(un, 'active')) (by_kind[f.kind ?? 'unknown'] ??= []).push(f)
      return { resolved: true, contact: un, display: displayMap().get(un) ?? un, by_kind }
    },
    findFacts(kind, predicate, query, status, limit) {
      return { results: store.findFactRows(kind, predicate, query, status ?? 'active', limit ?? 50) }
    },
    setFactStatus(id, status, now) { return { ok: store.setFactStatusById(id, status, now) } },
    extractionStatus() {
      const g = grouped(); const per: any[] = []; let caught = 0
      for (const [c, rows] of g) {
        const remaining = backlog(rows, c).length
        if (remaining === 0) caught++
        per.push({ contact: c, extracted_until: store.factWatermark(c)[0], remaining })
      }
      per.sort((a, b) => b.remaining - a.remaining)
      return { contacts: g.size, caught_up: caught, facts_by_kind: store.factCountsByKind(), backlog: per.slice(0, 50) }
    },
  }
}
```

- [ ] **Step 4: Run, verify pass + tsc clean.**
- [ ] **Step 5: Commit** `feat(knowledge): facts orchestration — makeFactsApi (FP T2)` (add `facts.ts` + `facts.test.ts`).

---

## Task 3: person.ts — `makePersonApi(store)` (pure Query composite)

**Files:**
- Create: `src/core/knowledge/person.ts`
- Test: `src/core/knowledge/person.test.ts`
- **Read `wxperson/brief.py` first.**

**Interfaces:**
- Consumes: `makeGraphQueryApi(store)` (`contactProfile`), `makeFactsApi(store)` (`contactFacts`, `findFacts`), `resolveName` from `./graph`, `store.allContacts`/`recentMessages`.
- Produces:
  ```ts
  export interface PersonApi { personBrief(name: string, recentN: number): object }
  export function makePersonApi(store: KnowledgeStore): PersonApi
  ```

- [ ] **Step 1: Write failing tests** `person.test.ts`:

```ts
import { openKnowledge } from './store'; import { makePersonApi } from './person'
import { makeFactsApi } from './facts'; import { rebuildGraphFromSource } from './graph-build'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'

test('personBrief assembles graph + facts + recent, resolved by name', () => {
  const s = openKnowledge(mkdtempSync(join(tmpdir(), 'kk-person-')))
  s.putContacts([{ username: 'wxid_a', display: '小A' }])
  s.putSourceMessages([
    { msg_key: 'Msg_a:1', conversation: 'wxid_a', sender: 'wxid_a', time: 10, type: '1', text: 'hi', server_id: '1', local_type: 1, is_group: false, kind: 'text' },
    { msg_key: 'Msg_a:2', conversation: 'wxid_a', sender: 'me', time: 20, type: '1', text: 'yo', server_id: '2', local_type: 1, is_group: false, kind: 'text' },
  ])
  rebuildGraphFromSource({ store: s, now: 100, ownerOverride: 'me' })   // so resolveName('小A') works
  const facts = makeFactsApi(s)
  const b = facts.nextBatch('wxid_a', 40) as any
  facts.record(b.batch_id, [{ kind: 'entity', predicate: 'is', value: 'friend', source_msg_keys: [] }], 1)
  const brief = makePersonApi(s).personBrief('小A', 12) as any
  expect(brief.resolved).toBe(true)
  expect(brief.wxid).toBe('wxid_a')
  expect(brief.recent_messages.map((m: any) => m.text)).toEqual(['yo', 'hi'])  // newest-first
  expect(brief.facts.by_kind.entity.length).toBe(1)
  s.close()
})

test('unresolved name returns resolved:false + candidates; empty sources degrade, no crash', () => {
  const s = openKnowledge(mkdtempSync(join(tmpdir(), 'kk-person2-')))
  const brief = makePersonApi(s).personBrief('不存在的人', 12) as any
  expect(brief.resolved).toBe(false)
  expect(Array.isArray(brief.candidates)).toBe(true)
  s.close()
})
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `person.ts` (port of `brief.py`; each field `_safe`-degrades):

```ts
import type { KnowledgeStore } from './store'
import { resolveName } from './graph'
import { makeGraphQueryApi } from './graph-query'
import { makeFactsApi } from './facts'

const safe = <T>(fn: () => T, dflt: T): T => { try { return fn() } catch { return dflt } }

export interface PersonApi { personBrief(name: string, recentN: number): object }

export function makePersonApi(store: KnowledgeStore): PersonApi {
  const graph = makeGraphQueryApi(store)
  const facts = makeFactsApi(store)
  return {
    personBrief(name, recentN) {
      const { username: un, candidates } = resolveName(store.allContacts(), name)
      if (!un) return { name, resolved: false, candidates }
      const relationship = safe(() => graph.contactProfile(name), null)
      const factsView = safe(() => facts.contactFacts(name), null)
      const obligations = safe(() => {
        const all = (facts.findFacts('obligation', null, null, 'active', 100) as any).results ?? []
        return all.filter((r: any) => r.contact === un || r.related_contact === un || r.related_contact === name)
      }, [])
      const recent_messages = safe(() => store.recentMessages(un, recentN), [])
      return { name, resolved: true, wxid: un, relationship, facts: factsView, obligations, recent_messages }
    },
  }
}
```

- [ ] **Step 4: Run, verify pass + tsc clean.**
- [ ] **Step 5: Commit** `feat(knowledge): person brief composite — makePersonApi (FP T3)`.

---

## Task 4: Query/Ingest routes + deps type + admin tiers

**Files:**
- Modify: `src/daemon/internal-api/types.ts:251-267` (add `facts?`/`person?` to `deps.knowledge`)
- Modify: `src/daemon/internal-api/routes-knowledge.ts` (add facts 6 routes + person route to `knowledgeRoutes`)
- Modify: `src/daemon/internal-api/route-tiers.ts:184-192` (add the new routes as `'admin'` in `ROUTE_MIN_TIER`)
- Test: `src/daemon/internal-api/routes-knowledge.test.ts`

**Interfaces:**
- Consumes: `FactsApi` (T2), `PersonApi` (T3).
- Produces: routes `POST /v1/knowledge/facts/extraction_batch|record_facts|contact_facts|find_facts|set_fact_status`, `GET /v1/knowledge/facts/extraction_status`, `POST /v1/knowledge/person/brief`. `deps.knowledge.facts?: FactsApi`, `deps.knowledge.person?: PersonApi`.

- [ ] **Step 1:** In `types.ts:251-267`, add inside the `knowledge?: { … }`:
```ts
  facts?: import('../../core/knowledge/facts').FactsApi
  person?: import('../../core/knowledge/person').PersonApi
```

- [ ] **Step 2: Write failing route tests** in `routes-knowledge.test.ts` (mirror the graph route tests):
```ts
test('facts + person routes 503 when unwired, 200 when wired', () => {
  const table = knowledgeRoutes({} as any)                        // no knowledge
  expect((table['POST /v1/knowledge/facts/contact_facts'] as any)(null, { name: 'x' }).status).toBe(503)
  expect((table['POST /v1/knowledge/person/brief'] as any)(null, { name: 'x' }).status).toBe(503)
  const facts = { contactFacts: () => ({ ok: 1 }), extractionStatus: () => ({ contacts: 0 }) }
  const person = { personBrief: () => ({ resolved: false }) }
  const wired = knowledgeRoutes({ knowledge: { facts, person } } as any)
  expect((wired['POST /v1/knowledge/facts/contact_facts'] as any)(null, { name: 'x' }).status).toBe(200)
  expect((wired['GET /v1/knowledge/facts/extraction_status'] as any)().status).toBe(200)
  expect((wired['POST /v1/knowledge/person/brief'] as any)(null, { name: 'x' }).status).toBe(200)
  expect((wired['POST /v1/knowledge/facts/contact_facts'] as any)(null, {}).status).toBe(400)  // missing name
})
```

- [ ] **Step 3: Implement routes** in `routes-knowledge.ts` (add to the returned table; mirror the graph handler template at `:132-175`):
```ts
'POST /v1/knowledge/facts/extraction_batch': (_q, body) => {
  if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
  const b = (body ?? {}) as { contact?: string; limit?: number }
  return { status: 200, body: deps.knowledge.facts.nextBatch(b.contact ?? null, b.limit ?? 40) }
},
'POST /v1/knowledge/facts/record_facts': (_q, body) => {
  if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
  const b = (body ?? {}) as { batch_id?: unknown; facts?: unknown; now?: number }
  if (typeof b.batch_id !== 'string' || !b.batch_id) return { status: 400, body: { error: 'invalid_batch_id' } }
  return { status: 200, body: deps.knowledge.facts.record(b.batch_id, (b.facts as any[]) ?? [], b.now ?? Math.floor(Date.now() / 1000)) }
},
'POST /v1/knowledge/facts/contact_facts': (_q, body) => {
  if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
  const b = (body ?? {}) as { name?: unknown }
  if (typeof b.name !== 'string' || !b.name) return { status: 400, body: { error: 'invalid_name' } }
  return { status: 200, body: deps.knowledge.facts.contactFacts(b.name) }
},
'POST /v1/knowledge/facts/find_facts': (_q, body) => {
  if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
  const b = (body ?? {}) as any
  return { status: 200, body: deps.knowledge.facts.findFacts(b.kind ?? null, b.predicate ?? null, b.query ?? null, b.status ?? 'active', b.limit ?? 50) }
},
'POST /v1/knowledge/facts/set_fact_status': (_q, body) => {
  if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
  const b = (body ?? {}) as { id?: unknown; status?: unknown; now?: number }
  if (typeof b.id !== 'number' || typeof b.status !== 'string' || !b.status) return { status: 400, body: { error: 'invalid_args' } }
  return { status: 200, body: deps.knowledge.facts.setFactStatus(b.id, b.status, b.now ?? Math.floor(Date.now() / 1000)) }
},
'GET /v1/knowledge/facts/extraction_status': () => {
  if (!deps.knowledge?.facts) return { status: 503, body: { error: 'knowledge_not_wired' } }
  return { status: 200, body: deps.knowledge.facts.extractionStatus() }
},
'POST /v1/knowledge/person/brief': (_q, body) => {
  if (!deps.knowledge?.person) return { status: 503, body: { error: 'knowledge_not_wired' } }
  const b = (body ?? {}) as { name?: unknown; recent_n?: number }
  if (typeof b.name !== 'string' || !b.name) return { status: 400, body: { error: 'invalid_name' } }
  return { status: 200, body: deps.knowledge.person.personBrief(b.name, b.recent_n ?? 12) }
},
```

- [ ] **Step 4:** In `route-tiers.ts` `ROUTE_MIN_TIER` (near `:184-192`), add:
```ts
'POST /v1/knowledge/facts/extraction_batch': 'admin',
'POST /v1/knowledge/facts/record_facts': 'admin',
'POST /v1/knowledge/facts/contact_facts': 'admin',
'POST /v1/knowledge/facts/find_facts': 'admin',
'POST /v1/knowledge/facts/set_fact_status': 'admin',
'GET /v1/knowledge/facts/extraction_status': 'admin',
'POST /v1/knowledge/person/brief': 'admin',
```

- [ ] **Step 5: Run tests + tsc, verify pass/clean.** `bun test src/daemon/internal-api/routes-knowledge.test.ts` + `bunx tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(knowledge): facts + person Query/Ingest routes + admin tiers (FP T4)`.

---

## Task 5: Agent tools + tier + prompt + bootstrap wiring (make it live)

**Files:**
- Create: `src/mcp-servers/wechat/tools-facts.ts`, `src/mcp-servers/wechat/tools-person.ts`
- Modify: `src/mcp-servers/wechat/main.ts` (imports near `:33`; register in the `if (SESSION_IS_ADMIN)` block `:106-124`)
- Modify: `src/core/user-tier.ts` (`ToolKind` `:40-41`; `ALL_KINDS` `:43-49`; `ADMIN_ONLY` `:94`; `classifyToolUse` `:243-247`)
- Modify: `src/core/claude-agent-provider.ts:30-52` (`TOOL_KIND_TO_CLAUDE_BUILTINS` — add `facts_query`/`person_query` — REQUIRED for tsc)
- Modify: `src/core/prompt-builder.ts` (`:40` drop wxfacts/wxperson from `KNOWN_KNOWLEDGE_PLUGINS`; `:202-211` compute `factsAvailable`/`personAvailable`; `:559`+ add to `opts` + switch the wxfacts/wxperson bullets at `:573-575`/`:594-596` to `opts?.factsAvailable`/`opts?.personAvailable`; add the flags to the args interface `:161-183`)
- Modify: `src/daemon/bootstrap/index.ts` (imports `:73-80`; `knowledge` literal `:505-514` add `facts`/`person`; prompt-arg flags near `:715`/`:721`)
- Tests: `src/core/user-tier.test.ts`, `src/core/prompt-builder.test.ts`

**Interfaces:**
- Consumes: `FactsApi`/`PersonApi` routes (T4), `makeFactsApi`/`makePersonApi` (T2/T3).
- Produces: MCP tools `extraction_batch`, `record_facts`, `contact_facts`, `find_facts`, `set_fact_status`, `extraction_status`, `person_brief`; ToolKinds `facts_query`, `person_query`.

- [ ] **Step 1: Create `tools-facts.ts`** (mirror `tools-graph.ts` structure — `z`, `passthroughErrorResult`, one `registerFactsTools(server, client)`). Port the 6 tool titles/descriptions from `wxfacts/server.py`'s `TOOLS` (keep the Chinese descriptions). Each calls `client.request(...)` against the T4 routes. Example (the rest follow identically):
```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerFactsTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool('extraction_batch', {
    title: 'Next un-extracted 1:1 message batch',
    description: '取下一批未抽取的 1:1 消息(不给 contact 则选积压最多的联系人)。你据此抽取实体/关系/义务,再调 record_facts 回写。仅管理员可用。',
    inputSchema: { contact: z.string().optional(), limit: z.number().int().optional() },
  }, async ({ contact, limit }) => {
    try {
      const resp = await client.request('POST', '/v1/knowledge/facts/extraction_batch', { contact, limit })
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) { return passthroughErrorResult(err, 'extraction_batch') }
  })
  server.registerTool('record_facts', {
    title: 'Record extracted facts + advance the batch',
    description: '回写你抽取到的结构化断言并推进该批水位(facts 可空,只推进)。fact:{kind,predicate,value,related_contact?,time_ref?,confidence?,source_msg_keys?}。confidence=low|med|high;kind 建议 entity|relation|obligation|attribute|event。仅管理员可用。',
    inputSchema: { batch_id: z.string(), facts: z.array(z.any()).optional() },
  }, async ({ batch_id, facts }) => {
    try {
      const resp = await client.request('POST', '/v1/knowledge/facts/record_facts', { batch_id, facts: facts ?? [] })
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) { return passthroughErrorResult(err, 'record_facts') }
  })
  // contact_facts {name} → POST .../contact_facts
  // find_facts {kind?,predicate?,query?,status?,limit?} → POST .../find_facts
  // set_fact_status {id,status} → POST .../set_fact_status
  // extraction_status {} → GET .../extraction_status
}
```
(Write out all 6 fully — repeat the try/catch shape; no placeholders.)

- [ ] **Step 2: Create `tools-person.ts`** — one tool `person_brief` (title/description ported from `wxperson/server.py`), `inputSchema: { name: z.string(), recent_n: z.number().int().optional() }`, `POST /v1/knowledge/person/brief`. Export `registerPersonTools(server, client)`.

- [ ] **Step 3: Register in `main.ts`.** Add imports near `:33`:
```ts
import { registerFactsTools } from './tools-facts'
import { registerPersonTools } from './tools-person'
```
Inside `if (SESSION_IS_ADMIN)` (`:106-124`), after `registerGraphTools(server, client)`:
```ts
registerFactsTools(server, client)
registerPersonTools(server, client)
```

- [ ] **Step 4: user-tier.ts.** Add `| 'facts_query' | 'person_query'` to the `ToolKind` union (`:41`); add both to `ALL_KINDS` (`:48`); add both to the `ADMIN_ONLY` set (`:94`); in `classifyToolUse` (`:243-247`) add:
```ts
if (sub === 'extraction_batch' || sub === 'record_facts' || sub === 'contact_facts'
  || sub === 'find_facts' || sub === 'set_fact_status' || sub === 'extraction_status') return 'facts_query'
if (sub === 'person_brief') return 'person_query'
```

- [ ] **Step 5: claude-agent-provider.ts.** In `TOOL_KIND_TO_CLAUDE_BUILTINS` (`:30-52`) add (exhaustive `Record<ToolKind>` — required):
```ts
facts_query: [],   // MCP-only (mcp__wechat__extraction_batch / …), admin-only, gated by canUseTool
person_query: [],  // MCP-only (mcp__wechat__person_brief), admin-only, gated by canUseTool
```

- [ ] **Step 6: prompt-builder.ts.** (a) `:40` change `KNOWN_KNOWLEDGE_PLUGINS` to `['wxsearch', 'wxmedia'] as const` (drop the now-daemon-owned `wxperson`,`wxfacts`; wxgraph already gone). (b) Add `factsAvailable?: boolean`/`personAvailable?: boolean` to the args interface (`:161-183`, beside `graphAvailable`). (c) In `buildSystemPrompt` (`:202-211`) compute `const factsAvailable = args.factsAvailable === true` / `const personAvailable = args.personAvailable === true`, and add them to `hasKnownKnowledge`'s `||` chain + the `knowledgeOrchestrationSection(..., { knowledgeSearchAvailable, graphAvailable, factsAvailable, personAvailable })` call (`:229`). (d) In `knowledgeOrchestrationSection` (`:559`) extend `opts` with the two flags and switch the existing wxfacts bullet (`:573-575`) to `if (opts?.factsAvailable)` and the wxperson bullet (`:594-596`) to `if (opts?.personAvailable)` (keep the bullet copy).

- [ ] **Step 7: bootstrap/index.ts.** Add imports (`:73-80`): `import { makeFactsApi } from '../../core/knowledge/facts'` and `makePersonApi` from `person`. In the `knowledge` literal (`:505-514`), after `graph: makeGraphQueryApi(knowledgeStore),` add:
```ts
facts: makeFactsApi(knowledgeStore),
person: makePersonApi(knowledgeStore),
```
Near the prompt-arg flags (`:715`/`:721`), add:
```ts
factsAvailable: !!knowledge?.facts && tierProfile.allow.has('facts_query'),
personAvailable: !!knowledge?.person && tierProfile.allow.has('person_query'),
```

- [ ] **Step 8: Write/extend tests.** In `user-tier.test.ts`: assert `classifyToolUse` maps the 6 facts tool names → `'facts_query'` and `person_brief` → `'person_query'`, and both kinds are in `ADMIN_ONLY` (non-admin tier denied). In `prompt-builder.test.ts`: assert the facts/person bullets render iff `factsAvailable`/`personAvailable` (not on plugin presence).

- [ ] **Step 9: Run all touched tests + tsc.** `bun test src/core/user-tier.test.ts src/core/prompt-builder.test.ts src/daemon/internal-api/routes-knowledge.test.ts` + `bunx tsc --noEmit` clean (the `Record<ToolKind>` exhaustiveness is the compile gate).
- [ ] **Step 10: Commit** `feat(knowledge): facts + person agent tools + tier + prompt + wiring (FP T5)`.

---

## Task 6: Retire wxfacts + wxperson plugins (plugins repo)

**Files (wechat-cc-plugins, separate repo/branch):**
- Modify: `packages/wxfacts/wxfacts/server.py` (`TOOLS = []`), its manifest (`tools: []`)
- Modify: `packages/wxperson/wxperson/server.py` (`TOOLS = []`), its manifest (`tools: []`)

Mirror the wxgraph/wxsearch retirement: empty the MCP tool lists + manifest `tools` so neither plugin advertises tools (the daemon owns facts/person now). Nothing imports wxfacts/wxperson (leaf consumers), so no interim coupling remains. Leave the library modules in place (harmless) or delete — minimal change is emptying TOOLS + manifest.

- [ ] **Step 1:** Set `TOOLS = []` in both `server.py` files; set `tools: []` in both manifests.
- [ ] **Step 2:** Run each package's test suite with its venv python (`packages/wxfacts/.venv/bin/python -m pytest packages/wxfacts` etc.) — confirm no suite references the removed tools / still passes (or is trivially green). If a test asserts tool presence, update it to assert retirement.
- [ ] **Step 3: Commit (plugins repo)** `feat(wxfacts,wxperson): retire in favor of the daemon in-proc facts/person (FP T6)`.

---

## Task 7: VERIFY-AGAINST-REAL (owner machine)

**File:** `scratchpad/facts-person-verify.ts` (a harness like `graph-verify.ts`).

On real source (`/Users/nategu_mac_company/Documents/wxvault/out/decrypted`):
- `runSourceAdapter` → ingest; `rebuildGraphFromSource` (so name-resolve + display work).
- `makeFactsApi(store)`: `extraction_batch(null, 20)` returns real 1:1 candidates for the max-backlog contact; `record_facts` a hand-written fact; `contact_facts` + `extraction_status` return it; watermark advanced.
- `makePersonApi(store)`: `person_brief(<a real display name>)` assembles the real graph relationship + the recorded fact + real recent messages — entirely off `..`.
- Print the assembled brief; sanity-check it's coherent (resolved wxid correct, recent messages are that conversation's newest, relationship closeness present).

- [ ] **Step 1:** Write + run the harness (`bun scratchpad/facts-person-verify.ts`). Acceptance gate: real extraction_batch → record → person_brief round-trips on real data, off `..`.

---

## Task 8: Re-point companion-ingest's auto-extraction at the in-proc FactsApi

**Why (found in the final whole-branch review):** the daemon already has an automatic fact-extraction loop — `src/daemon/companion/ingest/extract.ts` (`runExtraction`) — that pulls `extraction_batch`, runs `cheapEval` to extract facts, and calls `record_facts`, all via the MCP bridge routed to the **wxfacts plugin**. Task 6 empties that plugin's tools, so after both branches ship the bridge finds no owner for `extraction_batch` and the loop silently stops. This task moves that one existing consumer off the plugin and onto the in-process `FactsApi` — completing the migration (no MCP subprocess, no `..`). Choice A ("agent-driven") governs the *kernel* (no kernel cycle auto-populates facts); companion-ingest is a *separate, pre-existing* daemon loop and must keep working.

**Files:**
- Create: `src/daemon/companion/ingest/facts-inproc.ts` + test — a tiny adapter `makeInProcFactsCall(facts: FactsApi): (tool: string, input?: unknown) => Promise<string>` that serves ONLY `extraction_batch`/`record_facts` by delegating to the in-proc FactsApi and `JSON.stringify`-ing the result (so `extract.ts`'s existing `call → JSON string` contract is unchanged).
- Modify: `src/daemon/companion/ingest/cycle.ts` — `CycleDeps` gains `factsApi?: import('../../../core/knowledge/facts').FactsApi`. In the extraction block (`cycle.ts:107-113`): when `d.factsApi` is present, build `runExtraction`'s `call` from `makeInProcFactsCall(d.factsApi)` and run extraction unconditionally (facts always "has" the tool); when absent, keep the existing `d.hasTool('extraction_batch')` gate + `d.bridge.call` (graceful fallback). The other cycle tasks (overview/rebuild/index_update/voice_backfill) stay on `d.bridge`/`d.hasTool` untouched.
- Modify: `src/daemon/wiring/tick-bodies.ts` (`ingestTick`, ~`:170-232`) — read `const factsApi = deps.boot.knowledge?.facts`. (a) Change the empty-specs early-return (`:176`) to `if (Object.keys(specs).length === 0 && !factsApi) return` (still run extraction when facts exists even if no MCP plugins remain). (b) Pass `factsApi` into `runIngestCycle({ …, factsApi })`. Preserve the existing `cheapEval` gate (extraction still only runs when `getCheapEval()` returns a provider — orthogonal, keep as-is).
- Tests: `facts-inproc.test.ts` (the adapter maps the two tools + stringifies + rejects unknown tools); extend `cycle.test.ts` (with a fake `factsApi`, extraction runs via it — `nextBatch`/`record` called, NOT `bridge.call`; without `factsApi`, the old bridge path still gates on `hasTool`).

**Interfaces:**
- Consumes: `FactsApi` (`src/core/knowledge/facts.ts:26` — `nextBatch(contact|null, limit) → object`, `record(batchId, facts, now) → object`), `ExtractDeps` (`extract.ts:115`, `call: (tool, input?) => Promise<string>`), `Bootstrap.knowledge?.facts` (in scope at `tick-bodies.ts` via `deps.boot`).
- Adapter mapping: `extraction_batch` `{contact?, limit?}` → `JSON.stringify(facts.nextBatch(input.contact ?? null, input.limit ?? 40))`; `record_facts` `{batch_id, facts}` → `JSON.stringify(facts.record(input.batch_id, input.facts ?? [], nowSec))` where `nowSec` is injected (default `Math.floor(Date.now()/1000)` — but inject it for testability, no bare `Date.now()` in the pure adapter). Any other tool name → `Promise.reject(new Error('in-proc facts serves only extraction_batch/record_facts, got ' + tool))`.

- [ ] **Step 1: Failing adapter test** `facts-inproc.test.ts`: a fake `FactsApi` whose `nextBatch`/`record` return sentinel objects; assert `makeInProcFactsCall(fake)('extraction_batch', {limit:5})` resolves to the JSON string of `nextBatch(null,5)`'s return, `('record_facts', {batch_id:'b', facts:[…]})` calls `record('b', […], <injected now>)` and returns its JSON, and an unknown tool rejects. Run → FAIL.
- [ ] **Step 2: Implement `facts-inproc.ts`.** `export function makeInProcFactsCall(facts, nowFn = () => Math.floor(Date.now()/1000)) { return async (tool, input) => { const b = (input ?? {}) as any; if (tool === 'extraction_batch') return JSON.stringify(facts.nextBatch(b.contact ?? null, b.limit ?? 40)); if (tool === 'record_facts') return JSON.stringify(facts.record(b.batch_id, b.facts ?? [], nowFn())); throw new Error('in-proc facts serves only extraction_batch/record_facts, got ' + tool) } }`. Run test → PASS. `bunx tsc --noEmit` clean.
- [ ] **Step 3: Failing cycle test** in `cycle.test.ts`: with `factsApi` = a fake `{nextBatch: vi.fn(()=>({done:true})), record: vi.fn()}` and a `bridge.call` spy, assert `runIngestCycle` runs extraction through the facts path (bridge.call NOT called for `extraction_batch`), even when `hasTool('extraction_batch')` is false. And a second case: no `factsApi`, `hasTool('extraction_batch')` true → old `bridge.call` path used. Run → FAIL.
- [ ] **Step 4: Implement `cycle.ts` change** (the extraction block only): `if (d.factsApi) { const { batches, recorded } = await runExtraction({ call: makeInProcFactsCall(d.factsApi), cheapEval: d.cheapEval, cap: d.cap, log: d.log }); report.batches = batches; report.recorded = recorded } else if (d.hasTool('extraction_batch')) { /* existing bridge path unchanged */ }`. Run cycle test → PASS.
- [ ] **Step 5: Wire `tick-bodies.ts`** — `const factsApi = deps.boot.knowledge?.facts`; guard `if (Object.keys(specs).length === 0 && !factsApi) return`; add `factsApi` to the `runIngestCycle({…})` call. `bunx tsc --noEmit` clean; run the ingest-related suites (`bun --bun vitest run src/daemon/companion/ingest/cycle.test.ts src/daemon/companion/ingest/facts-inproc.test.ts`).
- [ ] **Step 6: Commit** `feat(knowledge): re-point companion-ingest auto-extraction at in-proc FactsApi (FP T8)` (stage only the 4 files; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`).

**Note:** `extract.ts` itself is UNCHANGED — its `call → JSON string` contract is preserved by the adapter. This keeps its reviewed cheapEval/parseFacts logic intact and the diff minimal.

## Self-review
- Coverage: facts.db store + merge/watermark port (T1), feed+record+query orchestration (T2), person composite (T3), routes+tiers+deps (T4), tools+tier+prompt+wiring (T5), retire plugins (T6), real verify (T7). Unblocks agent-social Phase 2 (person_brief for judge).
- Risk: T1 merge fidelity (tests pin confidence-max/ordered-union/status-untouched/monotonic-tuple, not just execution); T2 cursor tiebreak (test pins same-second local_id not skipped); T5 `Record<ToolKind>` exhaustiveness (tsc is the gate).
- No cycle wiring by design (choice A, agent-driven) — empty facts.db + graph-only person_brief is expected graceful degradation, not a bug.
