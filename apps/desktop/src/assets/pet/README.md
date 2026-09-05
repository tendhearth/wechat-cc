# CC Desktop Pet Assets v1

Production-ready raster starter pack for Tauri. The two supplied boards are the only canonical references.

## Non-negotiable character rules

- Unlit and lit are the same CC: same outline, proportions, ears, paws, and bottom anchor.
- Unlit is matte charcoal with large white oval eyes.
- Lit is warm cream with tiny black eyes, peach cheeks, a small x-like mouth, and the two-leaf sprout.
- The sprout, micro-light, laptop, envelope, bubbles, exclamation, and mug also exist as separate props.
- Do not reinterpret CC as a cat, bear, rabbit, dog, robot, or human.

## Runtime

Character frames are 512×512 RGBA PNG. Anchor is `(0.5, 0.91796875)`, equivalent to `(256, 470)` px. Props are 384×384 RGBA PNG and should be positioned relative to the character anchor. Use `manifest.json` as the machine-readable source of truth.

`idle`, `working`, `thinking`, `permission`, `companion`, and `sleep` may be held or gently tweened. One-shot states return to idle unless runtime context overrides them. The transformation plays at 8 fps.

## Integration note

These are keyframes, not a final high-frame-count animation library. Small breathing, bobbing, and prop motion should be implemented as restrained transforms in the Tauri renderer; do not deform the canonical silhouette.
