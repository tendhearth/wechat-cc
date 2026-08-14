# Knowledge Kernel — graph layer in-process (Relay 2) — Design

**Date**: 2026-08-12
**Status**: Design approved (brainstorm 2026-08-12); writing-plans next.
**Builds on**: the Knowledge Kernel (Phase 0/1 merged: dev `dd6efd58`; agent-search dev `ead34923`). North star: `docs/design/2026-07-12-knowledge-kernel-architecture.md` (Relay 2 = collapse the pure-SQL understanding trio graph/facts/person into in-process TS).

## Goal

Migrate the **graph** layer off its `..`-reading Python plugin into an
**in-process TS** kernel module (Relay 2): it reads `source` in-process (no
`..`, no cross-process auth), computes per-contact profiles + closeness + mention
edges, writes a `graph` layer, and exposes graph queries on the Query face +
admin agent tools. Retires the `wxgraph` plugin. Unblocks agent-social `discover`
(`rank_contacts`) and gives the agent relationship queries directly.

Chosen over Relay 1 (keep-Python-re-plumb) because graph is **pure SQL, no ML** —
wrapping it as a dumb subprocess (the Phase-0/1 Option-C pattern, needed only for
fastembed) would be contortion; in-process TS is the right shape and removes a
subprocess + the sibling-import coupling entirely.

## Prerequisite realization: the `source` layer must get richer

Phase 0/1's source adapter ingested **text messages only** (type=1, decoded) —
enough for wxsearch. Graph's closeness needs the **full** message stream +
metadata: all message types, `local_type`, `is_group`, `sender_un` vs owner,
transfer/redpacket/voice/call classification, and @mention / refermsg references
for edges. So this slice **enriches the source layer first** — a foundation that
facts + person will also consume.

## Scope

**In:**
1. **Enrich `source`** — extend `source.db.messages` + the adapter to ingest ALL
   messages (not just text) with the fields the understanding layers need:
   `local_type` (raw), `is_group` (bool), a normalized `kind` (text/voice/call/
   image/transfer/redpacket/…, ported from wxgraph `source.classify_type`),
   `sender_un`, and mention refs (@atuserlist / refermsg target) parsed out.
   Keep the existing text/decode/prefix-strip. Backfill re-ingests (idempotent on
   msg_key; the cursor handles incrementality). wxsearch is unaffected (it filters
   to text kind).
2. **`src/core/knowledge/graph.ts`** — in-process TS port of wxgraph's
   `profile.py` (build_profiles: sent/recv, initiations >6h gap, active_days,
   transfer/voice/call intimacy, shared_groups, recency TAU=90d decay, P95
   normalization, weighted closeness `{recency .35, volume .30, intimacy .20,
   reciprocity .15}`), `edges.py` (mention edges; displayname collision → drop),
   and `graph.py` (owner detection from 1:1 chats + `WXGRAPH_OWNER`/config
   override, resolve_name: username-exact wins, collision → candidates,
   contact_profile, top_contacts, rank_contacts, relationship_subgraph,
   connectors). **Port faithfully** — these algorithms were reviewed in the
   plugin suite; preserve weights, P95, `now` injection, collision handling.
3. **`graph` store** — a `graph.db` (or a `graph` namespace in the knowledge
   root) with `contacts` (profile rows), `edges` (a,b,kind,weight), `meta`
   (owner, built_at, source watermark). Written by the in-proc builder from
   `source`; rebuilt incrementally on the knowledge cycle (after the adapter).
4. **Query face** additions (`routes-knowledge.ts`, admin): `contact_profile`,
   `top_contacts`, `rank_contacts`, `relationship_subgraph`, `connectors`,
   `graph_status`. Backed by `graph.ts` reading `graph.db` in-proc.
5. **Agent tools** — `knowledge_graph_*` (or reuse the wxgraph tool names)
   admin-tier MCP tools in the wechat MCP server wrapping the Query routes
   (mirror `knowledge_search`); prompt bullet.
