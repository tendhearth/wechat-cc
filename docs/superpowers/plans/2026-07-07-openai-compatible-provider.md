# openai-compatible Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic `openai` provider — a light, pay-per-token chat backend (DeepSeek/Kimi/Qwen/OpenRouter/Ollama) built on Vercel AI SDK, selectable like claude/codex, with its own tool-calling loop, MCP companion tools + fs/shell built-ins, and tier-gated permissions.

**Architecture:** New provider implements the existing `AgentProvider` interface (mirrors `cursor-agent-provider.ts`), so session-manager/coordinator/capability-matrix need no logic change. We OWN the tool loop; Vercel AI SDK is confined to ONE adapter behind a narrow `ChatModelClient` seam. MCP tools bridge via the already-installed `@modelcontextprotocol/sdk` client (not AI SDK's experimental MCP client). Tier gating reuses `classifyToolUse` + `TierProfile`.

**Tech Stack:** TypeScript, Bun test runner (`bun test` / vitest-compatible `describe/it/expect`), `ai` (v5) + `@ai-sdk/openai-compatible` (adapter only), `@modelcontextprotocol/sdk` ^1.29 (already a dep), `zod` v4 (already a dep).

## Global Constraints

- **AI SDK imports live in exactly ONE file** (`src/core/openai-chat-model.ts`). No other file imports `ai` or `@ai-sdk/*`. This is the maintenance seam — enforce it.
- **Provider id is `openai`** (generic; not `deepseek`). One provider, many models via base_url+model+key.
- **API key from `process.env.WECHAT_OPENAI_API_KEY`** only — never read from or written to a config file. base_url + model live in agent-config.
- **`ProviderId` is `string`** (open union, `src/core/conversation.ts`) — no type edit needed to add `openai`.
- **TDD**: every task writes the failing test first, watches it fail, then implements. Commit after each green task.
- **Existing tier machinery is reused, not reinvented**: `classifyToolUse(toolName, input)` + `TierProfile.{allow,relay,deny}` from `src/core/user-tier.ts`. MCP tool names must be reconstructed to the `mcp__wechat__<sub>` shape before classifying; built-in tools are named `Read`/`Write`/`Edit`/`Bash` so the classifier maps them unchanged.
- **v1 relay handling (scope decision made during planning):** a tool classified into the tier's `relay` set is **denied** in strict mode (mid-turn WeChat "are you sure?" round-trip is deferred to a follow-up) and **allowed** under `permissionMode === 'dangerously'`. This is a documented v1 gap; see Task 4.
- **v1 non-goals:** no OS sandbox (fs/shell run in-process, gate is the only barrier); `supportsResume: false` (in-memory message history only).

---

## File Structure

- Create `src/core/openai-chat-model.ts` — the `ChatModelClient` seam (types + AI SDK adapter). **Only** file importing `ai`/`@ai-sdk/openai-compatible`.
- Create `src/core/openai-mcp-bridge.ts` — MCP stdio client → `ToolSpec[]` + `call()` + `close()`, via `@modelcontextprotocol/sdk`.
- Create `src/core/openai-tools.ts` — built-in fs/shell tools (`Read`/`Write`/`Edit`/`Bash`) with risk tags.
- Create `src/core/openai-gate.ts` — `gateTool(...)` reusing `classifyToolUse` + `TierProfile`.
- Create `src/core/openai-agent-provider.ts` — `OPENAI_CAPABILITIES`, `mapDeltaToEvent`, `makeOpenAiSession` (the owned loop), `createOpenAiAgentProvider`, cheapEval/strongEval.
- Modify `src/lib/agent-config.ts` — add `'openai'` to provider enum + `openaiBaseUrl`/`openaiModel` fields.
- Modify `src/core/capability-matrix.ts` — register `openai: OPENAI_CAPABILITIES`.
- Modify `src/core/provider-registry.ts` — add `openai` to `CHEAP_EVAL_PREFERENCE`.
- Modify `src/daemon/bootstrap/index.ts` — conditional registration block (mirrors cursor).
- Modify `package.json` — add `ai` + `@ai-sdk/openai-compatible`.

---

## Task 1: `ChatModelClient` seam + AI SDK adapter

**Files:**
- Modify: `package.json` (add deps)
- Create: `src/core/openai-chat-model.ts`
- Test: `src/core/openai-chat-model.test.ts`

**Interfaces:**
- Produces:
  - `type ChatMessage` (opaque re-export of AI SDK `ModelMessage`)
  - `interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> /* JSON Schema */ }`
  - `type TurnDelta = { kind: 'text'; text: string } | { kind: 'tool_call'; id: string; name: string; input: unknown }`
  - `interface StreamedTurn { deltas: AsyncIterable<TurnDelta>; finished: Promise<{ messages: ChatMessage[]; toolCalls: { id: string; name: string; input: unknown }[] }> }`
  - `interface ChatModelClient { streamTurn(messages, tools): StreamedTurn; generate(messages): Promise<string>; userMessage(text): ChatMessage; systemMessage(text): ChatMessage; toolResultMessage(toolCallId, toolName, result): ChatMessage }`
  - `function createAiSdkChatModel(opts: { baseURL: string; apiKey: string; model: string }): ChatModelClient`

- [ ] **Step 1: Add dependencies**

Run:
```bash
cd /Users/nategu_mac_company/Documents/wechat-cc
bun add ai@^5 @ai-sdk/openai-compatible@^1
```
Expected: both appear under `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing test**

Create `src/core/openai-chat-model.test.ts`. Uses AI SDK's `MockLanguageModelV2` + `simulateReadableStream` from `ai/test` to drive the adapter without a network call.

```ts
import { describe, it, expect } from 'vitest'
import { MockLanguageModelV2 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { createChatModelFromLanguageModel } from './openai-chat-model'

// createChatModelFromLanguageModel is an internal seam used by the test to
// inject a mock model; createAiSdkChatModel wraps it with a real provider.
function textModel(chunks: string[]) {
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '1' },
          ...chunks.map(delta => ({ type: 'text-delta' as const, id: '1', delta })),
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ],
      }),
    }),
  })
}

