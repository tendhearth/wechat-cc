# First-Scan Bot-Name Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On fresh admin's first message, extend onboarding to ask "你想怎么称呼我?" after capturing the user's name; persist to `agent-config.bot_name`; add `/name` admin command for later renaming. Non-admins unaffected.

**Architecture:** Single global field `agent-config.bot_name` mutated in-memory + saved to disk. `botName(mode, cfg)` picks override-or-fallback. Onboarding state machine gains an `awaiting_bot_name` phase, gated by `isAdmin && !getBotName()`. `/name` command in `admin-commands.ts` shares the same `setBotName` closure as onboarding.

**Tech Stack:** TypeScript / Bun / vitest / zod. Project test command: `bun run test <file>`; typecheck: `bun run typecheck`.

**Spec:** `docs/superpowers/specs/2026-05-25-first-scan-name-ask-design.md`

---

## File Map

| File | Action |
|---|---|
| `src/lib/agent-config.ts` | Modify: add `bot_name?` field (interface + zod) + lenient parse in loadAgentConfig |
| `src/lib/agent-config.test.ts` | Modify: add cases for bot_name parse/save/load round-trip |
| `src/daemon/bot-name.ts` | Modify: rename `botNameForMode` → `botNameFromModeFallback`; export new `botName(mode, cfg)` |
| `src/daemon/bot-name.test.ts` | Modify: rename existing import, add override/trim/fallback cases |
| `src/daemon/wiring/side-effects.ts` | Modify: replace hard-coded "Claude" greeting (line 51) with botName lookup |
| `src/daemon/mode-commands.ts` | Modify: `botNameForMode(cur)` → `botName(cur, agentConfig)` |
| `src/daemon/bootstrap/index.ts` | Modify: expose `agentConfig: configuredAgent` in return value |
| `src/daemon/bootstrap.ts` (re-export module) | Modify: ensure `agentConfig` is in the `Bootstrap` type |
| `src/daemon/admin-commands.ts` | Modify: add `NAME_RE` + `/name` handler + `getBotName/setBotName/botNameFallback` deps |
| `src/daemon/admin-commands.test.ts` | Modify: new cases for `/name` set/clear/show/non-admin/invalid |
| `src/daemon/onboarding.ts` | Modify: `awaiting` Map gains `phase` field; awaiting_bot_name branch; new deps |
| `src/daemon/onboarding.test.ts` | Modify: new cases for two-step admin flow / skip / non-admin / `/name` mid-flow |
| `src/daemon/wiring/pipeline-deps.ts` | Modify: build shared `setBotName` closure, thread `agentConfig` into botName, wire onboarding/admin-commands new deps |

No new files.

---

## Task 1 — agent-config.bot_name field

**Files:**
- Modify: `src/lib/agent-config.ts`
- Test: `src/lib/agent-config.test.ts`

**Goal:** Add optional `bot_name: string | null` to the AgentConfig interface and zod schema. Load preserves the field; save round-trips it.

- [ ] **Step 1: Read existing tests to match style**

```bash
head -80 src/lib/agent-config.test.ts
```

- [ ] **Step 2: Add failing test for bot_name round-trip**

Append to `src/lib/agent-config.test.ts`, inside the existing top-level `describe`:

```typescript
  it('round-trips bot_name string through save → load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-botname-'))
    const cfg = {
      provider: 'claude' as const,
      dangerouslySkipPermissions: true,
      autoStart: true,
      closeStopsDaemon: false,
      bot_name: '小希',
    }
    saveAgentConfig(dir, cfg)
    const loaded = loadAgentConfig(dir)
    expect(loaded.bot_name).toBe('小希')
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips bot_name=null through save → load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-botname-null-'))
    const cfg = {
      provider: 'claude' as const,
      dangerouslySkipPermissions: true,
      autoStart: true,
      closeStopsDaemon: false,
      bot_name: null,
    }
    saveAgentConfig(dir, cfg)
    const loaded = loadAgentConfig(dir)
    expect(loaded.bot_name).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('absent bot_name field loads as undefined (back-compat)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-botname-abs-'))
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      provider: 'claude',
      dangerouslySkipPermissions: true,
      autoStart: true,
      closeStopsDaemon: false,
    }))
    const loaded = loadAgentConfig(dir)
    expect(loaded.bot_name).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })
```

If `mkdtempSync` / `rmSync` / `writeFileSync` / `tmpdir` / `join` / `saveAgentConfig` / `loadAgentConfig` aren't already imported at the top of the test file, add them.

- [ ] **Step 3: Run test to verify it fails**

```bash
bun run test src/lib/agent-config.test.ts
```

