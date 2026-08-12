# Knowledge Kernel Phase 0/1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stand up the daemon-owned Knowledge Kernel and move semantic search (wxsearch) fully onto it — decrypted messages ingested into an owned `source` store, wxsearch reading via a Query face (no `..`) and writing vectors via an Ingest face (with provenance), search running on the daemon's Query face.

**Architecture:** A knowledge root (`${STATE_DIR}/knowledge/`) with `source.db` + `semantic.db` behind one Knowledge API (`routes-knowledge.ts` in internal-api). A source adapter normalizes wxvault's `out/decrypted` once (zstd-decode + prefix-strip) into `source`. wxsearch becomes a pure indexer; its cosine+FTS+RRF search is ported to the TS Query face.

**Tech Stack:** TypeScript/Bun (host: store, routes, adapter, search); Python (wxsearch indexer HTTP re-plumb). `bun test` / `pytest` via the out-of-repo venv.

## Global Constraints

- **Source is immutable ground-truth; derived carries provenance.** Every `semantic` row stores `model_id + model_version`; `search` filters by `model_id` → mixed-dimension stacking is impossible by construction.
- **Normalize once at ingest.** The adapter does the zstd-decode (ZMAGIC `\x28\xb5\x2f\xfd` + `stream_reader` fallback) + exact-sender-prefix strip a single time; `source.db` holds clean text; no consumer touches zstd.
- **wxvault (closed) is not modified** — the adapter only READS its `out/decrypted`.
- **Consumers never open the knowledge SQLite files** — only the Knowledge API. Bulk vectors never cross HTTP (search runs in-process in the daemon).
- **TDD**: failing test first, watch fail, implement, watch pass, commit. `bun test <file>` (host) / venv `pytest` (wxsearch). Never `git add -A`; never touch `package.json`/`bun.lock` (revert bun auto-bump).
- Host default branch `master`, integration `dev`. Work on `feat/knowledge-kernel-phase01`. wxsearch changes are in the sibling `wechat-cc-plugins` repo.
- Keep the reviewed search knowledge intact when porting: RRF `k=60`, own-content FTS5 trigram, exact cosine (no FAISS).

## Source of truth
Spec: `docs/superpowers/specs/2026-07-12-knowledge-kernel-phase01-design.md`. North star: `docs/design/2026-07-12-knowledge-kernel-architecture.md`.

---

## File Structure

Host (`wechat-cc`):
- Create `src/daemon/knowledge/store.ts` — open/create source.db + semantic.db; low-level put/query.
- Create `src/daemon/knowledge/search.ts` — cosine + FTS5 bm25 + RRF over semantic.db (TS port).
- Create `src/daemon/knowledge/source-adapter.ts` — normalize `out/decrypted` → source (backfill + incremental).
- Create `src/daemon/internal-api/routes-knowledge.ts` — Ingest + Query HTTP surface.
- Modify `src/daemon/internal-api/routes.ts` — spread `...knowledgeRoutes(deps)`.
- Modify `src/daemon/internal-api/types.ts` — add `knowledge?: { store; search }` to `InternalApiDeps`.
- Modify `src/daemon/internal-api/route-tiers.ts` — gate `/v1/knowledge/*` (ingest internal/admin; query = agent tier).
- Modify `src/daemon/bootstrap/index.ts` — construct the store, schedule the adapter, wire `deps.knowledge`.

wxsearch (`wechat-cc-plugins/packages/wxsearch`):
- Create `wxsearch/kclient.py` — tiny HTTP client for the Knowledge API (messages paging + semantic put + search).
- Modify `wxsearch/embed.py` (unchanged runner), `wxsearch/server.py` (index_update pages source via kclient + writes via kclient; search forwards to `/knowledge/search`). Retire `text_source.py` + the `index.sqlite` sidecar path.

---

## Task 1: Knowledge store (source.db + semantic.db)

**Files:** Create `src/daemon/knowledge/store.ts`; Test `src/daemon/knowledge/store.test.ts`.

**Interfaces (Produces):**
- `openKnowledge(root: string): KnowledgeStore` with:
  - `putSourceMessages(msgs: SourceMsg[]): void` (idempotent upsert on msg_key; assigns monotonic `ingested_watermark`).
  - `listMessages(sinceWatermark: number, limit: number): { messages: SourceMsg[]; watermark: number }`.
  - `putSemantic(model_id: string, model_version: string, chunks: Chunk[]): void` (idempotent on `(msg_key, model_id)`).
  - `loadVectors(model_id: string): { rowids: number[]; dim: number; buf: Float32Array }` and `keywordSearch(query, k)` and `getDocs(rowids)` and `getMeta/setMeta`.
  - `close()`.
- Types `SourceMsg = { msg_key, conversation, sender, time, type, text, server_id }`, `Chunk = { msg_key, conversation, sender, time, kind, text, vector: number[] }`.

