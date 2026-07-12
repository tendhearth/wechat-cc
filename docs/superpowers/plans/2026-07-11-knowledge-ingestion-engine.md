# Knowledge Ingestion Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]`.

**Goal:** A daemon background loop that keeps the local knowledge base (wxgraph/wxsearch/wxmedia/wxfacts) fresh from wxvault's decrypted output — deterministic builders driven via the MCP bridge, wxfacts extraction driven via `cheapEval` — idle-gated, rate-bounded, resumable.

**Architecture:** Daemon-orchestrated, NO agent turn. `createMcpToolBridge` (`src/core/openai-mcp-bridge.ts`) calls plugin tools programmatically; `cheapEval` does only the extraction reasoning. A new `registerIngest` scheduler (peer of push/introspect) runs `runIngestCycle`. See spec `docs/superpowers/specs/2026-07-11-knowledge-ingestion-engine-design.md`.

**Tech Stack:** daemon TypeScript, vitest.

## Global Constraints

- Plugin tools + shapes (verbatim): `wxvault.overview` (poke → forces incremental re-decrypt); `wxgraph.graph_status`→`{contacts,owner,built_at,stale}`, `wxgraph.rebuild`; `wxsearch.index_update`→`{indexed,skipped}`; `wxmedia.voice_backfill`; `wxfacts.extraction_batch`→`{done:true}` OR `{batch_id,contact,display,covers_until_ts,messages:[{msg_key,sender,time,text}]}`, `wxfacts.record_facts`→`{recorded,merged,advanced_to}` (args `{batch_id, facts}`; `facts:[]` just advances the watermark).
- Bridge `.call(name, input) → Promise<string>` returns the tool's TEXT content; wxfacts/wxgraph/wxsearch all reply with a JSON string → `JSON.parse` it.
- Fact shape: `{kind∈entity|relation|obligation|attribute|event, predicate, value, related_contact?, time_ref?, confidence∈low|med|high, source_msg_keys?}`.
- Deterministic-builder gate = the engine's own **source-max-mtime** of `<stateDir>/plugin-data/wxvault/out/decrypted/*.sqlite`, compared to an in-closure `lastSourceMtime` (no persistent store; a post-restart extra build is harmless). wxfacts extraction self-gates (returns `{done:true}` when caught up).
- Per-cycle extraction cap `INGEST_BATCH_CAP = 4`; cadence `INGEST_INTERVAL_MS = 25*60_000`; jitter 0.3.
- Idle-only: skip a cycle if any chat is in-flight; run under a dedicated `__ingest__` lock. Enable gate: `CompanionConfig.enabled && cfg.ingest_enabled !== false && !snoozed`.
- Tolerate a plugin absent from the spec map (skip that source). TDD; tsc clean; explicit `git add`.

---

### Task 1: fact parsing + extraction prompt (`extract.ts`, pure)

**Files:** Create `src/daemon/companion/ingest/extract.ts`, `src/daemon/companion/ingest/extract.test.ts`

**Interfaces — Produces:**
```ts
export type FactKind = 'entity' | 'relation' | 'obligation' | 'attribute' | 'event'
export interface Fact {
  kind: FactKind; predicate: string; value: string
  related_contact?: string; time_ref?: string
  confidence?: 'low' | 'med' | 'high'; source_msg_keys?: string[]
}
export interface Batch { batch_id: string; contact: string; display?: string; messages: Array<{ msg_key: string; sender: string; time: number; text: string | null }> }
export function buildExtractionPrompt(batch: Batch): string
export function parseFacts(text: string): Fact[]
export const FACT_KINDS: readonly FactKind[]
```

