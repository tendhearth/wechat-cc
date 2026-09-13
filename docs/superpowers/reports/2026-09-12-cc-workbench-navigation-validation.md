# Workbench navigation motion — 2026-09-12

## Scope

Make the existing global navigation collapse naturally when entering work, and
remain convenient to reopen without moving the current task. No new navigation
level, task execution feature, or artwork is introduced.

## Diagnosis and change

- The previous rail changed positioning and internal layout at the same instant
  the main grid jumped from a reserved column to full width. The rail is now
  consistently positioned, and its width and reserved column share the existing
  responsive widths: 177 / 145 / 72 px. The main content stays in column 2.
- Entry/exit animate the reserved column and rail together over 220 ms. Opening
  navigation while already working is an overlay; the task does not move.
- Removed open-only internal layout overrides. Narrow-window links retain the
  same icon-and-label arrangement throughout the exit animation.
- The scrim stays mounted while working. Opacity and rail movement use the same
  duration/easing, with CSS visibility delayed until exit finishes. Pointer input
  is released immediately on close; the rail immediately becomes inert. There
  are no timer callbacks or transition-end dependencies to race a quick reopen.
- Reduced-motion preferences disable these transitions.
- Opening focuses the active navigation item before falling back to the first
  enabled item. Closing restores focus. An Escape already consumed by an inner
  interaction does not also close this navigation.
- Keyboard entry previously left focus on the body. The target pane is now shown
  before first-entry focus moves to the navigation toggle. Repeated state sync
  does not steal focus, and selecting the current workbench still avoids remount.
- The compact CC entry has a native tooltip matching its accessible action label.

## Reference decisions

These are specific implementation lessons, not a claim to reproduce the products.

- [Paseo: mobile panel presentation](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/app/src/mobile-panels/presentation.tsx#L27)
  derives rail displacement and scrim opacity from one position. CC uses matching
  CSS transitions so these parts also enter and leave together.
- [Orca: reduced-motion accordion styles](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/renderer/src/assets/main.css#L1629)
  provides a concrete reduced-motion rule. CC applies that preference to this
  navigation; this is not an assertion about all Orca navigation animations.
- [CC Switch: keyboard handling](https://github.com/farion1231/cc-switch/blob/1d5d90f4aba88447d422a16cdec5282ec5331fd7/src/App.tsx#L622)
  respects consumed keyboard events. CC now also checks `defaultPrevented`.
- [Orca: titlebar sidebar control](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/renderer/src/app-shell/TitlebarLeftControls.tsx#L90)
  keeps its entry discoverable. CC retains the fixed compact entry and adds its
  action tooltip; no unimplemented shortcut is advertised.

## Verification

- TDD navigation regressions: scrim lifecycle, active-first focus, fallback,
  Escape ownership, first-entry focus, repeated-state focus, rapid reversal,
  outside dismissal and same-page dismissal. Navigation suite: 8 tests passed.
- `bun --bun vitest run apps/desktop/src/modules/workbench-navigation.test.ts apps/desktop/src/modules/workbench.test.ts apps/desktop/src/modules/cc-life.test.ts`:
  3 files, 69 tests passed. Existing vendored `marked.bundle.mjs.map` warning
  remains non-fatal and unrelated.
- `bun run typecheck`: passed. `git diff --check`: passed.
- Independent read-only review of CSS, navigation, tests and pane-switch ordering:
  no remaining defects reported.
- Real browser at 1440×1000, 1024×900 and its original 663×744 viewport. The
  corresponding rail widths were 177, 145 and 72 px. No horizontal overflow or
  composer/content overlap observed.
- Sampled actual transition frames through read-only DOM observations. At 1440 px,
  entry main X moved 152.66 → 125.45 → 104.46 → 83.70 → 68.45 while the rail's
  right edge tracked the same position and its width remained 177 px.
- At 663 px, overlay entry sampled opacity 0 → 0.14 → 0.28 → 0.41 while rail X
  moved −72 → −61.88 → −51.85 → −42.72. Main X stayed 0. Closing immediately
  released pointer input; reopening partway reversed from the current position.
- With reduced motion emulated, all three transition durations were 0 s, both
  navigation states remained usable, and keyboard focus returned correctly.
  The emulation was removed afterward.
- At 1024 px, opening and selecting the current workbench preserved the selected
  task, expanded tool details, unsent draft and settled content scrollTop 768.5.
  The temporary draft was removed without sending; details were closed again.

## Preview and limits

The isolated workbench development service was restarted at
http://127.0.0.1:4187/. Existing completed task data was used for UI checks; no new
Claude/Codex execution or permission approval was triggered. Temporary viewport
overrides were removed. Native Tauri was not rebuilt or rechecked this round.
