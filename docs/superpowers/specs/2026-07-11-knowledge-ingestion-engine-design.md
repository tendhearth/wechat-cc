# Design: Knowledge Ingestion Engine (unified person model — WRITE side)

Date: 2026-07-11
Status: approved design → implementation
Origin: the unified person model has a READ side (person_brief + knowledge-orchestration prompt — shipped) but **no WRITE side**. Diagnosis on the live machine: the daemon triggers ZERO knowledge builds; every store (wxgraph/wxsearch/wxfacts) was built by hand at different times and drifts stale; **wxfacts has never run — 0 facts / 0 watermarks across 102 contacts / 14,451 indexed messages.** So the core owns "read the knowledge" but not "build/keep the knowledge." This engine is the WRITE-side counterpart: a daemon background subsystem that keeps every knowledge source fresh from the decrypted messages — systematically, resumably, idle-gated. See [[architecture-direction-2026]].

> **2026-07-17 wxvault v1.3.2 update:** Step 1 below records the original design. On macOS,
> ordinary wxvault read tools now consume the current decrypted snapshot only; they do not trigger
> decryption. Refresh requires an explicit `sync_wechat_data` request or the desktop plugin button,
> and runs through an on-demand LaunchAgent with no schedule. The Windows backend retains its
> source-mtime-gated incremental refresh-on-read behavior.

## 1. What

A daemon background loop (`registerIngest`, peer of the existing companion push/introspect schedulers) that on each cycle brings the local knowledge base toward "caught up" from wxvault's decrypted output — WITHOUT any user-facing agent turn. Two mechanisms, both already in the codebase:

- **`createMcpToolBridge(specs)`** (`src/core/openai-mcp-bridge.ts`) — connects to a plugin's stdio MCP server and calls its tools **programmatically** (`.call(name, input) → text`, `.close()`). This is the data-plane: it drives the plugins' own builders/queries directly, no LLM, no agent turn.
- **`cheapEval(prompt) → text`** (`boot.registry.getCheapEval()`, already used by `runThreadsExtraction`) — pure text-in/text-out LLM. This is the only place an LLM is used: the **extraction judgment** for wxfacts.

The daemon owns orchestration; the LLM does only extraction reasoning; the bridge does all reads/writes. (This sidesteps the fact — confirmed in the seam map — that the codebase has no way to spawn a restricted-toolset "wxfacts-tools-only" agent turn; we never need one.)

## 2. The ingest cycle

One cycle = these steps in order, **each independently staleness-gated** so a nothing-changed cycle is just cheap status probes (no rebuild, no LLM):

