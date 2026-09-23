# Signal prop revision — current

- Exclamation uses saturated warm orange soft material for permission visibility.
- Micro-light uses stronger self-emission and a separate HDR Fog Glow pass;
  the measured bloom is composited behind the surface and fades before the 12px border.
- Only these two prop PNGs changed. All character PNGs, frozen .blend, masks,
  transitions and the other five props remain byte-identical to e1ad4c16.
- Validator: 85 assets, 0 errors. Directed Vitest: 14 files, 169 tests passed.
- Inspected updated light/dark sheets; browser loaded both revised props in both
  forms at 384px. Evidence: props/revision-signals-results.json and its browser log.
- Native QA app rebuilt successfully with the revised bytes. Real wallpaper
  transparency remains pending owner inspection. Candidate statuses retained;
  no reverse-transition change, push or PR.
- Earlier seven-prop browser screenshots/results below are historical, not a
  claim that those screenshots show this revision.

---

# Seven props — prior batch

- Seven existing prop PNGs replaced with 384×384 RGBA8 Blender/Cycles candidates,
  using an independent scene. All character assets and frozen source remain unchanged
  by this batch; the preceding thinking-only correction is commit 4765e12a.
- Validator: 85 assets, 0 errors. Directed Vitest: 14 files, 169 tests passed.
  New tests cover prop metadata/dimensions/padding, rejected missing registration,
  and rejection of a prop substituted into a character slot. Character decoder
  calls still require 512px; props explicitly request 384px.
- Inspected seven renders on light/dark review sheets; softened the initial star
  silhouette/color, speech tail and cloud shading before candidate registration.
- Browser verified 7 props × 2 forms, loaded at 384px, unchanged renderer slots;
  working+laptop and thinking+mug screenshots saved. Thinking/sleep both checked
  again in each form. No new missing-frame warnings; reverse form switch still
  reports its existing lit-to-unlit fade fallback. Deprecated sprout UI removed.
- QA app rebuilt with this manifest/assets. No new native desktop-composite review
  is claimed. Props and corrected thinking remain owner-review candidates.
- Evidence and current manifest digest: props/results.json; all network cache
  testing overrides restored. No push or publication performed.

---

# Thinking silhouette correction

- Thinking now selects the existing raised/forward listening C with squint eyes;
  sleep remains low C. No frozen mesh, pose-key data, camera, material or light changed.
- Both thinking frames share the existing listening mask. Only those two PNGs
  rerendered via --expressions-only --behavior thinking; canonical/transitions untouched.
- Compared thinking/sleep at actual 96 px and 256 px on both backgrounds:
  thinking has an open elevated hook, sleep has the low forward fold.
  Comparison: thinking-vs-sleep.png.
- Validator: 78 assets, 0 errors. Directed Vitest: 14 files, 167 tests passed.
- Owner accepted other second-batch performances; their state/frame statuses now
  reviewed-production. Revised thinking remains a candidate for owner inspection.
- Prior expression-qa captures show the prior thinking pose and are historical;
  full browser recheck will accompany the following prop batch.

---

# Previous second-batch expressions

- Owner accepted base geometry, camera, Light/Dark materials and lighting at
  a6b28e2a. Frozen .blend/camera/canonical/transition/mask hashes recorded and tested.
- Added 16 expression PNGs and 5 shared pose masks using --expressions-only from
  that frozen .blend, 96 Cycles samples. No baseline asset bytes changed.
- Both forms now declare all 13 behaviors. Eight authored performances replace
  rest placeholders; companion uses canonical, wake retains half→canonical.
- Validator: 78 assets, 0 errors. Directed Vitest: 14 files, 167 tests passed.
  Added behavior/mask integration, frozen-file hashes, body/foot coverage and two-eye
  shape checks (crescent, squint, larger eyes, shifted gaze); working fallback tests
  now use the authored PNG. The initial tests failed against rest/missing frames.
- Inspected both 13-slot contact sheets, happy crescent close-up and live lab images.
  Same pose masks are shared by happy done/receive and excited error/drag.
- Browser pet-lab normal and reduced each loaded 13 behaviors in both forms;
  short one-shots captured through DOM load observation. Actual drag used the
  beginDrag/endDrag button, preserving state-machine semantics. Dark→Light eight
  frames played; reverse form switch retains the prior fade fallback warning.
- Browser network-block test: broken Dark working frame fell back to Dark canonical
  while preserving working; unblocked load restored working.png. Overrides removed.
  Raw browser observations/screenshots and manifest hash: expression-qa/.
- Native QA app rebuilt. Real wallpaper compositing remains owner-only pending;
  no current native playback screenshot is claimed. New expressions are candidates;
  approved canonical/idle/companion are reviewed-production, overall kit remains
  normative-placeholder because turnaround/prop production is unfinished.

---

# Previous broad Facing / C volume revision

- 96-sample Cycles regeneration completed for canonical, blink, sleep and eight
  transitions. Inspected before/after, surface without exterior glow and animation
  contact sheets; C has a broad tube gradient instead of a thin bright outline.