Expected: the three new tests fail (the existing parse drops unknown fields, so `bot_name` won't appear in loaded output).

- [ ] **Step 4: Add bot_name to the AgentConfig interface**

In `src/lib/agent-config.ts`, modify the `AgentConfig` interface (after `closeStopsDaemon: boolean`, before `a2a_listen?`):

```typescript
  // Admin-chosen self-name. Null/undefined → fall back to botNameForMode(mode).
  // Constrained to NICKNAME_RE (1-24 chars, CJK/Latin/digits/space/_/-).
  // Set via the daemon's onboarding flow (first admin scan) or `/name` command.
  bot_name?: string | null
```

- [ ] **Step 5: Add bot_name to the zod schema**

In the same file, modify `AgentConfigSchema` to add `bot_name` (after the `a2a_agents` field):

```typescript
  bot_name: z.string().nullable().optional(),
```

- [ ] **Step 6: Preserve bot_name through loadAgentConfig**

In `loadAgentConfig`, modify the return block to spread bot_name when present:

```typescript
    return {
      provider,
      ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
      ...(typeof parsed.cursorModel === 'string' ? { cursorModel: parsed.cursorModel } : {}),
      dangerouslySkipPermissions,
      autoStart,
      closeStopsDaemon,
      ...(a2aListen ? { a2a_listen: a2aListen } : {}),
      ...(a2aAgents && a2aAgents.length > 0 ? { a2a_agents: a2aAgents } : {}),
      ...(parsed.bot_name === null ? { bot_name: null } : {}),
      ...(typeof parsed.bot_name === 'string' ? { bot_name: parsed.bot_name } : {}),
    }
```

The two spreads are intentional: explicit `null` (admin chose to clear) and string both preserve; missing field stays undefined.

- [ ] **Step 7: Run test to verify it passes**

```bash
bun run test src/lib/agent-config.test.ts
```

Expected: all tests pass (including the three new bot_name cases plus all existing ones).

- [ ] **Step 8: Typecheck**

```bash
bun run typecheck
```

Expected: zero errors. (Per `feedback_typecheck_after_interface_change.md` memory — vitest alone won't catch broken consumers.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/agent-config.ts src/lib/agent-config.test.ts
git commit -m "feat(agent-config): add optional bot_name field

Per the first-scan name-ask spec — admin's chosen self-name lives
here as a global field; null/undefined falls back to botNameForMode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — bot-name.ts: add botName(mode, cfg)

**Files:**
- Modify: `src/daemon/bot-name.ts`
- Test: `src/daemon/bot-name.test.ts`

**Goal:** Keep the existing mode-derived lookup as a private fallback; add a new top-level `botName(mode, cfg)` that prefers `cfg.bot_name` when set.

- [ ] **Step 1: Write failing tests for new botName signature**

Append to `src/daemon/bot-name.test.ts`:

```typescript
import { botName } from './bot-name'

describe('botName (override + fallback)', () => {
  it('cfg.bot_name set → returns it regardless of mode', () => {
    expect(botName({ kind: 'solo', provider: 'claude' }, { bot_name: '小希' })).toBe('小希')
    expect(botName({ kind: 'parallel' }, { bot_name: '小希' })).toBe('小希')
  })

  it('cfg.bot_name null → falls back to mode-derived name', () => {
    expect(botName({ kind: 'solo', provider: 'claude' }, { bot_name: null })).toBe('cc')
    expect(botName({ kind: 'solo', provider: 'codex' }, { bot_name: null })).toBe('codex')
  })

  it('cfg.bot_name undefined → falls back', () => {
    expect(botName({ kind: 'solo', provider: 'claude' }, {})).toBe('cc')
  })

  it('cfg.bot_name empty/whitespace → falls back (treat as unset)', () => {
    expect(botName({ kind: 'solo', provider: 'claude' }, { bot_name: '' })).toBe('cc')
    expect(botName({ kind: 'solo', provider: 'claude' }, { bot_name: '   ' })).toBe('cc')
  })

  it('cfg.bot_name with surrounding whitespace → trimmed', () => {
    expect(botName({ kind: 'solo', provider: 'claude' }, { bot_name: '  小希  ' })).toBe('小希')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test src/daemon/bot-name.test.ts
```

Expected: import error / `botName is not exported`.

- [ ] **Step 3: Refactor bot-name.ts — rename + add new export**

Replace the contents of `src/daemon/bot-name.ts` (preserve the file header doc):

```typescript
/**
 * bot-name — derive the bot's user-facing self-name. Two-stage:
 *
 *   1. If agent-config has bot_name set (admin chose one), use it.
 *   2. Otherwise derive from the active conversation mode
 *      (claude → cc, codex → codex, parallel/chatroom → cc + codex).
 *
 * The override is set via the daemon's first-scan onboarding flow or
 * the `/name` admin command. Pass the agentConfig REFERENCE around so
 * mutations (saveAgentConfig + in-place update) are visible to all
 * callers without a per-message file read.
 *
 * Keep this pure (no I/O, no registry) so it's trivially testable and
 * safe to call from anywhere in the request hot path.
 */
import type { Mode } from '../core/conversation'

/** Mode-derived fallback. Public for tests + the rare caller that
 *  genuinely wants the mode-only name (e.g. the "回到默认" reply in
 *  /name and the skip-word path in onboarding). */
export function botNameFromModeFallback(mode: Mode): string {
  const nameOf = (id: string): string => (id === 'claude' ? 'cc' : id)
  switch (mode.kind) {
    case 'solo':         return nameOf(mode.provider)
    case 'primary_tool': return nameOf(mode.primary)
    case 'parallel':
    case 'chatroom':     return 'cc + codex'
  }
}

/** Override (cfg.bot_name) wins; falls back to mode-derived name when
 *  the override is null / undefined / empty / whitespace. */
export function botName(mode: Mode, cfg: { bot_name?: string | null }): string {
  const override = cfg.bot_name?.trim()
  if (override) return override
  return botNameFromModeFallback(mode)
}
```

- [ ] **Step 4: Update existing test imports**

In `src/daemon/bot-name.test.ts`, change the top import line:

```typescript
import { botNameForMode } from './bot-name'
```

to:

```typescript
import { botNameFromModeFallback } from './bot-name'
```

And rename the existing `describe` block + its `botNameForMode(...)` calls to `botNameFromModeFallback(...)`. The `botName` import added in Step 1 stays separate.

- [ ] **Step 5: Run tests**

```bash
bun run test src/daemon/bot-name.test.ts
```

Expected: all (existing + new) pass.

- [ ] **Step 6: Typecheck (catches stale botNameForMode callers)**

```bash
bun run typecheck
```

Expected: errors at `mode-commands.ts` and `wiring/pipeline-deps.ts` for stale `botNameForMode` imports. These are fixed in Task 3 — for now, leave them as the typecheck signal that Task 3 has work to do.

If you want a green typecheck at this commit boundary, add a temporary shim export at the bottom of `bot-name.ts`:

```typescript
/** @deprecated kept only between Tasks 2 and 3 of the bot-name spec rollout; removed in Task 3. */
export const botNameForMode = botNameFromModeFallback
```

- [ ] **Step 7: Commit**

```bash
git add src/daemon/bot-name.ts src/daemon/bot-name.test.ts
git commit -m "refactor(bot-name): add botName(mode, cfg) with override path

Existing mode-derived logic preserved as botNameFromModeFallback;
new botName() prefers cfg.bot_name when non-empty after trim.
Temporary botNameForMode alias kept until callers migrate (Task 3).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — migrate callers + drop the shim

**Files:**
- Modify: `src/daemon/bot-name.ts` (remove the temporary alias from Task 2)
- Modify: `src/daemon/mode-commands.ts`
- Modify: `src/daemon/wiring/side-effects.ts`
- Modify: `src/daemon/wiring/pipeline-deps.ts`

**Goal:** Switch every `botNameForMode` call to the new `botName(mode, cfg)` signature. Fix the hard-coded "Claude" in side-effects.ts as a passing-fix. After this task, the `botNameForMode` alias is gone.

- [ ] **Step 1: Find all callers**

```bash
grep -rn "botNameForMode\|botName" src/daemon/ src/core/ src/lib/ --include='*.ts' | grep -v test | grep -v node_modules
```

Expected callers (from spec review): `mode-commands.ts:28,292`, `wiring/pipeline-deps.ts:20,85`, `onboarding.ts:114` (via `deps.botName` indirection — no direct call), `wiring/side-effects.ts:51` (currently a hard-coded literal — needs upgrade).

- [ ] **Step 2: Update mode-commands.ts**

In `src/daemon/mode-commands.ts`, find the import:

```typescript
import { botNameForMode } from './bot-name'
```

Replace with:

```typescript
import { botName } from './bot-name'
import type { AgentConfig } from '../lib/agent-config'
```

Add `agentConfig: AgentConfig` to the deps interface (`ModeCommandsDeps` — search for `setUserName(chatId` to find it). Update the call site (line ~292):

```typescript
const botNameStr = botName(cur, deps.agentConfig)
```

(Rename the local var if needed to avoid shadowing the import.)

Then update the call site that builds the reply line — replace `${botName}` with `${botNameStr}`.

- [ ] **Step 3: Update side-effects.ts (the hardcoded "Claude" bug)**

Read `src/daemon/wiring/side-effects.ts` around line 51:

```bash
sed -n '40,80p' src/daemon/wiring/side-effects.ts
```

The string `'嗨，我是 Claude。我会慢慢理解你...'` is hardcoded. Replace it with a template that uses botName:

a. Add imports at top (after existing imports):

```typescript
import { botName } from '../bot-name'
import type { AgentConfig } from '../../lib/agent-config'
import type { Mode } from '../../core/conversation'
```

b. The function that holds the string is `makeMaybeWriteWelcomeObservation`. Add `agentConfig` + `getMode` to its deps:

```typescript
export function makeMaybeWriteWelcomeObservation(opts: {
  stateDir: string
  db: Db
  agentConfig: AgentConfig
  getMode: (chatId: string) => Mode
}) {
  // ...
}
```

c. Inside the function body, replace the literal string:

```typescript
body: `嗨，我是 ${botName(opts.getMode(chatId), opts.agentConfig)}。我会慢慢理解你，把观察写在这里——你可以随时来翻、纠正、忽略。`,
```

Note: the call site for `makeMaybeWriteWelcomeObservation` is in `pipeline-deps.ts:47`. Update that wiring in Step 5 of this task.

- [ ] **Step 4: Update pipeline-deps.ts (botName closure + welcome wiring)**

In `src/daemon/wiring/pipeline-deps.ts`:

a. Change the import line:

```typescript
import { botNameForMode } from '../bot-name'
```

to:

```typescript
import { botName } from '../bot-name'
```

b. Find the call site `botName: (cid) => botNameForMode(boot.coordinator.getMode(cid)),` (line 85) and replace:

```typescript
    botName: (cid) => botName(boot.coordinator.getMode(cid), boot.agentConfig),
```

(`boot.agentConfig` will be exposed by Task 4 — TypeScript will flag this as a missing property until then. The intended order is: do Tasks 3 + 4 before re-running typecheck.)

c. Update the `maybeWriteWelcomeObservation` construction (line 47) to pass the new deps:

```typescript
  const maybeWriteWelcomeObservation = makeMaybeWriteWelcomeObservation({
    stateDir,
    db,
    agentConfig: boot.agentConfig,
    getMode: (cid) => boot.coordinator.getMode(cid),
  })
```

d. Update the `makeModeCommands` construction (line 71) to pass agentConfig:

```typescript
  const modeHandler = makeModeCommands({
    coordinator: boot.coordinator,
    registry: boot.registry,
    defaultProviderId: boot.defaultProviderId,
    agentConfig: boot.agentConfig,
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    getUserName: (cid) => ilink.resolveUserName(cid) ?? null,
    log,
  })
```

- [ ] **Step 5: Remove the temporary alias from Task 2**

In `src/daemon/bot-name.ts`, delete the `export const botNameForMode = botNameFromModeFallback` line.

- [ ] **Step 6: Typecheck**

```bash
bun run typecheck
```

Expected: errors at `boot.agentConfig` lookups (Bootstrap doesn't expose it yet — fixed in Task 4). Skip the commit until Task 4 makes it green.

- [ ] **Step 7: Run impacted tests (don't commit yet — typecheck still red)**

```bash
bun run test src/daemon/bot-name.test.ts src/daemon/mode-commands.test.ts
```

Expected: bot-name tests pass; mode-commands tests probably need the agentConfig field added to the test setup — fix those failures inline (add `agentConfig: { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false }` to the deps factory).

This task does NOT commit on its own — Task 4 closes the typecheck gap and commits both together.

---

## Task 4 — expose agentConfig from Bootstrap

**Files:**
- Modify: `src/daemon/bootstrap/index.ts`
- Modify: `src/daemon/bootstrap.ts` (re-export module, if it carries the Bootstrap type)

**Goal:** `boot.agentConfig` becomes a property of the Bootstrap return value, holding the same `configuredAgent` reference used internally. Sets up the in-memory mutation channel for Task 5/6.

- [ ] **Step 1: Locate the Bootstrap type**

```bash
grep -n "export.*Bootstrap\b\|export.*type Bootstrap\|export interface Bootstrap" src/daemon/bootstrap.ts src/daemon/bootstrap/index.ts
```

If the type is inferred from the function's return value, no separate interface change is needed — adding the property to the return literal is enough.

- [ ] **Step 2: Add agentConfig to the Bootstrap return**

In `src/daemon/bootstrap/index.ts`, find the final `return {` (around line 779 — the function epilogue) and add `agentConfig: configuredAgent,` to the returned object. Final block looks like:

```typescript
  return {
    sessionManager,
    sessionStore,
    conversationStore,
    registry,
    coordinator,
    resolve,
    formatInbound,
    sdkOptionsForProject,
    defaultProviderId,
    agentProviderKind: defaultProviderId,
    dispatchDelegate,
    a2aDeps,
    a2aServer,
    agentConfig: configuredAgent,
  }
```

- [ ] **Step 3: Verify Bootstrap type picks it up**

```bash
bun run typecheck
```

Expected: the `boot.agentConfig` references in Task 3 now resolve. Any leftover errors are real — fix inline.

- [ ] **Step 4: Run full test suite to sanity-check Task 3 + 4 integration**

```bash
bun run test
```

Expected: all green. Any failures mean a consumer of `botNameForMode` was missed — search and fix.

- [ ] **Step 5: Commit Tasks 3 + 4 together**

```bash
git add src/daemon/bot-name.ts src/daemon/mode-commands.ts src/daemon/wiring/side-effects.ts src/daemon/wiring/pipeline-deps.ts src/daemon/bootstrap/index.ts
# Plus any mode-commands.test.ts updates from Task 3 Step 7
git status
git commit -m "refactor(bot-name): migrate callers to botName(mode, cfg) + expose agentConfig

mode-commands /whoami, the welcome observation writer, and the
onboarding botName closure all now go through the override-aware
botName(). Also fixes the hard-coded '嗨，我是 Claude' welcome
string. Bootstrap's return surface gains agentConfig so the same
in-memory reference is shared across wiring closures.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — `/name` command in admin-commands

**Files:**
- Modify: `src/daemon/admin-commands.ts`
- Test: `src/daemon/admin-commands.test.ts`

**Goal:** Admin can `/name 小希` to set, `/name 跳过` to clear, `/name` alone to show. Non-admins are silently dropped (existing convention).

- [ ] **Step 1: Read existing handler structure**

```bash
sed -n '50,130p' src/daemon/admin-commands.ts
```

Note the pattern: regex const at top → `isCmd` OR-chain in `handle()` → admin gate → if-branch per command → `return true` after sending reply.

- [ ] **Step 2: Add new deps to AdminCommandsDeps**

In `src/daemon/admin-commands.ts`, find the `AdminCommandsDeps` interface (line ~21). Add three fields (alongside `sendMessage`):

```typescript
  getBotName: () => string | null
  setBotName: (name: string | null) => Promise<void>
  botNameFallback: (chatId: string) => string  // mode-derived; shown when bot_name is null
```

- [ ] **Step 3: Add SKIP_WORDS and NAME_RE constants**

Near the other regex consts (after `HEALTH_AI_RE`):

```typescript
// /name <new-name>  — set
// /name 跳过 / 不用 / 没有 / skip / clear / 清除  — clear (fall back to mode-derived)
// /name             — show current
const NAME_RE = /^\s*\/name(?:\s+(.+?))?\s*$/
const NAME_SKIP_WORDS = new Set(['跳过', '不用', '没有', 'skip', 'clear', '清除'])
// Reuse the same nickname constraint onboarding applies to user_name.
// Keep this regex in sync with onboarding.ts::NICKNAME_RE.
const NAME_VALID_RE = /^[一-鿿_a-zA-Z0-9 \-]+$/
const NAME_MAX_LEN = 24
```

- [ ] **Step 4: Wire NAME_RE into the isCmd check**

Find the `isCmd =` line (around line 71). Append `|| NAME_RE.test(text)`:

```typescript
const isCmd = text === '/health' || HEALTH_AI_RE.test(text) || RESET_RE.test(text) || CLEANUP_RE.test(text) || HEARTH_INGEST_RE.test(text) || HEARTH_LIST_RE.test(text) || HEARTH_SHOW_RE.test(text) || HEARTH_APPLY_RE.test(text) || HEARTH_HELP_RE.test(text) || NAME_RE.test(text)
```

- [ ] **Step 5: Add the /name handler branch**

After the existing command branches in `handle()` (find the last `if (...) { ... return true }` before the trailing `return true`), insert:

```typescript
      const nameMatch = text.match(NAME_RE)
      if (nameMatch) {
        const arg = nameMatch[1]?.trim()
        // /name (no arg) — show current
        if (!arg) {
          const current = deps.getBotName()
          const display = current && current.trim() ? current.trim() : deps.botNameFallback(msg.chatId)
          await deps.sendMessage(msg.chatId, `我现在叫 ${display}`)
          return true
        }
        // /name 跳过 — explicit clear
        if (NAME_SKIP_WORDS.has(arg.toLowerCase())) {
          try {
            await deps.setBotName(null)
            const fallback = deps.botNameFallback(msg.chatId)
            await deps.sendMessage(msg.chatId, `好的，回到默认「${fallback}」`)
          } catch (err) {
            deps.log('ADMIN_CMD', `/name clear failed: ${err}`)
            await deps.sendMessage(msg.chatId, '我没记住，稍后再试 /name')
          }
          return true
        }
        // /name <new-name> — validate + set
        if (arg.length > NAME_MAX_LEN) {
          await deps.sendMessage(msg.chatId, `「${arg}」太长（最多 ${NAME_MAX_LEN} 字符）。再试一次?`)
          return true
        }
        if (!NAME_VALID_RE.test(arg)) {
          await deps.sendMessage(msg.chatId, `「${arg}」不行：只支持中文/字母/数字/空格/_/- (1-24 字)`)
          return true
        }
        try {
          await deps.setBotName(arg)
          await deps.sendMessage(msg.chatId, `好的，从现在开始我叫 ${arg}`)
        } catch (err) {
          deps.log('ADMIN_CMD', `/name set failed: ${err}`)
          await deps.sendMessage(msg.chatId, '我没记住，稍后再试 /name')
        }
        return true
      }
```

- [ ] **Step 6: Write failing test cases**

In `src/daemon/admin-commands.test.ts`, find the `beforeEach` and add mocks for the new deps. Inside the existing `describe('admin-commands', ...)`, add a new nested describe:

```typescript
  describe('/name command', () => {
    let getBotName: ReturnType<typeof vi.fn>
    let setBotName: ReturnType<typeof vi.fn>
    let botNameFallback: ReturnType<typeof vi.fn>

    function mkMsg(text: string, chatId = 'admin-1'): InboundMsg {
      return {
        chatId, userId: chatId, userName: undefined, accountId: 'a1',
        text, msgType: 'text', createTimeMs: 0,
      }
    }

    function build(): ReturnType<typeof makeAdminCommands> {
      const deps: AdminCommandsDeps = {
        stateDir, isAdmin, sessionState,
        pollHandle: { stopAccount, stopAccountAndWait, running },
        resolveUserName: () => undefined,
        sendMessage,
        resolveProject: () => null,
        registry: { list: () => [] },
        sessionManager: { release: vi.fn(), list: vi.fn(() => []) },
        sessionStore: { get: vi.fn(() => null), delete: vi.fn() },
        log,
        startedAt: '2026-05-25T00:00:00.000Z',
        getBotName,
        setBotName,
        botNameFallback,
      }
      return makeAdminCommands(deps)
    }

    beforeEach(() => {
      getBotName = vi.fn(() => null)
      setBotName = vi.fn(async () => {})
      botNameFallback = vi.fn(() => 'cc')
      isAdmin.mockReturnValue(true)
    })

    it('/name <valid> from admin → setBotName called + ack', async () => {
      const handler = build()
      const consumed = await handler.handle(mkMsg('/name 小希'))
      expect(consumed).toBe(true)
      expect(setBotName).toHaveBeenCalledWith('小希')
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('小希'))
    })

    it('/name <valid> from non-admin → silently consumed, no setBotName', async () => {
      isAdmin.mockReturnValue(false)
      const handler = build()
      const consumed = await handler.handle(mkMsg('/name 偷偷改'))
      expect(consumed).toBe(true)  // matches existing admin-cmd convention: drop silently
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('/name 跳过 → setBotName(null) + ack with fallback', async () => {
      botNameFallback.mockReturnValue('cc')
      const handler = build()
      await handler.handle(mkMsg('/name 跳过'))
      expect(setBotName).toHaveBeenCalledWith(null)
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('cc'))
    })

    it('/name (bare, bot_name set) → show current', async () => {
      getBotName.mockReturnValue('小希')
      const handler = build()
      await handler.handle(mkMsg('/name'))
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('小希'))
    })

    it('/name (bare, bot_name null) → show fallback', async () => {
      getBotName.mockReturnValue(null)
      botNameFallback.mockReturnValue('cc')
      const handler = build()
      await handler.handle(mkMsg('/name'))
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('cc'))
    })

    it('/name <too long> → validation reply, no setBotName', async () => {
      const longName = 'a'.repeat(25)
      const handler = build()
      await handler.handle(mkMsg(`/name ${longName}`))
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('太长'))
    })

    it('/name <illegal chars> → validation reply, no setBotName', async () => {
      const handler = build()
      await handler.handle(mkMsg('/name 🌸emoji🌸'))
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('不行'))
    })

    it('setBotName throws → ack with retry hint, no crash', async () => {
      setBotName.mockRejectedValueOnce(new Error('disk full'))
      const handler = build()
      const consumed = await handler.handle(mkMsg('/name 小希'))
      expect(consumed).toBe(true)
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('稍后再试'))
    })
  })
```

- [ ] **Step 7: Run tests**

```bash
bun run test src/daemon/admin-commands.test.ts
```

Expected: all new `/name` cases pass; existing admin-command tests still pass.

- [ ] **Step 8: Typecheck**

```bash
bun run typecheck
```

Expected: errors at `pipeline-deps.ts` for the missing `getBotName / setBotName / botNameFallback` props on `makeAdminCommands(...)` — these are wired in Task 7. Leave as the signal.

- [ ] **Step 9: Commit (test-green, typecheck flagging Task 7)**

```bash
git add src/daemon/admin-commands.ts src/daemon/admin-commands.test.ts
git commit -m "feat(admin-commands): add /name command

Admin-only. /name <new-name> sets, /name 跳过 (and skip/clear/不用
/没有/清除) clears to fallback, /name shows current. Validation
matches onboarding's NICKNAME_RE / 24-char ceiling. Non-admin
sending /name is silently consumed, matching the /reset / 清理
convention. setBotName failures reply with a retry hint without
mutating state.

Wiring lands in Task 7 (typecheck still red on pipeline-deps until then).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — onboarding state machine: awaiting_bot_name

**Files:**
- Modify: `src/daemon/onboarding.ts`
- Test: `src/daemon/onboarding.test.ts`

**Goal:** After user_name is captured, if `isAdmin(userId) && !getBotName()`, ask for the bot name and transition to `awaiting_bot_name`. Skip words → store null. Valid name → setBotName. Mid-flow `/name` → detected via getBotName() flip, exit cleanly.

- [ ] **Step 1: Write failing tests in onboarding.test.ts**

In `src/daemon/onboarding.test.ts`, extend `makeDeps` to support the new deps (with sensible defaults so existing tests don't break):

```typescript
function makeDeps(opts: {
  knownUsers?: Set<string>
  nowStart?: number
  admins?: Set<string>
  initialBotName?: string | null
} = {}): {
  deps: OnboardingDeps
  sent: string[]
  saved: Array<{ chatId: string; name: string }>
  dispatched: InboundMsg[]
  setNow: (ms: number) => void
  botNameSet: Array<string | null>
  getBotNameLive: () => string | null
} {
  const known = opts.knownUsers ?? new Set<string>()
  const admins = opts.admins ?? new Set<string>()
  let nowMs = opts.nowStart ?? 1_000_000
  let currentBotName: string | null = opts.initialBotName ?? null
  const sent: string[] = []
  const saved: Array<{ chatId: string; name: string }> = []
  const dispatched: InboundMsg[] = []
  const botNameSet: Array<string | null> = []
  const deps: OnboardingDeps = {
    isKnownUser: (uid) => known.has(uid),
    setUserName: async (chatId, name) => { saved.push({ chatId, name }); known.add(chatId) },
    sendMessage: async (_chatId, text) => { sent.push(text) },
    botName: () => 'cc',
    dispatchInbound: async (msg) => { dispatched.push(msg) },
    log: () => {},
    now: () => nowMs,
    isAdmin: (uid) => admins.has(uid),
    getBotName: () => currentBotName,
    setBotName: async (name) => { botNameSet.push(name); currentBotName = name },
  }
  return {
    deps, sent, saved, dispatched, botNameSet,
    setNow: (ms: number) => { nowMs = ms },
    getBotNameLive: () => currentBotName,
  }
}
```

Then add a new `describe` block at the bottom of the existing top-level describe:

```typescript
  describe('admin two-step flow', () => {
    it('fresh admin: user_name → bot_name → ack + redispatch', async () => {
      const { deps, sent, saved, botNameSet, dispatched, getBotNameLive } = makeDeps({
        admins: new Set(['admin-1']),
      })
      const handler = makeOnboardingHandler(deps)

      // turn 1: admin sends greeting → ask user_name
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))
      expect(sent[0]).toMatch(/你好/)
      expect(sent[0]).toMatch(/称呼你/)

      // turn 2: admin replies with user_name → store, ask bot_name
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'Nate' }))
      expect(saved).toEqual([{ chatId: 'admin-1', name: 'Nate' }])
      expect(sent[1]).toMatch(/好的 Nate/)
      expect(sent[1]).toMatch(/怎么叫我|称呼我/)
      // bot_name not yet stored
      expect(botNameSet).toHaveLength(0)

      // turn 3: admin replies with bot_name → store, ack with original trigger, redispatch
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '小希' }))
      expect(botNameSet).toEqual(['小希'])
      expect(getBotNameLive()).toBe('小希')
      expect(sent[2]).toMatch(/刚才你说「你好」/)
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0].text).toBe('你好')
    })

    it('fresh non-admin: only user_name asked, no bot_name turn', async () => {
      const { deps, sent, saved, botNameSet, dispatched } = makeDeps()
      const handler = makeOnboardingHandler(deps)

      await handler.handle(mkMsg({ userId: 'guest-1', chatId: 'guest-1', text: '在吗' }))
      await handler.handle(mkMsg({ userId: 'guest-1', chatId: 'guest-1', text: 'Alex' }))

      expect(saved).toEqual([{ chatId: 'guest-1', name: 'Alex' }])
      expect(botNameSet).toHaveLength(0)
      // sent[0] = greeting, sent[1] = ack-with-quote. No third turn.
      expect(sent).toHaveLength(2)
      expect(sent[1]).toMatch(/刚才你说「在吗」/)
      expect(dispatched).toHaveLength(1)
    })

    it('admin already has bot_name set → skips bot_name ask', async () => {
      const { deps, saved, botNameSet, dispatched } = makeDeps({
        admins: new Set(['admin-1']),
        initialBotName: '小希',
      })
      const handler = makeOnboardingHandler(deps)

      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'Nate' }))

      expect(saved).toEqual([{ chatId: 'admin-1', name: 'Nate' }])
      expect(botNameSet).toHaveLength(0)
      expect(dispatched).toHaveLength(1)
    })

    it('admin says skip word at bot_name turn → setBotName(null) + fallback ack', async () => {
      const { deps, sent, botNameSet, dispatched } = makeDeps({
        admins: new Set(['admin-1']),
      })
      const handler = makeOnboardingHandler(deps)

      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'Nate' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '跳过' }))

      expect(botNameSet).toEqual([null])
      expect(sent[2]).toMatch(/继续用|默认/)
      expect(dispatched).toHaveLength(1)
    })

    it('admin sends invalid bot_name → retry, no setBotName, state preserved', async () => {
      const { deps, sent, botNameSet } = makeDeps({
        admins: new Set(['admin-1']),
      })
      const handler = makeOnboardingHandler(deps)

      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'Nate' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '🌸' }))

      expect(botNameSet).toHaveLength(0)
      expect(sent[2]).toMatch(/不行|再发一次/)
      // Now a valid name resolves the turn.
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '小希' }))
      expect(botNameSet).toEqual(['小希'])
    })

    it('bot_name set mid-flow via /name → next inbound clears awaiting + redispatches', async () => {
      const { deps, sent, dispatched, botNameSet } = makeDeps({
        admins: new Set(['admin-1']),
      })
      const handler = makeOnboardingHandler(deps)

      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'Nate' }))
      // Simulate /name being handled by mw-admin (deps.setBotName called outside onboarding).
      await deps.setBotName('小希')
      // Next inbound: onboarding should detect getBotName() !== null and exit awaiting cleanly.
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'whatever' }))

      expect(botNameSet).toEqual(['小希'])  // only the /name call, not a second setBotName from onboarding
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0].text).toBe('你好')
      expect(sent.at(-1)).toMatch(/刚才你说「你好」/)
    })
  })
