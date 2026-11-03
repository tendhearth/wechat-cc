# CC acting and private curiosity

## Intent

The owner explicitly established a continuing goal: CC should look excellent and
have moments of surprise. They delegated the visual decisions, asked for no
intermediate questions, and retained the prior Mini-only validation and daily
deployment instructions. This document records the builder's choices, rather
than claiming the owner approved individual poses.

CC remains the family's luminous little caretaker. The next improvement is
intentional acting: notice something, think for a beat, act, then settle. A good
gesture has one readable idea. Surprise is an occasional private little situation,
not a new notification or something the owner must dismiss.

## Evidence and approaches

An independent visual critic inspected every complete current performance sheet
at 48/96/128px on paper/slate. Stretch, landing and celebration already read;
peek has no clear discovery, lifted feet hide inside the silhouette, carrying is
hard to distinguish, and work mostly reads as blinking. The fixed character is
stronger than its acting. Playback timing observations remain hypotheses until
the next Mini previews are viewed.

1. **Richer acting in the current renderer — selected.** Improve eye intent,
   held decisions, weight shift and the C's delayed response. A new short scene
   lets CC notice its own C. This preserves identity and the small sprite player.
2. **A separately rendered light companion.** Could support a magical little
   story, but needs synchronized front/rear occlusion and failure handling. Defer
   until CC's own acting communicates well without an additional visual subject.
3. **Live 3D.** More freedom, but introduces an unnecessary runtime and a larger
   hardware/energy surface. The owner already chose the existing 3D-to-PNG route.

## Acting direction

- **Peek:** one discovery per gesture. Eyes lead by about two frames; hold the
  target, then let the body follow. Return the gaze before the body fully settles.
  Author left and right looks independently; never mirror the asymmetric C or
  accepted three-quarter camera.
- **Stretch:** eyes relax first; hold the lengthened pose; C finishes last.
- **Steps:** shift toward the support foot before lifting its partner. Move the
  lifted foot outward enough to read below the body's outline. Keep steps in place.
- **Carry:** a slightly higher body with asymmetrically hanging feet. The feet
  still intersect the lower body; no detached components or invented legs.
- **Landing:** decisive contact, smaller rebound, slower recovery. Body stands
  before the C finishes settling.
- **Completion:** the existing single hop gains a quiet, pleased acknowledgement
  and a C that composes itself one beat later. Keep the factual completion rules.
- **Work:** an intentional downward glance toward the laptop, followed by still
  concentration. Keep the six-second rest and restrained movement.
- **Private curiosity:** eyes notice the C above; C perks; CC cautiously inspects
  it; the C shifts again; CC pauses and returns to its ordinary pose with one tiny
  toe adjustment. No extra object, speech, sound, badge or claimed task event.

## Authoring contract

The seven existing durations stay compatible with their current director clocks:
peek/stretch 14@12fps, walk 12@10 loop, lift 12@12 loop, land 8@16,
celebrate 12@16, work 12@8 loop. Add peek-left 14@12 and curiosity 36@12,
for nine clips and 134 paired samples. Holds are authored as repeated numerical
poses, rather than continuous motion everywhere.

Use performance plan schema **3**, with finite `gazeUp` in **[-0.04, 0.14]**
model units. Re-seat each translated eye on the existing face surface. Zero gaze
keeps the exact resting path. Existing C shape keys provide the delayed C motion;
no new C topology, free endpoint, body turn, limb or mouth is introduced.

Preserve the frozen blend, source geometry, camera, materials, lighting, canonical
images, fixed-body motion clips and transition bytes. Body/foot envelopes remain
the existing ones. Canvas512², anchor[0.5,0.91796875], safe bounds[80,28,432,470),
shared Light/Dark geometry masks and all alpha contracts remain unchanged. Current
seven performance PNGs are mutable candidates; all previous receipts and the
installed1c324a13 full app remain preserved as the baseline.

Prototype renders use an isolated Mini draft project and 24 samples, clearly
labeled draft. They cannot overwrite the live test kit or be registered. Final
art uses Blender5.2.1 LTS, 96 samples, seed11, four CPU threads. Render one clip
per owned Mini job with digest checkpoints, allowing other family jobs between
clips. Never resume across a changed render identity.

## Runtime contract

`peek-left` is an optional variant selected by the director's direction. Older
manifests without it use the ordinary peek; no CSS image mirroring.

Curiosity is a decorative director action, never a `PetBehavior` or backend fact.
It is enabled only when the optional nonloop artwork is available. It can begin
at an ordinary idle-idea boundary after **75 seconds continuously eligible**, at
most once per calm episode, with a **30-minute window-local monotonic cooldown**.
Starting consumes the opportunity, even if interrupted. No persistence, rewards,
scheduled catch-up or background scene queue is introduced.

The curiosity scene ends on its sprite player's actual final callback, not an
independent three-second timeout. A generation token rejects stale callbacks.
Existing completion behavior stays intact. Work, permission, error, drag, Dark,
nearby controls/focus, settings, hidden state, quiet and reduced motion interrupt
immediately and never replay the scene on return. Missing all curiosity frames
disables the optional scene and settles to the existing factual presentation.
Normal idle observations must not restart playback. The original 180-second calm
doze clock is not extended by decoration.

## Visual gate

Review actual Mini playback, not only contact sheets. At96px, a fresh critic must
be able to describe each gesture's intention in one sentence. At48px, the key pose
must differ from rest through silhouette, position or a robust eye change. Three
selected stills must show anticipation/action/recovery. Support foot and weight
must agree; C/eyes remain attached; no clipping, skating, duplicate CSS motion or
snapping back before a scene completes. At least one beat must feel specific to
CC. Each gesture becomes still after its idea lands.

Run at least two visual passes: draft critique/refinement, then complete96-sample
playback and independent final visual review. Technical green alone does not close
the goal. Owner aesthetic acceptance remains pending their eventual trial.

## Validation and delivery

Root is the sole product writer and integrator in its existing isolated worktree,
branch `codex/cc-pet-delight` from dev1c324a13. Read-only specialists review design
and visuals; the existing Mini executor alone writes/runs the offline lab.
Baseline1c324a13/8f19a17b has genuine full, browser45/native25/compatibility/CI
proofs from the preceding delivery. All new RED/GREEN, renders, headless/native
UI checks and heavy builds run on Mini. No production daemon, real accounts,
model credentials or private databases are copied there.

After independent code/visual review, merged-source full verification, Mini
playback/native checks and real CI, root serially signs/deploys on the protected
primary host with a full compatible rollback app. Probe an existing healthy
provider before swapping the daily app; use the same real image/resume and
chat/tool/resume gates. Temporary gate-provider selection never changes the
owner's stored default. Preserve all failed attempts and state; never rewind
the database. No primary mouse, keyboard, focus/window automation or heavy build.
