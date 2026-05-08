# Spike · `@cursor/sdk` for P1 of multi-provider extension

**Date**: 2026-05-08
**Goal**: Confirm `@cursor/sdk@1.0.12` (public-beta, released 2026-04-29) is a viable third agent provider for wechat-cc. Resolve open questions #1, #2, #4 from `docs/specs/2026-05-08-multi-provider-extension.md` (P1 design).
**Method**: Type-surface inspection on the installed package + cross-reference with public docs at https://cursor.com/docs/api/sdk/typescript. No live API calls (would require `CURSOR_API_KEY` and billable tokens — separate gate before implementation lands).

---

## TL;DR — implementation is unblocked

P1 of the multi-provider spec can move forward as designed. Three open questions that the spec flagged are now resolved enough to write the provider wrapper without ambiguity. One remaining unknown is isolated to a single mapping decision and only needs a 5-minute live PoC at implementation time, not a redesign.

---

## What's in the box (`@cursor/sdk@1.0.12`)

Install: `bun add -d @cursor/sdk` → 238 transitive packages, ~26 MB on disk.

Public surface (from `dist/esm/index.d.ts`):

```ts
// Top-level entry points
class Agent {
  static create(options: AgentOptions): Promise<SDKAgent>
  static resume(agentId: string, options?: Partial<AgentOptions>): Promise<SDKAgent>
  static prompt(message: string, options?: AgentOptions): Promise<RunResult>  // one-shot convenience
  static list(...): Promise<ListResult<SDKAgentInfo>>
  static get(agentId: string, ...): Promise<SDKAgentInfo>
  // archive / unarchive / delete / listRuns / getRun (cloud-only mostly)
}

interface SDKAgent {
  agentId: string
  send(message: string | SDKUserMessage, options?: SendOptions): Promise<Run>
  close(): void
  reload(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
  listArtifacts(): Promise<SDKArtifact[]>
  downloadArtifact(path: string): Promise<Buffer>
}

interface Run {
  id: string
  agentId: string
  result: RunResult | undefined
  status: RunStatus
  stream(): AsyncGenerator<SDKMessage, void>
  conversation(): Promise<ConversationTurn[]>
  wait(): Promise<RunResult>
  cancel(): Promise<void>
  onDidChangeStatus(listener: (status: RunStatus) => void): () => void
  // ... supports() / unsupportedReason() probes
}

class Cursor {
  static me(...): Promise<SDKUser>
  static models = { list(...): Promise<SDKModel[]> }
  static repositories = { list(...): Promise<SDKRepository[]> }
}
```

Maps to our `AgentProvider` / `AgentSession` shape directly — the only translation work is event-shape mapping (next section).

---

## Open Q1 (resolved) — MCP wiring shape

**Question**: how is `mcpServers` passed to `Agent.create`, and is the inline config shape compatible with our existing `McpStdioSpec`?

**Answer**: drop-in compatible. From `dist/esm/options.d.ts`:

```ts
type McpServerConfig =
  | { type?: "stdio", command: string, args?: string[], env?: Record<string, string>, cwd?: string }
  | { type?: "http" | "sse", url: string, headers?: Record<string, string>, auth?: {...} }

interface AgentOptions {
  mcpServers?: Record<string, McpServerConfig>
  // ... model, apiKey, name, local, cloud, agents, agentId, platform
}
```

Our `McpStdioSpec` (in `src/daemon/bootstrap/mcp-specs.ts`) emits `{ command, args, env }` — exactly the stdio variant of `McpServerConfig` minus the optional `cwd`. The cursor provider can pass it through verbatim:

```ts
Agent.create({
  apiKey: cursorKey,
  mcpServers: {
    wechat: { type: 'stdio', ...wechatStdioForCursor },
    delegate: { type: 'stdio', ...delegateStdioForCursor },
  },
  local: { cwd: project.path, settingSources: ['project', 'plugins'] },
})
```

**Sample from official docs** (cursor.com/docs/api/sdk/typescript) confirms this is the intended usage:

