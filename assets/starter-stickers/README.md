# CC Ink v1 starter pack

Owner-approved Light/Dark SVG study, rasterized to transparent 512px PNG for existing sticker delivery. SVG sources match apps/desktop/art/cc-sticker-study. PNGs generated with CairoSVG; runtime does not require it.

The versioned manifest adds missing entries to existing libraries without deleting history. When a mood has a CC Ink match, automatic selection excludes the four legacy bundled bear descriptions; personal stickers and collected artwork remain eligible. Legacy files stay available for history. The original fish sticker is unrelated to the mascot.

Postcards remain generated from actual visits, using the shared CC identity prompt. Fictional preview postcards are not seeded into user collections or sent as actual visits.

## Fixed-character generation

Generated stickers and visit postcards now request JSON with `form`, `pose`, and `sceneSvg`. `src/lib/cc-ink-compose.ts` validates the selections and SVG, then places the fixed character after the scene. Model-controlled transforms cannot change the character. Scene content is still model-generated: the prompt forbids an additional mascot, but this is not a semantic image detector.

Export templates with `python3 apps/desktop/art/cc-sticker-study/generate.py --export-templates src/lib/cc-ink-templates.json`. The checked-in template JSON is embedded by the compiler. Regenerate the starter PNG bundle with `bun scripts/build-cc-starter-pack.ts` after changing production PNGs (also runs during sidecar build).

If generation is malformed, no new image is saved or sent. Visit narration remains attached to the same journal entry; a composed postcard is attached to that entry before sending. Free painting and owner portraits do not use this compositor.
