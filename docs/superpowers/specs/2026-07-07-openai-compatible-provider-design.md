# Design: `openai-compatible` provider (AI SDK runtime)

Date: 2026-07-07
Status: approved design → writing-plans next

## 1. Motivation

Claude Code / Codex are "heavy": each existing provider (`claude`, `codex`,
`cursor`) wraps a full **agent host** (claude-agent-sdk / codex binary /
cursor SDK) that ships its own tool loop, MCP wiring, sandbox, and per-tool
permission callback. The value is real but the cost is a flat subscription
(Claude Max / ChatGPT Pro) and a heavy subprocess.

We want a **cheap, light chat backend**: point the WeChat bot at a
pay-per-token OpenAI-compatible model (DeepSeek, Kimi, Qwen, GLM, OpenRouter,
local Ollama, …). DeepSeek et al. are **not** agent hosts — they are raw
chat-completions APIs. So we must supply the agent loop ourselves.

## 2. Scope decisions (locked)

- **One generic provider, id `openai`** — not per-model. base_url + model +
  key select the actual backend, so all OpenAI-compatible models flow through
  one provider (the standing "don't build a little separate piece per model"
  rule, see `architecture-conventions` memory).
- **Full chat backend** — the WeChat main-chat backend, selectable like
  claude/codex, not just background cheapEval.
- **Includes fs/shell tools in v1** — read/write/edit/bash alongside the
  WeChat companion tools, for uniformity with claude/codex (accepted: capability
  is weaker than Claude Code; uniformity is the goal).
- **Build our own runtime on Vercel AI SDK** (Approach B). NOT wrapping
  opencode/codex-at-DeepSeek (Approach A — another heavy CLI, coding-flavored),
  NOT adopting Mastra (Approach C — Mastra wants to own memory/agent/MCP/approval,
  which overlaps and fights wechat-cc's existing session-manager / tier /
  wechat-MCP / memory).
- **API key from env `WECHAT_OPENAI_API_KEY`** — key never lands in a config
  file. base_url + model live in agent-config.
- **No spike** — direct build.

### Why AI SDK and not Mastra

The veylin reference (`compassX/veylin`) turned out to have **no bespoke
runtime** — its "runtime" is Mastra, and Mastra is a wrapper over Vercel AI
SDK. The genuinely reusable veylin-authored pieces are thin: an
OpenAI-compatible model-catalog config shape and a ~65-LOC allow/approve/deny
policy gate. wechat-cc already owns tier/permission (`user-tier.ts` +
`capability-matrix.ts` + canUseTool), the wechat MCP server, memory snapshots,
and the coordinator. The **only** thing a new provider is missing is the
loop inside `dispatch()`. AI SDK supplies exactly that (tool-calling loop +
streaming + OpenAI-compatible provider + MCP tool bridging) without importing
Mastra's competing abstractions.

## 3. Architecture

The new provider implements the existing `AgentProvider` interface
(`src/core/agent-provider.ts`) verbatim, so session-manager, coordinator, and
capability-matrix require **no changes** to their logic (only registration +
one capability entry). It mirrors `cursor-agent-provider.ts` file-for-file.

### 3.1 Module layout

`src/core/openai-agent-provider.ts` (mirrors cursor):
- `createOpenAiAgentProvider(opts): AgentProvider` — factory.
- `OPENAI_CAPABILITIES: ProviderCapabilities` — static declaration.
- `tierProfileToOpenAiPolicy(tp, permissionMode)` — translate a tier into
  the tool-gate policy for this session.
- `mapStreamPart(part): AgentEvent | null` — AI SDK `fullStream` part →
  our `AgentEvent` (pure, unit-tested like `mapCursorMessage`).
- `makeOpenAiSession(...)` — the `AgentSession` with the `dispatch()` loop.

Lifted from veylin (rewritten small, no Mastra dep):
- OpenAI-compatible model config shape `{ id, baseURL, apiKey, modelId }`
  (from `packages/shared/src/model-resolve.ts`).
- The allow/approve/deny policy idea (from `packages/policy`) — but see §3.4:
  we reuse wechat-cc's **own** tier machinery, not veylin's policy, for the
  gate; veylin's policy is a reference only.

### 3.2 The runtime (inside `dispatch()`)

- Model: `@ai-sdk/openai-compatible` →
  `createOpenAICompatible({ baseURL, apiKey }).chatModel(modelId)`.
- Loop: AI SDK `streamText({ model, messages, tools, stopWhen: stepCountIs(N) })`.
  One `streamText` call IS the multi-step tool loop; `stopWhen` bounds it
  (`maxSteps`, default e.g. 25, configurable).
