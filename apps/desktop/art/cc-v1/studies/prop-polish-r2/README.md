# CC prop polish

The micro-light now limits measured HDR bloom by distance from its rendered star
surface. The 384px canvas still has twelve clear pixels at every edge. The
shape, material, camera and opaque surface are unchanged. See
[before/after, four sizes and two grounds](glow-review.png) and
[actual pixel checks](pixel-check.json).

The previous image had 83,108 nonzero-alpha pixels outside the new finite
support; the revised image has zero, retaining 22,436 near-surface exterior
pixels. The fourteen frozen character inputs and six other props are unchanged.
`source/` retains the rendered body, revised candidate and generator identity.
`before.png` pins the prior accepted image; its acceptance stays in manifest
history. The revised bytes remain `production-candidate`.

Runtime behavior props are projected from the state machine's actual displayed
behavior, after priority/drag/transition decisions. Working uses laptop;
thinking uses thought-bubble and mug; permission uses exclamation; receive uses
envelope with the factual unread count; look uses micro-light. Factual envelope
and error signals own their slots. No unread count is manufactured for receipt
art. Quiet, paused and reduced-motion controls consume decorative light, so
restoring motion does not replay old contact signals.

Runtime prop nodes are keyed and retained across badge updates. Appearance and
removal use opacity for160ms; rapid reentry cancels stale removal. Motion
suppression settles immediately, and destroy cancels owned work. Both surfaces
use block images so inline-image baseline space cannot distort the slots.

Source-module/CSS tests run in an isolated, headless browser on the Mini. Tauri
QA stages the same production UI with test-only polling controls; these handles
are absent from normal application assets. Neither test uses global mouse input.
