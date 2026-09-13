# Native task recovery and recorded handoff — validation, 2026-09-12

Scope: the local two-column workbench can discover supported native histories, import explicitly selected text, continue a closed original session, request a separate review, and send a chosen review quotation back to the original task. No public push or merge was performed.

## Real execution evidence

The opt-in runner is `scripts/workbench-native-history-smoke.ts --run`. It creates disposable projects and its own native sessions, then reads only those exact IDs. It uses the installed strict workbench adapters and existing login configuration. It does not scan personal history, alter global configuration, install dependencies or bypass approvals. If an approval appears, the runner prints it and waits for an explicit task-scoped decision.

Installed versions: Codex CLI **0.153.4**, Claude Code **2.1.267**, Claude SDK **0.2.116**, Bun **1.3.14**. The complete machine-readable result is [the sanitized evidence record](2026-09-12-cc-native-history-handoff-evidence.json).

| Check | Actual result |
| --- | --- |
| Claude original-session recovery | Created and closed a dedicated native session; imported its exact text; resumed the same ID; recovered a random marker absent from the continuation prompt. Passed. |
| Codex original-session recovery | Same controlled procedure; exact original ID and marker preserved. Passed. |
| Real code implementation | Codex added `average(values)` in an owned Git fixture and produced a code-change artifact. |
| Independent review | Claude read the pinned first change snapshot and identified the new empty-array requirement. It also offered a separate optional suggestion. |
| Chosen revision | Only the exact empty-array quotation was sent back to the original Codex task. It added the fix and a test. |
| Result verification | `average([]) === 0`, `average([2,4]) === 3`, `sum([2,3]) === 5`, and the model's `node math.test.mjs` all passed. |
| Identity and versions | Original Codex native ID unchanged; Claude has its own ID; both handoffs reference the same immutable v1 hash; a distinct v2 code snapshot exists. |
| Existing user work | Pre-existing dirty `notes.txt` was classified as pre-existing and remained byte-for-byte unchanged. |
| Native permissions in this run | Zero interactive requests were raised for these sandbox-local operations. This run is not evidence of an approval prompt; protocol/permission tests and the earlier controlled network-approval QA cover that path separately. |

A first combined runner attempt received `native_history_changed` immediately after creating/closing a new Claude session. It failed closed before import/dispatch. A later read was stable. The runner now refreshes only this owned fixture's preview up to twice on that error; it never ignores fingerprints or retries by starting a new model session. The final recorded run passed with **zero refreshes**. Separate earlier text-only and code-loop runs also passed; those do not substitute for the final code-loop evidence above.

## Browser verification

Using the real store/service with clearly marked synthetic providers on an isolated local server:

- Read Claude/Codex history, import without starting a task, and use the explicit original-program-closed continuation step.
- From Codex's completed reply, open “交给 Claude 检查”; the latest code snapshot is selected by default, and all versions and the actual packet are expandable.
- Start the independent review; its source task and original records remain available.
- Edit the chosen quote to the second opinion only, refresh the preview, inspect the packet, then return it to the original task.
- The original task completes and retains its unsent draft. The full machine packet is collapsed in the conversation, not rendered as a giant user message.
- Open the persisted handoff record and confirm the exact selected quote and v1 hash remain visible after revision.
- Checked the compact modal at 1280×720 and the existing main viewport at 663×744. Expanding a long packet scrolls within the body while close/confirm remain visible. Related tasks are disclosures, never a persistent third pane.
- Restarted the isolated development service at `http://127.0.0.1:4187/` after confirming its 7 tasks were terminal; all 7 remain. Verified the native-history entry and a read-only review preview for the existing synthetic sales project; no new model run was started by this UI closeout.
- An older temporary project had been removed. The backend correctly rejected its review preview with `invalid_path`; the UI now tells the user to restore the original folder instead of suggesting a blind retry. Verified the message in the browser and a red/green regression test.

## Automated checks

- Focused backend, HTTP, UI, source/migration and continuation checks passed. The final handoff-specific suite has 8 tests including source-version changes, idempotency, expired previews, corrupt/missing snapshots, selected-quote validation, busy/archive rejection, restart approval, queued cancellation, original native identity and immutable packet copies.
- Full repository TypeScript check passed.
- Native desktop workbench proxy allowlist test passed (1 test).
- Dependency checks: 0 errors; 2 existing Claude permission-module circular warnings; no new handoff cycles.
- The full suite was attempted. One unchanged phone/settings HTTP suite has 16 timeout failures on this host. It also fails alone. A minimal owned Bun server reproduced the host boundary: binding `127.0.0.1` returns HTTP 200; binding `0.0.0.0` then requesting loopback times out. No firewall/network configuration or production listener was changed.
- The remainder of the full suite was rerun with only that known environment-blocked file excluded; **503 files / 6,621 tests passed; 1 file / 10 tests skipped**. This is not a claim that the entire unmodified full-suite command is green.
- After the final missing-project copy fix, the 12 handoff backend/UI tests and full typecheck passed again. The 6,621 figure above is the earlier broad run, before this additional UI regression case.
- Updated the migration smoke's exact table/version assertions, classified/tested the real Claude SDK default, and fixed one pre-existing BOM-unsafe thoughts reader found by the repository guard. Assertions were retained.

## Deliberate boundaries

- This restores a known native session after explicit closure acknowledgement. It does not seize an already running external CLI/app process or provide a cross-application lock. Known local conflicts are blocked; unknown external state remains visible as unknown.
- Codex history covers the native indexed, supported local sources. Unsupported/remote/active sources are not advertised as safely recoverable.
- Handoffs include only the current task's selected text and pinned text/code artifacts (up to 10, bounded to 24,000 characters with truncation disclosed). Images and Office files are not silently treated as inspected content.
- Review means a separate explicitly dispatched task. Revision requires an exact quoted segment selected by the user. There is no automatic agent-to-agent loop or permission bypass.
- Code differences describe working-directory observations before/after a turn, not proof that every byte change was made by the model.
- Independent agents were unavailable because of account usage/local worker compatibility limits. Root performed the review and added regression coverage; no independent-agent approval is claimed.

## Delivery

Branch: `codex/cc-workbench-v1`, local only. Native recovery: `41374425`; recorded handoff: `43e61a66`; unrelated BOM reader guard fix: `eda2409a`; missing-project explanation: `92d1e3c3`. Validation scripts/evidence are committed separately. The main development preview remains running; the isolated synthetic UI server was stopped. No frozen character assets were changed.
