# Knowledge Kernel — graph layer in-process (Relay 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Migrate the graph layer into an in-process TS kernel module: enrich `source` to all message types + metadata, port wxgraph's closeness/edges/queries to TS reading source in-process, add graph Query routes + admin tools, retire the wxgraph plugin. Unblocks agent-social `discover` (rank_contacts).

**Architecture:** Source enrichment (adapter + `source.db` schema hold every message + `local_type`/`is_group`/`kind`/mentions). A pure-TS `graph.ts` (faithful port of `profile.py`/`edges.py`/`graph.py`) builds profiles+edges from source into `graph.db`, rebuilt on the knowledge cycle after the indexer. Query routes + admin agent tools mirror `knowledge_search`.

**Tech Stack:** TypeScript/Bun (`bun test`); the wxgraph plugin (Python) is retired in the sibling `wechat-cc-plugins` repo. Branch `feat/knowledge-graph-inproc` (base dev `ead34923`).

## Global Constraints
- **Faithful port — pin the numbers.** Port `profile.py`'s closeness EXACTLY: weights `{recency .35, volume .30, intimacy .20, reciprocity .15}`, GAP=6h initiations, TAU=90d recency decay, P95 normalization, `now` injected (no `Date.now()` in the pure builder). Tests must assert the numeric sub-scores + ranking match the Python on the same inputs — not just "runs".
- **Source stays immutable ground-truth.** Enrichment adds columns/rows; still write-once, idempotent on msg_key, cursor-incremental.
- **wxsearch unaffected** — it filters to text `kind`.
- **Admin-only** — graph Query routes + tools stay admin-tier, fail-closed (mirror knowledge_search).
- **TDD**; `bun test <file>`; never `git add -A`; never touch package.json/bun.lock.

## Source of truth
Spec: `docs/superpowers/specs/2026-08-12-knowledge-graph-inproc-design.md`. Port source: `wechat-cc-plugins/packages/wxgraph/wxgraph/{profile,edges,graph,source,store}.py` (read these — they're the reviewed algorithm).

---

## Task 1: Enrich the source layer (all messages + metadata)

**Files:** Modify `src/core/knowledge/store.ts` (SourceMsg + schema), `src/core/knowledge/source-adapter.ts` (ingest all messages). Tests: `store.test.ts`, `source-adapter.test.ts`.

- Extend `SourceMsg` + `source.db.messages`: add `local_type INTEGER`, `is_group INTEGER (0/1)`, `kind TEXT` (normalized). Add a `source_mentions(msg_key TEXT, target_un TEXT)` table (for @mention/refermsg edges).
- Port `wxgraph/source.py`'s `classify_type(local_type, content) → kind` (text/voice/call/image/transfer/redpacket/…) into a TS `classifyKind`. Adapter: stop filtering to `TEXT_TYPE===1` — ingest EVERY row; compute `kind`; set `is_group` from the conversation (session vs group — mirror wxgraph `source.iter_messages`'s is_session/group logic); for text keep the existing decode+prefix-strip (`text` empty for non-text kinds unless it has a text body); parse @atuserlist/refermsg targets → `source_mentions`.
- `listMessages` gains an optional `kind` filter (or the wxsearch indexer skips non-text `kind`); ensure the search indexer still only embeds text.
- [ ] Steps: failing tests first — adapter fixture with text + voice + transfer + a group msg + an @mention row → `source.db` has all with correct `kind`/`is_group`/mention rows; the text row still decoded/stripped; `listMessages(kind:'text')` returns only text. Store test: new columns round-trip. Implement; `bun test store.test.ts source-adapter.test.ts` + `bunx tsc --noEmit` green. Commit `feat(knowledge): enrich source — all message types + kind/is_group/mentions (GR T1)`.

## Task 2: `graph.ts` — profiles + closeness (the numeric port)

**Files:** Create `src/core/knowledge/graph-profiles.ts` + test. **Read `profile.py` in full first.**

- Port `build_profiles(messages, owner, now, weights)`: per-1:1-contact accumulation (sent/recv, transfer_in/out, per-kind type counts, initiations via >6h GAP, active_days, first/last ts, shared_groups from group speaker sets), then the sub-scores (recency = exp decay TAU=90d on last_ts vs now; volume = P95-normalized total; intimacy from voice+call+transfer `_n_int`; reciprocity from sent/recv balance) and the weighted `closeness`. Include `percentile`/P95 + `_clamp01` exactly. `now` + `weights` injected.
- Types: `Msg` (the shape build_profiles needs — `is_group, sender_un, conversation, ts, ltype, content, kind`), `Profile` (username + all sub-scores + counts).
- [ ] Steps: failing tests FIRST that pin the numbers — feed a small fixed message set + fixed `now`, assert the exact closeness sub-scores + the closeness value + the ranking match what `profile.py` produces for the same input (compute the expected values by hand / from the Python). Include: initiations gap boundary, P95 with 1 vs many contacts, recency decay, reciprocity balance, self-chat skip. Implement the port; `bun test` green; `bunx tsc --noEmit` clean. Commit `feat(knowledge): graph profiles + closeness port (numeric-faithful) (GR T2)`.

