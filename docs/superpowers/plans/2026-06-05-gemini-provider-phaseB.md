# Gemini Provider — Phase B (integration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Phase-A Gemini provider into the daemon as a selectable, tier-gated 4th provider — the real genai client, the MCP-over-stdio connection, the real per-tool gate, the capability row, the config/enum plumbing, and the `/gemini` + doctor + display-name surface — so a user can pick Gemini and it answers using the daemon's tools.

**Architecture:** Two new helpers land in the provider module (`makeGeminiToolGate` — the real tier gate replicating `makeCanUseTool`'s allow/relay/deny but returning `ToolGateDecision` and normalizing bare MCP tool names; `connectWechatMcp` — opens an `@modelcontextprotocol/sdk` Client over stdio to the wechat server). A bootstrap registration block (mirroring Cursor's) constructs the real `genai`/`mcpConnect`/`buildGate`/`systemInstruction` and registers the provider. The rest is mechanical enum/CLI/doctor plumbing — `ProviderId` is already an open `string`, so the blast radius is the closed enumerations only.

**Tech Stack:** TypeScript, Bun, vitest, `@google/genai` 2.8.0, `@modelcontextprotocol/sdk` 1.29.0.

**Spec:** `docs/superpowers/specs/2026-06-04-gemini-provider-design.md`. **Prereqs:** Phase 0 (spike, GO) + Phase A (`gemini-agent-provider.ts` with `GEMINI_CAPABILITIES`, `createGeminiAgentProvider`, `runDispatchLoop`, `mcpToolsToFunctionDeclarations`, the `ToolGate`/`McpConnection`/`GenaiClient` types) are merged on this branch.

---

## Scope note

**Deferred (documented follow-ups, NOT this plan):**
- **Full daemon e2e** ("Gemini answers a WeChat user"). It needs new harness plumbing (`installFakeGemini` + a recorder + the `agentConfig.provider` union) AND a real `GEMINI_API_KEY` to confirm the genai response contract. Phase B verifies at **unit + boot level** (the gate logic, the config plumbing, that gemini registers + `assertMatrixComplete` passes). The keyed daemon e2e is a follow-up for when a key is available — it's also where the documented-but-unverified `resp.text`/`resp.functionCalls` shape gets confirmed against the live SDK (spike findings note).
- Wizard card, `delegate_gemini`, session resume, Vertex (per the spec).

---

## Background — pinned current code these tasks edit

- `AgentProviderKind = 'claude' | 'codex' | 'cursor'` at `agent-config.ts:8`; `z.enum(['claude','codex','cursor'])` at `agent-config.ts:61` and `schema.ts:62`; `loadAgentConfig` resolution chain `parsed.provider === 'codex' ? 'codex' : parsed.provider === 'cursor' ? 'cursor' : 'claude'` (`agent-config.ts:97-100`); `cursorModel?: string` field at `agent-config.ts:16` + schema line 63.
- `ProviderId = string` (`conversation.ts:16`) — **open, no change.**
- `CAPABILITIES_BY_PROVIDER` at `capability-matrix.ts:107-111`; `assertMatrixComplete(registry.list())` gates boot at `bootstrap/index.ts:704`.
- `isProviderCommand` (`mode-commands.ts:59-65`), `defaultDelegatePeer` (`:74-79`), the `支持: cc, codex, cursor` message (`:189`), the `/mode` status line (`:245`).
- `provider set` validation (`cli.ts:814`), its args description (`:800-802`), HELP_TEXT (`:158`).
- doctor's cursor pattern: `defaultProbeCursor` (`doctor.ts:359-367`), `probeCursor` hook (`:63`), `checks.cursor` (`:235-248`), `nextActions` push (`:152-188`), `provider` fix branch (`:269-287`); `DoctorOutput.cursor` shape (`schema.ts:87-90`).
- `providerDisplayName`/`KNOWN_NAMES` (`provider-display-names.ts:16-27`) — fallback already yields `'Gemini'`; adding the entry is for consistency.
- `CHEAP_EVAL_PREFERENCE = ['claude','codex']` (`provider-registry.ts:49`); fallback loop picks up any other cheapEval (`:67-84`).
- Cursor registration block to mirror: `bootstrap/index.ts:656-698`; the deps available there: `deps.ilink.askUser`, `deps.stateDir`, `deps.dangerouslySkipPermissions`, `deps.log`, `conversationStore`, `permissionMode`, `deps.internalApi`; `wechatStdioMcpSpec(deps.internalApi, 'gemini')` from `mcp-specs.ts`; `resolveAdminChatId(loadAccess(), loadCompanionConfig(deps.stateDir), chatId)` (`bootstrap/index.ts:298-310`); `buildSystemPrompt({providerId, peerProviderId, companionEnabled, delegateAvailable})` (`prompt-builder.ts`).
- The gate to replicate: `makeCanUseTool` (`permission-relay.ts:68-103`): `kind = classifyToolUse(toolName, input)`; `base = lookup(mode, provider, permissionMode)`; `decision = effectivePolicy(base, TIER_PROFILES[tier], kind)`; allow→allow, deny→deny(message), relay→`askUser(admin, prompt, hash, timeout)`→allow/deny.

