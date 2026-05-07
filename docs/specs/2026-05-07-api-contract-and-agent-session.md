# Spec · Daemon API contract + AgentSession unification

**Status**: Draft · 2026-05-07
**Author**: GSR + Claude Opus 4.7 (brainstorming session)
**Implementation**: Two independent PRs (PR-A = P1, PR-B = P2)
**Predecessor context**: Architecture review identified P1/P2 as highest-priority cleanup items in the `v0.5.x` codebase

---

## TL;DR

Two surgical interface changes that close concrete architectural gaps surfaced during the 2026-05-07 architecture review:

1. **P1 — Daemon ↔ Desktop API contract**: `internal-api`'s 24 routes get zod schemas as the single source of truth. The 3 desktop API consumer files (`conversations-poller.js`, `doctor-poller.js`, `ipc.js`) opt into static type checking via `// @ts-check` + JSDoc imports. Daemon schema drift now fails CI before reaching users' machines.

2. **P2 — `AgentSession` interface unification**: Replace the dual return-value-plus-callback shape with a single `AsyncIterable<AgentEvent>`. Both providers (Claude, Codex) already iterate SDK events internally; this just exposes that stream rather than translating it twice. Drops the leaky `replyToolCalled` field — consumers derive it by observing `tool_call` events.

Both PRs are big-bang single-commit-tree changes (no coexistence/shim layer) but independent — order does not matter.

---

## Context

The current architecture has two paper cuts the project keeps stepping on:

**P1 motivation**: `apps/desktop/src/` is plain JavaScript loaded directly by Tauri's webview. The pollers and IPC client call the daemon's HTTP `internal-api` routes, but no shared schema exists between the two layers. When daemon route shapes change, desktop silently breaks at runtime in a packaged build. The 2026-05-04 v0.6 PR5 dashboard rewrite touched several routes and only caught the schema mismatch via manual click-through — a near-miss.

