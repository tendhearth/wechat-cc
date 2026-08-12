# Knowledge Kernel — facts + person layers in-process (Relay 2) — Design

**Date**: 2026-08-12
**Status**: Design approved (brainstorm 2026-08-12); writing-plans next.
**Builds on**: the Knowledge Kernel (Phase 0/1 merged dev `dd6efd58`; agent-search dev `ead34923`; graph in-process dev `f31270d2`). North star: `docs/design/2026-07-12-knowledge-kernel-architecture.md` (Relay 2 = collapse the pure-SQL understanding trio graph/facts/person into in-process TS). Graph already landed; this slice does the remaining two.

## Goal

Migrate the **facts** (agent-driven structured-fact extraction) and **person**
(unified per-contact brief) layers off their `..`-reading + sibling-importing
Python plugins into **in-process TS** kernel modules (Relay 2). facts reads the
kernel `source` in-process for its candidate feed, stores claims + per-contact
extraction watermarks in a `facts.db`, and exposes an Ingest face (agent writes
facts) + Query face (fact queries + candidate feed). person is a pure Query-face
composite over graph + facts + source — no storage of its own. Retires the
`wxfacts` and `wxperson` plugins, eliminating the last `..` reads and the
sibling-import coupling (`wxfacts`→`wxgraph`, `wxperson`→`wxgraph`+`wxfacts`+
`wxsearch`) in the understanding trio.

Chosen (like graph) over Relay 1 (keep-Python-re-plumb): facts + person are
**pure SQL, no ML** — wrapping them as dumb subprocesses (the Option-C pattern,
needed only for fastembed) would be contortion; in-process TS is the right shape
and removes two subprocesses + all remaining sibling coupling.

## The one design fork (resolved): who drives extraction

facts differs from graph/semantic: those are **deterministic builders** the
daemon runs on the knowledge cycle. facts needs an **LLM to extract** (read a
batch of messages → pull entities/relations/obligations → write them back). The
kernel can only provide the substrate: a **candidate feed** (source backlog per
contact) + **storage** + **queries**. The extraction step needs an agent.