- [ ] Step 1 (failing test): open a temp-dir store; `putSourceMessages` two msgs then `putSourceMessages` one again with the same msg_key (upsert, no dup); `listMessages(0, 10)` returns them ordered by watermark with a watermark cursor; a second `listMessages(watermark, 10)` returns only newer. `putSemantic('m','1',[chunk])` twice → one row; `loadVectors('m')` returns 1 vector of the right dim; `loadVectors('other')` returns empty. Provenance: a chunk written under `('m2','1')` is NOT returned by `loadVectors('m')`.
- [ ] Step 2: run `bun test src/daemon/knowledge/store.test.ts` → FAIL.
- [ ] Step 3: implement with `bun:sqlite` (mirror how existing daemon stores open SQLite — see `src/core/a2a-events-store.ts` for the Database usage pattern). DDL exactly per the spec's Data model. `putSourceMessages` uses `INSERT ... ON CONFLICT(msg_key) DO UPDATE`; watermark = a monotonic counter column via `MAX(ingested_watermark)+1` per batch. `putSemantic` upserts on `(msg_key, model_id)`, stores `vector` as `Float32Array` bytes + `model_id`,`model_version`. `loadVectors` selects `WHERE model_id=?` only (provenance filter). own-content FTS5 for `keywordSearch` (mirror the reviewed Python `IndexStore`).
- [ ] Step 4: run → PASS. [ ] Step 5: commit `feat(knowledge): source.db + semantic.db store with provenance (KK T1)`.

## Task 2: `semantic_search` (TS: cosine + FTS + RRF)

**Files:** Create `src/daemon/knowledge/search.ts`; Test `search.test.ts`.

**Interfaces:** `semanticSearch(store, { queryVector, queryText, model_id, limit, conversation? }): { results, vectors_stale }`. (The query embedding is computed by the caller/route via the embed worker; search takes the vector.)

- [ ] Step 1 (failing test): seed a store with 3 chunks (distinct vectors + texts) under model 'm'; `semanticSearch` with a queryVector closest to chunk B and queryText matching chunk C's word → RRF fuses cosine(B) + bm25(C); assert B and C both appear, ranked. With `model_id` mismatch vs stored meta → `vectors_stale:true` and BM25-only. `conversation` filter applied after fusion.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement — load vectors via `store.loadVectors(model_id)`, cosine = matrix·q (plain TS loop over Float32Array, personal scale), argsort top-k; `store.keywordSearch` for bm25 rowids; RRF (k=60) exactly as the reviewed Python `rrf()`; `store.getDocs(fused)`; conversation filter + limit after fusion. Port `search.py` semantics 1:1.
- [ ] Step 4: run → PASS. [ ] Step 5: commit `feat(knowledge): TS semantic search (cosine+FTS+RRF, model-filtered) (KK T2)`.

## Task 3: `routes-knowledge.ts` (Ingest + Query surface)

**Files:** Create `src/daemon/internal-api/routes-knowledge.ts`; Modify `routes.ts` (import + spread `...knowledgeRoutes(deps)` next to `...socialRoutes(deps)` ~line 696), `types.ts` (add `knowledge?: { store: KnowledgeStore; search: typeof semanticSearch; embedQuery?: (text) => Promise<number[]> }` to `InternalApiDeps`), `route-tiers.ts` (tier-gate the new paths). Test `routes-knowledge.test.ts`.

**Mirror `routes-social.ts` exactly** (`export function knowledgeRoutes(deps: InternalApiDeps): RouteTable`, 503 when `!deps.knowledge`, inline body validation, no REQUEST_SCHEMAS entry needed).

Routes:
- `POST /v1/knowledge/source/put` → `deps.knowledge.store.putSourceMessages(body.messages)` → `{ ok, watermark }`.
- `GET  /v1/knowledge/messages` (query `since_watermark`,`limit`) → `store.listMessages(...)`.
- `POST /v1/knowledge/semantic/put` → `store.putSemantic(body.model_id, body.model_version, body.chunks)`.
- `POST /v1/knowledge/search` → embed `body.query` via `deps.knowledge.embedQuery` (if wired) → `deps.knowledge.search(store, {...})`.
- `GET  /v1/knowledge/semantic/status` → counts + meta.

- [ ] Step 1 (failing test, mirror `routes-social.test.ts`): with a real temp store wired into `deps.knowledge`, exercise source/put→messages paging; semantic/put→search returns the seeded chunk; 503 when `deps.knowledge` absent; bad body → 400.
- [ ] Step 2: run `bun test src/daemon/internal-api/routes-knowledge.test.ts` → FAIL.
- [ ] Step 3: implement the routes + types + tier rows (mirror how `social_seek` routes are tiered in `route-tiers.ts`: query = agent-callable, ingest = admin/internal only).
- [ ] Step 4: run → PASS. [ ] Step 5: commit `feat(knowledge): routes-knowledge Ingest+Query surface (KK T3)`.

