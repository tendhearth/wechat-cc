# Spec — `memory_delete` Safety Design

**Status**: Draft · 2026-05-21
**Parent**: PR #50 (memory_delete pulled per Codex review finding A); builds on PR #51 (`MemoryFS` realpath sandbox)
**Expected effort**: 1.5–2 h
**Supersedes**: the hard-delete `memory_delete` tool removed in PR #50

---

## 0. Why this needs its own spec

The original `memory_delete` MCP tool (PR #50) was a thin wrapper around `MemoryFS.delete` — agent calls it, daemon hard-unlinks the file. Codex review surfaced **two distinct safety gaps**:

1. **Provider asymmetry** — Codex strict-mode has `askUser: 'never'` in the capability matrix, so `canUseTool` never prompts the user. An agent in `/codex` or `/both` can silently delete memory files; the same tool in `/cc` would trigger a WeChat permission prompt. The asymmetry is invisible to users.
2. **Irreversibility** — even with user approval, a typo'd path or a misinterpreted "forget X" instruction permanently destroys data. Memory holds the agent's accumulated understanding of the user; one bad delete sets the relationship back weeks.

This spec resolves both via a **soft-delete-only contract** in v1, deferring hard-delete to a separate `memory_purge` tool in v2 if a real need surfaces.

PR #51 (realpath sandbox) is a prerequisite — guarantees the delete operates on a path actually inside `memory/`, not a symlink escape.

---

## 1. Non-goals

- **Hard delete in v1.** Hard-unlink behavior moves to a hypothetical future `memory_purge` tool with full user confirmation. Not building that here.
- **A `memory_restore` MCP tool.** Restoration is manual filesystem operation in v1 (instructions in the agent-facing description). If demand surfaces, add later.
- **Cross-chat memory delete.** Tool operates on the agent's own `memory/<chat_id>/` sandbox per the existing `MemoryFS` boundary. No cross-chat delete.
- **Retention policy / auto-purge.** Soft-deleted files accumulate forever. A later janitor task can sweep `*.deleted-*` older than N days; not in this PR.
- **Audit log dashboard surface.** The `memory_deleted` event lands in the SQLite events store; surfacing it on the dashboard is a separate UX PR.

---

## 2. The soft-delete contract

`memory_delete(path)` does NOT call `MemoryFS.delete` (existing hard unlink). Instead, it renames the target to a tombstoned sibling:

```
memory/profile.md → memory/profile.md.deleted-2026-05-21T08-14-32-123Z
```

Properties:

- **Recoverable**: user can `mv memory/profile.md.deleted-* memory/profile.md` from a terminal to restore.
- **Invisible to the agent**: `MemoryFS.list()` skips `.deleted-*` entries (sibling to the existing `.tmp-` skip rule).
- **Idempotent**: deleting an already-soft-deleted file is a no-op (returns ok).
- **Audited**: every soft-delete writes an event with kind `memory_deleted` to the per-chat events table (see §4).

Hard-unlink (`MemoryFS.delete`) stays available internally — used only by tests and any future operator-driven cleanup. The MCP tool **does not** expose it.

---

## 3. `MemoryFS.softDelete` — new method

Add a new method to the `MemoryFS` interface alongside the existing `delete`:

```ts
export interface MemoryFS {
  // ...existing read / write / list / delete...

  /**
   * Soft-delete: rename `relPath` to `relPath.deleted-<ISO>` in place.
   * Returns the new tombstone path (relative, POSIX-normalised) on
   * success, or null if the source file didn't exist.
   *
   * Like `delete`, runs the realpath sandbox check from PR #51. Unlike
   * `delete`, never destroys data — the operator can restore by
   * `mv`-ing the tombstone back. `list()` skips `.deleted-*` so the
   * agent doesn't see them on subsequent calls.
   */
  softDelete(relPath: string): string | null
}
```

Implementation:

```ts
softDelete(relPath) {
  const full = resolveSafe(relPath)
  checkExt(full)
  if (!existsSync(full)) return null
  assertWithinRealRoot(full, true)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const tombstone = `${full}.deleted-${stamp}`
  renameSync(full, tombstone)
  return relative(root, tombstone).split(sep).join('/')
}
```

`list()` filter update:

```ts
// Existing skip rules
if (entry.name.startsWith('.') || entry.name.includes('.tmp-')) continue
// New: skip soft-delete tombstones
if (entry.name.includes('.deleted-')) continue
```

---

## 4. Audit log — new `memory_deleted` event kind

The events store has a CHECK-constrained `kind` column (DB migration v8). Extend the enum + add a migration v10 to relax the constraint.

### 4.1 Schema additions

```ts
// src/daemon/events/store.ts
export type EventKind =
  | 'cron_eval_pushed'
  | 'cron_eval_skipped'
  | 'cron_eval_failed'
  | 'observation_written'
  | 'milestone'
  | 'memory_deleted'  // NEW

export interface EventRecord {
  // ...existing fields...
  memory_path?: string  // NEW — POSIX relative path of soft-deleted file
}
```

### 4.2 DB migration v10

```ts
// src/lib/db.ts migrations[]
(db) => {
  db.exec(`
    CREATE TABLE events_v10 (
      id TEXT PRIMARY KEY NOT NULL,
      chat_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
        'observation_written', 'milestone',
        'memory_deleted'
      )),
      trigger TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      push_text TEXT,
      observation_id TEXT,
      milestone_id TEXT,
      jsonl_session_id TEXT,
      memory_path TEXT
    ) STRICT;
    INSERT INTO events_v10 (id, chat_id, ts, kind, trigger, reasoning,
                            push_text, observation_id, milestone_id, jsonl_session_id)
      SELECT id, chat_id, ts, kind, trigger, reasoning,
             push_text, observation_id, milestone_id, jsonl_session_id FROM events;
    DROP TABLE events;
    ALTER TABLE events_v10 RENAME TO events;
    CREATE INDEX IF NOT EXISTS events_chat_ts ON events(chat_id, ts DESC);
  `)
}
```

