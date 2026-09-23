# CC focused workbench implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the existing two-column Claude / Codex workspace quiet and readable without hiding real execution or permission state.

**Architecture:** Preserve the task controller and backend contracts. Refine the renderer into a fixed task header, scrolling conversation, and a separate composer dock. Keep visual rules in workbench.css instead of maintaining competing workbench rules in cc-life.css.

**Tech Stack:** Vanilla JavaScript, CSS, native details, Vitest, existing desktop Vite preview.

**Spec:** [CC task entry scope](../specs/2026-09-12-cc-task-entry-scope.md), especially Default interface; current user request: simpler, less cluttered, focused work.

## Global constraints

- Two columns: project/task list and the current task's complete conversation; global navigation remains callable but collapsed.
- Keep exact task identities, scoped drafts, request ordering, permission binding, stop behavior and immutable artifacts unchanged.
- Preserve real pending-permission counts, full approval details, queue blockers, writer-not-closed explanations and errors.
- Running/queued drafts are not delivered until the current turn ends. No new live-steering promise.
- Frozen CC assets and backend execution parameters remain unchanged; do not run build-cc-asset-kit.mjs.
- No push, merge, new orchestration dashboard, external-history import or handoff in this refinement.

## Design and reference evidence

This is a bounded refinement of the user's approved two-column work mode, not a new navigation proposal. The default screen should answer which task is selected, who is executing it, and whether the user needs to act. Technical identifiers and exact paths remain available in Task details. Keep restrained warm neutrals and high contrast body text; reserve colored emphasis for activity, failure and attention.

Official source inspected (not a claim of running those products):

- [Paseo sidebar row](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/app/src/components/sidebar/sidebar-workspace-row-content.tsx#L138): lightweight title and state; [tool disclosure](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/app/src/tool-calls/detail-level/overview/view.tsx#L110).
- [Orca composer actions](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/renderer/src/components/native-chat/NativeChatComposerActions.tsx#L137): one primary action position; [approval card](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/renderer/src/components/native-chat/NativeChatApprovalCard.tsx#L22): operation and decision stay clear.
- [CC Switch session row](https://github.com/farion1231/cc-switch/blob/1d5d90f4aba88447d422a16cdec5282ec5331fd7/src/components/sessions/SessionItem.tsx#L73), [session header](https://github.com/farion1231/cc-switch/blob/1d5d90f4aba88447d422a16cdec5282ec5331fd7/src/components/sessions/SessionManagerPage.tsx#L1465): compact context, full paths secondary.

## Task 1: Refine the existing focused surface

**Files:**
- Modify: apps/desktop/src/modules/workbench.js and workbench.test.ts (renderer and interaction regression).
- Modify: apps/desktop/src/styles/workbench.css (all workbench visual/layout rules).
- Modify: apps/desktop/src/cc-life.css and index.html (shell integration, remove competing overrides and slogan).
- Record: docs/superpowers/reports/2026-09-12-cc-workbench-focus-validation.md.

**Interfaces:** .wb-main contains header.wb-task-head, .wb-content, .wb-controls as siblings. All normal document scrolling belongs to .wb-content, including new-task/loading views. The dock contains current permission requests and the composer; long permission details can scroll within a bounded area. #wb-task-info joins existing per-task details preservation. Form IDs, data-action values and backend payloads remain stable.

- [x] Add meaningful failing tests: full task identity/path remains in closed Task details; empty artifact sections disappear; composer is outside the conversation scroller; permissions remain outside collapsed logs; draft controls cannot submit during an active run; scroll and task-details state survive task switching/polling. Adapt existing assertions to the same user contract, never delete coverage.
- [x] Run focused tests and verify the expected missing structure/behavior fails before implementation.
- [x] Render two-line task rows with provider and one truthful state area; keep full title/date/path accessible and duplicate folder names disambiguated. Move task ID, full path, update time and optional WeChat continuation into #wb-task-info. Preserve all messages and full approval descriptions. Use only Stop while active, Continue after completion, and one clear draft timing sentence.
- [x] Build fixed header/content/dock styles; compact list rows, neutral selection, smaller heading, readable 14px text, one bordered composer, no content hidden underneath it. Remove competing workbench overrides from cc-life.css. Keep visible keyboard focus and responsive widths.
- [x] Run workbench, navigation and cc-life tests, then typecheck. Inspect real preview at 1440×1000 and 1024×900; inspect completed, empty, long-message/artifact and pending-permission/queue states using explicitly labeled local UI fixtures if necessary. Check no horizontal overflow and no composer overlap. Do not trigger real provider calls for cosmetic verification.
- [x] Independent review of renderer/layout diff and fixes; record evidence and limitations, commit locally, leave real task preview open.
