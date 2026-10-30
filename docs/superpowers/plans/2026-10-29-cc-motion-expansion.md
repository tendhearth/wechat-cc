# CC Motion Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand CC's authored animation library and add useful, quiet companion controls during the authorized eight-hour task.

**Architecture:** Keep the manifest-driven renderer and real-event bridge. Render new frame paths from the frozen Blender source, preserve old single-frame fallbacks, and isolate companion preferences from daemon facts. Main agent integrates commits on its feature branch; implementation helpers use separate worktrees.

**Tech Stack:** Vanilla JavaScript, Vitest, Playwright, Blender 5.2.1 / Python, PNG asset metadata.

**Spec:** `docs/superpowers/specs/2026-10-29-cc-motion-expansion-design.md`

## Global Constraints

- Light means reachable daemon; Dark means unreachable daemon.
- Existing frozen source/camera/material/canonical files retain exact bytes.
- New character frames: 512×512 RGBA PNG, anchor `(256,470)`, safe bbox `[80,28,432,470)`, corresponding Light/Dark frames share one mask path.
- Entity coverage is preserved; exterior alpha ≤89; Dark has no exterior haze or emission.
- New art remains `production-candidate`; no owner review claim.
- Use existing behavior names and true event facts; no new daemon permissions or observation features.
- No shared worktree writes or shared daemon deployment; feature-branch integration only.

## Review Focus

- Null initial completion followed by a true first success emits exactly one done; historical initial values emit none.
- Permissions remain visible during receive/done/blink and quiet periods; rejected one-shots do not recurse forever.
- Changing motion preferences or hiding during a transition leaves the correct form and current facts, with no timer leakage or delayed burst.
- Corrupt preferences, inaccessible storage and clock rollback fail softly; system reduced motion always wins.
- Broken new frames keep same-form canonical fallback; new artwork never changes frozen files or promotes itself to reviewed.

### Task 1: Real-event reliability and quiet controls

**Files:** `apps/desktop/src/pet/bridge/runtime-events*`, `pet/domain/state-machine*`, `pet/pet*`, `pet/renderer/sprite-renderer*`, companion-specific preference/controller modules and tests, `companion-window.{js,html,css}`, main navigation whitelist and focused browser specs.

**Interfaces:** Consumes existing `createPet`, `applyIntent`, `createSpriteRenderer`, `show_main_window(page)`. Produces live motion preference/pause controls and a keyboard-accessible main-window entry; does not change manifest frame semantics.

- [x] Add and run failing tests for first-null completion, duplicate/initial observations, persistent permission precedence and held one-shots.
- [x] Implement minimal fixes, preserving blink/look while companion is idle and real error priority.
- [x] Add failing tests for dynamic reduced motion, pause/resume, no queued quiet-period celebration and hidden-window timers.
- [x] Implement `setReducedMotion` / visibility pause through semantic pet/renderer APIs; keep current facts and suppress decorative work.
- [x] Add locally persisted user reduced-motion and one-hour quiet controls; handle unavailable storage and invalid values. System reduced motion cannot be overridden.
- [x] Add one main-window button using existing navigation command and bounded destination whitelist, with browser fallback and keyboard semantics.
- [x] Run focused pet/unit/browser tests; commit in helper's own branch and report exact commands/results.

### Task 2: Frozen-source continuous animation materials

**Files:** New motion recipe/catalog module, Blender motion render entry or guarded extension of `apps/desktop/scripts/render-cc.py`, new `src/assets/pet/cc-v1/motion/` frames/masks and metadata, focused asset tests.

**Interfaces:** Consumes frozen `.blend` and existing manifest contract. Produces corresponding Light/Dark sequences, fps/loop metadata, reproducible recipe and provenance; old static paths remain usable.

