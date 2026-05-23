# User-Tier Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3-tier (admin/trusted/guest) capability gating on inbound, with per-chat session isolation, so a guest user who can DM the bot can't get the agent to run Bash/Edit/etc. — while admin keeps full access and trusted gets everything except destructive ops.

**Architecture:** Daemon defines a single `TierProfile` (a set of `ToolKind` permissions) as source of truth. Each provider implements a pure `tierProfileToSdkOpts(tp)` function that translates the profile into its SDK options. Sessions are keyed by `(alias, provider, chatId)` so tier enforcement holds across cached sessions. Permission relay routes to a configured admin chat (not the requesting chat).

**Tech Stack:** TypeScript / Bun / vitest. Uses `@anthropic-ai/claude-agent-sdk` (Claude) and `@openai/codex-sdk` (Codex). SQLite via `bun:sqlite` for schema migration.

**Source of truth for design decisions:** `docs/superpowers/specs/2026-05-22-user-tier-permissions-design.md`. If a step here disagrees with the spec, the spec wins — flag the conflict and ask before resolving.

---

## File Structure

**New files:**
- `src/core/user-tier.ts` — `UserTier`, `ToolKind`, `TierProfile`, `TIER_PROFILES`, `resolveTier`, `classifyToolUse`
- `src/core/user-tier.test.ts` — unit tests for the above

**Modified files (production code):**
- `src/lib/access.ts` — `Access` interface gains `trusted?: string[]`; reader keeps caching; `setSessionInvalidator` hook
- `src/core/agent-provider.ts` — `AgentProvider.spawn` signature gains `tierProfile`
- `src/core/claude-agent-provider.ts` — `tierProfileToSdkOpts(tp)` pure helper; `spawn` threads it through
- `src/core/codex-agent-provider.ts` — `tierProfileToSdkOpts(tp)` pure helper; `spawn` threads it through
- `src/core/session-store.ts` — primary key now `(alias, provider, chat_id)`; queries take `chatId`
- `src/core/session-manager.ts` — `acquire`/`release`/`isInFlight`/`shutdown` switch to options-object signatures with `chatId` + `tierProfile`
- `src/core/conversation-coordinator.ts` — dispatch threads `chatId` + computed tierProfile to acquire
- `src/core/permission-relay.ts` — `makeCanUseTool` takes `tierProfile` + `classifyToolUse`; `effectivePolicy()` helper
- `src/daemon/bootstrap/index.ts` — `resolveAdminChatId`; permission-relay's destination chat changes; `sdkOptionsForProject` signature grows
- `src/daemon/wiring/tick-bodies.ts` — push/introspect tick read companion `default_chat_id`, compute tierProfile, pass to acquire
- `src/daemon/wiring/pipeline-deps.ts` — no direct change expected; verify dispatch threads chatId
- `src/lib/db.ts` — migration v10 adds `chat_id` column + legacy cleanup
- `eval/companion/engine/daemon-shim.ts` — write trajectory chatId into `access.admins`
- `README.md` — Access control section expanded; Known limitations entry added

**Tests modified:**
- `src/core/session-store.test.ts` — adopt new `chatId` parameter
- `src/core/session-manager.test.ts` — adopt new options-object signature
- `src/core/claude-agent-provider.test.ts` (if exists) / `codex-agent-provider.test.ts` — spawn signature
- `src/core/permission-relay.test.ts` — tier-aware decisions
- `src/core/conversation-coordinator.test.ts` — chatId routing

---

## Task 1: `Access` interface gains optional `trusted` field

**Files:**
- Modify: `src/lib/access.ts`
- Modify: `src/lib/access.test.ts` (if exists)

Smallest possible foundation step. The reader already returns a structured `Access` object; we add a field and parse it.

- [ ] **Step 1: Write failing test**

Open `src/lib/access.test.ts`. If it doesn't exist, create it with the standard vitest pattern:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Access.trusted', () => {
  it('parses trusted array when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'access-test-'))
    process.env.WECHAT_STATE_DIR = dir
    writeFileSync(join(dir, 'access.json'), JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['u1', 'u2', 'u3'],
      admins: ['u1'],
      trusted: ['u2'],
    }))
    try {
      // Use a fresh import so the module-level cache doesn't return stale data
      delete require.cache[require.resolve('./access')]
      const { readAccessForTest } = require('./access') as { readAccessForTest: () => unknown }
      const a = readAccessForTest() as { trusted?: string[] }
      expect(a.trusted).toEqual(['u2'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      delete process.env.WECHAT_STATE_DIR
    }
  })

  it('omitted trusted parses as undefined (not empty array)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'access-test-'))
    process.env.WECHAT_STATE_DIR = dir
    writeFileSync(join(dir, 'access.json'), JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['u1'],
      admins: ['u1'],
    }))
    try {
      delete require.cache[require.resolve('./access')]
      const { readAccessForTest } = require('./access') as { readAccessForTest: () => unknown }
      const a = readAccessForTest() as { trusted?: string[] }
      expect(a.trusted).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      delete process.env.WECHAT_STATE_DIR
    }
  })
})
```

Note: if `access.ts` doesn't currently export a test seam, the test imports the module's `loadAccess` or similar. Adjust the import to the existing public symbol. The goal: prove the new `trusted` field round-trips.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun --bun vitest run src/lib/access.test.ts`
Expected: FAIL — `trusted` undefined where it should be `['u2']`.

- [ ] **Step 3: Add `trusted` to the `Access` interface and reader**

In `src/lib/access.ts`:

```ts
export interface Access {
  dmPolicy: 'allowlist' | 'disabled'
  allowFrom: string[]
  admins?: string[]
  /**
   * Trusted users get every capability admin has EXCEPT destructive
   * operations (rm / git reset --hard / memory_delete / etc.) — those
   * trigger a permission prompt to the admin chat. Optional field;
   * missing or empty means no users have trusted tier and the operator
   * must explicitly opt people in.
   */
  trusted?: string[]
}
```

In `readAccessFile()`, parse the new field:

```ts
function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'allowlist',
      allowFrom: parsed.allowFrom ?? [],
      ...(parsed.admins ? { admins: parsed.admins } : {}),
      ...(parsed.trusted ? { trusted: parsed.trusted } : {}),
    }
  } catch (err) {
    // existing error path unchanged
    ...
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun --bun vitest run src/lib/access.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/access.ts src/lib/access.test.ts
git commit -m "feat(access): add optional trusted[] field to Access

Backwards-compatible — missing field stays undefined. Reader parses it
through. No callers consume it yet; next task introduces user-tier.ts
which uses this field to assign 'trusted' tier."
```

---

## Task 2: `user-tier.ts` — types + `TIER_PROFILES` + `resolveTier`

**Files:**
- Create: `src/core/user-tier.ts`
- Create: `src/core/user-tier.test.ts`

Foundational module. Pure types and lookup; no I/O.

- [ ] **Step 1: Write failing test**

Create `src/core/user-tier.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveTier, TIER_PROFILES, type UserTier, type ToolKind } from './user-tier'
import type { Access } from '../lib/access'

const baseAccess: Access = {
  dmPolicy: 'allowlist',
  allowFrom: ['admin1', 'trusted1', 'guest1'],
  admins: ['admin1'],
  trusted: ['trusted1'],
}

describe('resolveTier', () => {
  it('returns admin when chatId is in admins', () => {
    expect(resolveTier('admin1', baseAccess)).toBe('admin')
  })

  it('returns trusted when chatId is in trusted but not admins', () => {
    expect(resolveTier('trusted1', baseAccess)).toBe('trusted')
  })

  it('returns guest for allowed-but-unclassified chats', () => {
    expect(resolveTier('guest1', baseAccess)).toBe('guest')
  })

  it('returns guest when admins is empty', () => {
    expect(resolveTier('any', { ...baseAccess, admins: [] })).toBe('guest')
  })

  it('admin takes precedence over trusted if both lists include the chatId', () => {
    expect(resolveTier('dupe', {
      ...baseAccess, admins: ['dupe'], trusted: ['dupe'],
    })).toBe('admin')
  })
})

describe('TIER_PROFILES', () => {
  const ALL_KINDS: ToolKind[] = [
    'reply', 'share_page', 'memory_read', 'memory_write', 'memory_delete',
    'observations_read', 'observations_write',
    'fs_read', 'fs_write', 'shell', 'shell_destructive', 'network', 'subagent',
  ]

  for (const tier of ['admin', 'trusted', 'guest'] as UserTier[]) {
    it(`tier=${tier}: allow ∪ relay ∪ deny covers every ToolKind exactly once`, () => {
      const p = TIER_PROFILES[tier]
      const seen = new Set<ToolKind>()
      for (const k of p.allow) seen.add(k)
      for (const k of p.relay) {
        expect(p.allow.has(k)).toBe(false)
        seen.add(k)
      }
      for (const k of p.deny) {
        expect(p.allow.has(k)).toBe(false)
        expect(p.relay.has(k)).toBe(false)
        seen.add(k)
      }
      for (const k of ALL_KINDS) {
        expect(seen.has(k)).toBe(true)
      }
    })
  }

  it('admin allows everything', () => {
    expect(TIER_PROFILES.admin.relay.size).toBe(0)
    expect(TIER_PROFILES.admin.deny.size).toBe(0)
  })

  it('trusted relays shell_destructive and memory_delete', () => {
    expect(TIER_PROFILES.trusted.relay.has('shell_destructive')).toBe(true)
    expect(TIER_PROFILES.trusted.relay.has('memory_delete')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.size).toBe(0)
  })

  it('guest allows only reply/share_page/memory_read/observations_read', () => {
    expect(TIER_PROFILES.guest.allow.has('reply')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('share_page')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('memory_read')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('observations_read')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('shell')).toBe(false)
    expect(TIER_PROFILES.guest.allow.has('fs_write')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/user-tier.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `user-tier.ts`**

Create `src/core/user-tier.ts`:

```ts
/**
 * User-tier policy — single source of truth for "what can this chat do".
 *
 * Three tiers, derived from access.json:
 *   - admin (access.admins): full access
 *   - trusted (access.trusted): full except destructive ops (relay to admin)
 *   - guest (allowed but not admin/trusted): reply + read only
 *
 * The TierProfile is daemon-defined; each provider's
 * `tierProfileToSdkOpts(profile)` is the only place that knows how to
 * translate the profile into its own SDK's permission knobs.
 *
 * See docs/superpowers/specs/2026-05-22-user-tier-permissions-design.md.
 */
import type { Access } from '../lib/access'

