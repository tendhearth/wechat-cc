# CC daily work — reliable continuation and usable results

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Execute sequential tasks and verify each independently.

**Goal:** Make continuing, finding and reviewing everyday Claude/Codex work reliable before extending external-session import and handoff.

**Architecture:** Preserve the existing task service, project isolation, immutable artifacts and two-column UI. Add explicit continuation consent, useful artifact presentation and persistent task organization as bounded additions. The existing task-entry scope remains the authority for the later external-history/handoff phase; that phase receives a separate detailed implementation plan after these foundations are verified.

**Tech Stack:** Bun, TypeScript, SQLite, vanilla JavaScript/CSS, Vitest, existing native Claude/Codex adapters.

**Spec:** docs/superpowers/specs/2026-09-12-cc-task-entry-scope.md and owner-approved overall evaluation on 2026-09-12.

## Global constraints

- Work only in wechat-cc-cc-kit on codex/cc-workbench-v1. Keep all changes local until publication is separately requested.
- Keep the two-column project/task and conversation layout; details remain progressive disclosures.
- Do not touch frozen CC assets or run build-cc-asset-kit.mjs.
- Do not change native permission mode, project/file isolation, cancellation, credential lifetime or queue safety.
- No silent fresh session when the original cannot resume. Keep original conversation and artifact records.
- Use the original user request, task-scoped history and evidenced artifact sources; no personal companion memory in work tasks.
- Existing active external CLI processes are not claimed as taken over.

## Task 1 — explicit continuation decision

Files: src/core/workbench/service.ts, a focused continuation helper if needed, routes-workbench.ts and their tests; modules/workbench.js/.test.ts and styles/workbench.css for the decision UI.

Interface: detail exposes continuation `{mode: 'new'|'resume'|'restart_required', restart?: {token:string, context:string, eventCount:number, includedEventCount:number, truncated:boolean}}`. The token fingerprints the immutable source session and included task history. `continueTask(id,text, options?:{restartToken?:string})` never restarts without a matching explicit token. The existing continue route accepts only an optional valid restartToken in addition to id/text. Ordinary calls retain their wire shape.

- [x] Add failing service tests: missing original session does not append a user event, queue, spawn or reset session ID on an unconfirmed continue; a matching consent token permits one fresh session with only the disclosed task context; history changes invalidate consent.
- [x] Cover native resume unchanged, provider recheck at queue dispatch, zero-history first run, stopped/restarted service, wrong-task consent, invalid route input and WeChat failure guidance. Never treat missing metadata as successful native restoration.
- [x] Implement bounded context extraction retaining the established 12-event / 24,000-character limit; disclose counts and truncation. No new model call for summaries.
- [x] Add UI tests before integration: show warning and actual context in main task flow; the affirmative button explicitly says it starts anew; regular Continue cannot silently send consent; stale confirmation preserves draft and refreshes task information.
- [x] Verify service/API/UI tests and typecheck. Review the diff, exercise the browser with temporary non-production fixtures, then commit this stage.

## Task 2 — readable artifacts and a direct results entry

Files: a focused workbench artifact-presentation module and tests, modules/workbench.js/.test.ts, styles/workbench.css.

- [x] Add failing tests for a Markdown report with headings/table/code, escaping HTML, refusing executable links, and keeping the source representation accessible.
- [x] Reuse the safe existing Markdown renderer, display image/PDF previews without changing snapshot identity, and retain plaintext for formats without a supported renderer. Preserve download and hash-bound confirmation semantics.
- [x] Put a compact Results action in the task header when actual artifacts exist. Opening it reveals the existing in-page result area, preserving a route back to the conversation and avoiding a permanent third column.
- [x] Verify unsupported formats honestly guide users to the original file, errors remain visible, task changes cannot show another task's preview, and all source/native-artifact paths remain task-bound. Commit independently.

## Task 3 — task retrieval, archive and project-local creation

Files: workbench store/service/routes and DB migration/tests; modules/workbench.js/.test.ts and styles/workbench.css.

- [x] Define and test paged search across all stored tasks, rather than filtering only the previous 200. Use stable ordering and escaped literal search; include a way to retrieve archived tasks.
- [x] Add reversible archive status only for inactive tasks; reject archiving active/queued/cancelling tasks. Show search and archive access compactly, without new navigation columns.
- [x] Let an existing project start a task with its directory and last executor already selected. Keep global New for a different project; keep optional naming/settings folded.
- [x] Preserve selection, drafts and pending permissions when list filters change. Verify migration is non-destructive, archived history is retrievable, and overlapping project writers remain serialized. Commit independently.

## Task 4 — code change review foundation

Files and interfaces are defined from the existing artifact collector before implementation; retain a read-only, task-scoped snapshot boundary.

- [ ] Capture and present project code differences with an honest origin: distinguish an end-of-task working-directory snapshot from edits proven to originate in the task. Include pre-existing modifications explicitly.
- [ ] Do not mutate the user index, checkout or history; use bounded read-only Git commands and existing artifact hashing/storage. Plain folders remain usable.
- [ ] Validate file scoping, unsupported/binary/large changes, hostile text and task-specific snapshots. Render readable changes without claiming an empty diff proves success. Commit independently.

## Next approved phase

After the above checks, continue the approved external-history and explicit Claude/Codex handoff phase. Before editing it, document exact existing source discovery/resume interfaces, collision handling, imported history provenance, artifact-version selection and the one-action review flow. It must not auto-run discovered sessions or silently control an already-running external process. The end-to-end acceptance remains Codex implementation → Claude review → user-selected Codex revision with traceable sessions and versions.
