# Memory-infra Phase 2a — hearth federated query — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). **CROSS-REPO:** Tasks 1–3 are in the `ggshr9/hearth` repo (clone at `/private/tmp/claude-501/-Users-nategu-mac-company-Documents-wxvault/96e8faa0-41a2-456b-88da-94b4b9e44cd8/scratchpad/hearth`; branch off `main` — independent of the Phase-1 `feat/channel-submit-apply` branch); Task 4 is in `wechat-cc` (branch `feat/hearth-federate-phase2a`, base dev `df06d6bf`); Task 5 spans both. Each repo commits to its own git.

**Goal:** hearth's own query can route a question to registered external sources and merge their cited answers with its local vault answers — each hit labeled with WHO verified it — proving federation with wechat-cc as the first source, without copying the raw messages into the vault.

**Architecture:** hearth (server-only today) gains: an extended `QueryHit` (`origin`/`verified_by`), a `~/.hearth/sources.json` registry, a minimal MCP **client** (to call a source's query tool), and a `federatedQuery` router (local `query()` + fan-out + flat merge + fail-open) exposed via `vault_query` with an opt-in `federate` flag (default OFF = today's pure-local behavior). wechat-cc adds one admin `federated_query` MCP tool that reshapes its kernel search into hearth-compatible hits. Federated hits are `verified_by:'wechat-cc'`, never run through hearth's local verifier.

**Tech Stack:** Both repos Bun + TypeScript, MCP via `@modelcontextprotocol/sdk` (hearth already depends on it; the `Client` + `StdioClientTransport` classes are available for the new client). hearth clone at `scratchpad/hearth`.