6. **Retire `wxgraph`** — the plugin's build/query MCP tools + its `..` source
   read + sidecar store are removed; the package is retired (like wxsearch's
   indexing role). Update the manifest / KNOWN_KNOWLEDGE_PLUGINS.

**Out (later slices):**
- facts (agent-driven extraction loop) + person (projection) — follow-on slices
  on the now-rich source + graph.
- agent-social Phase 2 (wire judge/discover to the Query face) — separate, after
  facts+person land (judge wants person_brief; discover wants rank_contacts,
  which THIS slice provides — so discover can be wired after this).
- Relay-2 in-process for facts/person (this slice does graph only).

## Architecture

### Source enrichment
`source.db.messages` gains: `local_type INTEGER`, `is_group INTEGER`, `kind TEXT`
(normalized), plus a small `source_mentions(msg_key, target_un)` table (or a JSON
column) for @mention/refermsg edges. The adapter (`source-adapter.ts`) stops
filtering to `type===1`: it ingests every row, computes `kind` via a ported
`classifyType(local_type, content)`, resolves `is_group` from the conversation
(session vs group — wxgraph's `source.iter_messages` logic), and extracts mention
targets. `listMessages` still returns text for wxsearch (add a `kind` filter or
have the indexer skip non-text). **Provenance/immutability unchanged** — source
stays write-once ground truth.

### In-process graph builder + cycle
`runKnowledgeCycle` (after adapter + indexer) calls `rebuildGraph({ sourceStore,
graphStore, now, ownerOverride })` when graph is enabled. Reads `source` in-proc,
builds profiles+edges, writes `graph.db`. Incremental: rebuild is cheap at
personal scale; can gate on source watermark advancing (rebuild only if new
messages). `now` injected (no `Date.now()` in pure builder for testability —
bootstrap passes it).

### Query + tools
Query routes are admin-only (same as search). Agent tools admin-gated + prompt
bullet gated on availability, exactly like `knowledge_search`.

## Data model (graph.db)
```sql
CREATE TABLE contacts (username TEXT PRIMARY KEY, display TEXT, closeness REAL,
  total INT, sent INT, recv INT, first_ts INT, last_ts INT, active_days INT,
  initiations INT, transfer_in INT, transfer_out INT, shared_groups INT,
  recency REAL, volume REAL, intimacy REAL, reciprocity REAL, kind TEXT, types TEXT);
CREATE TABLE edges (a TEXT, b TEXT, kind TEXT, weight REAL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- owner, built_at, source_watermark
```
(Port wxgraph's `store.py` schema; `types` = JSON per-kind counts.)

## Verification
- **Source enrichment (unit):** adapter fixture with text + voice + transfer +
  a group message + an @mention → `source.db` has all with correct `kind`,
  `is_group`, mention rows; wxsearch's text-only view unaffected.
- **graph.ts (unit):** port-fidelity tests against the reviewed Python behavior —
  build profiles from a fixture message set, assert closeness sub-scores +
  ordering match the Python (same weights/inputs → same ranking); owner
  detection; resolve_name collision → candidates; mention edges; `now` injection.
- **Query/tools (unit):** routes return the graph data; tools admin-only (mirror
  knowledge_search gating tests).
- **VERIFY-AGAINST-REAL (owner machine):** rebuild graph from real source →
  `top_contacts`/`contact_profile` match the old wxgraph output on the same data
  (owner inferred correctly, closeness plausible), entirely off `..`.

## Non-goals / risks
- Faithful Python→TS port of a nontrivial scoring algorithm — the port tests must
  pin the numeric behavior (weights, P95, decay), not just "runs".
- Source enrichment re-backfills once (idempotent) — a larger source.db (all
  messages, not just text).
- facts + person still on `..` until their slices; person_brief not available yet
  (needs facts).
