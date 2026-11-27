/**
 * cli-session-store.ts — 终端会话登记处(v76 `cli_sessions`,2026-10-14)。
 *
 * 主人在 CC 之外开的 claude / codex 会话经 hooks 接上。记录发现只给两端列表补充未接上的行。
 * 以前 hub 只在内存里记
 * 最多 256 条、没有状态、重启就忘;这里把它们落库,并从**已有的** hook 事件推导状态:
 *
 *   UserPromptSubmit            → running
 *   PermissionRequest(待批)     → waiting(要主人拍板)
 *   权限拍了 allow / deny        → running
 *   Stop                        → idle(这一轮做完了;最后一句是那件事的一步)
 *   SessionEnd                  → ended
 *
 * 不加新的 hook 事件(PreToolUse 太密),也不跑定时器:running / waiting 超过 STALE_MS
 * 没有任何事件,在**读的时候**当 idle(stale=true,domain/cli-session-view.ts)—— 终端被直接关掉、或主人在终端里
 * 自己答了权限,hook 都不会再报一声。
 *
 * M4d(设计稿 docs/superpowers/specs/2026-11-04-m4-terminal-matter-design.md):状态、最近一句、等你那一项**从这件事推**
 * (那件 kind='terminal' 的事,matter_bindings surface='cli');第 2 步(v100)起这几列删了,表里只留指针和钩子报来的事实
 * (会话 id、来源、cwd、机器、记录路径、最近一次事件 / 发问的时间)。
 *   这件事 done                    → ended
 *   有一张开着的权限卡(started)    → waiting(那张卡的 tool / summary / 时间)
 *   有一轮在跑                      → running
 *   其余                            → idle
 *   没有这件事                      → idle,没有最近一句 / 等你那一项。M4a 起每个钩子事件都会建它,v100 把登记处里
 *                                     剩下的老会话按当时的列补建了;还会没有的只剩写轮失败(CLI_TURNS 日志)那几条 ——
 *                                     当歇着:照样列出来、「@码」认得;下一个钩子事件 / 看一眼(turns.ensure)就建上
 */
import { lstatSync } from 'node:fs'
import { PRESESSION_EXPIRY_MS, type Presession } from '../../domain/presession'
import type { Db } from '../../lib/db'
import type { CliSessionIdentity, CliSessionRow, CliSessionStore } from '../../ports/cli-session'
import { hintWrite } from '../../lib/write-hints'

/** 已结束的会话留多久。 */
export const CLI_SESSION_ENDED_RETAIN_MS = 7 * 24 * 3600_000
/** 没报过 SessionEnd(终端被直接关掉)的会话,多久没动静就清掉。 */
export const CLI_SESSION_ABANDONED_RETAIN_MS = 30 * 24 * 3600_000
/** 最多留这么多行(按 last_event_at 留最新的)。 */
export const CLI_SESSION_MAX_ROWS = 500
/** 每写这么多次修剪一次(建 store 时也修一次)。 */
const PRUNE_EVERY = 50

// Real prompts have epoch timestamps. Reserve -1 until the first hook touch
// and project it as an absent last_prompt_at on the wire.
const UNHOOKED = -1
const IS_UNHOOKED = `last_prompt_at IS ${UNHOOKED}`

const COLS = 'session_id,source,cwd,machine,terminal_json,transcript_path,origin_agent,status,last_event_at,last_prompt_at,last_summary,pending_tool,pending_summary,pending_at,pending_display_json,pending_cwd,pending_truncated,created_at,unhooked'

