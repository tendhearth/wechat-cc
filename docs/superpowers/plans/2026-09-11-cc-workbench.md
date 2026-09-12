# CC Workbench Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development; the root implements the coupled runtime while independent desktop work is delegated. Review the whole branch after integration.

**Goal:** Deliver the approved persistent folder-task-artifact workflow with explicit owner WeChat continuation.

**Architecture:** A daemon-owned WorkbenchService persists tasks/events/artifact versions in SQLite and drives existing AgentProviders with separate sessions. Admin HTTP routes and an owner-only inbound command share this service. Desktop renders the same data using a host-held credential.

**Tech Stack:** Bun, TypeScript, SQLite, existing AgentProvider adapters, vanilla JS/CSS, Tauri.

**Spec:** `docs/superpowers/specs/2026-09-11-cc-workbench-design.md`

## Global Constraints

- No frozen character assets or unrelated branch changes.
- One active workbench turn; separate task sessions and no automatic restart replay.
- Admin-only HTTP; owner-only explicit WeChat task commands.
- Existing strict/trusted execution policy, no new bypass.
- Artifact snapshots are immutable; 8 MiB/file, 100 files/turn, no symlinks or arbitrary path fetch.
- No automatic outgoing messages/files or model requests during tests.
- Preview fixtures must be labeled; do not claim live-provider verification from mocks.

## Task 1: Persistent task runtime and artifacts

Files: `src/core/workbench/{store,artifacts,service}.ts` plus their tests, append migration to `src/lib/db.ts`.
Interfaces: `makeWorkbenchStore(db)`, `makeWorkbenchService({store,registry,stateDir,ownerChatId,mintSessionToken,revokeSessionToken,holdBusy})`; public `list`, `detail`, `create`, `continueTask`, `cancel`, `artifact`, `approve`, `handleWechat`, `shutdown`.

- [x] Write tests using an actual temporary SQLite database and directory. Create a task, complete a controlled generator, reopen the store, assert persisted text/artifact bytes. Assert a second task has no first-task session ID.
- [x] Add tests that hold spawn/dispatch open: duplicate runs reject, cancel during spawn never dispatches, missing result fails, restart running tasks become interrupted. Assert symbolically linked files are excluded and approval of one hash does not approve another version.
- [x] Run tests red; implement the migration, store, snapshot collector and service. Use synchronous reservation before async spawn to close race windows.
- [x] Add owner command tests: `任务 <id>` reads only bound-owner task; followup uses same service lock; a nonowner gets no task data. Run covering tests green.
- [x] Commit runtime and test evidence.

## Task 2: Desktop workbench and host proxy

Files: `apps/desktop/src/modules/workbench.js`, `workbench.test.ts`, `styles/workbench.css`, `main.js`, `index.html`, `api.js`; host changes in `src-tauri/src/lib.rs`, `test-shim.ts`; preview in `art/cc-workbench/`.
Consumes exact API/data fields in spec. Exports `initWorkbenchPage(deps)` and `stopWorkbenchPolling()`.

- [x] Write behavior tests for escaped task/event content, task status controls, stable artifact-version selection and stale response suppression.
- [x] Implement accessible task form, progress view, scoped artifact view/download/confirmation and followup form. Keep drafts during polling, reject double submit, show errors without clearing input.
- [x] Wire native folder selection and a strict method/path allowlist host proxy. Add proxy boundary tests. Wire navigation without changing existing panes.
- [x] Create explicitly labeled fixture preview using production module. Check 1280px and 760px widths and capture screenshots. Run desktop tests.
- [x] Commit only desktop files.

## Task 3: Daemon API and owner ingress integration

Files: `src/daemon/internal-api/routes-workbench.ts`, tests, `types.ts`, `index.ts`, `routes.ts`, `route-tiers.ts`; `wiring/pipeline-deps.ts`, `main.ts`, `bootstrap/wire-workbench.ts` and tests.
Consumes Task 1 service and serves Task 2 contract.

- [x] Test real route table via HTTP: unconfigured 503, trusted 403, admin can create/read, malformed IDs/text/path are rejected, known task failure is distinguishable from empty results.
- [x] Late-bind WorkbenchService after bootstrap, pass same instance into inbound path before ordinary agent dispatch; register lifecycle shutdown and busy hold.
- [x] Use task-only append instructions, scoped session auth and original backend resume checks. No main owner session mutation.
- [x] Run API, runtime, pipeline and desktop tests, then full typecheck. Review diff for credential leakage, lifecycle races and artifact path handling.
- [x] Commit integration and validation report; show preview. Leave local branch unpushed unless separately authorized.

## Validation record

See `docs/superpowers/reports/2026-09-11-cc-workbench-validation.md`. The first integration targets macOS. Linux artifact traversal is implemented but was not machine-tested; Windows artifact collection is not supported. Crash recovery preserves already captured versions and pending files on disk rather than automatically inspecting an unconfirmed writer.
