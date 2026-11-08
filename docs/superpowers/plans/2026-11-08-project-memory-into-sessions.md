# Project memory into terminal sessions

> Execution: native implementation with read-only parallel investigation and final review. User supplied the specification and authorized implementation, verification and a local commit.

**Goal:** New Claude Code and Codex sessions receive a conservative project topic index from CC.

**Design:** A synchronous SessionStart hook requests a FILE-token-only terminal route. The daemon resolves the actual git root/common directory, compares repository/remote names exactly to topic titles/aliases, and follows work-entry → matter → CLI binding → cwd evidence. Conflicting candidates produce no context. Only the owner's non-private, non-done topics and live entries are eligible. The existing index renderer is reused without bodies or summary; commitments and ongoing progress come first. The complete context, including its staleness notice, is at most 1200 Unicode characters.

**Constraints:** No production state/config, live APIs, daemon/service operations, push or main-Mac UI automation. Existing worktree and branch are assigned to this task. Tests only grow. Hook failures are silent and bounded below 1.5 seconds. Config defaults on and is immediately writable in settings. Existing correction paths remain authoritative.

**References:** User task; `2026-11-05-topics-t1-t3-design.md`; `2026-11-06-t4-topic-bubbles-design.md`; `2026-09-09-cli-hook-push-design.md`; official Claude and Codex hooks documentation.

## Review focus

- Worktree/subdirectory/symlink identity must not be guessed from wt-* names.
- Private, foreign-owner, completed or marked-wrong memory must never enter context.
- Conflicting name/history evidence must fail closed; historical CLI pruning must retain matter evidence.
- Deadline must cover response-body consumption; failures must emit no stdout/stderr.
- Existing hook installation must gain exactly one synchronous SessionStart handler without losing other hooks.

## Tasks

- [x] Add red mapping/identity/rendering table tests, implement conservative resolver and daemon memory service, verify green.
- [x] Add red hook/route/upgrade/deadline tests, implement native SessionStart for both CLIs and FILE-only route/schema, verify green.
- [x] Add red config/settings persistence tests, wire default-on switch and settings control, verify green.
- [x] Review the complete change and fix material findings with regression tests.

Final verification, local commit and delivery receipts are recorded in the requested external `codex-project-memory-report.md`; do not push.
