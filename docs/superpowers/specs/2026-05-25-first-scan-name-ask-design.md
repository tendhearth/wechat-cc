# First-Scan Bot-Name Capture — Design

**Date**: 2026-05-25
**Status**: Design approved; implementation pending (writing-plans next)
**Why this design**: The daemon already asks a fresh chat "我应该怎么称呼你?" via `src/daemon/onboarding.ts` and persists the answer to `conversations.last_user_name` per-chat. The reverse direction is missing — the bot's own self-name is hard-coded to `botNameForMode(mode)` (`claude → cc`, `codex → codex`, parallel → `cc + codex`). The user can't tell her "I'd like to call you 小希". This design adds a single new field (`agent-config.bot_name`), extends the admin's first-time onboarding to a two-step exchange (user name → bot name), and introduces a `/name` admin-only command for later renaming. Non-admins are unaffected — they continue to see whatever the admin chose, and "borrow" the bot under that name.

## Goal

Three concurrent properties:

1. **First successful QR-scan flow asks both directions**: when an admin user sends their first message, the bot greets, asks for the user's preferred name, then asks what the user would like to call her. Both are persisted before the original first message is re-dispatched through the pipeline.

2. **Bot's self-name is one global value, set by admin**: stored in `agent-config.json` as `bot_name`. All chats see the same name. Non-admins cannot change it. When unset, the daemon falls back to the existing `botNameForMode(mode)` derivation, preserving today's behavior.

3. **`/name` command lets admin rename anytime**: `/name 小樱` updates, `/name 跳过` clears (back to fallback), `/name` with no args shows current. Non-admins sending `/name` are silently dropped (matches existing admin-command convention).

**Non-goal**: per-chat bot-name overrides (the user explicitly said "其他人只是暂时借用了她"). Retroactive ask for existing admins whose `bot_name` happens to be null (user said "静默不问"). Validation differences from existing `NICKNAME_RE`. Desktop dashboard editor for `bot_name` (can be added later; out of scope for this spec).

## Architecture

```
admin first message
   │
   ▼
mw-admin (no /name yet → pass)
   │
   ▼
mw-onboarding
   │
   ├─ phase=awaiting_user_name → reply "我该怎么称呼你?"
   ↓ admin: "Nate"
   ├─ store last_user_name; isAdmin(userId) && !getBotName() ?
   │    ├─ yes → phase=awaiting_bot_name → reply "好的 Nate。那你想怎么叫我?"
   │    └─ no  → ack + redispatch (existing path)
   ↓ admin: "小希"
   └─ phase=awaiting_bot_name → setBotName("小希") → ack + redispatch

later: admin sends "/name 小樱"
   │
   ▼
mw-admin (matches NAME_RE) → setBotName("小樱") → reply "好的, 从现在开始我叫 小樱"
```

The data plane has **one new field** (`agent-config.bot_name`), **one new dep triple** on the onboarding handler (`isAdmin / getBotName / setBotName`), **one new command** in `admin-commands.ts`. No new tables, no new modules, no schema migration.

## Components

### 1. `agent-config.bot_name` field

`src/lib/agent-config.ts` adds:

```ts
export interface AgentConfig {
  // ...existing fields...
  /** Admin-chosen self-name displayed in greetings / /whoami / Companion v2.
   *  Null or missing → fall back to botNameForMode(mode). Constrained to
   *  NICKNAME_RE (1-24 chars, CJK/Latin/digits/space/_/-). */
  bot_name?: string | null
}
```

Zod schema: `bot_name: z.string().nullable().optional()`. Existing config files read back with `bot_name === undefined`, which the fallback path treats identically to null. No migration.

### 2. `botName(mode, cfg)` lookup

`src/daemon/bot-name.ts` is refactored. The current `botNameForMode(mode)` is renamed `botNameFromModeFallback(mode)` (unchanged logic). A new top-level export:

```ts
export function botName(mode: Mode, cfg: Pick<AgentConfig, 'bot_name'>): string {
  const override = cfg.bot_name?.trim()
  return override || botNameFromModeFallback(mode)
}
```

All callers thread the `agentConfig` reference through (no per-call file read; same in-memory object whose `bot_name` field is mutated by `setBotName`).