describe('ChatModelClient adapter', () => {
  it('streams text deltas as TurnDelta text events', async () => {
    const client = createChatModelFromLanguageModel(textModel(['Hel', 'lo']))
    const turn = client.streamTurn([client.userMessage('hi')], [])
    const seen: string[] = []
    for await (const d of turn.deltas) if (d.kind === 'text') seen.push(d.text)
    expect(seen.join('')).toBe('Hello')
    const fin = await turn.finished
    expect(fin.toolCalls).toEqual([])
    expect(fin.messages.length).toBeGreaterThan(0)
  })

  it('generate() returns the concatenated text for a one-shot call', async () => {
    const client = createChatModelFromLanguageModel(textModel(['42']))
    const out = await client.generate([client.userMessage('answer?')])
    expect(out).toBe('42')
  })

  it('surfaces a tool call (schema-only tool, no execute) as a tool_call delta', async () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'reply', input: '{"text":"hi"}' },
            { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ],
        }),
      }),
    })
    const client = createChatModelFromLanguageModel(model)
    const spec = { name: 'reply', description: 'send a reply', parameters: { type: 'object', properties: { text: { type: 'string' } } } }
    const turn = client.streamTurn([client.userMessage('hi')], [spec])
    const calls: unknown[] = []
    for await (const d of turn.deltas) if (d.kind === 'tool_call') calls.push(d)
    const fin = await turn.finished
    expect(fin.toolCalls).toHaveLength(1)
    expect(fin.toolCalls[0]).toMatchObject({ id: 'c1', name: 'reply' })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/core/openai-chat-model.test.ts`
Expected: FAIL — `createChatModelFromLanguageModel` / `./openai-chat-model` not found.

- [ ] **Step 4: Implement `src/core/openai-chat-model.ts`**

```ts
import {
  streamText,
  generateText,
  jsonSchema,
  tool,
  type ModelMessage,
  type LanguageModel,
} from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

// Opaque re-export: the rest of the provider treats ChatMessage as a black box
// it only ever appends. Keeps AI SDK's ModelMessage type from leaking outward.
export type ChatMessage = ModelMessage

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>
}

export type TurnDelta =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }

export interface StreamedTurn {
  deltas: AsyncIterable<TurnDelta>
  finished: Promise<{
    messages: ChatMessage[]
    toolCalls: { id: string; name: string; input: unknown }[]
  }>
}

export interface ChatModelClient {
  streamTurn(messages: ChatMessage[], tools: ToolSpec[]): StreamedTurn
  generate(messages: ChatMessage[]): Promise<string>
  userMessage(text: string): ChatMessage
  systemMessage(text: string): ChatMessage
  toolResultMessage(toolCallId: string, toolName: string, result: unknown): ChatMessage
}

/**
 * Build the ChatModelClient from a concrete AI SDK LanguageModel. Split out so
 * tests can inject a MockLanguageModelV2 without a provider/base_url. Schema-only
 * tools (no `execute`) ⇒ AI SDK surfaces tool-call parts but never runs them and
 * stops after one step — WE own the loop (openai-agent-provider).
 */
export function createChatModelFromLanguageModel(model: LanguageModel): ChatModelClient {
  const toAiTools = (specs: ToolSpec[]): Record<string, ReturnType<typeof tool>> =>
    Object.fromEntries(
      specs.map(s => [s.name, tool({ description: s.description, inputSchema: jsonSchema(s.parameters) })]),
    )

  return {
    streamTurn(messages, tools) {
      const result = streamText({ model, messages, tools: toAiTools(tools) })
      const toolCalls: { id: string; name: string; input: unknown }[] = []
      async function* deltas(): AsyncIterable<TurnDelta> {
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            // v5 fullStream text-delta carries `.text`.
            yield { kind: 'text', text: (part as { text: string }).text }
          } else if (part.type === 'tool-call') {
            const p = part as { toolCallId: string; toolName: string; input: unknown }
            toolCalls.push({ id: p.toolCallId, name: p.toolName, input: p.input })
            yield { kind: 'tool_call', id: p.toolCallId, name: p.toolName, input: p.input }
          }
          // text-start/end, finish, etc. ignored — the loop drives on toolCalls.
        }
      }
      const finished = (async () => {
        const stream = deltas()
        // Drain is done by the caller iterating `deltas`; but `finished` must not
        // resolve before the stream is consumed. We expose the same generator so
        // the caller iterates once; `response` awaits the underlying result.
        const response = await result.response
        return { messages: response.messages as ChatMessage[], toolCalls }
      })()
      // Return a single shared async iterable so caller consumes deltas, then
      // awaits finished. `finished` internally awaits result.response which only
      // settles after the stream completes.
      return { deltas: deltas(), finished }
    },

    async generate(messages) {
      const { text } = await generateText({ model, messages })
      return text
    },

    userMessage(text) {
      return { role: 'user', content: text }
    },
    systemMessage(text) {
      return { role: 'system', content: text }
    },
    toolResultMessage(toolCallId, toolName, result) {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName,
            output: { type: 'text', value: typeof result === 'string' ? result : JSON.stringify(result) },
          },
        ],
      } as ChatMessage
    },
  }
}

