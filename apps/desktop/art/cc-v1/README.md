# CC Blender production source

## Current props and thinking correction

Thinking uses the existing raised listening C with squint eyes, separated from
low-C sleep without changing the frozen scene. See thinking-vs-sleep.png.
Seven standalone 384px props are in the sibling runtime props folder; reproducible
source is render-cc-props.py, review/evidence in props/. They remain candidates.

## Owner-frozen base and second-batch expressions

Owner accepted geometry, camera and both materials/lights at a6b28e2a. The frozen
`.blend`, canonical images, masks and transition bytes are indexed by
`design-freeze.json`; tests guard their exact bytes.

Render the new performances without overwriting the frozen source or first batch:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --python-exit-code 1 --python apps/desktop/scripts/render-cc.py -- --expressions-only
```

This mode opens the frozen `.blend` and rebinds its objects/materials/camera.
C pose keys are selected without editing their geometry. Eyes reset from the
saved capsule mesh before each frame: default, horizontal squint, bowed crescent,
or 1.15× larger. Look shifts both eyes .07 in X and reseats them on the same face.
No new materials, lights or compositor parameters are used for the character;
only unlit diagnostic eye-coverage materials are created for the existing mask pass.

Eight performances per form are produced: thinking/listening+squint,
working/listening+default, done/happy+crescent, receive/happy+large,
permission/confused+default, error/excited+large, look/default+shift,
drag/excited+default. Companion uses canonical; wake retains half→canonical.
Shared pose masks prevent eye variants from changing silhouette coverage.
`expressions-lit-review.png` and `expressions-unlit-review.png` show all 13 slots.
New performances remain candidates pending owner inspection.

## Historical base construction and material iteration


`cc-v1.blend` retains one Body, one rooted C with eight pose shape keys, two Feet
and two Eyes, the frozen orthographic camera and both material sets. Light/default
is saved active. Blender 5.2.1 LTS / Cycles / 96 samples / seed 11 is the pinned
renderer. Cross-version or device byte reproducibility is not promised.

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --python-exit-code 1 --python apps/desktop/scripts/render-cc.py
```

The script rebuilds the inspectable `.blend`, canonical PNGs, half/closed blink, low-C sleep, shared masks and eight transition PNGs.
It does not update manifest registration or claim owner approval. Do not run
`build-cc-asset-kit.mjs`, which replaces art with historical SVG placeholders.

Light uses warm SSS and emission, plus a true HDR Fog Glow compositor pass.
A contour-distance envelope bounds its effect support; Light may add contact shadow.
Dark has matte charcoal, no body emission, and **no exterior effect pixels**.
Dark eyes use camera-ray-only unlit white: they cannot illuminate the body.
An occluded, antialiased eye coverage pass under Standard view maps eye interiors
to display RGB 255, avoiding AgX's gray compression; it never enters the glow pass.

The entity mask is sampled once from opaque Dark, including AA. Light and Dark
share that file. Effects preserve alpha >= mask, lock mask >= 250, and stay <=89
where mask is zero. Normal rendering explicitly zeroes inactive shape keys.
There is no frame crop, per-frame fit, sprite offset or image generator.

`review.png` shows the actual pair on white and charcoal. `comparison.png`(含母版裁图,已移到私有目录 `~/Documents/tendhearth/cc-design/`,不进仓库)is
the historical prior-revision reference comparison, not the current output.
These are production candidates; owner aesthetic approval remains pending.

## Eight-pose camera calibration (step 2)

`render-cc.py -- --calibrate-camera --samples 96` renders default, listening, happy,
confused, thinking, low, angry and excited from the design sheet §06 / master §08.
All share one rooted tube topology, retained as shape keys in the `.blend`.
The first pass measures actual RGBA silhouettes at ortho scale 6.0; the second
verifies the fitted scale against entity bounds [104, 52, 408, 470), reserving
24 pixels for effects inside the runtime safe rectangle. `camera-fit.json` records
both sets of bounds, reference hashes and a geometry fingerprint. Normal renders
consume this frozen camera and reject changed geometry until all poses are measured again.

Measured scale is **3.85**; the excited pose is highest at y=55, all feet end at
y=469. There is no per-frame fitting, translation or crop. `poses/*.png` and
`poses-review.png` are calibration previews, not registered runtime frames.
The canonical pair now uses this camera.

## Continuous animation (step 4)

Blink changes only eye scale (0.48 / 0.12), reuses the default C and canonical entity
mask. Sleep uses the low C shape key and closed eyes, with its own shared entity
mask. Eight Dark→Light frames mix endpoint colors in premultiplied linear light and
interpolate alpha; exact PNG endpoint copies eliminate entrance/exit discontinuity.
`rest.png` is an exact canonical copy used for unproduced behavior performances,
so missing artwork cannot switch back to the old vector character. These remain
explicit TODOs in the manifest, not completed expression designs.

