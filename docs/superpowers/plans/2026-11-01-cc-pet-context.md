# CC Pet Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix reviewed interactions and let CC pet open the actual owner task that needs attention.

**Architecture:** Keep existing Tauri/renderer/pollers/workbench. Add a narrow owner-scoped read projection and carry one validated navigation object through live and cold entry.

**Tech Stack:** JavaScript/Tauri Rust/TypeScript, Vitest/Playwright/embedded WebKit on Mini.

**Spec:** docs/superpowers/specs/2026-11-01-cc-pet-context-design.md

## Global Constraints

- Root sole product writer/integrator; separate feature worktree from dev2d137ee8.
- Primary Mac: no automated input/focus/GUI, regression or build. Mini: offline QA/fakes only, shared family lock, no production daemon/models/accounts/plugins/keys.
- Frozen images and Light/Dark connection semantics unchanged; no fake unread/completion, no auto-approval/send/continue.
- Navigation only selects actual8-lowercase-hex task ID; legacy pages work. No new task lifecycle, scheduler, polling or database migration.
- Actual RED→GREEN, associated verify, integrated full verify, browser/native evidence, whole-bundle rollback and protected primary signing/deployment.

## Review Focus

- Auxiliary click after a genuine click/drag must not duplicate or trigger activation: Task1 tests.
- Pointer leaves after a task/permission supersedes local attention: Task1 test must preserve new fact.
- More than20 foreign/recent tasks must never leak data or hide an older live owner approval: Task2 tests.
- Slow cold restore and two competing concrete targets must retain the newest complete ID: Task3 unit/browser tests.
- Deleted target, untrusted text/IDs, menu keyboard and an existing draft must never cause send/continue or inaccessible controls: Task4 integration/browser tests.

### Task 1: Interaction fixes

Files: companion-window.js/html/css/test.ts; pet/pet.js/test.ts; playwright/companion-controls.spec.ts.
Interfaces: pet.acknowledgeAttention() remains boolean; add releaseAttention() that owns only its accepted local look; DOM tracks pointer/focus attention sources. Stage physical activation remains drag controller callback, virtualclick handled separately.

- [ ] Add tests: virtual click opens once; physical click+nativeclick opens once; postdragclick never opens; leaving accepted local look returns latest resting, never ends a superseding permission/transition/unrelated look.
- [ ] Browser RED: pointer-used zoom focus then leave hides controls; Tab/focus remains available; settings open visible; keyboardactivation succeeds.
- [ ] Observe meaningful RED on Mini, implement minimal fixes, run Mini unit/browser affected cases, commit.

### Task 2: Owner-scoped factual activities

Files: src/features/workbench/service/view.ts/view.test.ts; service.ts; src/domain/pet-turn.ts; daemon/wiring/wire-pet-turn.ts and pipeline-deps.ts; wiring tests; packages/protocol/src/desktop-api.ts.
Interfaces: view.petActivities() returns PetTaskActivity[]; optional WirePetTurnDeps.activities:()=>PetTaskActivity[]; PetTurnPayload.activities optional (legacy compatible). Existing trusted owner resolver stays authoritative.

- [ ] Add real store/view tests for ownership-before-limit, all live owner pending beyond20, archived/cancelled suppression, phase/paused/stopping/replied age, deterministic cap8/title bounds and no detail/git/touch.
- [ ] Add wiring/protocol tests for activities and legacy payload, no inferred permissiontask/unread; observe RED on Mini.
- [ ] Implement narrow projection and existing pet payload wiring; related Mini suites GREEN; commit.

### Task 3: Exact warm/cold main navigation

Files: desktop src/main-navigation.js/test.ts and main.js; src-tauri main navigation module/new unit tests and lib.rs; playwright/companion-entry.spec.ts.
Interfaces: existing legacy page accepted; new {page:'workbench',taskId:'deadbeef'} object; Rust pending and event same serialized object. Main callback reuses switchPane+openWorkbenchTask.

- [ ] Add navigation parser/queue tests for complete valid target, badID/extrafields/mismatchedpage rejection, legacy pages, live before/during/afterpending, newest ID retained.
- [ ] Browser RED opens exactly target outside current list, cold fast/slow preserves target; existing draft unchanged and no submission.
- [ ] Implement Rust+JS validation/queue and existing task open; Mini Rust/unit/browser GREEN; commit.

### Task 4: Compact activity entry

Files: companion-window.html/css/js/test.ts; new pet-activities.js/test.ts (validation/format/render helper as needed); existing bridge types; playwright companion-controls/status; QA fixtures/staging/native script/tests.
Interfaces: render validated activities using textContent, exact target passed to one activation path; primary focused activity + max8 compact chooser, permission/connection hints priority. Existing chat button unchanged.

- [ ] Add cases for invalid/duplicate records, hostile title, pending priority, read-only exacttask dispatch, hidden/disconnected stale state, settings/activity Escape and keyboard exit.
- [ ] Observe Mini RED; implement constrained UI, preserve existing fact props/connection and no fake one-shots; GREEN unit/browser.
- [ ] Extend offline QA scenario with real-shaped owner task descriptors and native target receipts; actual AppKit navigation live+pending plus CSS endpoint/keyboard synthetic scope documented; commit.

### Task 5: Final gates and delivery

- [ ] Mini affected verify, final source clean/exacttree; independent whole-branch review and fix any material findings with RED→GREEN.
- [ ] Integrate latest dev in root-owned integration worktree, preserve unrelated changes; same-source Mini full-platform, browser, nativeQA and productionbuild. Import only exact remote verifiedtree stamp; normal push hooks and exacthead CI.
- [ ] Use previous operator flow with fresh paths/baseline backup/actual receipts; preserve signed code/resources, FDA identity, guard and6plugins; wholebundle rollback on failure; run real workbench+chat selftests. No primaryUI launch/focus.
- [ ] Record final health/deployment/limitations; long-duration soak not replaced by an initial min-hours0 signal check.
