# CC coordinated performances implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver coordinated CC body, feet, eyes and C performances in the daily desktop companion.

**Architecture:** A separate numeric performance plan drives transient transforms on the frozen Blender scene. Paired PNGs and masks register as optional `life-*` states; the existing player chooses these for local life actions and falls back to its existing choreography.

**Tech Stack:** Blender 5.2.1, Python, JavaScript, Vitest, Tauri/WebKit.

**Spec:** docs/superpowers/specs/2026-11-03-cc-motion-performance-design.md

## Global Constraints

- Frozen source/base/camera/materials/canonical/transition bytes remain unchanged.
- Separate performance profile; no existing fixed-body test is removed or weakened.
- 512×512, anchor [0.5,0.91796875], safe bounds [80,28,432,470], paired shared masks and existing alpha rules.
- All tests, renders, builds and UI validation on registered Mini; no primary input/focus, no Mini production accounts/daemon.
- Root is sole product writer/integrator. User already authorized dev merge and daily deployment, with full rollback backup.

## Review Focus

- A failed optional frame must not restart an infinite error loop or remove factual task behavior.
- Permission/error/new work during a performance must interrupt it without delayed completion or stale movement.
- Body transforms must carry the eyes and C together without double-transforming the C's world-space mesh.
- A support foot must stay planted while its peer lifts, with no camera-dependent ground clipping.
- Work-exit plus real completion must celebrate once and return to the current actual task.

### Task 1: Coordinated recipes and transient rig

**Files:** new `cc-performance-recipes.mjs`, `cc_performance_geometry.py` and corresponding script tests; modify `render-cc.py`.

**Interfaces:** `buildPerformancePlan()` → schema2 paired plan; each sample supplies existing eye/C fields plus bounded body/foot controls. `body_point(point, controls)` and `foot_point(point, pivot, controls)` supply pure geometry math; Blender adapter uses equivalent matrices and saved base matrices.

- [x] Write tests for closed loops, canonical endpoints, anticipation/recovery, alternate foot support, finite bounded inputs, rooted-body/eye correspondence and positive deformation determinant.
- [x] Run new tests on Mini and record expected missing-feature RED.
- [x] Implement seven recipes and reset-safe transient rig, separate output/checkpoint namespace and exact frozen-source checks.
- [x] Run tests GREEN, render representative poses on Mini, inspect contact sheets before full render.
- [x] Commit recipe/rig source after Mini verification.

### Task 2: Validated assets and runtime selection

**Files:** new `register-cc-performance.mjs` and tests, new `pet/life/performance.js` and tests; modify `pet.js`, `body-motion.js/css`, asset manifest and performance assets.

**Interfaces:** registration accepts only complete provenance-matched seven-clip pairs. `resolvePerformance(manifest, form, action)` returns an optional animation. Existing normalized form states carry `life-*` entries, so existing bad-frame removal applies.

- [x] Write runtime RED tests for authored selection, CSS suppression, interruption, missing-frame fallback and one actual completion.
- [x] Implement selection without changing factual state; suppress duplicated body effects only while authored frames play.
- [ ] Render all pairs on Mini; register only after digest, shared mask, bounds, alpha, ground/contact and frozen-byte verification.
- [ ] Inspect playback/contact sheets and 48/96/128px samples. Run existing and new affected tests GREEN on Mini.
- [ ] Commit verified runtime and assets.

### Task 3: Review, integrate and deliver

**Files:** test/lab integration lists only if needed, art documentation and evidence index.

- [ ] Fresh independent whole-branch review. Fix important findings with actual Mini RED→GREEN; preserve evidence.
- [ ] Merge in root-owned integration worktree from fresh dev, then Mini full verification, browser/native QA and production build on exact merged source.
- [ ] Push dev and verify exact-head CI. Back up daily full signed app/state, sign Mini artifact on primary, deploy serially through existing guards/selftests and retain compatible rollback.
- [ ] Report the actual delivered revision, visual preview and material coverage limits.
