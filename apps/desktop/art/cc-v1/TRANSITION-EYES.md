# Discrete transition eyes

Both directions keep the starting eye color in frames 000–003, then switch to
the destination eye color at 004. Body/C/material timing, fps, effects, every
alpha byte and both canonical endpoints are unchanged from dev 3513628c.

The frozen .blend supplies an occluded eye matte. Only its 1,232 supported pixels
receive canonical RGB, including the authored antialias edge. One-level display
dither outside the eye geometry is excluded. No source scene is saved.

Reproduce after either transition renderer:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --python-exit-code 1 --python apps/desktop/scripts/cc-transition-eyes.py
```

Refresh manifest digests after generating outputs. The six previously frozen
brightening interiors have an explicit eye-only amendment in design-freeze.json,
retaining their previous hashes and reason; the original scene/canonical freeze
assertions remain. Revised transitions/interiors are candidates pending owner
review rather than inheriting an approval of the previous eye animation.

Verification: validator 93 assets / zero errors; directed Vitest 15 files / 175
passed; full-repository typecheck passed. Tests compare eye RGB with the correct
canonical form, non-eye RGBA hashes and complete alpha hashes for all 12 interiors.
An independent comparison against dev confirmed all non-eye pixels unchanged.
The contact sheet includes enlarged faces. Browser records both full eight-frame
sequences, no warnings, and idle endpoints. Native QA app rebuilt successfully;
new real-wallpaper owner approval is not claimed. Old comparison/browser evidence
in FOLLOWUPS.md predates this eye-only revision.
