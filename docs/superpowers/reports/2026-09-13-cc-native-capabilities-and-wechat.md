# Native task capabilities and WeChat control

Date: 2026-09-13. Worktree: `wechat-cc-cc-kit`, branch `codex/cc-workbench-v1`. Baseline: `6bb59ab8`. Source commits: `1cd5c3ad` (native capabilities), `e629f555` (WeChat controls), local only.

This delivery improves the existing two-column task workspace. It does not claim that most Claude/Codex CLI or native App features are covered, or that the full unified-entry goal is complete.

## Native execution retained

Claude task options now select transport/model/auth fields explicitly instead of inheriting the companion's entire configuration. Project/local instruction and skill sources remain native. Supported previously approved stdio/HTTP/SSE MCP configurations are read from user/project/local scopes, with native precedence, disabled flags and merged allow/deny policies. The same merged policy reaches the native CLI at flag scope, preventing a user allowlist entry from being lost when project settings load.

User-level instruction/persona files are deliberately not loaded in this slice. Reading user MCP definitions is separate from importing global personal instructions. Native hooks, plugin startup and skill inline shell expansion remain disabled. Supported native tool calls receive individual task-owned approval even if local native settings preapprove them. Companion integrations are excluded by identity/config provenance before startup. An empty daemon route allowlist remains in force.

Private companion environment values are removed from the process overlay. Private keys found in project/local `settings.env` are overridden with empty values at flag scope; ordinary native tool authentication survives. This neutralizes known private environment values; it is not a claim of operating-system isolation or erasure of every environment variable.

Codex starts a private native app-server, reads effective configuration before starting/resuming a thread, and preserves enabled direct external MCP servers and configured web search. Default web search is cached. Server defaults and existing per-tool approval overrides are set to prompt; native tool allow/deny lists and credentials stay in their original configuration. Workspace-write, on-request and user approval review remain enforced.

Codex MCP approvals require privileged native metadata, exact server/arguments, one uniquely matching observed unfinished invocation, and the active thread/turn. Approval is one-shot. Unsupported generic forms/OAuth requests are visibly declined. Stop, native resolution, turn completion and process exit invalidate pending decisions.

Capability omissions are recorded through a run-bound notice callback, never as fabricated assistant replies. Approval previews redact common credential fields, URL authentication/query credentials and named header pairs. Arbitrary secrets embedded in free prose cannot be reliably inferred.

## WeChat controls the same task service

- `任务` / `/task`: owner-filtered recent task list.
- `任务 <ID>` / `任务 <ID> 结果`: state, latest reply, newest saved artifact names, retained input and pending requests.
- `任务 <ID> 补充 <要求>`: native Codex steering when acknowledged, or Claude's next turn in the same task/session. Pending, confirmed and uncertain delivery are distinct.
- `任务 <ID> 停止`: stop the original run, with a durable command receipt before the side effect. A failed message reply followed by retry or database reopen cannot stop a later run. Unfinished receipts report uncertainty and are never re-executed.
- Explicit permission/question IDs use the existing task-run APIs. Stale or wrong-task replies cannot grant or answer a new request. Long permissions require complete desktop review for approval; the phone can still decline.

Commands enter after sender authorization and canonical message recording, before companion recall and unrelated model-health services. Ordinary chat keeps its existing route. Both configured owner and actual sender identity are checked. There is no global last-used-task inference or interception of plain y/n.

Stable inbound identities also reuse durable live-input receipts, including idle continuation. Changed-content retries conflict. The outbound adapter's returned error is treated as a failed delivery rather than success, so redelivery retrieves the original receipt.

New task commands and their replies carry explicit `workbench` provenance in the canonical audit. Personal-memory extraction filters both new batches and context tails; a task-only batch advances its watermark without a model call. The work journal and canonical audit remain available. Older rows without provenance are not guessed or relabeled.

## Validation

Final combined test command:

```sh
bun --bun vitest run src/core/workbench src/core/claude-agent-provider.test.ts src/daemon/bootstrap/wire-workbench.test.ts src/daemon/inbound src/daemon/wiring/pipeline-deps-converse.test.ts src/daemon/wiring/recent-inbound.test.ts src/daemon/internal-api/routes-workbench.test.ts src/daemon/ilink-glue.outbound.test.ts src/daemon/ilink-glue.test.ts src/daemon/threads/extractor.test.ts src/lib/db.test.ts src/lib/messages-store.test.ts apps/desktop/src/modules/workbench*.test.ts scripts/workbench-claude-config.test.ts scripts/workbench-codex-config.test.ts
bun run typecheck
```