### 4.3 Event payload

Each soft-delete writes:

```ts
await events.append({
  kind: 'memory_deleted',
  trigger: 'mcp_tool_call',
  reasoning: <agent-supplied reason from tool input>,
  memory_path: <tombstone relative path>,
})
```

`reasoning` becomes a required-by-convention agent input (see §5). Without it, the audit log says "(no reason given)" — useful for spotting accidental deletes.

---

## 5. MCP tool surface

```ts
server.registerTool(
  'memory_delete',
  {
    title: 'Soft-delete a memory file',
    description:
      '把 memory/ 下的一个 .md 文件"软删除"——重命名为 .deleted-<时间> 后缀。\n' +
      '不进入 list() 结果；用户可在终端 mv 还原。' +
      '\n' +
      '何时调用：用户明确说"忘了/删掉/不要这个了"。不要因为"觉得过时了"主观删除。' +
      '\n' +
      '硬删除：本工具不提供。如果用户要彻底擦除（隐私 / 法律原因），\n' +
      '让他们手动 rm `~/.claude/channels/wechat/memory/<chat>/<path>.deleted-*`。' +
      '\n' +
      '必填 reason：写下用户说了什么 / 你为何认为该删。\n' +
      'reasoning 会进 audit 日志（dashboard 可查），方便事后追溯。',
    inputSchema: {
      path: z.string()
        .max(500, 'path must be <= 500 chars')  // matches MemoryFS internal cap
        .refine(s => !s.includes('\0'), { message: 'path must not contain null bytes' }),
      reason: z.string()
        .min(4, 'reason must be at least 4 chars — quote the user or state your inference')
        .max(500, 'reason must be <= 500 chars'),
    },
  },
  async ({ path, reason }) => {
    try {
      const resp = await client.request<{
        ok: boolean
        tombstone?: string  // POSIX relative
        existed?: boolean   // false if path didn't exist (no-op)
        error?: string
      }>('POST', '/v1/memory/delete', { path, reason })
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'memory_delete')
    }
  },
)
```

Three behavioral notes the description embeds:
- **Soft-only**: explicitly says the tool doesn't hard-delete and points the operator to `rm` for the rare hard case.
- **Trigger criteria**: "user explicitly said forget/delete/don't want" — guards against agent-initiated speculative deletes.
- **`reason` is required** — Zod enforces; daemon writes it to the audit log.

---

## 6. Daemon route + capability gating

`POST /v1/memory/delete` handler:

```ts
// src/daemon/internal-api/routes.ts
'POST /v1/memory/delete': async (_q, body) => {
  if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
  if (!deps.eventsFor) return { status: 503, body: { error: 'events_store_not_wired' } }
  const { path, reason } = body as MemoryDeleteRequestT
  try {
    const tombstone = deps.memory.softDelete(path)
    if (tombstone === null) {
      return { status: 200, body: { ok: true, existed: false } }
    }
    // Audit log lives in the per-chat events store. We pull the chat
    // id from the request context (set by the daemon's auth middleware
    // per the existing /v1/memory/read pattern).
    await deps.eventsFor(_q.chatId).append({
      kind: 'memory_deleted',
      trigger: 'mcp_tool_call',
      reasoning: reason,
      memory_path: tombstone,
    })
    return { status: 200, body: { ok: true, existed: true, tombstone } }
  } catch (err) {
    return { status: 200, body: { ok: false, error: errMsg(err) } }
  }
},
```

