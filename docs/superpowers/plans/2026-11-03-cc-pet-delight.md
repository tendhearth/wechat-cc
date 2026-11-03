# CC pet acting and delight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give CC clear intention, a distinctive delayed-C physical signature and one quiet, surprising private-curiosity scene.

**Architecture:** Retain the frozen Blender-to-PNG pipeline and existing sprite renderer. Performance schema4 adds bounded vertical eye placement and a curiosity-only rooted C tilt; nine authored clips replace only mutable candidate performance assets. Optional curiosity stays inside the decorative director and ends on actual presentation completion with a generation token.

**Tech Stack:** Blender5.2.1 LTS / Python, vanilla JS, Vitest, Playwright, Tauri/AppKit Mini QA.

**Spec:** `docs/superpowers/specs/2026-11-03-cc-pet-delight-design.md`

## Global Constraints

- Owner delegated design/execution and opted out of intermediate questions. Root uses native execution as the single product writer, with read-only visual/code specialists and the sole Mini executor.
- Existing isolated workspace: `/Users/nategu_mac_company/.codex/worktrees/cc-pet-context/wechat-cc`; branch `codex/cc-pet-delight`, base dev1c324a131cc3b60806636ac021629ea00883645e/tree8f19a17b139c19e83f91e80b7d4ef9a78203d124.
- All tests, renders, builds and graphical checks on Mini; no primary input/focus/window control or heavy workloads. No real daemon/accounts/model credentials/private data on Mini.
- Preserve frozen blend/geometry/camera/materials/lighting/canonical/transition/legacy fixed-body PNG bytes. Existing body/foot envelopes stay except the visually justified carry-only rise≤0.20 (all other rises≤0.13); carry feet≥0.05.512² canvas, anchor[0.5,0.91796875], safe bounds[80,28,432,470), shared masks and alpha contracts stay unchanged.
- Schema4 `gazeUp` is finite and in[-0.04,0.14]; `crestTilt` finite in[-0.18,0.18], zero exceptcuriosity. Nine clips: seven existing counts/rates plus peek-left14@12 and curiosity36@12 =134 pairs. Final96samples/seed11/fourCPUthreads. Draft24samples remains isolated and unregistered.
- Curiosity requires artwork,75s continuously eligible, once per calm episode,30min monotonic window-local cooldown. Opportunity consumed at start. Actual frame completion ends it; no factual state, background catch-up, scene replay or extended180s doze.
- Genuine new-source validation and full compatible app backup precede serial dev integration/daily delivery. Preserve previous receipts, failed attempts and current data.

## Review Focus

- New work/permissions/nearby controls arrive during any curiosity phase: cancel now and reject its old callback; Task2.
- Timers slow or optional frames fail: retain actual scene until its last frame, or settle safely when unavailable; Task2/3.
- Leftward attention could mirror CC's identity: use separate geometry poses, never flip the image; Task1/2.
- Small foot/C/eye changes look neutral or disconnected despite valid math: actual48/96/128 playback samples and independent critique, Task1/3.
- A renderer/schema mismatch could silently publish draft or wrong eye placement: strict schema/provenance/96sample registration and unchanged frozen hashes, Task1/3.

### Task 1: Intentional acting authoring and visual drafts

**Files:**
- Modify `apps/desktop/scripts/cc-performance-recipes.mjs`, `cc_performance_geometry.py`, `render-cc.py`, `register-cc-performance.mjs`.
- Extend `cc-performance-recipes.test.ts`, `cc-performance-geometry.test.ts`, `register-cc-performance.test.ts`, `cc-performance-catalog.test.ts` in that directory.
- Task-only transport/draft ledgers live in ignored `.superpowers/sdd/2026-11-03-cc-pet-delight/`.

**Interfaces:**
- `buildPerformancePlan()` returns schema3 with frame `{pose,eyeScale,crescent,gaze,gazeUp,body,feet}`; `samplePerformance(id,time)` supports the nine exact IDs.
- Python `eye_surface_point(location,gaze,gaze_up)` re-seats eyes on the existing face; zero motion preserves the resting path. `set_eyes` takes optional vertical gaze; nonperformance schema1 remains unchanged.
- Renderer accepts only schema3 for coordinated performances, validates the new field and nine IDs, includes `gazeUp===0` in canonical-rest reuse. Registrar validates schema3/complete nine/provenance before publishing.