Result: **71 files, 825 tests passed**, complete repository typecheck passed, `git diff --check` passed. This was an affected-suite run, not a claim that every repository test ran. Mock transport tests intentionally emitted failure/undelivered diagnostics. No real messages were sent.

Independent reviews found and drove red/green regressions for native policy selectors, private disk environment injection, omission visibility, credential-bearing previews, stop replay across runs, task traffic entering personal-memory extraction and reversed artifact selection. The reviewed fixes retain original histories and do not change frozen art.

### Real harness, owned synthetic endpoints

Both native smoke scripts use actual installed executors with temporary owned projects/configuration/MCP servers and loopback fake model responses. They prove configuration, wire protocol, approval and lifecycle behavior, not real model judgment, commercial API quality or third-party OAuth compatibility.

| Native executor | Verified |
| --- | --- |
| Claude CLI 2.1.267 / Agent SDK 0.2.116 | Project CLAUDE.md marker reached the native request; skill advertised and actual Skill activation loaded its body; direct MCP advertised; user/project allowlists merged; inherited permissive settings still prompted; approve invoked once, decline/cancel zero times; hooks and companion aliases never started; private disk env values blank, ordinary tool auth retained |
| Codex 0.153.4 | Two consecutive approvals required two decisions and executed twice; deny/cancel executed zero calls; process close and same native session resume preserved identity and approval; companion starts zero; recognized credentials absent from permission preview/activity |
| Synthetic phone → task service → native Codex | Owner found the task, read its actual pending permission ID, inspected the tool call, approved and retrieved the native result; one task/run/session, one MCP execution, two fake-model requests; wrong-owner and duplicate approvals had no effect |

Repeatable commands:

```sh
bun scripts/workbench-claude-capabilities-smoke.ts --run
bun scripts/workbench-codex-native-tools-smoke.ts
```

The Claude fixture additionally restricts native child network to loopback via a macOS profile. The Codex fixture's only configured servers/endpoints are owned fixtures. An independent discovery-only probe of the installed Codex CLI with an excluded HTTP MCP and header helper observed zero HTTP requests and zero helper runs. This is version-specific evidence, not a promise about future versions.

The final Codex smoke passed all five scenarios after adding the composed phone path. That path uses production `makeWorkbenchService`, SQLite store, phone command handling and the real app-server adapter; only the transport message source and model responses are synthetic. It verifies that the invocation remains unexecuted during phone review, the same activity row completes, and phone status queries do not start extra model turns. It does not exercise the external WeChat network.

## What still requires leaving CC

Images/files as task inputs, per-task model/effort controls, complete background-agent lifecycle, native plugin/app setup, generic MCP elicitation/OAuth UI, richer Git operations and other provider workbench adapters remain open. Native CLI history continuation is not takeover of an actively running external App/CLI, and local resume is not cross-computer migration.

WeChat is currently an explicit, owner-only, pull-based text control surface. It does not yet create tasks, transfer result files, interpret voice commands or send automatic completion notifications. Large requests still need the desktop. Historical unclassified message records have not been migrated into a new memory policy.

No real user MCP service, model API or WeChat contact was invoked. No release bot restart, public push/merge, frozen asset change or native desktop rebuild was performed in this delivery.

## Primary project references

- [Paseo native Claude adapter](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/server/src/server/agent/providers/claude/agent.ts): background session ownership, native cwd/resume and explicit configuration sources. CC does not copy its permission-bypass product policy.
- [Orca native provider skill paths](https://github.com/stablyai/orca/blob/fe4237cd41e4d48793fd135640939ef8aa5418e0/docs/reference/agent-skill-provider-paths.md): retain provider-specific context conventions instead of pretending one directory convention fits every harness.
- [Official DeepSeek harness](https://github.com/deepseek-ai/deepseek-harness) and its [MCP design](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md): exact configured-server/raw-tool identity; approval and sandbox are separate contracts. Its developer-preview architecture is reference material, not an implemented CC adapter.
- [Codex app-server](https://learn.chatgpt.com/docs/app-server), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [inspected privileged approval metadata](https://github.com/openai/codex/blob/1715e55076737158ba61d43158ede504de6d4ce1/codex-rs/protocol/src/mcp_approval_meta.rs).
- [Claude permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [MCP policy](https://code.claude.com/docs/en/managed-mcp), [native MCP configuration](https://code.claude.com/docs/en/mcp), [skills](https://code.claude.com/docs/en/agent-sdk/skills) and [settings](https://code.claude.com/docs/en/settings).

Managed organization policy and future native versions require separate compatibility evidence. No flag or prompt is represented as overriding an organization's enforcement.