1. **Read the current decrypted snapshot.** Bridge-call `wxvault.overview` (or `list_conversations`). On macOS this is read-only and does not re-decrypt changed WeChat libraries; a user must explicitly invoke `sync_wechat_data` (or the desktop sync button) before newly landed Mac data enters `out/decrypted/*.sqlite`. On Windows the backend may still perform a source-mtime-gated incremental refresh before returning the read.
2. **Deterministic refreshers** (bridge, no LLM). For each present + ready source, check its status tool, and only build if stale:
   - `wxgraph` — `graph_status` reports whether a rebuild is needed (it stores `source_max_mtime` in meta vs the decrypted output's mtime). If behind → `wxgraph.rebuild`.
   - `wxsearch` — status reports `vectors_stale` / new docs. If behind → `wxsearch.index_update` (the incremental indexer; NOT full reindex).
   - `wxmedia` — if new untranscribed voice/media exists → `wxmedia.voice_backfill` (bounded run).
3. **Extraction worker** (bridge + cheapEval, rate-bounded). Loop up to **N batches this cycle** (N = per-cycle cap):
   - `wxfacts.extraction_batch` (no `contact` arg → it auto-picks the most-backlogged contact) → `{batch_id, contact, msgs}` or `{done:true}`.
   - If `done` → backlog drained, stop the loop for this cycle.
   - Else `cheapEval(EXTRACTION_PROMPT + the messages)` → the model returns a JSON array of facts `{kind∈entity|relation|obligation|attribute|event, predicate, value, related_contact?, time_ref?, confidence∈low|med|high, source_msg_keys}`.
   - **Validate** the output (see §4). On valid → `wxfacts.record_facts(batch_id, facts)` (also advances the watermark). On unusable output → `record_facts(batch_id, [])` (advance past the bad batch, logged) so one bad window can't stall the contact forever. On model/network error → **do not** advance; break the loop and retry next cycle.

Over cycles the 102-contact backlog drains; then the worker stays incremental (watermarks make each batch pick up only new messages).

## 3. Triggers (idle cadence + new-message nudge)

- **Idle cadence.** A self-rescheduling `startCompanionScheduler` loop (same primitive as push/introspect), default interval **25 min**, 0.3 jitter, wrapped by the scheduler's bounded-tick timeout.
- **New-message nudge.** Hook the inbound-WeChat-message path (`src/daemon/inbound/*` / `ilink-glue.ts` where `messagesStore.append` records an inbound) to schedule a **debounced** ingest cycle (e.g. run once ~2 min after activity settles). New chat activity means the WeChat DB just grew → new data to fold in; this makes the knowledge base track conversations near-real-time instead of only on the 25-min tick. wxvault emits no push signal, so this inbound hook IS the "react to new messages" wiring.

Both paths funnel into the same guarded `ingestTick` (idempotent + idle-gated), so overlapping triggers are safe.

## 4. Bounds & safety

- **Idle-only.** Before doing work, the tick respects the same in-flight guard user turns use — `sessionManager.isInFlight` + `coordinator.runExclusive` (per-chat mutex). A real conversation preempts; ingestion never competes with a live turn. (Ingestion isn't chat-scoped, so it uses a dedicated lock key, e.g. `__ingest__`, and additionally skips a cycle if ANY chat is in-flight — extraction can wait.)
- **Rate-bounded.** Per-cycle extraction cap **N = 4 batches** (≈160 messages/cycle). Deterministic refreshers run at most once/cycle each. Bounded-tick timeout (scheduler default 11 min) caps a wedged cycle.
- **Resumable.** wxfacts watermarks (`extraction_state`) already make extraction resumable across cycles/restarts — no new progress state invented.
- **Output-validated extraction** (the memory-gardener lesson: an LLM refusal/garbage must never corrupt the store). cheapEval output must parse to a JSON array where each element has the required fact fields and a known `kind`; drop malformed elements. A wholesale parse failure or a refusal-shaped response → treat as "no facts" (advance watermark, log) rather than recording garbage. `record_facts` already carries provenance (`source_msg_keys`) + confidence, so recorded facts stay auditable.
- **Tolerates not-ready plugins.** `pluginMcpSpecs` only returns enabled+ready plugins; a source absent from the spec map (e.g. wxsearch NOT READY before wxvault output exists) is simply skipped this cycle — the engine degrades per-source, never crashes.
- **Enable gate.** Master gate = `CompanionConfig.enabled` AND `ingest_enabled !== false` (new optional flag, default true when companion is on — an independent off-switch since ingestion is silent maintenance, distinct from proactive-push which sends messages) AND not snoozed (`snooze_until`). Same `shouldRun` shape as push/introspect.

## 5. Wiring (seams, from the daemon-seam map)

1. **`ingestTick` body** in `src/daemon/wiring/tick-bodies.ts` (`buildTickBodies`) — has `TickDeps` (stateDir, boot→{registry.getCheapEval, sessionManager, coordinator}, log, …). It builds the bridge from `pluginMcpSpecs(loadPlugins({stateDir, bundledDir: bundledPluginsDir(), hostVersion}))` (re-run the pure disk scan — plugin specs aren't on `Bootstrap`) and runs §2.
2. **`registerIngest(deps)`** in `src/daemon/companion/lifecycle.ts` — wraps `startCompanionScheduler` with the 25-min interval; returns a `Lifecycle`.
3. **Deps + `shouldRun`** in `src/daemon/wiring/lifecycle-deps.ts` (`buildLifecycleDeps`) — mirror `companionPushDeps`, with the §4 enable gate.
4. **`lc.register(registerIngest(...))`** in `src/daemon/main.ts` next to the push/introspect registrations; plus the debounced inbound nudge wired into the inbound pipeline (a `nudge()` the scheduler exposes).
5. **Bridge reuse** — `createMcpToolBridge` is already exported and behavior-agnostic; import it directly (its `ToolSpec` typing is cosmetic for our `.call`-only use). Relocating it to a neutral module is optional and out of scope.

## 6. Non-goals

- No restricted-toolset agent-turn plumbing (the direct-bridge + cheapEval design makes it unnecessary).
- No new decryption path or wxvault push-signal (poke-via-read is sufficient).
- No new progress/watermark store (reuse each plugin's own).
- No change to person_brief / the READ side, the prompt sections, or tier gating.
- No desktop UI for ingest status (a later nicety; `extraction_status`/`graph_status` already exist for a future pane).
- Full reindex/rebuild-from-scratch remains a manual op; the engine only does incremental catch-up.

## 7. Testing

- **Ingest cycle (unit, bridge + cheapEval both faked)**: a fake bridge records calls + returns canned status/batches; a fake cheapEval returns canned facts JSON. Assert: (1) `overview` poked first; (2) a source reporting "stale" gets its builder called, a source reporting "fresh" does NOT; (3) extraction loops until `{done:true}` OR the N-batch cap, calling `record_facts` with the parsed facts; (4) malformed cheapEval output → `record_facts(batch_id, [])` (watermark advanced, nothing garbage recorded); (5) cheapEval throwing → loop breaks, watermark NOT advanced; (6) a source absent from the spec map is skipped (no crash).
- **Staleness gates**: fresh status ⇒ zero builder calls (cheap no-op cycle).
- **Enable gate / idle**: `shouldRun` false (disabled / snoozed / `ingest_enabled:false`) ⇒ tick body never runs; in-flight ⇒ cycle deferred.
- **Debounce**: rapid inbound nudges collapse to a single scheduled cycle.
- **Wiring**: `registerIngest` registered in main; full daemon suite + e2e green (e2e harness has no wx plugins ⇒ spec map empty ⇒ cycle is an inert no-op).
- **Live smoke** (real machine, manual): one forced cycle drains ≥1 wxfacts batch → `extraction_status` shows facts recorded → `person_brief` on that contact surfaces new facts/obligations.