export type UserTier = 'admin' | 'trusted' | 'guest'

export type ToolKind =
  | 'reply'
  | 'share_page'
  | 'memory_read'
  | 'memory_write'
  | 'memory_delete'
  | 'observations_read'
  | 'observations_write'
  | 'fs_read'
  | 'fs_write'
  | 'shell'
  | 'shell_destructive'  // virtual — set by classifyToolUse when Bash input matches a destructive pattern
  | 'network'
  | 'subagent'

const ALL_KINDS: ReadonlySet<ToolKind> = new Set([
  'reply', 'share_page', 'memory_read', 'memory_write', 'memory_delete',
  'observations_read', 'observations_write',
  'fs_read', 'fs_write', 'shell', 'shell_destructive', 'network', 'subagent',
])

export interface TierProfile {
  /** Tools directly allowed without further check. */
  allow: ReadonlySet<ToolKind>
  /** Tools that require a permission prompt to the admin chat. */
  relay: ReadonlySet<ToolKind>
  /** Tools the SDK is told (or directed) to refuse outright. */
  deny: ReadonlySet<ToolKind>
}

function difference(a: ReadonlySet<ToolKind>, b: ReadonlySet<ToolKind>): Set<ToolKind> {
  const out = new Set<ToolKind>()
  for (const k of a) if (!b.has(k)) out.add(k)
  return out
}

const TRUSTED_RELAY = new Set<ToolKind>(['shell_destructive', 'memory_delete'])

const GUEST_ALLOW = new Set<ToolKind>(['reply', 'share_page', 'memory_read', 'observations_read'])

export const TIER_PROFILES: Record<UserTier, TierProfile> = {
  admin: {
    allow: ALL_KINDS,
    relay: new Set(),
    deny: new Set(),
  },
  trusted: {
    allow: difference(ALL_KINDS, TRUSTED_RELAY),
    relay: TRUSTED_RELAY,
    deny: new Set(),
  },
  guest: {
    allow: GUEST_ALLOW,
    relay: new Set(),
    deny: difference(ALL_KINDS, GUEST_ALLOW),
  },
}

/**
 * Resolve a chatId's tier from access.json snapshot. Admin > trusted > guest.
 * A chatId not in any list still maps to guest — the assumption is the
 * upstream allowlist gate has already rejected outright-blocked users.
 */
export function resolveTier(chatId: string, access: Access): UserTier {
  if (access.admins?.includes(chatId)) return 'admin'
  if (access.trusted?.includes(chatId)) return 'trusted'
  return 'guest'
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/core/user-tier.test.ts`
Expected: PASS, all assertions.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/user-tier.ts src/core/user-tier.test.ts
git commit -m "feat(user-tier): types + TIER_PROFILES + resolveTier

Daemon-level source of truth for what each tier can do. Defines the
ToolKind taxonomy that providers will map to their own SDK options in
later tasks. No callers yet."
```

---

## Task 3: `classifyToolUse` + destructive Bash detection

**Files:**
- Modify: `src/core/user-tier.ts`
- Modify: `src/core/user-tier.test.ts`

Pure function that maps `(toolName, input)` to a `ToolKind`. The `shell_destructive` virtual kind requires inspecting `input.command`. This is best-effort regex matching.

- [ ] **Step 1: Write failing test**

Append to `src/core/user-tier.test.ts`:

```ts
import { classifyToolUse } from './user-tier'

describe('classifyToolUse', () => {
  it('reply → reply', () => {
    expect(classifyToolUse('mcp__wechat__reply', {})).toBe('reply')
  })

  it('share_page → share_page', () => {
    expect(classifyToolUse('mcp__wechat__share_page', {})).toBe('share_page')
  })

  it('memory_list / memory_read → memory_read', () => {
    expect(classifyToolUse('mcp__wechat__memory_list', {})).toBe('memory_read')
    expect(classifyToolUse('mcp__wechat__memory_read', {})).toBe('memory_read')
  })

  it('memory_write / memory_edit → memory_write', () => {
    expect(classifyToolUse('mcp__wechat__memory_write', {})).toBe('memory_write')
    expect(classifyToolUse('mcp__wechat__memory_edit', {})).toBe('memory_write')
  })

  it('memory_delete → memory_delete', () => {
    expect(classifyToolUse('mcp__wechat__memory_delete', {})).toBe('memory_delete')
  })

  it('observations_list / observations_read → observations_read', () => {
    expect(classifyToolUse('mcp__wechat__observations_list', {})).toBe('observations_read')
    expect(classifyToolUse('mcp__wechat__observations_read', {})).toBe('observations_read')
  })

  it('observations_write / observations_archive → observations_write', () => {
    expect(classifyToolUse('mcp__wechat__observations_write', {})).toBe('observations_write')
    expect(classifyToolUse('mcp__wechat__observations_archive', {})).toBe('observations_write')
  })

  it('Read / Glob / Grep / LS → fs_read', () => {
    expect(classifyToolUse('Read', {})).toBe('fs_read')
    expect(classifyToolUse('Glob', {})).toBe('fs_read')
    expect(classifyToolUse('Grep', {})).toBe('fs_read')
    expect(classifyToolUse('LS', {})).toBe('fs_read')
  })

  it('Write / Edit / NotebookEdit → fs_write', () => {
    expect(classifyToolUse('Write', {})).toBe('fs_write')
    expect(classifyToolUse('Edit', {})).toBe('fs_write')
    expect(classifyToolUse('NotebookEdit', {})).toBe('fs_write')
  })

  it('Bash with non-destructive command → shell', () => {
    expect(classifyToolUse('Bash', { command: 'ls -la' })).toBe('shell')
    expect(classifyToolUse('Bash', { command: 'git status' })).toBe('shell')
    expect(classifyToolUse('Bash', { command: 'echo hello' })).toBe('shell')
  })

  it('Bash with destructive patterns → shell_destructive', () => {
    expect(classifyToolUse('Bash', { command: 'rm -rf /tmp/foo' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'rm file.txt' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git reset --hard HEAD~1' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git push origin main --force' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git push --force-with-lease' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git branch -D feature' })).toBe('shell_destructive')
  })

  it('Bash with command that mentions rm in a string → shell (not destructive)', () => {
    // Best-effort regex; we accept some false negatives but try not to over-fire
    expect(classifyToolUse('Bash', { command: 'echo "rm is dangerous"' })).toBe('shell')
  })

  it('KillShell → shell', () => {
    expect(classifyToolUse('KillShell', { shell_id: 'x' })).toBe('shell')
  })

  it('WebFetch / WebSearch → network', () => {
    expect(classifyToolUse('WebFetch', {})).toBe('network')
    expect(classifyToolUse('WebSearch', {})).toBe('network')
  })

  it('Task → subagent', () => {
    expect(classifyToolUse('Task', {})).toBe('subagent')
  })

  it('unknown tool defaults to subagent (treated as untrusted)', () => {
    // Safe default — an unrecognised tool is treated as the most-restricted
    // class so a new tool added without classification updates doesn't
    // accidentally bypass tier checks.
    expect(classifyToolUse('SomeNewToolNobodyDocumented', {})).toBe('subagent')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/user-tier.test.ts -t classifyToolUse`
Expected: FAIL — `classifyToolUse` undefined.

- [ ] **Step 3: Implement `classifyToolUse`**

Append to `src/core/user-tier.ts`:

```ts
/**
 * Regex set for destructive Bash commands. Best-effort — a determined
 * adversary can `eval` or obfuscate. The intent is preventing
 * accidents and surface-level prompt injection, not stopping malice.
 *
 * Pattern guidelines:
 *   - Anchor to word boundaries so we don't over-fire on "rm" inside a path
 *     ("/var/farm/...") or git command embedded in a string.
 *   - `\s+` between args so `rm  -rf` (multiple spaces) still matches.
 *
 * Extend by adding patterns; document the rationale next to each.
 */
const DESTRUCTIVE_BASH_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|[;&|`$()\s])rm(?:\s+-[a-zA-Z]*)*\s+/,     // rm, rm -rf, rm -f, etc.
  /(?:^|[;&|`$()\s])git\s+reset\s+--hard/,        // git reset --hard
  /(?:^|[;&|`$()\s])git\s+push\b[^|]*--force/,    // git push --force / --force-with-lease
  /(?:^|[;&|`$()\s])git\s+branch\s+-D\b/,         // git branch -D
  /(?:^|[;&|`$()\s])dd\s+(?:if|of)=/,             // dd if=… of=…
]

function isDestructiveBash(command: string): boolean {
  return DESTRUCTIVE_BASH_PATTERNS.some(re => re.test(command))
}

/**
 * Map (toolName, input) to a daemon ToolKind. Unknown tools collapse to
 * 'subagent' (the most-restricted bucket) so adding a new tool without
 * a classifier update fails safe.
 */
export function classifyToolUse(toolName: string, input: Record<string, unknown>): ToolKind {
  // MCP-prefixed wechat tools
  if (toolName.startsWith('mcp__wechat__')) {
    const sub = toolName.slice('mcp__wechat__'.length)
    if (sub === 'reply') return 'reply'
    if (sub === 'share_page') return 'share_page'
    if (sub === 'memory_list' || sub === 'memory_read') return 'memory_read'
    if (sub === 'memory_write' || sub === 'memory_edit') return 'memory_write'
    if (sub === 'memory_delete') return 'memory_delete'
    if (sub === 'observations_list' || sub === 'observations_read') return 'observations_read'
    if (sub === 'observations_write' || sub === 'observations_archive') return 'observations_write'
    // Other wechat tools: classify as fs_read (safest non-reply default
    // for new wechat MCP tools — they tend to be query-like).
    return 'fs_read'
  }

  // Built-in Claude Code tools
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep' || toolName === 'LS') return 'fs_read'
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') return 'fs_write'
  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    return isDestructiveBash(cmd) ? 'shell_destructive' : 'shell'
  }
  if (toolName === 'KillShell') return 'shell'
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'network'
  if (toolName === 'Task') return 'subagent'

  // Unknown — fail safe. Subagent is in `guest.deny`, so guests can't
  // call a tool we haven't classified yet.
  return 'subagent'
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/core/user-tier.test.ts`
Expected: PASS, every classifier case.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/user-tier.ts src/core/user-tier.test.ts
git commit -m "feat(user-tier): classifyToolUse + destructive Bash patterns

Maps (toolName, input) → ToolKind so the policy combiner in later tasks
sees a single, daemon-defined classification regardless of which
provider is running. Unknown tools collapse to 'subagent' (in guest's
deny set) — fails safe."
```