/** Production factory: an OpenAI-compatible provider (DeepSeek/Kimi/Qwen/...). */
export function createAiSdkChatModel(opts: { baseURL: string; apiKey: string; model: string }): ChatModelClient {
  const provider = createOpenAICompatible({
    name: 'wechat-openai',
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
  })
  return createChatModelFromLanguageModel(provider.chatModel(opts.model))
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/core/openai-chat-model.test.ts`
Expected: PASS (3 tests). If the `text-delta` field is not `.text` on the installed v5, adjust the extraction in `streamTurn` (it is the only place this matters — the seam contains it).

- [ ] **Step 6: Verify the import-isolation constraint**

Run: `grep -rln "from 'ai'\|@ai-sdk/" src/ | grep -v openai-chat-model`
Expected: NO output (AI SDK imported only by `openai-chat-model.ts`).

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lockb src/core/openai-chat-model.ts src/core/openai-chat-model.test.ts
git commit -m "feat(openai): ChatModelClient seam + AI SDK adapter"
```

---

## Task 2: MCP tool bridge

**Files:**
- Create: `src/core/openai-mcp-bridge.ts`
- Test: `src/core/openai-mcp-bridge.test.ts`

**Interfaces:**
- Consumes: `ToolSpec` (Task 1); `McpStdioSpec` = `{ command: string; args: string[]; env?: Record<string, string> }` (structurally matches `./mcp-specs`).
- Produces:
  - `interface McpToolBridge { tools: ToolSpec[]; call(name: string, input: unknown): Promise<string>; close(): Promise<void> }`
  - `function createMcpToolBridge(specs: Record<string, McpStdioSpec>, deps?: { makeClient?: ... }): Promise<McpToolBridge>` — connects each stdio server, lists tools (name/description/inputSchema → ToolSpec), and routes `call()` to the owning client.

- [ ] **Step 1: Write the failing test** (inject a fake client, no real subprocess)

```ts
import { describe, it, expect } from 'vitest'
import { createMcpToolBridge, type McpClientLike } from './openai-mcp-bridge'

function fakeClient(tools: { name: string; description?: string; inputSchema: unknown }[]): McpClientLike {
  return {
    async listTools() { return { tools } },
    async callTool({ name }: { name: string }) { return { content: [{ type: 'text', text: `ran:${name}` }] } },
    async close() {},
  }
}

describe('MCP tool bridge', () => {
  it('lists MCP tools as ToolSpecs and routes calls to the owning client', async () => {
    const bridge = await createMcpToolBridge(
      { wechat: { command: 'x', args: [] } },
      { makeClient: async () => fakeClient([{ name: 'reply', description: 'r', inputSchema: { type: 'object' } }]) },
    )
    expect(bridge.tools.map(t => t.name)).toEqual(['reply'])
    expect(await bridge.call('reply', { text: 'hi' })).toBe('ran:reply')
    await bridge.close()
  })

  it('defaults a missing inputSchema to an empty object schema', async () => {
    const bridge = await createMcpToolBridge(
      { wechat: { command: 'x', args: [] } },
      { makeClient: async () => fakeClient([{ name: 'ping', inputSchema: undefined as unknown }]) },
    )
    expect(bridge.tools[0].parameters).toEqual({ type: 'object', properties: {} })
    await bridge.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/openai-mcp-bridge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/openai-mcp-bridge.ts`**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolSpec } from './openai-chat-model'

export interface McpStdioSpec {
  command: string
  args: string[]
  env?: Record<string, string>
}

/** Minimal surface of the MCP client we depend on — lets tests inject a fake. */
export interface McpClientLike {
  listTools(): Promise<{ tools: { name: string; description?: string; inputSchema?: unknown }[] }>
  callTool(args: { name: string; arguments?: unknown }): Promise<{ content: { type: string; text?: string }[] }>
  close(): Promise<void>
}

export interface McpToolBridge {
  tools: ToolSpec[]
  call(name: string, input: unknown): Promise<string>
  close(): Promise<void>
}

const EMPTY_SCHEMA = { type: 'object', properties: {} } as const