`animation-review.png` contains all eight authored form/expression combinations.
The underlying body/feet half-coverage contour matches between idle and sleep;
eight AA pixels vary by at most 5/255 between independent Cycles renders.

## Material / C revision after reference comparison

Dark adds two broad rear-side area lights at (-3,3,2.1) / (3,3,2.5), powers
230 / 180, and a subtle noise bump (scale 135, strength .08, distance .012).
Body emission remains zero; exterior alpha remains exactly zero. Frontward
strong lights were rejected because they washed the body gray.

Light's warm emission color is now (1,.68,.36) in linear light and strength
5.5 + 12×Fresnel, separating the warm-white edge from the softly shaded center.
Existing SSS .65 and HDR Fog Glow are retained; alpha limits remain unchanged.

Default C vertical arc center/radius are 1.88/.49, opening the hook above the
body. Low/sleep has a forward centerline reaching y=-.95 and downward tip z=1.72,
rather than lying across the head. All eight poses were remeasured at 96 samples:
ortho stays 3.85, highest pose y=55, default y=104, all feet end y=469.
Canonical, blink, sleep, rest and all transitions were rerendered together.

`material-revision-review.png` labels previous/current candidates at equal display
sizes; `animation-review.png` and `review.png` show the current assets. New native
checks live in `native-qa/revision-v3/`; older native captures retain their original
manifest hashes. Authoring TODOs for rest-only behavior performances are preserved.

## Light volume revision after a6a63c59

Geometry, eye placement, eight C poses and camera are unchanged. Light emission
now uses an art-directed world-height profile plus a reduced Fresnel contribution:
normalized height spans z=.1–2.45; five profile knots multiply by 7, with
7×Fresnel added. This is a spatial approximation, not a measured thickness or AO
model. Emission shifts from peach at the base to warm ivory above. Removing the
low bounce and raising the broad top-front key from 60 to 110 preserves a darker,
warmer seated body under the bright shoulder and C.

Light eyes already had zero SSS. Setting their specular level to zero and roughness
to 1 removes the warm reflective eye interiors without moving or repainting them.
The rendered comparison supports that fix; it does not prove all prior fringe
color came from a single transport mechanism. Dark base changes from #1A1A1A to
#141414; the accepted rim lights, micro-normal texture and white eyes are retained.

`light-volume-review.png` compares a6a63c59 with this revision. `lit-surface-only.png`
is the direct Light surface render with no exterior bloom/contact-shadow composite;
it demonstrates that the visible body gradient is in the material. It is a QA
artifact, not an additional runtime effect layer. `material-revision-review.png`
and the camera-pose previews remain historical geometry/calibration evidence.
Native screenshots under revision-v3 also show the previous material, not this one.

## Light lamp revision after 2b7f22d3

The earlier height-only emission dip is superseded. Body emission now uses a
localized elliptical Gaussian: center x=0, z=.78, radii .85/.38; strength is
7×(.50−.28×exp(−r²)) plus 7×Fresnel. This leaves the base and shoulder luminous
while keeping a soft central depression instead of a horizontal band. It is an
art-directed spatial material, not physically measured thickness. Base emission
color warms only to (1,.65,.38), with upper color (1,.80,.54), in linear RGB.

C has a separate copy of the Light material with constant base strength 1.96 plus
7×Fresnel. It no longer grows brighter solely because it is higher than the body.
Its shaded tube and brighter grazing edges remain part of the surface render.
Fog Glow size rises .45→.65 and the exterior distance envelope 28→40 px; the same
safe-bounds fade and alpha ceiling still apply. No runtime or mask contract changes.

`light-lamp-review.png` compares this revision with 2b7f22d3. `review.png`,
`animation-review.png` and `lit-surface-only.png` show current assets. Earlier
comparison sheets and all existing native screenshots remain historical. Dark
materials/lights, geometry and camera are frozen; the two mask files are byte-exact.
Tiny Dark render RGB rounding (at most one byte level) is listed in VALIDATION.md.

## Broad Facing revision after 431dc26b

Light's Fresnel edge term is replaced by Layer Weight Facing, Blend .55, on both
body and C. The broad response uses gain 3.5 on the body to preserve its accepted
central dip; C uses gain 7, with constant base emission lowered 1.96→1.4 (body
upper base remains 3.5). Geometry, camera, palette, lights, Gaussian body shading,
eyes, Fog Glow and its distance support are unchanged.

`light-facing-review.png` compares against 431dc26b. In the direct surface PNG,
C's opaque row y=205, x=147…221 spans approximately 215–244 display luminance,
versus 220–235 before. The outer side fades from about 235 at x=152 to 215 at
x=182, a broad 30 px transition. `facing-profile.json` records every sample and
image hashes; these are our specified scan coordinates, not Claude's unspecified
reference scan or a claim of exact photometric agreement with the design board.
The tube's gradient and softened root seam were also visually inspected.
