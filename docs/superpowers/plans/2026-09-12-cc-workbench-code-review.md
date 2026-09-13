# CC workbench — project change snapshots

Owner-approved daily-work sequence, following reliable continuation and task organization. Implement with subagent-driven-development (root owns this bounded backend module while Task3 UI is independent).

Goal: show readable changes between the actual project working files at execution start and confirmed exit, distinguish pre-existing edits, and preserve immutable evidence without touching user index or git history.

## Contract

New src/core/workbench/git-review.ts with captureGitBaseline(project) and finishGitReview(baseline). Capture after directory reservation and before provider.spawn. Finalize only after writer close confirmation and before releasing reservation, including late-close path. No snapshot for a task cancelled while queued. Non-Git projects keep current behavior and get no useless code artifact.

Capture initial HEAD for provenance, but compare actual working-file bytes captured at execution start. Git-clean does not imply bytes match the HEAD blob (CRLF, filters, assume-unchanged), so do not infer missing snapshots from blob contents. Enumerate tracked, untracked, initial HEAD and dirty paths; preserve roster of omitted initial files. At end inspect the union of initial roster and current tracked/untracked paths. New files absent from the initial roster compare to missing; omitted files never do. Include Git-reported pre-existing paths separately. External edits during a run cannot be attributed to a specific writer; state this in report.

All Git calls are argument arrays, no shell; no ext-diff/textconv/pager/prompts/optional locks. Use timeout/maxBuffer. Read working files through existing descriptor-anchored no-symlink helper (extend optional size limit, default unchanged). Limit candidate paths 1000, file text256KiB, total text16MiB, rendered diff total2MiB; report partial/skipped instead of claiming complete. Exclude .git and .cc-workbench, ignore known secret/hidden artifacts except source control metadata; binary/link/submodule/non-UTF8 and over-limit paths report reason. Path scope canonical project, including nested repo directories. No index, checkout, hooks, commit or git object mutations. Disable configured filters/fsmonitor, discard inherited Git control variables, prevent lazy fetch/replacement objects; enforce a15s per-phase deadline and5s command deadline. Preserve UTF8 BOM and fail closed on nonUTF8 paths; nonblocking anchored file opens plus before/after fstat prevent FIFO hangs and inconsistent reads.

Use git --no-index only between task-owned temporary files for bounded unified diffs; retain only hunks and store actual relative path separately. Clean up temporary files. A new project file/deletion compares to empty; no changes is an observation, not a success claim.

Persist JSON via an extracted saveArtifactSnapshot helper in artifacts.ts, custom MIME application/vnd.cc.workbench-review+json (ordinary collected .json cannot impersonate it). JSON schema version1, start/end timestamps/heads, scope working-tree-before-after, status complete|partial|unavailable, preexistingPaths[], notes[], files[{path,preexisting,kind,beforeSha256,afterSha256,diff?,reason?}]. Name human readable with run identity; no user-folder generated report. Existing hash-bound artifact approval/download is reused. No schema migration required.

Frontend helper renders specialized JSON as compact file disclosures with added/deleted lines and truthful coverage header, original JSON downloadable; raw HTML always escaped. Only generated custom MIME triggers it. Artifact section stays in existing two-column conversation. Also allow common code source extensions in designated output directory as text/plain (HTML source displayed escaped, never executed).

## Steps / validation

- [x] RED tests in git-review.test.ts: pre-existing edits unchanged vs modified during run, staged edits, edits committed during run, new/deleted files, nested project scope, symlink/binary/limits, nonGit, exact unchanged user index/HEAD/status. Temporary synthetic repositories only.
- [x] Implement bounded snapshots and generated artifact storage. Existing artifact tests remain passing; source output files safe.
- [x] Service integration after Task3 backend commit: baseline before spawn, final after close, uncertain and queued cancel do not finalize early. Tests inspect generated artifact + hashes using fake providers, no real model calls.
- [x] Frontend after Task3 UI commit: specialized report + safe line rendering and unavailable/partial states tested; browser exercise synthetic repository end-to-end.
- [x] Independent review, focused suites and full typecheck; separate commit. Do not push.

Native existing-session discovery/resume/handoff remains the next approved phase and gets its own exact plan based on installed SDK/protocol evidence.

## Completed verification

Independent final review passed 168 backend/frontend tests, full typecheck and diff check. Root final focused service/artifact/UI/API suite passed182 tests after an added review-save-failure regression. Final stage typecheck passed with only next-stage untracked native-history TDD files excluded (they are being developed independently); no Task4 errors. Browser used production service with a synthetic repository/fake provider: actual600→900 diff, pre-existing marker, addedtestfile, source/coverage disclosures and readable red/green hunks verified. No real model executed by this fixture.

Additional regression fixes: shutdown awaits in-flight late-close collections; serialized JSON bytes are bounded even when escape expansion exceeds rawdiffsize, and a failed generated-review save cannot suppress ordinary results. UI preview independently caps displayedfiles/lines/text and points to complete snapshot download.