async function connectStdio(spec: McpStdioSpec): Promise<McpClientLike> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
  })
  const client = new Client({ name: 'wechat-openai-provider', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client as unknown as McpClientLike
}

export async function createMcpToolBridge(
  specs: Record<string, McpStdioSpec>,
  deps?: { makeClient?: (spec: McpStdioSpec) => Promise<McpClientLike> },
): Promise<McpToolBridge> {
  const make = deps?.makeClient ?? connectStdio
  const owners = new Map<string, McpClientLike>() // toolName → client
  const clients: McpClientLike[] = []
  const tools: ToolSpec[] = []

  for (const spec of Object.values(specs)) {
    const client = await make(spec)
    clients.push(client)
    const { tools: mcpTools } = await client.listTools()
    for (const t of mcpTools) {
      owners.set(t.name, client)
      tools.push({
        name: t.name,
        description: t.description ?? t.name,
        parameters: (t.inputSchema as Record<string, unknown>) ?? { ...EMPTY_SCHEMA },
      })
    }
  }

  return {
    tools,
    async call(name, input) {
      const client = owners.get(name)
      if (!client) throw new Error(`mcp bridge: no server owns tool ${name}`)
      const res = await client.callTool({ name, arguments: input ?? {} })
      return res.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
    },
    async close() {
      await Promise.all(clients.map(c => c.close().catch(() => {})))
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/openai-mcp-bridge.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/openai-mcp-bridge.ts src/core/openai-mcp-bridge.test.ts
git commit -m "feat(openai): MCP stdio tool bridge via @modelcontextprotocol/sdk"
```

---

## Task 3: Built-in fs/shell tools

**Files:**
- Create: `src/core/openai-tools.ts`
- Test: `src/core/openai-tools.test.ts`

**Interfaces:**
- Consumes: `ToolSpec` (Task 1).
- Produces:
  - `type ToolRisk = 'safe' | 'caution' | 'dangerous'`
  - `interface BuiltinTool { spec: ToolSpec; risk: ToolRisk; execute(input: Record<string, unknown>): Promise<string> }`
  - `function builtinTools(cwd: string): BuiltinTool[]` — `Read`, `Write`, `Edit`, `Bash` (names chosen so `classifyToolUse` maps them to fs_read/fs_write/shell).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinTools } from './openai-tools'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oa-tools-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const byName = (cwd: string, name: string) => builtinTools(cwd).find(t => t.spec.name === name)!

describe('builtin tools', () => {
  it('Write then Read round-trips a file', async () => {
    await byName(dir, 'Write').execute({ path: 'a.txt', content: 'hello' })
    const out = await byName(dir, 'Read').execute({ path: 'a.txt' })
    expect(out).toContain('hello')
  })

  it('Edit replaces an exact string', async () => {
    writeFileSync(join(dir, 'b.txt'), 'foo bar')
    await byName(dir, 'Edit').execute({ path: 'b.txt', old: 'foo', new: 'baz' })
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('baz bar')
  })

  it('Bash runs a command and returns stdout', async () => {
    const out = await byName(dir, 'Bash').execute({ command: 'echo hi' })
    expect(out).toContain('hi')
  })

  it('tags risk levels: Read safe, Write/Edit caution, Bash dangerous', () => {
    const risk = (n: string) => byName(dir, n).risk
    expect(risk('Read')).toBe('safe')
    expect(risk('Write')).toBe('caution')
    expect(risk('Bash')).toBe('dangerous')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/openai-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/openai-tools.ts`**

```ts
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { exec as execCb } from 'node:child_process'
import type { ToolSpec } from './openai-chat-model'

const exec = promisify(execCb)

export type ToolRisk = 'safe' | 'caution' | 'dangerous'

export interface BuiltinTool {
  spec: ToolSpec
  risk: ToolRisk
  execute(input: Record<string, unknown>): Promise<string>
}

const abs = (cwd: string, p: string): string => (isAbsolute(p) ? p : resolve(cwd, p))
const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string') throw new Error(`missing/invalid "${field}"`)
  return v
}

export function builtinTools(cwd: string): BuiltinTool[] {
  return [
    {
      risk: 'safe',
      spec: {
        name: 'Read',
        description: 'Read a text file relative to the working directory.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      async execute(input) {
        return await readFile(abs(cwd, str(input.path, 'path')), 'utf8')
      },
    },
    {
      risk: 'caution',
      spec: {
        name: 'Write',
        description: 'Write (overwrite) a text file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
      async execute(input) {
        const p = abs(cwd, str(input.path, 'path'))
        await writeFile(p, str(input.content, 'content'), 'utf8')
        return `wrote ${p}`
      },
    },
    {
      risk: 'caution',
      spec: {
        name: 'Edit',
        description: 'Replace the first exact occurrence of "old" with "new" in a file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } },
          required: ['path', 'old', 'new'],
        },
      },
      async execute(input) {
        const p = abs(cwd, str(input.path, 'path'))
        const old = str(input.old, 'old')
        const body = await readFile(p, 'utf8')
        if (!body.includes(old)) throw new Error(`"old" not found in ${p}`)
        await writeFile(p, body.replace(old, str(input.new, 'new')), 'utf8')
        return `edited ${p}`
      },
    },
    {
      risk: 'dangerous',
      spec: {
        name: 'Bash',
        description: 'Run a shell command in the working directory.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
      async execute(input) {
        const { stdout, stderr } = await exec(str(input.command, 'command'), { cwd, timeout: 120_000 })
        return [stdout, stderr].filter(Boolean).join('\n') || '(no output)'
      },
    },
  ]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/openai-tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/openai-tools.ts src/core/openai-tools.test.ts
git commit -m "feat(openai): built-in fs/shell tools (Read/Write/Edit/Bash) with risk tags"
```

---

## Task 4: Tier gate

**Files:**
- Create: `src/core/openai-gate.ts`
- Test: `src/core/openai-gate.test.ts`

**Interfaces:**
- Consumes: `classifyToolUse`, `TierProfile` (`src/core/user-tier.ts`); `PermissionMode` (`src/core/agent-provider.ts`).
- Produces:
  - `type GateDecision = 'allow' | 'deny'` (v1: relay collapses to deny in strict — see Global Constraints).
  - `function gateTool(args: { toolName: string; isMcp: boolean; input: Record<string, unknown>; tierProfile: TierProfile; permissionMode: PermissionMode }): GateDecision`
  - MCP tool names are reconstructed to `mcp__wechat__<name>` before classifying; built-in names pass through.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { gateTool } from './openai-gate'
import { tierProfileFor } from './user-tier' // existing factory; see note in Step 3

// If the existing helper name differs, use whatever user-tier.ts exports to
// build a guest/trusted/admin TierProfile. The three sets are what matter.
const guest = tierProfileFor('guest')
const admin = tierProfileFor('admin')

describe('gateTool', () => {
  it('denies a deny-classified tool in strict mode', () => {
    // guest denies fs_write etc.; Write → fs_write
    expect(gateTool({ toolName: 'Write', isMcp: false, input: {}, tierProfile: guest, permissionMode: 'strict' })).toBe('deny')
  })

  it('allows an allow-classified MCP tool (reply) for guest', () => {
    expect(gateTool({ toolName: 'reply', isMcp: true, input: {}, tierProfile: guest, permissionMode: 'strict' })).toBe('allow')
  })

  it('collapses a relay-classified tool to deny in strict mode (v1)', () => {
    // admin relays destructive Bash; a destructive command classifies to shell_destructive ∈ admin.relay
    expect(gateTool({ toolName: 'Bash', isMcp: false, input: { command: 'rm -rf /' }, tierProfile: admin, permissionMode: 'strict' })).toBe('deny')
  })

  it('allows everything under dangerously', () => {
    expect(gateTool({ toolName: 'Bash', isMcp: false, input: { command: 'rm -rf /' }, tierProfile: admin, permissionMode: 'dangerously' })).toBe('allow')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/openai-gate.test.ts`
Expected: FAIL — module not found. (If `tierProfileFor` is not the real export, first `grep -n "export" src/core/user-tier.ts` and use the actual TierProfile factory; adjust the import in the test.)

- [ ] **Step 3: Implement `src/core/openai-gate.ts`**

```ts
import { classifyToolUse, type TierProfile } from './user-tier'
import type { PermissionMode } from './agent-provider'

export type GateDecision = 'allow' | 'deny'

/**
 * Decide whether a tool call may run. Reuses the existing tier machinery:
 *   classifyToolUse(sdkName, input) → ToolKind, then TierProfile sets.
 * v1: a `relay`-classified tool is DENIED in strict mode (mid-turn WeChat
 * confirmation round-trip is deferred). Under `dangerously`, everything runs.
 */
export function gateTool(args: {
  toolName: string
  isMcp: boolean
  input: Record<string, unknown>
  tierProfile: TierProfile
  permissionMode: PermissionMode
}): GateDecision {
  if (args.permissionMode === 'dangerously') return 'allow'
  // classifyToolUse expects the SDK-prefixed name for wechat MCP tools.
  const sdkName = args.isMcp ? `mcp__wechat__${args.toolName}` : args.toolName
  const kind = classifyToolUse(sdkName, args.input)
  if (args.tierProfile.deny.has(kind)) return 'deny'
  if (args.tierProfile.relay.has(kind)) return 'deny' // v1: relay → deny
  return 'allow'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/openai-gate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/openai-gate.ts src/core/openai-gate.test.ts
git commit -m "feat(openai): tier gate reusing classifyToolUse (v1 relay→deny)"
```

---

## Task 5: Capabilities + event mapping (pure bits)

**Files:**
- Create: `src/core/openai-agent-provider.ts` (partial — pure exports only this task)
- Test: `src/core/openai-agent-provider.test.ts` (partial)

**Interfaces:**
- Consumes: `ProviderCapabilities`, `AgentEvent` (`src/core/agent-provider.ts`); `TurnDelta` (Task 1).
- Produces:
  - `const OPENAI_CAPABILITIES: ProviderCapabilities`
  - `function mapDeltaToEvent(d: TurnDelta): AgentEvent` — text→text; tool_call→tool_call (server `'wechat'` when the name is a known MCP tool, else undefined).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { OPENAI_CAPABILITIES, mapDeltaToEvent } from './openai-agent-provider'

describe('openai capabilities + mapping', () => {
  it('declares perToolCallback true, empty sandbox, no resume', () => {
    expect(OPENAI_CAPABILITIES.perToolCallback).toBe(true)
    expect(OPENAI_CAPABILITIES.sandboxLevels.size).toBe(0)
    expect(OPENAI_CAPABILITIES.supportsResume).toBe(false)
  })

  it('maps a text delta to a text event', () => {
    expect(mapDeltaToEvent({ kind: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' })
  })

  it('maps a tool_call delta to a tool_call event with wechat server for MCP tools', () => {
    expect(mapDeltaToEvent({ kind: 'tool_call', id: 'c1', name: 'reply', input: {} }))
      .toMatchObject({ kind: 'tool_call', tool: 'reply', server: 'wechat' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/openai-agent-provider.test.ts`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Implement the pure exports at the top of `src/core/openai-agent-provider.ts`**

```ts
import type { ProviderCapabilities, AgentEvent } from './agent-provider'
import type { TurnDelta } from './openai-chat-model'

/** wechat MCP tool names that get server:'wechat' stamped on their event (used
 *  by isReplyToolCall to detect the reply tool). Kept small — extend if the
 *  wechat server adds reply-like tools. */
const WECHAT_TOOL_NAMES = new Set([
  'reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast',
  'memory_read', 'memory_list', 'memory_write', 'memory_edit', 'memory_delete',
  'observations_read', 'observations_list', 'observations_write', 'share_page', 'a2a_send',
])

export const OPENAI_CAPABILITIES: ProviderCapabilities = {
  // We own the loop, so per-tool gating IS realisable.
  perToolCallback: true,
  // No SDK/OS sandbox in v1 — the tier gate is the only barrier.
  sandboxLevels: new Set(),
  supportsDelegation: true,
  supportsResume: false,
  defaultPeer: 'claude',
  authFailHint: 'openai: set WECHAT_OPENAI_API_KEY (and check base_url/model in agent config).',
}

export function mapDeltaToEvent(d: TurnDelta): AgentEvent {
  if (d.kind === 'text') return { kind: 'text', text: d.text }
  return {
    kind: 'tool_call',
    tool: d.name,
    ...(WECHAT_TOOL_NAMES.has(d.name) ? { server: 'wechat' } : {}),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/openai-agent-provider.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/openai-agent-provider.ts src/core/openai-agent-provider.test.ts
git commit -m "feat(openai): OPENAI_CAPABILITIES + delta→AgentEvent mapping"
```

---

## Task 6: The owned loop — session + provider factory + cheapEval

**Files:**
- Modify: `src/core/openai-agent-provider.ts`
- Test: `src/core/openai-agent-provider.test.ts`

**Interfaces:**
- Consumes: `ChatModelClient`, `ChatMessage`, `ToolSpec` (Task 1); `McpToolBridge` (Task 2); `BuiltinTool` (Task 3); `gateTool` (Task 4); `AgentProvider`, `AgentSession`, `SpawnContext`, `AgentProject`, `assertNotAuthFailed` (`src/core/agent-provider.ts`); `randomUUID` (`node:crypto`).
- Produces:
  - `interface OpenAiAgentProviderOptions { chatModel: ChatModelClient; makeMcpBridge: (mcpEnv: Record<string, string>) => Promise<McpToolBridge>; cwd?: string; maxSteps?: number; log?: (tag: string, line: string) => void }`
  - `function createOpenAiAgentProvider(opts: OpenAiAgentProviderOptions): AgentProvider` (implements `spawn`, `cheapEval`, `strongEval`).

- [ ] **Step 1: Write the failing test** (mock chat model that emits a tool call on turn 1, then text on turn 2)

```ts
import { describe, it, expect } from 'vitest'
import { createOpenAiAgentProvider } from './openai-agent-provider'
import { collectTurn } from './agent-provider'
import type { ChatModelClient, ToolSpec } from './openai-chat-model'
import type { McpToolBridge } from './openai-mcp-bridge'

// A scripted ChatModelClient: turn 1 asks to call `reply`, turn 2 answers.
function scriptedModel(): ChatModelClient {
  let turn = 0
  return {
    streamTurn(_messages, _tools) {
      turn++
      const isFirst = turn === 1
      const toolCalls = isFirst ? [{ id: 'c1', name: 'reply', input: { text: 'hi' } }] : []
      async function* deltas() {
        if (isFirst) yield { kind: 'tool_call' as const, id: 'c1', name: 'reply', input: { text: 'hi' } }
        else yield { kind: 'text' as const, text: 'done' }
      }
      return { deltas: deltas(), finished: Promise.resolve({ messages: [{ role: 'assistant', content: '' }] as any, toolCalls }) }
    },
    async generate() { return 'ok' },
    userMessage: (t) => ({ role: 'user', content: t } as any),
    systemMessage: (t) => ({ role: 'system', content: t } as any),
    toolResultMessage: (id, name, r) => ({ role: 'tool', content: `${name}:${JSON.stringify(r)}` } as any),
  }
}

function fakeBridge(calls: string[]): McpToolBridge {
  const tools: ToolSpec[] = [{ name: 'reply', description: 'r', parameters: { type: 'object' } }]
  return { tools, async call(name) { calls.push(name); return `ran:${name}` }, async close() {} }
}

const guestSpawn = {
  tierProfile: { allow: new Set(['reply']), relay: new Set(), deny: new Set() } as any,
  permissionMode: 'strict' as const,
  chatId: 'c',
}

describe('openai provider loop', () => {
  it('runs the tool loop: executes reply, then produces final text', async () => {
    const calls: string[] = []
    const provider = createOpenAiAgentProvider({
      chatModel: scriptedModel(),
      makeMcpBridge: async () => fakeBridge(calls),
    })
    const session = await provider.spawn({ alias: 'a', path: '/tmp' }, guestSpawn as any)
    const summary = await collectTurn(session.dispatch('hi'))
    expect(calls).toEqual(['reply'])            // tool executed
    expect(summary.replyToolCalled).toBe(true)  // reply detected
    expect(summary.assistantText.join('')).toContain('done')
    await session.close()
  })

  it('cheapEval returns text and screens auth failures', async () => {
    const provider = createOpenAiAgentProvider({ chatModel: scriptedModel(), makeMcpBridge: async () => fakeBridge([]) })
    expect(await provider.cheapEval!('ping')).toBe('ok')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/openai-agent-provider.test.ts`
Expected: FAIL — `createOpenAiAgentProvider` not exported.

- [ ] **Step 3: Append the implementation to `src/core/openai-agent-provider.ts`**

```ts
import { randomUUID } from 'node:crypto'
import {
  type AgentProvider,
  type AgentSession,
  type AgentEvent,
  type AgentProject,
  type SpawnContext,
  assertNotAuthFailed,
} from './agent-provider'
import type { ChatModelClient, ChatMessage, ToolSpec } from './openai-chat-model'
import type { McpToolBridge } from './openai-mcp-bridge'
import { builtinTools, type BuiltinTool } from './openai-tools'
import { gateTool } from './openai-gate'

export interface OpenAiAgentProviderOptions {
  chatModel: ChatModelClient
  makeMcpBridge: (mcpEnv: Record<string, string>) => Promise<McpToolBridge>
  cwd?: string
  maxSteps?: number
  log?: (tag: string, line: string) => void
}

const DEFAULT_MAX_STEPS = 25

export function createOpenAiAgentProvider(opts: OpenAiAgentProviderOptions): AgentProvider {
  const log = opts.log ?? (() => {})
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS

  return {
    async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      const sessionId = randomUUID()
      const cwd = opts.cwd ?? project.path
      const bridge = await opts.makeMcpBridge(ctx.mcpEnv ?? {})
      const builtins = builtinTools(cwd)
      const builtinByName = new Map<string, BuiltinTool>(builtins.map(b => [b.spec.name, b]))
      const mcpNames = new Set(bridge.tools.map(t => t.name))
      const toolSpecs: ToolSpec[] = [...bridge.tools, ...builtins.map(b => b.spec)]

      // Conversation history for this live session (in-memory; no resume in v1).
      const messages: ChatMessage[] = []
      if (ctx.appendInstructions) messages.push(opts.chatModel.systemMessage(ctx.appendInstructions))
      let first = true

      const session: AgentSession = {
        dispatch(text: string): AsyncIterable<AgentEvent> {
          messages.push(opts.chatModel.userMessage(text))
          const startedAt = Date.now()
          return (async function* run(): AsyncIterable<AgentEvent> {
            if (first) { first = false; yield { kind: 'init', sessionId } }
            let steps = 0
            for (;;) {
              steps++
              const turn = opts.chatModel.streamTurn(messages, toolSpecs)
              for await (const d of turn.deltas) yield mapDeltaToEvent(d)
              const { messages: assistantMsgs, toolCalls } = await turn.finished
              messages.push(...assistantMsgs)
              if (toolCalls.length === 0) break
              for (const tc of toolCalls) {
                const isMcp = mcpNames.has(tc.name)
                const decision = gateTool({
                  toolName: tc.name,
                  isMcp,
                  input: (tc.input ?? {}) as Record<string, unknown>,
                  tierProfile: ctx.tierProfile,
                  permissionMode: ctx.permissionMode,
                })
                let result: string
                if (decision === 'deny') {
                  result = `Permission denied: tool "${tc.name}" is not allowed for this chat.`
                } else {
                  try {
                    result = isMcp
                      ? await bridge.call(tc.name, tc.input)
                      : await builtinByName.get(tc.name)!.execute((tc.input ?? {}) as Record<string, unknown>)
                  } catch (err) {
                    result = `Tool error: ${err instanceof Error ? err.message : String(err)}`
                  }
                }
                messages.push(opts.chatModel.toolResultMessage(tc.id, tc.name, result))
              }
              if (steps >= maxSteps) {
                yield { kind: 'error', message: `step budget ${maxSteps} exhausted`, code: 'step_budget' }
                break
              }
            }
            yield { kind: 'result', sessionId, numTurns: steps, durationMs: Date.now() - startedAt }
          })()
        },
        async close() {
          await bridge.close().catch(() => {})
        },
      }
      log('SESSION_SPAWN', `alias=${project.alias} provider=openai session=${sessionId}`)
      return session
    },

    async cheapEval(prompt: string): Promise<string> {
      const text = await opts.chatModel.generate([opts.chatModel.userMessage(prompt)])
      assertNotAuthFailed(text, log, 'openai')
      return text
    },

    async strongEval(prompt: string): Promise<string> {
      // v1: same model as cheapEval (DeepSeek is already the strong+cheap model).
      const text = await opts.chatModel.generate([opts.chatModel.userMessage(prompt)])
      assertNotAuthFailed(text, log, 'openai')
      return text
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/openai-agent-provider.test.ts`
Expected: PASS (all tests in the file, including Task 5's).

- [ ] **Step 5: Commit**

```bash
git add src/core/openai-agent-provider.ts src/core/openai-agent-provider.test.ts
git commit -m "feat(openai): owned tool loop, provider factory, cheapEval/strongEval"
```

---

## Task 7: agent-config — provider enum + fields

**Files:**
- Modify: `src/lib/agent-config.ts`
- Test: `src/lib/agent-config.test.ts` (add cases; find the existing file first)

**Interfaces:**
- Produces: `AgentConfig` gains optional `openaiBaseUrl?: string` and `openaiModel?: string`; provider enum accepts `'openai'`.

- [ ] **Step 1: Write the failing test** (append to the existing agent-config test file; if none, create it)

```ts
import { describe, it, expect } from 'vitest'
import { parseAgentConfig } from './agent-config' // use the real parse/load export name

describe('agent-config openai', () => {
  it('accepts provider "openai" with base_url + model', () => {
    const cfg = parseAgentConfig({ provider: 'openai', openaiBaseUrl: 'https://api.deepseek.com/v1', openaiModel: 'deepseek-chat' })
    expect(cfg.provider).toBe('openai')
    expect(cfg.openaiBaseUrl).toBe('https://api.deepseek.com/v1')
    expect(cfg.openaiModel).toBe('deepseek-chat')
  })
})
```
(First run `grep -n "export" src/lib/agent-config.ts` to confirm the parse function name; adjust the import to match — e.g. `loadAgentConfig`/`parseAgentConfig`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/agent-config.test.ts`
Expected: FAIL — `'openai'` rejected by the zod enum / fields undefined.

- [ ] **Step 3: Implement** — edit the zod schema in `src/lib/agent-config.ts`

Change the provider enum:
```ts
// before: provider: z.enum(['claude', 'codex', 'cursor']).default('claude'),
provider: z.enum(['claude', 'codex', 'cursor', 'openai']).default('claude'),
```
Add fields near `model`:
```ts
openaiBaseUrl: z.string().optional(),
openaiModel: z.string().optional(),
```
Add to the `AgentConfig` interface:
```ts
openaiBaseUrl?: string
openaiModel?: string
```
And preserve them in the object the parser returns (mirror how `cursorModel` is carried):
```ts
...(typeof parsed.openaiBaseUrl === 'string' ? { openaiBaseUrl: parsed.openaiBaseUrl } : {}),
...(typeof parsed.openaiModel === 'string' ? { openaiModel: parsed.openaiModel } : {}),
```
Extend the provider mapping ternary to pass `'openai'` through:
```ts
const provider: AgentProviderKind =
  parsed.provider === 'codex' ? 'codex'
  : parsed.provider === 'cursor' ? 'cursor'
  : parsed.provider === 'openai' ? 'openai'
  : 'claude'
```
(If `AgentProviderKind` is a closed union type, add `'openai'` to it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/agent-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-config.ts src/lib/agent-config.test.ts
git commit -m "feat(openai): agent-config provider 'openai' + openaiBaseUrl/openaiModel"
```

---

## Task 8: capability-matrix + cheapEval preference

**Files:**
- Modify: `src/core/capability-matrix.ts`
- Modify: `src/core/provider-registry.ts`
- Test: `src/core/capability-matrix.test.ts` (add a case)

**Interfaces:**
- Consumes: `OPENAI_CAPABILITIES` (Task 5).
- Produces: `CAPABILITIES_BY_PROVIDER` includes `openai`; `assertMatrixComplete(['openai',...])` passes; `CHEAP_EVAL_PREFERENCE` prefers `openai` first.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { lookup, assertMatrixComplete, capabilityProviderIds } from './capability-matrix'

describe('capability-matrix openai', () => {
  it('includes openai and derives all combinations', () => {
    expect(capabilityProviderIds()).toContain('openai')
    expect(() => assertMatrixComplete(['openai'])).not.toThrow()
    expect(lookup('solo', 'openai', 'strict').askUser).toBe('per-tool') // perToolCallback true
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/capability-matrix.test.ts`
Expected: FAIL — `capabilitiesFor('openai')` throws (not registered).

- [ ] **Step 3: Implement**

In `src/core/capability-matrix.ts`, add the import + registry entry:
```ts
import { OPENAI_CAPABILITIES } from './openai-agent-provider'
// ...
const CAPABILITIES_BY_PROVIDER: Record<ProviderId, ProviderCapabilities> = {
  claude: CLAUDE_CAPABILITIES,
  codex:  CODEX_CAPABILITIES,
  cursor: CURSOR_CAPABILITIES,
  openai: OPENAI_CAPABILITIES,
}
```
In `src/core/provider-registry.ts`, prefer the cheap OpenAI model first:
```ts
// before: const CHEAP_EVAL_PREFERENCE: ProviderId[] = ['claude', 'codex']
const CHEAP_EVAL_PREFERENCE: ProviderId[] = ['openai', 'claude', 'codex']
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/capability-matrix.test.ts src/core/provider-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/capability-matrix.ts src/core/provider-registry.ts src/core/capability-matrix.test.ts
git commit -m "feat(openai): register capabilities + prefer openai for cheapEval"
```

---

## Task 9: bootstrap registration

**Files:**
- Modify: `src/daemon/bootstrap/index.ts`

**Interfaces:**
- Consumes: `createOpenAiAgentProvider` (Task 6); `createAiSdkChatModel` (Task 1); `createMcpToolBridge` (Task 2); `wechatStdioMcpSpec`/`delegateStdioMcpSpec` (`./mcp-specs`); `configuredAgent.openaiBaseUrl`/`openaiModel` (Task 7).

- [ ] **Step 1: Add a `wechatStdioForOpenai` + `delegateStdioForOpenai` spec** near the existing `wechatStdioForClaude` (around line 416/432)

```ts
const wechatStdioForOpenai: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'openai') : null
const delegateStdioForOpenai: McpStdioSpec | null = delegateStdioByProvider.openai ?? null
```
And ensure the `delegateStdioByProvider` loop covers `openai` — it iterates `capabilityProviderIds()` and uses each provider's `defaultPeer`, so once Task 8 registers `openai` this is automatic. Confirm by reading the loop at ~line 425.

- [ ] **Step 2: Add the registration block** after the cursor block (~line 790), mirroring its shape

```ts
// openai-compatible (DeepSeek/Kimi/Qwen/OpenRouter/Ollama). Registered only
// when a base_url + model are configured and WECHAT_OPENAI_API_KEY is set.
const openaiKey = process.env.WECHAT_OPENAI_API_KEY
if (openaiKey && configuredAgent.openaiBaseUrl && configuredAgent.openaiModel) {
  try {
    const { createOpenAiAgentProvider } = await import('../../core/openai-agent-provider')
    const { createAiSdkChatModel } = await import('../../core/openai-chat-model')
    const { createMcpToolBridge } = await import('../../core/openai-mcp-bridge')
    registry.register(
      'openai',
      createOpenAiAgentProvider({
        chatModel: createAiSdkChatModel({
          baseURL: configuredAgent.openaiBaseUrl,
          apiKey: openaiKey,
          model: configuredAgent.openaiModel,
        }),
        makeMcpBridge: async (sessionEnv) => {
          const specs: Record<string, McpStdioSpec> = {}
          if (wechatStdioForOpenai) specs.wechat = { ...wechatStdioForOpenai, env: { ...wechatStdioForOpenai.env, ...sessionEnv } }
          if (delegateStdioForOpenai) specs.delegate = { ...delegateStdioForOpenai, env: { ...delegateStdioForOpenai.env, ...sessionEnv } }
          return createMcpToolBridge(specs)
        },
        log: deps.log,
      }),
      { displayName: 'OpenAI-compatible', canResume: () => false },
    )
    deps.log('BOOT', 'openai: base_url + model + WECHAT_OPENAI_API_KEY present — provider registered')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.log('BOOT', `openai: registration failed (${msg}) — provider not registered`)
  }
} else {
  deps.log('BOOT', 'openai: not configured (need WECHAT_OPENAI_API_KEY + openaiBaseUrl + openaiModel) — provider not registered')
}
```

- [ ] **Step 3: Typecheck + run the bootstrap test**

Run: `bunx tsc --noEmit && bun test src/daemon/bootstrap.test.ts`
Expected: PASS (no matrix-completeness throw; openai only registers when configured, so existing tests that don't set the env are unaffected).

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap/index.ts
git commit -m "feat(openai): conditional bootstrap registration (env + base_url + model)"
```

---

## Task 10: End-to-end integration test + docs

**Files:**
- Create: `src/core/openai-integration.test.ts`
- Modify: `README.md` (or the provider docs section) + `docs/superpowers/specs/2026-07-07-openai-compatible-provider-design.md` (mark status done)

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Write the integration test** — real `createOpenAiAgentProvider` + real `builtinTools` + a real MCP bridge over an in-memory fake client + a mock chat model that calls `Write` then finishes. Asserts the tool loop executes a built-in tool and a denied tool is refused.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAiAgentProvider } from './openai-agent-provider'
import { collectTurn } from './agent-provider'
import type { ChatModelClient } from './openai-chat-model'
import type { McpToolBridge } from './openai-mcp-bridge'

// Model: turn 1 → call Write; turn 2 → text 'saved'
function writeThenDone(): ChatModelClient {
  let t = 0
  return {
    streamTurn() {
      t++
      const tcs = t === 1 ? [{ id: 'w1', name: 'Write', input: { path: 'note.txt', content: 'hi there' } }] : []
      async function* deltas() {
        if (t === 1) yield { kind: 'tool_call' as const, id: 'w1', name: 'Write', input: { path: 'note.txt', content: 'hi there' } }
        else yield { kind: 'text' as const, text: 'saved' }
      }
      return { deltas: deltas(), finished: Promise.resolve({ messages: [{ role: 'assistant', content: '' }] as any, toolCalls: tcs }) }
    },
    async generate() { return '' },
    userMessage: (x) => ({ role: 'user', content: x } as any),
    systemMessage: (x) => ({ role: 'system', content: x } as any),
    toolResultMessage: (id, n, r) => ({ role: 'tool', content: `${n}` } as any),
  }
}
const noMcp: McpToolBridge = { tools: [], async call() { return '' }, async close() {} }

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oa-int-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('openai provider integration', () => {
  it('trusted tier executes Write via the owned loop', async () => {
    const provider = createOpenAiAgentProvider({ chatModel: writeThenDone(), makeMcpBridge: async () => noMcp, cwd: dir })
    const session = await provider.spawn({ alias: 'a', path: dir }, {
      tierProfile: { allow: new Set(['fs_write']), relay: new Set(), deny: new Set() } as any,
      permissionMode: 'strict', chatId: 'c',
    } as any)
    const summary = await collectTurn(session.dispatch('write a note'))
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('hi there')
    expect(summary.assistantText.join('')).toContain('saved')
    await session.close()
  })

  it('guest tier denies Write (fs_write ∈ deny) — file is NOT written', async () => {
    const provider = createOpenAiAgentProvider({ chatModel: writeThenDone(), makeMcpBridge: async () => noMcp, cwd: dir })
    const session = await provider.spawn({ alias: 'a', path: dir }, {
      tierProfile: { allow: new Set(), relay: new Set(), deny: new Set(['fs_write']) } as any,
      permissionMode: 'strict', chatId: 'c',
    } as any)
    await collectTurn(session.dispatch('write a note'))
    expect(() => readFileSync(join(dir, 'note.txt'), 'utf8')).toThrow()
    await session.close()
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `bun test src/core/openai-integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Run the full suite + typecheck**

Run: `bunx tsc --noEmit && bun test`
Expected: PASS — full suite green, new provider covered.

- [ ] **Step 4: Document usage** — add a short section to `README.md` (or the providers doc): how to enable openai (set `WECHAT_OPENAI_API_KEY`, `wechat-cc provider set openai --base-url https://api.deepseek.com/v1 --model deepseek-chat` OR edit agent-config), and the v1 limitations (no OS sandbox; relay-classified tools denied in strict mode; no session resume). Mark the spec status done.

- [ ] **Step 5: Commit**

```bash
git add src/core/openai-integration.test.ts README.md docs/superpowers/specs/2026-07-07-openai-compatible-provider-design.md
git commit -m "test(openai): end-to-end loop + gate integration; docs"
```

---

## Self-Review notes (author)

- **Spec coverage:** §3.1 modules → Tasks 1–6; §3.2 owned loop → Task 6; §3.3a MCP bridge → Task 2 (via `@modelcontextprotocol/sdk`, not AI SDK — a stricter choice than the spec's `experimental_createMCPClient`, allowed by spec §7's stated fallback); §3.3b fs/shell → Task 3; §3.4 gate → Task 4 (relay→deny v1 gap documented); §3.5 cheapEval/strongEval → Task 6 + Task 8 preference; §3.6 seam → Task 1 + Global-Constraints grep gate (Task 1 Step 6); §4 config/wiring → Tasks 7/8/9; §5 testing → every task + Task 10; §6 non-goals → capabilities (Task 5) + docs (Task 10).
- **Deviation from spec (flag for reviewer):** relay-classified tools are DENIED in strict mode in v1 (spec §3.4 envisioned routing them through the WeChat relay). Mid-turn user-confirmation round-trip in the owned async loop is deferred. Recorded in Global Constraints + Task 4 + Task 10 docs.
- **Verify-against-installed items:** the v5 `text-delta` field (`.text`) and the `tool-result` ModelMessage output shape (`{type:'text',value}`) are the two spots that could differ by minor version — both are contained inside `openai-chat-model.ts` (Task 1). If Task 1 Step 5 fails, adjust there only.
