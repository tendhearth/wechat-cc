# CC expression batch

Owner-approved baseline: a6b28e2a. Freeze character geometry, camera, materials,
lighting, canonical PNGs and all transition bytes. Do not push or regenerate kit SVGs.

1. Add asset integration assertions for all 13 behaviors in both forms, actual
   authored frames, and shared pose masks. Update working-frame fallback tests.
2. Add an expressions-only render mode loading the frozen .blend. Render thinking,
   working, done, receive, permission, error, look and drag with the specified eyes;
   companion uses canonical and wake retains half→canonical. Share masks by C pose.
3. Register candidate frames, preserve behavioral timing/priority semantics, inspect
   contact sheets and verify bounds/masks/endpoints/material freeze.
4. Exercise both forms and all 13 behaviors in pet-lab, normal/reduced mode; run
   validator and directed tests, record evidence and commit without pushing.