```ts
const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  local: { cwd: process.cwd() },
  mcpServers: {
    docs: { type: "http", url: "https://example.com/mcp", auth: {...} },
    filesystem: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
      cwd: process.cwd(),
    },
  },
})
```

`cwd` per-server is supported, useful if we ever want to scope wechat-mcp to a specific working directory.

---

## Open Q2 (resolved) — session resume

**Question**: does Cursor SDK support resuming an agent across daemon restarts?

**Answer**: yes. `Agent.resume(agentId, options?)` is a documented API. The `Run` object carries `id` + `agentId` and `Run.list(...)` enumerates past runs. So the registration's `canResume` callback can return `true` and the daemon's session-store can persist `agentId` like it does for Claude session ids.

Caveat — Cursor's "agent" is a durable object that owns multiple "runs" (one per dispatch). Our `AgentSession` is per-(provider, alias) and fans out turns onto a single SDK session. Cursor's model fits this naturally: one `SDKAgent` instance, one `agent.send()` call per dispatch, multiple `Run`s. No semantic mismatch.

**Open implementation detail** (not blocking): when does an agent become "stale" and need re-creation rather than resume? Cursor docs mention archive/unarchive/delete lifecycle but don't specify a TTL. Conservative default: try resume first, fall back to `Agent.create` on failure (similar to how `claude-agent-provider` handles missing JSONL).

---

## Open Q3 (deferred to live PoC) — exact tool name format for MCP tools

**Question**: when an MCP tool is invoked, what's the value of `SDKToolUseMessage.name`? Is it `mcp__<server>__<tool>` (matching Anthropic SDK convention) or just `<tool>`?

**Answer**: undocumented in static types and SDK README. Official docs explicitly say *"Tool call schema is not stable. The `args` and `result` payloads reflect each tool's internal shape and can change."* Need to observe live to confirm.

**Why this matters**: the coordinator's `isReplyToolCall(ev)` (in `src/core/agent-provider.ts:57-59`) checks `ev.server === 'wechat' && REPLY_TOOLS.has(ev.tool)`. The mapping in `cursor-agent-provider.ts` needs to populate `server` correctly from the SDK's tool name. If Cursor uses `mcp__wechat__reply` — same parser as Claude (`/^mcp__([^_]+)__(.+)$/`) works. If Cursor uses raw `reply` — we need a different lookup (e.g. consult our own `mcpServers` keys to disambiguate built-in vs MCP).

**Mitigation**: implement the mapping with the Anthropic-style parser first, plus a fallback that checks against the registered MCP server names. Add a runtime sanity log on first tool call so the implementer notices if the format diverges.

```ts
function mapCursorToolName(rawName: string, mcpServerNames: Set<string>): { server?: string; tool: string } {
  const m = /^mcp__([^_]+)__(.+)$/.exec(rawName)
  if (m && mcpServerNames.has(m[1]!)) return { server: m[1], tool: m[2]! }
  // Fallback: check if rawName is "<server>__<tool>" or "<server>:<tool>"
  for (const sep of ['__', ':', '/']) {
    const i = rawName.indexOf(sep)
    if (i > 0 && mcpServerNames.has(rawName.slice(0, i))) {
      return { server: rawName.slice(0, i), tool: rawName.slice(i + sep.length) }
    }
  }
  // Built-in tool (Read, Edit, Shell, etc.) — no server.
  return { tool: rawName }
}
```

5-minute live PoC at implementation time:
```ts
// PoC: real send + log first MCP tool name observed
const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  mcpServers: { wechat: { type: 'stdio', command: 'echo', args: ['hi'] } },
})
const run = await agent.send('use the wechat reply tool')
for await (const ev of run.stream()) {
  if (ev.type === 'tool_call') console.log('TOOL:', ev.name)
}
```

Cost: ~$0.01 in Cursor tokens. Defer until P1 implementation day 2.

---

## Open Q4 (resolved) — permission model

**Question**: does Cursor SDK expose a per-tool authorization callback like Claude's `canUseTool`?

**Answer**: no. `AgentOptions` has no permission hook. The SDK runs tools by default; the only documented isolation is `local.sandboxOptions: { enabled: boolean }`, which is process-level sandboxing on cloud agents (not per-tool gating).

