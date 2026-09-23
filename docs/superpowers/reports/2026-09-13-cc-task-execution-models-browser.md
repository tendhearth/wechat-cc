# Task execution models: browser integration evidence

Date: 2026-09-13. Worktree `wechat-cc-cc-kit`, baseline `e81fe704` plus the pending execution-model implementation.

Both modes of the repeatable browser fixture passed after the service model route was integrated:

```sh
bun scripts/workbench-attachments-browser-smoke.ts --execution
bun scripts/workbench-attachments-browser-smoke.ts
```

The fixture uses the production workbench module/API transport, restricted host operator proxy, real internal HTTP routes, task service, SQLite and attachment snapshots. Browser JavaScript never receives the operator token. The AgentProvider supplies synthetic catalog entries, records the actual spawn execution choices and attachment bytes, and reports synthetic observations. State/projects are isolated temporary directories and are removed afterward. It does not invoke user model APIs, MCP servers, native CLI sessions or WeChat.

## Execution mode

The final run completed two tasks and six dispatches. Assertions establish:

- No catalog discovery occurs before opening settings. Discovery is scoped to the selected project; reloading performs fresh discovery without mixing projects.
- Creating project A selects `fixture-model-A` / `deep`; project B selects `fixture-model-B` / `high`. These exact choices reach the service's provider spawn context.
- The task disclosure shows the provider-reported `observed-fixture-model-A` separately from the requested choice, and says effort was not reported. The fixture deliberately reports a different model name and omits effort.
- Choosing automatic restores both null overrides after a page reload. Attachment-only continuation receives `{defaults:"provider",model:null,reasoningEffort:null}`.
- Active model/effort controls are disabled. Queued input uses the accepted run's execution choice and retains its receipt run identity.
- When the fixture's original session becomes unavailable, changing the next-turn selection to `fixture-model-B` / `high` requests a fresh ordinary restart preview. Its confirmation token changes, and the confirmed dispatch receives exactly B/high through the real service.
- SQLite reopen retains the last selected B/high choice and its reported observation. Attachment reads retain the original names, order, bytes and SHA256 identities.

Unit regression additionally covers the preview response being lost, retrying it, an earlier A response arriving after B is ready, and attempts to submit stale A tokens. The form stays disabled until the matching preview is available. Execution error messages now give the next action while leaving raw diagnostic codes in task data; submit failure retains the draft.

This proves the browser-to-service contract. Synthetic model IDs/efforts are fixtures, not advertised native options. Installed executor catalog discovery, request mapping and native observation fidelity require the separate native protocol evidence.

## Attachment regression

The default mode also completed two tasks and five dispatches: actual file chooser, PNG/text bytes reaching AgentAttachment, real snapshot preview/download, delayed upload while switching tasks, preserved task drafts, reload, attachment-only continuation, queued material and database reopen. Both modes observed one expected best-effort discard refusal after the attachment was already claimed. The fixture allows only that exact discard response and proves its ID remains task-owned with unchanged bytes; every other HTTP failure fails the run.

## Screenshots and records

Execution evidence directory:

`/private/var/folders/yc/y9bc_lbd69z5_3_dqbt5bn6c0000gn/T/cc-attachments-browser-evidence-U8GWK6`

Default attachment evidence directory:

`/private/var/folders/yc/y9bc_lbd69z5_3_dqbt5bn6c0000gn/T/cc-attachments-browser-evidence-SRUKJA`

The execution screenshots cover the expanded creation disclosure, the task settings and observed-model area, ordinary restart confirmation, and the existing layout at 1280, 760 and 430 pixels. Visual inspection of the final restart screen and the 1280/430 settings found no overlap or horizontal overflow. The task overlay remains bounded and scrollable; the conversation and composer retain their normal space when it closes.

- `create-execution-options.png`: selected native-style model and effort in the existing creation disclosure.
- `task-execution-options.png`: automatic next-turn choice beside the distinct last reported model.
- `restart-execution-preview.png`: model-bound ordinary recovery confirmation before the sixth dispatch.
- `task-options-1280.png`, `task-options-760.png`, `task-options-430.png`: readable settings overlay at desktop and narrow widths.
- `workbench-1280.png`, `workbench-760.png`, `workbench-430.png`: normal conversation/composer with settings closed.

A durable copy of both machine-readable results is retained in [the browser record](2026-09-13-cc-task-execution-models-browser.json). Screenshots remain in the synthetic evidence directories; rerunning the script creates fresh evidence.

Final focused verification: 13 UI/browser-proxy suites, 246 tests passed, including three later native-folder-picker regressions; TypeScript check passed; Rust exact method/route allowlist test passed; diff whitespace check passed. The picker now triggers the same change/draft/catalog path as typed input and rejects late results after task/draft navigation. The existing missing `marked.bundle.mjs.map` warning is unrelated.
