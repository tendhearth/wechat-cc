# Memory-infra Phase 1 — wechat-cc ingests distilled knowledge into hearth (over MCP) — Design

**Date**: 2026-08-13
**Status**: Design draft (brainstorm 2026-08-13); user review next.
**Cross-repo**: touches `wechat-cc` (this repo) + `ggshr9/hearth` (a small MCP addition). North star + full rationale: memory note `hearth-memory-infra`.

## The direction (context)

"Memory" is being split out of wechat-cc into a standalone infrastructure product — which already exists as [`ggshr9/hearth`](https://github.com/ggshr9/hearth) (agent-native markdown-vault governance: Ingest/Query/Lint, ChangePlan + permission + claim-level citations + audit, vendor-neutral over MCP). wechat-cc stops trying to *be* a memory store and becomes a **channel/province**: it feeds distilled wechat knowledge INTO hearth and (Phase 2) federates its wechat-native structured lens. The two stay **independent** (hearth depends on nobody; wechat-cc *optionally* uses hearth, feature-detected) but compose 1+1>2 (wechat-cc gives hearth its richest channel; hearth gives wechat-cc's agent whole-vault memory + a governed durable home for wechat knowledge).

Phasing by readiness: **Phase 1 = Ingest** (near — hearth's ingest path is purpose-built for wechat-cc) → Phase 2 = Federate (hearth-side new work) → Phase 3 = permission broker (coarse all-local-trust until then). **This spec is Phase 1.**

## Goal

wechat-cc pushes its **distilled** wechat knowledge (the owner's social-state digest that `knowledge-distill` already produces for `knowledge.md`) into hearth's vault as a **governed ChangePlan**, over the **MCP boundary**, applied under **owner-channel authentication** — proving the "wechat → shared vault" pipe end-to-end with loose, optional coupling. Raw messages stay in wechat-cc (that's Phase 2 federation); only the distilled digest crosses.

## Why this exact shape (grounded in hearth's real contracts)

Read from hearth `0317ac0` (v0.4):
- **hearth's MCP ingest tool `vault_plan_ingest` runs the `mock` adapter** (`mcp-server.ts:222`, "mock for v0.4; real Claude later") → it produces trivial pages, NOT real distillation. And **`vault_apply_change` requires a human approval token** (`REQUIRES_HUMAN_APPROVAL`). So the *stock* MCP surface can't do a good, owner-authenticated ingest today.
- **But wechat-cc already HAS the structured knowledge** (facts / graph / obligations via the in-proc kernel) and already distills it deterministically (`knowledge-distill.ts`). So wechat-cc should **produce the ChangePlan itself** (no LLM, no hearth re-distillation) and hand hearth a finished plan to **govern + apply**. hearth's kernel still enforces everything that matters (plan validation, path-escape guard, preconditions/base_hash, citation verification, audit).
- The pieces to do this already exist inside hearth as functions — they're just not exposed over MCP: `validateChangePlan()` (`core/plan-validator.ts:92`), `PendingStore.save(plan)` (`core/pending-store.ts:23`), `applyForOwner()` (`runtime.ts:433`, channel-ownership = auth, **no token**). So the hearth addition is small: **expose a channel-trusted submit+apply path over MCP.**

Decision recap (from brainstorm): **MCP boundary** (loose/optional/vendor-neutral), not `import` (compile-time coupling); **wechat-cc owns distillation**, hearth owns governance; **prebuilt ChangePlan**, not `source_text`→hearth-LLM.

## Scope

### A. hearth side (small — in the `ggshr9/hearth` repo)

Add two MCP tools to `src/mcp-server.ts` (reusing existing kernel functions; no new subsystems):

1. **`vault_plan_submit`** — in `{ change_plan: ChangePlan, origin?: string }` → `{ change_id, risk, ops, requires_review }`. Runs `validateChangePlan(change_plan, { schema, vaultRoot })` then `PendingStore.save()`. **Does NOT run an adapter** (the plan is pre-built by a trusted channel). Same validation/audit as any plan; never writes the vault.
2. **`vault_apply_for_owner`** — in `{ change_id, owner_id, channel }` → `ApplyForOwnerResult`. Thin MCP wrapper over the existing `applyForOwner()` (channel-ownership is the auth; **no human token**). Respects `requires_review`/risk: a `requires_review: true` (high-risk) plan is NOT auto-applied — it returns a "needs review" result the channel surfaces (Phase 1 leaves high-risk plans pending; low/medium auto-apply for the owner).

(These are generic — any trusted first-party channel can use them, not wechat-specific. hearth stays channel-neutral.)

### B. wechat-cc side (this repo)

1. **A hearth MCP client, feature-detected + optional.** New config `hearth_enabled` / `hearth_vault` (path) [+ how to reach hearth's `hearth mcp serve`]. wechat-cc already has MCP-client machinery (`createMcpToolBridge` / the companion-ingest bridge) — reuse it to connect to hearth's stdio MCP server. **If hearth is not configured or unreachable → wechat-cc keeps its current local `knowledge.md` behavior unchanged** (this is the independence guarantee: wechat-cc runs fully without hearth).
2. **A distill→ChangePlan builder.** Reuse `distillOwnerKnowledge` (in-proc facts/graph/obligations → the social-state digest). Wrap its output into a hearth `ChangePlan`:
   - one `create` op for a **source page** `raw/wechat/social-state.md` = the digest markdown (the thing citations anchor to), with YAML frontmatter (channel/generated_at).
   - one `create|update` op for a **concept page** (e.g. `wechat/social-state.md`) whose frontmatter `claims:` list anchors each assertion to the source page with `{ type:'line', line_start, line_end, quote, quote_hash: sha256(quote) }` (hearth v0.1 only verifies `type:line` anchors — so use line anchors). `precondition.base_hash` = sha256 of the current target (or `exists:false` for create).
   - Deterministic: built from the structured digest, no LLM.
3. **Push flow** (on the same tick that writes `knowledge.md` today, when hearth is enabled): `vault_plan_submit(plan)` → `vault_apply_for_owner(change_id, owner, 'wechat')` for low/medium risk; log + skip (leave pending) on high-risk or any error. Never block the ingest tick (throw-safe, like the existing distill call).
4. **Keep `knowledge.md` too** (Phase 1): still write the local digest as today. Phase 1 *adds* the hearth push; it doesn't remove the local behavior (de-risk: the two coexist until federate/Query proves hearth is the durable home).

## Architecture

wechat-cc's daemon (already has the in-proc kernel + MCP-client bridge) connects to a local hearth MCP server as an optional downstream. The **ingest bundle** wechat-cc submits is self-contained: a source digest page + a concept page citing it — so hearth's citation verification (`quote` must exist in the cited source + `quote_hash` matches) passes without wechat-cc needing to reach back into raw messages. **Provenance depth (Phase 1):** citations anchor to the *distilled digest*, and the digest text embeds the underlying `msg_key`s as prose; anchoring a claim directly to the *original wechat message* is deferred (needs Phase-2 federation / the raw source in the vault). Governance (validation, preconditions, audit) is 100% hearth's; distillation is 100% wechat-cc's; they meet only at the two MCP tools.

**Independence, concretely:** hearth has zero knowledge of wechat-cc (generic tools); wechat-cc treats hearth as an optional, feature-detected sink with a full local fallback. Either ships and runs alone.

## Verification
- **hearth tools (unit, hearth repo):** `vault_plan_submit` validates + queues a well-formed plan and rejects a path-escaping / precondition-drifted one (reuses `validateChangePlan` tests); `vault_apply_for_owner` applies a low-risk owner plan without a token, and leaves a `requires_review` plan pending.
- **wechat-cc distill→ChangePlan (unit):** `distillOwnerKnowledge`'s digest → a valid `ChangePlan` with a source page + a concept page whose `claims:` line-anchors have `quote_hash === sha256(quote)` and quotes that exist in the source page. Feature-detect off → no hearth calls, `knowledge.md` still written.
- **VERIFY-AGAINST-REAL (owner machine):** with the cloned hearth as a real vault + real wechat kernel: distill real social-state → submit → apply-for-owner → the hearth vault contains the source + concept pages, and `hearth query "<a real fact>"` returns a **citation-grounded** hit anchored to the ingested page — entirely over MCP, no import. And with `hearth_enabled=false`, wechat-cc behaves exactly as today.

## Non-goals (later phases)
- **Federate / Query** (wechat-cc's kernel answering hearth queries) — Phase 2 (needs hearth's new query-router + source-registry).
- **Permission broker** (per-consumer × per-source scope + audit beyond hearth's existing) — Phase 3; Phase 1 is owner-channel-trust.
- **Deep provenance** (claims anchored to original wechat messages, not the digest) — needs the raw source in-vault / federation.
- **Rich concept decomposition + MOC + dedup/merge** into many wiki pages — Phase 1 ingests a single source+concept pair; hearth's claude adapter (or a richer wechat-cc distiller) can decompose later.
- **In-wechat review UX** (render the ChangePlan in a wechat chat, approve there) — the tools support it (`renderPlanMarkdown` exists); wiring the interactive approval into a wechat chat is a follow-on. Phase 1 auto-applies low/med-risk owner plans.

## Risks
- **Cross-repo change** — the hearth tools land in the hearth repo; keep them generic (channel-neutral) so hearth stays vendor-neutral and the change is upstreamable.
- **Coupling creep** — resist letting wechat-cc reach into hearth internals; it must talk ONLY through the two MCP tools + fall back cleanly when hearth is absent.
- **Citation honesty** — Phase 1 anchors to the digest, not raw messages; the spec/pages must not overclaim message-level provenance.
