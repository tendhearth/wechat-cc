# Task model and reasoning selection

Date: 2026-09-13. Worktree `wechat-cc-cc-kit`, branch `codex/cc-workbench-v1`, baseline `e81fe704`.

This slice lets a workbench task choose its native model and reasoning setting without leaving CC. It does not establish complete CLI/App parity or completion of the unified-entry goal. The final verification below distinguishes passing workbench checks from an independently reproduced host-network failure in the older settings-panel suite.

## Behavior

- Existing closed task settings contain the controls; the conversation remains two columns. Opening settings reads the selected executor's catalog for the selected project. Model inventories are not embedded in the UI.
- New tasks may inherit configured provider defaults. Imported native sessions and automatically resumed sessions preserve their native settings instead of receiving CC's global fallback model. “自动（沿用当前设置）” omits an override; it is not a reset operation.
- A task's requested settings and each accepted run's immutable settings are durable SQLite records. Native observations are separate, and an unreported model or effort is not inferred from the selection. Observation updates cannot change task settings or invalidate a preparation by changing the task timestamp.
- Active runs cannot change model through live input. A queued supplement keeps its original run's accepted settings and receipt identity. A terminal retry binds text, ordered material, and execution settings; a later task setting cannot rewrite the original acceptance.
- Native preparation binds the selected setting. Ordinary recovery also obtains a preview for the selected next-run setting, with both the chosen and retained settings in its token. The preview does not apply settings before the user submits. Changes to the selection or retained task invalidate an earlier token.
- A new Claude/Codex review uses the target executor's defaults, not the source executor's model ID. A selected review returned to its original task keeps that task's settings. The handoff record includes the accepted target configuration and pinned materials.
- Schema v54 adds task configuration, immutable run configuration/observation, and optional execution on durable input receipts. Existing imported tasks default to native inheritance; other tasks retain provider inheritance.

## Native protocol evidence

Repeatable owned fixture: `bun scripts/workbench-native-models-smoke.ts --run`.

Actual installed Claude Code 2.1.267 / Agent SDK 0.2.116 and Codex 0.153.4 run against synthetic loopback model endpoints, temporary native homes and owned projects. A macOS network profile restricts the native executors to loopback. Configured owned MCP/startup-hook markers must remain absent during discovery. No real account request, user MCP, WeChat send or bot restart is part of this proof.

The fixture verifies:

1. Native model catalogs are read without a generation request, empty session transcript, MCP startup or configured Claude startup hook.
2. Catalog-selected model and low/high effort values reach actual requests on the initial turn and continuation.
3. Explicitly changing the model and effort on resume changes the request while preserving the native session and history.
4. Automatic resume retains that changed model and effort, despite a deliberately different CC fallback setting.
5. Native observations use resolved model names, not requested aliases. Unsupported effort is rejected before generation.

Codex's model-list `id` identifies a picker preset; `model` supplies the executable slug. CC normalizes its shared catalog key from the latter. [The pinned protocol](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/protocol/src/openai_models.rs) defines both fields separately, even though this installed version currently constructs equal values. Nine regression cases cover unequal fields, missing/invalid model values, default resolution and actual start/resume arguments. A second owned run, `bun scripts/workbench-native-models-smoke.ts --run --split-codex-preset-ids`, changes only preset IDs in the catalog envelope while preserving all native execution and model traffic. It passes with the unchanged executable slug reaching first and resumed requests. This synthetic-envelope test is distinct from the unmodified native catalog proof.

Observed catalog inventory and selected model names in this fixture are not hosted entitlement or model-quality claims. Claude reports no observed effort through the messages used here, so the UI leaves it unknown.