- [x] Write failing recipe/registration tests: valid fixed canvas, frame count, closed loops, matching paired mask paths, candidate status and frozen-source digests.
- [x] Add deterministic small-amplitude C/eye recipes for thinking, working, permission, receive, done and look; no body/camera drift.
- [x] Render a small sample first, inspect silhouette, eye visibility, shading and alpha; estimate runtime and render serially with bounded threads.
- [x] Render the remaining useful sequences. Record parameters, masks and digests without touching frozen bytes or copying private boards.
- [x] Run validator and focused asset tests; render review contact sheets on light/dark backgrounds at useful sizes; commit.

### Task 3: Motion review and scene preview

**Files:** Production-aware motion review generator; isolated review HTML/CSS/JS under `apps/desktop/art/cc-v1/motion/`; optional focused enhancements to pet-lab and tests.

**Interfaces:** Consumes Task 2's motion catalog and frames. Produces a self-contained review entry with actual fps, both forms, reduced motion, selected sequences and runtime facts/asset status clearly separated.

- [x] Add meaningful failing tests for missing/corrupt assets and catalog-to-preview resolution.
- [x] Generate contact sheets and a preview with pause/step/play, form and display-size controls; use existing design tokens and no decorative controls.
- [x] Exercise normal/reduced/broken-frame scenarios in an isolated browser on an unused port; inspect captured images.
- [x] Record evidence and commit.

### Task 4: Integration, validation and delivery

**Files:** Integration fixes, current asset documentation, focused verification report and plan checklist.

**Interfaces:** Consumes Tasks 1–3, preserving their asset/runtime boundary.

- [x] Integrate each helper commit serially onto the main feature branch and inspect cumulative diff.
- [x] Run all pet tests and relevant browser coverage, validator, `git diff --check`, then `bun run verify`. Check load before any full run.
- [x] Have an independent reviewer inspect the complete branch against spec, tests and real failure modes; resolve material findings with regression tests.
- [x] Update current docs with exact counts, commands, candidate boundaries and remaining native/owner checks.
- [x] Use remaining authorized time for quality revisions and valuable materials, not duplicate tests or inflated frame counts. Deliver branch/commits plus visual review entry after the task window.

### Task 5: Bring true-state motion to the home hero

**Files:** New `apps/desktop/src/modules/now-hero.js` and tests; focused edits to `now-page.js`/tests, `workbench-attention.js`/tests, `cc-now.css`, main conversation snapshot hook and focused browser coverage.

**Interfaces:** Consumes existing presence, attention/progress, terminal and conversation snapshots plus Task1 semantic pet motion APIs. Reuses manifest and `createPet`; no additional request or independent frame scheduler. Produces home-hero actions while retaining static canonical fallback and existing bubble/click navigation.

- [x] Establish RED for independent initial baselines, true working→replied vs disappearing requests, duplicate/hidden/reconnect/reduced suppression, permission priority and destroy-before-asset-load.
- [x] Forward optional progress/moved data from the existing attention request without changing existing notification behavior. Old daemon with no progress remains supported.
- [x] Add a scoped runtime layer inside the stable hero button, retain immediate two-canonical fallback, and avoid importing companion global styles or double breathing.
- [x] Observe document/pane/home-chat visibility, consume inactive facts, pause timers, and resume aligned without bursts. Listen for dynamic system reduction; new controls must not override it.
- [x] Preserve the bubble and waiting-list behavior and run focused real-component/unit/browser tests at one worker on an unused port. Commit in its isolated helper branch.
- [x] Independent task review before feature-branch integration; repeat integration tests with the actual new paired catalog.

### Task 6: Remember a safe companion window placement

**Files:** Focused Rust companion layout module/tests and `src-tauri/src/lib.rs` wiring; existing companion settings button/wiring and focused browser/static guards if needed. No new dependency or lockfile edit.

**Interfaces:** Consumes trusted companion window only, current monitor bounds and existing Tauri app-data path. Produces best-effort local UI placement persistence, restore and reset; daemon/config/permissions are unchanged.

