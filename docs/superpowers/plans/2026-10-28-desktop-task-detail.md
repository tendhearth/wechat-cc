# Desktop Task Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Complete the task detail hierarchy across running, response-needed and answered outcomes using the approved minimal phone logic.

**Architecture:** Keep existing desktop DOM/controller/stream reconciliation and renderer contracts. One implementer owns overall task detail assembly/styles; another independently adds an opt-in compact review summary, then its interface is integrated before the caller uses it. Use a small pure presentation helper only where state derivation/rendering benefits from a separate responsibility.

**Tech Stack:** Existing JavaScript/JSDoc, shared CSS tokens and local icons, Bun/Vitest and isolated Playwright fixtures.

**Spec:** `docs/superpowers/specs/2026-10-28-desktop-task-detail-design.md`, extending the approved October1 cross-platform and October5 page hierarchy specifications.

## Global Constraints

- Warm paper `#faf7f2`, deep green `#4f6b4f`, serif400/500; no new assets, dependencies, protocol, backend or theme.
- Derive labels from workbenchRuntimePresentation and authoritative phase/runId/inputMode, never activity guesses or file presence. Filter permissions/questions by current task id.
- Raw request/cwd/scope, errors, network freeze, partial/unknown reads, external-close/restart disclosures, queued retained save-only meaning and background-work termination consequences remain explicit.
- Preserve DOM action hooks, stable disclosure IDs, controller/preview instances, drafts, focus, selection, scroll anchors and pending locks.
- Existing assertions only increase. If a visual fixture truly conflicts with approved new hierarchy, report it first; preserve the underlying behavior/safety coverage instead of dropping or weakening tests. Prefer opt-in renderer presentation to keep old standalone compatibility fixtures.
- Continue in root's owned dev-descended branch/worktree codex/desktop-minimal-ui at aaa62101; child implementers use their own managed worktrees. Root serially integrates. No shared dev merge/push, daemon mutation, production state or native installation.
- Use isolated fixture state and unique ports: root4217, task detail4211, review4212. Official unit runner `bun run test <files> --maxWorkers=2 --no-file-parallelism`, not direct Bun test.

## Review Focus

- Running/paused/replied/retained/unknown and imported tasks must not be falsely classified as completed.
- Promoted result default and user-chosen folds survive new artifacts, task switches and streaming updates without moving the reader or opening previews unsolicited.
- A pending request cannot be obscured by an older result; exact request identity/scope and failure retry remain correct.
- Input help disclosures and metadata folds survive repaint without destroying typed text, model settings or focused review editors.
- Low-height/narrow layouts keep actual requests, supplement, stop/close, recovery and review actions reachable.

### Task 1: Compact review summary interface

**Files:** `apps/desktop/src/modules/workbench-review-panel.js`, related review tests; optional unique browser test. No workbench.js or shared CSS edits.

**Interface:** Extend ReviewPanelOptions with `compactSummary?: boolean` (default false). When true, use a short summary (改动 + meaningful count) and put existing complete statistics in the expanded body. Preserve existing default HTML compatibility, warnings, editors and all actions; no new outer disclosure.

- [x] Add meaningful compact-mode assertions for statistics availability, coverage warnings and active return/comment controls; observe RED.
- [x] Implement opt-in compact summary without touching default output or hidden safety content.
- [x] Run focused review/rewind/comment checks, commit the interface, report hash so Task2 can consume it.

### Task 2: State-led task detail and composer

**Files:** `apps/desktop/src/modules/workbench.js`, optional pure `workbench-task-detail.js`, `apps/desktop/src/styles/workbench.css`, focused task/runtime tests and a dedicated `playwright/task-detail-minimal.spec.ts`. Do not edit review-panel source/tests or shared index/styles.

**Interfaces:** Consume existing detail/runtime/pending inputs and Task1's compactSummary option after its commit is available. Keep review/preview renderer APIs, action IDs and request fields. Derive presentation once rather than inventing a second state machine.

- [x] Add state-matrix and real rendered interaction regressions before changes: running modes, scoped mixed decisions, paused/recovery/imported, answered output vs review-only, and archived.
- [x] Simplify task header/metadata and composer. Preserve visible essential limitations and opt-in help state per task.
- [x] Promote actual saved outcomes and make first-load results discoverable while respecting explicit disclosure choices, active reading anchors and selected artifact/preview instances; enable compact review option after Task1 integration.
- [x] Verify drafts, run/request ownership, focus, streaming/result transitions, failed submissions and wide/narrow/low-height interaction; inspect screenshots and commit.

### Task 3: Integration and final acceptance

- [x] Review each task independently and fix important findings with targeted RED/GREEN checks.
- [x] Serially integrate reviewed commits; run project verify against pinned dev baseline plus affected existing and new desktop browser flows.
- [x] Inspect actual running, decision, answered and recovery screenshots; resolve visual omissions against the stated hierarchy rather than counting list changes as detail completion.
- [x] Obtain a fresh whole-branch correctness review, preserve acceptance evidence/rulings, stop owned fixtures and leave a clean committed branch.