/** 那件事里开着的权限卡 / 最后一句。最近一次发问照旧读列:一轮里可能发问好几次,轮的开始时间不是最近那一次(Codex 评审)。 */
const CARD = "SELECT %s FROM matter_items i WHERE i.matter_id = b.matter_id AND i.kind = 'permission' AND i.status = 'started' ORDER BY i.seq DESC LIMIT 1"
const SAID = "SELECT json_extract(i.payload_json, '$.text') FROM matter_items i WHERE i.matter_id = b.matter_id AND i.kind = 'agent_message' AND json_extract(i.payload_json, '$.text') IS NOT NULL ORDER BY i.seq DESC LIMIT 1"
const DERIVED = `SELECT c.session_id, c.source, c.cwd, c.machine, c.terminal_json, c.transcript_path, c.origin_agent, c.last_event_at, c.created_at,
    NULLIF(c.last_prompt_at, ${UNHOOKED}) AS last_prompt_at,
    CASE WHEN c.${IS_UNHOOKED} THEN 1 END AS unhooked,
    CASE WHEN c.${IS_UNHOOKED} OR m.id IS NULL THEN 'idle'
         WHEN m.state = 'done' THEN 'ended'
         WHEN EXISTS (${CARD.replace('%s', '1')}) THEN 'waiting'
         WHEN EXISTS (SELECT 1 FROM matter_turns t WHERE t.matter_id = b.matter_id AND t.status = 'running') THEN 'running'
         ELSE 'idle' END AS status,
    CASE WHEN c.${IS_UNHOOKED} OR m.id IS NULL THEN NULL ELSE (${SAID}) END AS last_summary,
    CASE WHEN c.${IS_UNHOOKED} OR m.id IS NULL THEN NULL ELSE (${CARD.replace('%s', "json_extract(i.payload_json, '$.tool')")}) END AS pending_tool,
    CASE WHEN c.${IS_UNHOOKED} OR m.id IS NULL THEN NULL ELSE (${CARD.replace('%s', "json_extract(i.payload_json, '$.summary')")}) END AS pending_summary,
    CASE WHEN c.${IS_UNHOOKED} OR m.id IS NULL THEN NULL ELSE (${CARD.replace('%s', "json_extract(i.payload_json, '$.display')")}) END AS pending_display_json,
    CASE WHEN c.${IS_UNHOOKED} OR m.id IS NULL THEN NULL ELSE (${CARD.replace('%s', "json_extract(i.payload_json, '$.cwd')")}) END AS pending_cwd,
    CASE WHEN c.${IS_UNHOOKED} OR m.id IS NULL THEN NULL ELSE (${CARD.replace('%s', "json_extract(i.payload_json, '$.truncated')")}) END AS pending_truncated,
    CASE WHEN c.${IS_UNHOOKED} OR m.id IS NULL THEN NULL ELSE (${CARD.replace('%s', 'i.created_at')}) END AS pending_at
  FROM cli_sessions c
  LEFT JOIN matter_bindings b ON b.surface = 'cli' AND b.surface_key = c.session_id
  LEFT JOIN matters m ON m.id = b.matter_id AND m.kind = 'terminal'`

export const readCliSession=(db:Db,id:string):CliSessionRow|null=>db.query<CliSessionRow,[string]>(`SELECT ${COLS} FROM (${DERIVED}) WHERE session_id=? AND unhooked IS NULL`).get(id)??null

