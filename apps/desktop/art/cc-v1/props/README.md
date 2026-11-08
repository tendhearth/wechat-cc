# Seven CC props

Rebuild with Blender and `apps/desktop/scripts/render-cc-props.py`. This standalone
scene never opens or writes the frozen character .blend. Cycles 96 samples, seed11,
fixed orthographic camera, transparent 384×384 RGBA8, at least 12 px clear padding.

Warm porcelain: envelope, speech bubble, puffy thought bubble, mug. Matte charcoal:
laptop body/screen/keys. Saturated warm orange: exclamation. Warm emissive gold: star micro-light. Props have no outline strokes; envelope folds are modeled details.
Micro-light adds a true HDR Fog Glow pass with a smooth fade before the clear
border. Other props have no exterior bloom; none adds a ground shadow layer. Seven existing filenames
and renderer slots are preserved; no per-form prop variants or character masks.

The current manifest registers all seven source props with their hashes and
kind=prop. Six retain reviewed-production status. The revised micro-light
falloff is a production-candidate with the earlier accepted bytes and review in
previousVersions; see `../studies/prop-polish-r2/`. New motion/prop
composition studies in `../studies/` remain production-candidate. The validator
uses a separate 384px/padding contract; a prop cannot substitute
for a 512px character frame. The deprecated sprout is absent from manifest and lab;
its old file is retained only for compatibility/history.

Review sheets show both backgrounds. Browser checked all seven props on each form,
including working+laptop and thinking+mug combinations. Screenshots are browser
captures, not real-desktop transparency evidence. Results pin the manifest hash.
The earlier candidate-phase captures are retained as history; current registration
and review records are in the runtime manifest. This documentation update does
not change any source prop, registration or review status.

Targeted rerender: append `-- --props micro-light exclamation` to the Blender command.
The current sheets include the two signal revisions. Browser screenshots and
results.json retain the earlier seven-prop batch as historical evidence.
