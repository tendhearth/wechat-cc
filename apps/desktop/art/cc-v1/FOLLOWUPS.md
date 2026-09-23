# CC follow-ups after PR #94

## 1. Owner acceptance

Owner ggshr9 accepted the existing Light/Dark bodies, blink, sleep, transitions
and props on 2026-09-09 in native transparent windows on real wallpaper.
All existing production candidates are now reviewed-production, including the
package status. SVG placeholders remain normative-placeholder.
Validator: 85 assets, zero errors; directed tests: 14 files / 170 passed.

## 2. Independent extinguish

`render-cc-extinguish.py` opens the frozen .blend read-only and copies its shader
node graphs into transition-only mix materials. Six interior frames are newly
rendered, not reversed PNGs. Smoothstep time plus HDR response compensation fades
surface emission; the accepted Light effect fades quadratically. Endpoint PNGs
are exact canonical bytes; the existing lighting endpoints are interpolated only
in the temporary scene. The .blend, original renderer and frozen images are unchanged.
Eight frames, 6 fps, non-looping. New animation/assets remain production-candidate:
the earlier owner review cannot approve imagery that did not yet exist.
Validator: 93 assets / zero errors. Directed tests: 14 files / 171 passed.
`extinguish-review.png` shows both backgrounds. `extinguish-browser.json` records
all eight frames in each direction and no warnings, then same-form idle.

## 3. New-body prop slots

Head signal moves right/up; micro-light has its own above-left slot. Side props
move inward; the laptop is smaller/lower so its lid clears both eyes.
Four pet-lab screenshots cover Light/Dark at 96px and 256px with stars, permission,
laptop and envelope simultaneously. Temporary DevTools shell dimensions produced
exact square stages (recorded in slots-browser.json); reload restored normal lab.
No page source changes. Tests cover separated signal/star bounds at both sizes.
Validator: 93 assets / zero errors. Directed tests: 14 files / 173 passed.

## 4. QA frontend isolation

Moved the three cc-native-qa files from src into art/cc-v1/native-qa. The QA-only
beforeBuildCommand stages runtime dependencies into ignored native-qa/dist;
production frontendDist remains src, with no QA page files. Pet-lab is untouched.
The staging filter explicitly excludes the two private design boards.
Regression test checks separate frontend paths, staged byte-identical runtime and
assets, absence of QA files from src, and preservation of pet-lab.
Validator: 93 assets / zero errors. Directed tests: 15 files / 174 passed.
Full-repository `bun run typecheck`: exit 0. Native QA Tauri app build: exit 0;
launched successfully and the 256px native window exposes both Light/Dark images
through tauri://localhost/cc-native-qa.html?size=256. This is a loading smoke check,
not a new owner wallpaper approval of the extinguish performance.
