# Shared paper surfaces — 2026-09-10

`cc-surfaces.css` aligns neutral paper, secondary text and border tokens across
pages, with targeted rules for atelier cards, todo cards/buttons, foraging
surfaces, backstage tabs and settings buttons. It preserves status palettes,
artwork, page layouts and application behavior. Focus-visible outlines are
explicit for controls in these sections. No new raster asset is required.

Browser checks at the local 663px-wide app: todo empty state, atelier unavailable
state, foraging unavailable-data state, backstage empty conversations and
settings drawer. Screenshot evidence is adjacent. Keyboard traversal confirmed
a 2px solid focus outline on a backstage tab. No settings were changed.
The local app has no production daemon data; populated cards and long real
content still need visual acceptance. This does not claim a full accessibility
or modal focus-trap audit.

Validation: desktop 39 files / 628 tests; repository typecheck; diff check.