- `FACT_KINDS = ['entity','relation','obligation','attribute','event'] as const`.
- `buildExtractionPrompt(batch)`: a Chinese prompt — role: 你是一个信息抽取器（不是聊天助手）. Given these 1:1 messages between 主人 and `${batch.display ?? batch.contact}`, extract DURABLE structured facts (稳定的实体/关系/义务/属性/事件；跳过寒暄/情绪/一次性闲聊). Obligation = 任一方的承诺或未了债务（"我欠他一本书"/"他答应帮我看简历"）. For each fact give `{kind,predicate,value,related_contact?,time_ref?,confidence,source_msg_keys}`, `source_msg_keys` = the `msg_key`s it came from, `confidence` ∈ low|med|high. 没有值得记的就返回 `[]`. **只输出 JSON 数组，不要任何解释/代码围栏。** Then the serialized messages (`[msg_key] sender: text`, skipping null text).
- `parseFacts(text)`: tolerant. Strip ```` ```json ```` / ```` ``` ```` fences; locate the first `[` and its matching `]` (bracket-depth scan so nested arrays don't truncate); `JSON.parse` that slice; if it isn't an array → return `[]`. For each element keep it ONLY if `FACT_KINDS.includes(kind)` and `predicate` and `value` are non-empty strings; coerce `source_msg_keys` to a string[] (drop if not array); drop `confidence` not in the enum. Return the surviving facts (possibly `[]`). NEVER throw.

- [ ] **Step 1: tests** — `buildExtractionPrompt`: contains the display name, the 只输出JSON数组 instruction, and each message's `msg_key`+`text`; a null-text message is omitted. `parseFacts`: (a) a clean `[{kind:"obligation",predicate:"欠",value:"一本书",source_msg_keys:["k1"]}]` → 1 fact; (b) fenced ```` ```json\n[...]\n``` ```` → parsed; (c) prose around the array (`好的，结果：[..] 完成`) → array extracted; (d) `kind:"gossip"` element dropped, valid sibling kept; (e) element missing `value` dropped; (f) `[]` → `[]`; (g) `我不能帮你做这个` (refusal, no array) → `[]`; (h) `{}` (object not array) → `[]`; (i) malformed `[{kind:` → `[]` (no throw).
- [ ] **Step 2: RED→GREEN.** `bun --bun vitest run src/daemon/companion/ingest/extract.test.ts` + `bunx tsc --noEmit`.
- [ ] **Step 3: Commit** `feat(ingest): fact parser + extraction prompt`.

---

### Task 2: extraction worker (`runExtraction` in `extract.ts`)

**Files:** `src/daemon/companion/ingest/extract.ts` (+ `extract.test.ts`)

**Interfaces — Produces:**
```ts
export interface ExtractDeps {
  call: (tool: string, input?: unknown) => Promise<string>   // bridge.call
  cheapEval: (prompt: string) => Promise<string>
  cap: number
  log?: (tag: string, msg: string) => void
}
export async function runExtraction(d: ExtractDeps): Promise<{ batches: number; recorded: number }>
```

Loop up to `d.cap` times:
1. `const batch = JSON.parse(await d.call('extraction_batch', { limit: 40 }))`.
2. If `batch.done` → break.
3. `let facts: Fact[]`; `try { facts = parseFacts(await d.cheapEval(buildExtractionPrompt(batch))) } catch (e) { d.log?.('INGEST', 'extract eval error, deferring: '+String(e)); break }` — **model/network error breaks WITHOUT recording (watermark NOT advanced → retried next cycle).**
4. `await d.call('record_facts', { batch_id: batch.batch_id, facts })` — advances the watermark even when `facts` is `[]` (parse-fail/refusal → advance past the bad window, logged).
5. `batches++; recorded += facts.length`.
Return `{ batches, recorded }`.

- [ ] **Step 1: tests** (fake `call`/`cheapEval` recording invocations):
  - drains to done: `call` returns 2 real batches then `{done:true}`; cheapEval returns 1 fact each ⇒ `{batches:2, recorded:2}`, `record_facts` called twice with the right `batch_id`.
  - cap respected: `call` always returns a batch (never done); cap=4 ⇒ exactly 4 `extraction_batch` + 4 `record_facts`, then stops.
  - malformed model output: cheapEval returns `我不能` ⇒ `record_facts` still called with `facts:[]` (watermark advances), `recorded:0`.
  - cheapEval throws ⇒ loop breaks, `record_facts` NOT called (watermark preserved).
- [ ] **Step 2: RED→GREEN.** vitest extract.test.ts + tsc.
- [ ] **Step 3: Commit** `feat(ingest): extraction worker (batch→cheapEval→record, bounded+resumable)`.

---

### Task 3: cycle orchestration (`cycle.ts`)

**Files:** Create `src/daemon/companion/ingest/cycle.ts`, `cycle.test.ts`

**Interfaces:**
- Consumes: `runExtraction` (Task 2); a bridge-like `{ call, close }`.
- Produces:
```ts
export interface IngestBridge { call: (tool: string, input?: unknown) => Promise<string> }
export interface CycleDeps {
  bridge: IngestBridge
  hasTool: (tool: string) => boolean          // from bridge.tools — is this plugin present+ready?
  cheapEval: (prompt: string) => Promise<string>
  sourceMaxMtime: () => number                 // max mtime of out/decrypted/*.sqlite (ms); 0 if none
  lastSourceMtime: number
  cap: number
  log?: (tag: string, msg: string) => void
}
export interface CycleReport { decrypted: boolean; rebuilt: boolean; indexed: boolean; transcribed: boolean; batches: number; recorded: number; newSourceMtime: number }
export async function runIngestCycle(d: CycleDeps): Promise<CycleReport>
```

Order (each step guarded by `hasTool`):
1. If `hasTool('overview')` → `await d.bridge.call('overview')` (poke wxvault; ignore result). `decrypted = true`.
2. `const mtime = d.sourceMaxMtime()`. `const sourceAdvanced = mtime > d.lastSourceMtime`.
3. If `sourceAdvanced`: run deterministic builders that are present — `if hasTool('rebuild') await call('rebuild')` (rebuilt=true); `if hasTool('index_update') await call('index_update')` (indexed=true); `if hasTool('voice_backfill') await call('voice_backfill')` (transcribed=true). Each wrapped in try/catch (log + continue — one builder failing doesn't abort the cycle).
4. Extraction: `if hasTool('extraction_batch')` → `const { batches, recorded } = await runExtraction({ call: d.bridge.call, cheapEval: d.cheapEval, cap: d.cap, log: d.log })`.
5. Return the report with `newSourceMtime: mtime` (the caller stores it as the next `lastSourceMtime`).

Note: builders gated on `sourceAdvanced` so a no-new-data cycle only pokes wxvault + runs one `extraction_batch` (which returns `done` cheaply when caught up).

- [ ] **Step 1: tests** (fake bridge recording tool calls + canned returns; `hasTool` from a set):
  - source advanced: `sourceMaxMtime` > `lastSourceMtime` ⇒ overview + rebuild + index_update + voice_backfill all called, then extraction runs.
  - source unchanged: `sourceMaxMtime` == `lastSourceMtime` ⇒ overview called, NO rebuild/index_update/voice_backfill; extraction still attempted (one `extraction_batch` returning done).
  - missing plugin: `hasTool('rebuild')` false ⇒ rebuild NOT called, others proceed.
  - builder throws ⇒ cycle continues to extraction (report notes the failure via log), no throw out of `runIngestCycle`.
- [ ] **Step 2: RED→GREEN.** vitest cycle.test.ts + tsc.
- [ ] **Step 3: Commit** `feat(ingest): cycle orchestration (poke→staleness-gated builders→extraction)`.

---

### Task 4: `ingestTick` body in tick-bodies.ts

**Files:** `src/daemon/wiring/tick-bodies.ts` (+ `tick-bodies.test.ts` if the harness supports; else covered by Task 3 + Task 5 wiring test)

- Add to `TickBodies` an `ingestTick: () => Promise<void>` and implement in `buildTickBodies`:
  - Build the spec map: `const specs = pluginMcpSpecs(loadPlugins({ stateDir: deps.stateDir, bundledDir: bundledPluginsDir(), hostVersion: <selfPkg.version if available in scope, else undefined> }))` (import `loadPlugins`/`pluginMcpSpecs` from `../plugins/registry`, `bundledPluginsDir` from `../plugins/paths`).
  - If `Object.keys(specs).length === 0` → return (nothing to ingest; e2e harness path).
  - `const cheapEval = deps.boot.registry.getCheapEval()`; if unavailable → still run (extraction self-skips: guard `runExtraction` behind `cheapEval` existing — if null, pass a `hasTool` that excludes `extraction_batch`, so only deterministic builders run). Simplest: `const canExtract = !!cheapEval`.
  - **Idle guard:** if `deps.boot.sessionManager` reports ANY chat in-flight, skip this cycle (log + return). (Use the existing in-flight query; if only per-chat, iterate `chatPrefs.list()` + default.) Run the body under `deps.boot.coordinator.runExclusive('__ingest__', ...)` so a user turn and ingestion never overlap.
  - `const bridge = await createMcpToolBridge(specs)` (import from `../../core/openai-mcp-bridge`); `try { const hasTool = (t) => bridge.tools.some(x => x.name === t); const report = await runIngestCycle({ bridge, hasTool, cheapEval: canExtract ? cheapEval : async()=>'[]', sourceMaxMtime: () => maxDecryptedMtime(deps.stateDir), lastSourceMtime: <persist in a closure var on buildTickBodies scope>, cap: INGEST_BATCH_CAP, log: deps.log }); lastIngestSourceMtime = report.newSourceMtime; deps.log('INGEST', summarize(report)) } finally { await bridge.close() }`.
  - `maxDecryptedMtime(stateDir)`: glob `join(stateDir,'plugin-data','wxvault','out','decrypted','*.sqlite')`, return max `statSync().mtimeMs` or 0. Put this helper in `cycle.ts` (exported) so it's unit-tested there too (add a small test: empty dir → 0; two files → the larger mtime).
- Keep `lastIngestSourceMtime` as a `let` in `buildTickBodies` closure (in-memory across cycles).

- [ ] **Step 1:** implement + a wiring smoke test if feasible (spec map empty ⇒ `ingestTick()` resolves without touching the bridge). Add the `maxDecryptedMtime` unit test in cycle.test.ts.
- [ ] **Step 2:** `bunx tsc --noEmit` + `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts src/daemon/companion/ingest/`.
- [ ] **Step 3: Commit** `feat(ingest): ingestTick body (bridge + cheapEval + idle guard)`.

---

### Task 5: config flag + scheduler + boot registration

**Files:** `src/daemon/companion/config.ts`, `src/daemon/companion/lifecycle.ts`, `src/daemon/wiring/lifecycle-deps.ts`, `src/daemon/main.ts` (+ tests mirroring existing push/introspect tests)

- `config.ts`: add `ingest_enabled?: boolean` to `CompanionConfig` (doc: default-on when companion enabled; explicit `false` disables the WRITE-side loop). No change to `defaultCompanionConfig` (absent = on).
- `lifecycle.ts`: `export function registerIngest(deps): Lifecycle` mirroring `registerCompanionPush`, interval `INGEST_INTERVAL_MS` (25 min), `JITTER` 0.3, calling `deps.ingestTick` via `startCompanionScheduler`.
- `lifecycle-deps.ts` (`buildLifecycleDeps`): build `companionIngestDeps` mirroring `companionPushDeps`, with `shouldRun` = `cfg.enabled && cfg.ingest_enabled !== false && !snoozed(cfg)` (reuse the existing snooze helper) and `onTick: ticks.ingestTick`.
- `main.ts`: `lc.register(registerIngest(wired.companionIngestDeps))` next to the push/introspect registrations. Thread `ingestTick` through `wiring/index.ts`'s `buildTickBodies` result into the lifecycle deps (mirror how `pushTick` is threaded).

- [ ] **Step 1: tests** (mirror the push lifecycle test): `shouldRun` false when `enabled:false`, when `ingest_enabled:false`, when snoozed; true otherwise. A boot test asserting `registerIngest` is registered (or that `ingestTick` fires under a fake scheduler).
- [ ] **Step 2:** `bunx tsc --noEmit` → `bun --bun vitest run src/daemon/companion/ src/daemon/wiring/` → full `bun --bun vitest run`.
- [ ] **Step 3: Commit** `feat(ingest): config flag + registerIngest scheduler + boot wiring`.

---

### Task 6: new-message nudge (debounced)

**Files:** `src/daemon/companion/lifecycle.ts` (expose `nudge()` on the ingest `Lifecycle`), `src/daemon/main.ts` / the inbound pipeline (`src/daemon/inbound/*` or `ilink-glue.ts`)

- `startCompanionScheduler` returns `stop`; extend `registerIngest` to also expose a **debounced `nudge()`**: on `nudge()`, if no cycle is scheduled sooner than `NUDGE_DELAY_MS` (2 min), (re)arm a one-shot timer that fires `ingestTick` after the debounce; collapse rapid nudges to a single fire. (Implement as a small debounce wrapper in `lifecycle.ts`; do NOT disturb the 25-min cadence — the nudge is an ADDITIONAL earlier fire.)
- Wire: where an inbound WeChat message is recorded (`messagesStore.append` in `ilink-glue.ts` / the inbound pipeline), call `ingestLifecycle.nudge()` (thread the handle in). Guarded by the same enable gate (nudge is a no-op when ingestion disabled).

- [ ] **Step 1: tests**: rapid `nudge()` calls ⇒ `ingestTick` fires once after the debounce (fake timers). `nudge()` when disabled ⇒ no fire.
- [ ] **Step 2:** tsc + `bun --bun vitest run src/daemon/companion/` → full suite → e2e (`bun --bun vitest run -c vitest.e2e.config.ts`; harness has no wx plugins ⇒ ingest is an inert no-op).
- [ ] **Step 3: Commit** `feat(ingest): debounced new-message nudge (react to fresh WeChat activity)`.

## Self-Review notes

Spec §2 → T3 (cycle) / §3 triggers → T5 (cadence) + T6 (nudge) / §4 bounds → T2 (cap+validate+resume) + T4 (idle guard) / §5 wiring → T4-T6. Extraction validation (memory-gardener lesson) pinned in T1 parseFacts + T2 (eval-throw vs parse-fail branch). Staleness gate is the engine's own source-mtime (uniform, plugin-agnostic) not per-plugin status. Names consistent: `runIngestCycle`/`runExtraction`/`parseFacts`/`ingestTick`/`registerIngest`/`ingest_enabled`/`INGEST_BATCH_CAP`/`INGEST_INTERVAL_MS`. Live smoke (spec §7) is a manual post-merge step, not a task. Deferred: desktop status pane, full-reindex automation, per-plugin richer gating.
