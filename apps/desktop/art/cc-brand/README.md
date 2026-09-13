# CC app mark

The app identity follows CC's frozen front silhouette: one forward C, a round
body, two small feet and two vertical eyes. This is a compact vector mark for
navigation and app icons, not a replacement for the frozen rendered character.

- Editable mark: `../../src/assets/brand/cc-mark.svg` (eyes are negative space).
- App tile: `app-icon.svg`, generated from that mark with a warm paper surface.
- Mobile sources: `app-icon-mobile.svg` uses a full-bleed opaque surface;
  `app-icon-foreground.svg` and `mobile-icons.json` provide Android's adaptive
  foreground and monochrome layer. Mobile platforms apply their own corner mask.
- Preview: `preview.html`, kept outside the production frontend.
- Rebuild: `bun run build:icons` from `apps/desktop`.
- Generated outputs: Tauri desktop/mobile icon sizes and both existing
  `wechat-cc-logo.png` entry points. No model, mask or sprite is modified.

The mark and derived icons are CC character artwork under the repository's
`ASSETS-LICENSE.md`. This revision is awaiting owner visual review.