- Direct C scan at y=205: luminance range approximately 29 levels, previously 15;
  outer-side transition extends across 30 px. Exact method/samples in facing-profile.json.
- Validator: 57 assets, 0 errors. Directed Vitest: 14 files, 163 tests passed.
- Both masks byte-identical to 431dc26b. Dark settings unchanged; rerender RGB
  differs by at most 1/255 in 10 idle/rest pixels, 5 half-blink, 3 closed-blink
  and 3 sleep pixels. Dark alpha unchanged.
- QA app rebuilt with this revision. Native playback and physical wallpaper
  compositing were not rerun; no previous native screenshots are current evidence.
- Light remains production-candidate pending owner confirmation; geometry and Dark
  remain design-frozen. Second-batch behavior performances have not begun.

---

# Previous Light lamp revision

- 96-sample Cycles renders completed for idle, blink and sleep; eight transitions
  regenerated from the new endpoints. Geometry fingerprint and camera unchanged.
- Inspected white/charcoal canonical comparison, no-exterior-glow Light surface
  and animation sheet. Base is luminous again; central shading is localized,
  C retains tube shading, and wider bloom stays within the effect contract.
- Validator: 57 assets, 0 errors. Directed Vitest: 14 files, 163 tests passed.
- Both entity masks are byte-identical to 2b7f22d3. Dark material and light settings
  unchanged; RGB rounding differs by at most 1/255 in 7 idle/rest pixels, 2 closed
  blink pixels, 3 sleep pixels, and zero half-blink pixels. Dark alpha is unchanged.
- QA app rebuilt with current assets. Native playback was not rechecked this turn;
  existing revision-v3 screenshots do not represent these materials. External
  desktop compositing and owner Light visual approval remain pending.
- Geometry and Dark treated as design-frozen per owner instruction; Light remains
  production-candidate. No new behavior performances were produced.

---

# Previous Light volume revision

- Rendered canonical, blink, sleep and all eight transition frames at 96 Cycles
  samples. Model fingerprint and fixed camera are unchanged from a6a63c59.
- Inspected direct Light surface without exterior effects, the before/after sheet,
  and both forms' blink/sleep contact sheet. Upper body/C remain bright, central
  body and peach base carry volume, and matte black eyes have clean interiors.
- Validator: 57 assets, zero errors. Directed tests: 14 files, 163 tests passed.
  Shared-mask inequalities, Dark alpha equality, white eyes, body/feet continuity
  and byte-exact transition endpoints remain covered.
- Native QA app rebuilt with these asset bytes. Native playback and external
  wallpaper compositing were not rechecked in this revision; revision-v3 captures
  must not be used as evidence of these new materials. Owner visual review pending.
- Behavior TODOs and production-candidate status retained. No new expression
  performances, geometry changes or production-art approval are claimed.

---

# Previous material / C revision

- All eight pose bounds remeasured at 96 Cycles samples; fixed ortho 3.85,
  highest y=55, default y=104, common feet baseline y=469.
- Dark rear-side contour light and micro-normal material revised; no body emission
  and no exterior effect alpha. Light warm-white material layering revised.
- Default C opening enlarged; sleep/low C bends forward and down. All delivered
  frames regenerated and registered as production candidates, behavior TODOs retained.
- Validator: 57 assets, zero errors. Directed Vitest: 14 files, 163 tests passed.
- Entity inequalities hold; Dark alpha equals entity, Light exterior max89;
  transition PNG endpoints remain byte-exact canonical copies.
- Rebuilt native app: four sizes, reached loop4, 16 loaded paths/window, zero
  image errors. New screenshots: `native-qa/revision-v3/`. Previous native files
  are historical, not evidence for these new asset bytes.
- White/charcoal QA backdrop checks passed for loading/alignment/edges. 48px Dark
  contrast remains subdued. Owner aesthetic approval and external-desktop
  transparency compositing remain pending.

---

# Current candidate validation — steps 1–5 (desktop-composite limitation below)

- Branch `feat/cc-asset-kit-v1-alpha`, isolated CC worktree.
- Entity/effect contract and candidate status validation: 161 tests passed at step 1.
- Eight actual pose silhouettes measured and rerendered at 96 Cycles samples.
  Frozen ortho 3.85, final highest pose y=55; all feet end at y=469.
- Corrected Blender shape-key initialization: normal renders explicitly select default
  instead of leaving all newly created keys active.
- Canonical pair regenerated at 96 samples. Dark alpha equals the pure entity mask;
  Light adds HDR Fog Glow/contact shadow under the three contract inequalities.
- Dark eyes have display-white interiors, camera-only radiance, no bloom contribution.
- `review.png` inspected on white and charcoal: no exterior Dark gray haze; both eyes
  white and visible, two tucked feet, one C; Light glow remains distinct.
- Step 4: 57 registered assets, validator 0 errors; 14 test files / 163 tests pass.
- Both forms render half/closed blink and low-C sleep from the same scene.
  All declared behavior frames are PNGs; unproduced performances use explicit rest
  candidates. Shared blink mask, separate shared sleep mask, exact transition endpoints.