- [x] Write meaningful RED tests: schema3/nine134samples; left/right peek have opposite one-target gaze without sign reversal, eyes precede body; body settles before C in landing/completion; carry body-rise minus each foot-lift exceeds0.03 at its held poses; lifted walk foot strides outward while the support foot stays exact identity; vertical eye placement finite/seated/bounded and invalid inputs rejected. Keep all prior endpoint, loop, foot and envelope checks.
- [x] Sole Mini executor records actual assertion RED against exact1c baseline with only owned test overlays, then restores baseline. No primary test execution.
- [x] Implement schema3/gazeUp and the refined nine recipes. Preserve the original seven durations; use repeated knots to hold decisions. Keep all C weights nonnegative and total≤1.
- [x] Run targeted recipe/geometry/registration/catalog checks and typecheck on Mini; resolve actual failures without loosening previous checks.
- [x] Create an isolated Mini draft project from an explicit source/frozen-file manifest. Render representative extrema and complete peek/curiosity/celebrate/carry drafts at24samples, separate paths/progress from the real kit.
- [x] Capture actual draft playback samples with timestamps on paper/slate at48/96/128/256. Review preparation/action/recovery, eye target, delayed C, supported weight and connected feet. Independent visual critic rejects weak poses; revise and repeat the affected draft before final rendering. Do not claim continuous playback watched when evidence is sampled frames.
- [x] Curiosity revision after complete draft critique: observe new Mini RED for C-before-eyes cause, blink→held wide-eyed recoil, and C-rest-before-gaze-drop. Keep36frames/12fps and existing limits; freeze a separate rev3 identity, review extrema then the whole story again.
- [x] Commit authoring code/tests and record exact frozen render inputs. No mutable source changes during a render job.
- [ ] Fresh neutral-title final review rejected the initial96-sample curiosity as generic idle. Preserve rejected48pairs/identity; before more final work, observe new Mini RED for schema4/root-fixed volume-preserving tilt, C-before-eye/second-look timing, exactzero elsewhere, and actual crest-root/determinant rejection. Implement transient localY tilt aboutROOT_C beforebaseC/commonbody, retainzero/legacy path; measure actual C matrices including numerical/canonical reuse. Review extrema and full neutral-title draft before a new immutable final identity.

### Task 2: Optional private curiosity and direction-aware peek

**Files:**
- Modify `apps/desktop/src/pet/life/life-director.js`, `life/performance.js`, `pet.js`.
- Extend `apps/desktop/src/pet/life/life-director.test.ts`, plus focused new director tests if isolation helps.

**Interfaces:**
- `resolvePerformance(manifest,form,action,behavior,direction=1)` selects optional `life-peek-left` for a negative direction, falls back to `life-peek` when absent, and recognizes `life-curiosity` only in valid calm presentation.
- Director gains optional injected monotonic `now`, `setCuriosityAvailable(on)`, and `finishCuriosity(token):boolean`. Only curiosity actions carry a generation `token`; prior action objects retain their existing shape.
- `createPet` passes `opts.monotonicNow ?? opts.now ?? (()=>performance.now())` for the director, preserving existing attention-clock behavior. It updates optional-art availability after loading and bad-frame removal, captures the action token in the real sprite callback and leaves factual completion handling intact.

- [x] Add RED tests on Mini before implementation: no curiosity before75s; first eligible idea can start it; it remains after3s when presentation is unfinished; correct token ends it, stale token cannot; normal observations do not replay it.
- [x] Add the full interruption matrix (work/thinking/permission/error/receive/drag/Dark/unavailable/settings-hidden/quiet/reduced/dispose) during the scene; no fake factual state and no replay on resume. Verify once-per-episode,30min cooldown consumed on interruption, unchanged180s doze, and no scene without artwork.
- [x] Add actual `createPet` integration tests with authored and legacy manifests: direction chooses independent image paths without CSS mirroring; missing/all-bad curiosity frames settle safely;200ms timer clamping finishes only after the real last frame. Preserve all existing throttled factual-done and no-double-motion tests.
- [x] Implement the optional controller path. Keep old peek/stretch/walk/factual clocks and native in-place travel guard unchanged. No generalized scene engine or prop layer.
- [ ] Run affected pet/sprite/mounted-companion tests, typecheck and all guards on Mini. Commit the verified runtime change.

