# Desktop Minimal UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the already approved phone interaction hierarchy to desktop: companion-first 此刻, task-first 一起做, one visible expression of each state, and details on demand.

**Architecture:** Keep the desktop DOM modules and existing wide-window navigation/list/conversation/optional-result layout. Reuse local icons, shared tokens and existing disclosure/state ownership mechanisms. Correct recovery and feedback races without changing backend contracts.

**Tech Stack:** DOM modules with JavaScript/JSDoc, shared CSS tokens, Bun/Vitest, Playwright and the isolated dry-run shim.

**Spec:** `docs/superpowers/specs/2026-10-01-tendhearth-design-unify-design.md` and `docs/superpowers/specs/2026-10-05-now-together-hierarchy.md`. User confirmed on 2026-10-28 that desktop should follow the same logic as the approved minimal phone version; this is implementation of that direction, not a new navigation proposal.

## Global Constraints

- Warm paper `#faf7f2`, deep green `#4f6b4f`, local serif fonts, weight 400/500, canonical CC only; no emoji, new theme, new dependency or backend route.
- 此刻 = CC 和你; 一起做 = 交给 CC 的事. Keep desktop projects, search, keyboard use and optional result preview.
- Familiar actions may use icons with accessible names and hover titles. Counts must retain their full accessible meanings; zero, unknown, stale and partial reads remain distinct.
- Preserve raw permission operation, cwd, exact-request scope, explicit decision actions, unsaved drafts, pending locks and authoritative success/failure semantics.
- Maintain every existing test assertion. Add meaningful RED/GREEN regressions for behavior changes; document any unavoidable test-contract change instead of deleting coverage.
- Work only in assigned independent worktrees; root integrates commits serially in `codex/desktop-minimal-ui`. Base is local `origin/dev` `dc4f8cf9`; attempted remote refresh failed with SSL, so do not claim remote freshness.
- No shared dev merge, push, daemon restart, production data, app install or release. Use unique local ports and isolated mock state.

## Review Focus

- Failed/partial attention reads keep uncertainty visible; terminal requests remain distinct and actionable.
- Icon-only status counts remain discoverable to mouse, keyboard and screen readers.
- Rerenders, task switches and closing details retain the correct draft and pending lock.
- Repeated recovery clicks and out-of-order responses cannot overwrite authoritative success or another view's content.
- Narrow windows, low height and 200% zoom keep primary actions and cancellation reachable.

### Task 1: 此刻 compact request rows

**Files:** `apps/desktop/src/modules/now-home.js`, `now-page.js`, their focused tests, `apps/desktop/src/cc-now.css`; dedicated Playwright coverage if needed.

**Interfaces:** Consume existing attention/terminal data and `icons.js`. Preserve task identity and terminal repair actions; normal request rows show the request plus a small icon/arrow, rather than repeating “N 件事等你” and “看清楚／回答”. Keep section accessibility and compact unknown/partial explanation. Do not modify `index.html`, shared icons or workbench code.

- [x] Add behavioral assertions for request identity, accessible purpose, stale/partial and terminal states; demonstrate the missing behavior.
- [x] Implement flat rows and remove redundant visible summary/action words while preserving existing data contracts or adding a presentation adapter.
- [x] Run focused unit/browser checks and capture a truthful demo screenshot; commit only owned files.

### Task 2: 一起做 one clear decision state

**Files:** `apps/desktop/src/modules/workbench.js`, `apps/desktop/src/styles/workbench.css`, relevant existing/new workbench tests and dedicated browser coverage.

**Interfaces:** Consume current task/detail/permission/question state and existing icons; preserve action hooks, search, project folds, raw commands, cwd, exact-scope decisions, draft capture and result preview. Use quiet visual markers in list/top navigation; concrete operation and primary decision remain the focus of the decision area. Do not alter now-page, shared icons, index markup or backend code.

- [x] Add a rendered-page regression asserting one main visible decision instruction and correct accessible count/navigation, with approval scope preserved.
- [x] Reduce repeated waiting/count copy at list/top/detail layers; keep distinct blocked/failed/unknown/completed states.
- [x] Verify task switching, drafts, permission focus, wide/narrow layout and result access; commit owned changes.

### Task 3: Secondary entries and honest feedback

**Files:** `apps/desktop/src/index.html`, `styles.css`, `modules/settings-drawer.js`, `modules/memory.js`, related focused tests and desktop browser regressions. A dedicated secondary-page implementer owns these files; root integrates and verifies.

**Interfaces:** Reuse existing disclosures and icons. Shorten secondary titles; move explanations into expanded details while distinguishing rereading from generation. Keep required privacy/scope disclosures. Settings success becomes a brief accessible check; saving and failure remain visible. Memory restore gets a synchronous pending lock and view ownership protection.

- [x] Reproduce duplicate restore request/false failure with a delayed system boundary, and settings feedback persistence with controlled time; add regressions before fixes.
- [x] Implement recovery lock and stale-response ownership, then verify success, failure and retry.
- [x] Compact memory and connection entry hierarchy without merging semantically different actions; keep every destination reachable.
- [x] Check disclosure/confirmation height and scroll behavior at low height/200% zoom, and fix only reproduced problems; commit.

### Task 4: Integration and verification

- [x] Review each task's diff against the approved specs; serially integrate into root's branch.
- [x] Run focused impacted checks, `bun run verify` against pinned dev baseline, and affected desktop Playwright flows using a unique dry-run port/state directory.
- [x] Inspect actual wide/narrow screenshots with seeded working task data; do not present unimplemented mock endpoints as product state.
- [x] Obtain a fresh whole-branch correctness review; resolve important findings and repeat only affected checks.
- [x] Save evidence and acceptance notes, stop only owned local servers, and leave a clean committed independent branch.
