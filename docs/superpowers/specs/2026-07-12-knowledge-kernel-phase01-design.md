# Knowledge Kernel — Phase 0/1 (Walking Skeleton) — Design

**Date**: 2026-07-12
**Status**: Design approved (brainstorm 2026-07-12); writing-plans next.
**Builds on**: `docs/design/2026-07-12-knowledge-kernel-architecture.md` (the
north-star). This spec is the **first vertical slice** — Phase 0 (Knowledge API
skeleton) + Phase 1 pilot (adapter-ingest `source`, re-plumb **wxsearch** off the
`..` hack) — proving the whole pattern end-to-end on one capability before rolling
to the rest.

## Goal

Stand up the daemon-owned **Knowledge Kernel** and move ONE capability (semantic
search) fully onto it: the decrypted messages are ingested into an owned `source`
store; wxsearch reads that via the **Query face** (no more `${dataDir}/../wxvault`
`..`), writes chunks+vectors via the **Ingest face** (with provenance), and search
runs on the daemon's Query face over an owned `semantic` store.

## Why this pilot

wxsearch best demonstrates the kernel's headline wins: **provenance** (vectors
isolated by `model@version` → the mixed-dimension `np.stack` bug becomes
structurally impossible) and **decode-once** (the adapter does the zstd-decode +
sender-prefix-strip a single time at ingest, so every consumer gets clean text and
the duplicated-and-once-buggy per-plugin zstd path disappears).

## Scope

**In:**
- A daemon-owned knowledge root with `source.db` + `semantic.db` (SQLite).
- `routes-knowledge.ts` in internal-api: a minimal Ingest + Query surface.
- A **source adapter** job: read wxvault's `out/decrypted/message_*.sqlite` +
  `contact.sqlite`, normalize (zstd-decode, prefix-strip, msg_key), write into
  `source` via Ingest. wxvault (closed) is untouched.
- **wxsearch re-plumb**: becomes a pure *indexer* — read source via Query, embed,
  write chunks+vectors via Ingest. Its search (cosine+FTS+RRF) moves to the Query
  face (`semantic_search`), ported to TS.
- The daemon exposes an agent MCP `search` tool that wraps `semantic_search`.

**Out (later phases):**
- Re-plumbing wxmedia/wxgraph/wxfacts/wxperson (Phase 1 continuation, same pattern).
- Touching closed wxvault (adapter only — never direct-write in this slice).
- Relay 2 in-process collapse; agent-social onto the Query face (Phase 2);
  sovereignty polish (Phase 4).
- `derived.db` (facts/graph/media) — created when those producers migrate.

## Architecture

### Knowledge root

A daemon-owned dir (e.g. `${STATE_DIR}/knowledge/`) holding, this slice:
- `source.db` — normalized messages + contacts (write-once by the adapter).
- `semantic.db` — chunks + vectors + FTS (written by the wxsearch indexer).

Split by write-owner + access pattern, **behind one Knowledge API** — consumers
never open these files; changing the split breaks no one.

### Knowledge API — `src/daemon/internal-api/routes-knowledge.ts`

