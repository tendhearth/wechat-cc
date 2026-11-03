# CC coordinated motion performances

The owner chose to keep CC's existing luminous 3D character and improve its acting, with Blender-authored performances exported as transparent PNG sequences. They explicitly asked for autonomous continuation, Mini-only testing and delivery to their daily CC after verification; no further design questions are required.

## Purpose and approach

CC should feel like a small companion with weight and attention. Eyes lead a glance, the body follows, and the rooted C settles last. Steps alternate a planted support foot and a lifted foot. Being carried leaves the feet hanging; a confirmed landing compresses, rebounds and settles. A real completed task earns one short, restrained hop. Work has small, occasional weight changes rather than constant bouncing.

Considered approaches: additional CSS transforms are cheap but cannot separate the feet and body; live 3D would require a new rendering/runtime system; rendering coordinated performances from the existing model preserves the accepted form and current lightweight player. The owner selected the last approach. Exact timing and rig implementation are builder decisions.

## Constraints

- Preserve the frozen `.blend`, base geometry, camera, materials, canonical images and transition bytes. No new limbs, mouth, ears or animal form.
- Add a separate performance profile and `life-*` states. Existing C/eye-only motion clips and their fixed-body tests stay intact.
- Render Body, eyes and C through the same body transform; pivot feet independently at their soles. Always reset the saved matrices before each frame. Never save the modified Blender scene over the source.
- Fixed 512×512 canvas, anchor [0.5, 0.91796875], safe bounds [80,28,432,470]. The anchor describes the ground plane; airborne frames may leave it. Light and Dark share one per-frame geometry mask. Preserve current alpha, glow and matte-Dark contracts.
- Seven clips: peek, stretch, walk, lift, land, celebrate, work. Nonloop performances start/end at exact canonical rest, except landing starts suspended. Walk/lift/work loops close. No per-frame fitting or cropping.
- Actual task facts, permission/error priority, reduced motion, quiet mode, cancellation, hidden state and drag confirmation remain authoritative. Authored performance suppresses duplicate CSS body motion, while retaining a small pointer-velocity swing during carrying. Missing performance frames fall back safely.
- All renders, tests, builds and graphical validation run on the registered Mini. No primary-machine input, focus or heavy workloads. No production accounts, models, daemon or private data on Mini.

## Acceptance

Review paired contact sheets, playback and 48/96/128px samples on Mini. Reject clipping, detached eyes/C, foot skating, double movement or repeated completion celebrations. Use recipe/geometry tests for continuous bounded transforms and foot contact, runtime tests for preemption/fallback, and image contracts for every registered frame. Fresh review, merged-dev full verification and Mini native checks precede signed daily deployment with a complete compatible rollback app.
