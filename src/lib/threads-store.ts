/**
 * Threads store — topic threads extracted from conversation history.
 *
 * Each thread represents a recurring topic in a chat (e.g. "compass 排产",
 * "stock watchlist"). Threads have:
 *   - facets: lens labels (task | knowledge | life) — can be multi-valued
 *   - tags: free-form user-visible labels, vocabulary shared across chats
 *   - episodes: message time ranges that belong to this thread
 *   - private: independently toggleable visibility flag
 *   - status: active | dormant | done lifecycle
 *
 * thread_extract_state tracks the watermark up to which messages have been
 * processed by the LLM extraction job (Tasks 7/8), so each run is
 * incremental rather than full-scan.
 *
 * House pattern: src/daemon/observations/store.ts
 */
import type { Db } from './db'

export type Facet = 'task' | 'knowledge' | 'life'
export type ThreadStatus = 'active' | 'dormant' | 'done'

export interface Episode {
  from_ts: string
  to_ts: string
}

/** 话题下的一条(v104):一件事 + 一行索引。承诺单独一类。 */
export type EntryKind = 'fact' | 'decision' | 'commitment' | 'progress' | 'conclusion'
export type EntryStatus = 'live' | 'done' | 'superseded'
export type EntrySource = 'chat' | 'work' | 'delegate'
export const ENTRY_KINDS: readonly EntryKind[] = ['fact', 'decision', 'commitment', 'progress', 'conclusion']

export interface TopicEntry {
  id: string
  threadId: string
  kind: EntryKind
  /** 索引那一行(≤ 60 字,带关键词)。 */
  line: string
  /** 细节(可空)。 */
  body: string
  /** 承诺的期限 YYYY-MM-DD(只有 commitment 带)。 */
  due: string | null
  status: EntryStatus
  source: EntrySource
  matterId: string | null
  createdTs: string
  updatedTs: string
}

export type CreateEntryInput = Pick<TopicEntry, 'threadId' | 'kind' | 'line'> & Partial<Pick<TopicEntry, 'body' | 'due' | 'source' | 'matterId'>> & { ts?: string }
export type UpdateEntryInput = Partial<Pick<TopicEntry, 'line' | 'body' | 'due' | 'status'>> & { ts?: string }

/** 抽取到哪了(v104 的两列新水位)。 */
export interface ExtractState {
  /** 对话:这个时刻(含)以前的消息按新格式抽过了;null = 从头。 */
  entriesToTs: string | null
  /** agent 的活:matter_items.cursor 抽到哪(含)。 */
  workCursor: number
}

/** 存之前把 episodes 排好、合并重叠段(重读历史不叠出重复的时间段)。 */
export function mergeEpisodes(eps: readonly Episode[]): Episode[] {
  const sorted = eps.filter(e => e && typeof e.from_ts === 'string' && typeof e.to_ts === 'string')
    .map(e => (e.from_ts <= e.to_ts ? { from_ts: e.from_ts, to_ts: e.to_ts } : { from_ts: e.to_ts, to_ts: e.from_ts }))
    .sort((a, b) => (a.from_ts < b.from_ts ? -1 : a.from_ts > b.from_ts ? 1 : 0))
  const out: Episode[] = []
  for (const e of sorted) {
    const last = out[out.length - 1]
    if (last && e.from_ts <= last.to_ts) { if (e.to_ts > last.to_ts) last.to_ts = e.to_ts } else out.push({ ...e })
  }
  return out
}

export interface ThreadRecord {
  id: string
  chatId: string
  title: string
  summary: string
  facets: Facet[]
  tags: string[]
  /** CC 定的「主人会怎么叫它」(v104):简称、英文名、口头说法。索引匹配用。 */
  aliases: string[]
  private: boolean
  status: ThreadStatus
  episodes: Episode[]
  createdTs: string
  lastActive: string
}

export type CreateThreadInput = Omit<ThreadRecord, 'id' | 'status' | 'createdTs' | 'lastActive' | 'aliases'> & {
  status?: ThreadStatus
  aliases?: string[]
  /** 活跃时刻(抽取时用那批消息的最后时刻);不给 ⇒ 现在。 */
  lastActive?: string
}

export type UpdateThreadInput = {
  title?: string
  summary?: string
  facets?: Facet[]
  tags?: string[]
  aliases?: string[]
  private?: boolean
  status?: ThreadStatus
  episodes?: Episode[]
  lastActive?: string
}

export interface ThreadsStore {
  create(input: CreateThreadInput): Promise<string>
  update(id: string, partial: UpdateThreadInput): Promise<void>
  list(chatId: string): Promise<ThreadRecord[]>
  get(id: string): Promise<ThreadRecord | null>
  tagVocabulary(n: number): Promise<string[]>
  getWatermark(chatId: string): Promise<string | null>
  setWatermark(chatId: string, ts: string): Promise<void>
  // ── v104:条目与新水位 ──
  addEntry(input: CreateEntryInput): Promise<string>
  updateEntry(id: string, patch: UpdateEntryInput): Promise<void>
  getEntry(id: string): Promise<TopicEntry | null>
  /** 一个话题的条目(新的在前);`live` = 只要还算数的。 */
  entries(threadId: string, opts?: { live?: boolean }): Promise<TopicEntry[]>
  /** 一个对话里所有话题的条目(新的在前),按话题分好。 */
  entriesByThread(chatId: string, opts?: { live?: boolean }): Promise<Map<string, TopicEntry[]>>
  getExtractState(chatId: string): Promise<ExtractState>
  setExtractState(chatId: string, patch: Partial<ExtractState>): Promise<void>
}

