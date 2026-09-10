# CC homepage aquarium — visual candidate

2026-09-09. Replaces the online homepage / animation-lab bear illustration with
an independently layered aquarium, interactive fish, and frozen Light CC sprite.
The offline illustration and separate native desktop pet are unchanged.

## Assets

- `src/assets/home-cc-aquarium-base.png`: generated edit of the owner's approved
  CC aquarium illustration. Preserve composition, glass, plants, warm lighting
  and 4:3 canvas; remove fish and CC and reconstruct the empty scene.
  SHA-256: `f0e96ae9143c5480299c074583e6eec358b8ecb60cc10223a507508cbe35231e`.
- `src/assets/home-cc-fish-atlas.png`: three transparent left-facing fish, yellow,
  coral orange and powder blue, equal horizontal cells. Reference-matched soft
  watercolor shading and delicate fins, no background or text. Runtime crops
  alpha padding once and reuses the sprites for seven swimming fish.
  SHA-256: `7bd0822fb701f11d9f860f0e0cff9994adcb4f43bf1bfcd350394a8c619ed7c6`.
- CC uses the existing `pet/cc-v1/canonical/lit/front.png` without modifying it.
  Square drawing dimensions keep the character proportion independent of the
  scene aspect ratio; pixel 470 remains the grounded anchor.

The source illustration is private and is not included. Generated with the
built-in image tool. These are runtime art candidates, not new character masters.
Existing lotus / crab artwork and interaction remain; their stronger outlines
are a remaining style difference. The native-pet screenshot's grey edge has not
been diagnosed by this homepage change.

## Verification

- Four targeted test files, 84 tests: layout, scene state, presence, dashboard.
- Repository typecheck.
- Browser animation-lab: aquarium and all seven new fish render; water click
  shows scatter feedback; reset works; CC click shows a greeting; no console
  errors. `preview.png` records the shared scene renderer at a 663px viewport.
- This is a browser scene check, not a native transparent-window acceptance or
  a connected production homepage session.

## Contact shadow revision

Adds a warm, soft elliptical shadow behind the unchanged canonical sprite,
anchored to the floor independently of the nod. Same-viewport screenshots:
`contact-before.png` and `contact-after.png`. At the left foot sample
(x143–153, y455–461), Rec.709 luminance remains 235.8. The floor immediately
below (x143–153, y469–473) changes from 232.4 to 211.1: contrast increases
from 3.4 to 24.7 levels. Samples are screenshot-specific, not a universal
contrast guarantee for every size. Four targeted files / 84 tests and repository
typecheck pass. No frozen character files changed.

## Homepage glow clipping experiment

The homepage now prepares one offscreen sprite using the shared `masks/front.png`
with `destination-in`. This removes the exterior desktop glow over paper and
foliage; original PNGs and the native pet rendering remain unchanged. No new
halo is added. `glow-before.png` / `glow-after.png` show the same viewport (fish
and greetings remain animated). Visual decision: retain clipping; the outer
haze is reduced while body shading and the scene contact shadow remain.
Antialiased edge alpha is multiplied, not replaced, by destination-in. If the
mask fails to load or dimensions disagree, the original sprite remains usable.
Browser reports no console errors; four test files / 84 tests and repository
typecheck pass. This experiment is a separate commit from the contact shadow.