Spread into `makeRoutes` like `routes-a2a`/`routes-social`; schemas in `schema.ts`;
gated in `route-tiers.ts` (ingest = admin/internal; query = the agent's tier).

**Ingest face** (producers write; every derived row carries provenance):
- `POST /v1/knowledge/source/put` — `{ messages: SourceMsg[], contacts?: Contact[] }`
  (adapter; idempotent upsert on `msg_key`).
- `POST /v1/knowledge/semantic/put` — `{ model_id, model_version, chunks: Chunk[] }`
  where each Chunk = `{ msg_key, conversation, sender, time, kind, text, vector }`;
  idempotent on `(msg_key, model_id)`; stores provenance `model_id@model_version`.

**Query face** (consumers read):
- `GET /v1/knowledge/messages?since_watermark=&limit=` → `{ messages: SourceMsg[],
  watermark }` — the indexer pages through source here (replaces `..` + zstd).
- `POST /v1/knowledge/search` — `{ query, model_id, limit, conversation? }` →
  `{ results, vectors_stale }` — runs cosine (over `semantic.db` vectors for
  `model_id`) + FTS5 bm25 + RRF **in the daemon (TS)**.
- `GET /v1/knowledge/semantic/status` → `{ indexed, model_id, model_version }`.

### Source adapter (job)

A daemon-scheduled job (`src/daemon/knowledge/source-adapter.ts`): open wxvault's
`out/decrypted/message_*.sqlite` read-only, walk each `Msg_<md5>` conversation table
(+ `Name2Id`, `contact.sqlite`), and for each message do the normalization that is
today duplicated across plugins **once**:
- zstd-decode `message_content` (ZMAGIC + stream_reader fallback),
- strip the exact sender-username prefix,
- compute `msg_key = "<table>:<local_id>"`,
resolving sender via the `Name2Id` rowid map. Emit `SourceMsg { msg_key,
conversation, sender, time, type, text, server_id }` and `POST /source/put`. Runs a
backfill on first enable + incremental by watermark thereafter. **wxvault is not
modified** — the adapter only reads its output.

### wxsearch re-plumb (the pilot capability)

`packages/wxsearch` keeps `embed.py` (the fastembed runner) and its search
*algorithm knowledge*, but its I/O moves to the Knowledge API:
- **Indexer** (`index_update`): page source via `GET /knowledge/messages` (clean
  text — no `text_source.py` `..`/zstd anymore), embed, `POST /semantic/put` with
  `model_id@version` (provenance). Its old sidecar `index.sqlite` + `text_source.py`
  are retired.
- **Search**: the cosine+FTS+RRF logic (`search.py`) is **ported to the Query
  face** (`semantic_search` in TS over `semantic.db`). wxsearch's MCP `search` tool
  becomes a thin call to `/knowledge/search` (or is replaced by the daemon's agent
  `search` tool). `models_status`/`set_model` stay as thin wrappers.

## Data model

### `source.db`
```sql
CREATE TABLE messages (
  msg_key TEXT PRIMARY KEY,        -- "Msg_<md5>:<local_id>"
  conversation TEXT, sender TEXT, time INTEGER,
  type TEXT, text TEXT, server_id TEXT,
  ingested_watermark INTEGER       -- monotonic; Query pages by this
);
CREATE TABLE contacts ( username TEXT PRIMARY KEY, display TEXT, ... );
```
Text is already normalized (decoded, prefix-stripped) — consumers never touch zstd.

### `semantic.db`
```sql
CREATE TABLE chunks (
  rowid INTEGER PRIMARY KEY, msg_key TEXT, conversation TEXT, sender TEXT,
  time INTEGER, kind TEXT, text TEXT,
  vector BLOB, model_id TEXT, model_version TEXT,   -- provenance
  UNIQUE(msg_key, model_id));
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, tokenize='trigram');  -- own-content
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```
`semantic_search` loads only the requested `model_id`'s vectors → **mixed-dimension
`np.stack` is impossible by construction** (provenance is the fix, in the schema).

### Provenance (the invariant this slice establishes)
Every `semantic` row carries `model_id + model_version`; the Query search filters by
`model_id`. This is the first concrete payoff of the "built-in provenance" principle
and the template every later producer copies.

## Verification

- **Unit**: Knowledge API routes (source put/query paging by watermark; semantic
  put idempotent on `(msg_key,model_id)`; search filters by model_id; provenance
  stored) — TS tests mirroring `routes-social.test.ts`. The TS `semantic_search`
  (cosine+FTS+RRF) gets its own test with tiny fixtures.
- **Adapter**: fixture `out/decrypted` (a couple `Msg_` rows incl. a zstd BLOB +
  a sender-prefixed row) → asserts normalized text in `source.db`.
- **wxsearch indexer**: with a fake embed runner, `index_update` pages source via a
  stub Query client and writes chunks via a stub Ingest client (no `..`, no sidecar).
- **VERIFY-AGAINST-REAL** (mirrors the plugin suite): run the adapter on the user's
  real `~/Documents/wxvault/out/decrypted`, index with real fastembed, and confirm
  `/knowledge/search` returns relevant messages — end-to-end off the `..` path.

## Non-goals / risks

- Search-in-TS is a port of proven Python cosine+FTS+RRF; personal scale (tens of
  thousands of vectors) makes a TS matmul fine. Keep the RRF constant (k=60) + the
  own-content FTS5 exactly as the reviewed Python.
- Bulk vector load stays in-process (daemon reads `semantic.db` directly); no bulk
  vectors cross the HTTP boundary.
- The adapter duplicates wxvault's output rather than replacing it during the slice
  (both exist until the other producers migrate) — accepted transitional overlap.

## Open questions (for the plan)

- Exact knowledge-root path + whether it lives beside or under the existing
  `plugin-data/` (pick a daemon-owned location outside any plugin's dataDir).
- Job scheduling: reuse the existing tick loop vs a small dedicated backfill runner.
- Whether the agent's `search` tool is the daemon's own (retiring wxsearch's MCP
  server) or wxsearch's MCP forwarding to `/knowledge/search` (less disruptive
  first). Prefer the latter for the slice; retire wxsearch's server in Phase 1
  continuation.