interface ThreadRow {
  id: string
  chat_id: string
  title: string
  summary: string
  facets: string
  tags: string
  aliases: string
  private: number
  status: string
  episodes: string
  created_ts: string
  last_active: string
}

/** Parse a JSON-array column defensively. A corrupt value (truncated write /
 *  manual DB edit) must NOT throw — that would break the whole query, not just
 *  the bad row. Non-JSON or non-array → []. Mirrors conversation-store's guard. */
function safeJsonArray<T>(json: string): T[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

function rowToRecord(r: ThreadRow): ThreadRecord {
  return {
    id: r.id,
    chatId: r.chat_id,
    title: r.title,
    summary: r.summary,
    facets: safeJsonArray<Facet>(r.facets),
    tags: safeJsonArray<string>(r.tags),
    aliases: safeJsonArray<string>(r.aliases),
    private: r.private !== 0,
    status: r.status as ThreadStatus,
    episodes: safeJsonArray<Episode>(r.episodes),
    createdTs: r.created_ts,
    lastActive: r.last_active,
  }
}

function newThreadId(): string {
  return `thr_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

// Whitelist of columns that update() is allowed to SET.
// Keyed by UpdateThreadInput property name → SQL column name.
const UPDATABLE_COLS: Record<keyof UpdateThreadInput, string> = {
  title: 'title',
  summary: 'summary',
  facets: 'facets',
  tags: 'tags',
  aliases: 'aliases',
  private: 'private',
  status: 'status',
  episodes: 'episodes',
  lastActive: 'last_active',
}

export function makeThreadsStore(db: Db): ThreadsStore {
  const stmtInsert = db.query<unknown, [string, string, string, string, string, string, string, number, string, string, string, string]>(
    `INSERT INTO threads(id, chat_id, title, summary, facets, tags, aliases, private, status, episodes, created_ts, last_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const stmtList = db.query<ThreadRow, [string]>(
    `SELECT id, chat_id, title, summary, facets, tags, aliases, private, status, episodes, created_ts, last_active
     FROM threads WHERE chat_id = ? ORDER BY last_active DESC`,
  )

  const stmtGet = db.query<ThreadRow, [string]>(
    `SELECT id, chat_id, title, summary, facets, tags, aliases, private, status, episodes, created_ts, last_active
     FROM threads WHERE id = ?`,
  )

  const stmtEntryInsert = db.query<unknown, [string, string, string, string, string, string | null, string, string | null, string, string]>(
    `INSERT INTO topic_entries(id, thread_id, kind, line, body, due, source, matter_id, created_ts, updated_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const stmtGetWatermark = db.query<{ extracted_to_ts: string }, [string]>(
    `SELECT extracted_to_ts FROM thread_extract_state WHERE chat_id = ?`,
  )

  const stmtSetWatermark = db.query<unknown, [string, string]>(
    `INSERT INTO thread_extract_state(chat_id, extracted_to_ts) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET extracted_to_ts = excluded.extracted_to_ts`,
  )

  return {
    async create(input) {
      const id = newThreadId()
      const now = new Date().toISOString()
      stmtInsert.run(
        id,
        input.chatId,
        input.title,
        input.summary,
        JSON.stringify(input.facets),
        JSON.stringify(input.tags),
        JSON.stringify(input.aliases ?? []),
        input.private ? 1 : 0,
        input.status ?? 'active',
        JSON.stringify(mergeEpisodes(input.episodes)),
        now,
        input.lastActive ?? now,
      )
      return id
    },

    async update(id, partial) {
      const keys = Object.keys(partial) as (keyof UpdateThreadInput)[]
      if (keys.length === 0) return

      const setClauses: string[] = []
      const values: unknown[] = []

      for (const key of keys) {
        const col = UPDATABLE_COLS[key]
        if (!col) continue  // belt-and-suspenders: skip unknown keys
        setClauses.push(`${col} = ?`)
        const val = partial[key]
        if (key === 'episodes') {
          values.push(JSON.stringify(mergeEpisodes(val as Episode[])))
        } else if (key === 'facets' || key === 'tags' || key === 'aliases') {
          values.push(JSON.stringify(val))
        } else if (key === 'private') {
          values.push(val ? 1 : 0)
        } else {
          values.push(val)
        }
      }

      if (setClauses.length === 0) return
      values.push(id)

      // Cast to any[] to satisfy bun:sqlite's overloaded run() — the actual
      // values are all SQLQueryBindings-compatible (string | number | null).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db.query(`UPDATE threads SET ${setClauses.join(', ')} WHERE id = ?`).run(...(values as any[]))
    },

    async list(chatId) {
      return stmtList.all(chatId).map(rowToRecord)
    },

    async get(id) {
      const row = stmtGet.get(id)
      return row ? rowToRecord(row) : null
    },

    async tagVocabulary(n) {
      // json_each is available in bun:sqlite (compiled with JSON1 extension)
      const rows = db.query<{ value: string }, [number]>(
        `SELECT value FROM threads, json_each(threads.tags) GROUP BY value ORDER BY COUNT(*) DESC LIMIT ?`,
      ).all(n)
      return rows.map((r) => r.value)
    },

    async getWatermark(chatId) {
      const row = stmtGetWatermark.get(chatId)
      return row ? row.extracted_to_ts : null
    },

    async setWatermark(chatId, ts) {
      stmtSetWatermark.run(chatId, ts)
    },

    async addEntry(input) {
      const id = newEntryId()
      const ts = input.ts ?? new Date().toISOString()
      stmtEntryInsert.run(id, input.threadId, input.kind, oneLine(input.line, LINE_MAX), (input.body ?? '').trim().slice(0, BODY_MAX),
        input.kind === 'commitment' ? input.due ?? null : null, input.source ?? 'chat', input.matterId ?? null, ts, ts)
      return id
    },

    async updateEntry(id, patch) {
      const sets: string[] = [], vals: (string | null)[] = []
      if (patch.line !== undefined) { sets.push('line = ?'); vals.push(oneLine(patch.line, LINE_MAX)) }
      if (patch.body !== undefined) { sets.push('body = ?'); vals.push(patch.body.trim().slice(0, BODY_MAX)) }
      if (patch.due !== undefined) { sets.push('due = ?'); vals.push(patch.due) }
      if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status) }
      if (sets.length === 0) return
      sets.push('updated_ts = ?'); vals.push(patch.ts ?? new Date().toISOString())
      db.query(`UPDATE topic_entries SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    },

    async getEntry(id) {
      const r = db.query<EntryRow, [string]>(`SELECT ${ENTRY_COLS} FROM topic_entries WHERE id = ?`).get(id)
      return r ? rowToEntry(r) : null
    },

    async entries(threadId, opts) {
      return db.query<EntryRow, [string]>(
        `SELECT ${ENTRY_COLS} FROM topic_entries WHERE thread_id = ?${opts?.live ? " AND status = 'live'" : ''} ORDER BY updated_ts DESC, id`,
      ).all(threadId).map(rowToEntry)
    },

    async entriesByThread(chatId, opts) {
      const rows = db.query<EntryRow, [string]>(
        `SELECT ${ENTRY_COLS.split(', ').map(c => `e.${c}`).join(', ')} FROM topic_entries e JOIN threads t ON t.id = e.thread_id
         WHERE t.chat_id = ?${opts?.live ? " AND e.status = 'live'" : ''} ORDER BY e.updated_ts DESC, e.id`,
      ).all(chatId)
      const out = new Map<string, TopicEntry[]>()
      for (const r of rows) { const e = rowToEntry(r); const l = out.get(e.threadId); if (l) l.push(e); else out.set(e.threadId, [e]) }
      return out
    },

    async getExtractState(chatId) {
      const r = db.query<{ entries_to_ts: string | null; work_cursor: number }, [string]>(
        'SELECT entries_to_ts, work_cursor FROM thread_extract_state WHERE chat_id = ?',
      ).get(chatId)
      return { entriesToTs: r?.entries_to_ts ?? null, workCursor: r?.work_cursor ?? 0 }
    },

    async setExtractState(chatId, patch) {
      // 老列 extracted_to_ts 是 NOT NULL:新行给它一个占位(不再读它),已有的行不动它。
      db.query(`INSERT INTO thread_extract_state(chat_id, extracted_to_ts) VALUES (?, '1970-01-01T00:00:00Z') ON CONFLICT(chat_id) DO NOTHING`).run(chatId)
      if (patch.entriesToTs !== undefined) db.query('UPDATE thread_extract_state SET entries_to_ts = ? WHERE chat_id = ?').run(patch.entriesToTs, chatId)
      if (patch.workCursor !== undefined) db.query('UPDATE thread_extract_state SET work_cursor = ? WHERE chat_id = ?').run(patch.workCursor, chatId)
    },
  }
}

const LINE_MAX = 80
const BODY_MAX = 600
const ENTRY_COLS = 'id, thread_id, kind, line, body, due, status, source, matter_id, created_ts, updated_ts'

interface EntryRow {
  id: string; thread_id: string; kind: string; line: string; body: string; due: string | null
  status: string; source: string; matter_id: string | null; created_ts: string; updated_ts: string
}

function rowToEntry(r: EntryRow): TopicEntry {
  return {
    id: r.id, threadId: r.thread_id, kind: r.kind as EntryKind, line: r.line, body: r.body, due: r.due,
    status: r.status as EntryStatus, source: r.source as EntrySource, matterId: r.matter_id, createdTs: r.created_ts, updatedTs: r.updated_ts,
  }
}

/** 索引那一行:去换行、压空白、截长。 */
function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return [...t].length > max ? [...t].slice(0, max).join('') : t
}

function newEntryId(): string {
  return `ent_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}
