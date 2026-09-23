# Workbench Executor Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Only admit work executors that explicitly implement CC's task protocol, and reject unsupported inputs before accepting a task.

**Architecture:** A small capability contract on code-level provider registration replaces the service's brand allowlist. Dedicated native adapters opt in; legacy chat adapters do not. Service checks capabilities at acceptance and dispatch, while the existing UI presents only actionable errors and concise optional explanation.

**Tech Stack:** TypeScript, Bun, Vitest, existing SQLite store and JS desktop modules; no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-13-cc-executor-admission.md`.

## Global Constraints

- Work only in `wechat-cc-cc-kit`, branch `codex/cc-workbench-v1`.
- No real WeChat sending, real bot restart, push/merge, frozen artwork edits or placeholder builder.
- User has authorized autonomous implementation and Cursor / agy model tests; this slice does not run them before configuration isolation is established.
- Capability metadata is code-level admission, not a user option or proof of OS isolation.
- Do not remove existing test assertions; test fixtures explicitly declare the protocol they simulate.

### Task 1: Contract and native registrations

**Files:** new `src/core/workbench/executor-capabilities.ts` and `.test.ts`; edit `src/core/provider-registry.ts`, `src/daemon/bootstrap/wire-workbench.ts`, `scripts/dev-cc-workbench.ts`, and owned `scripts/workbench-*-smoke.ts` registrations.

**Interfaces:** exports `WorkbenchExecutorCapabilities`, `MANAGED_NATIVE_CAPABILITIES`, `isWorkbenchExecutorCapabilities(value:unknown): value is WorkbenchExecutorCapabilities`, and `requireWorkbenchInput(capabilities, input:{attachments:readonly unknown[]; execution:AgentExecutionChoice; resume?:boolean}):void`. Registration gets optional `workbench?:WorkbenchExecutorCapabilities`.

- [x] Add failing tests for each missing required promise and false/unknown feature values; validator rejects truthy strings.
- [x] Add tests asserting `requireWorkbenchInput({...MANAGED_NATIVE_CAPABILITIES,features:{...MANAGED_NATIVE_CAPABILITIES.features,attachments:false}}, {attachments:[{}],execution:{defaults:'provider',model:null,reasoningEffort:null}})` throws `workbench_attachments_unsupported`; default text remains accepted.
- [x] Implement exact field checks and errors: `workbench_attachments_unsupported`, `workbench_execution_unsupported`, `workbench_resume_unsupported`. Freeze exported profile and nested features; copies returned through APIs must not mutate registration.
- [x] Explicitly attach `{...opts,workbench:MANAGED_NATIVE_CAPABILITIES}` only to specialized native registrations. Inventory workbench smoke scripts with `rg` and update owned fixtures; leave ordinary daemon registrations untouched.
- [x] Run contract tests and typecheck, inspect changes and commit with Task 2 integration.

### Task 2: Service admission and rejection before acceptance

**Files:** `src/core/workbench/service.ts`, new `src/core/workbench/service-capabilities.test.ts`; existing workbench, internal API and desktop integration test fixture registrations as needed.

**Consumes:** Task 1 exports and optional `ProviderRegistration.workbench`.
**Produces:** same service methods; `list().providers` gains a copied `capabilities` field. All entry and dispatch routes use the same checked provider and input helper.

- [x] Write red service tests with real temporary DB/projects: ordinary registry entry named Claude is not offered and cannot spawn; a valid distinct provider is offered and finishes; unsupported attachment/model/resume attempts create no durable input or task.
- [x] Replace `SUPPORTED` filtering with registration enumeration filtered by `isWorkbenchExecutorCapabilities`. In `provider(id)`, reject unadmitted with existing `unavailable_provider`.
- [x] Use one `requireWorkbenchInput` wrapper in `start`, create acceptance, native resume, handoff and live input paths. Include merged restart/handoff materials and retained execution choices. Check again before `spawn`.
- [x] Gate `canResume` by feature before calling native checker. Gate `modelCatalog` with feature and real method. Keep existing result/history reads accessible when unavailable.
- [x] In `src/core/workbench/handoff.ts` and `src/daemon/internal-api/routes-workbench.ts`, use `isWorkbenchProviderId(value:unknown):value is string` (`^[a-z][a-z0-9._-]{0,63}$`) for create/model/handoff tokens, then shared service admission. Preserve native history's two-reader boundary. Map the three exact capability failures to 422. Exercise real handlers with an admitted `reviewer-v2` and an unavailable well-formed token.
- [x] Add queue-time and live-input regression tests: mutating registry metadata while a task waits must not spawn it; failed live input does not bind files or create an input receipt.
- [x] Update only fixture declarations to explicitly opt simulated managed providers in; preserve assertion meaning. Run service/workbench/WeChat internal API coverage and typecheck.

### Task 3: Quiet user-facing compatibility and review

**Files:** `apps/desktop/src/modules/workbench-execution.js` and tests, `apps/desktop/src/modules/workbench.js` and tests, `src/core/workbench/wechat-control.ts` and tests, new `docs/superpowers/reports/2026-09-13-cc-executor-admission.md`.

- [x] Add failing desktop/WeChat assertions translating unsupported materials/settings into explicit remedies, never raw protocol codes. Empty-provider copy must not claim no executable is installed.
- [x] Keep the two-column view; improve only unavailable-provider copy and optional explanatory text under existing executor settings. Do not add a matrix or new setup form.
- [x] Extend explicit WeChat selection using `用 @<provider-id> <要求>`, shared identifier syntax and service gate; preserve legacy Claude/Codex selections and unprefixed ordinary requirements. Test a real service with admitted `reviewer-v2`, missing and malformed @ choices creating no task, and ordinary `用 Python 处理数据` reaching the default unchanged. Project help uses a returned project provider, not an assumed Codex connection.
- [x] Verify compact rendering, existing selections, and escaped explanatory text. Run relevant UI tests.
- [x] Independent reviewer checks admission bypasses, fixture opt-ins, publication ordering and capability copy isolation. Address substantive findings with tests.
- [x] Run combined relevant regressions once and whole-repo typecheck. Record native public-code findings and test scope honestly, commit and keep overall goal active.

## Completion evidence

60 relevant files / 839 tests passed; full typecheck and diff check passed. Independent review closed all four P2 findings. See `docs/superpowers/reports/2026-09-13-cc-executor-admission.md`. No new production executor or overall CLI/App parity claim.
