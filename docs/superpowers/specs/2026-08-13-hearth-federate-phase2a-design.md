# Memory-infra Phase 2a — hearth federated query (wechat-cc as first federated source) — Design

**Date**: 2026-08-13
**Status**: Design draft (brainstorm 2026-08-13); user review next.
**Cross-repo**: `ggshr9/hearth` (the bulk — query router + source registry + MCP client) + `wechat-cc` (a federated-query MCP tool). Builds on Phase 1 (`hearth-ingest-phase1`, merged wechat-cc dev `df06d6bf`; hearth branch `feat/channel-submit-apply`). North star: memory note `hearth-memory-infra`.

## Our goal (anchor — read first)

hearth = the standalone personal-memory front door; wechat-cc = a **province** that keeps its wechat-native structured lens and answers **federated queries** about its own territory. Phase 1 proved INGEST (wechat-cc distills → hearth vault). Phase 2a proves **FEDERATE**: hearth's own `query()` can route a question to registered external sources (wechat-cc's kernel), which answer with their own citations, and hearth **merges** those with its local vault answers — so any agent asking hearth can reach the owner's wechat knowledge WITHOUT that knowledge being copied into the vault. The roles flip from Phase 1: here **hearth is the MCP client**, the source is the server.

**Stay grounded, don't cargo-cult.** Mature products validate the shape (below), but this is **personal scale**: a lightweight custom router + a handful of sources + local trust — NOT an enterprise gateway/RBAC. Borrow the ideas, not the weight.

### Prior-art validation (sharpening, not templating)
- **Glean** attaches provenance + **verification state** + freshness + scope to *facts*, not just documents — this is exactly our (A): each hit carries who verified it. Confirmed by the mature enterprise-search leader.
- **GoSearch's federated-first hybrid** = *index shared knowledge for speed, federate sensitive data in-place to avoid copying/PII exposure* — literally our ingest(distilled)+federate(raw 25k messages) split.
- **Federated RAG** (privacy-critical domains) = *retrieve across sources without sharing raw data* — our "raw stays in wechat-cc, only cited answers cross" is that pattern.

## The honesty constraint (hearth's core personality — must not break)

hearth's `query()` today answers ONLY from the **verified** claim index (`buildClaimIndex(vaultRoot).verified()`) and says the literal `"no answer found in vault"` otherwise — its whole point is **"doesn't fabricate."** Federation must preserve this. hearth **cannot verify** a federated source's content (the 25k messages aren't in the vault). Therefore (decision **A**, brainstorm-approved):

> A federated hit is **verified by the SOURCE, not by hearth**. hearth surfaces it clearly labeled `origin: 'federated', verified_by: '<source-id>'` — it is transparently *routing*, never *vouching*. Local hits stay `origin: 'vault', verified_by: 'vault'`. hearth never runs `verifyClaim` on federated content and never presents a federated hit as vault-verified.

This keeps "doesn't fabricate" intact: hearth still never invents an answer; it either has a vault-verified claim, or it faithfully relays a source's own cited answer with the label that it's the source's word.

## Scope

### A. hearth side (the bulk — in `ggshr9/hearth`)

1. **Extend `QueryHit`** (`src/core/query.ts`) with two fields (backward-compatible; local hits default them):
   - `origin: 'vault' | 'federated'`
   - `verified_by: 'vault' | string` (a source id for federated)
   (Optionally a `freshness?`/`scope?` later — 2b; keep 2a to origin+verified_by.)