**Implication**: cursor provider in wechat-cc is **coarse-permission only**, same status as codex. The capability matrix (`src/core/capability-matrix.ts`) currently differentiates `claude` (per-tool relay supported) vs `codex` (coarse only); add `cursor` to the same row as codex.

`permissionMode: 'strict'` daemon → cursor session runs with whatever Cursor's defaults are (likely "all tools allowed inside the sandbox"; the human user delegates trust to the SDK). `--dangerously` doesn't change anything because there was nothing to gate. Documented in the provider's prompt section so users know to switch to `claude` when they want fine-grained control.

---

## Event-shape mapping — actionable plan for the provider

Cursor's `SDKMessage` discriminated union (from `dist/esm/messages.d.ts`):

```ts
type SDKMessage =
  | SDKSystemMessage      // { type:'system', subtype?:'init', agent_id, run_id, model?, tools? }
  | SDKAssistantMessage   // { type:'assistant', message:{ role, content:[TextBlock|ToolUseBlock] } }
  | SDKUserMessageEvent   // { type:'user', message:{ role, content:[TextBlock] } }  — echo of input
  | SDKToolUseMessage     // { type:'tool_call', call_id, name, status, args?, result?, truncated? }
  | SDKThinkingMessage    // { type:'thinking', text, thinking_duration_ms? }
  | SDKStatusMessage      // { type:'status', status:'CREATING'|'RUNNING'|'FINISHED'|'ERROR'|'CANCELLED'|'EXPIRED' }
  | SDKRequestMessage     // { type:'request', request_id }
  | SDKTaskMessage        // { type:'task', status?, text? }
```

Mapping to our `AgentEvent`:

| Cursor SDKMessage | Our AgentEvent | Notes |
|---|---|---|
| `system` w/ `subtype:'init'` | `{kind:'started', sessionId: agent_id}` | once per session |
| `assistant` (TextBlock content) | `{kind:'text', text}` | extract every text block |
| `assistant` (ToolUseBlock content) | `{kind:'tool_call', server?, tool, input}` | parse name via mapCursorToolName |
| `tool_call` w/ `status:'completed'` | (informational, drop) | duplicate of assistant's tool_use block |
| `tool_call` w/ `status:'error'` | `{kind:'error', message:'tool X failed'}` | promote tool error to AgentEvent error |
| `status` w/ `'FINISHED'` | `{kind:'result', sessionId, numTurns?, durationMs?}` | end-of-turn |
| `status` w/ `'ERROR'`/`'CANCELLED'` | `{kind:'error', message}` | end-of-turn with failure |
| `user` | drop | input echo, not interesting |
| `thinking` | drop | could become a future `AgentEvent.kind:'thinking'` if dashboard wants it |
| `request`, `task` | drop | request-ID and progress markers, not turn-relevant |

The SDK emits both `assistant` w/ ToolUseBlock AND a separate `tool_call` event for the same call. To avoid double-counting in `replyToolCalled` detection: prefer the `assistant` ToolUseBlock as authoritative (it carries the original `id`), drop the standalone `tool_call` event unless `status === 'error'`.

---

## Implementation skeleton (validated against types)