```

- [ ] **Step 2: Run failing tests**

```bash
bun run test src/daemon/onboarding.test.ts
```

Expected: type error first (`isAdmin`, `getBotName`, `setBotName` not in `OnboardingDeps`). Add the fields to deps; then assertion failures.

- [ ] **Step 3: Update OnboardingDeps interface**

In `src/daemon/onboarding.ts`, in the `OnboardingDeps` interface (line ~22), add:

```typescript
  /** True when this user is an admin per access.json. Only admins are
   *  asked "你想怎么叫我?" — non-admins inherit whatever name admin set
   *  (or the mode fallback if unset). */
  isAdmin(userId: string): boolean
  /** Current global bot self-name override. Null/empty = use fallback.
   *  Read fresh each call: the underlying agentConfig is mutated by /name
   *  outside onboarding, so caching the value would go stale. */
  getBotName(): string | null
  /** Persist the new self-name (null = clear). Disk-first, then in-memory
   *  mutate. Throws on I/O failure; caller catches + replies retry hint. */
  setBotName(name: string | null): Promise<void>
```

- [ ] **Step 4: Add the phase field + skip-word set**

In `src/daemon/onboarding.ts`, near the top (after the existing `NICKNAME_RE` / `AWAIT_TIMEOUT_MS` / `DEDUP_WINDOW_MS` constants), add:

```typescript
const BOT_NAME_SKIP_WORDS = new Set(['跳过', '不用', '没有', 'skip', 'clear', '清除'])

