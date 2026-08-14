# Knowledge Kernel — Phase 1 continuation: agent-facing search — Design

**Date**: 2026-07-12
**Status**: Design approved (brainstorm 2026-07-12); writing-plans next.
**Builds on**: `docs/superpowers/specs/2026-07-12-knowledge-kernel-phase01-design.md`
(Phase 0/1 slice, merged: host dev `dd6efd58`, plugins main `60c62f3`). Closes
final-review findings I2 (embed-model desync) + I3 (agent has no search path).

## Goal

Make the Knowledge Kernel actually usable by the agent: the owner's agent can
call a `knowledge_search(query)` MCP tool that semantically searches the owner's
message history — the daemon embeds the query itself (no caller-supplied vector)
using the **same embedder that indexed**, so query and index share one embedding
space by construction.

## The key decision (brainstorm): one daemon-owned embedder service (Option b)

Today the indexer spawns + closes its own embed subprocess per cycle, and the
search route has no query embedder at all. Instead of a *separate* query
embedder (which could load a different model than the indexer → query in the
wrong space → garbage results), we introduce **one daemon-owned singleton
embedder service** that BOTH the indexer and the query path use. This:
- guarantees index and query embed with the **same model** (correctness, closes
  I2 — one source of `model_id`, no desync);
- is the first instance of the kernel's "daemon-driven capability worker"
  pattern (reusable later for ASR/OCR/reranker);
- has one lifecycle (lazy-spawn, respawn-on-death, close-on-shutdown) instead of
  the indexer's per-cycle spawn/close plus a second query runner.

## Scope

**In:**
- `src/core/knowledge/embedder-service.ts` — the singleton embedder service
  (wraps a persistent `makeEmbedRunner`; lazy spawn, respawn on death, `close()`).
- Refactor `runKnowledgeCycle`/indexer wiring to use the shared service instead
  of spawning + closing an embed runner per cycle.
- Wire `deps.knowledge.embedder` / `embedQuery`; `/v1/knowledge/search` embeds
  `body.query` via the service when no `queryVector` is given, and uses the
  service's `model_id` (so search's provenance filter matches what was indexed).
- `src/mcp-servers/wechat/tools-knowledge.ts` — the `knowledge_search` MCP tool
  (admin-tier), calling `/v1/knowledge/search`.
- Register `knowledge_search` in the wechat MCP server under `SESSION_IS_ADMIN`
  (mirrors `registerSocialSeekTool`); gate it in `user-tier.ts` (admin-only).
- Re-add the prompt-builder search bullet, gated on the tool actually being
  available (knowledge enabled + admin session), pointing at `knowledge_search`.

**Out (later):**
- Opening query to `trusted` contacts (needs memoryScopeDenied-style per-caller
  conversation scoping — still deferred).
- Migrating wxmedia/wxgraph/wxfacts/wxperson into the kernel.
- Reranker; the wxmedia "also searchable" prompt line (returns once wxmedia
  derived text is indexed into `semantic`).

## Architecture

### Embedder service (`embedder-service.ts`)

`makeEmbedderService(opts: { pythonBin: string; scriptPath: string; model_id: string; env?: Record<string,string>; timeoutMs?: number }): EmbedderService` where:
```ts
interface EmbedderService {
  model_id: string
  embed(texts: string[]): Promise<number[][]>   // lazy-spawns the runner on first call; respawns if the prior runner is broken
  close(): Promise<void>                         // close on daemon shutdown
}
```
- Internally holds `let runner: EmbedRunner | null`. `embed()`: if `runner` is
  null or marked broken, `runner = makeEmbedRunner({...})` (reusing the existing
  persistent-subprocess runner with its timeout + length-guard). Then
  `runner.embed(texts)`. On a rejection that indicates the child died/broke,
  drop the runner (next call respawns). Concurrency: `makeEmbedRunner` already
  serializes requests over the pipe; the service adds respawn + a single shared
  instance. Lazy = no subprocess (no model load) until the first index or query.
- One resident model at rest (serving queries), same instance the indexer uses.

### Indexer wiring change

`runKnowledgeCycle` no longer does `makeEmbedRunner(...)` + `finally close()`.
It takes the shared `embedder` and calls `runIndexer({ store, embed: embedder.embed, model_id: embedder.model_id, model_version })`. The service is created ONCE in bootstrap (knowledge block, gated on `knowledge_enabled`) and `close()`d in the shutdown path. `runIndexer` is unchanged (it already takes an injected `embed`).

### Search route embeds the query

`/v1/knowledge/search`: if `body.queryVector` is absent and `deps.knowledge.embedder` is present, `queryVector = (await embedder.embed([body.query]))[0]`; use `model_id = embedder.model_id` (NOT a caller-supplied one) so the provenance filter matches the index. Keep accepting an explicit `queryVector` (tests, external callers). If neither a vector nor an embedder is available → 400 `query_vector_required` (unchanged fallback).

### `knowledge_search` MCP tool

`src/mcp-servers/wechat/tools-knowledge.ts` — `registerKnowledgeSearchTool(server, client)` mirroring `registerSocialSeekTool`: tool `knowledge_search` with params `{ query: string, limit?: number, conversation?: string }`, calling internal-api `POST /v1/knowledge/search` with `{ query, limit, conversation }`, returning the `{results}` (or a passthrough error). Registered inside the wechat MCP server's `if (SESSION_IS_ADMIN)` block. Tier-gated `admin` in `user-tier.ts` (mirror `social_seek`/`file_locate`) so it's classified admin-only + fail-closed.

### Prompt bullet

Re-add to `knowledgeOrchestrationSection` (or via a new signal) a bullet like
`- **消息检索**（\`knowledge_search\`）：语义找"那次聊到 X 的消息"。回溯具体对话用它。`
— rendered only when knowledge search is actually available (knowledge enabled +
admin session). Route a `knowledgeSearchAvailable: boolean` (or similar) from
bootstrap into the prompt builder rather than keying on the `wxsearch` plugin
name (which no longer provides the tool).

## Verification

- **Embedder service (unit):** injected `makeEmbedRunner`/spawn fake — lazy (no
  spawn until first `embed`); reuse across calls (one runner); respawn after a
  simulated child death (next `embed` gets a fresh runner); `close()` closes the
  runner and a subsequent `embed` respawns.
- **Search route (unit):** with a fake embedder in `deps.knowledge`, `POST
  /v1/knowledge/search {query}` (no queryVector) embeds via the service + returns
  the seeded chunk; the `model_id` used is the embedder's; an explicit
  `queryVector` still works; no embedder + no vector → 400.
- **MCP tool (unit):** `knowledge_search` is admin-only in `user-tier.ts`
  (allowed admin, denied trusted/guest — mirror `social_seek` tests); the tool
  calls the right internal-api path.
- **Bootstrap:** indexer + query share ONE embedder instance (assert the same
  `model_id`); service `close()`d on shutdown; nothing spawned when knowledge
  disabled.
- **VERIFY-AGAINST-REAL (T-final, owner's machine):** `knowledge_search("...")`
  from the agent returns relevant real messages — the whole kernel usable end to
  end, index and query provably in the same space.

## Non-goals / risks
- One resident embedding model in RAM while the daemon runs (personal scale —
  acceptable; it's the same model the indexer needs anyway).
- First query after boot pays the lazy model-load once.
- Admin-only means only the owner's agent can search (correct privacy posture;
  trusted-scoping is a separate future item).
