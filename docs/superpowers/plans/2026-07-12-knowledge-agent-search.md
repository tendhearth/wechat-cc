# Knowledge Kernel — Agent-facing Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Make the kernel usable by the agent — a daemon-owned singleton embedder service (used by BOTH indexer and query), query-embedding in `/v1/knowledge/search`, and a `knowledge_search` admin-only MCP tool. Closes final-review I2 (embed-model desync) + I3 (no agent search path).

**Architecture:** One `EmbedderService` (lazy-spawn, respawn-on-death, close-on-shutdown) wraps the persistent `makeEmbedRunner`. The indexer stops spawning its own per-cycle runner and uses the service; the search route embeds the query via the same service using the service's `model_id`. A `knowledge_search` MCP tool wraps the admin-only route.

**Tech Stack:** TypeScript/Bun; `bun test`. Host repo only (`wechat-cc`), branch `feat/knowledge-agent-search` (base dev `dd6efd58`).

## Global Constraints
- **One embedder, one model_id.** The indexer and the query path use the SAME `EmbedderService` instance → index and query embed in the same space; the search route uses `embedder.model_id` (never a caller-supplied model_id).
- **Admin-only.** `knowledge_search` + all `/v1/knowledge/*` stay admin-tier, fail-closed. Only the owner's agent searches.
- **Lazy + resilient.** No subprocess until the first index-or-query; a dead child is respawned on the next `embed()`; `close()` on shutdown.
- **TDD**, `bun test <file>`; never `git add -A`; never touch package.json/bun.lock (revert bun bumps).

## Source of truth
Spec: `docs/superpowers/specs/2026-07-12-knowledge-agent-search-design.md`. Phase 0/1: `...knowledge-kernel-phase01-design.md`.

---

## Task 1: Embedder service

**Files:** Create `src/core/knowledge/embedder-service.ts` + `embedder-service.test.ts`.

**Interfaces (Produces):**
`makeEmbedderService(opts: { pythonBin: string; scriptPath: string; model_id: string; env?: Record<string,string>; timeoutMs?: number; makeRunner?: typeof makeEmbedRunner }): EmbedderService`
where `EmbedderService = { model_id: string; embed(texts: string[]): Promise<number[][]>; close(): Promise<void> }`.

**Consumes:** `makeEmbedRunner` from `./embed-runner` (returns `{ embed, close }`; injectable via `opts.makeRunner` for tests).

- [ ] Step 1 (failing test): inject a fake `makeRunner` that returns a runner whose `embed` records calls + returns a fixed vector per text and whose `close` is spied. Assert: (a) LAZY — constructing the service spawns nothing (`makeRunner` not called until first `embed`); (b) REUSE — two `embed()` calls use ONE runner (`makeRunner` called once); (c) RESPAWN — after a runner whose `embed` rejects with a "broken"/child-death error, the NEXT `embed()` calls `makeRunner` again (fresh runner) and succeeds; (d) `close()` calls the runner's `close`, and an `embed()` after close respawns; (e) `model_id` is exposed.
- [ ] Step 2: `bun test src/core/knowledge/embedder-service.test.ts` → FAIL.
- [ ] Step 3: implement — hold `let runner: ReturnType<typeof makeEmbedRunner> | null = null`. `embed(texts)`: if `!runner` build it via `(opts.makeRunner ?? makeEmbedRunner)({ pythonBin, scriptPath, model_id, env, timeoutMs })`; `try { return await runner.embed(texts) } catch (e) { /* drop the runner so the next call respawns */ runner = null; throw e }`. `close()`: if runner, `await runner.close(); runner = null`. `model_id` from opts. (Requests are already serialized inside `makeEmbedRunner`.)
- [ ] Step 4: PASS. [ ] Step 5: commit `feat(knowledge): singleton embedder service (lazy/respawn/close) (AS T1)`.

## Task 2: Bootstrap — share the service across indexer + query; close on shutdown

**Files:** Modify `src/daemon/bootstrap/index.ts` (the knowledge block + `runKnowledgeCycle`), `src/daemon/internal-api/types.ts` (add `embedder?` to `deps.knowledge`), `src/daemon/main.ts` (shutdown close). Test: `src/daemon/bootstrap.test.ts` + the cycle helper test.

