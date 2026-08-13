# Memory-infra Phase 1 — wechat-cc ingests into hearth (over MCP) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). **CROSS-REPO:** Task H1 is in the `ggshr9/hearth` repo (clone at `/private/tmp/claude-501/-Users-nategu-mac-company-Documents-wxvault/96e8faa0-41a2-456b-88da-94b4b9e44cd8/scratchpad/hearth`); Tasks W1–W4 are in `wechat-cc` (branch `feat/hearth-ingest-phase1`, base dev `2ddd5daf`). Each repo commits to its own git.

**Goal:** wechat-cc distills its wechat knowledge into a hearth `ChangePlan` and pushes it over hearth's MCP boundary — hearth governs (validate/apply/audit/citations), wechat-cc owns distillation. Feature-detected + optional (wechat-cc runs unchanged when hearth is absent).

**Architecture:** hearth gains two generic MCP tools (`vault_plan_submit`, `vault_apply_for_owner`) that accept a channel-produced ChangePlan and apply it under channel-ownership auth (no human token), reusing existing kernel functions. wechat-cc spawns `hearth mcp serve` as an optional stdio MCP subprocess, builds a ChangePlan from `distillOwnerKnowledge`'s digest, and pushes submit→apply on the ingest tick; if hearth is unconfigured/unreachable it keeps writing `knowledge.md` exactly as today.

**Tech Stack:** Both repos Bun + TypeScript, MCP via `@modelcontextprotocol/sdk`. hearth clone at `scratchpad/hearth` (commit `0317ac0`).

