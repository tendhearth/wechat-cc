# Dispatch polish 4 implementation plan

> **For agentic workers:** Use superpowers:executing-plans. Only one executor writes this worktree at a time; investigation and review remain read-only.

**Goal:** Fix dogfood friction 21–24 without weakening tests or accessing a live daemon.
**Architecture:** Explicitly exclude task caches at collection boundaries; activate the task compatibility preload only when native uptime is unavailable; supervise test subprocesses with file and silence deadlines; gate deployment on active work and recover restart interruptions once.
**Tech Stack:** TypeScript, Bun, Node, Vitest, existing workbench store and CLI HTTP client.
**Spec:** Product owner brief 2026-11-09, dogfood-friction.md 21–24; existing dispatch and self-maintenance designs.

## Global constraints

- Assigned worktree dispatch-polish-4 at f65122bb1; no push or real deployment.
- No live API, production state, launchctl, UI automation, or mini tests.
- Keep all tests; record each regression red before its fix and green afterward.
- Run related Node tests and load-gated (load < 8, no CivilizationVII in the same shell command) `bun run verify` on this Mac.
- Final commit includes `Co-Authored-By: Codex <noreply@openai.com>`; write the requested external report.

## Review focus

- Cached test/source fixtures are ignored even when tracked or nested and when gitignore is bypassed.
- Healthy host Node/Bun APIs and subprocess argv stay native; denied uptime remains supported inside the sandbox.
- A noisy hanging file still expires; silent phases and grandchildren are terminated with useful diagnostics.
- Failed task queries prevent deployment; noninteractive waiting has a finite deadline; rollback remains available.
- Restart continuation respects writer leases, archived tasks, user cancellations, pending decisions and durable deduplication.

## Task 1: Cache collection

- [x] Add failing behavior tests for discovery, change collection and guard walking of both task cache locations.
- [x] Share path exclusion rules; apply to verify, Vitest, guards, test-shrink, depcheck and TypeScript discovery.
- [x] Run targeted discovery/guard tests and retain ordinary source coverage.

## Task 2: Task preload

- [x] Reproduce changed host runtime/subprocess behavior under the task environment.
- [x] Gate uptime and subprocess hooks on actual native uptime failure, preserving sandbox fallback.
- [x] Run host and real Seatbelt compatibility regressions in Bun and Node.

## Task 3: Verify supervision

- [x] Add real subprocess fixtures that hang silently or keep printing while a test file hangs.
- [x] Replace synchronous test execution with bounded supervision and Vitest file progress; use 120s/file and 300s/silence defaults with environment overrides.
- [x] Verify timeout reports identify files/durations, return nonzero and stop only the owned child tree.

## Task 4: Deployment and restart recovery

- [x] Add offline red tests for active task listing, wait/force choices, finite timeout and restart continuation.
- [x] Gate ship/deploy on running work; interactive default waits, noninteractive requires explicit wait/force when busy.
- [x] Persist restart cause and issue one safe continuation after shutdown, with the interruption explanation.
- [x] Update docs/maintainer/deploy.md and run lifecycle/store/CLI tests.

## Delivery

Independent reviews covered shutdown/recovery, permission boundaries, all source scanners and subprocess supervision. Final Node, load-gated verify and commit receipts are recorded in the requested external `codex-polish4-report.md`; this plan remains the implementation record, without duplicating those receipts.
