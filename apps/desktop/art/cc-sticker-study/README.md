# CC SVG visual study

Review-only samples: six stickers and two postcards. Open `preview.html` through a local static server. Switch between the gallery and chat example, or compare paper, white and dark sticker backgrounds.

These are authored SVG illustrations using one shared CC body template and five C poses. They adapt the character to line art; they are not frozen Blender geometry or model-generated outputs. Postcard stories are fictional examples, not actual visit records.

Regenerate with `python3 apps/desktop/art/cc-sticker-study/generate.py` from the repository root. All eight SVG files pass the existing `safeSvg` allowlist and XML parsing. Gallery and chat layouts were checked in the browser, including the small sticker examples. No runtime code changed, so the full application test suite was not rerun.

No starter pack, sending prompt, existing sticker or collection has been replaced. A later rollout should update sticker and visit prompts together, review character wording in memory art prompts, and preserve existing collections. Free artwork need not always depict CC.

## Revision 02 — Light / Dark pairs

Four paired moods: received, happy, goodnight and company. Each pair shares identical geometry and motifs; only character colors differ. Dark uses charcoal, warm-white eyes and a muted warm contour. Added a fictional evening café postcard. Original six samples remain for comparison. All 17 SVG files pass safeSvg and XML parsing; four paired SVG trees were checked for identical geometry. Desktop four-column and narrow two-column layouts were inspected, along with dark backgrounds. No production sending paths or frozen character assets changed.

## Production integration

Owner approved replacement. The eight paired SVGs are copied to assets/starter-stickers with 512px transparent PNGs and a versioned manifest. Runtime sticker and postcard prompts share src/lib/cc-ink.ts. This supersedes the earlier review-only status for the paired stickers; postcard stories remain examples. No historical collection is deleted. Deployment is separate from source integration.
