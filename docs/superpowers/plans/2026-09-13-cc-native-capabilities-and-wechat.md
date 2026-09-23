# Native capabilities and WeChat task control

> **For agentic workers:** Use test-first implementation with independent reviews. Each slice can be validated and committed without the other.

**Goal:** Preserve useful native task context/tools and let WeChat control the same task lifecycle as the desktop.

**Architecture:** Native providers keep owning execution. CC owns task/run identities, permissions and records. Claude receives native project sources plus a filtered explicit MCP map; no companion prompt or privileged MCP map is inherited. WeChat commands enter after sender authorization but before unrelated conversation/model services, and call existing task APIs.

**Tech Stack:** Existing TypeScript, Bun, Vitest, Claude Agent SDK 0.2.116, native Codex app-server.

**Spec:** `../specs/2026-09-13-cc-unified-task-entry.md`

## Global constraints

- Existing isolated worktree `wechat-cc-cc-kit`, branch `codex/cc-workbench-v1`; no main checkout changes, push, release bot restart or real WeChat sends.
- No frozen art changes or asset rebuilds. Preserve two-column workbench and companion separation.
- No bypass to compensate for missing protocol. Tool grants bind to current task/run; native executor acknowledgment controls delivery status.
- No automatic external active-session takeover or execution migration claims.
- Tests use temporary HOME/config/project files and owned synthetic tools, never actual user MCP servers.

## Task 1: Claude native project context and tools

Files: add `src/core/workbench/claude-native-config.ts` and tests; modify `src/daemon/bootstrap/wire-workbench.ts` and tests; extend `makeWorkbenchClaudeCanUseTool` and its tests.

Interfaces:

```ts
interface NativeClaudeTools {
  servers: NonNullable<import('@anthropic-ai/claude-agent-sdk').Options['mcpServers']>
  omitted: string[]
}
function readNativeClaudeTools(cwd: string, environment?: NodeJS.ProcessEnv): NativeClaudeTools
// Optional third gate argument is admitted MCP server names, default empty.
// Existing ordinary chat callers retain their behavior.
```

- [x] Write failing tests for native user/project/local MCP precedence, explicitly disabled servers, blocked companion integrations, malformed config, fixed configuration diagnostics without raw configuration values, and no mutation of source files.
- [x] Write failing gate tests: admitted external MCP reaches run permission callback with the exact tool identity and a bounded, credential-redacted input preview; denied/aborted/unknown/core servers never execute. Missing callback denies.
- [x] Write failing option tests: native project sources load, strict explicit MCP configuration, default permissions with bypass disabled, inherited allow rules cannot bypass admitted MCP review, no base companion instructions/tools/hooks/agents/environment pointers.
- [x] Implement bounded configuration reads. Admit supported stdio/http/SSE configurations already enabled in native sources; retain credentials only inside the native map. Honor local > project > user scope and existing rejection/approval settings. Exclude CC companion MCPs before starting them.
- [x] Load project/local instruction and skill sources. Read user MCP definitions/policies separately; user-level persona/instruction files remain out of scope. Explicit task settings disable automatic hooks and skill shell expansion until their lifecycle is supported; task-specific MCP ask rules reach the existing callback. Do not mistake an empty allow array for clearing inherited permission rules.
- [x] Run focused tests and typecheck. Real temporary native Claude task must read a random marker from CLAUDE.md, discover a test skill and invoke an owned MCP only after callback approval. Record what is actually proven.

## Task 2: Codex configured tool path

Files: `src/core/workbench/codex-config.ts`, `codex-app-server.ts`, corresponding tests.

- [x] Verify native per-MCP approval configuration and event/request shapes against installed harness and upstream source before admitting MCPs.
- [x] Tests must prove external configured tools retained, companion integrations excluded, task approval policy and daemon environment stripping retained, native web search no longer unconditionally removed.
- [x] Implement supported native MCP request/approval lifecycle with thread/turn identities, stop and late-response handling. Do not expose config credentials in progress events.
- [x] Run synthetic protocol tests and an owned native MCP fixture. If an interface is unsupported, record the exact capability boundary rather than imply parity.

## Task 3: WeChat as another task control surface

Files: new focused command/parser middleware module as needed; `service.ts`, `store.ts`, inbound pipeline wiring and matching tests. Behavior, independent review outcomes and evidence are retained in `../reports/2026-09-13-cc-native-capabilities-and-wechat.md`.

- [x] Failing tests cover owner-only list/status, sender denial, running Codex steering versus Claude queue, exact task/request permission decisions and question answers, stale/repeated requests, input delivery idempotence, and model-health failure not blocking task commands.
- [x] Route explicit `任务` / `/task` commands after sender authorization and before chat recall/model-health. Ordinary messages continue through the existing pipeline.
- [x] Reuse `submitInput`, `resolvePermission`, question answering and cancellation APIs. Query task lists with owner filtering before pagination.
- [x] Show pending actions and exact reply syntax with native delivery status. Do not guess a last-used task, redirect plain y/n or silently restart an unavailable native session.
- [x] Run focused service and full inbound pipeline tests, without actual contact messages.
- [x] Complete the additional synthetic-channel-to-native-executor smoke: phone list/status/review/approve/result through the production task service and real Codex app-server passed. Wrong-owner and repeated grants execute nothing extra.

## Task 4: Combined validation and continued goal

- [x] Review each slice independently for requirements and correctness; fix important findings and rerun covering checks.
- [x] Run workbench/provider/inbound suites and full typecheck on final tree. Inspect current diffs and record native versions and verification boundaries.
- [x] Commit independently verified changes separately: native capabilities `1cd5c3ad`, WeChat task controls `e629f555`. Update the goal evidence table; leave unimplemented media input, execution settings, background lifecycle, Git controls and other executor requirements open.

Implementation, independent reviews and the composed native smoke are complete for this delivery. External WeChat transport and the full product goal are not claimed accepted. Final evidence and remaining requirements are recorded in the linked report.
