# CC Pet Life Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give CC coherent idle life, lifting/landing feedback, and truthful work choreography.

**Architecture:** Keep the compact native window, existing sprite player and factual state machine. Add a local life director and body layer; use separately bounded native motion with temporary-placement protection for short walks.

**Tech Stack:** Existing JS/TypeScript tests, CSS, Tauri/Rust, Mini Playwright and embedded WebKit driver.

**Spec:** `docs/superpowers/specs/2026-11-02-cc-pet-life-design.md`

## Global Constraints

- Preserve CC's own luminous character; reference behavior only, no imported Clawd artwork/hooks.
- No primary Mac tests/builds/input/focus; Mini only, isolated state, no production daemon/models/WeChat/accounts.
- Real permissions, failures, connection and task facts supersede decoration. No invented completion or auto-send/approval.
- Quiet/reduced/hidden stops motion immediately; no historical celebration on resume.
- Walk only near current screen bottom, horizontal ±48 logical points, approximately 3 seconds round trip, no screen crossing.
- User-saved position must survive all temporary autonomous motion and cancellation paths.
- root is sole product writer/integrator, then Mini validates the exact combined dev source before deployment.

## Review Focus

- Late motion after pointer/focus/manual drag/reset/resize/visibility cancellation: test token invalidation and serialization in Task 2.
- Autonomous Moved/close/quit persisting a temporary location: test central persistence guard and reopen in Task 2/3.
- Work→permission/error/hidden during put-away or celebration: test immediate factual preemption in Task 1/3.
- Dozing/roaming over a visible task card or offline state: test all availability gates in Task 3.
- Tiny/negative-coordinate/different-DPI work areas: test pure bounds and actual native geometry in Task 2/3.

### Task 1: Local life director and body choreography

**Files:** create `apps/desktop/src/pet/life/life-director.js`, `.test.ts`, `body-motion.js`, `.test.ts`; modify `pet/pet.js`, `companion-window.html/css`, `pet/renderer/prop-layer.js` as needed.

**Interfaces:** director consumes factual snapshot + suppression/near/blocked flags and injected clock/random; emits `{action, direction}`. Drag feedback accepts finite velocity and explicit moved release. The state machine remains the factual authority.

- [ ] Write tests for idle probe/stretch/doze/wake, work-enter/work-exit/real done chain, priority interruption and timer destruction; run Mini RED before production code.
- [ ] Implement director with 20–40s idle gaps and 180s doze, 350ms prepare and 300ms put-away; add bounded body pose renderer preserving feet and facts.
- [ ] Mini GREEN plus existing pet/renderer/props tests; record and commit.

### Task 2: Bounded native walk and drag feedback

**Files:** create `apps/desktop/src/companion-motion.js`, `.test.ts`, `apps/desktop/src-tauri/src/companion_motion.rs`; modify `lib.rs`, `companion-drag.js`, `.test.ts`.

**Interfaces:** `companion_motion_context` returns logical origin/bounds plus generation token; `step_companion_motion(token,offset)` validates current display/visibility and ±48 bounds; `stop_companion_motion` invalidates without accepting temporary placement. Manual movement explicitly adopts a new position only after actual drag movement. Motion scheduler owns at most one request in flight and fresh post-stop delays.

- [ ] Write geometry/temporary-placement/token and async late-response tests, including click/cancel without landing; Mini RED.
- [ ] Implement pure bounds/session state and fixed companion-only commands; all persistence paths honor temporary position, explicit drag/resize/reset invalidate old movement. Add velocity and confirmed moved-release callbacks without changing activation semantics.
- [ ] Mini GREEN including Rust unit tests, drag and existing placement tests; record and commit.

### Task 3: Live integration and visible/native proof

**Files:** modify `companion-window.js`, native QA exact allowlist and `macmini-embedded-ui.mjs`, `macmini-ui-remote.mjs`; add browser `companion-life.spec.ts`; extend relevant wiring tests.

**Interfaces:** window feeds latest task/connection/preferences and whole-shell pointer/focus/visibility controls to local life and motion. Native QA uses actual commands and geometry; fixtures remain isolated and synthetic input is identified as such.

- [ ] Add meaningful visible sequence and cancellation regressions; Mini RED before corresponding wiring changes.
- [ ] Wire body/director/short-walk/drag velocity, explicit stop before window controls, and cleanup. Extend QA only within existing debug/Mini boundary.
- [ ] Mini affected/typecheck/depcheck/guards, full-platform, browser and native suites; inspect actual screenshots/phase geometry; commit after GREEN.
- [ ] One fresh whole-branch review, one tested fix pass for material findings. Fetch dev, integrate in root-owned integration worktree; rerun exact-head full/browser/native and production build on Mini.
- [ ] Verify CI, sign exact Mini app on primary, retain full old bundle and consistent data backup, serialize protected deploy and actual selftests. Record receipts and final outcome without primary GUI input.