**P2 motivation**: `AgentSession.dispatch()` returns `Promise<{ assistantText[]; replyToolCalled }>` AND exposes `onAssistantText` / `onResult` listener registration. Same data, two paths. The `replyToolCalled` field is a leaky abstraction (it encodes "did the agent call the wechat-mcp reply tool family?" — a wechat-channel concept) up into the provider interface. Coordinator dispatch logic (`solo`, `parallel`, `chatroom`) all hand-roll fallback semantics around this field. Mature SDKs in this space (Anthropic's own, Vercel AI SDK, LangGraph) ship a single async iterator instead.

---

## Scope

**In**:
- New file `src/daemon/internal-api/schema.ts` with zod schemas for all 24 routes
- Validation step injected in `src/daemon/internal-api/index.ts`
- Tightened handler parameter types in `src/daemon/internal-api/routes.ts`
- `tsconfig.json` includes 3 specific `apps/desktop/src/*.js` files; `allowJs: true`
- `// @ts-check` directives + JSDoc imports in those 3 files
- `AgentEvent` discriminated union + new `AgentSession` shape in `src/core/agent-provider.ts`
- Rewrite of `src/core/claude-agent-provider.ts` to yield events instead of accumulating
- Rewrite of `src/core/codex-agent-provider.ts` similarly
- New `collectTurn` + `isReplyToolCall` helpers in `src/core/agent-provider.ts`
- Coordinator dispatch updates (`solo` / `parallel` / `chatroom`) to consume via `collectTurn`
- All affected tests rewritten for new shapes

**Out**:
- Frontend toolchain introduction (vite/esbuild) — separate P0.5 spec when it happens
- Other 14 desktop `.js` files — wait for toolchain
- `routes.ts` decomposition into per-route files
- AgentSession `cancel()` / `abort()` API (still via `close()`)
- OpenAPI / tRPC / additional contract layers — zod is sufficient
- Provider behavior changes (reply-tool detection logic, error handling philosophy unchanged)

---

## P1 Design — Daemon API contract

### Architecture

```
┌─────────────────────────────────────┐
│ src/daemon/internal-api/schema.ts   │  ← single source of truth
│   - 24 RequestSchemas (zod)         │
│   - 24 ResponseSchemas (zod)        │
│   - REQUEST_SCHEMAS lookup table    │
└──────────────┬──────────────────────┘
               │
       ┌───────┴────────┐
       ↓                ↓
┌──────────────┐  ┌────────────────────────────┐
│ index.ts     │  │ apps/desktop/src/*.js      │
│  validates   │  │   (3 files, // @ts-check)  │
│  POST body   │  │   import types via JSDoc   │
│  before      │  │   z.infer<typeof X>        │
│  handler     │  │                            │
└──────────────┘  └────────────────────────────┘
```

### Components

#### `src/daemon/internal-api/schema.ts` (new)

Single file mirroring `routes.ts`'s key order. For each route:

```ts
import { z } from 'zod'

// GET /v1/health
export const HealthResponse = z.object({
  ok: z.boolean(),
  daemon_pid: z.number(),
})

// POST /v1/memory/read
export const MemoryReadRequest = z.object({
  chatId: z.string(),
  name: z.string(),
})
export const MemoryReadResponse = z.object({
  exists: z.boolean(),
  content: z.string().optional(),
})

// ... 22 more routes ...

// Inferred types — exported alongside zod values so JSDoc consumers can
// import them by name without nested generics. Naming convention:
// `<Schema>` is the zod value; `<Schema>T` is the inferred TS type.
export type HealthResponseT = z.infer<typeof HealthResponse>
export type MemoryReadRequestT = z.infer<typeof MemoryReadRequest>
export type MemoryReadResponseT = z.infer<typeof MemoryReadResponse>
// ... one type alias per schema ...

export const REQUEST_SCHEMAS: Record<string, z.ZodTypeAny | undefined> = {
  'POST /v1/memory/read': MemoryReadRequest,
  'POST /v1/memory/write': MemoryWriteRequest,
  // ... and so on; both *Request and *Query schemas are listed
}

export const RESPONSE_SCHEMAS: Record<string, z.ZodTypeAny | undefined> = {
  'GET /v1/health': HealthResponse,
  // ...
}
```

`MemoryWriteRequest`, `ProjectsListResponse`, etc. follow the same pattern — value `Schema` + type alias `SchemaT`. The schema test file (`schema.test.ts`) will spot any forgotten alias because untested zod values catch CI's eye via the test count.

GET routes that read query parameters get a `QuerySchema` instead of (or in addition to) request body schemas:

```ts
// GET /v1/memory/list?chatId=...
export const MemoryListQuery = z.object({
  chatId: z.string(),
})
export const MemoryListResponse = z.object({
  files: z.array(z.object({ name: z.string(), updatedAt: z.string() })),
})
```

GET routes with no query parameters (e.g. `/v1/health`) only get a `Response` schema.

#### `src/daemon/internal-api/index.ts` (modified)

Validation injected before route handler dispatch:

```ts
import { REQUEST_SCHEMAS } from './schema'

// inside the request handler, after parsing body:
const key = `${method} ${path}`
const reqSchema = REQUEST_SCHEMAS[key]
if (reqSchema && method === 'POST') {
  const parsed = reqSchema.safeParse(body)
  if (!parsed.success) {
    deps.log?.('INTERNAL_API', `400 ${key} schema mismatch`, {
      path: key,
      issues: parsed.error.issues,
    })
    return {
      status: 400,
      body: { error: 'invalid_request', detail: parsed.error.flatten() },
    }
  }
  body = parsed.data
}
const out = await route(url.searchParams, body)
```

GET query validation uses the same pattern but parses `Object.fromEntries(url.searchParams)` against the route's `QuerySchema`.

#### `src/daemon/internal-api/routes.ts` (modified)

Each handler signature gets explicit body type via `z.infer`:

```ts
'POST /v1/memory/read': (_q, body: z.infer<typeof MemoryReadRequest>) => {
  // body is now typed; no `as` casts inside the handler
  return deps.memory.read(body.chatId, body.name)
},
```

The handler **logic** does not change. This is purely tightening the type signature so internal type errors surface during `bun run typecheck`.

#### `tsconfig.json` (modified)

```diff
   "compilerOptions": {
     "target": "ESNext",
     "module": "ESNext",
     "moduleResolution": "bundler",
     "strict": true,
     "noUncheckedIndexedAccess": true,
     "skipLibCheck": true,
     "types": ["bun"],
     "lib": ["ESNext"],
     "esModuleInterop": true,
     "allowImportingTsExtensions": true,
     "noEmit": true,
     "verbatimModuleSyntax": true,
     "resolveJsonModule": true,
+    "allowJs": true
   },
   "include": [
     "**/*.ts",
     "src/**/*.ts",
-    "types/**/*.d.ts"
+    "types/**/*.d.ts",
+    "apps/desktop/src/conversations-poller.js",
+    "apps/desktop/src/doctor-poller.js",
+    "apps/desktop/src/ipc.js"
   ],
```

`allowJs: true` is required because we're adding `.js` files to `include`. We do NOT enable `checkJs` globally; type checking is opt-in per file via `// @ts-check` so other desktop `.js` files (still ~14 of them) are unaffected.

#### `apps/desktop/src/{conversations-poller,doctor-poller,ipc}.js` (modified)

Top of each file:

```js
// @ts-check
/** @typedef {import('../../../src/daemon/internal-api/schema').ConversationsListResponseT} ConversationsList */
/** @typedef {import('../../../src/daemon/internal-api/schema').MemoryListResponseT} MemoryList */
```

JSDoc's `import('...').TypeName` syntax requires importing a named export that is itself a TypeScript type — hence the `*T` aliases in `schema.ts`. JSDoc does NOT support generic instantiation inside the import (e.g., `z.infer<typeof X>` would not parse), which is why we pre-compute the inferred types in the schema file rather than at the use site.

Then per-function:

```js
/**
 * @param {string} chatId
 * @returns {Promise<MemoryList>}
 */
export async function loadMemoryList(chatId) {
  const res = await fetch(`${baseUrl}/v1/memory/list?chatId=${encodeURIComponent(chatId)}`, ...)
  return res.json()
}
```

The `@typedef` aliases are declared once per file so the rest of the file uses short names.

### Migration sequence (single PR)

1. Write `schema.ts` with all 24 schemas + lookup tables.
2. Write `schema.test.ts` with round-trip parse tests for each schema (valid + invalid fixture each).
3. Modify `index.ts` to call validation step.
4. Modify `routes.ts` handler signatures to use `z.infer` types.
5. Modify `tsconfig.json` (`allowJs` + 3 include paths).
6. Add `// @ts-check` + JSDoc to 3 desktop files.
7. Verify `bun run typecheck` passes.
8. Verify existing route handler tests pass unchanged.
9. Verify `apps/desktop/shim.e2e.test.ts` + Playwright still pass.

### Tests

**New**:
- `src/daemon/internal-api/schema.test.ts` — for each of 24 schemas: one valid parse + one invalid parse (~50 tests total)
- `src/daemon/internal-api/index.test.ts` adds:
  - "POST with malformed body returns 400 + error detail"
  - "POST with valid body has handler receive parsed `data`"
  - "POST with no schema (e.g. internal route) skips validation"
  - "GET with malformed query returns 400"

**Unchanged**: All 24 route handler tests in `routes.test.ts` (handler logic is not changing).

**Unchanged**: `apps/desktop/shim.e2e.test.ts` and Playwright suites.

---

## P2 Design — `AgentSession` unification

### Architecture

```
┌──────────────────────────────────────────────────┐
│ src/core/agent-provider.ts                       │
│   type AgentEvent = TextEvent | ToolCallEvent    │
│                   | InitEvent | ResultEvent      │
│                   | ErrorEvent                   │
│   interface AgentSession {                       │
│     dispatch(text): AsyncIterable<AgentEvent>    │
│     close(): Promise<void>                       │
│   }                                              │
│   helper collectTurn(events) → TurnSummary       │
│   helper isReplyToolCall(event) → boolean        │
└──────────────────────────────────────────────────┘
              ↑                    ↑
              │                    │
   ┌──────────┴──────┐  ┌──────────┴──────────┐
   │ claude-provider │  │ codex-provider      │
   │  yields events  │  │  yields events      │
   │  per dispatch   │  │  per dispatch       │
   └─────────────────┘  └─────────────────────┘
              ↑                    ↑
              └────────┬───────────┘
                       │
              ┌────────┴────────────────┐
              │ conversation-coordinator│
              │  uses collectTurn()     │
              │  in solo/parallel/chat  │
              └─────────────────────────┘
```

### Components

#### `src/core/agent-provider.ts` (rewritten)

```ts
export interface AgentProject {
  alias: string
  path: string
}

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; server?: string; tool: string }
  | { kind: 'init'; sessionId: string }
  | { kind: 'result'; sessionId: string; numTurns: number; durationMs: number }
  | { kind: 'error'; message: string }

export interface AgentSession {
  dispatch(text: string): AsyncIterable<AgentEvent>
  close(): Promise<void>
}

export interface AgentProvider {
  spawn(
    project: AgentProject,
    opts?: { resumeSessionId?: string },
  ): Promise<AgentSession>
}

// Reply-tool detection moves to consumer space (was duplicated in both providers).
const REPLY_TOOLS = new Set([
  'reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast',
])

export function isReplyToolCall(ev: AgentEvent): boolean {
  return ev.kind === 'tool_call' && ev.server === 'wechat' && REPLY_TOOLS.has(ev.tool)
}

export interface TurnSummary {
  assistantText: string[]
  replyToolCalled: boolean
  result?: { sessionId: string; numTurns: number; durationMs: number }
  error?: string
}

export async function collectTurn(events: AsyncIterable<AgentEvent>): Promise<TurnSummary> {
  const texts: string[] = []
  let replyToolCalled = false
  let result: TurnSummary['result']
  let error: string | undefined
  for await (const ev of events) {
    if (ev.kind === 'text') texts.push(ev.text)
    else if (ev.kind === 'tool_call' && isReplyToolCall(ev)) replyToolCalled = true
    else if (ev.kind === 'result') {
      result = { sessionId: ev.sessionId, numTurns: ev.numTurns, durationMs: ev.durationMs }
    } else if (ev.kind === 'error') {
      error = ev.message
    }
  }
  return { assistantText: texts, replyToolCalled, result, error }
}
```

**Removed from this file**:
- `AgentResult` interface (subsumed into `result` event variant)
- `AgentSession.onAssistantText` / `onResult` listener methods
- `dispatch` return value's `assistantText` / `replyToolCalled` fields

#### Tool name normalization

| Provider | SDK source | Normalized output |
|---|---|---|
| Claude | tool_use block: `name: 'mcp__wechat__reply'` | `{ kind: 'tool_call', server: 'wechat', tool: 'reply' }` |
| Codex | mcp_tool_call item with `server: 'wechat'`, `tool: 'reply'` | `{ kind: 'tool_call', server: 'wechat', tool: 'reply' }` (passthrough) |
| Either, non-MCP | Built-in tools (Read, Bash, etc.) | `{ kind: 'tool_call', tool: '<sdk_name>' }` (no server field) |

Each provider does its own normalization in the event emit step. Consumers (and `isReplyToolCall`) rely on the normalized shape.

#### Error semantics

| SDK signal | Event/exception |
|---|---|
| Claude `result` with `subtype !== 'success'` | yield `{ kind: 'error', message }`, then exit normally |
| Claude SDK iterator throws | iterator throws; consumer's `for await` catches |
| Codex `turn.failed` event | yield `{ kind: 'error', message: ev.error.message }`, then exit |
| Codex `error` event | yield `{ kind: 'error', message: ev.message }`, then exit |
| Codex `runStreamed` rejects | iterator throws; consumer catches |

`collectTurn` captures the error event into `summary.error` rather than rethrowing — consumers decide what to do based on `summary.error` presence + `summary.assistantText` (e.g., partial response with terminal error).

#### `src/core/claude-agent-provider.ts` (rewritten)

Internal `pendingTurns` queue and Promise-based `dispatch` resolution **deleted**. New shape:

```ts
async function spawn(project, spawnOpts) {
  const sdkQueue = new AsyncQueue<SDKUserMessage>()
  const q = query({ prompt: sdkQueue.iterable(), options })
  let activeEventQueue: AsyncQueue<AgentEvent> | null = null
  let closed = false

  ;(async () => {
    try {
      for await (const raw of q as AsyncGenerator<SDKMessage>) {
        const msg = narrow(raw)
        if (!msg) continue
        if (!activeEventQueue) {
          // No in-flight dispatch — preserves v1.2-era [STREAM_DROP] behavior.
          // Trailing chunks after a result, or assistant text from an SDK quirk,
          // get logged but not attributed to a future turn.
          if (msg.type === 'assistant') {
            const text = extractText(msg.message?.content)
            if (text) {
              droppedAssistantChunks++
              console.warn(`wechat channel: [STREAM_DROP] alias=${project.alias} count=${droppedAssistantChunks} preview=${JSON.stringify(text.slice(0, 80))}`)
            }
          }
          continue
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          activeEventQueue.push({ kind: 'init', sessionId: msg.session_id ?? '' })
        } else if (msg.type === 'assistant') {
          const content = msg.message?.content
          // Emit tool_call events for tool_use blocks
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use') {
                activeEventQueue.push(parseToolUseToEvent(block))
              }
            }
          }
          // Emit text event for any text blocks
          const text = extractText(content)
          if (text) activeEventQueue.push({ kind: 'text', text })
        } else if (msg.type === 'result') {
          if (msg.subtype && msg.subtype !== 'success') {
            activeEventQueue.push({ kind: 'error', message: `subtype=${msg.subtype}` })
          }
          activeEventQueue.push({
            kind: 'result',
            sessionId: msg.session_id ?? '',
            numTurns: msg.num_turns ?? 0,
            durationMs: msg.duration_ms ?? 0,
          })
          activeEventQueue.end()  // close iterator after result
          activeEventQueue = null
        }
      }
    } catch (e) {
      if (activeEventQueue) {
        activeEventQueue.push({ kind: 'error', message: errMsg(e) })
        activeEventQueue.end()
      }
    }
  })()

  let droppedAssistantChunks = 0

  return {
    dispatch(text) {
      if (closed) {
        // Already closed — return an iterable that yields nothing and ends.
        return { async *[Symbol.asyncIterator]() {} }
      }
      // Serialize: only one in-flight dispatch at a time. The previous queue
      // must have ended before we set a new one.
      if (activeEventQueue) {
        throw new Error('claude provider: previous dispatch still in flight')
      }
      const queue = new AsyncQueue<AgentEvent>()
      activeEventQueue = queue
      sdkQueue.push({ type: 'user', parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text }] } })
      return queue.iterable()
    },
    async close() {
      closed = true
      sdkQueue.end()
      ;(q as any).close?.()
      ;(q as any).interrupt?.()
      if (activeEventQueue) {
        activeEventQueue.end()
        activeEventQueue = null
      }
    },
  }
}
```

`AsyncQueue` (already in this file) gains an `end()` method (it has it).

`parseToolUseToEvent(block)` parses `mcp__wechat__reply` into `{ server: 'wechat', tool: 'reply' }`, falling back to `{ tool: <name> }` for non-MCP tools.

The `[STREAM_DROP]` warning behavior is preserved: if the SDK iterator emits assistant text after the event queue has already ended, log via `console.warn` and continue.

#### `src/core/codex-agent-provider.ts` (rewritten)

Codex's translation is more direct because `thread.runStreamed` already returns a per-turn `AsyncGenerator<ThreadEvent>`:

```ts
return {
  dispatch(text) {
    return {
      async *[Symbol.asyncIterator]() {
        if (closed) return
        const turnAborter = new AbortController()
        activeAborter = turnAborter
        const turnStarted = Date.now()
        let dispatchedText = text
        if (!instructionsInjected && opts.appendInstructions) {
          dispatchedText = `${opts.appendInstructions}\n\n---\n\n${text}`
          instructionsInjected = true
        }
        try {
          const { events } = await thread.runStreamed(dispatchedText, { signal: turnAborter.signal })
          for await (const ev of events) {
            if (ev.type === 'thread.started') {
              yield { kind: 'init', sessionId: ev.thread_id }
            } else if (ev.type === 'item.completed') {
              const item = ev.item
              if (item.type === 'agent_message') {
                yield { kind: 'text', text: item.text }
              } else if (item.type === 'mcp_tool_call') {
                yield { kind: 'tool_call', server: item.server, tool: item.tool }
              }
            } else if (ev.type === 'turn.completed') {
              yield {
                kind: 'result',
                sessionId: thread.id ?? '',
                numTurns: ++turnCount,
                durationMs: Date.now() - turnStarted,
              }
            } else if (ev.type === 'turn.failed') {
              yield { kind: 'error', message: ev.error.message }
            } else if (ev.type === 'error') {
              yield { kind: 'error', message: ev.message }
            }
          }
        } finally {
          if (activeAborter === turnAborter) activeAborter = null
        }
      },
    }
  },
  async close() { closed = true; activeAborter?.abort() },
}
```

The closure-scoped state (`activeAborter`, `instructionsInjected`, `turnCount`, `closed`) is preserved verbatim. Listener storage (`assistantListeners`, `resultListeners`) is **deleted**.

#### `src/core/conversation-coordinator.ts` (modified)

Replace each `await handle.dispatch(text)` with `await collectTurn(handle.dispatch(text))`. The `assistantText` / `replyToolCalled` extraction continues to work because `TurnSummary` has the same shape:

```diff
   const handle = await deps.manager.acquire(proj.alias, proj.path, providerId)
   const text = deps.format(msg)
-  const result = await handle.dispatch(text)
-  const assistantTexts = result.assistantText
-  const replyToolCalled = result.replyToolCalled
+  const summary = await collectTurn(handle.dispatch(text))
+  const assistantTexts = summary.assistantText
+  const replyToolCalled = summary.replyToolCalled
```

This pattern repeats in:
- `dispatchSolo` (one occurrence)
- `dispatchParallel` (inside `Promise.allSettled` map: `handles.map(h => collectTurn(h.dispatch(text)))`)
- `dispatchChatroom` (per-speaker `await collectTurn(handle.dispatch(dispatchedPrompt))`)

All other coordinator logic — capability matrix gating, fallback degradation, abort controller, history tracking — is unchanged.

### Migration sequence (single PR)

1. Define `AgentEvent`, new `AgentSession`, `collectTurn`, `isReplyToolCall`, `TurnSummary` in `agent-provider.ts`.
2. Rewrite `claude-agent-provider.ts`.
3. Rewrite `codex-agent-provider.ts`.
4. Update `conversation-coordinator.ts` (3 dispatch functions).
5. Rewrite `claude-agent-provider.test.ts` (assert event sequence).
6. Rewrite `codex-agent-provider.test.ts` (same).
7. Add `agent-provider.test.ts` (collectTurn + isReplyToolCall units).
8. Update `conversation-coordinator.test.ts` — rewrite all `makeFakeSession()` call sites to yield events.
9. Run full test suite + `bun run typecheck`.
10. Spot-check a chat session against a real Claude / Codex session via shim.

### Tests

**New**:
- `src/core/agent-provider.test.ts` — `collectTurn` (5-7 tests covering text/tool_call/result/error event sequences) + `isReplyToolCall` (4 tests covering wechat-mcp tools, non-wechat-server tools, non-tool events).

**Rewritten**:
- `src/core/claude-agent-provider.test.ts` — assertions shift from "dispatch returns aggregated `{texts, replyToolCalled}`" to "dispatch yields events in this sequence".
- `src/core/codex-agent-provider.test.ts` — same.
- `src/core/conversation-coordinator.test.ts` — fixture helper `makeFakeSession({ events: AgentEvent[] })` produces an `AgentSession` whose `dispatch()` returns an iterable of the supplied events. All ~30 test cases consume this helper. Existing assertions on coordinator behavior (fallback fan-out, parallel, chatroom routing) are preserved.

**Unchanged**:
- All e2e tests in `src/daemon/__e2e__/` — these test daemon-level behavior, not provider internals. Their fake-sdk implementations get swapped to the new shape.
- All inbound middleware tests — coordinator interface (`dispatch(msg): Promise<void>`) is unchanged.
- `apps/desktop/shim.e2e.test.ts` and Playwright — completely orthogonal.

---

## Risks

### P1

1. **`@typedef` import path verbosity in JSDoc**: `import('../../../src/daemon/internal-api/schema').ConversationsListResponse` is ugly. Mitigation: declare each type alias once at the top of each desktop file; downstream usage stays clean.

2. **Schema/handler return-shape drift**: response schemas are declared but not actively asserted against handler return values. Mitigation: declared as type-only contracts (caught by `tsc` if the handler return type doesn't match `z.infer`); optionally add a dev-mode `.parse()` assertion as a follow-up.

3. **`allowJs` ripple effects**: enabling `allowJs` widens what TypeScript considers part of the project. Mitigation: explicit `include` list — only the 3 named files are compiled, not all `.js` in the repo. Verified by inspecting `tsc --listFiles`.

### P2

1. **`conversation-coordinator.test.ts` rewrite volume**: 367 lines, ~30 test cases. Mitigation: write `makeFakeSession({ events })` helper first; mechanical substitution after.

2. **Claude provider `[STREAM_DROP]` semantics**: current code logs when assistant text arrives without a pending turn. New shape: when assistant text arrives without an `activeEventQueue`, the warn fires identically — no functional change.

3. **Concurrent dispatch**: Claude provider currently serializes via FIFO `pendingTurns`. New shape throws on second `dispatch()` while one is in flight (cleaner contract). Coordinator currently never makes parallel dispatches against the same session, so this is a no-op in practice — but a behavioral tightening worth noting.

4. **Codex `instructionsInjected` first-dispatch state**: preserved exactly. The injection happens inside the iterator body before the first `runStreamed` call.

---

## Non-goals (explicit)

1. **Frontend toolchain introduction** — out of scope. Z option's whole point.
2. **Routes file decomposition** — `routes.ts` remains a single object literal. Splitting into per-route files is a separate refactor.
3. **OpenAPI / tRPC / contract spec layer** — zod is the contract.
4. **AgentSession streaming-text events at sub-message granularity** — events are emitted at SDK message boundaries (full text per assistant block), not per token. Sub-message streaming is a future API contract change if dashboard ever needs it.
5. **`AgentSession.cancel()` / explicit per-dispatch abort** — `close()` covers session shutdown; per-dispatch abort is a future API addition only if needed.
6. **`replyToolCalled` for non-wechat tool families** — `isReplyToolCall` is hardcoded to `server === 'wechat'`. If the channel ever ships another MCP server with reply-like semantics, this gets a list parameter.

---

## Open questions / future work

- **P1 follow-up**: dev-mode response parse assertion to catch schema/handler drift even when handler types match `z.infer` formally but actual return value diverges.
- **P2 follow-up**: should `init` and `error` events surface to dashboard via internal-api? Currently consumed only by `collectTurn`. Decision deferred until dashboard has a reason to render them.
- **Both**: when frontend toolchain (vite/esbuild) lands, B-mid (.js + JSDoc) graduates to full `.ts`. The `// @ts-check` markers become redundant; the schema imports become regular TS imports. No behavior change.

---

## Implementation order

PR-A (P1) and PR-B (P2) are fully independent — no shared files, no shared tests. Can be implemented in either order, or in parallel by separate agents/sessions. Recommend P1 first only because its CI signal (typed failure on schema mismatch) provides immediate user-facing risk reduction; P2 is internal cleanup.