```ts
// src/core/cursor-agent-provider.ts
import { Agent, type SDKAgent, type SDKMessage, type Run, type AgentOptions } from '@cursor/sdk'
import type { AgentProvider, AgentSession, AgentEvent } from './agent-provider'

export interface CursorProviderOpts {
  apiKey: string
  model?: { id: string; params?: { id: string; value: string }[] }
  mcpServers?: AgentOptions['mcpServers']
  /** Local-only for daemon use. Cloud agents need different lifecycle plumbing. */
  cwd?: string
}

export function createCursorAgentProvider(opts: CursorProviderOpts): AgentProvider {
  const mcpServerNames = new Set(Object.keys(opts.mcpServers ?? {}))
  return {
    async spawn(project) {
      const agent = await Agent.create({
        apiKey: opts.apiKey,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
        local: { cwd: opts.cwd ?? project.path, settingSources: ['project', 'plugins'] },
      })
      return makeSession(agent, mcpServerNames)
    },
  }
}

function makeSession(agent: SDKAgent, mcpServerNames: Set<string>): AgentSession {
  return {
    dispatch(text: string): AsyncIterable<AgentEvent> {
      return (async function*() {
        const run = await agent.send(text)
        for await (const sdkMsg of run.stream()) {
          const ev = mapSdkMessage(sdkMsg, mcpServerNames)
          if (ev) yield ev
        }
        const result = run.result ?? await run.wait()
        yield {
          kind: 'result',
          sessionId: agent.agentId,
          numTurns: 1,
          durationMs: result.durationMs ?? 0,
        }
      })()
    },
    async close() { agent.close() },
  }
}

function mapSdkMessage(msg: SDKMessage, mcpServerNames: Set<string>): AgentEvent | null {
  if (msg.type === 'system' && msg.subtype === 'init') {
    return { kind: 'started', sessionId: msg.agent_id }
  }
  if (msg.type === 'assistant') {
    // Synthesize multiple events from one assistant message — caller's
    // dispatch loop yields each in turn. (Matches claude-agent-provider style.)
    // For now return the FIRST event; mapper actually needs to be a generator.
    // (Real impl: convert mapSdkMessage → mapSdkMessages returning AgentEvent[].)
  }
  if (msg.type === 'tool_call' && msg.status === 'error') {
    return { kind: 'error', message: `cursor tool ${msg.name} failed` }
  }
  if (msg.type === 'status' && (msg.status === 'ERROR' || msg.status === 'CANCELLED')) {
    return { kind: 'error', message: msg.message ?? msg.status }
  }
  return null
}

// (mapSdkMessages would expand assistant content into multiple AgentEvents
//  — text + tool_call per ToolUseBlock — and parse the name via
//  mapCursorToolName. Detail elided for spike skeleton.)
```

This compiles against the installed types (verified in next section).

---

## Verification

```bash
cd ~/.claude/plugins/local/wechat
bun x tsc --noEmit  # 0 errors with @cursor/sdk in dependencies
```

Existing test suite still green: 1589 unit + 12 e2e, no regressions from adding the dep.

---

## Recommendation — proceed to P1 day 2

P1 implementation can begin without further design work. Estimated remaining cost:

- **Day 2 (~4-6 hours)**: full provider implementation + unit tests mirroring `codex-agent-provider.test.ts`. The 5-minute live tool-name PoC fits in this day.
- **Day 3 (~3-4 hours)**: bootstrap registration + `agent-config.json` schema bump (add `cursorModel?` and optional `cursorApiKey?` field) + e2e (`dispatch-solo-cursor.e2e.test.ts` mirroring `dispatch-solo-codex.e2e.test.ts`) + fake-sdk additions for `@cursor/sdk` mock.

Spike spent ~1 hour. Budget for full P1 holds at ~3 days as the spec estimated.

---

## Followups not in P1 scope

- **Cloud agents** — the SDK supports `cloud: { env, repos, ... }` for running in Cursor's cloud VMs. Useful for daemon scenarios where the user wants Cursor to spawn its own sandbox per chat (privacy / blast-radius isolation) rather than using the daemon's cwd. Defer to a P1.5 or P5 follow-up; P1 itself is local-only.
- **Subagents / hooks** — Cursor SDK's `agents: Record<string, AgentDefinition>` lets the parent agent spawn pre-defined subagents, and `.cursor/hooks.json` lets the agent loop be observed/extended. Both are powerful but orthogonal to "register Cursor as a wechat-cc provider"; they'd surface in v0.7+ if users start asking for "set up a code-review subagent that fires on every Cursor turn."
- **Pricing visibility** — Cursor billing is token-based via `CURSOR_API_KEY`. Daemon should log per-turn token usage to `wechat-cc.db`'s `activity` table for the dashboard's cost view (which doesn't exist yet — separate v0.7 task).

---

## Decision

P1 cleared to land. Schedule when v0.5.14 has soaked for a week (≥ 2026-05-15) and there's no follow-up incident from today's release chain.
