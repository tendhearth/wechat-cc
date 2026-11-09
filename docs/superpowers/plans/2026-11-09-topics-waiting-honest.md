# Honest topic activity implementation plan

> **For agentic workers:** Use test-driven development and verify before completion. The owner explicitly authorized implementation, local verification, mini UI acceptance, and a local commit without push.

**Goal:** Only unresolved permissions/questions count as waiting; only unseen CC task results count as unread.

**Architecture:** Keep activity classification in the daemon's shared project projection. Existing desktop, App, web grouping and recall consume that projection.

**Tech Stack:** TypeScript, SQLite, Vitest, Playwright, Maestro.

**Spec:** `docs/superpowers/specs/2026-11-09-topics-are-projects-design.md`, updated by the owner's six rules on 2026-11-09.

## Constraints and review focus

- Work only in `wt-topics-waiting-codex` / `topics-waiting-honest`; no live daemon, production state, push or deployment.
- Preserve unresolved old requests, both terminal and task questions, task seen across surfaces, and queued/running distinctions.
- Main Mac tests require load < 8 and no CivilizationVII in the same command. UI runs only through mini lab with its shared lock; remove only owned inactive snapshots.

## Task 1: Shared classification and regression evidence

- [ ] Add real-shaped six-terminal reply, pending request, task seen and running/queued tests; run red.
- [ ] Correct `src/features/memory/project-activity.ts`, preserving metadata/privacy limits; run green.
- [ ] Update obsolete product expectations while retaining seen, push, stale and recall coverage; synchronize the design table.

## Task 2: UI acceptance and delivery

- [ ] Add idle replied terminal rows to desktop/App/web regressions and relevant browser/Maestro fixtures.
- [ ] Register only this authorized task's snapshot source; run guarded `bun run verify` including App.
- [ ] Commit with Codex trailer; transfer committed snapshot through lab; run browser and App topic flows.
- [ ] Review diff, collect evidence, clean owned inactive mini snapshots, write requested report; no push.