Callers updated:
- `src/daemon/onboarding.ts` — `deps.botName(chatId)` closure built in `pipeline-deps.ts` calls `botName(mode, agentConfig)`
- `src/daemon/mode-commands.ts:292` — `/whoami` output
- `src/daemon/wiring/side-effects.ts:51` — replaces the hard-coded "嗨，我是 Claude" (bug fix included in passing)
- `src/daemon/wiring/pipeline-deps.ts:85` — the central closure

### 3. Onboarding handler extension

`src/daemon/onboarding.ts`:

```ts
export interface OnboardingDeps {
  // ...existing fields...
  isAdmin(userId: string): boolean
  getBotName(): string | null
  setBotName(name: string | null): Promise<void>  // persists to disk + mutates agentConfig
}

// awaiting Map entry gains a phase field
{ since, triggerText, fromMessage, phase: 'awaiting_user_name' | 'awaiting_bot_name' }
```

State machine:

| Current state | Input | Next state | Side effects |
|---|---|---|---|
| (no awaiting) unknown user inbound | any | `awaiting_user_name` | reply "你好呀！我是 \<botName\>，我该怎么称呼你?" |
| `awaiting_user_name` | valid name | (fresh admin + no bot_name) → `awaiting_bot_name`; otherwise none (clear) | setUserName; if admin path: reply "好的 \<name\>。那你想怎么叫我?"; else: ack + redispatch (existing) |
| `awaiting_user_name` | invalid | `awaiting_user_name` (retry) | reply with reason |
| `awaiting_bot_name` | `getBotName() != null` (set elsewhere mid-flow) | (clear) | ack + redispatch |
| `awaiting_bot_name` | skip word (`跳过` / `不用` / `没有` / `skip`) | (clear) | bot_name unchanged (still null); ack "好的，那继续用「\<fallback\>」"; redispatch |
| `awaiting_bot_name` | valid name | (clear) | setBotName; ack + redispatch |
| `awaiting_bot_name` | invalid | `awaiting_bot_name` (retry) | reply with reason |

Validation reuses existing `NICKNAME_RE` and length bounds.

Dedup window (`DEDUP_WINDOW_MS = 1500ms`) is checked against `phase + text` rather than text alone, so a quick double-tap reply in `awaiting_bot_name` doesn't accidentally race-match the `awaiting_user_name` trigger.

Timeout (`AWAIT_TIMEOUT_MS = 30 min`) unchanged. Expiry treats the chat as "back to fresh"; next message restarts at `awaiting_user_name`. For admins past timeout, this is non-disruptive — they're already known users by then (last_user_name is set), so onboarding skips entirely and they fall to the old admin path. The bot_name stays null until they `/name` it.

### 4. `/name` admin command

New regex + handler in `src/daemon/admin-commands.ts`:

```ts
const NAME_RE = /^\s*\/name(?:\s+(.+?))?\s*$/
```

Handler logic (after the existing admin-check gate consumes non-admins silently):

| Capture group 1 | Action | Reply |
|---|---|---|
| undefined (bare `/name`) | none | current name (`agentConfig.bot_name` or fallback) — "我现在叫 \<name\>" |
| valid name | setBotName(name) | "好的，从现在开始我叫 \<name\>" |
| skip word | setBotName(null) | "好的，回到默认「\<fallback\>」" |
| invalid (empty after trim, too long, illegal chars) | none | "「\<input\>」不行：只支持中文/字母/数字/空格/\_/- (1-24 字)" |

`setBotName` is shared with onboarding: writes `agentConfig.bot_name` and calls `saveAgentConfig(stateDir, agentConfig)` — **disk first, then mutate, then reply**. Disk failure → log + reply "我没记住，稍后再试 `/name`", in-memory unchanged.

### 5. Wiring

`src/daemon/wiring/pipeline-deps.ts`:

- Construct one `setBotName` closure used by both onboarding and admin-commands:
  ```ts
  const setBotName = async (name: string | null) => {
    const next = { ...agentConfig, bot_name: name }
    await saveAgentConfig(stateDir, next)   // throws → caller handles
    agentConfig.bot_name = name              // mutate in place
  }
  ```
