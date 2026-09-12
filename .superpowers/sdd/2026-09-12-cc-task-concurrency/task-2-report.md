# Task 2 UI implementation report

## Result

The existing two-column workbench now consumes backend-provided `waitingFor` metadata without deriving path conflicts in the browser. Queued tasks show the real blocking task for same or nested folders. A quarantined path reports that the previous execution has not confirmed exit, that the queue cannot progress, that the owner should inspect the process and output, and that unrelated folders can continue.

Task operations are isolated by mutation key. Duplicate or conflicting requests for one task remain suppressed while requests for another task can proceed. List reads use a request generation so older successes and failures cannot replace a newer task snapshot. Permission decisions remain available when an unrelated preview error is visible.

The mutation scopes are explicit: all create requests share the `create` key, while continue, stop, and permission decisions share `task:<taskId>` for their target task. This prevents conflicting writes within one task without coupling unrelated tasks. Each controller instance owns a monotonically increasing list-request generation; only the newest `GET /v1/workbench` response or rejection may update that controller, and destroy invalidates any remaining list request. Existing detail and artifact generations continue to guard selected-task content independently.

## Red

The expanded workbench suite initially had 8 expected failures:

- same-path, nested-path, and unconfirmed-writer waiting copy was absent;
- permission buttons were disabled by an unrelated global error;
- an older list success replaced the newer list and an older list rejection escaped;
- the page-wide mutation lock prevented task B from posting while task A was pending.

The remaining 39 tests stayed green. Existing behavior already covered multiple genuine permission counts and queued cancellation identity, and the new characterization tests preserve those contracts.

## Green

- Added the additive `WaitingFor` UI type with `same_path`, `nested_path`, and `writer_not_closed` reasons.
- Added compact, escaped waiting text to task rows, selected-task empty dialogue, and queued controls.
- Kept queued follow-up drafts editable, sending disabled, and Stop available.
- Replaced the page-wide mutation boolean with `create` and `task:<id>` keys.
- Added list request generations alongside the existing detail and artifact request guards.
- Removed the unrelated global-error gate from permission buttons and decisions.
- Preserved captured task identity, navigation generation, draft clearing rules, selection, focus, scroll, disclosure, and collapsed global navigation behavior.

## Verification

- `bun --bun vitest run apps/desktop/src/modules/workbench.test.ts` — 47 passed.
- `bun --bun vitest run apps/desktop/src/modules/workbench.test.ts apps/desktop/src/modules/workbench-navigation.test.ts` — 50 passed.
- JavaScript syntax and scoped diff checks are run immediately before commit.

Vitest continues to print the pre-existing warning that `apps/desktop/src/vendor/marked.bundle.mjs.map` is absent. The tests themselves pass.

## Review fix evidence

Review exposed that detailed queue guidance was part of the empty-dialogue fallback. Real creates and continuations already include a user event, so the selected task could hide why it was waiting. Three same-path, nested-path, and unconfirmed-writer tests were changed to include real user/history events; all three failed before the fix. Queued tasks with `waitingFor` now render one compact guidance row after their dialogue regardless of event count, while the composer retains only the stop action guidance to avoid repeating the blocker title. The focused regression run passes 3 of 3 tests, and the full verification above covers the remaining workbench and navigation behavior.

## Risks and limits

- The UI trusts `waitingFor` and per-task permission counts from the backend; it does not infer lock ownership from path strings.
- Mutation keys prevent duplicate actions within one task but do not display a persistent request spinner. The accepted POSTs are short and polling supplies the durable queued/running state.
- Real multi-process scheduling, FIFO behavior, queued cancellation, and writer quarantine remain backend responsibilities and require the integration and live QA tasks.