### Task 3: Production art and final visual gate

**Files:**
- Generate `apps/desktop/art/cc-v1/performance/{recipes.json,render-progress.json,catalog.json,samples/*}` and performance actor/mask PNGs under `apps/desktop/src/assets/pet/cc-v1/`.
- Update `manifest.json`, `apps/desktop/src/pet/assets/cc-performance-kit.test.ts`, performance README.

- [x] First extend real asset-profile checks to schema3/nine IDs/134 paired frames and observe actual RED on the old kit. Retain all geometry/alpha/source/digest checks.
- [ ] Freeze accepted authoring inputs. Render each full96sample clip as a separate Mini job with `--clip` and verified resume checkpoints; preserve old kit/progress before the first batch. Never mix draft24 frames into final provenance. Let other legitimate family jobs run between clips.
- [ ] Prepare, do not activate, the complete catalog. Validate402PNGs against source/plan/renderer/helper/sample identities, shared masks, foot clearance, determinant, canvas and safe bounds; verify every frozen/legacy image byte remains unchanged.
- [ ] Produce complete contacts, animated previews and actual HTML-player capture/timing evidence. Require a fresh visual pass after the draft round:96px intention,48px key-pose distinction, connected C/eyes/feet, deliberate contact, no skating/clipping, pleasing final settle and one specifically-CC beat. Revise affected clips if weak even when tests pass.
- [ ] Activate only the accepted final candidate; copy exact bytes to root with a hash ledger. Run actual registered profile/preview tests on Mini. Update README without claiming owner aesthetic approval. Commit source/art and preserve review artifacts.

### Task 4: Native acceptance, independent review and daily delivery

**Files:**
- Extend `apps/desktop/playwright/companion-life.spec.ts`, `apps/desktop/scripts/macmini-embedded-ui.mjs` for actual curiosity playback/cancellation and optional-art fallback; preserve all prior checks.
- New goal-specific operator scripts/receipts in ignored `.superpowers/sdd/2026-11-03-cc-pet-delight/` bind a fresh final head and daily baseline1c324a13. Prior delivery records remain immutable.

- [ ] On Mini, verify actual decoded actor frames, no CSS double movement, ordinary and left peek, completed curiosity plus mid-scene interruption by controls/work/permission/quiet/reduced/hidden, no stale replay, unchanged hit area and bounded native geometry. Keep authoritative task facts readable.
- [ ] Use one fresh whole-branch code review plus an independent final visual review. Fix important findings with actual RED/GREEN. Do not repeat whole review merely because the first pass was accepted.
- [ ] Root alone integrates into its assigned integration workspace from the latest dev. Fast-forward the exact clean Mini checkout with source/ownership guards; run genuine merged `verify --full`, browser, Rust and native UI checks. Import only actual new-tree proof.
- [ ] Freeze a compatible rollback fixture from exact daily1c324a13; test real current-schema write/reopen compatibility on Mini. Build/export the exact unsigned app only there, never launching production identity or copying credentials.
- [ ] Push verified dev normally; require actual exact-head CI with every path-selected job executed. Desktop native acceptance runs on Mini. The unchanged mobile Swift/Kotlin push-vector job may be legitimately skipped for desktop-only paths; preserve its existing Intel runner and verify its source remains unchanged from the already-tested baseline. If new integration changes select that job, require its actual execution too. Before app swap, run real availability gates through an existing configured healthy provider; record temporary selection without global preferences changes.
- [ ] Preserve a complete signed baseline app and consistent private state snapshot. Sign and serially deploy through the actual lock/load/network/source/plugin/FDA gates on the protected primary host, no input/focus or heavy build. Run the same actual workbench image/resume and chat/tool/resume gates; restore the whole compatible app on failure while keeping current DB/WAL.
- [ ] Retain post-update state privately outside pruning, verify installed/running head against dev and Mini payloads, and run an exact-boot initial soak with honest duration. Show the real animated result. Keep goal active if visual review still finds the result merely functional; technical green alone does not satisfy it.