type AwaitPhase = 'awaiting_user_name' | 'awaiting_bot_name'
```

Update the `awaiting` Map declaration inside `makeOnboardingHandler`:

```typescript
  const awaiting = new Map<string, {
    since: number
    triggerText: string
    fromMessage: InboundMsg
    phase: AwaitPhase
  }>()
```

When inserting on first contact, set `phase: 'awaiting_user_name'`.

- [ ] **Step 5: Branch the state machine**

Replace the body of the `handle` function so the existing `stillWaiting` block dispatches on phase. The new structure:

```typescript
    async handle(msg) {
      if (deps.isKnownUser(msg.userId)) return false

      const aw = awaiting.get(msg.chatId)
      const stillWaiting = aw !== undefined && (now() - aw.since) < AWAIT_TIMEOUT_MS

      if (stillWaiting) {
        // Dedup: ilink re-delivery / user double-tap within DEDUP window
        // — compare phase + text so a second-turn echo doesn't get matched
        // against the first-turn trigger.
        if (now() - aw.since < DEDUP_WINDOW_MS && msg.text === aw.triggerText) {
          deps.log('ONBOARDING', `dedup chat=${msg.chatId} phase=${aw.phase} (${now() - aw.since}ms)`)
          return true
        }

        if (aw.phase === 'awaiting_user_name') {
          return await handleUserName(msg, aw)
        }
        if (aw.phase === 'awaiting_bot_name') {
          return await handleBotName(msg, aw)
        }
      }

      // First contact (or stale awaiting state past timeout): greet + clock.
      awaiting.set(msg.chatId, {
        since: now(),
        triggerText: msg.text,
        fromMessage: msg,
        phase: 'awaiting_user_name',
      })
      deps.log('ONBOARDING', `start chat=${msg.chatId} userId=${msg.userId}`)
      await deps.sendMessage(
        msg.chatId,
        `你好呀！我是 ${deps.botName(msg.chatId)}，先问一下我应该怎么称呼你?比如「Nate」「丸子」（中文 / 英文都行）。`,
      )
      return true
    },