## Task 3: `graph.ts` — edges, owner, resolve_name, queries

**Files:** Create `src/core/knowledge/graph.ts` (+ test) consuming graph-profiles. **Read `edges.py` + `graph.py`.**

- Port `edges.py` `build_mention_edges` (mention edges from `source_mentions`; displayname collision → drop, never guess), `graph.py` `detect_owner` (owner = the non-session sender mode across 1:1 chats; `WXGRAPH_OWNER`/config override; warn if null), `resolve_name` (username-exact wins; display collision → return candidates), and the query fns `contact_profile`, `top_contacts` (by closeness/volume/recency/reciprocity/neglected), `rank_contacts` (topical/closeness ranking for discover), `relationship_subgraph`, `connectors`.
- [ ] Steps: failing tests (owner detection; resolve_name collision→candidates; mention edge collision→drop; top_contacts sort orders; connectors shared-group+mutual-mention). Implement. Green + tsc clean. Commit `feat(knowledge): graph edges/owner/resolve/queries port (GR T3)`.

## Task 4: graph store + rebuildGraph + cycle wiring

**Files:** Modify `src/core/knowledge/store.ts` (add `graph.db` handle + graph store methods: `rebuildGraph(profiles, edges, displayMap, owner, now, watermark)`, `getContact`, `allContacts`, `edgesFor`, graph meta) — OR a new `graph-store.ts`. Create `src/core/knowledge/graph-build.ts` (`rebuildGraph({ sourceStore, graphStore, now, ownerOverride })` — reads source via the store in-proc, builds profiles+edges, writes graph). Modify `bootstrap/index.ts` (call `rebuildGraph` in `runKnowledgeCycle` after the indexer, gated on knowledge_enabled; gate the rebuild on source watermark advancing). Tests: store + build + cycle.
- [ ] Steps: failing tests (rebuild writes contacts+edges+meta; incremental skips when no new source; owner override). Implement; green + tsc clean. Commit `feat(knowledge): graph store + rebuild + cycle wiring (GR T4)`.

## Task 5: Query routes + agent tools + prompt

**Files:** Modify `routes-knowledge.ts` (add graph query routes, admin), `types.ts` (`deps.knowledge.graph?`), Create `src/mcp-servers/wechat/tools-graph.ts` (admin tools mirroring tools-knowledge), Modify `main.ts` (register under SESSION_IS_ADMIN), `user-tier.ts` (gate the new tool kinds admin-only), `prompt-builder.ts` (re-add the wxgraph 关系画像 bullet gated on availability — it currently keys off the `wxgraph` plugin name which is being retired; switch to the daemon-graph-available signal). Tests: routes-knowledge.test, user-tier.test, prompt-builder.test.
- [ ] Steps: mirror the `knowledge_search` pattern end-to-end (route 503-when-unwired, admin tier, tool double-gated, prompt gated on availability). Green + tsc clean. Commit `feat(knowledge): graph Query routes + admin tools + prompt (GR T5)`.

## Task 6: Retire the wxgraph plugin (plugins repo)

**Files (wechat-cc-plugins):** remove wxgraph's build/query MCP tools + its `..` source read + sidecar (or retire the package like wxsearch's indexing role); update its manifest; drop `wxgraph` from the host's `KNOWN_KNOWLEDGE_PLUGINS` if that gated the old bullet. Note: `wxfacts`/`wxperson` still import from `wxgraph` (sibling coupling) — check `wxfacts`/`wxperson` don't break; if they read wxgraph's store, leave the minimal Python read-path until their own slices, OR point them at the daemon (document the interim). Keep tests green with the venv python.
- [ ] Steps: retire the tools; verify `wxfacts`/`wxperson` suites still pass (or the interim coupling is documented); commit in plugins repo `feat(wxgraph): retire in favor of the daemon in-proc graph (GR T6)`.

## Task 7: VERIFY-AGAINST-REAL (owner machine)

On real source: rebuild graph → `top_contacts`/`contact_profile` match the old wxgraph output on the same data (owner inferred = the real wxid, closeness ordering plausible, transfers/calls counted), entirely off `..`. Acceptance gate.

## Self-review
- Coverage: source enrichment (T1), closeness numeric port (T2), edges/owner/resolve/queries (T3), store+rebuild+cycle (T4), routes+tools+prompt (T5), retire plugin (T6), real verify (T7). Unblocks agent-social discover via rank_contacts (T3/T5).
- Risk: T2 numeric fidelity — tests pin the exact values, not just execution.
- Interim: wxfacts/wxperson still couple to wxgraph until their slices (T6 documents it).
