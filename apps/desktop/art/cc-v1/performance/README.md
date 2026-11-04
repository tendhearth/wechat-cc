# Coordinated CC performances

This profile keeps the owner-frozen CC character, camera and materials. The same
Blender source now supplies coordinated body, feet, eyes and rooted-C acting,
exported as transparent PNGs. It is not a live 3D renderer or a new character rig
saved over `cc-v1.blend`. All new artwork remains `production-candidate`.

| Clip | Acting | Nominal duration |
| --- | --- | --- |
| peek / peek-left | Notice one side, hold, lean after the eyes, then settle | 14 frames each / 12 fps |
| stretch | Relax eyes, compress, hold the stretch; C settles last | 14 / 12 |
| walk | In-place steps with alternating lifted/support feet | 12 / 10, loop |
| lift | Suspended body with attached, asymmetrically hanging feet | 12 / 12, loop |
| land | Suspended pose, compression, small rebound, stable rest | 8 / 16 |
| celebrate | Anticipation, one short hop, landing, recovery | 12 / 16 |
| work | Downward concentration and blink, then a six-second hold | 12 / 8, loop |
| curiosity | C dips first; open-eyed inspection, one startled hop, held look, curl recovers, late blink | 36 / 12 |

The existing player rounds frame delays to milliseconds, so the two short
16fps gestures take 504/756ms. A factual completion remains on the same authored
clip until its actual final callback, including when WebKit slows timers. A new
task, permission or error still interrupts it. Other surfaces keep their original
behavior artwork unless `life` is explicitly enabled. Missing optional frames
fall back through the existing bad-frame handler and CSS choreography.
The separately authored left glance never mirrors CC's asymmetric character.
Older seven-clip kits retain their original peek and omit curiosity safely.
Curiosity is optional decoration, never task activity: after 75s continuously
eligible it can start at an ordinary idea boundary, once per calm episode and
no more than once per 30min window-local monotonic cooldown. It finishes through
the actual last-frame callback. Interruption consumes the opportunity; it never
queues a replay or extends the original 180s doze deadline.
The authored walk stays at the user's window anchor: whole-window travel would
slide its planted support foot. Existing native strolls remain available to the
fallback choreography; the new artwork does not start those independent clocks.

## Authoring and registration

Run rendering, tests and preview generation only in the registered Mini lab.
Use Blender **5.2.1 LTS**, Cycles, 96 samples, seed 11, four CPU threads.

```sh
node apps/desktop/scripts/cc-performance-recipes.mjs apps/desktop/art/cc-v1/performance/recipes.json
Blender -b --python-exit-code 1 --python apps/desktop/scripts/render-cc.py -- --performance-plan apps/desktop/art/cc-v1/performance/recipes.json --samples 96 --threads 4 --resume-motion
node apps/desktop/scripts/register-cc-performance.mjs
```

The numeric plan has schema 4, including finite vertical eye placement `gazeUp`
in [-0.04,0.14]. Eyes are re-seated on the same face surface. Per-frame controls
are bounded before rendering.
Curiosity additionally uses a bounded `crestTilt` in [-0.42,0.8] radians about
the C's embedded root, before its saved matrix and common body transform. The
other eight clips keep zero; zero follows the previous matrix path exactly.
The mesh, topology and shape keys stay frozen. Registration requires measured
root preservation and determinant evidence after the actual scene update,
including samples whose identical or canonical pixels are reused.
Every sample starts from saved object matrices; Body, eyes and C receive the same
volume-preserving affine transform. Each foot has a separate sole pivot and
ground-clearance correction. No topology, shape-key geometry, material, light or
camera is edited. The original source, canonical, masks and frozen transitions
are checked by digest after rendering.

Each checkpoint records parameters, both PNG digests, one shared geometry mask,
actual foot geometry clearance and the body determinant. Resume accepts a frame
only when source, renderer, helper, plan, Blender version, samples and all three
file digests match. Airborne poses may leave the virtual ground anchor; all
frames retain the same 512px canvas, anchor [256,470] and safe bounds. Dark has
no exterior effect pixels; Light retains its bounded glow and reduces the contact
shadow as both feet rise.

Registration validates all 134 pairs (402 PNG files) before returning any manifest
to publish. Draft work at 24 samples lives in a separate test-only project and
cannot pass the 96-sample registration gate.
`--activate` additionally registers nine `life-*` states; prior C/eye-only
behavior states, their fixed-body tests and owner-frozen bytes remain intact.
The review catalog works with `buildMotionReview` and `buildMotionSamples` using
explicit performance catalog/output paths. Review both forms on white and dark
backgrounds, contact sheets at 48/96/128/256px and actual playback before delivery.
Implementation visual QA does not claim the owner's aesthetic approval.

[Overview](samples/index.png) · [walking](samples/walk.webp) ·
[landing](samples/land.webp) · [completion](samples/celebrate.webp) ·
[private curiosity](samples/curiosity.webp).
The nine 128px paired WebPs and posters are retained in `samples/`.
Its `catalog.json` pins the exact catalog bytes used for those exports;
activation may refresh the active catalog's timestamp without changing artwork.
