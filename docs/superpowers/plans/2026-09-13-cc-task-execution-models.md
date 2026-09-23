# Task execution models implementation plan

> For agentic workers: use superpowers:subagent-driven-development or superpowers:executing-plans. Follow the interfaces below and verify each boundary with real native protocol evidence.

**Goal:** Choose a task's model and native reasoning level inside CC, retain the choice across continuation, and distinguish requested settings from the executor's observed configuration.

**Architecture:** Optional provider-native catalogs feed the existing collapsed workbench controls. Task choices and accepted run snapshots are durable; an active run never re-reads mutable settings. Native responses report effective model observations separately. New tasks inherit provider configuration, while imported native sessions and automatic resumed turns must not accidentally inherit CC's global fallback model.

**Tech stack:** TypeScript/Bun/SQLite, Claude Agent SDK 0.2.116 (CLI 2.1.267), Codex app-server 0.153.4, existing vanilla desktop modules/Tauri proxy.

**Spec:** `docs/superpowers/specs/2026-09-13-cc-unified-task-entry.md`; baseline `e81fe704`.

## Constraints and decisions

- The user authorized autonomous implementation. No new approval round, real model API calls, user MCP execution, WeChat sends, real bot restart, push or merge.
- Keep two columns and existing disclosures. New task: model/effort inside “执行者与命名”; existing task: next-run choices inside “任务详情”. No permanent settings panel. Active/queued/cancelling tasks cannot change execution settings or use steering to change a model.
- Native catalogs determine advertised model IDs and per-model effort strings. Do not invent IDs or flatten two executors into a single static effort enum. A missing catalog is a visible discovery failure; default execution can still use native behavior, explicit unsupported settings must not silently downgrade.
- `null` means omit the task override, not reset a native conversation to a guessed global default. UI uses “自动（沿用当前设置）”; for a new task this means provider defaults, for an existing native conversation it means its retained settings.
- An effective model may be unknown until the native executor reports it. Requested settings cannot be relabeled as actual model observations. No raw reasoning content is recorded.
- Model changes are submitted with create/continue, not saved by a separate auto-applying endpoint. Continuation receipt identity includes the accepted execution choice, as do native preparation and handoff confirmation. Changing a draft after submission does not alter the already accepted run.
- A new review task does not inherit the other provider's model ID. A revision uses the existing target task's choice. Queued supplements retain the accepted parent run's choice; live steering has no execution-setting override.

## Shared interfaces

Define in `src/core/agent-provider.ts`:

```ts
interface AgentExecutionChoice {
  defaults: 'provider' | 'native';
  model: string | null;
  reasoningEffort: string | null;
}
interface AgentExecutionModel {
  id: string; displayName: string; description?: string;
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
  inputModalities?: string[];
}
interface AgentModelCatalog {
  models: AgentExecutionModel[];
  defaultModel?: string;
  source: 'native';
}
interface AgentExecutionObservation {
  model: string;
  reasoningEffort?: string;
  sessionId?: string;
  source: 'native_response' | 'native_message' | 'native_reroute';
}
// AgentProvider:
modelCatalog?(project: AgentProject): Promise<AgentModelCatalog>;
// SpawnContext:
execution?: AgentExecutionChoice;
reportExecution?(value: AgentExecutionObservation): void;
```

Keep existing `SpawnContext.model` and text-only callers unchanged outside this opt-in workbench path. Catalogs must be bounded, deduplicate IDs and reject malformed native fields rather than exposing raw responses.

## Task 1: Native catalogs and actual request mapping

Files: shared provider types; Claude provider; workbench Codex adapter; native catalog helper(s); workbench wiring; native/unit fixtures.

- [x] Test optional catalog mapping, model-specific effort validation, existing no-execution callers, auto-resume without CC fallback, explicit overrides and actual observation sources before implementation.
- [x] Codex catalog discovery: initialize → paginated model/list → config/read → close, without thread/start or model input. Claude discovery: empty streaming input → supportedModels/initializationResult → close, with no tools/MCP/hooks/plugins and no persisted session.
- [x] Explicit choices use Claude Options.model/effort or Codex supported start/resume/turn fields, with native validation before a model request. Do not use private SDK methods or unsupported steer fields. Apply native fallback/reroute observations only to the originating run.
- [x] Run actual installed native executors against owned loopback endpoints. Assert discovery makes zero model requests/empty histories, request model/effort match the selected choice, and resumed auto omits the CC fallback. No user account calls.

## Task 2: Durable choice and per-run observation