```

Then add the two helper closures inside `makeOnboardingHandler` (above the `return { ... }`):

```typescript
  async function handleUserName(
    msg: InboundMsg,
    aw: { since: number; triggerText: string; fromMessage: InboundMsg; phase: AwaitPhase },
  ): Promise<boolean> {
    const proposed = msg.text.trim()
    if (proposed.length < NICKNAME_MIN_LEN) {
      await deps.sendMessage(msg.chatId, '请发一个昵称（不能为空）。')
      return true
    }
    if (proposed.length > NICKNAME_MAX_LEN) {
      await deps.sendMessage(msg.chatId, `昵称太长（最多 ${NICKNAME_MAX_LEN} 字符）。再发一次?`)
      return true
    }
    if (!NICKNAME_RE.test(proposed)) {
      await deps.sendMessage(msg.chatId, '昵称只支持中文 / 字母 / 数字 / 空格 / _ / -。再发一次?')
      return true
    }
    await deps.setUserName(msg.chatId, proposed)
    deps.log('ONBOARDING', `name set chat=${msg.chatId} → "${proposed}"`)

    const askBotName = deps.isAdmin(msg.userId) && !(deps.getBotName()?.trim())
    if (askBotName) {
      awaiting.set(msg.chatId, { ...aw, phase: 'awaiting_bot_name', since: now() })
      await deps.sendMessage(
        msg.chatId,
        `好的 ${proposed}。那你想怎么叫我?比如「小希」「助理」（中文 / 英文都行，回「跳过」用默认）。`,
      )
      return true
    }

    awaiting.delete(msg.chatId)
    await deps.sendMessage(
      msg.chatId,
      `好的 ${proposed}, 刚才你说「${aw.triggerText}」, 回答下：`,
    )
    void deps.dispatchInbound(aw.fromMessage).catch(err => {
      deps.log('ONBOARDING', `echo dispatch failed chat=${msg.chatId}: ${err}`)
    })
    return true
  }

  async function handleBotName(
    msg: InboundMsg,
    aw: { since: number; triggerText: string; fromMessage: InboundMsg; phase: AwaitPhase },
  ): Promise<boolean> {
    // /name (or any other code path) may have set bot_name out of band.
    // Exit awaiting cleanly + redispatch the original trigger.
    if (deps.getBotName()?.trim()) {
      awaiting.delete(msg.chatId)
      await deps.sendMessage(
        msg.chatId,
        `好的。刚才你说「${aw.triggerText}」, 回答下：`,
      )
      void deps.dispatchInbound(aw.fromMessage).catch(err => {
        deps.log('ONBOARDING', `echo dispatch failed chat=${msg.chatId}: ${err}`)
      })
      return true
    }

    const proposed = msg.text.trim()
    // Skip word → clear bot_name (null) + fallback ack.
    if (BOT_NAME_SKIP_WORDS.has(proposed.toLowerCase())) {
      try { await deps.setBotName(null) }
      catch (err) {
        deps.log('ONBOARDING', `setBotName(null) failed chat=${msg.chatId}: ${err}`)
        await deps.sendMessage(msg.chatId, '我没记住，稍后再试 /name')
        return true
      }
      awaiting.delete(msg.chatId)
      await deps.sendMessage(
        msg.chatId,
        `好的，继续用默认「${deps.botName(msg.chatId)}」。刚才你说「${aw.triggerText}」, 回答下：`,
      )
      void deps.dispatchInbound(aw.fromMessage).catch(err => {
        deps.log('ONBOARDING', `echo dispatch failed chat=${msg.chatId}: ${err}`)
      })
      return true
    }

    // Validate + store.
    if (proposed.length < NICKNAME_MIN_LEN) {
      await deps.sendMessage(msg.chatId, '请发一个昵称（不能为空），或回「跳过」用默认。')
      return true
    }
    if (proposed.length > NICKNAME_MAX_LEN) {
      await deps.sendMessage(msg.chatId, `昵称太长（最多 ${NICKNAME_MAX_LEN} 字符）。再发一次?`)
      return true
    }
    if (!NICKNAME_RE.test(proposed)) {
      await deps.sendMessage(msg.chatId, '昵称只支持中文 / 字母 / 数字 / 空格 / _ / -。再发一次?')
      return true
    }
    try { await deps.setBotName(proposed) }
    catch (err) {
      deps.log('ONBOARDING', `setBotName failed chat=${msg.chatId}: ${err}`)
      await deps.sendMessage(msg.chatId, '我没记住，稍后再试 /name')
      return true
    }
    awaiting.delete(msg.chatId)
    deps.log('ONBOARDING', `bot_name set chat=${msg.chatId} → "${proposed}"`)
    await deps.sendMessage(
      msg.chatId,
      `好的。刚才你说「${aw.triggerText}」, 回答下：`,
    )
    void deps.dispatchInbound(aw.fromMessage).catch(err => {
      deps.log('ONBOARDING', `echo dispatch failed chat=${msg.chatId}: ${err}`)
    })
    return true
  }