## Task 4: Source adapter (normalize out/decrypted → source)

**Files:** Create `src/daemon/knowledge/source-adapter.ts`; Test `source-adapter.test.ts`.

**Interfaces:** `runSourceAdapter({ decryptedDir, store, sinceWatermark? }): { ingested: number }`. Reads `message_*.sqlite` (each `Msg_<md5>` table + `Name2Id` rowid→user_name map + is_session) and `contact.sqlite`; for each row: zstd-decode `message_content` (ZMAGIC + stream_reader fallback), strip the exact resolved-sender prefix, `msg_key = "<table>:<local_id>"`, text-type gating (type 1); emit `SourceMsg` and `store.putSourceMessages` in batches.

**Port the normalization from the reviewed Python** `wxsearch/text_source.py` (`_to_text`, ZMAGIC, the Name2Id rowid resolution, exact-prefix strip) — this is the logic being centralized. Use a zstd lib available to Bun (`fzstd`/`zstd` npm, or Bun's built-in if available; pick one and add it as the ONE new dep, justified in the commit).

- [ ] Step 1 (failing test): build a fixture `decryptedDir` with a `message_0.sqlite` containing `Name2Id` + a `Msg_<md5>` table with (a) a plain text row, (b) a row whose `message_content` is a zstd BLOB (compress with the chosen lib, incl. a content-size-less frame), (c) a row prefixed `"<sender>:\n..."`. Run the adapter → assert `source.db` has the decoded/stripped text for all three, correct msg_key/conversation/sender.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement (read-only `file:...?mode=ro`); batch inserts; watermark-incremental (only rows past a stored source cursor — reuse a meta key). Handle the content-size-less zstd frame via stream_reader fallback (the bug class fixed once, here).
- [ ] Step 4: run → PASS. [ ] Step 5: commit `feat(knowledge): source adapter — decode/normalize out/decrypted once (KK T4)`.

## Task 5: Bootstrap wiring + adapter scheduling

**Files:** Modify `src/daemon/bootstrap/index.ts`; Test additions in `src/daemon/bootstrap.test.ts`.

- Construct `const knowledgeStore = openKnowledge(join(STATE_DIR, 'knowledge'))` at boot (gated behind a config flag `knowledge_enabled?` in agent-config, mirroring `social_enabled` — default off so it's opt-in during the slice).
- Wire `deps.knowledge = { store, search: semanticSearch, embedQuery }` where `embedQuery` uses the wxsearch embed worker (or, for the slice, is undefined and `/knowledge/search` requires the caller to pass a pre-embedded vector — simplest first; note in report).
- Schedule `runSourceAdapter` (backfill on enable + incremental on the existing tick loop; mirror how another periodic job is scheduled in `wiring/tick-bodies.ts`).
- [ ] Steps: bootstrap test asserts `deps.knowledge` present iff `knowledge_enabled`; `/v1/knowledge/*` 503 when disabled. Implement, verify `bun test src/daemon/bootstrap.test.ts`, commit `feat(knowledge): bootstrap wiring + adapter scheduling (KK T5)`.

## Task 6: wxsearch indexer re-plumb (Python)

**Files (wechat-cc-plugins/packages/wxsearch):** Create `wxsearch/kclient.py`; Modify `wxsearch/server.py`; retire `text_source.py`/`index.py` sidecar usage. Test `packages/wxsearch/tests/test_kclient_indexer.py`.

- `kclient.py`: `KClient(base_url, token)` with `iter_messages(since_watermark)` (pages `GET /v1/knowledge/messages`), `put_semantic(model_id, model_version, chunks)`, `search(query, model_id, limit)`. Thin `urllib`/`requests` over the internal-api (reuse the plugin's existing internal-api client auth pattern — grep how wxmedia/wxsearch already call back to the daemon, if at all; else use the loopback base_url + token from env like other plugins).
- `server.py` `index_update`: page source via `kclient.iter_messages` (clean text — NO `text_source`/zstd), embed with the existing `embed.py` runner, `kclient.put_semantic(...)` with `model_id@version`. `search` tool → `kclient.search(...)`.
- [ ] Step 1 (failing test): with a stub KClient (records puts, returns 2 fake messages) + a fake embed runner, `index_update` reads the 2 messages and puts 2 chunks with the model id — asserting NO filesystem `..` access and NO local `index.sqlite` written.
- [ ] Step 2: venv `pytest packages/wxsearch/tests/test_kclient_indexer.py` → FAIL.
- [ ] Step 3: implement; delete the `text_source.py` import + the `IndexStore` sidecar writes.
- [ ] Step 4: run → PASS (adjust/retire the old `test_text_source`/`test_index` tests that no longer apply — note them in the report). [ ] Step 5: commit in the plugins repo `feat(wxsearch): re-plumb indexer onto the Knowledge API (KK T6)`.

## Task 7: Retire wxsearch's sidecar search path + manifest/env

**Files:** `wxsearch/server.py` (search/status/models_status/set_model become thin wrappers over kclient or stay local model policy), `wechat-cc.plugin.json` (env: knowledge base_url/token; drop the `../wxvault` healthcheck path now that it reads via API). Test: update `wxsearch` suite green.
- [ ] Steps: point search at `/knowledge/search`; keep `set_model`/`models_status` as model-policy locals; update manifest env (Knowledge API base_url + token, remove the `${dataDir}/../wxvault` requiresPaths). Run the wxsearch suite green; commit `feat(wxsearch): search via Knowledge API; drop ../wxvault dependency (KK T7)`.

## Task 8: VERIFY-AGAINST-REAL (controller-run, not a subagent)

On the user's real `~/Documents/wxvault/out/decrypted`: enable `knowledge_enabled`, run the adapter (backfill), run wxsearch `index_update` with real fastembed, call `/v1/knowledge/search` with a few real queries → confirm relevant messages return, entirely off the `..` path (grep-confirm no `../wxvault` access in the search path). Record counts + a couple example hits. This mirrors the plugin suite's VERIFY-AGAINST-REAL and is the acceptance gate for the slice.

## Self-review checklist (done)

- **Spec coverage:** source.db+semantic.db (T1), TS search (T2), Ingest/Query routes (T3), adapter normalize-once (T4), bootstrap+schedule (T5), wxsearch indexer re-plumb (T6), search-via-API + drop `..` (T7), real verify (T8). Provenance (model_id filter) in T1/T2/T3. Decode-once in T4.
- **Type consistency:** `SourceMsg`/`Chunk` from T1 used in T3/T4/T6; `semanticSearch` sig from T2 used in T3/T5.
- **Placeholders:** none — integration tasks name the mirror targets (`routes-social.ts`, `a2a-events-store.ts`, `route-tiers.ts` social rows, `tick-bodies.ts`).

---

## PIVOT (2026-07-12): Option C — daemon-driven in-process indexer + dumb embed subprocess

The plugin-calls-Knowledge-API approach (T6/T7 as originally written) hit a real gap: the daemon injects internal-api creds only to CORE MCP servers, not to plugins, so a wxsearch worker has no admin token for the admin-only Knowledge API. Rather than add a first-party-plugin auth path, we invert control (the correct long-term shape):

- **The daemon owns + drives indexing IN-PROCESS.** A new `src/core/knowledge/indexer.ts` reads `source` via the store directly (in-proc, no HTTP), batches, embeds, and writes `semantic` via the store directly (in-proc). No cross-process auth, no `..`.
- **Embed stays Python but as a DUMB subprocess** (text in → vectors out), never a plugin that calls back. Protocol: the daemon spawns `embed_subprocess.py` ONCE per indexing run; sends batches as JSONL on stdin (`{"texts":[...]}`); reads JSONL vectors on stdout (`{"vectors":[[...]]}`); closes stdin when done (amortizes model load). The script reuses wxsearch's existing `embed.py` fastembed runner + model-manager policy. NO Knowledge API, NO token, NO `..`.
- **The HTTP Query/Ingest routes (T3) stay** — `search` for the agent, Ingest for any external producer — but the indexer does not use them (it's in-proc).
- **wxsearch's indexer role disappears.** T6's `kclient.py` + `index_update`-via-kclient are superseded (reverted). `text_source.py`/sidecar stay removed. `embed.py` is reused by `embed_subprocess.py`. The agent's `search` = the daemon Query face.

### Revised remaining tasks
- **T6' (host, TS):** `src/core/knowledge/indexer.ts` (`runIndexer({store, embed, model_id, model_version, batch})`, injectable embed) + `src/core/knowledge/embed-runner.ts` (spawns the persistent Python embed subprocess, JSONL protocol). TDD with a fake embed / fake subprocess.
- **T6'' (plugins, Python):** `embed_subprocess.py` — read JSONL texts on stdin, embed via the existing `embed.py` fastembed runner, write JSONL vectors on stdout. Revert T6's kclient/index_update changes; keep text_source deletion.
- **T7' (host):** bootstrap schedules `runIndexer` after the source adapter (in-proc, gated on knowledge_enabled). Retire wxsearch's indexing MCP; drop its `../wxvault` healthcheck.
- **T8:** VERIFY-AGAINST-REAL (adapter → indexer → embed subprocess with real fastembed → `/knowledge/search`), on the user's machine.