- `getBotName: () => agentConfig.bot_name ?? null`
- `isAdmin`: reuse the existing `access.ts::isAdmin(userId)` (already imported in `pipeline-deps.ts`; shared with admin-commands' wiring). Onboarding passes `msg.userId` (type-correct); admin-commands passes `msg.chatId` (inherited inconsistency, runtime-equivalent in DMs — out of scope to fix here)
- The existing `botName` closure changes from `botNameForMode(mode)` to `botName(mode, agentConfig)`

`src/daemon/bootstrap/index.ts`: `configuredAgent` (the loaded `AgentConfig`) is already in scope at wiring construction; pass it through into the new closures by reference so mutations are visible everywhere.

## Data Flow

### Path A — Fresh admin (new binding, first message)

```
[admin: "你好"]
   inbound → mw-trace/identity/access ✓ → mw-admin (no match) → mw-mode (no match)
   → mw-onboarding: unknown user → awaiting_user_name → reply
[bot: "你好呀！我是 cc，先问一下我应该怎么称呼你?"]

[admin: "Nate"]
   inbound → mw-onboarding: awaiting_user_name → setUserName("Nate")
   isAdmin(userId)=true, getBotName()=null → awaiting_bot_name → reply
[bot: "好的 Nate。那你想怎么叫我?"]

[admin: "小希"]
   inbound → mw-onboarding: awaiting_bot_name → setBotName("小希")
   ack + redispatch fromMessage("你好")
[bot: "好的。刚才你说「你好」, 回答下："]
   (re-dispatched "你好" flows through normal pipeline → reaches Claude → answers)
```

### Path B — Fresh non-admin

```
[guest: "在吗"]
   inbound → mw-onboarding: unknown → awaiting_user_name → reply
[bot: "你好呀！我是 cc，先问一下我应该怎么称呼你?"]

[guest: "Alex"]
   inbound → mw-onboarding: awaiting_user_name → setUserName("Alex")
   isAdmin=false → ack + redispatch (no bot_name ask)
[bot: "好的 Alex, 刚才你说「在吗」, 回答下："]
```

If admin already set bot_name to "小希" before this guest arrived, the greeting reads "我是 小希" instead of "我是 cc".

### Path C — Old admin (already has user_name, bot_name null)

```
[admin: "weather today"]
   inbound → mw-onboarding: isKnownUser=true → pass (no awaiting state, no compare against bot_name)
   → mw-dispatch → Claude
```

Bot greets using fallback name everywhere until admin runs `/name`.

### Path D — `/name` rename

```
[admin: "/name 小樱"]
   inbound → mw-admin: NAME_RE matches, isAdmin=true → setBotName("小樱")
   reply
[bot: "好的，从现在开始我叫 小樱"]
```

Next botName lookup anywhere in the daemon returns "小樱" — same object reference.

### Path E — `/name` from non-admin

```
[guest: "/name 偷偷改"]
   inbound → mw-admin: NAME_RE matches, isAdmin=false → silently consumed + log
   (no reply; matches existing /reset, 清理, /hearth convention)
```

### Path F — `/name` mid-onboarding (admin races their own state machine)

```
[admin in awaiting_bot_name state]
[admin: "/name 小希"]
   inbound → mw-admin runs first → NAME_RE matches → setBotName → reply
   (mw-onboarding never sees this message)
[admin sends anything next, e.g. "?"]
   inbound → mw-onboarding: awaiting_bot_name state, but getBotName() now non-null
   → clear awaiting + ack + redispatch original fromMessage
```

## Error handling

| Failure | Handling |
|---|---|
| `saveAgentConfig` throws (disk full, EACCES, etc.) | Caught in `setBotName` wrapper; `agentConfig.bot_name` NOT mutated; caller (onboarding or `/name`) replies "我没记住，稍后再试 `/name`"; logs `SETBOTNAME_FAIL` with err |
| `/name` invalid input | Same validation pattern as onboarding's name-step replies; doesn't transition state, doesn't touch disk |
| Awaiting state corrupted across daemon restart | Existing behavior — in-memory map clears, admin re-sends, starts at `awaiting_user_name`. If their `last_user_name` is already persisted (rare race), they go through Path C instead |
| `access.admins` is undefined or empty when `isAdmin()` runs | Returns false; admin path never triggers. Pre-onboarding access gate (mw-access) is the primary defense; isAdmin here is purely for branching the bot_name ask, not for security |
| Admin double-taps name reply within DEDUP_WINDOW_MS | Caught by phase-aware dedup check; second tap silently dropped, log `ONBOARDING dedup phase=awaiting_bot_name` |

## Testing

### Unit tests

`src/daemon/bot-name.test.ts` — extends:
- `botName(mode, { bot_name: '小希' })` returns "小希" regardless of mode
- `botName(mode, { bot_name: null })`, `{ bot_name: undefined }`, `{ bot_name: '' }`, `{ bot_name: '   ' }` all fall back to `botNameFromModeFallback(mode)`
- `botName(mode, { bot_name: '  小希  ' })` returns "小希" (trimmed)

`src/daemon/onboarding.test.ts` — extends:
- Fresh admin: two-step flow completes; both `setUserName` and `setBotName` are called exactly once with the right args; final ack quotes original trigger; `dispatchInbound` called with `fromMessage`
- Fresh non-admin: only `setUserName` called; `setBotName` not called; bot_name ask never appears
- Skip word in `awaiting_bot_name`: `setBotName` called with `null`; ack uses fallback name
- Invalid name in `awaiting_bot_name`: retry message sent; state preserved; no setBotName call
- DEDUP_WINDOW_MS: rapid duplicate in `awaiting_bot_name` consumed silently
- `/name` mid-flow (simulate `getBotName()` flipping non-null mid-awaiting): on next inbound, ack + redispatch + clear awaiting; no spurious validation

`src/daemon/admin-commands.test.ts` — new (or extend if exists):
- `/name 小希` from admin: setBotName called with "小希"; reply matches expected
- `/name` bare from admin: reply contains current name (override path)
- `/name` bare from admin with null bot_name: reply contains fallback name
- `/name 跳过` from admin: setBotName called with null
- `/name 小希` from non-admin: silently consumed; setBotName NOT called
- `/name <invalid>` from admin: validation reply; setBotName NOT called

### Integration

No new e2e test. The existing onboarding e2e plus the new unit coverage on the state machine give enough confidence. If we later add a desktop dashboard "Bot name" field, that flow gets its own playwright test then.

### `bun run typecheck`

Required after the `AgentConfig` interface change — the `Pick<AgentConfig, 'bot_name'>` parameter type on `botName(mode, cfg)` should compile cleanly. Per the project's CI convention (per `feedback_typecheck_after_interface_change.md` memory), vitest alone won't catch missing required-field consumers.

## Open questions

None. All design decisions resolved during brainstorming:

- Scope: bot_name global, set by admin only — confirmed
- UX: sequential (user name → bot name) — confirmed
- Old admins: silent, `/name` only — confirmed
- Storage: `agent-config.json` field, in-memory mutate + disk save — chosen for symmetry with rest of admin-editable config

## Files touched (summary)

| File | Change |
|---|---|
| `src/lib/agent-config.ts` | Add `bot_name?: string \| null` to interface + zod schema |
| `src/daemon/bot-name.ts` | Rename `botNameForMode` → `botNameFromModeFallback`; add `botName(mode, cfg)` |
| `src/daemon/onboarding.ts` | Add phase field, awaiting_bot_name path, new deps |
| `src/daemon/admin-commands.ts` | Add `/name` regex + handler |
| `src/daemon/wiring/pipeline-deps.ts` | Wire new closures (isAdmin / getBotName / setBotName); thread agentConfig into botName closure |
| `src/daemon/wiring/side-effects.ts` | Replace hard-coded "嗨，我是 Claude" with botName() — incidental bug fix |
| `src/daemon/mode-commands.ts` | `botNameForMode(cur)` → `botName(cur, agentConfig)` |
| `src/daemon/bot-name.test.ts` | New cases per Testing section |
| `src/daemon/onboarding.test.ts` | New cases per Testing section |
| `src/daemon/admin-commands.test.ts` | New cases (or new file if absent) |