```

- [ ] **Step 6: Run tests**

```bash
bun run test src/daemon/onboarding.test.ts
```

Expected: all (existing + new) pass.

- [ ] **Step 7: Typecheck**

```bash
bun run typecheck
```

Expected: errors at `pipeline-deps.ts` for the missing onboarding deps (isAdmin/getBotName/setBotName) — wired in Task 7.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/onboarding.ts src/daemon/onboarding.test.ts
git commit -m "feat(onboarding): two-step admin flow — also ask bot_name

After user_name is captured, if isAdmin(userId) && !getBotName(),
transition to awaiting_bot_name and ask 你想怎么叫我?. Skip words
(跳过/不用/没有/skip/clear/清除) store null. Mid-flow getBotName()
flip (e.g. admin runs /name in another turn) cleanly exits the
awaiting state and redispatches the original trigger.

Wiring lands in Task 7 (typecheck still red on pipeline-deps).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — pipeline-deps wiring + final typecheck

**Files:**
- Modify: `src/daemon/wiring/pipeline-deps.ts`

**Goal:** Build the shared `setBotName` closure (disk-first, then in-memory mutate) and pass it to both admin-commands and onboarding. Inject `isAdmin / getBotName / botNameFallback` where each consumer needs it. After this commit, `bun run typecheck` and `bun run test` are both green.

- [ ] **Step 1: Add imports**

In `src/daemon/wiring/pipeline-deps.ts`, find the imports block and add:

```typescript
import { saveAgentConfig } from '../../lib/agent-config'
import { botNameFromModeFallback } from '../bot-name'
```

(The existing `botName` import from Task 3 stays.)

- [ ] **Step 2: Build the shared setBotName closure**

Near the top of `buildPipelineDeps`, after `const fireMilestonesFor = ...` (around line 45), add:

```typescript
  // Disk-first then mutate: if saveAgentConfig throws (EACCES, ENOSPC),
  // the in-memory boot.agentConfig stays untouched so callers can retry.
  // Mutate via index access so existing readers (who hold the same object
  // reference) see the new value on next lookup.
  const setBotName = async (name: string | null): Promise<void> => {
    const next: typeof boot.agentConfig = { ...boot.agentConfig, bot_name: name }
    await saveAgentConfig(stateDir, next)
    boot.agentConfig.bot_name = name
  }
  const getBotName = (): string | null => {
    const v = boot.agentConfig.bot_name
    return v == null ? null : v
  }