- [x] RED for malformed/stale placement, negative multi-monitor coordinates, removed monitor, changed scale, small monitor and valid same-monitor restore. Width200–600,height250–750 logicalpx remain bounds.
- [x] Persist normal close and successful zoom size/position best-effort in a versioned local UI preference; atomic replacement, no unbounded event writes. Restore into a current visible monitor before showing; invalid/unreadable data falls back to defaults.
- [x] Add trusted reset-position command and one secondary「回到屏幕边缘」button inside existing settings. Browser preview cannot pretend native movement succeeded.
- [x] Run focused native pure-layout tests and bounded native type/build check in own target directory when CPU permits; no daemon, app install, shared targets or production preference mutation.
- [x] Independent review, integrate serially and verify in isolated QA native app before claiming native placement worked.

### Task 7: Shareable paired motion samples

**Files:** A focused offline `apps/desktop/scripts/build-cc-motion-samples.mjs`, meaningful unit/integration tests, and brief usage documentation beside the motion review entry. No runtime changes.

**Interfaces:** Consumes the validated Task2 paired catalog and already-rendered PNG files read-only. Produces an output directory chosen by the caller with one animated WebP per clip and an index poster; both forms must appear simultaneously with equal dimensions. Uses bundled Sharp and available ffmpeg, with no new dependency/lockfile edit.

- [x] Establish RED for incorrect timing/frame counts, missing or mismatched pair paths and invalid output overlap; validate all inputs before writing output.
- [x] Render a calm warm-paper two-column comparison, labels Light CC and Dark CC, clip title and candidate status, with no runtime-state claim. Preserve image aspect/alpha; compose both forms from the same sample index. Do not retime or interpolate generated artwork.
- [x] Use exact catalog fps and loop semantics. Loop clips may loop indefinitely; single gestures must play once and hold their last frame in the provided HTML preview, with replay available. Avoid claiming an animated WebP player's loop policy is universally respected.
- [x] Add a self-contained local HTML preview and static PNG index with useful sizes and relative references. Never embed private design boards, local home paths or user/backend data.
- [x] Verify using a tiny synthetic paired catalog, inspect actual generated metadata and one output image, commit in the isolated delivery worktree, and report. Root will generate and inspect the real catalog once rendering completes.

### Task 8: Original C-pose material studies

**Files:** `apps/desktop/scripts/render-cc-pose-studies.py`, separate `art/cc-v1/studies/c-poses/` paired stills, shared masks, source/digest metadata and a static design guide. No runtime behavior or manifest changes.

**Interfaces:** Reuses the unchanged production renderer and exact frozen scene through a cached, verified completed motion sample. Requires the primary batch to have finished. Redirects all additional render outputs to the study folder and temporary raw directory; validates frozen/source/manifest/progress hashes before and after.

- [x] Render the eight C pose keys already present in the frozen model in both original materials, with unchanged normal eyes, body, feet, lighting and camera. Reuse exact accepted canonical bytes for default.
- [x] Keep new outputs `production-candidate` and explicitly describe these as design studies, not new runtime moods or task states. Include per-file digests, shared mask paths and the actual renderer/source identity.
- [x] Inspect all paired poses at useful sizes on warm paper and slate. Verify safe bounds, fixed feet/body coverage, full Dark matte alpha and Light alpha constraints. Generate a clear paired static guide using new model renders only; no private design board copied.
- [x] Confirm all protected production bytes unchanged, record exact generation/check commands, then commit the study materials and recipe.

### Task 9: Readable companion activity during quiet motion

**Files:** Focused `apps/desktop/src/companion-status.js` and tests, existing companion window JS/status wiring and focused browser coverage. No Rust, daemon, runtime state machine or animation changes.

**Interfaces:** Consumes the existing merged `PetIntent` and current pending-permission count. Produces a bounded plain-language status in the existing settings status row and the CC image accessibility label. Adds no permanent visual element, request, timer, sound or system notification.