**No per-provider gating in v1.** Because the action is now soft and audited, the asymmetry between Claude (with `canUseTool` prompt) and Codex (without) is acceptable: even a silent Codex soft-delete is recoverable AND visible in the audit log. The trade is "Codex requires no prompt" (low friction) for "delete is reversible + auditable" (low blast radius).

If real-world dogfooding shows agents abusing the tool, a v2 follow-up can add provider-aware gating (refuse Codex calls unless `confirm: true` accompanies, etc.). Building it now would be premature.

---

## 7. Tests

### 7.1 `MemoryFS` (unit)

- `softDelete renames to .deleted-<iso> in place`
- `softDelete returns null for missing files`
- `softDelete runs realpath sandbox check (rejects symlink escape, inherited from PR #51)`
- `list() does NOT surface .deleted-* entries`
- `softDelete is idempotent — second call on a missing target returns null`

### 7.2 DB migration v10

- `v10 migration extends events.kind CHECK to include memory_deleted`
- `pre-v10 events are preserved through the table recreate`
- `INSERT INTO events with kind=memory_deleted succeeds; INSERT with kind=foo fails`

### 7.3 Route + tool (integration)

- `POST /v1/memory/delete with valid path + reason → soft-deletes, writes audit event`
- `POST /v1/memory/delete with missing path → ok:true, existed:false, no event written`
- `POST /v1/memory/delete with reason < 4 chars → 400 validation`
- `memory_delete MCP tool → routes to daemon, returns ok with tombstone`

### 7.4 Acceptance script (`scripts/acceptance-p0p1.ts`)

Add a check that exercises the full path through fake-ilink + fake-sdk: agent calls `memory_delete`, file moves to tombstone, events table has the record.

---

## 8. Open questions

1. **Where does `chatId` come from in the route?** The existing `/v1/memory/read` reads it from... actually it doesn't — it operates on a daemon-wide MemoryFS rooted at `memory/`, NOT per-chat. The `memory_path` in audit events would need a per-chat events store keyed off the calling session's chatId. Need to verify the daemon's internal-api transport surfaces chatId; if not, we pull it from the `WECHAT_CHAT_ID` env that the MCP stdio child carries (set when the daemon spawns the wechat-mcp child per session).

2. **Tombstone path collision** if user deletes the same file twice within 1 ms (impossible in practice but worth a sanity guard). The ISO timestamp granularity is millis; the rename would fail with EEXIST and we'd want to retry with an extra suffix. Probably overkill.

3. **Should `list()` have an `includeTombstones` opt for operator tools?** Future dashboard might want to show "recently soft-deleted" so the operator can restore. Add later when there's a real consumer.

---

## 9. Failure modes

| Scenario | Behavior |
|---|---|
| Agent calls `memory_delete('nonexistent.md', '...')` | `ok: true, existed: false`, no audit event |
| Agent calls `memory_delete('escape/path.md', '...')` (symlink) | Throws `MemoryPathError` from PR #51 realpath check; route returns `ok: false, error: 'escape via symlink'` |
| Agent calls with `reason: ''` | Zod validation fails at MCP layer; tool errors before reaching daemon |
| User manually `rm`'d the tombstone before this call | Same as nonexistent — no-op |
| events store unavailable (test fixture without db) | Soft-delete still succeeds (file is renamed); audit event silently skipped with log warning. Daemon should not fail user-visible operation because audit infra is degraded. |
| Daemon restart between rename and audit event write | Soft-delete persists (filesystem rename is atomic); audit event is lost. Acceptable for v1; revisit if dashboard needs strong audit guarantees. |

---

## 10. Implementation order

1. **`MemoryFS.softDelete` + `list()` filter** + 5 unit tests. Smallest, self-contained.
2. **DB migration v10** extending `events.kind` CHECK + `memory_path` column + 3 migration tests.
3. **EventKind union update** in `src/daemon/events/store.ts` + EventRecord type + 1 store test.
4. **Daemon route** `POST /v1/memory/delete` with Zod schemas + 4 route tests.
5. **MCP tool** registration in `src/mcp-servers/wechat/main.ts` + 1 tool test.
6. **Acceptance script** addition.
7. **Verify**: vitest + tsc + depcheck + Playwright + daemon e2e.

Expected diff: ~+350 / −0 lines (8–10 files; +1 migration; 1 net new MCP tool).
