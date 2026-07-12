# wechat-cc — System Architecture

> Single source of truth for the whole system. Synthesized 2026-07-11 from an evidence-based
> sweep of all five layers (file:line anchors throughout). Before this, the architecture lived
> only in code + memory + ~40 per-feature specs; this doc is the map. Keep it current.

---

## 0. Thesis — why this exists

A **companion** that reaches you where you already are (WeChat), runs its own agent loop, and
keeps your data on your machine. The moat is **real-chat-access × own-loop × data-sovereignty** —
not "memory" (that's commoditized). Everything below serves that: local-first, self-hosted, the
knowledge built from your own decrypted chat history, never leaving the box.

Two provider families express the strategy: **wrap** an existing subscription harness for raw
capability (Claude Code, Codex), **self-build** the loop for the companion/differentiation tier
(OpenAI-compatible APIs). The desktop app is the "unconstrained surface" that transcends WeChat's
limits (real voice conversation); WeChat is the funnel.

---

## 1. One-screen overview

```
                 ┌───────────────────────── channels (turn entries) ─────────────────────────┐
   WeChat  ──────│ long-poll → inbound pipeline (17 mw) ─┐                                     │
   Desktop app ──│ internal-api /converse → companionConverse ─┤  all serialize per chatId    │
   Companion tick│ scheduler → dispatchToChat ─────────────────┘  (async-mutex.runExclusive)  │
                 └──────────────────────────────┬──────────────────────────────────────────────┘
                                                ▼
                              ConversationCoordinator.dispatchInner
                                  getMode(chatId) → solo | primary_tool | parallel | chatroom
                                                ▼
                              SessionManager.acquire(provider, alias, chatId)
                                  → AgentProvider.spawn() → AgentSession.dispatch()
                     ┌──────────────┬──────────────┬──────────────┬──────────────┐
              claude(wrap)   codex(wrap)   cursor(wrap)   gemini(self)   openai(self)
                     └──────────────┴──────────────┴──────────────┴──────────────┘
                                                ▼  agent calls `reply` MCP tool
                              internal-api POST /v1/wechat/reply
                                  reply-sink open? → capture (app turn)   else → ilink → WeChat

   Knowledge (built from the user's decrypted WeChat vault, all LOCAL):
     wxvault(decrypt, hidden) → wxgraph/wxfacts/wxsearch/wxmedia (sources) → wxperson.person_brief (assemble)
     ingestion engine (daemon) drives the WRITE side; prompt sections drive the READ side

   Memory (daemon-side, .md + sqlite): profile/persona/agenda/notes(.md) + events/observations/
     threads/messages(sqlite) + gardener/synthesis(_overview.md, _profile.json)
```

**The core abstraction is `session ≠ channel`.** One owner session, keyed by
`(provider, projectAlias, chatId)`, is reachable through three turn-entry channels that all
converge on one coordinator and one per-chat mutex. Reply delivery is redirected transparently by
a per-chat **reply-sink** (app captures the reply) vs the ilink transport (WeChat sends it).

---

## 2. The five layers

### 2.1 Provider layer — `src/core/*-agent-provider.ts`

The one genuinely-unifying abstraction is the **event stream**: every provider funnels its native
runtime into `AgentEvent` (`text|tool_call|init|result|error`, `agent-provider.ts:33`) and takes a
`SpawnContext` (`:95`, tier/permission/chatId/model/appendInstructions). `ProviderCapabilities`
(`:186`) declares per-provider traits (`perToolCallback`, `sandboxLevels`, `supportsDelegation`,
`supportsResume`, `defaultPeer`).

| Provider | Family | Wraps | Loop owner | cheapEval | delegation |
|---|---|---|---|---|---|
| claude | **wrap** | `@anthropic-ai/claude-agent-sdk` | SDK | ✅ haiku | peer + target |
| codex | **wrap** | `@openai/codex-sdk` (Thread) | SDK | ✅ | target |
| cursor | **wrap** | `@cursor/sdk` (optional dep) | SDK | ❌ | ❌ |
| gemini | **self-built** | `@google/genai` (raw) | **us** (`runDispatchLoop`) | ✅ | ❌ |
| openai | **self-built** | any OpenAI-compat (DeepSeek/Kimi/Qwen) | **us** (`makeOpenAiSession`) | ✅ +strong | target |

Registry (`provider-registry.ts`) is per-daemon (not singleton); `ProviderId` is an open string;
`getCheapEval()` walks a hardcoded cost order `['openai','claude','codex','gemini']`. Selection: a
chat's persisted `Mode` → `providerId` → `SessionManager.acquire` keyed by `provider|alias|chatId`.

**Shared:** `AgentEvent`/`SpawnContext`/`ProviderCapabilities`, `collectTurn` (turn aggregation +
watchdog), `mergeEnvIntoMcpServers`, `assertNotAuthFailed`, `isReplyToolCall`.
**Not shared (re-implemented 5×):** the entire session/event-translation loop, cancel/close
teardown, tier→SDK translation, and the MCP stdio spec type (4 near-identical shapes).

### 2.2 Channel / Session / Turn layer

**Turn lifecycle** (`conversation-coordinator.ts`, `inbound/`, `reply-sinks.ts`):
- **WeChat**: `poll-loop` (turn runs *inline* in the poll loop, `poll-loop.ts:353`) → 17-mw onion
  pipeline (`inbound/build.ts:42`, order is load-bearing: access-gate before side-effects, dedup
  wraps the turn, guard-before-permission) → terminal `mw-dispatch` → `coordinator.dispatch`.
- **App**: `companionConverse` (`pipeline-deps.ts:388`) opens a reply-sink, calls `dispatchInner`
  directly (not `dispatch` — self-deadlock), returns the captured text.
- **Tick**: `dispatchToChat` (`tick-bodies.ts:243`) drives `SessionManager.acquire` directly under
  `runExclusive`.

**Serialization**: `makeChatMutex().runExclusive(chatId, fn)` (`async-mutex.ts`, poison-proof
tail-chain). All three entries take the **same per-chat lock**. **Chatroom is exempt** — it has its
own abort-based preempt protocol (latest-message-wins), and routing it through the mutex would break
that (verified empirically, comment `conversation-coordinator.ts:863`).

**Modes**: `solo | primary_tool | parallel(/both) | chatroom(/chat)` (`mode-commands.ts`).
`primary_tool` ≈ solo at dispatch (peer reached via a pre-loaded `delegate_<peer>` MCP tool).
Participants capped at 3; degrade to solo when <2 resolve.

**Auth** (`internal-api/`): 127.0.0.1-only HTTP callback for the stdio MCP subprocesses. Two gates:
tier (`guest<trusted<admin`, unlisted routes fail-closed to admin) + `routeAllow` (route-scoping).
Three token origins: **file** (shell-readable ⇒ capped at trusted), **session** (minted, carries
the real tier + sessionKey), **operator** (admin but route-scoped to converse/speak/transcribe — so
the desktop app reaches admin `/converse` without widening the shared token). Well-reasoned
defense-in-depth.

### 2.3 Wiring / Boot / Scheduler layer

**Boot** is one linear numbered sequence in `main.ts:bootDaemon` (~250 lines): instance-lock (health-
aware, can steal from a wedged holder) → shared singletons (`chatPrefs`/`careLedger`/`replySinks` —
must be one instance for write-through cache coherence) → **(1)** internal-api → **(2)** bootstrap →
**(3)** wireMain → **(4)** register lifecycles (LIFO teardown) → **(5)** startup sweeps. Atomic:
any failure calls `shutdown()`.

**Circular construction** is broken three ways: raw `let bootRef/ticksRef=null` thunks, typed
`Ref<T>`/`wireRef` (fail-fast), and ad-hoc `setX` setters on internal-api. `wireMain`
(`wiring/index.ts`) splits into `tick-bodies` / `pipeline-deps` / `lifecycle-deps` / `side-effects`
— by lifetime/consumer, load-bearing (each has real branching logic).

**Schedulers** (`companion/scheduler.ts`, `lifecycle.ts`): recursive `setTimeout` (settle-then-rearm)
with jitter + a `shouldRun()` gate + an 11-min bounded-tick watchdog. Three: push (20m), introspect
(24h), ingest (25m + trailing-debounced inbound nudge). The *send* decision is a deeper gate
(`calibration.shouldSpeak` + `careLedger`), separate from "does the tick run."

### 2.4 Store / Memory / Knowledge layer

Three physically separate tiers:
- **A — Daemon SQLite** (`src/lib/db.ts`, v1–v15): `messages` (bot-chat log only), `threads`
  (LLM-extracted topics), `observations` (introspect notes, 30d TTL), `milestones`, `events`
  (decision log), + operational (session_state, dedup, heartbeat). JSON sidecars: `care_ledger`,
  `garden_state`.
- **B — Daemon `.md` memory** (`<stateDir>/memory/<chatId>/`): `profile.md` ("你眼中的 ta",
  injected as core memory), `persona.md`, `agenda.md`, `notes/`, synthesized `_overview.md` +
  `_profile.json`. Agent-authored via `memory_write`; curated by the gardener; sandboxed
  (`memory/fs-api.ts`).
- **C — Plugin knowledge SQLite** (`wechat-cc-plugins`, Python, reads the **raw decrypted vault** —
  the user's *entire* WeChat history): `wxfacts` FactStore (claims/obligations),
  `wxgraph` GraphStore (relationship stats), `wxsearch` IndexStore (FTS5 + embeddings).
  `wxperson.person_brief` fans them into one view at read-time.

**Designed boundary (crisp):** `.md` = the bot's *subjective take*; plugins = *objective derived
data*; the agent fuses them at prompt time (`brief.py:1` "DATA ONLY, does NOT read .md";
`prompt-builder.ts:346/509`).

### 2.5 Deployment / Runtime topology

- **Daemon**: one Bun process (`cli.ts run`, in-process, no fork). Supervised per-OS
  (`service-manager.ts`): macOS LaunchAgent (`KeepAlive=true`), Linux systemd `--user`
  (`Restart=always`), Windows ScheduledTask. Single-instance O_EXCL pidfile + health-heartbeat
  steal. State in `~/.claude/channels/wechat/`.
- **Desktop app**: Tauri v2, vanilla-JS frontend, ships a **compiled sidecar** `wechat-cc-cli`
  (bun `--compile`, 74 MB) — does NOT embed the daemon; drives `service install/start/stop` and
  reaches the running daemon via `internal-api-info.json` (loopback port + two token files). MIT +
  a Pro tier (Lemon Squeezy, `license.json`).
- **Plugins**: discovered from bundled `<repoRoot>/plugins/` (default enabled) + user
  `<stateDir>/plugins/` (default disabled). First-party are **dev symlinks** into the sibling repos;
  the marketplace (`catalog.ts`, git-clone-from-registry) is built but `registry.json` is empty.
  `wxsearch`/`wxmedia` need Python 3.10+ ⇒ each owns a per-plugin `.venv` built live at setup.
- **Voice**: STT is now **local** (`wxmedia/stt_server.py` on 127.0.0.1:8001, faster-whisper,
  OpenAI-shaped); TTS is **remote** (VoxCPM2 on a VPS, `brain.youdamaster.cc/voice`). Both configured
  at runtime via `stt-config.json`/`voice-config.json`; no defaults, no host in code.
- **Repos**: `wechat-cc` (daemon+app) · `wechat-cc-plugins` (knowledge) · `wxvault` (decrypt). Bound
  only by symlink + `minWechatCcVersion` — no submodule, no pinned SHA, versions drift.

---

## 3. Key flows

**A turn (WeChat):** message → poll-loop parse → pipeline (trace→identity→access→dedup→…→dispatch)
→ `coordinator.dispatch` → `runExclusive(chatId)` → `dispatchInner` → mode → `SessionManager.acquire`
→ `provider.spawn().dispatch(text)` → agent calls `reply` tool → `POST /v1/wechat/reply` → (no sink)
→ ilink chunks + sends to WeChat.

**A knowledge-ingest cycle (daemon, 25m or inbound-nudge):** idle-gated `ingestTick` → resilient
per-plugin MCP bridge → poke wxvault (incremental re-decrypt) → source-mtime-gated builders
(wxgraph rebuild / wxsearch index / wxmedia transcribe) → wxfacts extraction (`extraction_batch` →
`cheapEval` → `record_facts`, bounded + watermark-resumable).

**A voice loop (app):** mic → `MediaRecorder` → `agent_transcribe` (Rust) → `POST /v1/companion/
transcribe` → local STT → text → converse → reply → `agent_speak` → `POST /v1/companion/speak` →
remote TTS → audio played.

---

## 4. Cross-cutting themes — what's actually going on

The system's **abstractions are clear and intentional**; the debt is not random. It is the
signature of fast, organic growth, and it clusters into four recurring patterns:

1. **Correctness enforced by convention, not by types.** The load-bearing invariants live in
   comments + runtime throws, not in the type system. A new author must *know*: to take
   `runExclusive` with the right entrypoint (dispatch vs dispatchInner), that chatroom is exempt,
   the boot statement order, which of three late-bind mechanisms to use, which of four gates decides
   a tick. Nothing structural prevents getting it wrong.

2. **Parallel implementations breed duplication.** Five hand-rolled session loops; four identical
   MCP-spec types; three auth-fail regexes; three late-bind mechanisms; two LLM-extraction pipelines
   (daemon `threads` vs plugin `wxfacts`); two whole-person synthesizers.

3. **"Unified X" is assembled at read-time only, never merged at write-time.** `person_brief`
   (plugin data) and `_overview.md`/`_profile.json` (daemon .md) are **two disjoint person models**
   from non-overlapping sources that never reconcile. The "unified person model" is unified only in
   the agent's prompt, not in any artifact.

4. **One first-class thing; everything else impersonates it.** WeChat/ilink is the only real
   channel — the app channel fabricates an `InboundMsg` and borrows ilink account routing; the reply
   route returns `ilink_not_wired` even for a pure-app turn. And the daemon installs cleanly while
   the plugin/voice periphery is still author-workstation-shaped.

---

## 5. Debt register (prioritized)

Ranked by **impact × reach**. Each is real and evidenced; none is a fire.

| # | Debt | Layer | Why it matters | Direction |
|---|---|---|---|---|
| **D1** | **Fragmented person model** — `person_brief` (plugin) vs `_overview.md`/`_profile.json` (daemon) never merge; two extraction pipelines (`threads` vs `wxfacts`) with no shared vocab/join key | Store | The *product thesis* is "coherent knowledge of each person" — currently there are two half-views. Directly undercuts the moat | **CORE ADDRESSED 2026-07-12.** (1) always-on: `knowledge-distill.ts` distills the owner's plugin knowledge → `knowledge.md`, injected beside `profile.md` (`knowledgeMemorySection`). (2) synthesized: `synthesizeOverview` now folds `knowledge.md` in as a 社交侧 category → `_overview.md` is plugin-aware (the actual "one canonical, other feeds it" merge). **Remaining (lower priority):** chatId↔wxid is a fuzzy display-name match across id spaces (`@i` vs `@openim`) — per-contact enrichment only fires when a contact chats the bot directly; `threads` vs `wxfacts` serve different corpora/subjects (bot-chats vs whole vault) so reconciliation is likely not a merge but a cross-reference — deferred as not-clearly-worth-it |
| **D2** | **Plugin/voice deployment is author-shaped** — dev symlinks, empty registry, live-built venvs into read-only bundle dirs, unsupervised local STT, hand-typed VPS URL, POSIX-only ML | Deploy | Blocks anyone but you from running the full stack; the `.app` can't actually deliver wxsearch/wxmedia/voice | Decide: is the knowledge stack a shipped product or a power-user add-on? Then either productize (populate registry, venv→dataDir, supervise STT) or scope it explicitly as dev-only |
| **D3** | **Turn-serialization invariant is convention, not structure** — 3 callers must each remember runExclusive + dispatch-vs-dispatchInner; chatroom exempt; reply-sink keys only on chatId; reply route guest-tier | Channel | The single most fragile seam; a future turn-entry author can silently reintroduce a race | **CORE DONE 2026-07-12** (conversation-actor pattern — borrowed from Durable Objects + voice-agent turn-taking; spec `2026-07-12-turn-entry-unification-design.md`): one `coordinator.submitTurn(chatId, {within})` entrypoint owns the lock + dispatch; `turnPolicy(mode)` makes queue-vs-preempt explicit (chatroom=preempt = the shape voice barge-in needs); `companionConverse` moved onto it; **`dispatchInner` is now private** — the bare-callable turn path is eliminated, invariant enforced by types not comments. **Deferred to the phone build:** the channel-neutral `{text, source}` input (so app/phone stop fabricating a WeChat InboundMsg) + a voice `preempt` mode — both plug into `submitTurn`/`turnPolicy`. The tick keeps `runExclusive` for its own SessionManager dispatch (legit, not a dispatchInner bypass) |
| **D4** | **Provider layer re-implements the loop 5×** — no shared session-loop helper; auth-fail 3×; tier→SDK + MCP-spec per-provider | Provider | Every provider fix/feature is done N times; gemini is a second-class self-built citizen | Extract a shared `event-stream session` helper; one `McpStdioSpec`; one auth-fail source. (gemini→agy/Antigravity still deferred per memory) |
| **D5** | **Boot/wiring ceremony** — 250-line `bootDaemon` god-function holds ordering implicitly; 3 late-bind mechanisms; a new feature touches 5–8 wiring files; ingest gating across 4 gates in 3 files | Wiring | High cognitive load; "why didn't this tick fire?" has no single answer | Consolidate to one late-bind mechanism (Ref); a `registerBackgroundFeature()` helper to collapse the 5-file thread; co-locate a feature's gates |
| ~~**D6**~~ | ~~**`HF_ENDPOINT=hf-mirror.com` forced in manifests**~~ **FIXED 2026-07-12** (plugins `728698a`) | Deploy | — | **Done:** manifests no longer hardcode `HF_ENDPOINT`; server.py/setup.py `setdefault` to hf-mirror (China default) so a `HF_ENDPOINT` in the daemon env now overrides. (The earlier failure was hf-mirror being *transient*, not persistently broken; a cache-based auto-probe can't reliably discriminate endpoints, so overridable is the honest fix.) Still-open (minor): two download paths (HF vs modelscope) |
| — | **Minor**: two state-dir env var names (`WECHAT_CC_STATE_DIR` vs `WECHAT_STATE_DIR`); two GitHub orgs (ggshr9 vs tendhearth); three unsynced app versions | Deploy | Latent confusion | Pick one each |

**Not debt (for the record) — deliberately good:** the `AgentEvent` contract; the `.md`(subjective)
vs plugin(objective) boundary; the auth tier + routeAllow model; the health-aware instance lock; the
chatroom mutex-exemption; the DI split by lifetime; the poison-proof mutex.

### Suggested sequencing
D1 and D3 are the two that touch the **product** (coherent knowledge) and **correctness** (turn
races) — highest value. D2 is a *decision* first (product vs power-user) before it's work. D4/D5 are
quality-of-life refactors — do them opportunistically when next touching those layers. D6 is a small
fix worth doing now.
