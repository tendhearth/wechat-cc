# CC continuous preview implementation plan

**Goal:** implement the owner's five ordered changes, with one commit per step in this isolated worktree.
**Spec:** `docs/superpowers/specs/2026-09-08-cc-asset-production-brief.md`, amended by the owner's explicit entity-mask contract.
**Architecture:** shared Blender geometry and pose keys; one camera fitted from rasterized coverage of all eight poses; independent per-form compositing; manifest-only runtime frame integration.
**Tech stack:** Blender 5.2.1 / bpy / numpy, RGBA8 PNG, Node validator, Vitest, Tauri/WKWebView.

## Constraints

- Worktree `~/Documents/tendhearth/wechat-cc-cc-kit`, branch `feat/cc-asset-kit-v1-alpha`, starting commit `30bd3a80`.
- Never invoke `build-cc-asset-kit.mjs`. Preserve `.blend` and original design boards.
- 512×512 RGBA; anchor `(256,470)`; all nonzero pixels within `[80,28,432,470)`.
- Corresponding forms reference the identical entity-mask path. Per pixel: alpha ≥ mask; mask ≥ 250 implies alpha == mask; mask == 0 implies alpha ≤ 89 (floor of 255×0.35).
- Effect files are not deliverables. Dark body cannot emit light; camera-only white eye appearance cannot illuminate the scene or produce bloom.
- Keep reviewed/candidate/placeholder statuses explicit. Do not claim owner/native review based on unit tests.

## 1 — Contract (commit 1)

Files: `cc-contract.js`, `validate-cc-asset-kit.mjs`, asset tests, brief and README.
- Add failing boundary fixtures (mask 0/249/250/255, alpha 89/90), altered alpha with valid digest, identical bytes under different mask paths, and unknown/missing statuses.
- Export the allowed art-status vocabulary; validate every declared state, transition and asset.
- Implement the three pixel rules and shared-path requirement. Update active prose including transition handling now that alpha can differ.
- Run validator and the targeted pet/presence/pet-turn suite, review, then commit only step-1 files and this plan.
- Existing committed masks are a legacy combined-coverage snapshot; step 3 replaces their source with Dark entity coverage. Do not relabel their provenance prematurely.

## 2 — Eight C poses and camera fitting (commit 2)

Files: `render-cc.py`, source `.blend`, `art/cc-v1/camera-fit.json`, pose contact sheet, source documentation.
- Parameterize default, listening, happy, confused, thinking, low, angry and excited from design-board sections 06/08; keep root attachment and topology shared.
- Rasterize all poses using a roomy measurement camera. Record measured alpha bounds.
- Fit one ortho scale from their union, including a reserved effect margin, quantize upward and rerender all poses to verify final bounds.
- Save the fitted camera and pose table fingerprint; normal production rendering loads this calibration and fails if the pose table has changed. No per-frame fitting or offsets.
- Confirm default pose is restored when saving `.blend`. Commit only step-2 source and calibration artifacts.

## 3 — Independent effects and white Dark eyes (commit 3)

Files: renderer, canonical PNGs, `masks/front.png`, manifest, review artifacts.
- Render the Dark body without effects, preserve its alpha as the entity mask.
- Use a camera-ray white eye shader that is absent from non-camera lighting contribution; bloom is extracted only for Light.
- Composite Light glow/contact shadow and Dark contact shadow independently. Clamp effect coverage at 89/255 outside the entity; restore alpha exactly on mask ≥ 250.
- Register actual hashes and candidate review metadata. Compare white/dark backgrounds and validate pixel rules before committing.

## 4 — Continuous idle/blink/sleep/transitions (commit 4)

Files: renderer, registration/transition utility if needed, runtime frames, masks, manifest, validator endpoint checks, asset/runtime tests.
- Render half/closed eyes with default C; render sleep with closed eyes and low C; all use the calibrated camera and body.
- Blink: canonical → half → closed → half → canonical at 8fps. Sleep loops.
- Generate eight endpoint-exact frames using linear-light premultiplied RGBA interpolation between canonical images; retain exact opaque-core alpha. Preserve endpoint bytes.
- Ensure remaining unproduced behaviors resolve to the new geometry instead of legacy SVG (explicit canonical fallback, candidate performance incomplete). Do not change state-machine priorities.
- Exercise pet-lab normal/reduced, forms, 13 behaviors, transitions and broken-frame fallback; run meaningful pixel/endpoint/runtime tests; commit step 4.

## 5 — Native Tauri visual review (commit 5)

Files: reproducible local QA entry/config if needed, `art/cc-v1/VALIDATION.md`, native screenshots/contact sheet.
- Build or launch a Tauri app from this worktree, visibly verify its actual transparent WKWebView window.
- Inspect sprite sizes 48/96/128/256 at both form values over light and dark backgrounds; include transitions/blinks and baseline/edge inspection.
- Use separate local QA surfaces instead of modifying user desktop preferences or contacting a live daemon.
- Record exactly what was observed, any limitations and screenshot evidence. Commit verification artifacts; no push or merge.

## Execution record

1. `677111d9`: entity/effect contract and candidate status; 161 tests pass.
2. `5c0c2b99`: all eight pose silhouettes measured at 96 samples; fixed ortho 3.85.
3. `e5a723c8`: separate entity coverage, no Dark exterior haze, white unlit eyes; 162 tests pass.
4. `54f4394b`: same-model blink/sleep and eight endpoint-exact transitions; 163 tests pass.
5. Native QA recorded in `apps/desktop/art/cc-v1/native-qa/`: four actual Tauri windows,
   reached loop 8 with 16 frames and zero load errors, eight native backdrop captures.
   External physical desktop compositing remains unverified due to capture limitations.

No push or placeholder rebuild performed.
