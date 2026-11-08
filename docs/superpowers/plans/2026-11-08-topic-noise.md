# Topic noise implementation plan

> **For agentic workers:** Use superpowers:executing-plans; one writer in the assigned worktree.

**Goal:** Keep CC routine maintenance out of project memory and provide reversible cleanup.

**Architecture:** Preserve structured speech source through both outbound channels; filter before extraction and work write-back. Share conservative legacy-text detection and entry priorities. An offline CLI plans changes read-only, applies existing wrong semantics with a journal, and refuses stale rollback.

**Tech Stack:** TypeScript, SQLite, Vitest, Bun.

**Spec:** User request, and `docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md`.

## Global Constraints

- Only this worktree/branch; one writer. No production DB, daemon, live API, UI, mini, or push.
- Tests only added; RED/GREEN evidence, `bun run verify` on main Mac; no full suite at load ≥8.
- Existing wrong semantics: superseded without replacement; never hard-delete entries.
- Commit after verification with `Co-Authored-By: Codex <noreply@openai.com>`.

## Review Focus

- User development about upgrade/selftest and recorded demos must survive text filtering.
- Both App fallback and mixed deferred notices preserve routine provenance.
- Excluded messages and work advance watermarks without model calls.
- Cleanup and rollback reject stale snapshots atomically and clear stale summaries.
- Explicit recall relevance/model selection survive; neutral injection prioritizes unfinished obligations.

### Task 1: Source filtering

**Files:** `src/domain/topic-noise.ts`, speech policy/proactive/App channel wiring, `threads/extractor.ts`, `threads/work-results.ts`, `threads/extract-prompt.ts` and associated tests.

**Interfaces:** `isRoutineTopicText(text): boolean`, `isTopicMessage(message): boolean`; optional message source metadata on proactive channels.

- [x] Add regression tests for source exclusion, cursor advancement, direct selftest write-back, conservative text cases and both delivery channels.
- [x] Run targeted Vitest tests; observe RED.
- [x] Preserve routine speech source, exclude at source and legacy text boundaries, strengthen extraction/consolidation prompts.
- [x] Run targeted tests; observe GREEN.

### Task 2: Reversible cleanup

**Files:** `src/cli/topic-noise-cleanup-plan.ts`, `src/cli/topic-noise-cleanup.ts`, dialogue command registration/help, CLI and plan tests.

**Interfaces:** Plan with complete before/after snapshots; apply/rollback in immediate transaction; explicit `--db`, `--chat-id`, default dry-run, `--apply --journal`, `--rollback --journal`.

- [x] Add tests for no writes by default, conservative candidates, exact rollback, stale/mismatched scope refusal, existing superseded chains and summary repair.
- [x] Run tests; observe RED.
- [x] Implement plan/apply/rollback and read-only dry-run CLI without migrations; journal before mutation.
- [x] Run tests; observe GREEN; add command parsing/help coverage.

### Task 3: Ranking, eval and handoff

**Files:** `src/domain/topic-match.ts`, associated tests, project memory tests, two topic eval JSONs, T1–T3 design amendment.

**Interfaces:** Shared priority commitment > unfinished progress > decision > conclusion > general progress > fact; explicit model selection/relevance still take precedence for queries.

- [x] Add neutral-query/injection priority tests and offline eval samples; observe RED.
- [x] Implement ranking and recall-time legacy noise exclusion; observe GREEN.
- [x] Fresh read-only branch review; fix correctness findings; run `bun run verify` and inspect results.
- [x] Write requested scratchpad report with RED/GREEN, limitations and integrator cleanup commands; commit, do not push.

Execution notes: root remained the sole writer; explorers and reviewer were read-only. The user supplied a concrete implementation request, so no additional approval gate was introduced. Cleanup lives in src/cli (not src/lib) to respect the lib dependency boundary. A shared create-only JSON writer supplies durable exclusive journals without weakening the JSON guard. Fresh review findings (completed pending items, extraction summaries, journal directory fsync, owner selftest development titles) were reproduced where observable and fixed before final verification. Final verification and commit evidence are in the requested delivery report.
