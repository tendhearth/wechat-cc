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

## PR #881 CI repair

User supplied the repair design and authorized inline implementation on `7e67f0b42` in this worktree. Node's offline server must be ready before publishing its port; the observed 69–78ms empty exits are connection failures, not exhausted deadlines. Keep the requested cold-start improvement as a separate product fix.

Approach: move the existing command registry unchanged to `src/cli/main.ts`, with `cli.ts` dispatching exact native hook invocations to a small entry. Other hook events retain their relay; extract API-info/loop-guard helpers and the request schema so startup does not import the relay or the full desktop schema. A single shared schema is preferred over duplicate validation. Keep production request/soft budgets at 650/800ms after stdin, with a 900ms process-uptime ceiling; test-only env injection requires `NODE_ENV=test`. Native 1s timeout remains authoritative for OS scheduling and synchronous runtime work.

- [x] Reproduce the original Node failure; only await server.ready and confirm the six original tests pass.
- [x] Add red regressions: reject unrelated command/schema loads, allow an injected request budget, separate header timeout/body stall/absence, and bound unfinished stdin to 1.5s.
- [x] Implement the lightweight entry and shared small dependencies; retain CLI help/relay behavior and all existing assertions.
- [x] Measure source and compiled entry before/after, recording runtime uptime before fetch and parent spawn wall time (including first-exec macOS validation).
Final gate: targeted Bun/Node tests, independent read-only review, `bun run verify` on the main Mac, and a local commit with the requested trailer. The external report records the receipts; do not push.

Review focus: help flags must bypass stdin; non-SessionStart relay must receive the already-read input; test env must not affect production; total deadline must include unfinished stdin and body consumption. Measurements use only temporary state and an offline loopback server. The only main-Mac build is the explicitly requested temporary CLI measurement binary.

Review repair: pass the absolute stdin-based deadline into the startup request helper, recalculate after synchronous API-info/token reads, and reject late results even if setup blocks timer delivery. A fake-clock regression first emitted late context and failed, before the repair.
