# API task executor implementation

Spec: `docs/superpowers/specs/2026-09-14-cc-api-task-executor.md`. Standing autonomous approval applies. Existing isolated worktree `codex/cc-workbench-v1` is used; no production bot restart or publishing.

1. Add an isolated abortable API transport with explicit finish/model metadata, no automatic retry and bounded output. Unit/owned HTTP tests cover tool calls, stream error, truncation and abort. Preserve legacy transport behavior.
2. Add bounded project read/list and exclusive task-artifact tools with normalized approval descriptions, anchored no-follow filesystem access and task-internal exclusion. No shell or project mutations. Test traversal, symlinks, overwrite, boundaries and cancellation.
3. Add a CC-managed transcript store and serialized task adapter. Bind source/task/owner/project identity, persist before effects, reject incomplete recovery, stream public text/activity, and close only after active work drains. Test lifecycle, isolation, resume and tool errors.
4. Extend capability metadata to distinguish CC-managed continuation from native resume. Register configured API adapter separately in workbench bootstrap and the isolated dev runner, with honest model/tool limitations. Preserve existing native adapters and companion registry.
5. Exercise the real service against an owned loopback API, including permissions, output collection, continuation and stop. Run relevant regressions and full typecheck. Independent code review, fix findings, document evidence and commit. Overall goal remains active; this is one actual execution path, not a claim that all CLI/App features are covered.
