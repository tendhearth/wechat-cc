# CC companion entry interactive preview

**Goal:** Turn the owner-approved home and scoped work-item concepts into a clickable, explicitly simulated preview.

**Design:** Home keeps personal conversation separate from project work. Project/task navigation binds the composer to one stable task ID. An optional process drawer displays provenance and illustrative native-session history. Reuse frozen CC assets and existing icons. No production routing or real model calls.

**Files:** `apps/desktop/art/cc-companion-entry/{preview.html,preview.css,preview.js,state.js,state.test.ts,README.md}`.

- [x] Write and run isolation tests: drafts, attachments, identical task titles across projects, delayed replies, blank sends, pause isolation.
- [x] Implement in-memory preview state, then home, project navigation, task workspace, scoped composer and process drawer.
- [x] Exercise real browser navigation, delayed replies, draft restoration, source-history dialog, keyboard controls and narrow layout. Save screenshots.
- [x] Run focused tests and typecheck; document demo boundaries and preview URL.

All data is synthetic and resets on reload. No local files are read/uploaded. Production code, provider configuration, frozen assets and original native conversations stay untouched. The owner has approved trying the concept; this preview does not establish production session attachment, cross-device control or project security isolation.
