# On-demand `locate_file` + learned locations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the admin an MCP tool to find files on their own computer on demand (by name, with a content fallback, plus a browse mode), returning metadata only; the agent reads the chosen file with its existing `Read` and remembers locations in `locations.md`.

**Architecture:** A pure, stateless `locateFiles()` core in `lib/` does a bounded filesystem walk over default life dirs + caller-supplied roots. An admin-tier internal-api route `GET /v1/locate` wraps it. An admin-only `locate_file` MCP tool calls that route, gated exactly like the existing daemon-control tools (new `ToolKind 'file_locate'` in `ADMIN_ONLY`, registered only for admin sessions). A prompt section tells the admin agent when to use it and to record finds in `locations.md`.

**Tech Stack:** TypeScript, Node `node:fs`, Vitest (`bun --bun vitest run`), `zod` (MCP input schemas), `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-06-28-locate-file-on-demand-design.md`

**Planning-time refinement vs spec (functional outcome unchanged):** the spec said the *route* reads `locations.md` to seed roots. The wechat MCP child has no chatId env (only `WECHAT_SESSION_TIER` / `WECHAT_SESSION_TOKEN`), so a stateless route can't resolve *which admin's* `locations.md`. Instead: the **agent** (which already reads its memory every turn) passes known directories via an optional `roots` param, and the route searches `roots + default life dirs`. `locations.md` stays pure agent memory (direct path mappings let the agent answer/`Read` instantly; new finds are appended via the existing `memory_write`). Learned locations still get used — the responsibility just moves from route to agent, removing route↔memory coupling.

## Global Constraints

- **Admin-only, double-gated.** Tool registers only when `process.env.WECHAT_SESSION_TIER === 'admin'` (same gate as `tools-daemon.ts`); route is admin-tier in `route-tiers.ts`. Non-admin: tool absent AND route 403.
- **No embeddings, no background index, no stored file content.** Retrieval is a stateless live bounded walk per call. Route returns metadata only — never file contents.
- **No file writes/moves/renames.** Locate + read only.
- **Layering:** `locateFiles()` lives in `src/lib/` (pure; no `src/daemon` or `src/core` imports). `daemon → lib` is allowed; `daemon → cli` is not.
- **Bounded walk:** default limits `maxDepth 6`, `maxEntries 20000`, `maxResults 10`, `timeoutMs 4000`, `grepMaxFiles 200`, `grepMaxBytesPerFile 262144`. Always return partial + `truncated:true` rather than run unbounded.
- **Default life dirs:** `~/Desktop`, `~/Documents`, `~/Downloads` (resolved via `os.homedir()`), defined in exactly one place (`routes-files.ts`).
- **Skip dirs** during walk: `node_modules`, `.git`, `Library`, `.Trash`, `.cache`; skip dotfiles/dotdirs.
- **Test runner:** single file → `bun --bun vitest run <path>`. Typecheck → `npm run typecheck` (`tsc --noEmit`). Commit after each task.

---

## File structure

- Create `src/lib/locate-files.ts` — pure `locateFiles()` core + types + `DEFAULT_LIMITS`.
- Create `src/lib/locate-files.test.ts` — unit tests against temp-dir fixtures.
- Create `src/daemon/internal-api/routes-files.ts` — `fileRoutes()` (`GET /v1/locate`) + `defaultLifeDirs()`.
- Create `src/daemon/internal-api/routes-files.test.ts` — route handler tests.
- Create `src/mcp-servers/wechat/tools-files.ts` — `registerFileTools(server, client)`.
- Modify `src/core/user-tier.ts` — `ToolKind` union, `ALL_KINDS`, `ADMIN_ONLY`, `classifyToolUse`.
- Modify `src/core/claude-agent-provider.ts:26` — add `file_locate: []` to `TOOL_KIND_TO_CLAUDE_BUILTINS`.
- Modify `src/daemon/internal-api/route-tiers.ts:64` — add `'GET /v1/locate': 'admin'`.
- Modify `src/daemon/internal-api/routes.ts:449` — spread `...fileRoutes()`.
- Modify `src/mcp-servers/wechat/main.ts:103` — register file tools under `SESSION_IS_ADMIN`.
- Modify `src/core/prompt-builder.ts` — `fileLocateAvailable` arg + `fileLocateSection()`.
- Modify `src/daemon/bootstrap/index.ts:780` — pass `fileLocateAvailable`.
- Modify `src/core/user-tier.test.ts`, `src/core/prompt-builder.test.ts`, `src/mcp-servers/wechat/integration.test.ts` — assertions.