- pet-lab served from this isolated worktree on port 4175: exercised both forms' blink,
  Dark sleep, default → Dark-to-Light transition → Light idle. New geometry throughout,
  no asset warnings; closed eyes and low C visually inspected.
- Step 5: built and ran a real Tauri debug .app, four independent transparent
  windows at 48/96/128/256 CSS px. Reached loop 8 (at least seven complete cycles), 16 unique playback
  paths loaded per window, zero image errors. Deep/light native QA backdrop
  screenshots and exact limitations are in `native-qa/README.md`.
- Actual external-desktop/wallpaper compositing remains unverified because the
  available capture API flattens individual windows and excludes the rear desktop.
  Native QA backdrop captures must not be described as that missing sign-off.
- 48px Dark on charcoal has low silhouette contrast; remains an aesthetic review item.
- This is a production candidate, not owner-approved final art.

<details><summary>Historical validation before the entity/effect revision</summary>

# First-batch validation — 2026-09-08

Scope: production brief §3.1 only. Two canonical idle images, one shared coverage mask,
Blender source, reproducible render script and manifest registration. No commits or push.

## Verified

- Blender 5.2.1 LTS / Cycles / 96 samples completed both renders. Source `.blend` opens,
  has Body, C, Foot.L, Foot.R, Eye.L, Eye.R, fixed orthographic camera and both materials.
- Both PNGs and mask: 512×512 RGBA8, PNG color type 6. Full alpha equality across all
  262,144 pixels, including shared halo and contact shadow support.
- Nonzero alpha bbox (inclusive): `[83,83,428,469]`; safe extent `[80,28,432,470)`.
  Row 469 contains foot-edge coverage; all pixels on/after row 470 are transparent.
  Anchor remains `(256,470)`. No post-render image translation/cropping/resizing.
- Rendered-image inspection by Codex: one C, two feet, two capsule eyes; no mouth,
  arms, ears or tail. Light has warm surface emission and halo; Dark material and eyes
  have zero emission. Contact shadow is dark in both forms after review correction.
- Static 48/96/128/256px composites on light/dark backgrounds: `review.png` and
  `review.html`. These are preview artifacts, never runtime sprites.
- `node apps/desktop/scripts/validate-cc-asset-kit.mjs`: 0 errors, 40 registered assets.
  Anatomy-attestation and unfinished-package warnings remain intentional.
- `bun --bun vitest run apps/desktop/src/pet src/core/pet-turn.test.ts src/core/companion-presence.test.ts`:
  14 files, 139 tests passed. Includes real canonical PNG loading, coverage registration,
  tampered alpha with updated digest, missing-frame → idle → inline fallback, and transition failure.
- pet-lab normal and `?reduced` visited in the app browser. Both new idle PNGs rendered;
  13 behavior buttons exercised in smoke checks, missing Dark states showed same-form
  idle fallback, transition returned to the requested form. Priority suppression during
  rapid button presses is state-machine behavior; this is not complete per-frame art approval.
- Independent code review caught gold-colored Light contact shadow; fixed by separating
  shadow and halo RGB while preserving shared alpha, rerendered, refreshed all three hashes.

## Pending / intentionally incomplete

- Owner aesthetic approval and real Tauri transparent-window review at all four sizes,
  over light and dark desktop backgrounds. The existing debug process was launched,
  but the UI automation could not identify it by executable or bundle ID. No native-window
  inspection is claimed; the temporary debug process was stopped.
- Live browser network-error injection was not performed. Broken-frame fallback is covered
  by the passing runtime tests, including a broken PNG master.
- Expressions, other turnaround views, transitions and props remain legacy placeholders.
  Blink and transition endpoints still use old geometry, so they visibly jump to/from the
  new idle. They are not presented as finished or continuous production animation.
- Per-image `visualReview` names Codex reference comparison and explicitly notes owner review
  pending. Per-image and idle `artStatus` is now `production-candidate`; top-level stays
  `normative-placeholder`.

No presence, pet-turn, state-machine or renderer behavior was changed.

## Visual revision verification

- Rebuilt at 96 samples after owner critique. Revised geometry/materials and measured HDR
  Fog Glow documented in source README. Full alpha bbox above reflects this revised output.
- Validator: 0 errors, 40 assets. All 139 targeted tests passed again after digest registration.
- Glow extends outside opaque geometry (render-time assertion); contour-distance falloff
  eliminates the square safe-bounds haze seen during iteration. Dark remains non-emissive.
- The PNGs were inspected on both backgrounds and at four sizes in the revised review sheet.
  `comparison.png` (holds a crop of the master board; moved to the private `~/Documents/tendhearth/cc-design/`, not in the repo) places the approved reference crop alongside revised previews.
- The revised images remain visual candidates. The prior `reviewed-production` label did
  not establish owner approval and has been removed from these first-batch entries.
- Historical browser behavior/fallback checks above were not reclassified as native or
  visual approval. Native transparent-window review remains pending.

</details>