- [x] RED for Light idle, thinking, working, companion, pending permission and Dark connection semantics; unknown input fails to the connection-only text. Reuse existing words: `已连接`, `暂时联系不上`, `想一想`, `正在做`, `等你决定`, `陪伴中`.
- [x] When connected, current pending permission outranks a lower activity phase. Offline/unreachable remains `暂时联系不上` without presenting stale activity as current. Decorative receive/done/blink/look and quiet/reduced toggles never manufacture task progress or success text.
- [x] Keep idle text and aria label exactly as now. For meaningful active facts, extend existing status text with ` · ` and aria label with `，`. Do not include task titles, message contents, file names or any unbounded backend text.
- [x] Wire the formatter into the existing apply function, deriving facts from the same bridge tick. The single main action stays「找 CC」; no new visible row or settings action.
- [x] Verify permission/activity remains readable while quiet or reduced, repeated facts do not announce different text, and current connection remains correct. Use focused unit/browser tests on an isolated dry-run port, commit in the assigned worktree and report. Root will review and integrate.

### Task 10: Quiet expiry after machine suspend

**Files:** `companion-preferences.js`/tests and minimal existing snapshot hooks in `companion-window.js`, `modules/now-hero.js` with their focused regressions. No Rust, assets, renderer, daemon, dependency or new polling/timer source.

**Interfaces:** Keeps the existing motion preference API/storage key. Quiet is bounded by the earlier of its fixed wall deadline and monotonic elapsed deadline. A wall rollback cannot extend it; a suspended monotonic clock cannot extend it after the wall hour expires. A forward wall jump may end quiet early. This intentionally replaces the earlier test policy that preserved quiet across arbitrary forward wall jumps.

- [x] RED for wall advancing past the hour while monotonic time stands still, persisted quiet resumed after suspend, a partial wall advance reducing remaining time, rollback/timeout bounds and repeated refresh without duplicate expiry notifications.
- [x] Keep one original one-hour wall deadline alongside elapsed time. Persist only a valid bounded remaining deadline, tolerate corrupt/unavailable storage, preserve reduced-motion/system precedence and cancel owned timers on destroy.
- [x] On existing snapshot updates, reconcile expiry even if a machine wake produces no visibility event. Consume newly observed facts while the previous quiet suppression still applies, then reconcile preferences, so work completed during suspend/quiet cannot burst into a delayed celebration. Current permission and error facts remain usable.
- [x] Prove this ordering through actual companion/home integration regressions; no new poller, interval, wake listener requiring permissions, or independent frame clock. Retain all first-null/duplicate/reconnect/hidden safeguards.
- [x] Run focused meaningful RED→GREEN, bounded typecheck and relevant browser coverage in the assigned worktree, commit code/tests only, keep the full report ignored, and hand back for scoped review and root native verification. Do not suspend the user's machine.

### Current validation boundary

The final whole-branch review and its single consolidated fix-wave re-review are complete. Recovery baselines, companion reduced-motion recovery and fade completion findings are addressed; final source is integrated at `66c79e3c`. The unchanged local pending→future reply browser regression still passes, with an added already-arrived reply check. Root's full verification passed (Bun 13,788 tests; Node 11,607 tests; typecheck and depcheck), the isolated native package rebuilt successfully, and current-code real-hour quiet expiry completed. The final three-hour runtime soak passed with 10,800,532 active ms, 63 cycles/812 phases and clean shutdown; the separate one-hour archived-static-art baseline also passed. Resource differences and residual RSS growth are recorded without a leak-freedom or native-memory claim.

After a normal unlock, native WebKit smoke checks observed paired working art, the live working status, reduced-motion controls, Find CC and applied quiet-off controls after a simulated two-hour wall jump. The full native fresh-completion recovery chain was not confirmed before the Mac locked again. Earlier physical Retina placement checks remain valid. Native dragging, physical mixed DPI, Windows, actual OS sleep and owner visual approval remain unverified. See the [delivery record](../reports/2026-10-29-cc-motion-verification.md) and [structured evidence](../reports/2026-10-29-cc-motion-evidence.json) for exact scope.
