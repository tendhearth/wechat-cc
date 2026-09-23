# API models as managed CC task executors

The standing owner request is to use CC for daily tasks across Claude, Codex and configured API models, with desktop and WeChat sharing the same task record. This continues that approved goal without another setup wizard or automatic provider fallback.

## Decision

Keep native Claude/Codex adapters for command-heavy engineering work. Add a separate OpenAI-compatible **task** adapter for reading project materials, producing reports and small document/data artifacts. Reuse AI SDK transport types; do not admit the companion OpenAI loop, its shell, personal memory or MCP closure. Merely wrapping the old provider would retain boundary-only cancellation and volatile history. A generic new shell/MCP runtime would add process-lifetime problems before providing this useful API workflow.

This adapter advertises its limits: no shell, arbitrary project edits, background jobs, MCP, provider-native history import or remote physical inference-stop guarantee. All local tools are bounded and synchronous; abort stops the HTTP request and prevents later tool effects. Confirmed local closure is required before the project reservation is released. Broader CLI/App coverage remains an active product goal.

## Run and session contract

- Use the configured OpenAI-compatible endpoint/key/model only when selected. No discovery calls, paid probes, login or automatic fallback. Endpoint/model are frozen for each runtime; continuation is refused if the endpoint or requested model no longer matches the saved binding.
- Preserve complete model messages, tool calls and tool results in a CC-owned SQLite transcript, separate from the public task journal. Bind it to task alias, owner, canonical directory identity and endpoint/model fingerprint. Credentials never enter persistence. This is managed continuation, not native API history.
- Persist a turn checkpoint before sending it. Persist assistant calls before effects and each result afterward. If a process dies mid-turn, do not replay an unresolved tool. Refuse continuation and use the existing explicit restart flow. A cancelled stream may retain the last complete checkpoint only when no ambiguous effect remains.
- Only an explicit successful protocol finish ends a task successfully. Length, content-filter, unknown/missing finish, malformed calls, step budget or transport failure cannot become completion.
- Stream public replies between tool activities. Existing task rendering folds activity after completion; no hidden reasoning is requested or exposed.

## Initial tools and attachments

Read project-relative text with a size bound and anchored no-symlink traversal; list a selected project directory without entering symlinks or other tasks' internal directories. Generate a new named artifact only inside this task's `.cc-workbench/<taskId>` folder. Save is exclusive, never overwrites an original or follows symlinks. Every read/list/save request is normalized before the task approval bridge, then checked again for cancellation before effects. Saving approval identifies the file, content size and digest. Unsupported tools produce a recorded error result, not execution.

Validated text attachments are provided as delimited material and image attachments as exact data blocks. Unsupported binary/PDF inputs fail explicitly before a model request. No prompt regex can open arbitrary paths. No shared project config, hooks or companion servers are loaded.

## Acceptance

Owned loopback OpenAI-compatible stream tests prove user text → tool request → exact permission → file output → visible answer → persistent continuation with prior tool results. A second task/project cannot restore that session. Abort during stream or permission produces no later writes; length/EOF/invalid tool calls fail; interrupted transcripts never replay. Verify service registration, desktop capability copy and WeChat generic-selector compatibility. Preserve the old companion OpenAI tests unchanged. Report synthetic transport evidence separately from live model quality and broad harness coverage.