## Global Constraints
- **Independence:** hearth has ZERO wechat-cc knowledge (tools are channel-generic). wechat-cc treats hearth as optional: `hearth_enabled` off / unreachable → the existing local `knowledge.md` path is unchanged. Never let wechat-cc reach hearth internals — only the two MCP tools.
- **hearth governs, wechat-cc distills:** wechat-cc produces the ChangePlan (no LLM); hearth's kernel still runs `validateChangePlan` (path-escape, preconditions/base_hash) + citation verification + audit. Don't bypass hearth's validation.
- **Citation honesty (Phase 1):** claims anchor to the *distilled digest* page (line anchors, `quote_hash=sha256(quote)`, hearth v0.1 verifies only `type:'line'`); do NOT claim message-level provenance. msg_keys ride as prose in the digest.
- **Throw-safe:** the hearth push runs on the ingest tick; a failure logs + falls back, never breaks the tick (mirror the existing `distillOwnerKnowledge` try/catch at `tick-bodies.ts:246-252`).
- **TDD**; `bunx tsc --noEmit` clean per repo; never `git add -A`; never touch package.json/bun.lock/lockfiles; commits end `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Source of truth
Spec: `docs/superpowers/specs/2026-08-13-hearth-ingest-phase1-design.md`. hearth contracts (read in the clone): `src/mcp-server.ts` (ListTools array + `CallToolRequestSchema` handler), `src/core/plan-validator.ts:92` (`validateChangePlan(raw,{schema,vaultRoot})`), `src/core/pending-store.ts` (`PendingStore.save/load`), `src/runtime.ts:433` (`applyForOwner(changeId,{vaultRoot,channel,ownerId,hearthStateDir?})`), `src/core/types.ts` (`ChangePlan`/`ChangeOp`/`Claim`/`Anchor`), `src/core/citations.ts` (`quote_hash`). wechat-cc: `src/core/openai-mcp-bridge.ts` (`McpStdioSpec`, `createMcpToolBridge`, `.call`), `src/daemon/companion/config.ts` (config), `src/daemon/companion/knowledge-distill.ts` (`distillOwnerKnowledge`), `src/daemon/wiring/tick-bodies.ts:246-252` (the distill call site).

---

## Task 1: [hearth repo · H1] `vault_plan_submit` + `vault_apply_for_owner` MCP tools

**Repo/dir:** `scratchpad/hearth` (its own git; branch e.g. `feat/channel-submit-apply`). **Files:** `src/mcp-server.ts` (+ tool tests wherever hearth tests live — check `src/*.test.ts` / `test/`).

- **`vault_plan_submit`**: inputSchema `{ required:['change_plan'], properties:{ change_plan:{type:'object'}, origin:{type:'string'} } }`. Handler: `const plan = validateChangePlan(req.params.arguments.change_plan, { schema: loadSchema(ctx.vaultRoot), vaultRoot: ctx.vaultRoot })` (throws → return the `PLAN_VALIDATION_FAILED` error shape the other tools use); `const path = new PendingStore(join(hearthStateDir,'pending')).save(plan)`; return `{ change_id: plan.change_id, risk: plan.risk, ops: plan.ops.length, requires_review: plan.requires_review }`. Audit `mcp.tool_called`. NEVER writes the vault. (Mirror how `vault_plan_ingest` is registered + audited, minus the adapter.)
- **`vault_apply_for_owner`**: inputSchema `{ required:['change_id','owner_id','channel'], properties:{ change_id:{type:'string'}, owner_id:{type:'string'}, channel:{type:'string'} } }`. Handler: load the plan; **if `plan.requires_review` (high-risk) → return `{ ok:false, requires_review:true, change_id, rendered:'high-risk plan left pending for review' }` WITHOUT applying**; else `return await applyForOwner(change_id, { vaultRoot: ctx.vaultRoot, ownerId: args.owner_id, channel: args.channel })`. This is the existing channel-ownership-auth apply — no token.

- [ ] **Step 1:** Read hearth's `mcp-server.ts` ListTools array + the `CallToolRequestSchema` handler + one existing tool (`vault_plan_ingest`, `vault_apply_change`) to match the exact registration + error-shape + audit conventions. Note where `ctx.vaultRoot` / `hearthStateDir` come from.
- [ ] **Step 2:** Write failing tests (match hearth's test style/runner): `vault_plan_submit` validates + queues a well-formed plan (returns change_id, plan lands in PendingStore) and rejects a path-escaping plan (`PLAN_VALIDATION_FAILED`); `vault_apply_for_owner` applies a low-risk owner plan (vault file written, plan removed from pending, audit `changeplan.applied` with `initiated_by: channel:*`) and leaves a `requires_review:true` plan pending (vault untouched).
- [ ] **Step 3:** Add both tools (ListTools entries + handler branches). Run tests + `bunx tsc --noEmit` (or hearth's typecheck) green.
- [ ] **Step 4: Commit (hearth repo)** `feat(mcp): channel-trusted vault_plan_submit + vault_apply_for_owner (wechat-cc ingest Phase 1)`. (Push to `ggshr9/hearth` is a separate human-authorized step — leave on the branch.)

**Interfaces produced (W tasks consume via MCP):** tool `vault_plan_submit({change_plan, origin?}) → {change_id, risk, ops, requires_review}`; tool `vault_apply_for_owner({change_id, owner_id, channel}) → {ok, change_id, ops_applied?, requires_review?, rendered, error?}`.

---

## Task 2: [wechat-cc · W1] optional hearth MCP client + config

**Files:** Modify `src/daemon/companion/config.ts` (add `hearth_enabled: boolean` + `hearth_vault: string | null` + optional `hearth_cmd`); Create `src/daemon/companion/hearth-client.ts` (+ test).

- Extend `CompanionConfig` + its defaults: `hearth_enabled` (default false), `hearth_vault` (default null), `hearth_cmd` (default null → derive `hearth mcp serve`).
- `hearth-client.ts`: `export async function connectHearth(cfg): Promise<HearthClient | null>` — if `!cfg.hearth_enabled || !cfg.hearth_vault` → return null (feature-off). Else build an `McpStdioSpec` (command/args = the hearth `mcp serve` entry from `hearth_cmd`, env `{ HEARTH_VAULT: cfg.hearth_vault }`) and `createMcpToolBridge({ hearth: spec }, {log})`; on connect failure (spawn/listTools throws) → log + return null (unreachable = graceful off). Expose `HearthClient` = `{ submit(plan): Promise<{change_id, requires_review}>, applyForOwner(changeId, ownerId, channel): Promise<{ok, requires_review?}>, close(): Promise<void> }`, each parsing the bridge's `.call(tool, input)` JSON-text result.
- [ ] Steps: failing tests (with a fake bridge injected: `hearth_enabled:false` → `connectHearth` returns null; enabled + fake bridge → `submit`/`applyForOwner` call the right tool names with the right args and parse results; a throwing bridge → null, no throw). Implement (reuse `createMcpToolBridge`; inject a `makeBridge?` seam for tests). `bun test` + `bunx tsc --noEmit` green. Commit `feat(memory): optional hearth MCP client + config (HI W1)`.

**Interfaces produced:** `connectHearth(cfg) → HearthClient | null`; `HearthClient.{submit, applyForOwner, close}`.

---

## Task 3: [wechat-cc · W2] distill → hearth ChangePlan builder

**Files:** Create `src/daemon/companion/hearth-plan.ts` (+ test).

- `export function buildHearthPlan(digest: string, now: number): ChangePlan` where `digest` is `distillOwnerKnowledge`'s markdown (the social-state digest) and `ChangePlan`/`ChangeOp`/`Claim`/`Anchor` are typed to MATCH hearth's `src/core/types.ts` (define a local mirror type in `hearth-plan.ts` — do NOT import from the hearth repo; keep the boundary at MCP). Build:
  - `change_id` = `wechat-social-state-<now>` (stable-ish; `now` injected).
  - one `create` op for the **source page** `raw/wechat/social-state.md` — body = the digest (+ a small YAML frontmatter `channel: wechat`, `generated_at`), `precondition:{exists:false}` (or `update` with `base_hash` if you also read current — Phase 1: create/replace), `patch:{type:'replace', value:<full page>}`.
  - one `create` op for the **concept page** `wechat/social-state.md` — body = a short markdown rendering of the digest PLUS YAML frontmatter `claims:` where each salient line of the digest becomes a `Claim { text, source:'raw/wechat/social-state.md', anchor:{ type:'line', line_start, line_end, quote:<the exact digest line>, quote_hash: sha256(quote) }, confidence:'high' }`. **`quote` MUST be the exact substring present in the source page** (so hearth's verify passes) and `quote_hash === sha256(quote)`.
  - `source_id` = `sha256(digest)`; `risk:'low'`; `requires_review:false`.
- `sha256` — **MUST match hearth's `src/core/hash.ts` exactly: `'sha256:' + createHash('sha256').update(s).digest('hex')` (the `sha256:` PREFIX is required)**. hearth's `verifyClaim` recomputes with the prefixed helper and does a strict `===` on `quote_hash`; bare hex → 100% `hash_mismatch`. Use the prefixed form for BOTH `quote_hash` and `source_id`.
- [ ] Steps: failing tests — given a fixed digest with 2-3 lines, `buildHearthPlan` yields a plan with the source op + concept op; every `claims[].anchor.quote` is a verbatim substring of the source page body AND `quote_hash === sha256(quote)`; line_start/line_end point at the right lines; `source_id === sha256(digest)`. Implement. `bun test` + `bunx tsc --noEmit` green. Commit `feat(memory): distill → hearth ChangePlan builder (HI W2)`.

**Interfaces produced:** `buildHearthPlan(digest, now) → ChangePlan` (local mirror type).

---

## Task 4: [wechat-cc · W3] wire the hearth push into the ingest tick

**Files:** Modify `src/daemon/wiring/tick-bodies.ts` (the distill block ~`:241-253`). Test: extend the ingest-tick / a focused hearth-push test.

- After the existing `distillOwnerKnowledge(deps.boot.knowledge)` produces `digest` and writes `knowledge.md` (UNCHANGED), add — inside the same `try` or a sibling throw-safe block: `const hearth = await connectHearth(loadCompanionConfig(deps.stateDir))`. If `hearth` (non-null) AND `digest`: `const plan = buildHearthPlan(digest, Date.now()); const { change_id, requires_review } = await hearth.submit(plan); if (!requires_review) { const r = await hearth.applyForOwner(change_id, ownerChat, 'wechat'); deps.log('INGEST', ...) } else { deps.log('INGEST', 'hearth: plan requires review, left pending '+change_id) } await hearth.close()`. Wrap in try/catch → `deps.log('INGEST', 'hearth push failed: '+err)`; NEVER rethrow (tick must survive). `owner`/`ownerChat` is the same `ownerChat` the distill block already computes.
- **Guard:** all of this runs ONLY when `connectHearth` returns non-null (feature-on + reachable). Feature-off → zero behavior change (knowledge.md path exactly as today).
- [ ] Steps: failing test — with a fake `connectHearth` returning a fake HearthClient, the tick calls `submit` then `applyForOwner('wechat')` with the built plan for a low-risk digest, and logs; a `requires_review` plan is left pending (no apply); `connectHearth`→null leaves the tick's knowledge.md behavior untouched and makes no hearth calls; a throwing hearth client doesn't break the tick. Implement (inject the `connectHearth`/`buildHearthPlan` seams for the test). `bunx tsc --noEmit` + `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts` green. Commit `feat(memory): push distilled knowledge to hearth on the ingest tick (HI W3)`.

---

## Task 5: [both repos · W4] VERIFY-AGAINST-REAL (owner machine, both repos)

**File:** `scratchpad/hearth-ingest-verify.ts`.

- Use the real hearth clone as a live vault: point `HEARTH_VAULT` at a fresh temp vault (run hearth's `adopt`/`setup` or hand-create `SCHEMA.md` + `raw/`), start `hearth mcp serve` (or drive the tools in-process). Real wechat kernel: `openKnowledge` + adapter + graph (as in prior verify harnesses) → `distillOwnerKnowledge` real digest → `buildHearthPlan` → `vault_plan_submit` → `vault_apply_for_owner('wechat')`.
- Assert: the temp vault now contains `raw/wechat/social-state.md` + `wechat/social-state.md`; run hearth's `query "<a real fact from the digest>"` (or `vault_query`) and confirm a **citation-grounded** hit anchored into the ingested page (claim verifies: quote present + hash matches). Then set `hearth_enabled:false` and confirm the tick still writes `knowledge.md` and makes no hearth calls.
- [ ] Step: write + run (`bun scratchpad/hearth-ingest-verify.ts`). Acceptance: real distilled wechat knowledge lands in a real hearth vault as a governed, citation-verified page over MCP; hearth-off = unchanged wechat-cc. (Harness not committed; needs H1 merged into the hearth clone.)

## Self-review
- Coverage: hearth tools (H1), optional client+config (W1), digest→ChangePlan (W2), tick wiring (W3), real verify (W4). Proves the ingest pipe with loose/optional coupling.
- Risk: W2 citation correctness (quote must be a verbatim source substring + hash match — hearth rejects otherwise); independence (W1/W3 must no-op cleanly when hearth is off); cross-repo (H1 in hearth's git, its own push).
- Non-goals unchanged: federate/Query (P2), permission (P3), deep msg-level provenance, rich concept decomposition, in-wechat interactive review.