---

## Task 4: Claude `tierProfileToSdkOpts` pure function

**Files:**
- Modify: `src/core/claude-agent-provider.ts`
- Create: `src/core/claude-agent-provider.test.ts` (if not present)

Pure helper, no SDK call. Translates a `TierProfile` into the subset of `Options` that vary by tier: `permissionMode` + `disallowedTools` + (Claude-only) `canUseTool` placeholder.

Note: `canUseTool` actual closure construction lives in `permission-relay.ts` (Task 12). This helper sets `permissionMode` and `disallowedTools` only; the `canUseTool` field stays unset here and is added by the caller.

- [ ] **Step 1: Write failing test**

Create or extend `src/core/claude-agent-provider.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { tierProfileToClaudeSdkOpts } from './claude-agent-provider'
import { TIER_PROFILES } from './user-tier'

describe('tierProfileToClaudeSdkOpts', () => {
  it('admin → permissionMode=bypassPermissions, no disallowedTools', () => {
    const out = tierProfileToClaudeSdkOpts(TIER_PROFILES.admin)
    expect(out.permissionMode).toBe('bypassPermissions')
    expect(out.disallowedTools).toBeUndefined()
  })

  it('trusted → permissionMode=default, no disallowedTools (canUseTool relays destructive)', () => {
    const out = tierProfileToClaudeSdkOpts(TIER_PROFILES.trusted)
    expect(out.permissionMode).toBe('default')
    // shell_destructive is relayed via canUseTool, not via disallowedTools —
    // because disallowedTools blocks at the tool name level and we'd lose
    // the ability to allow non-destructive Bash.
    expect(out.disallowedTools).toBeUndefined()
  })

  it('guest → permissionMode=default + disallowedTools blocks everything outside allow set', () => {
    const out = tierProfileToClaudeSdkOpts(TIER_PROFILES.guest)
    expect(out.permissionMode).toBe('default')
    expect(out.disallowedTools).toBeDefined()
    // Confirm a non-allowed tool is in the list
    expect(out.disallowedTools).toContain('Bash')
    expect(out.disallowedTools).toContain('Write')
    expect(out.disallowedTools).toContain('Edit')
    expect(out.disallowedTools).toContain('WebFetch')
    expect(out.disallowedTools).toContain('Task')
    // Confirm an allowed tool is NOT in the list
    expect(out.disallowedTools).not.toContain('Read')          // fs_read still in deny for guest
    // Wait — guest.allow does NOT include fs_read. So Read SHOULD be in disallowed.
    // Re-read the spec: guest can only reply/share_page/memory_read/observations_read.
    // Read (built-in) is fs_read, which is in guest.deny. So Read IS in disallowedTools.
    // Re-correcting:
  })

  it('guest disallowedTools is exactly the built-in tools mapped to non-allow ToolKinds', () => {
    const out = tierProfileToClaudeSdkOpts(TIER_PROFILES.guest)
    const set = new Set(out.disallowedTools ?? [])
    // Built-in tools whose ToolKind is in guest.deny
    expect(set.has('Bash')).toBe(true)
    expect(set.has('KillShell')).toBe(true)
    expect(set.has('Write')).toBe(true)
    expect(set.has('Edit')).toBe(true)
    expect(set.has('NotebookEdit')).toBe(true)
    expect(set.has('Read')).toBe(true)
    expect(set.has('Glob')).toBe(true)
    expect(set.has('Grep')).toBe(true)
    expect(set.has('LS')).toBe(true)
    expect(set.has('WebFetch')).toBe(true)
    expect(set.has('WebSearch')).toBe(true)
    expect(set.has('Task')).toBe(true)
    // MCP tools are NOT included in disallowedTools — they're filtered by
    // canUseTool instead (because the wechat MCP server exposes them
    // dynamically; we can't pre-enumerate the names here without
    // double-maintaining a list).
  })
})
```

Fix the inline mistake in test 3: rewrite that test cleanly:

```ts
it('guest → permissionMode=default + disallowedTools blocks non-allowed built-ins', () => {
  const out = tierProfileToClaudeSdkOpts(TIER_PROFILES.guest)
  expect(out.permissionMode).toBe('default')
  expect(out.disallowedTools).toContain('Bash')
  expect(out.disallowedTools).toContain('Write')
})
```

(Adjust the first guest test in the file to match.)

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/claude-agent-provider.test.ts`
Expected: FAIL — `tierProfileToClaudeSdkOpts` not exported.

- [ ] **Step 3: Implement the helper**

In `src/core/claude-agent-provider.ts`, near the top (after imports):

```ts
import type { TierProfile, ToolKind } from './user-tier'

/**
 * Map ToolKind → the Claude Code built-in tool names that fall into it.
 * MCP tools (mcp__wechat__*) are NOT listed — they're gated by canUseTool
 * (a per-tool callback fires for every MCP invocation), which the
 * permission-relay layer sets up.
 */
const TOOL_KIND_TO_CLAUDE_BUILTINS: Record<ToolKind, ReadonlyArray<string>> = {
  reply: [],            // MCP-only
  share_page: [],       // MCP-only
  memory_read: [],      // MCP-only
  memory_write: [],     // MCP-only
  memory_delete: [],    // MCP-only
  observations_read: [],  // MCP-only
  observations_write: [], // MCP-only
  fs_read: ['Read', 'Glob', 'Grep', 'LS'],
  fs_write: ['Write', 'Edit', 'NotebookEdit'],
  shell: ['Bash', 'KillShell'],
  shell_destructive: [],   // virtual; same Bash tool, gated by canUseTool input inspection
  network: ['WebFetch', 'WebSearch'],
  subagent: ['Task'],
}

export interface ClaudeTierSdkOpts {
  permissionMode: 'default' | 'bypassPermissions'
  disallowedTools?: string[]
}

/**
 * Pure translation from daemon TierProfile → Claude SDK options.
 * The caller layers `canUseTool` on top of this — `disallowedTools` only
 * covers built-ins (which the SDK knows by name); MCP tools and
 * shell_destructive get filtered inside the canUseTool closure.
 */
