/**
 * cli-session-store.ts — 终端会话登记处(v76 `cli_sessions`,2026-10-14)。
 *
 * 主人在 CC 之外开的 claude / codex 会话,只经 hooks 让 CC 知道。以前 hub 只在内存里记
 * 最多 256 条、没有状态、重启就忘;这里把它们落库,并从**已有的** hook 事件推导状态:
 *
 *   UserPromptSubmit            → running
 *   PermissionRequest(待批)     → waiting(要主人拍板)
 *   权限拍了 allow / deny        → running
 *   Stop                        → idle(这一轮做完了;记一句 last_summary)
 *   SessionEnd                  → ended
 *
 * 不加新的 hook 事件(PreToolUse 太密),也不跑定时器:running / waiting 超过 STALE_MS
 * 没有任何事件,在**读的时候**当 idle(stale=true)—— 终端被直接关掉、或主人在终端里
 * 自己答了权限,hook 都不会再报一声。
 */
import type { Db } from '../../lib/db'
import type { CliSessionRow, CliSessionStore } from '../../ports/cli-session'

/** 已结束的会话留多久。 */
export const CLI_SESSION_ENDED_RETAIN_MS = 7 * 24 * 3600_000
/** 没报过 SessionEnd(终端被直接关掉)的会话,多久没动静就清掉。 */
export const CLI_SESSION_ABANDONED_RETAIN_MS = 30 * 24 * 3600_000
/** 最多留这么多行(按 last_event_at 留最新的)。 */
export const CLI_SESSION_MAX_ROWS = 500
/** 每写这么多次修剪一次(建 store 时也修一次)。 */
const PRUNE_EVERY = 50

const COLS = 'session_id,source,cwd,machine,transcript_path,origin_agent,status,last_event_at,last_prompt_at,last_summary,pending_tool,pending_summary,pending_at,created_at'

export function makeCliSessionStore(db: Db, now: () => number = () => Date.now()): CliSessionStore {
  let writes = 0
  const afterWrite = (at: number) => { if (++writes % PRUNE_EVERY === 0) prune(at) }

  function prune(t: number): void {
    db.query('DELETE FROM cli_sessions WHERE status = ? AND last_event_at < ?').run('ended', t - CLI_SESSION_ENDED_RETAIN_MS)
    db.query('DELETE FROM cli_sessions WHERE last_event_at < ?').run(t - CLI_SESSION_ABANDONED_RETAIN_MS)
    db.query(`DELETE FROM cli_sessions WHERE session_id NOT IN (SELECT session_id FROM cli_sessions ORDER BY last_event_at DESC LIMIT ?)`).run(CLI_SESSION_MAX_ROWS)
  }

  const store: CliSessionStore = {
    touch(id, at) {
      db.query(`INSERT INTO cli_sessions(session_id,source,cwd,machine,transcript_path,origin_agent,status,last_event_at,created_at)
        VALUES(?,?,?,?,?,?,'running',?,?)
        ON CONFLICT(session_id) DO UPDATE SET
          source=excluded.source,
          cwd=CASE WHEN excluded.cwd <> '' THEN excluded.cwd ELSE cwd END,
          machine=COALESCE(excluded.machine, machine),
          transcript_path=COALESCE(excluded.transcript_path, transcript_path),
          origin_agent=COALESCE(excluded.origin_agent, origin_agent),
          last_event_at=MAX(last_event_at, excluded.last_event_at)`)
        .run(id.session_id, id.source, id.cwd, id.machine || null, id.transcript_path || null, id.origin_agent || null, at, at)
      afterWrite(at)
    },
    setStatus(sessionId, status, at, extra = {}) {
      const pending = status === 'waiting' ? extra.pending : undefined
      db.query(`UPDATE cli_sessions SET status=?, last_event_at=MAX(last_event_at, ?),
          last_summary=CASE WHEN ? THEN ? ELSE last_summary END,
          last_prompt_at=COALESCE(?, last_prompt_at),
          pending_tool=?, pending_summary=?, pending_at=?
        WHERE session_id=?`)
        .run(status, at,
          extra.summary !== undefined ? 1 : 0, extra.summary ?? null,
          extra.promptAt ?? null,
          pending?.tool ?? null, pending?.summary ?? null, pending ? at : null,
          sessionId)
    },
    get(sessionId) {
      return db.query<CliSessionRow, [string]>(`SELECT ${COLS} FROM cli_sessions WHERE session_id=?`).get(sessionId) ?? null
    },
    findByPrefix(prefix) {
      const p = prefix.trim().toLowerCase()
      if (!p) return null
      const like = p.replace(/[\\%_]/g, (c) => `\\${c}`) + '%'
      return db.query<CliSessionRow, [string]>(`SELECT ${COLS} FROM cli_sessions
        WHERE lower(session_id) LIKE ? ESCAPE '\\' AND status <> 'ended'
        ORDER BY last_event_at DESC LIMIT 1`).get(like) ?? null
    },
    list(opts = {}) {
      const limit = Math.max(1, Math.min(opts.limit ?? CLI_SESSION_MAX_ROWS, CLI_SESSION_MAX_ROWS))
      const where = opts.includeEnded ? '' : `WHERE status <> 'ended'`
      return db.query<CliSessionRow, [number]>(`SELECT ${COLS} FROM cli_sessions ${where} ORDER BY (status = 'waiting') DESC, last_event_at DESC LIMIT ?`).all(limit)
    },
    prune,
  }
  prune(now())
  return store
}