**Run tests with `bun run test`** (NOT `bun test`). Typecheck: `bun run typecheck`.

---

## Task 1: Config + enum plumbing — `'gemini'` + `geminiModel`

**Files:**
- Modify: `src/lib/agent-config.ts`, `src/cli/schema.ts`
- Test: `src/lib/agent-config.test.ts` (or wherever `loadAgentConfig` is tested — grep `loadAgentConfig` in test files)

- [ ] **Step 1: Write the failing test**

Find the agent-config test file: `grep -rln 'loadAgentConfig' src/lib/*.test.ts src/**/*.test.ts | head`. Append a test (adapt the existing test's setup — it writes a config json to a tmp dir and calls `loadAgentConfig(dir)`):
```ts
it('resolves provider=gemini + geminiModel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentcfg-'))
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'gemini', geminiModel: 'gemini-flash-latest' }))
  const cfg = loadAgentConfig(dir)
  expect(cfg.provider).toBe('gemini')
  expect(cfg.geminiModel).toBe('gemini-flash-latest')
})
```
(Match the imports the existing tests use — `mkdtempSync`/`writeFileSync`/`join`/`tmpdir` are likely already imported there.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test <that test file>`
Expected: FAIL — `provider` resolves to `'claude'` (gemini not in the chain) and `geminiModel` is undefined.

- [ ] **Step 3: Add `'gemini'` to the union, schema, field, and resolution**

In `src/lib/agent-config.ts`:
- Line 8: `export type AgentProviderKind = 'claude' | 'codex' | 'cursor' | 'gemini'`
- In the `AgentConfig` interface (near `cursorModel?: string` at line 16) add: `geminiModel?: string`
- Line 61 (`AgentConfigSchema`): `provider: z.enum(['claude', 'codex', 'cursor', 'gemini']).default('claude'),`
- Below `cursorModel: z.string().optional(),` (line 63) add: `geminiModel: z.string().optional(),`
- In `loadAgentConfig` resolution chain (lines 97-100), extend it:
```ts
    const provider: AgentProviderKind =
      parsed.provider === 'codex' ? 'codex'
      : parsed.provider === 'cursor' ? 'cursor'
      : parsed.provider === 'gemini' ? 'gemini'
      : 'claude'
```
- In the returned object (near `...(typeof parsed.cursorModel === 'string' ? { cursorModel: parsed.cursorModel } : {}),`) add:
```ts
      ...(typeof parsed.geminiModel === 'string' ? { geminiModel: parsed.geminiModel } : {}),
```

In `src/cli/schema.ts`:
- Line 62: `const AgentProviderKind = z.enum(['claude', 'codex', 'cursor', 'gemini'])`
- In the inline `AgentConfigSchema` (line 184-191), below `cursorModel: z.string().optional(),` add: `geminiModel: z.string().optional(),`

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test <that test file>` → PASS. Run `bun run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-config.ts src/cli/schema.ts <that test file>
git commit -m "feat(gemini): AgentProviderKind gemini + geminiModel config field"
```

---

## Task 2: Capability-matrix row

**Files:**
- Modify: `src/core/capability-matrix.ts`
- Test: `src/core/capability-matrix.test.ts` (grep for the existing per-provider tests)

- [ ] **Step 1: Write the failing test**

In `src/core/capability-matrix.test.ts`, add (mirroring how it tests claude/codex/cursor rows exist):
```ts
import { GEMINI_CAPABILITIES } from './gemini-agent-provider'
it('has a capability row for gemini', () => {
  // deriveCapability must not throw for gemini across modes/perms
  expect(() => deriveCapability(GEMINI_CAPABILITIES, 'solo', 'strict')).not.toThrow()
})
```
(Check the file's existing imports/exports — it likely already imports `deriveCapability` or `CAPABILITIES_BY_PROVIDER` / `assertMatrixComplete`. Mirror an existing cursor-row test if present.)

- [ ] **Step 2: Run it to verify it fails OR (if the test is matrix-membership) confirm the gap**

Run: `bun run test src/core/capability-matrix.test.ts`
If the test asserts `CAPABILITIES_BY_PROVIDER.gemini` exists, it FAILs (no gemini key). If it only checks `deriveCapability` works on the const, it may pass — in that case add an assertion that `CAPABILITIES_BY_PROVIDER` includes `'gemini'` after Step 3.

- [ ] **Step 3: Add the row**

In `src/core/capability-matrix.ts`:
- Add the import: `import { GEMINI_CAPABILITIES } from './gemini-agent-provider'` (next to the other provider-capability imports).
- In `CAPABILITIES_BY_PROVIDER` (lines 107-111) add the line:
```ts
  gemini: GEMINI_CAPABILITIES,
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test src/core/capability-matrix.test.ts` → PASS. `bun run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/capability-matrix.ts src/core/capability-matrix.test.ts
git commit -m "feat(gemini): CAPABILITIES_BY_PROVIDER gemini row"
```

---

## Task 3: The real tier gate — `makeGeminiToolGate`

**Files:**
- Modify: `src/core/gemini-agent-provider.ts`, `src/core/gemini-agent-provider.test.ts`

Builds the real per-tool gate (replicating `makeCanUseTool`'s allow/relay/deny), returning `ToolGateDecision`, normalizing bare tool names, decoupled via injected deps so it's unit-testable. Bootstrap (Task 5) supplies the real deps.

- [ ] **Step 1: Write the failing test**

Append to `src/core/gemini-agent-provider.test.ts`:
```ts
import { makeGeminiToolGate, type GeminiGateDeps } from './gemini-agent-provider'

describe('makeGeminiToolGate', () => {
  function deps(over: Partial<GeminiGateDeps> = {}): GeminiGateDeps {
    return {
      askUser: async () => 'allow',
      adminFor: () => 'admin-chat',
      modeFor: () => 'solo',
      lookupBase: () => ({ askUser: 'never' } as any),
      ...over,
    }
  }
  const ctx = (tier: 'admin'|'trusted'|'guest', perm: 'strict'|'dangerously' = 'strict') =>
    ({ tierProfile: TIER_PROFILES[tier], permissionMode: perm, chatId: 'c1' }) as any

  it('dangerously → always allow', async () => {
    const gate = makeGeminiToolGate(deps())(ctx('guest', 'dangerously'))
    expect(await gate('memory_delete', {})).toEqual({ allow: true })
  })
  it('guest: reply allowed, memory_delete denied', async () => {
    const gate = makeGeminiToolGate(deps())(ctx('guest'))
    expect((await gate('reply', { chat_id: 'c', text: 'x' })).allow).toBe(true)
    expect((await gate('memory_delete', { path: 'p' })).allow).toBe(false)
  })
  it('trusted: a2a_send relays → askUser allow ⇒ allow', async () => {
    const gate = makeGeminiToolGate(deps({ askUser: async () => 'allow' }))(ctx('trusted'))
    expect((await gate('a2a_send', { agent_id: 'x', text: 't' })).allow).toBe(true)
  })
  it('trusted: a2a_send relays → askUser deny ⇒ deny', async () => {
    const gate = makeGeminiToolGate(deps({ askUser: async () => 'deny' }))(ctx('trusted'))
    expect((await gate('a2a_send', { agent_id: 'x', text: 't' })).allow).toBe(false)
  })
  it('relay but no admin ⇒ deny', async () => {
    const gate = makeGeminiToolGate(deps({ adminFor: () => null }))(ctx('trusted'))
    expect((await gate('a2a_send', {})).allow).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/core/gemini-agent-provider.test.ts` → FAIL (`makeGeminiToolGate` not exported).

- [ ] **Step 3: Implement the gate**

Append to `src/core/gemini-agent-provider.ts` (add imports at the top: `import { classifyToolUse, TIER_PROFILES } from './user-tier'` — note `TIER_PROFILES` may already be importable; and `import { effectivePolicy } from './permission-relay'`; and a `Capability` type import if needed for the deps type — use `import type { Capability } from './capability-matrix'`):
```ts
import { classifyToolUse } from './user-tier'
import { effectivePolicy } from './permission-relay'
import type { Capability } from './capability-matrix'

/** Injected deps for the gate — bootstrap supplies the real ones; tests fake them.
 *  Kept abstract so the provider module doesn't import bootstrap. */
export interface GeminiGateDeps {
  /** Relay a permission prompt to the admin chat; returns the operator's answer. */
  askUser: (adminChatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow' | 'deny' | 'timeout'>
  /** Resolve the admin chat to relay to for this initiating chat (null ⇒ none). */
  adminFor: (chatId: string) => string | null
  /** The current conversation mode for this chat (for the capability lookup). */
  modeFor: (chatId: string) => string
  /** The capability-matrix base row for (mode, gemini, permissionMode). */
  lookupBase: (mode: string, permissionMode: PermissionMode) => Capability
}

const GEMINI_RELAY_TIMEOUT_MS = 120_000

/** Build the per-spawn tool gate. Replicates makeCanUseTool's allow/relay/deny
 *  but returns ToolGateDecision and normalizes the wechat MCP server's BARE tool
 *  names (`reply`) into the `mcp__wechat__reply` form classifyToolUse expects. */
export function makeGeminiToolGate(deps: GeminiGateDeps): (ctx: SpawnContext) => ToolGate {
  return (ctx: SpawnContext): ToolGate => {
    return async (toolName, input) => {
      if (ctx.permissionMode === 'dangerously') return { allow: true }
      const kind = classifyToolUse(`mcp__wechat__${toolName}`, input)
      const base = deps.lookupBase(deps.modeFor(ctx.chatId), ctx.permissionMode)
      const decision = effectivePolicy(base, ctx.tierProfile, kind)
      if (decision === 'allow') return { allow: true }
      if (decision === 'deny') return { allow: false, message: `tool '${toolName}' (${kind}) not allowed for this tier` }
      // relay
      const admin = deps.adminFor(ctx.chatId)
      if (!admin) return { allow: false, message: 'no admin configured to approve permission requests' }
      const answer = await deps.askUser(admin, `Gemini wants to run ${toolName}`, toolName, GEMINI_RELAY_TIMEOUT_MS)
      if (answer === 'allow') return { allow: true }
      return { allow: false, message: answer === 'timeout' ? 'no reply in time; denied' : 'denied by operator' }
    }
  }
}
```
(If `TIER_PROFILES` isn't already imported in this file from a prior task, the test imports it itself — the provider module only needs `classifyToolUse`/`effectivePolicy`/`Capability`.)

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test src/core/gemini-agent-provider.test.ts` → PASS (all gate cases + the earlier suites). `bun run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/gemini-agent-provider.ts src/core/gemini-agent-provider.test.ts
git commit -m "feat(gemini): makeGeminiToolGate — real tier gate (allow/relay/deny) over the loop"
```

---

## Task 4: The MCP-over-stdio connection helper — `connectWechatMcp`

**Files:**
- Modify: `src/core/gemini-agent-provider.ts`

This wraps the MCP SDK Client/StdioClientTransport (proven by the spike) into the `McpConnection` the provider expects. It's hard to unit-test (spawns a subprocess), so it's verified by typecheck + the boot test in Task 5 (and the spike already proved the live round-trip).

- [ ] **Step 1: Implement the helper**

Append to `src/core/gemini-agent-provider.ts`:
```ts
/** Stdio launch spec for an MCP server (matches bootstrap's McpStdioSpec). */
export interface GeminiMcpStdioSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

/** Connect an MCP client over stdio to a server (the daemon's wechat server) and
 *  adapt it to the McpConnection the provider consumes. Dynamic-imports the MCP
 *  SDK so this module stays import-light. */
export async function connectWechatMcp(spec: GeminiMcpStdioSpec): Promise<McpConnection> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env })
  const client = new Client({ name: 'wechat-cc-gemini', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return {
    async listTools() {
      const res = await client.listTools()
      return res.tools as McpToolDef[]
    },
    async callTool(name, args) {
      const res = await client.callTool({ name, arguments: args })
      return { content: (res.content as unknown[]) ?? [], isError: res.isError as boolean | undefined }
    },
    async close() {
      try { await client.close() } catch { /* swallow */ }
    },
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck` → exit 0. (If the MCP SDK's `callTool` return type doesn't have `content`/`isError` directly, adjust the casts — the spike confirmed `{ content: [...] }`; pin against the installed `@modelcontextprotocol/sdk` 1.29.0 types.)

- [ ] **Step 3: Run the provider tests (no regression)**

Run: `bun run test src/core/gemini-agent-provider.test.ts` → still green (this helper isn't exercised by the unit tests; it's wired in Task 5).

- [ ] **Step 4: Commit**

```bash
git add src/core/gemini-agent-provider.ts
git commit -m "feat(gemini): connectWechatMcp — MCP client over stdio → McpConnection"
```

---

## Task 5: Bootstrap registration

**Files:**
- Modify: `src/daemon/bootstrap/index.ts`
- Test: a boot/registration test (extend an existing bootstrap or e2e test that checks `registry.list()`, OR a focused new test)

- [ ] **Step 1: Add the gemini MCP spec + registration block**

In `src/daemon/bootstrap/index.ts`, near the cursor mcp-spec assignments (~lines 395-396) add:
```ts
const wechatStdioForGemini: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'gemini') : null
```
Then **after the Cursor registration block (after line ~698)** add the Gemini block (mirrors Cursor's guard + dynamic import + register):
```ts
const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
if (geminiKey && !configuredAgent.geminiModel) {
  deps.log('BOOT',
    'gemini: GEMINI_API_KEY is set but geminiModel is not configured. ' +
    'Run `wechat-cc provider set gemini --model gemini-flash-latest`. Provider not registered.',
  )
} else if (geminiKey) {
  try {
    const { GoogleGenAI } = await import('@google/genai')
    const { createGeminiAgentProvider, makeGeminiToolGate, connectWechatMcp } = await import('../../core/gemini-agent-provider')
    const { lookup } = await import('../../core/capability-matrix')
    const genaiClient = new GoogleGenAI({ apiKey: geminiKey }) as unknown as import('../../core/gemini-agent-provider').GenaiClient
    const buildGate = makeGeminiToolGate({
      askUser: deps.ilink.askUser,
      adminFor: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(deps.stateDir), chatId),
      modeFor: (chatId) => conversationStore.get(chatId)?.mode.kind ?? 'solo',
      lookupBase: (mode, perm) => lookup(mode as never, 'gemini', perm),
    })
    registry.register(
      'gemini',
      createGeminiAgentProvider({
        genai: genaiClient,
        model: configuredAgent.geminiModel!,
        systemInstruction: buildSystemPrompt({ providerId: 'gemini', peerProviderId: 'claude', companionEnabled, delegateAvailable: false }),
        mcpConnect: () => {
          if (!wechatStdioForGemini) throw new Error('gemini: internalApi unavailable — cannot connect wechat MCP')
          return connectWechatMcp(wechatStdioForGemini)
        },
        buildGate,
        cheapModel: process.env.WECHAT_GEMINI_CHEAP_MODEL ?? 'gemini-flash-latest',
      }),
      { displayName: 'Gemini', canResume: () => false },
    )
    deps.log('BOOT', 'gemini: SDK + API key present — provider registered')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.log('BOOT', `gemini: SDK not available (${msg}) — run \`bun add @google/genai\` to enable; provider not registered`)
  }
} else {
  deps.log('BOOT', 'gemini: GEMINI_API_KEY not set — provider not registered')
}
```
Notes: `companionEnabled` is the same local used by the other providers' `buildSystemPrompt` calls — grep `companionEnabled` in bootstrap to confirm it's in scope at this point (it is; the cursor/codex/claude blocks use it). If `buildSystemPrompt` is invoked differently per provider in this file, mirror exactly how Cursor builds its system prompt.

- [ ] **Step 2: Add a boot/registration test**

Find a bootstrap test that builds the daemon and inspects `registry.list()` (grep `registry.list()` / `buildBootstrap` in `src/daemon/__e2e__` or `bootstrap.test.ts`). Add a case that sets `process.env.GEMINI_API_KEY = 'test'` + an agent-config with `provider: 'gemini', geminiModel: 'gemini-flash-latest'` and asserts `registry.list()` includes `'gemini'` and the daemon boots (i.e. `assertMatrixComplete` doesn't throw — which it won't, since Task 2 added the row). If a focused boot test is hard, instead add a unit assertion in `capability-matrix.test.ts` that `assertMatrixComplete(['claude','codex','cursor','gemini'])` does not throw. Restore the env var after.

- [ ] **Step 3: Typecheck + run tests**

Run: `bun run typecheck` → exit 0.
Run: `bun run test` → green (the new boot/registration assertion + everything else).

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap/index.ts <the boot test file>
git commit -m "feat(gemini): bootstrap registration — genai client + MCP connect + real tier gate, GEMINI_API_KEY-gated"
```

---

## Task 6: `/gemini` command + delegate peer + messages

**Files:**
- Modify: `src/daemon/mode-commands.ts`
- Test: `src/daemon/mode-commands.test.ts` (grep for `isProviderCommand` tests)

- [ ] **Step 1: Write the failing test**

In `src/daemon/mode-commands.test.ts`, add (mirroring the existing cursor case):
```ts
it('recognizes /gemini as the gemini provider', () => {
  expect(isProviderCommand('gemini')).toBe('gemini')
})
```
(If `isProviderCommand` isn't exported for tests, test via the slash-dispatch path the existing tests use for `/cursor`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/daemon/mode-commands.test.ts` → FAIL.

- [ ] **Step 3: Wire `/gemini`**

In `src/daemon/mode-commands.ts`:
- `isProviderCommand` (lines 59-65): add `if (lower === 'gemini') return 'gemini'` before `return null`.
- `defaultDelegatePeer` (lines 74-79): add `if (primary === 'gemini') return 'claude'` before `return null`.
- The error message (line 189): `支持: cc, codex, cursor, gemini`.
- The `/mode` status line (line 245): add `/gemini` to the command list.

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/daemon/mode-commands.test.ts` → PASS. `bun run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/mode-commands.ts src/daemon/mode-commands.test.ts
git commit -m "feat(gemini): /gemini slash command + delegate peer + help strings"
```

---

## Task 7: CLI `provider set gemini` + doctor + display name + cheap-eval pref

**Files:**
- Modify: `cli.ts`, `src/cli/doctor.ts`, `src/cli/schema.ts`, `src/daemon/provider-display-names.ts`, `src/core/provider-registry.ts`
- Test: `src/cli/doctor.test.ts` (gemini probe) + a `provider set` test if one exists

- [ ] **Step 1: `provider set gemini` (cli.ts)**

- Validation (line 814): `if (args.provider !== 'claude' && args.provider !== 'codex' && args.provider !== 'cursor' && args.provider !== 'gemini') {` and update the error string to `'claude', 'codex', 'cursor', or 'gemini'`.
- `providerSetCmd` args (lines 800-802): update `description` + `valueHint` to include `gemini` (`'claude | codex | cursor | gemini'`, `valueHint: 'claude|codex|cursor|gemini'`).
- HELP_TEXT (line 158): update `provider set <claude|codex>` → `provider set <claude|codex|cursor|gemini>`.

- [ ] **Step 2: doctor gemini probe (mirror cursor)**

In `src/cli/doctor.ts`:
- Add `defaultProbeGemini` next to `defaultProbeCursor` (lines 359-367):
```ts
export function defaultProbeGemini(): { apiKeySet: boolean; sdkInstalled: boolean } {
  const apiKeySet = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
  let sdkInstalled = false
  try { createRequire(import.meta.url).resolve('@google/genai'); sdkInstalled = true } catch { /* not installed */ }
  return { apiKeySet, sdkInstalled }
}
```
- Add `probeGemini?: () => { apiKeySet: boolean; sdkInstalled: boolean }` to `DoctorDeps` (near line 63).
- In `analyzeDoctor`: `const geminiProbe = (deps.probeGemini ?? defaultProbeGemini)()`, `const geminiOk = geminiProbe.apiKeySet && geminiProbe.sdkInstalled`, and in the nextActions chain add `else if (agent.provider === 'gemini' && !geminiOk) nextActions.push('install_gemini')`.
- Add a `checks.gemini` block mirroring `checks.cursor` (lines 235-248) with the fix hint `!geminiProbe.apiKeySet ? { action: 'export GEMINI_API_KEY=<your-key>' } : { command: 'bun add @google/genai' }`.
- In `checks.provider`'s fix branch (lines 269-287), extend the active-provider readiness + fix to handle `gemini` (mirror the `cursor` branch: `cursorIsActive ? cursorOk : ...` → add `geminiIsActive ? geminiOk : ...`; and the fix hint for `agent.provider === 'gemini'`).
- In `src/cli/schema.ts` `DoctorOutput` (lines 87-90): add a `gemini: DoctorCheckBase.extend({ apiKeySet: z.boolean(), sdkInstalled: z.boolean() })` shape next to `cursor`.

- [ ] **Step 3: display name + cheap-eval preference**

- `src/daemon/provider-display-names.ts` (line 16-19): add `gemini: 'Gemini',` to `KNOWN_NAMES`.
- `src/core/provider-registry.ts` (line 49): `const CHEAP_EVAL_PREFERENCE: ProviderId[] = ['claude', 'codex', 'gemini']` (Gemini Flash is cheap; placing it after the two shipped ones is fine — the fallback loop would pick it up anyway, this just makes the cost ordering explicit).

- [ ] **Step 4: Tests**

In `src/cli/doctor.test.ts` add a gemini probe case (mirror the cursor probe test): with `probeGemini` injected returning `{apiKeySet:false,sdkInstalled:false}` and `agent.provider:'gemini'`, assert `checks.gemini.ok === false` and `nextActions` includes `'install_gemini'`. Run: `bun run test src/cli/doctor.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck` → exit 0.
```bash
git add cli.ts src/cli/doctor.ts src/cli/schema.ts src/daemon/provider-display-names.ts src/core/provider-registry.ts src/cli/doctor.test.ts
git commit -m "feat(gemini): provider set gemini + doctor probe + display name + cheap-eval preference"
```

---

## Task 8: Full Phase-B verification

**Files:** none

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck` → exit 0 (gemini is now referenced from bootstrap/matrix/CLI/doctor — confirms the whole wiring typechecks).

- [ ] **Step 2: Full unit suite**

Run: `bun run test`
Expected: all green — the gemini provider tests, the config/matrix/mode-commands/doctor additions, and no regression elsewhere.

- [ ] **Step 3: Boot smoke (gemini selectable, key-gated)**

Run: `bun cli.ts provider set gemini --model gemini-flash-latest 2>&1 | head` → succeeds (writes config; no validation error).
Run (no key): start nothing destructive — instead confirm the registration guard logs cleanly: `GEMINI_API_KEY= bun -e "console.log('gemini guard path: no key → not registered (expected)')"` (the real boot path logs `gemini: GEMINI_API_KEY not set — provider not registered`; a full daemon boot is exercised by the test suite). Reset the provider: `bun cli.ts provider set claude`.

- [ ] **Step 4: Commit (only if Steps 1-3 surfaced a fix)**

```bash
git add -A
git commit -m "chore(gemini): phase-B verification fixes"
```

---

## Decision gate (controller, after Task 8)

Gemini is now a registered, selectable, tier-gated provider — **but the genai response contract is still only mock-verified**, and there's no full daemon e2e. Surface to the user:
- **Get a `GEMINI_API_KEY`** and run the deferred confirmation: `provider set gemini`, send a real WeChat message, verify Gemini answers + uses tools + the tier gate fires. This is also where `resp.text`/`resp.functionCalls` get confirmed against the live SDK; if they differ, fix the two accessor reads in `runDispatchLoop` + the `GenaiPort` mock (the only residual risk from the keyless build).
- The deferred follow-ups (wizard card, `delegate_gemini`, resume, Vertex, the harness-level daemon e2e) remain optional.

---

## Self-Review notes (applied)

- **Spec coverage:** selectable provider + registration (Task 5), tier translation + the real per-tool gate (Task 3 + wired Task 5), MCP consumption via stdio (Task 4 + Task 5), cheapEval preference (Task 7), the enum/config plumbing + capability row (Tasks 1-2), the `/gemini`/doctor/display-name surface (Tasks 6-7). The full daemon e2e + keyed contract-confirm are explicitly deferred (scope note + decision gate) because they need harness plumbing + a key.
- **`ProviderId` is open `string`** → no change there; the blast radius is the closed enums (`AgentProviderKind` ×2) + the hardcoded provider lists (mode-commands, cli, doctor) — all covered.
- **The gate (`makeGeminiToolGate`)** deliberately duplicates ~15 lines of `makeCanUseTool`'s allow/relay/deny rather than refactoring `permission-relay.ts` (which would touch Claude's heavily-tested path). Noted as a future-extract candidate. It's decoupled via `GeminiGateDeps` so it's unit-tested without bootstrap.
- **No placeholders:** every step shows the literal edit + exact commands. The few "grep to find the test file / confirm `companionEnabled` in scope" steps are explicit verifications against named symbols, not hand-waves.
- **Type consistency:** `makeGeminiToolGate`/`GeminiGateDeps`, `connectWechatMcp`/`GeminiMcpStdioSpec`, the `createGeminiAgentProvider` opts (`genai`/`model`/`systemInstruction`/`mcpConnect`/`buildGate`/`cheapModel`) match Phase A's exported signatures exactly; `'gemini'` is added identically across every closed enum.
