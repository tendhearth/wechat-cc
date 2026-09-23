# Workbench execution contract audit and fixes — 2026-09-22

## Scope and findings

Real installed-daemon tasks used separate disposable projects. The original selftest reported failure for both providers, but inspection found:

- Claude had written the requested file and continued correctly. The test assumed `uname -a` must request permission; the trusted tool policy intentionally allows ordinary shell and file writes.
- Codex had written and collected `hello.txt` in the task output directory. The test checked only the project root while the task instructions directed all deliverables to the output directory.
- One original Codex run reported an output-directory collection warning as well as a saved artifact. A repeat retaining the project did not reproduce that transient warning. Its original environmental cause remains unconfirmed; this change does not claim otherwise.
- Inspection and a failing filesystem regression reproduced a separate concrete bug: snapshot-storage failures were described as unreadable/invalid source files, and retained-turn collection failures could be swallowed.
- The native-history smoke test waited for process exit even when Claude had already replied and retained its session. It falsely failed native recovery.

## Changes

1. Distinguish project edits and explicit user paths from standalone deliverables. Code stays in place and is reviewed as a diff; reports/images without an explicit path use the task output directory. Replies must distinguish completed verification from checks not run.
2. Use the same collection path for retained turns and final settlement. Distinguish project identity failure, unreadable output directory and snapshot-storage failure. Preserve saved snapshots and record recovery after a successful retry. Final settlement waits for pending turn collection.
3. Selftest requests the exact project-root file, verifies its contents, and exercises a disposable deletion probe. Claude uses its deletion approval policy; Codex explicitly requests native escalation for that one command. Both approval response and actual deletion must pass. No permissions configuration was relaxed.
4. Never delete a scratch project after a failed archive/closure confirmation.
5. Native-history/handoff smoke uses `phase=replied` for turn completion and explicitly closes a retained idle task before checking final snapshots.

## Validation

New regressions failed before implementation, then passed. Full suites:

- Bun: 622 passed / 1 skipped files; 8,348 passed / 10 skipped tests.
- Node: 531 passed / 2 skipped files; 7,118 passed / 11 skipped tests.
- Typecheck: passed.
- Dependency check: 0 errors, 7 circular-dependency warnings; no new module dependency introduced.
- Desktop sidecar build and atomic local deployment: passed health check.

Real-provider checks:

- Claude and Codex: explicit root file, native approval roundtrip, deletion probe execution, continuation, archival all passed before and after deployment. The compiled CLI drove the post-deploy checks against the installed daemon. Both task details contained the root-file code snapshot and no collection-failure notices.
- Native history: both original native session IDs restored and original random marker recalled.
- Codex → Claude review → original Codex revision: passed. Selected empty-array fix applied; executable assertions passed; original session and marker, immutable prior snapshot and pre-existing user notes preserved. This ran through the current service with real providers in an isolated fixture, not through a desktop click path.

## Limits

This does not establish full native-app feature parity or verify desktop visual interactions. `replied` means the executor answered, not that an arbitrary user task has been independently accepted as correct. Source/artifact checks and model claims remain distinct.
