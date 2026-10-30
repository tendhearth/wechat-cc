# CC Materials Round Two Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Produce twenty paired frozen-model views and five motion/prop composition studies, with offline review artifacts and unchanged production art.

**Architecture:** Reuse the owned isolated worktree on a new branch from dev. A new study wrapper loads the unchanged renderer through its verified cached sample, derives two explicit study-only function adaptations in memory, and renders with a cloned camera. A separate review builder validates candidate PNGs and creates paired contact sheets and self-contained previews; composition uses the real prop slot constants.

**Tech Stack:** Blender 5.2.1 LTS / bundled Python+NumPy; Node26, Bun1.3.13, Sharp0.34.5, Playwright1.61.1 and headless Chromium1228 on Mini.

**Spec:** `docs/superpowers/specs/2026-10-30-cc-materials-round-two-design.md`; owner requested continuation without questions, so root selects routine details and executes inline, with a fresh whole-branch review.

## Global Constraints

- Root sole writer/integrator: `/Users/nategu_mac_company/.codex/worktrees/cc-macmini-ui/wechat-cc`, `codex/cc-materials-round-two`, base `10e15dab4209b50fd5d1c13eee596450e3347891`. Reuse existing linked worktree; preserve completed deployment ledgers.
- All execution on `homes-mac-mini`, existing lab `/Users/home/cc-ui-lab/cc-motion-drag-20261030`; serialize through its execution lock. No primary GUI, input, heavy tests or rendering. No Mini real backend/accounts/private state/signing keys.
- Preserve all original art, frozen script, geometry and checkpoints; new outputs under `apps/desktop/art/cc-v1/studies/turnarounds-r2` and `compositions-r2`. Runtime manifest stays byte-identical; candidate status never becomes reviewed automatically.
- 512×512 RGBA8; anchor `(256,470)`; safe bbox `[80,28,432,470)`; shared masks, opaque alpha preserved, exterior ≤89, Dark no exterior alpha. Common study scale ≥3.85, seed11, final96 samples, threads2.
- Download only verified official public Blender archive; actual rendering/tests use existing offline profile and fresh state. Keep source/tool digests in receipts.

## Review Focus

- A changed source, damaged checkpoint or half-render must not be silently reused.
- New camera registration must not mutate original camera/data or apply per-view resizing.
- Occluded rear eyes must not weaken the original renderer or front-eye checks.
- Preview/combination outputs must not overwrite inputs or present fabricated runtime facts.
- Composition sizing must match actual prop slots at 48/96/128/256px and preserve face readability.

### Task 1: Non-destructive paired view study

**Files:** create `apps/desktop/scripts/cc_turnaround_study.py`, `cc_turnaround_study_test.py`, `render-cc-turnarounds.py`, and `art/cc-v1/studies/turnarounds-r2/` data. Original `render-cc.py` stays unchanged.

**Interfaces:** pure study module defines `views()`, `orbit(yaw,pitch,scale)`, `derive_render_pair(source,context)`, output/provenance checks. Wrapper accepts `--output`, `--samples`, `--threads`, `--views`, `--resume`; records per-view parameters, three file digests and complete/partial status. Original cached bootstrap must match all existing motion samples and original renderer identity before execution.

- [x] Write stdlib tests for front/right/rear orbit, twenty unique valid views, invalid/singular angles, protected/overlapping outputs, damaged resume records and adapter changes preserving all unrelated assertions; run RED on Mini.
- [x] Implement pure recipe and fail-closed adapter: only wrap the named white-eye assertion with per-view requirement and zero the original fixed `shadow` assignment. Require exactly one match each; copy function AST, never edit the frozen file.
- [x] Implement wrapper with original object/data camera snapshot, cloned camera, common-scale projection fit, existing foot registration, fresh temporary raw output and digest-protected resume. Validate protected bytes in `finally`.
- [x] Provision public Blender, run pilot front/right/rear/raised-front at24 samples in a separate ignored folder; inspect registration, eyes and materials. Fix evidence-backed issues before full rendering.
- [x] Render all20 pairs at96 samples/threads2 under Mini offline profile. Expect40 character PNGs+20 masks, finite metadata and unchanged protected inputs. Commit source and candidate data.

### Task 2: Directional validation and review artifacts

**Files:** create `validate-cc-turnaround-studies.mjs`, `build-cc-turnaround-review.mjs`, associated tests and candidate review outputs.

**Interfaces:** validator consumes study index+asset root and returns per-pair metrics/digests; builder consumes fully validated index and explicit empty/new output. Outputs four-size sheets, a portable offline HTML with embedded images, and summary.json. Original canonical bytes are labeled references and excluded from new-view counts.

- [x] Run RED fixtures for unsafe paths/output overlap, malformed/corrupt PNG, mismatched masks, exterior Dark haze, overwritten opaque entity, invalid baseline and count/metadata mismatch.
- [x] Implement strict decode and alpha/bounds checks, fresh-output guard, contact sheets and standalone viewer; horizontal orbit plays only on request, pauses on hidden/reduced motion, no network requests.
- [x] Verify fixtures GREEN and actual20-pair pack. Run offline browser checks for playback/pause/replay, both forms and no external requests. Inspect sheets at48/96/128/256 on both backgrounds and record findings. Commit.

### Task 3: Continuous motion with approved props

**Files:** create `build-cc-composition-studies.mjs`, associated tests and `art/cc-v1/studies/compositions-r2/`; update art index/README and stale props status documentation only where verified.

**Interfaces:** five declared scenes consume existing catalog clips, approved prop PNGs, `SLOTS`/`PROP_SLOTS` and anchor. Outputs full-sequence four-size contact sheets, paired replayable samples and source/slot digests, not runtime sprites or a modified manifest.

- [x] Establish rendering coordinates from the real prop CSS/constants; test against actual DOM geometry at all4 sizes on Mini. Test strict missing/bad assets, safe output and mask-independent scene alpha accounting.
- [x] Build five complete scenes with original frame timing and 0 unread badges. Validate no prop opaque coverage over Dark white-eye pixels, source bytes preserved, no fabricated task state in preview.
- [x] Run meaningful sample timing/offline browser and original asset-kit guards, plus affected verification on Mini. Expect five scenes, full timelines, valid pixel outputs and protected-source checks green.
- [x] Get one fresh-context correctness/artifact review of the branch. Fix material findings with reproductions; keep new studies candidate. Commit and deliver saved review paths; do not replace daily app art as part of this batch.

## Completion evidence

See [verification report](../reports/2026-10-30-cc-materials-round-two.md). Final fresh full render:20 pairs/96 samples/CPU2, all protected bytes unchanged. Mini affected verification and independent artifact review passed. New candidate data stays on the isolated branch; daily CC is unchanged.