```

- [ ] **Step 3: Wire into admin-commands**

In the existing `makeAdminCommands({...})` call, add three new fields:

```typescript
  const adminCommandsHandler = makeAdminCommands({
    stateDir, isAdmin,
    sessionState: ilink.sessionState,
    pollHandle: { /* unchanged */ },
    resolveUserName: (cid) => ilink.resolveUserName(cid),
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
    sharePage: (t, c, o) => ilink.sharePage(t, c, o),
    resolveProject: boot.resolve,
    registry: boot.registry,
    sessionManager: boot.sessionManager,
    sessionStore: boot.sessionStore,
    log,
    startedAt: STARTED_AT_ISO,
    getBotName,
    setBotName,
    botNameFallback: (cid) => botNameFromModeFallback(boot.coordinator.getMode(cid)),
  })
```

- [ ] **Step 4: Wire into onboarding**

In the existing `makeOnboardingHandler({...})` call, add the three new deps:

```typescript
  const onboardingHandler = makeOnboardingHandler({
    isKnownUser: (uid) => ilink.resolveUserName(uid) !== undefined,
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    sendMessage: async (cid, txt) => { await ilink.sendMessage(cid, txt) },
    botName: (cid) => botName(boot.coordinator.getMode(cid), boot.agentConfig),
    dispatchInbound: async (msg) => {
      await refs.pipeline.deref('onboarding echo dispatch')({
        msg,
        receivedAtMs: Date.now(),
        requestId: randomBytes(4).toString('hex'),
      })
    },
    log,
    isAdmin: (uid) => isAdmin(uid),
    getBotName,
    setBotName,
  })