export function makeCliSessionStore(db: Db, now: () => number = () => Date.now()) {
  let writes = 0
  const afterWrite = (at: number) => { if (++writes % PRUNE_EVERY === 0) prune(at) }
  const changed = (sessionId:string) => {
    const matter=db.query<{matter_id:string},[string]>("SELECT matter_id FROM matter_bindings WHERE surface='cli' AND surface_key=? LIMIT 1").get(sessionId)
    if(matter)hintWrite(db,{kind:'matter',matterId:matter.matter_id})
    hintWrite(db,{kind:'cli',sessionId})
  }

  function prune(t: number): void {
    const removed: Array<{ session_id: string; unhooked: number }> = []
    const returning = `RETURNING session_id, (${IS_UNHOOKED}) AS unhooked`
    removed.push(...db.query<(typeof removed)[number],[number]>(`DELETE FROM cli_sessions WHERE last_event_at < ? AND session_id IN (SELECT session_id FROM (${DERIVED}) WHERE status = 'ended') ${returning}`).all(t - CLI_SESSION_ENDED_RETAIN_MS))
    removed.push(...db.query<(typeof removed)[number],[number]>(`DELETE FROM cli_sessions WHERE last_event_at < ? ${returning}`).all(t - CLI_SESSION_ABANDONED_RETAIN_MS))
    removed.push(...db.query<(typeof removed)[number],[number]>(`DELETE FROM cli_sessions WHERE session_id NOT IN (SELECT session_id FROM cli_sessions ORDER BY last_event_at DESC LIMIT ?) ${returning}`).all(CLI_SESSION_MAX_ROWS))
    for (const row of removed) if (!row.unhooked) changed(row.session_id)
  }

  const store = {
    registeredIds() {
      return new Set(db.query<{ session_id: string }, []>('SELECT session_id FROM cli_sessions').all().map(row => row.session_id))
    },
    discover(sessions: readonly Presession[]) {
      const insert = db.query(`INSERT INTO cli_sessions(session_id,source,cwd,transcript_path,last_event_at,created_at,last_prompt_at)
        VALUES(?,?,?,?,?,?,${UNHOOKED}) ON CONFLICT(session_id) DO NOTHING`)
      db.transaction(() => {
        for (const s of sessions) {
          const mtime = Math.floor(s.mtimeMs)
          insert.run(s.sessionId, s.source, s.cwd, s.path, mtime, mtime)
        }
      })()
      if (sessions.length) prune(now())
    },
    // SessionStart uses the project-memory hook. Register only a transition
    // here; new sessions still enter through the regular event path.
    connectDiscovered(id: CliSessionIdentity, at: number) {
      const result = db.query(`UPDATE cli_sessions
        SET cwd=?, last_event_at=MAX(last_event_at, ?), last_prompt_at=NULL
        WHERE session_id=? AND source=? AND ${IS_UNHOOKED}`).run(id.cwd, at, id.session_id, id.source)
      if (result.changes) changed(id.session_id)
    },
    touch(id, at) {
      db.query(`INSERT INTO cli_sessions(session_id,source,cwd,machine,terminal_json,transcript_path,origin_agent,last_event_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET
          source=excluded.source,
          cwd=CASE WHEN excluded.cwd <> '' THEN excluded.cwd ELSE cwd END,
          machine=COALESCE(excluded.machine, machine),
          terminal_json=COALESCE(excluded.terminal_json, terminal_json),
          transcript_path=COALESCE(excluded.transcript_path, transcript_path),
          origin_agent=COALESCE(excluded.origin_agent, origin_agent),
          last_prompt_at=NULLIF(last_prompt_at, ${UNHOOKED}),
          last_event_at=MAX(last_event_at, excluded.last_event_at)`)
        .run(id.session_id, id.source, id.cwd, id.machine || null, id.terminal ? JSON.stringify(id.terminal) : null, id.transcript_path || null, id.origin_agent || null, at, at)
      afterWrite(at)
      changed(id.session_id)
    },
    seen(sessionId, at, extra = {}) {
      db.query('UPDATE cli_sessions SET last_event_at=MAX(last_event_at, ?), last_prompt_at=COALESCE(?, last_prompt_at) WHERE session_id=?')
        .run(at, extra.promptAt ?? null, sessionId)
      changed(sessionId)
    },
    get(sessionId) {
      return readCliSession(db,sessionId)
    },
    findByPrefix(prefix) {
      const p = prefix.trim().toLowerCase()
      if (!p) return null
      const like = p.replace(/[\\%_]/g, (c) => `\\${c}`) + '%'
      return db.query<CliSessionRow, [string]>(`SELECT ${COLS} FROM (${DERIVED})
        WHERE lower(session_id) LIKE ? ESCAPE '\\' AND status <> 'ended' AND unhooked IS NULL
        ORDER BY last_event_at DESC LIMIT 1`).get(like) ?? null
    },
    list(opts = {}) {
      const limit = Math.max(1, Math.min(opts.limit ?? CLI_SESSION_MAX_ROWS, CLI_SESSION_MAX_ROWS))
      const rows = db.query<CliSessionRow, [number]>(`SELECT ${COLS} FROM (${DERIVED})
        WHERE ${opts.includeEnded ? '1' : "status <> 'ended'"} AND ${opts.includeUnhooked ? '1' : 'unhooked IS NULL'}
        ORDER BY (status = 'waiting') DESC, last_event_at DESC LIMIT ?`).all(opts.includeUnhooked ? CLI_SESSION_MAX_ROWS : limit)
      if (!opts.includeUnhooked) return rows
      const cutoff = now() - PRESESSION_EXPIRY_MS
      return rows.filter(row => {
        if (!row.unhooked || row.last_event_at > cutoff) return true
        if (!row.transcript_path) return false
        try {
          const stat = lstatSync(row.transcript_path)
          return stat.isFile() && stat.mtimeMs > cutoff
        } catch { return false }
      }).slice(0, limit)
    },
    prune,
  } satisfies CliSessionStore & {
    registeredIds(): Set<string>
    discover(sessions: readonly Presession[]): void
    connectDiscovered(id: CliSessionIdentity, at: number): void
  }
  prune(now())
  return store
}
