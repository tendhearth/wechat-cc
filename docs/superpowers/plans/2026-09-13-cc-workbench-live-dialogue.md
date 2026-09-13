# Workbench live dialogue implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or executing-plans. Preserve existing assertions and record red/green verification.

**Goal:** Users can submit supplements, answer agent questions and notice pending decisions without leaving CC.

**Architecture:** Optional native steer plus persistent sequential fallback; task-bound question broker; one global attention poller independent of workbench page lifecycle.

**Tech Stack:** TypeScript/Bun/SQLite, native Claude SDK and Codex app-server, vanilla desktop UI/Tauri.

**Spec:** ../specs/2026-09-13-cc-workbench-live-dialogue-design.md

## Global constraints

- Work in existing isolated codex/cc-workbench-v1; no push, frozen art changes or placeholder builder.
- Keep permissions strict. New input does not grant permission or bypass native-session continuation checks.
- Secret questions are explicitly unsupported. No automatic resume after cancellation, failure or daemon restart.
- No overlapping writers for same/nested project; no overlapping native dispatch.

## Task 1 — Native protocol (delegated)

Files: agent-provider.ts (root types), codex-app-server.ts/tests, claude-agent-provider.ts/tests, wire-workbench.ts, dev runner.

Interface: AgentUserQuestion {id,header,question,options,multiSelect?,allowOther?}; AgentUserInputRequest {questions}; answers Record<string,string[]>; SpawnContext.requestUserInput(request,signal?) -> Promise<answers|null>; AgentSession.steer?(text) -> Promise<void>.

- [x] Test expected native turn ID, rejection and cancellation before adding steer.
- [x] Test structured questions route only to owning turn; late/duplicate answers cannot affect next turn.
- [x] Claude AskUserQuestion returns updatedInput.answers before generic permission classification.
- [x] Run native adapter tests and inspect exact local SDK/protocol contracts.

## Task 2 — Service ownership and durable supplements (root)

Files: user-input.ts/tests, live-inputs.ts/tests, lib/db.ts, workbench/service.ts/tests, routes-workbench.ts/tests, native+development proxy allowlists.

- [x] Add validator/broker tests for bounds, choices, immutable requests, cancel, stale and duplicate answers.
- [x] Add migration and supplement store. IDs are global UUIDs; a reused ID with differing task/run/text is conflict. Pending/sending become held on restart.
- [x] Add service tests: successful native steer, rejected steer, durable sequential delivery, same-session requirement, cross-task/stale run rejection, stop and crash keep unsent text.
- [x] Implement GET attention, POST input/withdraw-input/answer; include questions/input records and run identity in detail.
- [x] Run route authorization tests, lifecycle tests and migration regression checks.

## Task 3 — Focused UI (delegated)

Files: workbench.js/tests, workbench-interaction.js/tests, styles/workbench.css.

- [x] Test running controls distinguish native delivery and queued next round, show held/withdrawn records honestly.
- [x] Render task-bound questions with options/free text and submit/decline. Preserve per-request draft over polling.
- [x] Submit immutable task/run/request IDs and keep drafts on failure. Prevent duplicate clicks and stale response navigation.
- [x] Provide exported openWorkbenchTask(id) for global attention entry.

## Task 4 — Global attention (delegated)

Files: workbench-attention.js/tests, main.js, dedicated CSS.

Contract GET /v1/workbench/attention -> {tasks:[{id,title,providerId,pendingPermissionCount,pendingQuestionCount,attentionKey}]}; key changes only for new pending request IDs. No body or path in native notification.

- [x] Poll independently of selected page; finite backoff on unavailable backend; stop on destroy.
- [x] Test unchanged requests do not repeat notifications, resolved requests disappear, new task selection opens exact task without sending anything.
- [x] Reuse notify_user native command. UI remains useful if notifications denied; no automatic permission prompt.

## Verification / delivery

- [x] Review all diffs and plan constraints; run workbench/native/provider/route/desktop tests and full typecheck.
- [x] Browser-check question/queue/attention states in isolated fixture, then update real preview without seeding user tasks.
- [x] Record exact scope and limits, commit coherent changes, leave branch unpushed.

验证结果与当前原生能力边界见 [交付报告](../reports/2026-09-13-cc-workbench-live-dialogue-validation.md)。