```

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: zero errors. If any remain, they're consumer-side leftovers — fix inline.

- [ ] **Step 6: Run the full test suite**

```bash
bun run test
```

Expected: all green.

- [ ] **Step 7: Smoke (optional, manual)**

If a daemon is reachable locally, start it from source and exercise:

```bash
bun --hot src/daemon/main.ts &
# In another terminal / WeChat:
#  1. Have an admin send "你好" → expect 2-step ask
#  2. /name 小希 → expect ack
#  3. /name → expect "我现在叫 小希"
#  4. /name 跳过 → expect "回到默认「cc」"
```

Skip if daemon-start is blocked by an unrelated config issue — the unit tests cover the behavior.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/wiring/pipeline-deps.ts
git commit -m "feat(wiring): plumb bot_name into onboarding + admin-commands

Shared setBotName closure (disk-first, then in-memory mutate so
all closures over boot.agentConfig see the new value), plus
getBotName / isAdmin / botNameFallback injection. Closes the
typecheck gap left by Tasks 5 + 6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review checklist (run before declaring done)

- [ ] **Spec coverage**: each section in `docs/superpowers/specs/2026-05-25-first-scan-name-ask-design.md` is implemented by at least one task above. (§1 data model → T1+T2; §2 state machine → T6; §2 /name → T5; §3 file changes → T3+T4+T7; §4 error handling → covered in T5+T6 unit tests.)
- [ ] **Placeholder scan**: every step has concrete code or a concrete bash command — no "TODO", "implement later", "similar to X".
- [ ] **Type consistency**: dep field names (`isAdmin`, `getBotName`, `setBotName`, `botNameFallback`, `agentConfig`) used in tests match the signatures defined in the production files.
- [ ] `bun run typecheck` green after Task 7.
- [ ] `bun run test` green after Task 7.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-25-first-scan-name-ask.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