2. **Source registry** — a small config of registered federated sources, in hearth state (`~/.hearth/sources.json`), each: `{ id, description, transport: { kind: 'stdio', command, args?, env? }, query_tool: string }`. Read-only for 2a (no dynamic registration UI). No secrets beyond what the transport needs.
3. **hearth MCP client** (NEW — hearth is server-only today, `mcp-server.ts:472`) — a minimal stdio MCP client (the `@modelcontextprotocol/sdk` `Client` hearth already depends on) that connects to a source's server, calls its `query_tool({ question })`, parses the returned hits, and closes. Per-query connect+close is fine at personal scale (few sources, low frequency); a connection cache is a 2b optimization.
4. **Query router** — `federatedQuery(vaultRoot, question, opts)`: run the existing local `query()` (→ vault-verified hits, tagged `origin:'vault'`), THEN for each registered source call it over the MCP client, tag each returned hit `origin:'federated', verified_by: source.id`, and **flat-merge** into one `QueryResult` (concat; local + federated; normalize `match_score` to a common 0–1 scale; a source failure/timeout drops that source's hits + logs, never breaks the whole query — fail-open on the local answer). The `"no answer found in vault"` message is returned ONLY when BOTH local and every federated source yield nothing.
5. **Federated-aware MCP tool** — either extend `vault_query` (add an opt-in `federate: true`, default off to preserve today's pure-local behavior) or add `vault_query_federated({ question })`. Returns the merged `QueryResult` with the new `origin`/`verified_by` on each hit. Audited.

### B. wechat-cc side (this repo)

1. **A federated-query MCP tool** — e.g. `federated_query({ question })` in the wechat MCP server, **admin-gated** (it exposes the owner's message knowledge, exactly like `knowledge_search`). It wraps the in-proc kernel search (`semanticSearch` over messages, + optionally facts/graph) and returns **hearth-compatible hits**:
   ```
   { hits: [ { claim_text, source, anchor_summary, confidence, match_score } ] }
   ```
   where `claim_text` = the relevant message/fact text, `source` = a wechat locator (e.g. `wechat:<conversation>` or the `msg_key`), `anchor_summary` = a human ref (e.g. the message timestamp), `confidence`/`match_score` from the search. This is mostly RESHAPING the existing `knowledge_search`/`semanticSearch` output into hearth's `QueryHit` shape — no new retrieval.
2. Register it in hearth's `~/.hearth/sources.json` (a setup/doc step) pointing at wechat-cc's MCP server + this tool name.

## Architecture

hearth becomes a **query-federation layer** (Glean/GoSearch shape), not a generic MCP-tool aggregator: it doesn't re-expose wechat-cc's tools; it fans its OWN `query()` out to sources and merges results with per-hit verification labels. Transport is MCP (hearth-as-client). **Privacy guarantee (state it explicitly):** the raw 25k messages never enter hearth's vault and never leave wechat-cc; only wechat-cc's own cited answer text crosses, in response to a specific question. This is the federated-RAG privacy pattern.

## Verification
- **hearth (unit):** `QueryHit` gains `origin`/`verified_by` (local hits default vault/vault); the router merges a fake federated source's hits (tagged federated/`<id>`) with local hits into one ranked `QueryResult`; a source that throws/times out is dropped (local answer still returned); `"no answer"` only when both empty; extending/adding the MCP tool returns the labeled hits; the plain `vault_query` (federate off) is byte-for-byte unchanged (honesty-preserving default).
- **wechat-cc (unit):** `federated_query` reshapes `semanticSearch` results into valid `QueryHit`s (claim_text/source/anchor/confidence/score), admin-gated (non-admin denied), returns `{hits:[]}` on no match.
- **VERIFY-AGAINST-REAL (owner machine, both repos):** register wechat-cc as a source in a real hearth vault (that also has a couple of ingested Phase-1 pages). Ask hearth a question that both a vault page AND wechat messages answer → the merged result contains a **vault hit labeled `verified_by:'vault'`** AND a **wechat-cc hit labeled `origin:'federated', verified_by:'wechat-cc'`**, each with its citation — over the real MCP round-trip (hearth spawning/þcalling wechat-cc's MCP tool). Confirm the raw messages are NOT in the vault. And `vault_query` without federation is unchanged.

## Non-goals (later)
- **Phase 2b:** multiple federated sources, richer cross-source merge/rank (beyond flat + score-normalize), connection caching, `freshness`/`scope` fields + staleness surfacing.
- **Phase 3:** the permission broker — per-consumer × per-source scope + audit (who may federate/consume what). 2a is local-trust (any local caller of hearth reaches the registered sources); the `verified_by`/`scope` groundwork is laid but not enforced.
- **No enterprise gateway/RBAC/namespacing-heavy machinery** — personal-scale lightweight router only.
- No change to hearth's local `query()` algorithm (keyword-over-verified-claims) — federation wraps it, doesn't replace it.

## Risks
- **Don't break "doesn't fabricate":** the default `vault_query` must stay pure-local; federated hits must be unmistakably labeled as source-verified, never merged in a way that looks vault-verified. The honesty property is the crux — tests must pin the labeling + the federate-off default.
- **hearth-side MCP client lifecycle** — connect/close per query must be clean (no orphaned child processes); a source failure must fail-open (local answer survives).
- **Cross-repo** — the hearth router/registry/client land in the hearth repo (its own branch/PR); wechat-cc only adds one admin tool.
- **Citation semantics** — a federated hit's `source`/`anchor` point into wechat-cc (not the vault); hearth must not attempt to `verifyClaim` them (would mark them broken). Keep federated hits out of `buildClaimIndex`/the local verifier entirely.
