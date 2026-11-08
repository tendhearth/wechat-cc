# CC material studies · round two

These are **production-candidate, nonruntime** studies. They do not change the
desktop manifest, daily CC, frozen model or existing registered artwork.

- [Directional review](turnarounds-r2-review/index.html): twenty paired views,
  sixteen horizontal directions and four raised views; forty character PNGs and
  twenty shared masks in `turnarounds-r2/`. The horizontal orbit plays only on
  request. Raised views can be selected as stills.
- [Motion and props](compositions-r2/index.html): five complete timelines,
  working+laptop, thinking+mug/thought-bubble, permission+exclamation,
  receive+envelope and look+micro-light. Both forms, both grounds, no unread badge.
- Each review folder contains `48px`, `96px`, `128px` and `256px` contact sheets
  plus a machine-readable `summary.json`. The HTML embeds its images and requires
  no server or network. Reduced motion and hidden-page changes pause playback.

Source angles use −Y as front, +X as right and +Z as up. Every new direction uses
one orthographic scale. The pre-existing `canonical/front.png` is the accepted
three-quarter view; it is preserved and excluded from the twenty new views.
Rear eyes can be physically occluded. The original renderer is unchanged;
the study adapter alone allows that occlusion and removes its fixed screen-space
contact shadow. Front white-eye and every alpha/safe-bounds assertion remain.

Feet are registered using the original vertex projection followed by a rendered
alpha probe. At most two pixels of camera translation can correct evaluated-mesh
and antialiasing differences; no output bitmap is shifted, cropped or resized
per view. Every final mask reaches row 469 and stays above row 470. The per-view
index records the correction and camera coordinates.

Composition positions come directly from `SLOTS` / `PROP_SLOTS` and the renderer's
centered CSS placement. A 640px review canvas pads the unchanged 512px character
stage by 64px on all sides, preserving the laptop's intentional lower overflow.
Sheet size labels refer to the character stage, excluding that padding. The
viewer preserves the source fps, sample order and loop/single-play behavior.
These compositions do not add runtime task facts or change the presence bridge.

Run rendering and verification only on the dedicated offline Mac mini. The
existing lab operator supplies fresh state, the outbound-deny profile, a shared
execution lock and CPU/thread limits. On the Mini, the source entry points are:

```sh
# Blender 5.2.1 LTS, factory startup, CPU threads2, samples96, seed11.
# New study directories or provenance-identical --resume only.
Blender --background --factory-startup --threads 2 --python-exit-code 1 \
  --python apps/desktop/scripts/render-cc-turnarounds.py -- --threads 2 --samples 96 --resume
node apps/desktop/scripts/validate-cc-turnaround-studies.mjs \
  apps/desktop/art/cc-v1/studies/turnarounds-r2
# Builders require new/empty outputs outside their protected inputs.
node apps/desktop/scripts/build-cc-turnaround-review.mjs \
  apps/desktop/art/cc-v1/studies/turnarounds-r2 /new/directional-review
node apps/desktop/scripts/build-cc-composition-studies.mjs /new/composition-review
```

Set `CC_SHARP_MODULE` to the Mini's installed Sharp module for the two builders.
The headless integration entry point is `verify-cc-material-studies.mjs`; its
receipt distinguishes real DOM geometry, actual playback/reduced-motion checks,
and a synthetic page-visibility event. None uses OS mouse input or screen capture.
Source/PNG hashes, render/tool identities and alpha metrics are retained in the
indices. Automated checks and implementer inspection do not grant owner art approval.