## Global Constraints
- **"Doesn't fabricate" is inviolable.** Default `vault_query` (federate off) MUST be byte-for-byte the same pure-local behavior as today. Federated hits MUST be unmistakably labeled `origin:'federated', verified_by:'<source>'` and MUST NOT enter `buildClaimIndex`/`verifyClaim` (hearth can't verify them; running the verifier would mark them broken). hearth relays a source's cited answer; it never presents it as vault-verified.
- **Fail-open:** a federated source that throws/times out drops ITS hits + logs; the local vault answer still returns. A federation failure never breaks a query.
- **Privacy:** raw wechat messages never enter the vault and never leave wechat-cc; only the source's cited answer text crosses, per question. State it in code comments at the seam.
- **Personal-scale, lightweight:** a small custom router + per-query connect/close MCP client; NO gateway/RBAC/namespacing machinery. `federated_query` is admin-gated on the wechat-cc side (it exposes the owner's message knowledge).
- **TDD**; `bunx tsc --noEmit` clean per repo; never `git add -A`; never touch package.json/bun.lock; commits end `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Source of truth
Spec: `docs/superpowers/specs/2026-08-13-hearth-federate-phase2a-design.md`. hearth (read in clone): `src/core/query.ts` (`QueryHit`/`QueryResult`/`query()`/`NO_ANSWER`), `src/core/citations.ts` (`buildClaimIndex`/`ClaimRecord` — do NOT feed federated hits here), `src/mcp-server.ts` (`vault_query` handler ~:218 + ListTools + how `ctx` is threaded; also the H1 `stateDirFor(ctx)`/`ServerContext` pattern for `~/.hearth`). wechat-cc: `src/core/knowledge/search.ts` (`semanticSearch` + `SemanticSearchResultItem` `{conversation,sender,time,type,text,score}`), `src/mcp-servers/wechat/tools-knowledge.ts` (`knowledge_search` registration — mirror for `federated_query`), `src/core/user-tier.ts` + `src/daemon/internal-api/routes-knowledge.ts` (admin gating pattern).

---

## Task 1: [hearth · HF1] extend QueryHit + source registry

**Repo/dir:** `scratchpad/hearth` (branch off `main`: `git checkout main && git checkout -b feat/federate-query`). **Files:** `src/core/query.ts` (extend `QueryHit`), new `src/core/source-registry.ts` (+ tests wherever hearth tests live, e.g. `tests/`).

- **Extend `QueryHit`** with `origin: 'vault' | 'federated'` and `verified_by: 'vault' | string`. In `query()`, every local hit gets `origin:'vault', verified_by:'vault'` (backward-compatible additive change; existing callers/tests still typecheck — the fields are always present with the vault defaults).
- **`source-registry.ts`**: `export interface FederatedSource { id: string; description?: string; transport: { kind: 'stdio'; command: string; args?: string[]; env?: Record<string,string> }; query_tool: string }` + `export function loadSources(stateDir?: string): FederatedSource[]` — read `<stateDir ?? ~/.hearth>/sources.json` (a JSON array); missing file → `[]`; malformed → `[]` + a logged warning (fail-safe, never throw). Validate each entry has id + transport.command + query_tool; drop invalid entries.
- [ ] Steps: failing tests — `query()` local hits now carry `origin:'vault'/verified_by:'vault'`; `loadSources` reads a temp `sources.json` (valid entries parsed, invalid dropped, missing file → `[]`, malformed JSON → `[]` no-throw). Implement. Run hearth tests + typecheck green. Commit (hearth repo) `feat(federate): QueryHit origin/verified_by + source registry (HF1)`.

**Interfaces produced:** `QueryHit` with `origin`/`verified_by`; `FederatedSource`, `loadSources(stateDir?)`.

---

## Task 2: [hearth · HF2] minimal MCP client to a federated source

**Repo/dir:** `scratchpad/hearth` (same `feat/federate-query` branch). **Files:** new `src/core/federated-client.ts` (+ test).

- Using `@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport` (already a dep — check `node_modules`/existing imports for the exact import paths), implement:
  ```ts
  export async function queryFederatedSource(
    source: FederatedSource, question: string,
    opts?: { timeoutMs?: number; makeClient?: (s: FederatedSource) => Promise<{ call(tool: string, args: unknown): Promise<string>; close(): Promise<void> }> },
  ): Promise<QueryHit[]>
  ```
  Spawn the source's stdio server (`transport = new StdioClientTransport({ command, args, env })`), `client.connect(transport)`, `client.callTool({ name: source.query_tool, arguments: { question } })`, read the text content, `JSON.parse` it as `{ hits: Array<{ claim_text, source, anchor_summary?, confidence?, match_score? }> }`, map each into a full `QueryHit` tagged `origin:'federated', verified_by: source.id` (defaulting missing confidence→'low', anchor_summary→'', match_score→0). ALWAYS close the client/transport (finally). A timeout (default ~5s) or ANY error → return `[]` (fail-open) — never throw. Inject `makeClient` for tests (fake source, no real spawn).
- [ ] Steps: failing tests (fake `makeClient`): a source returning well-formed hits → mapped `QueryHit[]` all tagged `origin:'federated', verified_by:source.id`; a malformed/error result → `[]` (no throw); a throwing/hanging client → `[]` + client closed. Implement. Green + typecheck. Commit `feat(federate): minimal MCP client for federated sources (HF2)`.

**Interfaces produced:** `queryFederatedSource(source, question, opts?) → QueryHit[]`.

---

## Task 3: [hearth · HF3] query router + federated-aware vault_query

**Repo/dir:** `scratchpad/hearth` (same branch). **Files:** `src/core/query.ts` (add `federatedQuery`), `src/mcp-server.ts` (`vault_query` gains `federate`). Tests: query + mcp-server.

- **`export async function federatedQuery(vaultRoot: string, question: string, opts?: { stateDir?: string; limit?: number; minScore?: number; queryFn?; sourceQueryFn? }): Promise<QueryResult>`**: run the existing sync `query(vaultRoot, question, {limit,minScore})` → local hits (origin vault). Then `loadSources(opts.stateDir)`; for each source `await queryFederatedSource(source, question)` (via the injectable `sourceQueryFn` seam for tests) → federated hits; **flat-merge**: concat local + all federated, sort by `match_score` desc (local scores are 0–1 fractions; federated `match_score` should already be 0–1 from the source — clamp/normalize to [0,1]), keep the top `limit*`(a slightly larger cap, e.g. `limit + sources*limit`, or just return all — 2a: return local (≤limit) + up to `limit` per source, don't drop federated to fit the local cap). `no_answer_message` stays `NO_ANSWER`; `hits` empty only when BOTH local and every source are empty. A source error is already swallowed to `[]` by HF2 — the router just concats.
- **`vault_query` MCP tool** (`mcp-server.ts`): add optional `federate: boolean` (default **false**) to its inputSchema. `federate !== true` → the EXISTING pure-local `query(ctx.vaultRoot, question)` path, UNCHANGED. `federate === true` → `await federatedQuery(ctx.vaultRoot, question, { stateDir: stateDirFor(ctx) })`. Audit either way.
- [ ] Steps: failing tests — `federatedQuery` merges local + a fake source's hits into one `QueryResult` (each hit's `origin`/`verified_by` correct; sorted; both-empty → NO_ANSWER; a source returning [] contributes nothing but local still returns; ordering local-vs-federated deterministic); the `vault_query` handler with `federate:false`/omitted is byte-identical to today (a test asserts no source calls happen), with `federate:true` returns merged labeled hits. Implement. Green + typecheck. Commit `feat(federate): federatedQuery router + vault_query federate flag (HF3)`.

**Interfaces produced:** `federatedQuery(vaultRoot, question, opts?)`; `vault_query({ question, federate? })`.

---

## Task 4: [wechat-cc · WF1] federated_query MCP tool

**Files:** Create `src/mcp-servers/wechat/tools-federated.ts` (mirror `tools-knowledge.ts`); modify `src/mcp-servers/wechat/main.ts` (register under `SESSION_IS_ADMIN`), `src/core/user-tier.ts` (+ `federated_query` ToolKind → ADMIN_ONLY + classifyToolUse), `src/core/claude-agent-provider.ts` (`TOOL_KIND_TO_CLAUDE_BUILTINS` entry — exhaustive `Record<ToolKind>`). Route: reuse the existing `/v1/knowledge/search` (or add a thin `/v1/knowledge/federated_query` that returns the reshaped hits) — prefer reshaping in the tool from the existing search route to avoid a new route. Tests: tools/tier tests.

- The tool `federated_query({ question })` (admin-gated, mirrors `knowledge_search`'s double-gate) calls the knowledge search (embed query + `semanticSearch`) and reshapes each `SemanticSearchResultItem` `{conversation,sender,time,text,score}` into a hearth-compatible hit:
  `{ claim_text: text, source: 'wechat:' + conversation, anchor_summary: <ISO or human time from `time`>, confidence: score>0.66?'high':score>0.33?'medium':'low', match_score: clamp01(score) }` → return `{ hits: [...] }`. (Reuse the exact retrieval `knowledge_search` uses; only the output shape differs.)
- [ ] Steps: failing tests — `federated_query` reshapes a fixture search result into valid hits (claim_text/source/anchor/confidence/match_score); admin-gated (non-admin denied, mirror knowledge_search gating tests); no-match → `{hits:[]}`. `bunx tsc --noEmit` clean (the `Record<ToolKind>` exhaustiveness is the compile gate). Green. Commit `feat(memory): federated_query MCP tool — wechat-cc as a hearth source (HF W1)`.

---

## Task 5: [both repos · VF] VERIFY-AGAINST-REAL

**File:** `scratchpad/hearth-federate-verify.ts`.

- Real hearth vault with a couple of Phase-1-ingested pages (or hand-add a vault page with a verified claim). Write `~/.hearth/sources.json` (temp stateDir) registering wechat-cc's MCP server + `federated_query`. Real wechat kernel (openKnowledge + adapter + graph + indexer with the cached bge model if available, else structured-only). Start/point wechat-cc's MCP server so hearth can spawn it.
- Ask hearth `federatedQuery(vaultRoot, "<a topic both a vault page AND wechat messages answer>")` (or `vault_query({federate:true})` over MCP) → assert the merged `QueryResult` contains BOTH a vault hit (`origin:'vault', verified_by:'vault'`) AND a wechat-cc federated hit (`origin:'federated', verified_by:'wechat-cc'`), each with a citation — over the real MCP round-trip. Confirm the raw messages are NOT in the vault. And `federate:false` returns only the vault hit (unchanged).
- [ ] Step: write + run. Acceptance: hearth returns merged, correctly-labeled local + federated results on real data over real MCP; raw stays in wechat-cc; federate-off unchanged. (Harness not committed; needs HF1-3 + WF1.)

## Self-review
- Coverage: QueryHit+registry (HF1), MCP client (HF2), router+tool (HF3), wechat-cc source tool (WF1), real verify (VF). Proves federation with per-hit verification labels + fail-open + privacy.
- Risk: the honesty default (federate off = unchanged, federated hits labeled + kept out of the verifier); fail-open on source failure; cross-repo (hearth branch off main + its own PR).
- Non-goals: multi-source/richer merge/freshness/caching (2b); permission broker (Phase 3); no gateway/RBAC.
