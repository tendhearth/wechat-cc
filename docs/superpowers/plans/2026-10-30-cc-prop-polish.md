# CC Prop Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix micro-light falloff, display five existing prop compositions from actual pet state, animate prop appearance/removal, validate on Mini and deploy verified dev to daily CC.

**Architecture:** Pure glow support adapter for the standalone prop source; actual-snapshot composition in pet assembly; keyed prop renderer with injected lifecycle timers. Preserve static tool renderer and existing character transitions. Root sole writer/integrator, independent read-only review.

**Tech Stack:** Existing Blender5.2.1LTS/NumPy, JS/TypeScript/Vitest, headless Chromium, Tauri embedded driver and production build on dedicated Mini.

**Spec:** `docs/superpowers/specs/2026-10-30-cc-prop-polish-design.md`.

## Global Constraints

- Owned feature worktree/branch and base per spec; integration only in owned dev worktree. No other workspace mutations, no primary GUI/input/heavy execution.
- Mini `/Users/home/cc-ui-lab/cc-motion-drag-20261030/project`, existing outbound-deny profile/fresh state/shared execution lock; CPU render threads2/samples96/seed11. No accounts/private DB/production plugins/signing keys.
- Existing14 frozen inputs/character renderer/geometry and other6props exact bytes; onlymicro-lightPNG/metadata change. Newbyte review remains candidate with prior review history.
- Five compositions follow actual behavior, facts win occupied slots; no fabricated unread badge. Opacity160ms, no geometry changes, suppressed motion settles immediately.
- Test-only QA identifier/features remain out of release; whole-app backup + DeveloperID requirements + guarded ship/rollback; no public release.

## Review Focus

- HDR distant tail can form a rectangle even with12pxpadding: test finite geometric support and visible near glow.
- Queued working behind drag/one-shot must not show laptop early; fact props/badges survive behavioral recipe changes.
- Remove/re-add before160ms must not duplicate/delete resurrected nodes; badge updates must not restart appearance.
- Reduced/quiet/paused/destroy during entrance or exit must cancel timers and leave current facts correct.
- Verify actual source/tree and exact CI SHA, not stale template/version/rollback data; native verification must not become OS input on primary.

### Task 1: Actual-state compositions and keyed prop lifecycle

**Files:** `src/pet/renderer/prop-layer.js` and tests; `src/pet/pet.js` and tests; both desktopCSS files; bridge stale comment/test title only.
**Interfaces:** `composeProps(behavior, facts, {decorative})`; `createPropRenderer({container,manifest,makeEl,schedule,cancel})` with render/setMotionSuppressed/destroy. Existing renderProps API remains immediate.

- [ ] Add failing tests for recipes/slot priorities, keyed entry/exit/reentry, badge identity, suppress/destroy and actual bridge→pet state priority; run RED on Mini.
- [ ] Implement recipe projection and keyed renderer; bind actual snapshots and all motion controls; add consistent opacity CSS to both surfaces. Keep old assertions, strengthen changed assumptions.
- [ ] Run GREEN/unit + real browser checks with actual CSS, nodes, assets and mid/final opacity. Add Tauri embedded flow assertions.

### Task 2: Source-driven micro-light correction

**Files:** new `scripts/cc_prop_glow.py` + tests; `render-cc-props.py`; micro-lightPNG + its manifest metadata; standalone QA artifacts.
**Interfaces:** numeric pure support/composite functions using supplied arrays; renderer explicit safe output/art/TMP destinations and onlyselected micro-light.

- [ ] Run RED constant weakHDR with central alpha: distant sample must zero, near exterior nonzero, core unchanged, transparency/border correct.
- [ ] Implement finite smooth contour-distance support and isolated generation; render on Mini, decode/measure/inspect both grounds and4sizes. Preserve original/rawbody/source hashes and all protected files.
- [ ] Register only newmicro-light hash/candidate proof with old review history; run original489asset guard and affected verify. Commit implementation/artifacts.

### Task 3: Integration, release verification and daily deployment

**Files:** final report/spec/plan; new ignored rollout receipts/operators based on known templates, rootowned integration workspace.

- [ ] Fresh independent correctness review; fix reproduced findings, commit clean feature branch.
- [ ] Confirm sole integration/locks/clean dev; merge todev, align exact Mini commit/tree. Run verify --full, browser, embedded-build→embedded, production-build with correct offline/platform scopes.
- [ ] Push dev, wait sameSHA CI green; transfer verified completeapp, fresh whole currentapp backup, valid DevID/team/designated requirements, no QA payload. Swap onlyafterall gates; guarded self ship --skip-build, inspect newhead/6plugins/FDA/guard; rollback wholeapp if failure.
- [ ] Save actual receipts/limits, update report/plan and deliver outcome. No new user question unless a truly nonrecoverable boundary prevents authorized completion.