export function tierProfileToClaudeSdkOpts(tp: TierProfile): ClaudeTierSdkOpts {
  // admin → bypass everything (equivalent to old --dangerously path)
  // Any allow-everything profile is treated this way; check by relay+deny size.
  if (tp.relay.size === 0 && tp.deny.size === 0) {
    return { permissionMode: 'bypassPermissions' }
  }

  // Build disallowedTools from the deny set's built-in tools only
  const disallowed: string[] = []
  for (const kind of tp.deny) {
    for (const name of TOOL_KIND_TO_CLAUDE_BUILTINS[kind]) disallowed.push(name)
  }

  return {
    permissionMode: 'default',
    ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/core/claude-agent-provider.test.ts -t tierProfileToClaudeSdkOpts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/claude-agent-provider.ts src/core/claude-agent-provider.test.ts
git commit -m "feat(claude-provider): tierProfileToClaudeSdkOpts pure helper

Translates daemon TierProfile to the Claude SDK's { permissionMode,
disallowedTools }. Admin → bypassPermissions. Trusted → default
(canUseTool handles relay). Guest → default + built-in disallowedTools.

No spawn integration yet — that comes when ProviderEntry.spawn
signature changes."
```

---

## Task 5: Codex `tierProfileToSdkOpts` pure function

**Files:**
- Modify: `src/core/codex-agent-provider.ts`
- Modify or create: `src/core/codex-agent-provider.test.ts`

Symmetric to Task 4 but maps to Codex's `{ sandboxMode, approvalPolicy }`. Lossy — Codex has coarser knobs (no per-tool callback).

- [ ] **Step 1: Write failing test**

Create or extend `src/core/codex-agent-provider.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { tierProfileToCodexSdkOpts } from './codex-agent-provider'
import { TIER_PROFILES } from './user-tier'

describe('tierProfileToCodexSdkOpts', () => {
  it('admin → danger-full-access + never', () => {
    const out = tierProfileToCodexSdkOpts(TIER_PROFILES.admin)
    expect(out.sandboxMode).toBe('danger-full-access')
    expect(out.approvalPolicy).toBe('never')
  })

  it('trusted → workspace-write + never (NOT on-request, no admin UI to field)', () => {
    const out = tierProfileToCodexSdkOpts(TIER_PROFILES.trusted)
    expect(out.sandboxMode).toBe('workspace-write')
    expect(out.approvalPolicy).toBe('never')
  })

  it('guest → read-only + untrusted', () => {
    const out = tierProfileToCodexSdkOpts(TIER_PROFILES.guest)
    expect(out.sandboxMode).toBe('read-only')
    expect(out.approvalPolicy).toBe('untrusted')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/codex-agent-provider.test.ts`
Expected: FAIL — `tierProfileToCodexSdkOpts` not exported.

- [ ] **Step 3: Implement**

In `src/core/codex-agent-provider.ts`, near the top:

```ts
import type { TierProfile } from './user-tier'

export interface CodexTierSdkOpts {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'untrusted' | 'on-request' | 'never'
}

/**
 * Pure translation from daemon TierProfile → Codex SDK options.
 *
 * Codex has no per-tool callback equivalent to Claude's canUseTool.
 * Tier enforcement is therefore coarser:
 *   - admin → full access
 *   - trusted → workspace-write sandbox (no admin UI to field
 *     'on-request' prompts, so we use 'never' approval — destructive
 *     ops within the workspace cwd are still possible; documented
 *     limitation)
 *   - guest → read-only sandbox + untrusted approval (functionally
 *     restricted to reading + replying)
 *
 * Distinguishing tiers by relay/deny size is a heuristic: a profile
 * with no relay and no deny is treated as admin-equivalent; any deny
 * presence means guest-equivalent; relay-only means trusted. This
 * works for the three default profiles; if custom profiles get added
 * later this needs revisiting.
 */
export function tierProfileToCodexSdkOpts(tp: TierProfile): CodexTierSdkOpts {
  if (tp.relay.size === 0 && tp.deny.size === 0) {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
  }
  if (tp.deny.size === 0) {
    return { sandboxMode: 'workspace-write', approvalPolicy: 'never' }
  }
  return { sandboxMode: 'read-only', approvalPolicy: 'untrusted' }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/core/codex-agent-provider.test.ts -t tierProfileToCodexSdkOpts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/codex-agent-provider.ts src/core/codex-agent-provider.test.ts
git commit -m "feat(codex-provider): tierProfileToCodexSdkOpts pure helper

Lossy mapping — Codex SDK has no per-tool callback. Trusted uses
workspace-write + never (not on-request — there's no admin UI to
field Codex approval prompts mid-session). Documented limitation
in the design doc."
```

---

## Task 6: `AgentProvider.spawn` signature gains `tierProfile`

**Files:**
- Modify: `src/core/agent-provider.ts`
- Modify: `src/core/claude-agent-provider.ts`
- Modify: `src/core/codex-agent-provider.ts`
- Modify: `src/core/session-manager.ts` (call site — passes hard-coded admin tier for now)
- Modify: `src/daemon/bootstrap/index.ts` (`sdkOptionsForProject` signature grows)

This is a breaking change to spawn. SessionManager passes a hard-coded admin tier as a stub; Task 9 threads the real tier through.

- [ ] **Step 1: Update `AgentProvider.spawn` interface**

In `src/core/agent-provider.ts:67`:

```ts
import type { TierProfile } from './user-tier'

export interface AgentProvider {
  spawn(project: AgentProject, opts: { resumeSessionId?: string; tierProfile: TierProfile }): Promise<AgentSession>
  cheapEval?: CheapEval
}
```

Note `opts` is no longer `?` — `tierProfile` is required.

- [ ] **Step 2: Update Claude provider `spawn`**

In `src/core/claude-agent-provider.ts`, change the spawn signature and use the new helper:

```ts
async spawn(
  project: AgentProject,
  spawnOpts: { resumeSessionId?: string; tierProfile: TierProfile },
): Promise<AgentSession> {
  const sdkQueue = new AsyncQueue<SDKUserMessage>()
  // sdkOptionsForProject now takes tierProfile so the bootstrap closure
  // can layer per-tier options on top of the base. Task 13 wires the
  // canUseTool closure inside that closure.
  const options = opts.sdkOptionsForProject(project.alias, project.path, spawnOpts.tierProfile)
  if (spawnOpts.resumeSessionId) {
    ;(options as Options & { resume?: string }).resume = spawnOpts.resumeSessionId
  }
  // ... rest unchanged
}
```

Update `ClaudeAgentProviderOptions`:

```ts
export interface ClaudeAgentProviderOptions {
  sdkOptionsForProject: (alias: string, path: string, tierProfile: TierProfile) => Options
  claudeBin?: string
}
```

- [ ] **Step 3: Update Codex provider `spawn`**

In `src/core/codex-agent-provider.ts`, replace the spawn signature:

```ts
async spawn(
  project: AgentProject,
  spawnOpts: { resumeSessionId?: string; tierProfile: TierProfile },
): Promise<AgentSession> {
  const tierOpts = tierProfileToCodexSdkOpts(spawnOpts.tierProfile)
  const threadOptions = {
    ...existingThreadOptions,
    sandboxMode: tierOpts.sandboxMode,
    approvalPolicy: tierOpts.approvalPolicy,
  }
  const thread = spawnOpts.resumeSessionId
    ? codex.resumeThread(spawnOpts.resumeSessionId, threadOptions)
    : codex.startThread(threadOptions)
  // ... rest unchanged
}
```

The existing code already builds `threadOptions` somewhere; merge the tier opts in. Inspect lines around 160 — adjust to fit current structure. The key: replace any hardcoded `sandboxMode` / `approvalPolicy` with the tier-derived ones.

- [ ] **Step 4: Update bootstrap's `sdkOptionsForProject` signature**

In `src/daemon/bootstrap/index.ts`, the closure at line 286:

```ts
const sdkOptionsForProject = (_alias: string, path: string, tierProfile: TierProfile): Options => {
  const cstatus = deps.ilink.companion.status()
  const systemPrompt = buildSystemPrompt({ /* unchanged */ })
  const common: Options = { /* unchanged */ }
  const tierOpts = tierProfileToClaudeSdkOpts(tierProfile)
  return {
    ...common,
    permissionMode: tierOpts.permissionMode,
    ...(tierOpts.disallowedTools ? { disallowedTools: tierOpts.disallowedTools } : {}),
    // canUseTool added in Task 13 when permission-relay is tier-aware
  }
}
```

Update the interface near line 169:

```ts
sdkOptionsForProject: (alias: string, path: string, tierProfile: TierProfile) => Options
```

Remove the old `if (deps.dangerouslySkipPermissions) { ... }` branch — tier is now the source of truth. The `dangerouslySkipPermissions` daemon flag still exists but is now interpreted in Task 13's tier resolver (admin tier sets bypassPermissions; dangerously can elevate non-admin chats to admin if desired, or just be removed as a concept entirely — decide in Task 13).

Update `src/daemon/bootstrap/delegate.ts:49` (the other `sdkOptionsForProject` site) similarly. The delegate path always runs admin-tier (the daemon initiated the delegation, not a chat).

- [ ] **Step 5: Update session-manager's `spawn()` call**

In `src/core/session-manager.ts`, around line 123-125, the call:

```ts
const session = resumeSessionId
  ? await provider.spawn(project, { resumeSessionId })
  : await provider.spawn(project)
```

Becomes:

```ts
import { TIER_PROFILES } from './user-tier'

// ... inside spawn():
const session = await provider.spawn(project, {
  ...(resumeSessionId ? { resumeSessionId } : {}),
  // Hard-coded admin tier — Task 9 threads real tier through acquire().
  tierProfile: TIER_PROFILES.admin,
})
```

This is the explicit stub. Comment it so the next task knows what to replace.

- [ ] **Step 6: Update existing provider tests**

If `src/core/claude-agent-provider.test.ts` already has tests that call spawn, update those calls to include `tierProfile: TIER_PROFILES.admin`. Same for codex. Find them with:

Run: `grep -rn "spawn({" src/core/*.test.ts`

For each match, update the call. Existing assertions should still pass since admin tier is effectively the same as the pre-change behaviour.

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors. Catches any caller you missed.

- [ ] **Step 8: Run full unit suite**

Run: `bun --bun vitest run`
Expected: all pass. Existing behaviour preserved because session-manager defaults to admin tier (matches old "no tier" effective behaviour).

- [ ] **Step 9: Commit**

```bash
git add src/core/agent-provider.ts src/core/claude-agent-provider.ts src/core/codex-agent-provider.ts \
        src/core/session-manager.ts src/daemon/bootstrap/index.ts src/daemon/bootstrap/delegate.ts \
        src/core/*.test.ts
git commit -m "refactor(provider): spawn() requires tierProfile

Both providers' spawn signatures gain a required tierProfile, mapped
internally to SDK options via the pure helpers from Tasks 4/5.
sessionManager passes a hard-coded admin tier as a stub — Task 9
threads the real tier through acquire().

Behaviour unchanged because admin tier translates to the same SDK
options the old code path used (bypassPermissions / danger-full-access)."
```

---

## Task 7: db.ts migration v10 — add `chat_id` column + legacy cleanup

**Files:**
- Modify: `src/lib/db.ts`
- Modify: `src/lib/db.test.ts` (or wherever migration coverage lives)

- [ ] **Step 1: Write failing test for the migration**

Add to the appropriate db test file (look for existing migration tests; if none, create `src/lib/db.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { Database } from 'bun:sqlite'

describe('migration v10 — sessions.chat_id', () => {
  it('adds chat_id column with _legacy default for pre-existing rows', () => {
    const db = new Database(':memory:')
    // Manually set up the pre-v10 schema and insert a row
    db.exec(`
      PRAGMA user_version = 9;
      CREATE TABLE sessions (
        alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        summary TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (alias, provider)
      ) STRICT;
      INSERT INTO sessions(alias, provider, session_id, last_used_at)
        VALUES ('_default', 'claude', 'sess1', '${new Date().toISOString()}');
    `)

    // Run the openDb logic against this database
    const { openDb } = require('./db') as { openDb: (opts: { path: string; existingDb?: Database }) => Database }
    // The existing openDb opens a file by path; for in-memory test, we need a way to inject.
    // If openDb doesn't support that, the test instead runs against a tempfile.

    // Alternative: write the migrated db to a tempfile then reopen
    // For now, assume db.ts exports a `runMigrations(db)` for testability
    const { runMigrations } = require('./db') as { runMigrations: (db: Database) => void }
    runMigrations(db)

    const cols = db.query("PRAGMA table_info('sessions')").all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('chat_id')

    const row = db.query("SELECT chat_id FROM sessions WHERE alias = '_default'").get() as { chat_id: string }
    expect(row.chat_id).toBe('_legacy')

    const ver = db.query('PRAGMA user_version').get() as { user_version: number }
    expect(ver.user_version).toBeGreaterThanOrEqual(10)
  })

  it('legacy rows older than 1 day are cleaned up', () => {
    const db = new Database(':memory:')
    const oldTs = new Date(Date.now() - 2 * 86_400_000).toISOString()
    db.exec(`
      PRAGMA user_version = 9;
      CREATE TABLE sessions (
        alias TEXT NOT NULL, provider TEXT NOT NULL, session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL, summary TEXT, summary_updated_at TEXT,
        PRIMARY KEY (alias, provider)
      ) STRICT;
      INSERT INTO sessions(alias, provider, session_id, last_used_at) VALUES
        ('_default', 'claude', 'old_sess', '${oldTs}'),
        ('_default', 'codex',  'fresh',    '${new Date().toISOString()}');
    `)
    const { runMigrations } = require('./db') as { runMigrations: (db: Database) => void }
    runMigrations(db)
    const remaining = db.query<{ session_id: string }, []>('SELECT session_id FROM sessions').all()
    expect(remaining.map(r => r.session_id)).toContain('fresh')
    expect(remaining.map(r => r.session_id)).not.toContain('old_sess')
  })
})
```

If `db.ts` doesn't export `runMigrations`, refactor the existing logic so the migration runner can be invoked in isolation. Look around line 233-242 (the `for (let i = current; ...)` loop) — extract to an exported function.

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/lib/db.test.ts`
Expected: FAIL — no `chat_id` column, or migration count too low.

- [ ] **Step 3: Add migration v10**

In `src/lib/db.ts`, append to the `migrations` array (after the existing v9):

```ts
// v10 — per-chat session keys. Pre-tier sessions get chat_id='_legacy'
// and are cleaned up if they're older than a day (most installs have
// nothing newer; the 1-day grace handles fresh upgrades mid-conversation).
// See docs/superpowers/specs/2026-05-22-user-tier-permissions-design.md.
(db) => {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN chat_id TEXT NOT NULL DEFAULT '_legacy';
  `)
  // SQLite can't ALTER a PRIMARY KEY in place; rebuild the table.
  db.exec(`
    CREATE TABLE sessions_v10 (
      alias TEXT NOT NULL,
      provider TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      summary TEXT,
      summary_updated_at TEXT,
      PRIMARY KEY (alias, provider, chat_id)
    ) STRICT;
    INSERT INTO sessions_v10(alias, provider, chat_id, session_id, last_used_at, summary, summary_updated_at)
      SELECT alias, provider, chat_id, session_id, last_used_at, summary, summary_updated_at FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_v10 RENAME TO sessions;
    CREATE INDEX IF NOT EXISTS sessions_alias_last_used ON sessions(alias, last_used_at DESC);
  `)
  // Cleanup pre-tier rows older than 1 day. ISO 8601 string-comparable.
  const cutoff = new Date(Date.now() - 86_400_000).toISOString()
  db.exec(`DELETE FROM sessions WHERE chat_id = '_legacy' AND last_used_at < '${cutoff}'`)
},
```

Refactor `openDb` to expose `runMigrations` if not already:

```ts
export function runMigrations(db: Database): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null
  const current = row?.user_version ?? 0
  for (let i = current; i < migrations.length; i++) {
    const next = migrations[i]!
    db.transaction(() => {
      next(db)
      db.exec(`PRAGMA user_version = ${i + 1};`)
    })()
  }
}
```

Then have `openDb` call `runMigrations(db)` instead of inlining the loop.

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/lib/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `bun run typecheck && bun --bun vitest run`
Expected: all pass. Existing session-store / session-manager tests still work because they default to fresh DBs that get the new schema directly.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts src/lib/db.test.ts
git commit -m "feat(db): migration v10 — sessions per (alias, provider, chat_id)

Adds chat_id column with default '_legacy', rebuilds the table with
the 3-column primary key, cleans up pre-tier rows older than 1 day.
runMigrations() extracted as an export so the test can drive it
against an in-memory DB."
```

---

## Task 8: `session-store.ts` — queries take required `chatId`

**Files:**
- Modify: `src/core/session-store.ts`
- Modify: `src/core/session-store.test.ts`

The schema has the column now (Task 7). This task updates the TypeScript queries + the `SessionStore` interface.

- [ ] **Step 1: Update the failing test set**

Open `src/core/session-store.test.ts`. Find tests that call `get`/`set`/`delete`/`deleteOne`. They currently look like:

```ts
store.set('alias1', 'sess1', 'claude')
const r = store.get('alias1', 'claude')
```

Update all such calls to include the new chat_id parameter. For example:

```ts
store.set({ alias: 'alias1', provider: 'claude', chatId: 'chat1', sessionId: 'sess1' })
const r = store.get({ alias: 'alias1', provider: 'claude', chatId: 'chat1' })
```

(Decide on options-object vs positional — options object recommended for clarity given 3 keys.)

Add a new test:

```ts
it('two chats on the same alias+provider get distinct rows', () => {
  const db = new Database(':memory:')
  runMigrations(db)
  const store = makeSessionStore(db)
  store.set({ alias: '_default', provider: 'claude', chatId: 'chatA', sessionId: 'sessA' })
  store.set({ alias: '_default', provider: 'claude', chatId: 'chatB', sessionId: 'sessB' })
  expect(store.get({ alias: '_default', provider: 'claude', chatId: 'chatA' })?.session_id).toBe('sessA')
  expect(store.get({ alias: '_default', provider: 'claude', chatId: 'chatB' })?.session_id).toBe('sessB')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/session-store.test.ts`
Expected: FAIL — `get/set` signature mismatch or missing chatId column behaviour.

- [ ] **Step 3: Update `SessionStore` interface + implementation**

In `src/core/session-store.ts`:

```ts
export interface SessionRecord {
  alias: string                     // NEW — was the key, now also a field
  session_id: string
  last_used_at: string
  provider: ProviderId
  chat_id: string                   // NEW
  summary?: string
  summary_updated_at?: string
}

export interface SessionStoreKey {
  alias: string
  provider: ProviderId
  chatId: string
}

export interface SessionStore {
  /**
   * Returns the stored record. Requires the full triple — there's no
   * "most-recently-used row across providers" any more because chat
   * scopes mean that lookup was ambiguous in the multi-chat world.
   */
  get(key: SessionStoreKey): SessionRecord | null
  set(key: SessionStoreKey, sessionId: string): void
  setSummary(key: SessionStoreKey, summary: string): void
  delete(key: { alias: string; chatId: string }): void   // forget every provider for an (alias, chat)
  deleteOne(key: SessionStoreKey): void
  /** Returns every row, keyed by `${alias}|${provider}|${chatId}`. */
  all(): Record<string, SessionRecord>
  flush(): Promise<void>
}
```

Then rewrite the prepared statements to use the triple key. The CREATE TABLE / INSERT OR REPLACE in `migrateFromFile` still emits `chat_id = '_legacy'` for unspecified rows.

Update `summarizer-runtime.ts` if it calls `store.all()` directly — the return shape changed from `Record<alias, ...>` to `Record<alias|provider|chatId, ...>`. Adjust the loop:

```ts
for (const [, rec] of Object.entries(all)) {  // iterate values
  if (!needsRefresh(rec)) continue
  const alias = rec.alias ?? extractAliasFromKey(...)  // OR add alias to SessionRecord
  // ...
}
```

Simpler: add `alias` and `chat_id` (already there) to `SessionRecord` so each row is self-describing.

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/core/session-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Update callers**

Run: `grep -rn "store\.\(get\|set\|delete\|deleteOne\|setSummary\)" src/ cli.ts | grep -v test`

For each call site, update to new signature. Likely sites: `session-manager.ts`, `summarizer-runtime.ts`.

Note: `session-manager.ts` is fully rewritten in Task 9 — for now just compile. Use a hard-coded `chatId='_legacy'` placeholder there and a `TODO: replaced in Task 9` comment.

- [ ] **Step 6: Typecheck + full suite**

Run: `bun run typecheck && bun --bun vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/session-store.ts src/core/session-store.test.ts src/core/session-manager.ts src/daemon/sessions/summarizer-runtime.ts
git commit -m "feat(session-store): chatId required on every query

PRIMARY KEY is now (alias, provider, chat_id). get/set/delete take an
options-object SessionStoreKey. session-manager passes chatId='_legacy'
as a placeholder until Task 9 wires the real chatId through acquire()."
```

---

## Task 9: `session-manager.ts` — options-object signatures with `chatId` + `tierProfile`

**Files:**
- Modify: `src/core/session-manager.ts`
- Modify: `src/core/session-manager.test.ts`

This is the heart of the refactor. `acquire`, `release`, `isInFlight`, and `shutdown` all change.

- [ ] **Step 1: Write failing tests**

In `src/core/session-manager.test.ts`, add:

```ts
import { TIER_PROFILES } from './user-tier'

describe('SessionManager — per-chat isolation', () => {
  it('acquire on same alias+provider but different chatId returns DIFFERENT handles', async () => {
    const mgr = /* construct as in existing tests */
    const h1 = await mgr.acquire({ alias: '_default', path: '/tmp/x', providerId: 'claude', chatId: 'chatA', tierProfile: TIER_PROFILES.admin })
    const h2 = await mgr.acquire({ alias: '_default', path: '/tmp/x', providerId: 'claude', chatId: 'chatB', tierProfile: TIER_PROFILES.admin })
    expect(h1).not.toBe(h2)
  })

  it('acquire on same triple returns CACHED handle', async () => {
    const mgr = /* ... */
    const h1 = await mgr.acquire({ alias: '_default', path: '/tmp/x', providerId: 'claude', chatId: 'chatA', tierProfile: TIER_PROFILES.admin })
    const h2 = await mgr.acquire({ alias: '_default', path: '/tmp/x', providerId: 'claude', chatId: 'chatA', tierProfile: TIER_PROFILES.admin })
    expect(h1).toBe(h2)
  })

  it('isInFlight is keyed by triple', async () => {
    const mgr = /* ... */
    // Start dispatch on chatA
    const h = await mgr.acquire({ alias: '_default', path: '/tmp/x', providerId: 'claude', chatId: 'chatA', tierProfile: TIER_PROFILES.admin })
    const it = h.dispatch('hi')[Symbol.asyncIterator]()
    void it.next()
    expect(mgr.isInFlight({ alias: '_default', providerId: 'claude', chatId: 'chatA' })).toBe(true)
    expect(mgr.isInFlight({ alias: '_default', providerId: 'claude', chatId: 'chatB' })).toBe(false)
  })
})
```

Update existing acquire tests to the new signature too.

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/session-manager.test.ts`
Expected: FAIL — `acquire` signature mismatch.

- [ ] **Step 3: Update SessionManager**

In `src/core/session-manager.ts`:

```ts
import type { TierProfile } from './user-tier'

export interface AcquireRequest {
  alias: string
  path: string
  providerId: ProviderId
  chatId: string
  tierProfile: TierProfile
}

export interface InFlightKey {
  alias: string
  providerId: ProviderId
  chatId: string
}

const sessionKey = (k: { alias: string; providerId: ProviderId; chatId: string }) =>
  `${k.providerId}|${k.alias}|${k.chatId}`

export class SessionManager {
  // ...
  async acquire(req: AcquireRequest): Promise<SessionHandle> {
    const k = sessionKey({ alias: req.alias, providerId: req.providerId, chatId: req.chatId })
    const existing = this.sessions.get(k)
    if (existing) {
      existing.handle.lastUsedAt = Date.now()
      return existing.handle
    }
    const inFlight = this.pending.get(k)
    if (inFlight) return inFlight
    const promise = this.spawn(req).finally(() => this.pending.delete(k))
    this.pending.set(k, promise)
    return promise
  }

  private async spawn(req: AcquireRequest): Promise<SessionHandle> {
    const entry = this.opts.registry.get(req.providerId)
    if (!entry) throw new Error(`unknown provider: ${req.providerId}`)
    const { provider, opts: regOpts } = entry

    const ttl = this.opts.resumeTTLMs ?? 7 * 24 * 60 * 60_000
    const record = this.opts.sessionStore?.get({ alias: req.alias, provider: req.providerId, chatId: req.chatId }) ?? null
    let resumeSessionId: string | undefined
    if (record) {
      const age = Date.now() - Date.parse(record.last_used_at)
      const jsonlStillThere = regOpts.canResume(req.path, record.session_id)
      if (age < ttl && jsonlStillThere) {
        resumeSessionId = record.session_id
        log('SESSION_RESUME', `alias=${req.alias} chat=${req.chatId} sid=${record.session_id} provider=${req.providerId} age=${Math.round(age / 1000)}s`)
      } else {
        this.opts.sessionStore?.deleteOne({ alias: req.alias, provider: req.providerId, chatId: req.chatId })
      }
    }

    const session = await provider.spawn(
      { alias: req.alias, path: req.path },
      {
        ...(resumeSessionId ? { resumeSessionId } : {}),
        tierProfile: req.tierProfile,
      },
    )

    // ... rest of spawn unchanged except passing the triple key everywhere
    // sessionStore.set is called inside the result event handler — pass the triple
  }

  isInFlight(k: InFlightKey): boolean {
    return (this.inFlight.get(sessionKey(k)) ?? 0) > 0
  }

  async release(k: InFlightKey): Promise<void> {
    const key = sessionKey(k)
    const s = this.sessions.get(key)
    if (!s) return
    this.sessions.delete(key)
    await s.handle.close()
  }

  // shutdown clears all sessions — unchanged conceptually, just iterates handles
}
```

Update `sessionStore.set` (and similar) calls inside `spawn`'s result-event handler to pass the triple-key.

- [ ] **Step 4: Update callers**

Run: `grep -rn "manager\.\(acquire\|release\|isInFlight\)" src/ | grep -v test`

Likely sites: `conversation-coordinator.ts`, `tick-bodies.ts`, `chatroom-moderator.ts`. Pass placeholder values temporarily:

```ts
manager.acquire({ alias, path, providerId, chatId: '_legacy', tierProfile: TIER_PROFILES.admin })
```

(Tasks 10 and 11 wire real chatId + tierProfile.) Mark with `TODO: tier wiring`.

- [ ] **Step 5: Run to verify pass**

Run: `bun --bun vitest run src/core/session-manager.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + full suite**

Run: `bun run typecheck && bun --bun vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/session-manager.ts src/core/session-manager.test.ts \
        src/core/conversation-coordinator.ts src/daemon/wiring/tick-bodies.ts \
        src/core/chatroom-moderator.ts
git commit -m "feat(session-manager): per-chat session isolation via AcquireRequest

acquire/release/isInFlight/spawn all take an options object including
chatId + tierProfile. Two chats on the same (alias, provider) now get
separate session_ids and separate jsonl files. Callers pass
chatId='_legacy' + admin tier as placeholders — Tasks 10/11 thread
the real values."
```

---

## Task 10: `conversation-coordinator.ts` threads `chatId` + tier

**Files:**
- Modify: `src/core/conversation-coordinator.ts`
- Modify: `src/core/conversation-coordinator.test.ts`

The coordinator already has `chatId` (it's the inbound message's chat). It just needs to compute `tierProfile` and pass both to `acquire`.

- [ ] **Step 1: Write failing test**

Add to `src/core/conversation-coordinator.test.ts`:

```ts
import { TIER_PROFILES } from './user-tier'

it('dispatch threads chatId into session acquire', async () => {
  const acquireCalls: Array<{ alias: string; chatId: string; tierProfile: TierProfile }> = []
  const fakeManager = {
    acquire: async (req: AcquireRequest) => {
      acquireCalls.push({ alias: req.alias, chatId: req.chatId, tierProfile: req.tierProfile })
      return /* fake handle */
    },
    isInFlight: () => false,
    release: async () => {},
  }
  const coord = createConversationCoordinator({
    /* deps with fakeManager + access containing admin: ['adminChat'] */
  })
  await coord.dispatch({ chatId: 'adminChat', /* ... */ })
  expect(acquireCalls[0]).toMatchObject({ chatId: 'adminChat' })
  expect(acquireCalls[0]?.tierProfile).toBe(TIER_PROFILES.admin)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/conversation-coordinator.test.ts -t 'threads chatId'`
Expected: FAIL.

- [ ] **Step 3: Update coordinator**

In `src/core/conversation-coordinator.ts`, the `dispatchSolo` function (line 228):

```ts
import { resolveTier, TIER_PROFILES } from './user-tier'

async function dispatchSolo(
  msg: InboundMsg,
  proj: { alias: string; path: string },
  providerId: ProviderId,
): Promise<void> {
  const tier = resolveTier(msg.chatId, deps.loadAccess())
  const tp = TIER_PROFILES[tier]
  // ... logging unchanged
  const handle = await deps.manager.acquire({
    alias: proj.alias,
    path: proj.path,
    providerId,
    chatId: msg.chatId,
    tierProfile: tp,
  })
  // ... rest unchanged
}
```

`ConversationCoordinatorDeps` gains:

```ts
export interface ConversationCoordinatorDeps {
  // ... existing
  loadAccess: () => Access
}
```

Update `dispatchParallel` / `dispatchPrimaryTool` / `dispatchChatroom` similarly — each takes a chatId + computes tier.

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `bun --bun vitest run src/core/conversation-coordinator.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Wire `loadAccess` at bootstrap**

In `src/daemon/bootstrap/index.ts`, where the coordinator is constructed:

```ts
import { loadAccess } from '../../lib/access'
// ...
const coordinator = createConversationCoordinator({
  // ... existing
  loadAccess,
})
```

- [ ] **Step 6: Run full suite**

Run: `bun --bun vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/conversation-coordinator.ts src/core/conversation-coordinator.test.ts src/daemon/bootstrap/index.ts
git commit -m "feat(coord): dispatch threads chatId + tier to manager.acquire

Coordinator resolves tier from inbound chatId via loadAccess. All four
dispatch modes (solo / parallel / primary_tool / chatroom) pass the
real chatId + TIER_PROFILES[tier] instead of the '_legacy' / admin
placeholder."
```

---

## Task 11: tick-bodies — push/introspect tick threads chatId

**Files:**
- Modify: `src/daemon/wiring/tick-bodies.ts`
- Modify: `src/daemon/wiring/tick-bodies.test.ts`

Companion ticks aren't user-initiated; they read `default_chat_id` from companion config and run admin-tier (the bot's owner).

- [ ] **Step 1: Write failing test**

Add to `src/daemon/wiring/tick-bodies.test.ts`:

```ts
it('pushTick acquires with companion default_chat_id and admin tier', async () => {
  const acquireCalls: AcquireRequest[] = []
  const fakeManager = {
    acquire: async (r: AcquireRequest) => { acquireCalls.push(r); return fakeHandle },
    isInFlight: () => false,
  }
  // Companion config with default_chat_id='ownerChat'
  // access.json with admins=['ownerChat']
  const ticks = buildTickBodies({ /* deps with fakeManager */ })
  await ticks.pushTick()
  expect(acquireCalls[0]?.chatId).toBe('ownerChat')
  expect(acquireCalls[0]?.tierProfile).toBe(TIER_PROFILES.admin)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts -t 'companion default'`
Expected: FAIL.

- [ ] **Step 3: Update pushTick + introspectTick**

In `src/daemon/wiring/tick-bodies.ts`, `pushTick`:

```ts
import { resolveTier, TIER_PROFILES } from '../../core/user-tier'
import { loadAccess } from '../../lib/access'

async function pushTick(opts?: { nowIso?: string }): Promise<void> {
  const cfg = loadCompanionConfig(deps.stateDir)
  if (!cfg.default_chat_id) {
    deps.log('SCHED', 'skip tick — no default_chat_id'); return
  }
  // ... project resolution unchanged

  const tier = resolveTier(cfg.default_chat_id, loadAccess())
  if (tier !== 'admin') {
    deps.log('COMPANION', `default_chat_id is non-admin tier (${tier}); tick will run with reduced capabilities`)
  }
  const tp = TIER_PROFILES[tier]

  if (deps.boot.sessionManager.isInFlight({ alias: proj.alias, providerId: deps.boot.defaultProviderId, chatId: cfg.default_chat_id })) {
    deps.log('SCHED', `[companion] skipping push tick: user session in-flight (alias=${proj.alias} chat=${cfg.default_chat_id})`)
    return
  }
  const handle = await deps.boot.sessionManager.acquire({
    alias: proj.alias,
    path: proj.path,
    providerId: deps.boot.defaultProviderId,
    chatId: cfg.default_chat_id,
    tierProfile: tp,
  })
  // ... rest unchanged
}
```

Same change for `introspectTick`.

- [ ] **Step 4: Run + typecheck**

Run: `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/wiring/tick-bodies.ts src/daemon/wiring/tick-bodies.test.ts
git commit -m "feat(tick): push/introspect tick uses default_chat_id + tier

Both ticks read companion default_chat_id, resolve its tier (logs a
warning if it's not admin — unusual configuration), and acquire with
the real chatId + tierProfile. Removes the '_legacy' placeholder."
```

---

## Task 12: `permission-relay.ts` — `effectivePolicy` + tier-aware `canUseTool`

**Files:**
- Modify: `src/core/permission-relay.ts`
- Modify: `src/core/permission-relay.test.ts`

The relay now consumes the tier profile and combines it with the matrix's base capability.

- [ ] **Step 1: Write failing test**

Add to `src/core/permission-relay.test.ts`:

```ts
import { TIER_PROFILES } from './user-tier'
import { effectivePolicy } from './permission-relay'

describe('effectivePolicy', () => {
  const adminBase = { askUser: 'never', /* other fields irrelevant */ }
  const strictBase = { askUser: 'per-tool', /* ... */ }

  it('tier.deny → deny regardless of base', () => {
    expect(effectivePolicy(adminBase as Capability, TIER_PROFILES.guest, 'shell')).toBe('deny')
    expect(effectivePolicy(strictBase as Capability, TIER_PROFILES.guest, 'shell')).toBe('deny')
  })

  it('tier.relay → relay regardless of base', () => {
    expect(effectivePolicy(adminBase as Capability, TIER_PROFILES.trusted, 'shell_destructive')).toBe('relay')
    expect(effectivePolicy(strictBase as Capability, TIER_PROFILES.trusted, 'shell_destructive')).toBe('relay')
  })

  it('tier.allow + base never → allow', () => {
    expect(effectivePolicy(adminBase as Capability, TIER_PROFILES.admin, 'shell')).toBe('allow')
  })

  it('tier.allow + base per-tool → relay (matrix dictates the relay)', () => {
    expect(effectivePolicy(strictBase as Capability, TIER_PROFILES.admin, 'shell')).toBe('relay')
  })
})
```

Also a test for the `canUseTool` closure end-to-end:

```ts
it('canUseTool denies a guest trying to call Bash even though Bash is allowed by matrix', async () => {
  // resolveAdminChatId returns 'admin1'; askUser mock denies anything
  const cut = makeCanUseTool({
    askUser: async () => 'deny',
    resolveTier: () => 'guest',
    classifyToolUse,
    mode: () => 'solo',
    provider: 'claude',
    permissionMode: 'strict',
    log: () => {},
    adminChatId: () => 'admin1',
  })
  const result = await cut('Bash', { command: 'ls' }, { toolUseID: 'tid' } as any)
  expect(result.behavior).toBe('deny')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/permission-relay.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement `effectivePolicy` + update `makeCanUseTool`**

In `src/core/permission-relay.ts`:

```ts
import type { TierProfile, ToolKind, UserTier } from './user-tier'
import { classifyToolUse } from './user-tier'
import { lookup, type Capability } from './capability-matrix'

export function effectivePolicy(
  base: Capability,
  tp: TierProfile,
  kind: ToolKind,
): 'allow' | 'relay' | 'deny' {
  if (tp.deny.has(kind)) return 'deny'
  if (tp.relay.has(kind)) return 'relay'
  return base.askUser === 'per-tool' ? 'relay' : 'allow'
}

export interface PermissionRelayDeps {
  askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow' | 'deny' | 'timeout'>
  /** chatId of the chat that initiated this dispatch (for routing context). */
  initiatingChatId: () => string | null
  /** chatId of an admin to receive prompts. May be null if no admins configured. */
  adminChatId: () => string | null
  /** Returns the tier of the initiating chat — used by effectivePolicy. */
  resolveTier: () => UserTier
  log: (tag: string, line: string) => void
  mode: () => Mode['kind']
  provider: ProviderId
  permissionMode: PermissionMode
}

export function makeCanUseTool(deps: PermissionRelayDeps): CanUseTool {
  return async (toolName, input, opts) => {
    const tier = deps.resolveTier()
    const tp = TIER_PROFILES[tier]
    const kind = classifyToolUse(toolName, input)
    const base = lookup(deps.mode(), deps.provider, deps.permissionMode)
    const decision = effectivePolicy(base, tp, kind)

    if (decision === 'allow') return { behavior: 'allow' } satisfies PermissionResult
    if (decision === 'deny') {
      deps.log('PERMISSION', `deny: tool=${toolName} kind=${kind} tier=${tier}`)
      return {
        behavior: 'deny',
        message: `Tool '${toolName}' (${kind}) not available to tier '${tier}'`,
      } satisfies PermissionResult
    }
    // relay
    const target = deps.adminChatId()
    if (!target) {
      deps.log('PERMISSION', `relay-but-no-admin: tool=${toolName} kind=${kind} — denying`)
      return { behavior: 'deny', message: 'no admin configured to approve permission requests' } satisfies PermissionResult
    }
    const hash = shortHash(opts.toolUseID ?? '')
    const prompt = opts.title ?? `Claude wants to run ${toolName} ${compactInput(input)}`
    const answer = await deps.askUser(target, prompt, hash, DEFAULT_TIMEOUT_MS)
    if (answer === 'allow') return { behavior: 'allow' } satisfies PermissionResult
    deps.log('PERMISSION', `${answer}: tool=${toolName} hash=${hash}`)
    return {
      behavior: 'deny',
      message: answer === 'timeout' ? 'User did not reply in time; request denied' : 'User denied the request',
    } satisfies PermissionResult
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/core/permission-relay.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: errors at `bootstrap/index.ts:234` (old `makeCanUseTool` signature). Fix in Task 13.

If typecheck reports errors only in bootstrap, ignore them temporarily — Task 13 wires bootstrap correctly.

- [ ] **Step 6: Commit**

```bash
git add src/core/permission-relay.ts src/core/permission-relay.test.ts
git commit -m "feat(relay): tier-aware canUseTool via effectivePolicy

makeCanUseTool now takes resolveTier + adminChatId callbacks and a
classifyToolUse import. effectivePolicy combines matrix base + tier
profile to a single allow/relay/deny decision per call. Bootstrap
wiring fix comes in the next task — typecheck may show errors there."
```

---

## Task 13: bootstrap — `resolveAdminChatId` + permission-relay wiring

**Files:**
- Modify: `src/daemon/bootstrap/index.ts`
- Modify: `src/daemon/bootstrap/*.test.ts` (if applicable)

Switch the relay's destination from `lastActiveChatId` to a configured admin chat.

- [ ] **Step 1: Write failing test**

If there's no bootstrap test that covers the relay routing, add one. Look for `resolveAdminChatId` or similar — if absent, write a small test:

```ts
import { resolveAdminChatId } from '../../daemon/bootstrap/index'  // or wherever it ends up exported

describe('resolveAdminChatId', () => {
  it('returns companion default_chat_id if it is admin', () => {
    expect(resolveAdminChatId(
      { allowFrom: ['x', 'y'], admins: ['x', 'y'] } as Access,
      { default_chat_id: 'x' } as CompanionConfig,
    )).toBe('x')
  })
  it('falls back to admins[0] if default_chat_id is not admin', () => {
    expect(resolveAdminChatId(
      { allowFrom: ['x', 'y'], admins: ['y'] } as Access,
      { default_chat_id: 'x' } as CompanionConfig,
    )).toBe('y')
  })
  it('returns null when admins empty', () => {
    expect(resolveAdminChatId(
      { allowFrom: ['x'], admins: [] } as Access,
      { default_chat_id: null } as CompanionConfig,
    )).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/daemon/bootstrap`
Expected: FAIL.

- [ ] **Step 3: Implement + wire**

In `src/daemon/bootstrap/index.ts` (top-level export):

```ts
export function resolveAdminChatId(access: Access, companion: CompanionConfig): string | null {
  if (companion.default_chat_id && access.admins?.includes(companion.default_chat_id)) {
    return companion.default_chat_id
  }
  return access.admins?.[0] ?? null
}
```

Update the `makeCanUseTool` call site at line 234:

```ts
const canUseTool = makeCanUseTool({
  askUser: deps.ilink.askUser,
  initiatingChatId: () => deps.lastActiveChatId(),
  adminChatId: () => resolveAdminChatId(loadAccess(), loadCompanionConfig(deps.stateDir)),
  resolveTier: () => {
    const cid = deps.lastActiveChatId()
    if (!cid) return 'admin'  // no active chat — system-initiated work runs admin
    return resolveTier(cid, loadAccess())
  },
  log: deps.log,
  mode: () => { /* existing per-dispatch mode lookup */ },
  provider: 'claude',
  permissionMode,
})
```

The `dangerouslySkipPermissions` daemon flag's interpretation changes: it now means "treat every chat as admin tier", which we implement by short-circuiting `resolveTier`:

```ts
resolveTier: () => {
  if (deps.dangerouslySkipPermissions) return 'admin'
  const cid = deps.lastActiveChatId()
  if (!cid) return 'admin'
  return resolveTier(cid, loadAccess())
},
```

- [ ] **Step 4: Run + typecheck**

Run: `bun --bun vitest run && bun run typecheck`
Expected: all pass — bootstrap typecheck errors from Task 12 cleared.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/bootstrap/index.ts src/daemon/bootstrap/*.test.ts
git commit -m "feat(bootstrap): resolveAdminChatId + tier-aware relay wiring

Permission prompts route to companion default_chat_id (if admin) or
admins[0]. dangerouslySkipPermissions reinterpreted as 'every chat is
admin tier' — the matrix's per-tool relay still fires (or doesn't,
per the matrix), but tier policy never narrows access."
```

---

## Task 14: `access.ts` — session invalidation on access edits

**Files:**
- Modify: `src/lib/access.ts`
- Modify: `src/lib/access.test.ts`
- Modify: `src/daemon/bootstrap/index.ts` — register the invalidator

- [ ] **Step 1: Write failing test**

```ts
it('access.ts emits invalidation when tier membership changes', () => {
  let invalidated = 0
  setSessionInvalidator(() => { invalidated++ })

  // First load — initialises snapshot
  writeFileSync(ACCESS_FILE, JSON.stringify({ admins: ['x'] }))
  loadAccess()
  expect(invalidated).toBe(0)

  // Rewrite with no change — no invalidation
  writeFileSync(ACCESS_FILE, JSON.stringify({ admins: ['x'] }))
  loadAccess()
  expect(invalidated).toBe(0)

  // Rewrite changing admins — invalidates
  writeFileSync(ACCESS_FILE, JSON.stringify({ admins: ['x', 'y'] }))
  loadAccess()
  expect(invalidated).toBe(1)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/lib/access.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/lib/access.ts`:

```ts
let lastSnapshot: Access | null = null
let invalidator: (() => void) | null = null

export function setSessionInvalidator(fn: (() => void) | null): void {
  invalidator = fn
}

function setEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  for (const x of b) if (!s.has(x)) return false
  return true
}

function tierMembershipChanged(prev: Access, next: Access): boolean {
  return !setEq(prev.admins ?? [], next.admins ?? [])
      || !setEq(prev.trusted ?? [], next.trusted ?? [])
      || !setEq(prev.allowFrom, next.allowFrom)
}

export function loadAccess(): Access {
  // ... existing 5s TTL cache logic ...
  const fresh = readAccessFile()
  if (lastSnapshot && tierMembershipChanged(lastSnapshot, fresh)) {
    try { invalidator?.() } catch (err) { /* log but don't throw */ }
  }
  lastSnapshot = fresh
  return fresh
}
```

Register the invalidator at bootstrap:

```ts
// src/daemon/bootstrap/index.ts, after sessionManager construction
setSessionInvalidator(() => {
  log('ACCESS', 'tier membership changed — invalidating all live sessions')
  void sessionManager.shutdown().catch(err => log('ACCESS', `invalidate shutdown error: ${err}`))
})
```

- [ ] **Step 4: Run + typecheck**

Run: `bun --bun vitest run && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/access.ts src/lib/access.test.ts src/daemon/bootstrap/index.ts
git commit -m "feat(access): invalidate sessions on tier membership change

When access.json's admins/trusted/allowFrom set differs from the
previous snapshot, the registered invalidator (sessionManager.shutdown)
fires. Next acquire re-spawns with the new tier. Single-step rule —
edit access.json → next inbound runs under new tier."
```

---

## Task 15: eval daemon-shim — write trajectory chatId into `access.admins`

**Files:**
- Modify: `eval/companion/engine/daemon-shim.ts`

The eval harness's chatIds currently can't pass `resolveTier(... 'admin')` because access.admins is set to `'evaladmin'`. Trajectories would run as guest and fail every tool call. Fix by writing the trajectory's chatId into admins.

- [ ] **Step 1: Read current shim**

Run: `head -80 eval/companion/engine/daemon-shim.ts`

Confirm the `access.json` write currently looks like:

```ts
writeFileSync(join(stateDir, 'access.json'), JSON.stringify({
  allowFrom: ['*'], admins: ['evaladmin'],
}))
```

- [ ] **Step 2: Update the shim**

Change `EvalDaemonOpts` to include the trajectory's chatId(s), or derive it from `knownUsers`:

```ts
export interface EvalDaemonOpts {
  knownUsers: Record<string, string>
  companion: { enabled: boolean; default_chat_id: string }
}

export async function startEvalDaemon(opts: EvalDaemonOpts): Promise<EvalDaemon> {
  // ...
  const allChatIds = Object.keys(opts.knownUsers)
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist',
    allowFrom: allChatIds,
    admins: allChatIds,  // every eval chat runs as admin so trajectories see the full tool set
  }, null, 2))
  // ...
}
```

Note: this means eval trajectories are admin-tier by default. If we later want tier-specific trajectories, add an `EvalDaemonOpts.tierOverrides?: Record<string, UserTier>` field.

- [ ] **Step 3: Run the eval engine unit tests**

Run: `bun --bun vitest run eval/companion/ -c vitest.eval-engine.config.ts`
Expected: all pass (these don't actually boot a daemon; they cover the harness's pure modules).

- [ ] **Step 4: Smoke-load both trajectories**

Run: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; ['tech_stress_followup_v1','emotional_care_v1'].forEach(id => { const t = loadTrajectory('./eval/companion/trajectories/' + id + '.yaml'); console.log(id, 'OK') })"`
Expected: both `OK`.

- [ ] **Step 5: Commit**

```bash
git add eval/companion/engine/daemon-shim.ts
git commit -m "fix(eval): write trajectory chatId into access.admins

Previously the shim wrote admins=['evaladmin'], which under the new
tier model would make every trajectory's chat guest-tier — breaking
all tool use. Now every known eval chatId is also admin."
```

---

## Task 16: README updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Expand "Access control" section**

Find the `## Access control` section. Add tier documentation:

```markdown
### Permission tiers (v0.6+)

Each chatId in `access.json` falls into one of three tiers:

- `admins`: full access — the bot runs every tool unconditionally.
- `trusted`: full access EXCEPT destructive operations (rm, git reset --hard,
  git push --force, memory_delete). Destructive ops prompt the admin chat for
  approval.
- everyone else in `allowFrom`: guest tier — can chat, read their own memory,
  and that's it. Bash/Edit/Write/Task/WebFetch/WebSearch are denied outright.

Example `access.json`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["wxid_owner", "wxid_friend", "wxid_acquaintance"],
  "admins": ["wxid_owner"],
  "trusted": ["wxid_friend"]
}
```

Above: `wxid_owner` is admin (you), `wxid_friend` can drive most of the
agent's tools (you'll get a prompt before they delete anything), and
`wxid_acquaintance` can only chat.

Caveat: destructive Bash detection is regex-based and conservative
(matches `rm`, `git reset --hard`, `git push --force`, `git branch -D`,
`dd if=… of=…`). A determined caller can obfuscate. Don't put untrusted
people in `trusted` tier.
```

- [ ] **Step 2: Add Known limitations entry**

In the `## Known limitations` section:

```markdown
- **Permission tiering is best-effort, not a security boundary** — destructive
  Bash detection is regex-based and can be bypassed by a determined caller
  (e.g. `eval` chains). Use `trusted` tier for people you'd hand the keyboard
  to. For people you wouldn't, leave them in default (guest) tier.
- **Codex tier enforcement is coarser than Claude's** — the Codex SDK has no
  per-tool callback. Trusted users on Codex get `workspace-write` sandbox +
  `never` approval, which means destructive operations *within the workspace
  cwd* are still possible. The guest tier on Codex uses `read-only` sandbox,
  which is solid.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document 3-tier permission model + caveats

Adds Permission tiers subsection under Access control. Lists known
limitations (best-effort destructive detection; Codex coarse-grained
tier mapping)."
```

---

## Task 17: e2e acceptance — guest can't run Bash, admin can

**Files:**
- Create: `src/daemon/__e2e__/user-tier.e2e.test.ts`

End-to-end test that boots a real daemon (with fake ilink + fake SDK) and verifies tier enforcement.

- [ ] **Step 1: Write the test**

Create `src/daemon/__e2e__/user-tier.e2e.test.ts`:

```ts
/**
 * E2E — user-tier enforcement.
 *
 * Boots the daemon with two chats:
 *   - 'admin_chat'   in access.admins
 *   - 'guest_chat'   in access.allowFrom (not admin, not trusted → guest)
 *
 * Sends an inbound from each that asks Claude to run `Bash(ls /)`.
 * Verifies:
 *   - guest's session was created with disallowedTools including 'Bash'
 *   - admin's session was created with permissionMode='bypassPermissions'
 *   - the two have distinct session_ids in the sessions table
 */
import { describe, it, expect, afterEach } from 'vitest'
import { startTestDaemon } from './harness'

describe('user-tier e2e', () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>> | null = null

  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = null } })

  it('guest and admin get different sessions on the same alias', async () => {
    // Fake claude that records which Options it was spawned with
    const spawnOptions: Array<Record<string, unknown>> = []

    daemon = await startTestDaemon({
      knownUsers: { admin_chat: 'admin', guest_chat: 'guest' },
      claudeScript: {
        recordSpawnOptions: (o) => spawnOptions.push(o),
        // ...
      },
      access: {
        allowFrom: ['admin_chat', 'guest_chat'],
        admins: ['admin_chat'],
      },
    })

    daemon.sendText('admin_chat', 'hi')
    await daemon.waitForReplyTo('admin_chat', 10_000)
    daemon.sendText('guest_chat', 'hi')
    await daemon.waitForReplyTo('guest_chat', 10_000)

    expect(spawnOptions.length).toBeGreaterThanOrEqual(2)
    const adminOpts = spawnOptions.find(o => o.permissionMode === 'bypassPermissions')
    expect(adminOpts).toBeDefined()
    const guestOpts = spawnOptions.find(o => Array.isArray((o as { disallowedTools?: string[] }).disallowedTools))
    expect(guestOpts).toBeDefined()
    expect((guestOpts as { disallowedTools: string[] }).disallowedTools).toContain('Bash')
  })

  it('tier change invalidates running sessions', async () => {
    daemon = await startTestDaemon({
      knownUsers: { c: 'tester' },
      access: { allowFrom: ['c'], admins: ['c'] },
    })

    daemon.sendText('c', 'hi')
    await daemon.waitForReplyTo('c', 10_000)
    const sessionsBefore = /* read sessions table for 'c' */ []

    // Demote c to guest
    daemon.rewriteAccess({ allowFrom: ['c'], admins: [] })
    daemon.sendText('c', 'hi again')
    await daemon.waitForReplyTo('c', 10_000)

    const sessionsAfter = /* read sessions table for 'c' */ []
    // After demotion + new inbound, a new session_id should exist
    expect(sessionsAfter).not.toEqual(sessionsBefore)
  })
})
```

The exact harness signature (whether it accepts `access`, whether `claudeScript` can record opts, etc.) depends on the existing `__e2e__/harness.ts`. Inspect it and adapt — if the harness doesn't already support `recordSpawnOptions`, extend it minimally (add a callback the fake-sdk wires up).

- [ ] **Step 2: Run**

Run: `bun --bun vitest run -c vitest.e2e.config.ts src/daemon/__e2e__/user-tier.e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Run full e2e suite**

Run: `bun --bun vitest run -c vitest.e2e.config.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/__e2e__/user-tier.e2e.test.ts src/daemon/__e2e__/harness.ts
git commit -m "test(e2e): user-tier enforcement + invalidation on access change

End-to-end test: two chats on the same alias get different sessions
with the right SDK options; tier demotion invalidates the live
session and forces re-spawn with the new tier."
```

---

## Acceptance gate

MVP is done when ALL of these are true:

- [ ] `bun run typecheck` is clean
- [ ] `bun --bun vitest run` passes the full unit suite
- [ ] `bun --bun vitest run -c vitest.e2e.config.ts` passes the full e2e suite
- [ ] `bun --bun vitest run eval/companion/ -c vitest.eval-engine.config.ts` passes the eval harness's own tests
- [ ] An admin chat can run Bash on the running daemon (manual check or e2e test)
- [ ] A guest chat cannot run Bash — the agent replies refusing the tool call or staying silent (manual check or e2e test)
- [ ] A trusted chat asking the agent to run `rm somefile` triggers a permission prompt to the admin chat (manual check)
- [ ] Editing access.json to demote an admin to guest, then sending a message from that chat, results in `[ACCESS] tier membership changed — invalidating all live sessions` in the log and a new SDK session

## Self-review notes (for the executing engineer)

- The signatures of `sessionManager.acquire` / `release` / `isInFlight` change to options objects. Use `grep -rn "manager\.acquire" src/ | grep -v test` after each task to catch any caller you forgot to update.
- `permissionMode` exists in TWO namespaces: the daemon's enum (`'strict' | 'dangerously'`) used by capability-matrix, and the Claude SDK's option (`'default' | 'bypassPermissions' | ...`) used in `Options`. The plan's helpers (`tierProfileToClaudeSdkOpts`) emit the SDK shape; the daemon's `PermissionMode` enum is unchanged.
- The DB migration v10 (Task 7) is one-way — once a daemon boots and upgrades, downgrading to a pre-v10 binary won't work because the schema differs. Document in the release notes.
- If you find that `sdkOptionsForProject` is called from places I missed (e.g., a delegate path), the engineer's job is to thread `tierProfile` through there too. The signature change is intentional — TypeScript will tell you everywhere.
- If `claudeScript` in `harness.ts` doesn't expose a way to record spawn Options for the e2e test, you may have to extend the harness's fake-sdk to call a hook. Keep the hook surface minimal — single callback that takes the raw Options object.
- The `summarizer-runtime.ts` traversal of `sessionStore.all()` needs careful migration. The return shape changed from `Record<alias, SessionRecord>` to `Record<alias|provider|chatId, SessionRecord>`. The loop body that currently treats keys as aliases needs to read `rec.alias` (a field we add in Task 8) instead. Don't skip that — it's tested and will surface in unit tests if missed.