- Session state: the session object holds the running `messages` array (multi-
  turn memory *within* a live session, analogous to claude's jsonl session).
  `dispatch(text)` appends the user message, runs `streamText`, appends the
  resulting assistant + tool messages back onto `messages`, and yields events.
- Event mapping via `fullStream`:
  - `text-delta` → `{ kind: 'text', text }`
  - `tool-call` → `{ kind: 'tool_call', server?, tool }`
  - `finish` → `{ kind: 'result', sessionId, numTurns, durationMs }`
  - `error` → `{ kind: 'error', message, code? }`
  - first dispatch also emits `{ kind: 'init', sessionId }`.
  The idle-watchdog in `collectTurn` (agent-provider.ts) already bounds a
  silent stall — no provider-side timeout needed.

### 3.3 Tools — two sources

**(a) WeChat/companion tools via MCP.** Bridge the existing `wechat` (+
`delegate`) stdio MCP server using AI SDK `experimental_createMCPClient` with a
stdio transport that spawns the same server binary the other providers use.
`client.tools()` returns AI-SDK-shaped tools that the LLM can call; AI SDK
executes the MCP call. The per-session auth env (`WECHAT_SESSION_TOKEN` /
`WECHAT_SESSION_TIER`) is injected into the MCP child exactly as today — the
provider merges `spawnOpts.mcpEnv` via the existing `mergeEnvIntoMcpServers`
seam (`CORE_MCP_SERVER_NAMES` gate). This gives reply / memory / send_file /
voice / web / delegate for free and keeps tier auth intact.

**(b) fs/shell built-in tools.** Our own AI SDK `tool({ description,
inputSchema (zod), execute })` definitions: `read`, `write`, `edit`, `bash`
(adapted from veylin `packages/tools`). Each is tagged with a risk level so the
gate (§3.4) can classify it. These run in-process.

### 3.4 Permission / tier gating (we own the loop)

- Capabilities: `perToolCallback: true` (we CAN gate per tool inside the loop),
  `sandboxLevels: new Set()` (empty — no OS sandbox in v1), `supportsResume:
  false` (v1), `supportsDelegation: true`, `defaultPeer` per policy.
- The gate wraps each tool's `execute`. Before running a tool it consults
  wechat-cc's **existing** tier logic — reuse `classifyToolUse` +
  `TierProfile.{allow,relay,deny}` (`user-tier.ts`) rather than authoring a new
  policy engine:
  - `deny` → refuse the tool (return an error result to the model).
  - `relay` → route through the existing WeChat "are you sure?" relay path
    (same UX the other providers get for `shell_destructive` / `memory_delete`).
  - `allow` → execute.
- `permissionMode === 'dangerously'` → skip the gate entirely (parity with
  the other providers).
- Honest gap (documented, not a v1 goal): fs/shell run **in-process with the
  gate as the only barrier**, no OS sandbox — weaker than codex's
  `workspace-write`. This matches veylin's model and is acceptable per the
  scope decision; a future v2 can add sandboxing.

### 3.5 cheapEval / strongEval (free bonus)

Implement `cheapEval` and `strongEval` as one-shot no-tool `streamText`
(or `generateText`) calls. Because DeepSeek is cheap, `ProviderRegistry`'s
cost-tier picker will select it as the preferred `cheapEval`, so registering
this provider **also** cuts the cost of background routing / chatroom-moderator
/ companion-introspect / memory-synthesis calls. `assertNotAuthFailed`
(agent-provider.ts) is applied to the eval output for consistent auth-fail
handling.

## 4. Config & wiring

- `src/lib/agent-config.ts`: add `'openai'` to the provider zod enum; add
  optional `openaiBaseUrl` + `openaiModel` fields (mirroring how cursor added
  its own model field). API key is **not** in config — read from
  `process.env.WECHAT_OPENAI_API_KEY` at spawn.
- `src/daemon/bootstrap/index.ts`: lazy-import + register the `openai` provider
  when its config (base_url + key) is present, mirroring the cursor conditional
  registration block.
- `src/core/capability-matrix.ts`: add `openai: OPENAI_CAPABILITIES` to
  `CAPABILITIES_BY_PROVIDER`. The boot-time `assertMatrixComplete` (driven by
  the live registry) then covers all 8 mode×permission rows automatically.
- `ProviderId` is already an open `string` union — no type change needed.

## 5. Testing (TDD)

- Unit: `mapStreamPart` (each AI SDK part → AgentEvent), `tierProfileToOpenAiPolicy`,
  the tool gate (allow/relay/deny branches), cheapEval auth-fail detection.
- Integration: use AI SDK's mock/simulated model to drive a full dispatch turn
  that emits a tool call → assert the AgentEvent stream, that the tool executed,
  and that a denied tool is refused / a relay tool routes to the relay path.
- capability-matrix completeness test picks up the new provider with no new row
  authoring (it derives from `OPENAI_CAPABILITIES`).

## 6. Deliberate non-goals (v1)

- **No OS sandbox** for fs/shell — in-process + tier/policy gate only
  (documented gap vs codex).
- **No cross-restart session resume** — `supportsResume: false`; message
  history is in-memory for the life of the session (can persist later).
- **Not forking** opencode / codex-at-DeepSeek; **not adopting** Mastra.
- Desktop UI for entering base_url/model/key is out of scope for v1 (env +
  agent-config edit is enough to validate; a settings pane can follow, per the
  `keep-desktop-ui-simple` memory).

## 7. Open items to resolve during planning

- **AI SDK version + exact API surface** (`streamText` `stopWhen`/`stepCountIs`,
  `fullStream` part names, `experimental_createMCPClient` stdio transport,
  `@ai-sdk/openai-compatible` factory name) must be verified against the version
  we install — the names above are from the v5/v6 line and may need adjustment.
  Verify via Context7 / the installed package before coding.
- Confirm DeepSeek's function-calling dialect works through
  `@ai-sdk/openai-compatible` (tool_calls in the OpenAI shape) — spot-check
  against DeepSeek docs.