**Resolved: A — keep extraction agent-driven** (owner's agent calls
`extraction_batch` → extracts itself → `record_facts`). The kernel is substrate;
the LLM extraction is the agent's job. This is faithful to the current design and
the north star ("facts = agent-driven extraction loop"), has zero standing token
cost, and is provider-independent. (Rejected B — daemon auto-extraction on the
cycle via a cheap model — because it bakes an LLM into the daemon cycle: standing
token cost, a hard dependency on some model being available, and extraction
quality no longer under the owner's supervision.)

**Consequence:** facts needs **no cycle wiring** (unlike graph's rebuild). The
feed reads live `source`; storage is written on-demand by the agent via tools.
Simpler than graph.

## Scope

**In:**

1. **`facts.db` store** — a `facts` claim table + `extraction_state` watermark
   table, faithful port of `wxfacts/store.py`:
   - `facts(id, contact, kind, predicate, value, related_contact, time_ref,
     confidence, source_msg_keys JSON, status, created_at, updated_at,
     UNIQUE(contact, predicate, value))`.
   - `extraction_state(contact PRIMARY KEY, last_ts, last_local_id, updated_at)`.
   - `upsertFact` (insert, or **merge** on the UNIQUE key: ordered union of
     `source_msg_keys`, `confidence` = max by `{low:0,med:1,high:2}`,
     `related_contact`/`time_ref` fill-if-absent, `status` untouched on merge),
     `getWatermark`/`advanceWatermark` (monotonic on the `(ts, local_id)`
     tuple)/`allWatermarks`, `factsFor(contact, status)`, `find(kind, predicate,
     query, status, limit)` (substring on predicate/value), `setStatus`,
     `countsByKind`.

2. **`facts.ts` orchestration** — port of `wxfacts/facts.py`:
   - `nextBatch({ contact?, limit })` — reads the kernel **source** 1:1 text
     backlog (`is_group=0` ∧ `kind='text'`) grouped by conversation, ordered by
     the `(ts, tiebreak)` cursor; picks the max-backlog contact when none given;
     returns `batch_id` (encodes contact + covers-until cursor) + candidate
     messages with display names resolved via the kernel **graph**.
   - `record({ batch_id, facts, now })` — `upsertFact` each + `advanceWatermark`.
   - `contactFacts(name)`, `findFacts(...)`, `setFactStatus(...)`,
     `extractionStatus()`. Contact-name resolution + display via the kernel graph
     (`resolveName`, display map) — replacing `wxfacts`'s `wxgraph` imports.

3. **`person.ts` — pure Query composite** — port of `wxperson/brief.py`:
   - `personBrief({ name, recent_n })` — `graph.resolveName(name)` → `un` or
     candidates; then assemble `relationship` = `graph.contactProfile`, `facts` =
     `facts.contactFacts(un)`, `obligations` = `facts.findFacts('obligation', …)`
     filtered to `un`/name, `recent_messages` = **kernel source** newest-first
     messages in `un`'s conversation (replaces the removed `wxsearch/index.sqlite`
     read). **No storage.** Each source degrades gracefully to empty, never a
     crash (preserve `brief.py`'s `_safe` behavior).

4. **Query/Ingest faces** (`routes-knowledge.ts`, admin) — facts: `record_facts`
   (Ingest), `extraction_batch` / `contact_facts` / `find_facts` /
   `set_fact_status` / `extraction_status` (Query); person: `person_brief`
   (Query). All admin-tier, fail-closed (mirror the search/graph routes).

5. **Agent tools** — `src/mcp-servers/wechat/tools-facts.ts` (the 6 fact tools)
   + `tools-person.ts` (`person_brief`), admin-gated (double-gated like
   `knowledge_search`/graph tools: user-tier ADMIN_ONLY + `SESSION_IS_ADMIN`
   registration). Prompt bullets gated on availability
   (`!!knowledge?.facts` / `!!knowledge?.person` ∧ tier allows).

6. **Retire `wxfacts` + `wxperson`** (plugins repo) — empty `TOOLS` + manifest
   `tools:[]` (like the wxgraph/wxsearch retirement); drop both from the host's
   `KNOWN_KNOWLEDGE_PLUGINS`. Nothing imports them (they were leaf consumers), so
   no interim coupling remains — the trio's `..`/sibling-import mess is fully gone
   after this slice.

**Out (later / not this slice):**
- agent-social Phase 2 (wire judge → `person_brief`, discover → `rank_contacts`)
  — separate follow-on; `person_brief` (this slice) is its prerequisite.
- Group-chat fact extraction (v1 is 1:1 only, faithful to `wxfacts`).
- Any change to the extraction *prompting*/agent loop itself (kernel is substrate
  only).

## Architecture

### facts store + orchestration (in-process TS)
`facts.db` opened alongside `source.db`/`semantic.db`/`graph.db` in the knowledge
root (its own file, consistent with the graph slice). `facts.ts` reads `source`
via the existing store (`listMessages` / a 1:1-text backlog query) — no `..`, no
subprocess. Contact resolution + display names come from the in-process graph
(the graph slice already exposes `resolveName` + a display map). No knowledge
cycle changes: facts is populated on-demand by the agent through the tools;
`nextBatch` computes the backlog live from `source` + `extraction_state`.

### Candidate-feed cursor (the one implementation detail for the plan)
`wxfacts` orders each conversation by `(ts, local_id)` and carries a
`(covers_ts, covers_local_id)` watermark, because WeChat `create_time` is only
second-granular so `ts` alone can't order a same-second burst. The kernel
`source.db.messages` has `time` but the tiebreak key must be settled in the plan:
reuse the source row's stable ordering (`rowid` or the existing `msg_key`
ordering) **or** add a `local_id` column to source during this slice. Requirement:
a **total order** per conversation + a monotonic watermark tuple so a late
same-second message is never skipped. **Provenance is self-consistent** — the
`msg_key`s in `facts.source_msg_keys` are exactly the ones the kernel source
emits through `extraction_batch` and the agent hands back via `record_facts`; no
cross-system key matching is needed.

### person composite (pure Query, in-process)
`person.ts` is stateless: it fans out to the in-process graph + facts stores +
`source` recent-messages query and assembles one dict, degrading each field to
empty on absence. It reads, never writes.

### Faces + tools + prompt
Mirror the graph slice exactly: admin-only Query/Ingest routes, admin
double-gated MCP tools, prompt bullets gated on availability. `deps.knowledge`
gains `facts` + `person`.

## Data model (facts.db)
```sql
CREATE TABLE facts (
  id INTEGER PRIMARY KEY, contact TEXT, kind TEXT, predicate TEXT, value TEXT,
  related_contact TEXT, time_ref TEXT, confidence TEXT, source_msg_keys TEXT,  -- JSON array
  status TEXT, created_at INTEGER, updated_at INTEGER,
  UNIQUE(contact, predicate, value));
CREATE TABLE extraction_state (
  contact TEXT PRIMARY KEY, last_ts INTEGER, last_local_id INTEGER DEFAULT 0,
  updated_at INTEGER);
```
(Port `wxfacts/store.py` verbatim; `source_msg_keys` = JSON array of source
msg_keys = the provenance link into `source.db`.)

## Verification

- **facts store (unit):** upsert inserts; re-upsert on the same
  `(contact,predicate,value)` **merges** (ordered-union msg_keys, confidence
  max, related/time_ref fill, status untouched); watermark round-trip +
  monotonic-tuple advance; `find` substring + kind/predicate/status filters;
  `setStatus`; `countsByKind`. Pin the merge semantics — not just "runs".
- **facts feed (unit):** fixture source with two 1:1 conversations + a group +
  non-text kinds → `nextBatch` returns only 1:1 text, picks the larger backlog
  when no contact given, respects the cursor (advancing the watermark shrinks the
  backlog; a same-second late message is still fed), and skips groups/non-text.
- **person (unit):** `personBrief` assembles graph + facts + recent from a
  fixture; unresolved name → `resolved:false` + candidates; each sibling empty →
  empty field, never a crash (graceful degrade).
- **Query/tools (unit):** routes return the data + are admin-only; tools
  double-gated (mirror `knowledge_search` gating tests).
- **VERIFY-AGAINST-REAL (owner machine):** on real `source` — `extraction_batch`
  returns real 1:1 candidates for a real contact; `record_facts` writes a claim;
  `contact_facts` + `person_brief` return it assembled with the real graph
  relationship + real recent messages, entirely off `..`.

## Non-goals / risks
- Faithful port of `store.py`'s merge/watermark semantics — the tests pin the
  numeric/set behavior (confidence max, ordered union, monotonic tuple), not just
  execution.
- The candidate-feed tiebreak key must give a true total order (plan decides
  rowid vs a `local_id` column) — a wrong tiebreak silently skips or re-feeds
  same-second messages.
- facts is agent-driven (choice A): with no agent running the loop, `facts.db`
  stays empty and `person_brief` shows only graph + recent (facts empty) — that
  is expected graceful degradation, not a bug.