Files: `src/core/workbench/execution-settings.ts` and tests; store; append migration v54 and migration tests.

Store facade `store.execution`:

```ts
choice(taskId: string): AgentExecutionChoice;
accept(taskId: string, runId: string, choice: AgentExecutionChoice): void;
run(taskId: string, runId: string): RunExecution | null;
last(taskId: string): RunExecution | null;
observe(taskId: string, runId: string, value: AgentExecutionObservation): void;
interface RunExecution {
  taskId: string; runId: string; choice: AgentExecutionChoice;
  effective: AgentExecutionObservation | null;
  createdAt: number; observedAt: number | null;
}
```

Use one task choice JSON column plus a run table. Existing tasks default to provider inheritance; imported sources migrate to native inheritance. `accept` runs inside service acceptance's SQLite transaction, creates an immutable run choice and updates the retained task choice. `observe` cannot update the choice or task timestamp. Reject a reused run ID with different task/choice. Export `normalizeExecutionChoice(value, fallback)` and `sameExecutionChoice(a,b)`; validate known keys, model/effort nonempty bounded identifiers or null, and reject effort without a supported native resolution at the adapter.

- [x] Red/green tests: v53 migration/defaults/imported native choice, database reopen, immutable run identity, task isolation, observation cannot rewrite requested choice or task version.
- [x] Use real SQLite; default reads must also work for a task just created in the surrounding transaction.

## Task 3: Service acceptance, identity and HTTP

Files: service, continuation, handoff/native adoption interfaces, live-input persistence, routes and tests, route tiers/operator allowlists.

- [x] Add `execution?: AgentExecutionChoice` to create/continue material input. Normalize omitted continuation to stored task choice; create to provider inheritance. Freeze it in Active and `store.execution.accept` inside the existing acceptance transaction, and pass it to spawn.
- [x] Store native observation through a run-bound callback that ignores stale/cancelled/finishing runs. Expose `execution` and `lastExecution` in task detail; do not infer effective model from requested choice.
- [x] Add read-only `GET /v1/workbench/models?providerId=...&path=...` through exact operator/admin/proxy allowlists. Canonicalize project path; call the registered provider's catalog with bounded discovery and clear errors.
- [x] Bind execution to durable terminal input identity, restart/native prepare tokens and handoff target configuration. Received queued inputs use the original run's choice. A retry with changed execution must conflict instead of silently replaying old work.
- [x] Service regressions: two projects with different models, retained choice on continuation/reopen, queued snapshot unaffected by later state, default native resume, cross-provider review, target revision, unknown observation, stale decision and conflicting receipt.

## Task 4: Existing disclosures and real browser flow

Files: workbench execution control helper and tests; workbench/window-state/interaction; CSS only as needed; browser/Rust proxy allowlists.

- [x] Lazy-load a catalog only when the existing settings disclosure is opened; key/cache it by provider + exact project and ignore stale responses after navigation. Keep unavailable explicit saved choices visible; provider change clears incompatible draft choices.
- [x] Restore automatic values by field presence, not truthiness. Capture execution with submit snapshots and include it in retry/draft reconciliation. Preparing native continuation freezes the same choice; editing it invalidates that preparation.
- [x] Show requested next-run choice separately from the last native-confirmed model/effort. Unknown effort remains unknown. Disable edits during active/queued/cancelling/submitting states.
- [x] Test draft/task/provider isolation, stale catalog replies, missing catalogs, automatic restoration, lost-response retry with choice changes and no visible layout regression. Run a production browser → restricted operator proxy → real HTTP/service/SQLite fixture using synthetic provider execution.

## Final review and delivery

- [x] Run affected native/service/HTTP/UI suites, full typecheck, Rust proxy check and owned native/browser probes. Independently review request identity, fallback semantics and observation provenance.
- [x] Commit independently reviewable changes; record exact evidence and remaining limitations in a delivery report. Keep the original goal active.

Delivery: native `17a4beb6`, durable service `b7b94286`, desktop `09645d54`, test guards `b47c5573`. See [the report](../reports/2026-09-13-cc-task-execution-models.md). The full repository run has 7048 passing tests and 16 older settings-panel HTTP timeouts independently reproduced as a host IPv4 wildcard-listener boundary; it is not reported as a fully green run.

Separate next slice: background lifecycle. Current Claude adapter ends its event queue at the first result and does not handle native `task_started`/`task_notification`; service closes the native process at iterator end. Codex similarly ends on the parent turn. This is direct evidence of a remaining lifecycle gap, not completed background-agent support. It requires its own native execution probe and protocol design after this model-control change.