An extra Codex `ultra` case confirms that the native session can acknowledge `ultra` while the ordinary Responses request uses `xhigh`. This follows [native model-owned effort normalization](https://raw.githubusercontent.com/openai/codex/1715e55076737158ba61d43158ede504de6d4ce1/codex-rs/protocol/src/openai_models/reasoning_effort.rs). CC records the native session setting without claiming it is the literal HTTP field. This finding does not establish complete background/subagent support.

## Browser and storage evidence

The production UI → restricted operator proxy → real HTTP routes → task service → SQLite fixture exercises different project models, native-style effort options, automatic restoration after reload, unavailable observations, active controls, receipt identity, attachments and database reopen. Only the provider's execution/catalog responses are synthetic. Recovery-specific verification also rejects the old model's token and dispatches only with the newly prepared token.

See [browser evidence](2026-09-13-cc-task-execution-models-browser.md) and its adjacent JSON for exact runs and screenshots. This proves the desktop/service path; native request fidelity is established separately above.

## Review corrections

- A recovery token initially covered only retained settings. A real HTTP/service/SQLite regression proved that token A incorrectly accepted model B; it now requires the token prepared for B.
- The native preparation response initially shared its nested settings object with the server decision. A failing mutation regression led to a deep copy at the return boundary.
- The historical discovery timeout wrapper rewrote model-specific errors and abandoned inner work. Model discovery now preserves its bounded errors, and native discovery owns its overall deadline and subprocess cleanup rather than relying on an outer race.
- Live receipts distinguish the settings of the active run from a different next-turn draft kept in another window. A receipt cannot clear newer draft content or silently acknowledge another execution choice.
- The native folder picker now goes through the normal change handler to retain its draft and refresh the correct project's catalog. A picker returning after navigation cannot overwrite another draft or task; three behavior regressions cover these cases.
- Full-repository guards exposed a stale schema/table assertion and two missing Windows guards around POSIX-only attachment mode assertions. Assertions were retained and updated. The subprocess guard now parses real calls: review found the same 25 executable sites as before, excluding only an incorrectly matched method declaration.

`bun scripts/workbench-model-catalog-deadline-smoke.ts --run` verifies one total discovery budget across configuration, initialization and cleanup. Three actual native stall scenarios return in about 1002 ms for a 1000 ms budget; all recorded owned processes/descendants exit, and an expired configuration probe never starts the catalog subprocess. The normal catalog/start/resume and five-scenario Codex MCP/phone smoke also pass after this change.

## Remaining scope

Complete background-agent lifecycle, plugin/hooks and general MCP authorization UI, additional workbench executors, independent worktrees, multi-host continuation, and fuller phone creation/material workflows remain separate requirements. This work does not take over an externally active native process or merge one provider's tool state into another provider's session.

## Final verification

After the final protocol, picker and test-guard corrections:

| Check | Result |
| --- | --- |
| Full repository `bun --bun vitest run` | **523 files passed, 1 failed, 1 skipped; 7048 tests passed, 16 failed, 10 skipped** (7074 total), 80.84 seconds |
| Failing suite | Only `src/daemon/settings-panel.test.ts`: the same 16 HTTP timeouts on an IPv4 wildcard listener |
| Complete repository `bun run typecheck` | Passed |
| Rust `workbench_proxy_tests::allows_only_the_exact_workbench_method_route_pairs` with `--exact` | **1 passed**, 5 filtered; exact catalog/preparation routes and methods checked |
| Native model/deadline unit boundary | 6 files, 206 passed |
| Final UI/proxy boundary including native picker | 13 files, 246 passed |
| Unmodified native model proof / split-preset proof / deadline proof | Passed, owned native processes and synthetic endpoints only |
| Production browser → HTTP → SQLite | Execution: 2 tasks / 6 dispatches; attachment regression: 2 tasks / 5 dispatches |
| Independent review | Acceptance, recovery, queue identity and final preset mapping reviewed; no unresolved confirmed dispatch/isolation defect |
| `git diff --check` | Passed |

The full run exited **1**; it is not a fully green repository result. Both settings-panel files are byte-identical to baseline `e81fe704`. Standalone Bun 1.3.14 and Node 26.4.0 probes without repository imports reproduce the failure before any request handler is invoked: an explicit `127.0.0.1` listener works, whereas a `0.0.0.0` listener does not accept the same loopback request. This identifies an execution-environment boundary without asserting a specific firewall cause. No test was skipped or given a longer timeout, and production listener defaults were not changed. See the [reproduction record](2026-09-13-cc-task-execution-models-network.md). Full final log: `/tmp/cc-task-execution-models-full-vitest-final.log`.

An earlier Rust invocation used an incomplete exact test name and collected zero tests. It was not counted; the result above is the subsequent fully qualified invocation that ran one test. The existing missing `marked.bundle.mjs.map` source-map warning remains unrelated.

## Local commits

- `b47c5573`: platform-sensitive attachment assertions and executable spawn detection.
- `17a4beb6`: native discovery, explicit model/effort mapping, observations and bounded cleanup, with owned native probes.
- `b7b94286`: durable accepted settings, recovery/receipt identity and exact service/HTTP routes.
- `09645d54`: existing desktop disclosures, isolated drafts, folder-picker handling, operator proxies and browser fixture.

These commits were not pushed or merged. No real bot was restarted and no native desktop application was rebuilt in this slice. User-facing verification of these latest bytes in the running application is separate from the owned browser/native evidence.
