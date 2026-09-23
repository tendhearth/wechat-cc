# Native Tauri QA — step 5

**Historical capture set:** these screenshots predate the subsequent material / C
revision. `results.json` pins the exact manifest hash; they do not attest the new
asset bytes. Current rebuilt-app captures are in `revision-v3/`; the parent files remain the historical set.

This is a real compiled macOS Tauri application, not the web shim or offline
composites. Four separate `transparent: true`, undecorated, shadow-free native
windows load the real `createPet` runtime and the committed manifest through
`tauri://localhost`. Each has two 48 / 96 / 128 / 256 CSS-pixel sprites. A fifth
window controls the test and receives real image-load and state reports.

## Packaging isolation

The three `cc-native-qa.*` source files live here, outside production `src/`.
`tauri.qa.json` runs `scripts/prepare-cc-native-qa.mjs`, which stages this page,
the real pet runtime, assets and font into the ignored `native-qa/dist/` folder.
Only the QA build uses that frontend. Production still uses `src/`; pet-lab is unchanged.
Private design boards are explicitly excluded even if locally restored.

## Reproduce

From `apps/desktop`:

```sh
bun run tauri build --debug --bundles app --no-sign --config art/cc-v1/native-qa/tauri.qa.json
```

Open `src-tauri/target/debug/bundle/macos/CC Native QA.app` (or the equivalent
location under your `CARGO_TARGET_DIR`). This run reused the original worktree's
Rust build cache, while all sources came from the isolated CC worktree. The
configuration excludes sidecars/resources/updater artifacts and grants only
QA event and window-focus permissions; it does not contact a daemon or change
user state. No placeholder builder was run.

Use the Window menu → CC Native QA to reach the controls from a sprite window.
The size buttons focus each native window for inspection. Automatic idle moves
and CSS breathing are suppressed for repeatable static captures; 125ms frame
timers, manually requested blink/sleep and the form state machine remain real.
The loop exercises both forms, blink, low-C sleep and both transition directions.

## Evidence and result

- Actual DOM rectangles: 48×48, 96×96, 128×128, 256×256.
- Reached loop 8 (at least seven complete cycles); all four windows loaded all 16 unique authored
  playback paths, with zero image-load errors. Native accessibility evidence:
  `native-loop-state.txt`; structured record and screenshot hashes: `results.json`.
- `light-*.png` / `dark-*.png` are unretouched CUA screenshots of the actual native
  windows. `native-review.png` simply arranges them without rescaling or recoloring.
  Arrow/glow marks away from the pets are the capture tool's pointer highlight.
- White backdrops: Dark has no exterior gray fog; Light remains warm and soft.
  Charcoal backdrops: Light glow and Dark white eyes are visible. No clipping or
  baseline shift was seen at any size. At 48px Dark's charcoal silhouette remains
  low contrast, so this stays an owner aesthetic review item.

## Exact boundary of this check

The deep/light screenshots use switchable **QA backdrops inside each native
window**. The transparent button restores a transparent body. CUA's screenshot
API captures one window and flattens transparency, excluding the rear desktop
window; attempts to capture the OS desktop through its UI did not produce usable
evidence. Therefore actual external desktop/wallpaper compositing is **not
verified** here. The four native windows, image decoding, sizing and animation
playback were verified; do not call this a completed physical-desktop sign-off.
No screenshot was fabricated from an offline asset composite to fill that gap.
