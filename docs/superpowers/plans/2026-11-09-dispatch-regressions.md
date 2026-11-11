# Dispatch regressions implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline; only the assigned root executor writes this worktree. Investigation and review agents are read-only.

**Goal:** Restore task Bun commands and correctly classify approval script previews.
**Architecture:** Preserve Bun subcommand parsing in the immutable task runtime. Extract preview candidates from execution positions and keep paths within the workspace; leave approval authorization unchanged.
**Tech Stack:** TypeScript, Bun 1.3.14, Vitest, macOS Seatbelt.
**Spec:** User regression brief; docs/superpowers/specs/2026-11-09-dispatch-no-stall-2.md and docs/maintainer/task-permissions.md.

## Global constraints

Only dispatch-regressions at 02d03029f is writable. No live daemon/API/production state, no UI automation or mini. Tests only grow. Final verify on this Mac requires load < 8 and no CivilizationVII in the same command. Commit after green with Codex co-author; do not push.

## Review focus

- Bun install and runtime argv retain their meaning, including absolute-path child processes.
- Frozen installation is truly offline under Seatbelt, with workspace-only writes.
- uptime fallback remains task-only, immutable and inaccessible to host helpers.
- Shell -lc command operands, outside executables and outside scripts never become script previews.
- Single-use approvals, task eligibility, anchored reads and notification redaction retain their security boundaries.

## Task 1: Bun task runtime

Files: task-trusted-runtime.ts, task-uptime.ts, task-runtime-commands.test.ts.
- [x] Record failing real Seatbelt install of a local fixture, then runtime/run/Vitest/bunx checks.
- [x] Correct the preload argument form without changing install arguments or cache isolation.
- [x] Run related Bun and Node tests, including uptime and host isolation.

## Task 2: Approval script classification

Files: permission-command.ts, permissions-command-regressions.test.ts.
- [x] Record failing shell -lc / outside-script / data-argument cases and five requested card cases.
- [x] Restrict candidate selection to interpreter/script execution positions; normalize display only after containment checks.
- [x] Preserve existing multi-script, alias, source, one-shot, eligibility and redaction tests.

## Delivery

- [x] Independent read-only correctness/security review; fix material findings.
Final gate: npm run test:node for related files and load-gated bun run verify; receipts and completion state live in the requested external report.
Delivery: write external report with red/green, limitations and commit. Commit with Co-Authored-By: Codex <noreply@openai.com>; no push.

Progress: initial runtime experiment reproduced split --require converting install to a script; single --require=<path> preserves Bun install parsing. Initial test attempt could not start because this fresh worktree had no dependencies; installing from frozen lock before recording actual red tests.

Implementation ledger: both original bugs reproduced with failing tests. Single-token preload fixes task wrappers and absolute runtime subprocesses. Candidate containment precedes display paths; shell -lc operands are never files. Review option-value/env findings were each covered red before repair; source-looking data keeps the old conservative task-grant veto. Existing multi-source Bun previews remain, but scanning stops at flags, separators and command names. No shared implementation interfaces between the two tasks.

Review complete: all reported option/env and eligibility findings resolved with red/green regressions; independent reviewer reports no remaining important issue. Final baseline withdrawal run: 15 failures / 13 passes across the 28 new cases; production files restored in finally. Related Bun and Node suites: 351 passes / 1 existing skip each (12 files). Final verify follows this snapshot.