- Construct `const embedder = makeEmbedderService({ pythonBin: <embedPythonBin>, scriptPath: <embedScriptPath>, model_id, env: { ...process.env, WXVAULT_STATE_DIR: join(deps.stateDir,'plugin-data','wxvault') } })` ONCE inside the `knowledge_enabled` block (only when `embedScriptPath` resolves).
- `runKnowledgeCycle`/the indexer call: replace the per-cycle `makeEmbedRunner(...)` + `finally close()` with `runIndexer({ store, embed: embedder.embed, model_id: embedder.model_id, model_version })`. The embedder is NOT closed per cycle (it's shared + long-lived).
- Wire `deps.knowledge = { store, search, embedder, embedQuery: (t) => embedder.embed([t]).then(v => v[0]) }` (extend the existing `deps.knowledge` object; keep `store`+`search`).
- Shutdown: `await bootRef?.knowledge?.embedder?.close?.()` in `main.ts`'s `shutdown()` (next to the store close).

- [ ] Steps: extend `types.ts` `knowledge?` to include `embedder?: EmbedderService` + `embedQuery?: (t: string) => Promise<number[]>`. Update the cycle helper unit test: indexer receives `embedder.embed` (assert the shared instance's model_id flows to putSemantic); the embedder is NOT closed between cycles; a second cycle reuses it. Bootstrap test: `deps.knowledge.embedder` present iff `knowledge_enabled` + script resolves. Run `bun test` on the touched suites → green; `bunx tsc --noEmit` clean. Commit `feat(knowledge): share one embedder service across indexer + query (AS T2)`.

## Task 3: Search route embeds the query

**Files:** Modify `src/daemon/internal-api/routes-knowledge.ts` (the `POST /v1/knowledge/search` handler). Test: `routes-knowledge.test.ts`.

- In the search handler: if `body.queryVector` is a non-empty array, use it (unchanged). Else if `deps.knowledge.embedder` (or `embedQuery`) present: `queryVector = await deps.knowledge.embedQuery(body.query)`; set `model_id = deps.knowledge.embedder.model_id` (ignore any caller `model_id`). Else → 400 `query_vector_required` (unchanged). Pass `queryVector` + `model_id` into `deps.knowledge.search(store, {...})`.

- [ ] Step 1 (failing test, extend routes-knowledge.test): with a fake `embedder` (`{ model_id:'m', embed: async ts => ts.map(()=>[...])}`) + `embedQuery` in `deps.knowledge` and a seeded store, `POST /v1/knowledge/search { query, limit }` (NO queryVector) → returns the seeded chunk, and the `model_id` used is the embedder's; an explicit `queryVector` still works; no embedder + no vector → 400. → FAIL → implement → PASS.
- [ ] Commit `feat(knowledge): /v1/knowledge/search embeds the query via the embedder service (AS T3)`.

## Task 4: `knowledge_search` MCP tool + admin gating + registration

**Files:** Create `src/mcp-servers/wechat/tools-knowledge.ts`; Modify `src/mcp-servers/wechat/main.ts` (register under `if (SESSION_IS_ADMIN)`), `src/core/user-tier.ts` (add `knowledge_search` to `ADMIN_ONLY` + classify `mcp__wechat__knowledge_search`). Test: `src/core/user-tier.test.ts`.

- `tools-knowledge.ts`: `registerKnowledgeSearchTool(server, client)` mirroring `registerSocialSeekTool` (`src/mcp-servers/wechat/tools-social.ts`): tool `knowledge_search`, inputSchema `{ query: z.string(), limit: z.number().optional(), conversation: z.string().optional() }`, calls `client.request('POST','/v1/knowledge/search', { query, limit, conversation })`, returns the result or `passthroughErrorResult(err,'knowledge_search')`. Chinese description ("语义检索你的微信消息历史…").
- `main.ts`: inside the existing `if (SESSION_IS_ADMIN) { ... }` block, `registerKnowledgeSearchTool(server, client)`.
- `user-tier.ts`: add `'knowledge_search'` to `ADMIN_ONLY`; add the classify line `if (sub === 'knowledge_search') return 'knowledge_search'` (before the fs_read catch-all), mirroring `social_seek`/`file_locate`.

- [ ] Step 1 (failing test, mirror the social_seek gating tests in `user-tier.test.ts`): `knowledge_search` allowed for admin, denied for trusted + guest; `classifyToolUse('mcp__wechat__knowledge_search') === 'knowledge_search'`. → FAIL → implement → PASS.
- [ ] Commit `feat(knowledge): knowledge_search MCP tool + admin-only gating (AS T4)`.

## Task 5: Re-add the prompt search bullet (gated on availability)

**Files:** Modify `src/core/prompt-builder.ts` (`knowledgeOrchestrationSection` or its caller `buildSystemPrompt`) + wherever bootstrap passes the plugin/knowledge signal into the prompt. Test: `src/core/prompt-builder.test.ts`.

- Route a `knowledgeSearchAvailable: boolean` signal from bootstrap (true when `knowledge_enabled` AND the session is admin — i.e. the tool is registered) into `knowledgeOrchestrationSection`. When true, render `- **消息检索**（\`knowledge_search\`）：语义找"那次聊到 X 的消息"。回溯具体对话用它。`. Do NOT key off the `wxsearch` plugin name (it no longer provides search). Find how `knowledgeOrchestrationSection` is called (grep `knowledgeOrchestrationSection(` in bootstrap/prompt assembly) and thread the flag.
- [ ] Step 1 (failing test): `knowledgeOrchestrationSection([...], { knowledgeSearchAvailable: true })` (new optional arg) contains `knowledge_search`; with it false, does NOT. Update the Phase-0/1 test that asserted `not.toContain('消息检索')` for the wxsearch-present case (that case had the flag false). → FAIL → implement → PASS.
- [ ] Commit `feat(knowledge): prompt advertises knowledge_search when available (AS T5)`.

## Task 6: VERIFY-AGAINST-REAL (controller/owner machine)

On the owner's machine with `knowledge_enabled` + wxsearch `.venv` built: restart the daemon; confirm one embedder subprocess serves both the indexer (BOOT log) and a `knowledge_search("...")` call from the agent that returns relevant real messages; verify the same `model_id` tags both indexed vectors and the query path (index and query in the same space). This is the acceptance gate — the kernel usable end-to-end by the agent.

## Self-review
- Spec coverage: embedder service (T1), shared across indexer+query + shutdown (T2), query-embedding route (T3), MCP tool + admin gating (T4), prompt (T5), real verify (T6). I2 closed (one model_id via the service in T2/T3); I3 closed (agent tool in T4 + prompt in T5).
- Type consistency: `EmbedderService` from T1 used in T2/T3 (`deps.knowledge.embedder`); `embedQuery` sig consistent T2↔T3.