---

### Task 1: Pure `locateFiles()` core

**Files:**
- Create: `src/lib/locate-files.ts`
- Test: `src/lib/locate-files.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type Candidate = { path: string; name: string; dir: string; bytes: number; mtime: string; isDir: boolean; score: number }`
  - `interface LocateLimits { maxDepth; maxEntries; maxResults; timeoutMs; grepMaxFiles; grepMaxBytesPerFile }` (all `number`)
  - `const DEFAULT_LIMITS: LocateLimits`
  - `interface LocateOpts { roots: string[]; query?: string; mode: 'name'|'content'|'browse'; limits?: Partial<LocateLimits>; now?: () => number }`
  - `interface LocateResult { candidates: Candidate[]; scannedEntries: number; truncated: boolean }`
  - `function locateFiles(opts: LocateOpts): LocateResult`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/locate-files.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateFiles } from './locate-files'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wcc-locate-'))
  mkdirSync(join(root, 'work'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'work', 'Q3预算.xlsx'), 'col,val\nrevenue,100')
  writeFileSync(join(root, 'work', 'notes.txt'), '关于预算的讨论纪要')
  writeFileSync(join(root, 'random.pdf'), 'unrelated')
  writeFileSync(join(root, 'node_modules', 'pkg', '预算.js'), 'noise')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('locateFiles', () => {
  it('name mode matches on filename and ranks name-hits first', () => {
    const r = locateFiles({ roots: [root], query: '预算', mode: 'name' })
    const names = r.candidates.map(c => c.name)
    expect(names).toContain('Q3预算.xlsx')
    expect(names).not.toContain('notes.txt')        // body match, not name → excluded in name mode
    expect(names).not.toContain('预算.js')           // under node_modules → skipped
    expect(r.candidates[0]!.name).toBe('Q3预算.xlsx') // name hit ranks first
  })

  it('content mode falls back to body matches when filename misses', () => {
    const r = locateFiles({ roots: [root], query: '讨论纪要', mode: 'content' })
    expect(r.candidates.map(c => c.name)).toContain('notes.txt')
  })

  it('browse mode lists immediate children (files + dirs), no recursion', () => {
    const r = locateFiles({ roots: [root], mode: 'browse' })
    const names = r.candidates.map(c => c.name)
    expect(names).toEqual(expect.arrayContaining(['work', 'random.pdf']))
    expect(r.candidates.find(c => c.name === 'work')!.isDir).toBe(true)
    expect(names).not.toContain('Q3预算.xlsx')        // child of work/, not listed (depth 0 only)
  })

  it('tolerates a missing root and truncates on maxEntries', () => {
    const r = locateFiles({
      roots: [join(root, 'does-not-exist'), root],
      query: 'x', mode: 'name', limits: { maxEntries: 1 },
    })
    expect(r.truncated).toBe(true)
    expect(r.scannedEntries).toBeGreaterThan(0)
  })

  it('searches caller-supplied roots before defaults are appended by the route (order preserved)', () => {
    const r = locateFiles({ roots: [join(root, 'work'), root], query: '预算', mode: 'name' })
    expect(r.candidates[0]!.name).toBe('Q3预算.xlsx')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/lib/locate-files.test.ts`
Expected: FAIL — "Failed to resolve import './locate-files'" / `locateFiles is not a function`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/locate-files.ts
/**
 * locate-files — stateless bounded filesystem search for the admin's own files.
 * Pure (no daemon/cli imports); the internal-api route wraps it. No index, no
 * embeddings — a live walk each call. Returns metadata only, never file bodies.
 */
import { readdirSync, statSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

export interface Candidate {
  path: string   // absolute file/dir path
  name: string   // basename
  dir: string    // absolute parent dir
  bytes: number  // 0 for dirs
  mtime: string  // ISO; '' if unstatable
  isDir: boolean
  score: number
}

export interface LocateLimits {
  maxDepth: number
  maxEntries: number
  maxResults: number
  timeoutMs: number
  grepMaxFiles: number
  grepMaxBytesPerFile: number
}

export const DEFAULT_LIMITS: LocateLimits = {
  maxDepth: 6,
  maxEntries: 20_000,
  maxResults: 10,
  timeoutMs: 4_000,
  grepMaxFiles: 200,
  grepMaxBytesPerFile: 256 * 1024,
}

export interface LocateOpts {
  roots: string[]
  query?: string
  mode: 'name' | 'content' | 'browse'
  limits?: Partial<LocateLimits>
  now?: () => number
}

export interface LocateResult {
  candidates: Candidate[]
  scannedEntries: number
  truncated: boolean
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'Library', '.Trash', '.cache'])

function meta(path: string, name: string, dir: string, isDir: boolean, score: number): Candidate {
  let bytes = 0
  let mtime = ''
  try { const st = statSync(path); bytes = isDir ? 0 : st.size; mtime = st.mtime.toISOString() } catch { /* unstatable */ }
  return { path, name, dir, bytes, mtime, isDir, score }
}

function scoreName(query: string, name: string, rel: string): number {
  const q = query.toLowerCase()
  if (name.toLowerCase().includes(q)) return 3
  if (rel.toLowerCase().includes(q)) return 1
  return 0
}

function grepHit(path: string, query: string, maxBytes: number): boolean {
  try {
    const buf = readFileSync(path)
    const text = buf.subarray(0, maxBytes).toString('utf8')
    return text.toLowerCase().includes(query.toLowerCase())
  } catch { return false }
}

export function locateFiles(opts: LocateOpts): LocateResult {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) }
  const nowFn = opts.now ?? Date.now
  const deadline = nowFn() + limits.timeoutMs
  const query = (opts.query ?? '').trim()
  const roots = [...new Set(opts.roots)]
  const out: Candidate[] = []
  let scanned = 0
  let truncated = false
  let grepped = 0

  // browse: list immediate children (files + dirs) of each root, no recursion.
  if (opts.mode === 'browse') {
    for (const r of roots) {
      let entries: Dirent[]
      try { entries = readdirSync(r, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        scanned++
        if (scanned > limits.maxEntries || nowFn() > deadline) { truncated = true; break }
        out.push(meta(join(r, e.name), e.name, r, e.isDirectory(), 0))
      }
    }
    out.sort((a, b) => b.mtime.localeCompare(a.mtime))
    return { candidates: out.slice(0, limits.maxResults), scannedEntries: scanned, truncated: truncated || out.length > limits.maxResults }
  }

  // name / content: recursive bounded walk; only matches are returned.
  outer: for (const r of roots) {
    const stack: Array<[string, number]> = [[r, 0]]
    while (stack.length) {
      const [dir, depth] = stack.pop()!
      let entries: Dirent[]
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        scanned++
        if (scanned > limits.maxEntries || nowFn() > deadline) { truncated = true; break outer }
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && depth + 1 <= limits.maxDepth) stack.push([full, depth + 1])
          continue
        }
        if (!e.isFile() || !query) continue
        const rel = full.slice(r.length).replace(/^[/\\]+/, '')
        let score = scoreName(query, e.name, rel)
        if (score === 0 && opts.mode === 'content' && grepped < limits.grepMaxFiles) {
          grepped++
          if (grepHit(full, query, limits.grepMaxBytesPerFile)) score = 1
        }
        if (score > 0) out.push(meta(full, e.name, dir, false, score))
      }
    }
  }
  out.sort((a, b) => b.score - a.score || b.mtime.localeCompare(a.mtime))
  return { candidates: out.slice(0, limits.maxResults), scannedEntries: scanned, truncated: truncated || out.length > limits.maxResults }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun --bun vitest run src/lib/locate-files.test.ts && npm run typecheck`
Expected: PASS (5 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/locate-files.ts src/lib/locate-files.test.ts
git commit -m "feat(locate): pure bounded locateFiles core (name/content/browse)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `file_locate` ToolKind + tier gating

**Files:**
- Modify: `src/core/user-tier.ts` (union ~:20, `ALL_KINDS` :38, `ADMIN_ONLY` :83, `classifyToolUse` :199)
- Modify: `src/core/claude-agent-provider.ts:26` (`TOOL_KIND_TO_CLAUDE_BUILTINS`)
- Test: `src/core/user-tier.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ToolKind` gains `'file_locate'`; `classifyToolUse('mcp__wechat__locate_file', {}) === 'file_locate'`; `TIER_PROFILES.admin.allow.has('file_locate') === true`, `TIER_PROFILES.trusted.deny.has('file_locate') === true`.

- [ ] **Step 1: Write the failing test** (append to `src/core/user-tier.test.ts`)

```typescript
import { classifyToolUse, TIER_PROFILES } from './user-tier'

describe('file_locate tier kind', () => {
  it('classifies locate_* wechat tools as file_locate (admin-only, prefix fail-closed)', () => {
    expect(classifyToolUse('mcp__wechat__locate_file', {})).toBe('file_locate')
    expect(classifyToolUse('mcp__wechat__locate_anything', {})).toBe('file_locate')
  })
  it('admin allows file_locate; trusted and guest deny it', () => {
    expect(TIER_PROFILES.admin.allow.has('file_locate')).toBe(true)
    expect(TIER_PROFILES.admin.relay.has('file_locate')).toBe(false)
    expect(TIER_PROFILES.trusted.deny.has('file_locate')).toBe(true)
    expect(TIER_PROFILES.guest.deny.has('file_locate')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/core/user-tier.test.ts`
Expected: FAIL — `classifyToolUse` returns `'fs_read'` for `locate_file`; `admin.allow.has('file_locate')` is false. Also `npm run typecheck` FAILS: `TOOL_KIND_TO_CLAUDE_BUILTINS` missing key `file_locate` (Record is exhaustive).

- [ ] **Step 3: Apply the changes**

In `src/core/user-tier.ts`, add to the `ToolKind` union (after the `daemon_remediate` line ~:36):

```typescript
  | 'file_locate'        // admin-only: locate files on the owner's computer (lib/locate-files)
```

Add `'file_locate'` to the `ALL_KINDS` set (extend the `'a2a_send', 'daemon_introspect', 'daemon_remediate',` line):

```typescript
  'a2a_send', 'daemon_introspect', 'daemon_remediate', 'file_locate',
```

Extend `ADMIN_ONLY` (:83) — file_locate is read-only (admin allow, not relay):

```typescript
const ADMIN_ONLY = new Set<ToolKind>(['daemon_introspect', 'daemon_remediate', 'file_locate'])
```

In `classifyToolUse` (:199), add the prefix rule just before the `return 'fs_read'` default (after the `daemon_`/`session_`/`model_set` line ~:216):

```typescript
    // File-locate family — admin-only, classified by PREFIX so a sibling
    // (locate_dir, …) fails CLOSED into file_locate, not the fs_read default.
    if (sub.startsWith('locate_')) return 'file_locate'
```

In `src/core/claude-agent-provider.ts`, add to `TOOL_KIND_TO_CLAUDE_BUILTINS` (after the `daemon_remediate: [],` line :42):

```typescript
  file_locate: [],         // MCP-only (mcp__wechat__locate_file), gated by canUseTool
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun --bun vitest run src/core/user-tier.test.ts && npm run typecheck`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/user-tier.ts src/core/user-tier.test.ts src/core/claude-agent-provider.ts
git commit -m "feat(tier): admin-only file_locate ToolKind (prefix fail-closed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `GET /v1/locate` internal-api route

**Files:**
- Create: `src/daemon/internal-api/routes-files.ts`
- Create: `src/daemon/internal-api/routes-files.test.ts`
- Modify: `src/daemon/internal-api/routes.ts` (import + spread at :449)
- Modify: `src/daemon/internal-api/route-tiers.ts:64` (add route entry)

**Interfaces:**
- Consumes: `locateFiles` (Task 1); `RouteTable`/handler shape from `./types` — a `GET` handler is `(q: URLSearchParams) => { status, body }`.
- Produces: `function fileRoutes(): RouteTable`; `function defaultLifeDirs(home?: string): string[]`; route `'GET /v1/locate'` → `{ status:200, body:{ candidates, truncated } }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/internal-api/routes-files.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileRoutes, defaultLifeDirs } from './routes-files'
import { minTierFor } from './route-tiers'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wcc-routes-files-'))
  writeFileSync(join(dir, '预算表.xlsx'), 'x')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('GET /v1/locate', () => {
  const handler = () => fileRoutes()['GET /v1/locate']!

  it('returns candidates from caller-supplied roots', async () => {
    const q = new URLSearchParams({ q: '预算', mode: 'name' })
    q.append('root', dir)
    const res = await handler()(q, undefined)
    expect(res.status).toBe(200)
    const body = res.body as { candidates: Array<{ name: string }>; truncated: boolean }
    expect(body.candidates.map(c => c.name)).toContain('预算表.xlsx')
  })

  it('ignores non-absolute roots and defaults mode to browse when no query', async () => {
    const res = await handler()(new URLSearchParams(), undefined)
    expect(res.status).toBe(200)
  })

  it('default life dirs are Desktop/Documents/Downloads under home', () => {
    expect(defaultLifeDirs('/home/me')).toEqual(['/home/me/Desktop', '/home/me/Documents', '/home/me/Downloads'])
  })

  it('route is admin-tier', () => {
    expect(minTierFor('GET /v1/locate')).toBe('admin')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/internal-api/routes-files.test.ts`
Expected: FAIL — cannot resolve `./routes-files`; `minTierFor('GET /v1/locate')` returns `'admin'` only after the entry is added (the default is also admin, so this sub-assertion may pass early — the import failure is the hard failure).

- [ ] **Step 3: Create the route module**

```typescript
// src/daemon/internal-api/routes-files.ts
/**
 * internal-api file-locate route — admin-only on-demand file search over the
 * owner's computer. Stateless: wraps the pure lib/locate-files core. Searches
 * caller-supplied roots (the agent passes dirs it learned in locations.md)
 * followed by the default life dirs. Returns metadata only — never file bodies.
 * Admin-tier per route-tiers.ts.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type RouteTable } from './types'
import { locateFiles } from '../../lib/locate-files'

/** The zero-config default search roots. Single source of truth. */
export function defaultLifeDirs(home: string = homedir()): string[] {
  return [join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads')]
}

export function fileRoutes(): RouteTable {
  return {
    'GET /v1/locate': (q) => {
      const query = q.get('q') ?? undefined
      const raw = q.get('mode') ?? (query ? 'name' : 'browse')
      const mode = (raw === 'content' || raw === 'browse') ? raw : 'name'
      const extraRoots = q.getAll('root').filter(r => r.startsWith('/'))   // absolute only
      const roots = [...extraRoots, ...defaultLifeDirs()]
      const { candidates, truncated } = locateFiles({ roots, query, mode })
      return { status: 200, body: { candidates, truncated } }
    },
  }
}
```

- [ ] **Step 4: Wire it into the route table**

In `src/daemon/internal-api/routes.ts`, add the import near the other route-group imports (after line 16):

```typescript
import { fileRoutes } from './routes-files'
```

and add the spread alongside the others (after `...daemonControlRoutes(deps),` at :449):

```typescript
    ...fileRoutes(),
```

In `src/daemon/internal-api/route-tiers.ts`, add to `ROUTE_MIN_TIER` after the daemon-control admin block (after line 63):

```typescript
  // admin — on-demand file locate over the owner's computer (file_locate)
  'GET /v1/locate': 'admin',
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun --bun vitest run src/daemon/internal-api/routes-files.test.ts src/daemon/internal-api/route-tiers.test.ts src/daemon/internal-api/schema.test.ts && npm run typecheck`
Expected: PASS (new route tests pass; existing route-tiers + schema/count tests unchanged — the route is inline, not in the schema table), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/internal-api/routes-files.ts src/daemon/internal-api/routes-files.test.ts src/daemon/internal-api/routes.ts src/daemon/internal-api/route-tiers.ts
git commit -m "feat(api): admin-tier GET /v1/locate over lib/locate-files

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `locate_file` MCP tool (admin-only)

**Files:**
- Create: `src/mcp-servers/wechat/tools-files.ts`
- Modify: `src/mcp-servers/wechat/main.ts` (import + register under `SESSION_IS_ADMIN`)
- Test: `src/mcp-servers/wechat/integration.test.ts`

**Interfaces:**
- Consumes: `InternalApiClient` (`./client`), `passthroughErrorResult` (`./tool-helpers`), the `GET /v1/locate` route (Task 3), `SESSION_IS_ADMIN` (main.ts:59).
- Produces: `function registerFileTools(server: McpServer, client: InternalApiClient): void` registering tool `locate_file`.

- [ ] **Step 1: Write the failing test** (extend the admin-tools listing in `src/mcp-servers/wechat/integration.test.ts`)

Add `'locate_file'` to the `DAEMON_TOOLS` array (line ~92) and add an assertion that admin sessions list it. If there is an existing test that boots an admin session and asserts `DAEMON_TOOLS` are listed, this is covered; otherwise add:

```typescript
  it('lists locate_file for an admin session', async () => {
    process.env.WECHAT_SESSION_TIER = 'admin'   // mirror how the existing admin-tool test sets the gate
    const { client } = await bootChain()
    const list = await client.listTools()
    expect(list.tools.map(t => t.name)).toContain('locate_file')
  })
```

(Match the existing admin-tool test's exact setup for `WECHAT_SESSION_TIER` — reuse its pattern rather than the line above if it differs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/mcp-servers/wechat/integration.test.ts`
Expected: FAIL — `locate_file` not in the listed tools.

- [ ] **Step 3: Create the tool module**

```typescript
// src/mcp-servers/wechat/tools-files.ts
/**
 * wechat-mcp file tools — admin-only on-demand file locate over the owner's
 * computer. Registered ONLY for an admin-tier session (SESSION_IS_ADMIN gate in
 * main.ts). Thin wrapper over GET /v1/locate; same shape as the daemon tools.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerFileTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'locate_file',
    {
      title: 'Locate a file on the owner’s computer',
      description: '【管理员】在主人电脑的常用位置（桌面/文档/下载，加上你在 locations.md 里记过的目录）找文件。query=关键词；mode 默认 name（只匹配文件名/路径，快、不读内容），文件名找不到再用 mode=content（在内容里搜，慢）；mode=browse 列出某目录大致有什么。roots 可选：传你已知的绝对路径目录会优先搜。返回候选路径+大小+修改时间（不含文件内容）——选中后用 Read 打开，并把「这是什么 → 路径」记进 locations.md；都找不到就在微信问主人一句它一般放哪，再把那个目录记进 locations.md。',
      inputSchema: {
        query: z.string().optional().describe('关键词；mode=browse 时可省略'),
        mode: z.enum(['name', 'content', 'browse']).optional(),
        roots: z.array(z.string()).optional().describe('可选：已知的绝对路径目录，优先搜'),
      },
    },
    async ({ query, mode, roots }) => {
      try {
        const qs = new URLSearchParams()
        if (query) qs.set('q', query)
        if (mode) qs.set('mode', mode)
        for (const r of roots ?? []) qs.append('root', r)
        const r = await client.request<unknown>('GET', `/v1/locate${qs.toString() ? `?${qs}` : ''}`)
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'locate_file')
      }
    },
  )
}
```

- [ ] **Step 4: Register it under the admin gate**

In `src/mcp-servers/wechat/main.ts`, add the import next to `registerDaemonTools` (after line 29):

```typescript
import { registerFileTools } from './tools-files'
```

and register inside the existing `if (SESSION_IS_ADMIN) {` block (after `registerDaemonTools(server, client)` at :103):

```typescript
  registerFileTools(server, client)
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun --bun vitest run src/mcp-servers/wechat/integration.test.ts && npm run typecheck`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-servers/wechat/tools-files.ts src/mcp-servers/wechat/main.ts src/mcp-servers/wechat/integration.test.ts
git commit -m "feat(mcp): admin-only locate_file tool over GET /v1/locate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Prompt nudge + `locations.md` behavior

**Files:**
- Modify: `src/core/prompt-builder.ts` (`BuildSystemPromptArgs` ~:49, `buildSystemPrompt` section list ~:65, new `fileLocateSection()` near `daemonSelfHealSection` :149)
- Modify: `src/daemon/bootstrap/index.ts:780` (`buildInstructions` thunk args)
- Test: `src/core/prompt-builder.test.ts`

**Interfaces:**
- Consumes: `tierProfile.allow.has('file_locate')` (Task 2) as the gate predicate.
- Produces: `BuildSystemPromptArgs.fileLocateAvailable?: boolean`; section markers `locate_file` and `locations.md` present iff true.

- [ ] **Step 1: Write the failing test** (append to `src/core/prompt-builder.test.ts`)

```typescript
import { buildSystemPrompt } from './prompt-builder'

describe('file-locate prompt section', () => {
  const base = { providerId: 'claude' as const, peerProviderId: 'codex' as const, companionEnabled: false, delegateAvailable: false }
  it('includes the locate section + locations.md guidance when fileLocateAvailable', () => {
    const p = buildSystemPrompt({ ...base, fileLocateAvailable: true })
    expect(p).toContain('locate_file')
    expect(p).toContain('locations.md')
  })
  it('omits it otherwise', () => {
    const p = buildSystemPrompt({ ...base })
    expect(p).not.toContain('locate_file')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/core/prompt-builder.test.ts`
Expected: FAIL — prompt does not contain `locate_file`; `fileLocateAvailable` not a known arg (tsc error too).

- [ ] **Step 3: Add the arg, section, and gating**

In `src/core/prompt-builder.ts`, add to `BuildSystemPromptArgs` (after the `daemonOpsAvailable?: boolean` field ~:49):

```typescript
  /**
   * When true, this session is admin-tier and the wechat-mcp `locate_file` tool
   * is registered. Adds the file-locate section so the agent knows to find the
   * owner's files on demand and record locations. Pass
   * `tierProfile.allow.has('file_locate')`. Default false.
   */
  fileLocateAvailable?: boolean
```

Add to the `sections` array in `buildSystemPrompt` (right after the daemon self-heal line :65, before `memorySection()` so it sits next to memory guidance):

```typescript
    args.fileLocateAvailable ? fileLocateSection() : '',
```

Add the section function next to `daemonSelfHealSection` (after its closing `}` ~:157):

```typescript
export function fileLocateSection(): string {
  return `## 找主人电脑里的文件（管理员）

当主人提到某个文件/文档（「那个预算表」「桌面上那个合同」），别说你看不到——你能找：
- 先看记忆里的 \`locations.md\`：若已记过「这是什么 → 路径」，直接用 \`Read\` 打开。
- 没记过就用 \`locate_file\`：query 给关键词，先 name 模式；文件名没命中再 \`mode=content\`；想看某目录大致有什么用 \`mode=browse\`。把 \`locations.md\` 里相关的目录用 \`roots\` 传进去会优先搜。
- 找到并确认后，用 \`Read\` 打开来回答，并用 \`memory_write\` 往 \`locations.md\` 追一行「这是什么 → 绝对路径」，下次直接命中。
- 实在找不到，就在微信问主人一句「X 一般放哪？」（只问这一次），拿到答案把那个目录记进 \`locations.md\`。
范围是用出来的，不是让主人配置出来的。`
}
```

- [ ] **Step 4: Pass the flag from bootstrap**

In `src/daemon/bootstrap/index.ts`, in the `buildInstructions` thunk's `buildSystemPrompt({ ... })` call (alongside `daemonOpsAvailable: tierProfile.allow.has('daemon_introspect'),` at :786):

```typescript
      fileLocateAvailable: tierProfile.allow.has('file_locate'),
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun --bun vitest run src/core/prompt-builder.test.ts && npm run typecheck`
Expected: PASS, tsc clean.

- [ ] **Step 6: Full suite + commit**

Run: `bun --bun vitest run && npm run typecheck`
Expected: full suite PASS, tsc clean.

```bash
git add src/core/prompt-builder.ts src/core/prompt-builder.test.ts src/daemon/bootstrap/index.ts
git commit -m "feat(prompt): admin file-locate section + locations.md behavior

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:**
- On-demand retrieval by name + content fallback + browse → Task 1 (core), Task 3 (route), Task 4 (tool). ✓
- Admin-only, double-gated → Task 2 (ToolKind in `ADMIN_ONLY`, classify), Task 3 (route-tier), Task 4 (`SESSION_IS_ADMIN` registration). ✓
- No embeddings / no index / metadata-only → Task 1 (live walk, `meta()` returns no body), Task 3 (returns candidates only). ✓
- `locations.md` learned locations → Task 5 (agent reads/writes via existing `memory_*`; route accepts `roots`). The spec's "route reads locations.md" is refined to "agent passes roots" (documented in header; same outcome, no identity coupling). ✓
- Bounded walk (depth/entries/results/timeout/grep caps, skip dirs) → Task 1 `DEFAULT_LIMITS` + `SKIP_DIRS`. ✓
- Default life dirs Desktop/Documents/Downloads, one source of truth → Task 3 `defaultLifeDirs`. ✓
- Prompt nudge gated on admin → Task 5. ✓
- Non-goals (no write/move, no ambient survey, no multi-user) → nothing implements them. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows command + expected output. ✓

**Type consistency:** `Candidate`, `LocateOpts`, `LocateResult`, `locateFiles`, `fileRoutes`, `defaultLifeDirs`, `registerFileTools`, `fileLocateSection`, `fileLocateAvailable`, `file_locate` used identically across tasks. The route handler signature `(q: URLSearchParams) => {status, body}` matches the existing `GET /v1/turns` handler in `routes-daemon-control.ts`. The one compiler-exhaustive `Record<ToolKind>` (`TOOL_KIND_TO_CLAUDE_BUILTINS`) is updated in Task 2; codex has no such map. ✓
