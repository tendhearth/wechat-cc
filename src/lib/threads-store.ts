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
import { readableTopicMetadata, allowedTopicEntryIds, restrictedTopicIds, topicMatterAccess, localTopicContext } from './topic-provenance'
import { hintWrite } from './write-hints'
import { redactIdentifiers } from './redact-identifiers'

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
  /** 被睡一觉的整理并进了哪一条(只标,不删)。 */
  supersededBy: string | null
  createdTs: string
  updatedTs: string
}

export type CreateEntryInput = Pick<TopicEntry, 'threadId' | 'kind' | 'line'> & Partial<Pick<TopicEntry, 'body' | 'due' | 'source' | 'matterId'>> & { ts?: string; derivedFrom?: readonly string[]; workCursor?:number }
export type UpdateEntryInput = Partial<Pick<TopicEntry, 'line' | 'body' | 'due' | 'status' | 'supersededBy'>> & { ts?: string }

/** 抽取到哪了(v104 的两列新水位)。 */
export interface ExtractState {
  /** 对话:这个时刻(含)以前的消息按新格式抽过了;null = 从头。 */
  entriesToTs: string | null
  /** agent 的活:matter_items.cursor 抽到哪(含)。 */
  workCursor: number
  /** 睡一觉的整理:这个时刻以前改过的话题整理过了;null = 从没整理过。 */
  consolidatedToTs: string | null
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
  /** 这个话题是什么(一行,v104):只在抽取时写;摘要 = 它 + 代码拼的最新状态(睡一觉时)。 */
  description: string
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

export type CreateThreadInput = Omit<ThreadRecord, 'id' | 'status' | 'createdTs' | 'lastActive' | 'aliases' | 'description'> & {
  description?: string
  status?: ThreadStatus
  aliases?: string[]
  /** 活跃时刻(抽取时用那批消息的最后时刻);不给 ⇒ 现在。 */
  lastActive?: string
}

export type UpdateThreadInput = {
  title?: string
  summary?: string
  description?: string
  facets?: Facet[]
  tags?: string[]
  aliases?: string[]
  private?: boolean
  status?: ThreadStatus
  episodes?: Episode[]
  lastActive?: string
}

export interface ConsolidationPlan {
  groups: Array<{entry: Omit<CreateEntryInput,'threadId'>; originals: string[]}>
  strips: Array<{id:string;line:string;body:string;ts:string}>
  summary?: string
  ts: string
}

export interface ThreadsStore {
  /** Shared DB identity for serializing extraction across independently constructed readers. */
  readonly extractionKey?: object
  /** One synchronous authorization + merge/strip/summary transaction. */
  applyConsolidation(owner:string,topic:string,plan:ConsolidationPlan,authorized:()=>boolean):boolean

  /** Owner-scoped atomic merge; old ids survive as aliases, including chains. */
  merge(owner:string,from:string,into:string):Promise<boolean>

  /** Synchronous recheck of a previously read model context. */
  contextAllowed?(owner: string, topics: readonly { id: string; summary: string; description?: string; title?: string; tags?: readonly string[]; aliases?: readonly string[] }[], entryIds: readonly string[]): boolean
  /** Whether a summary rewrite can use the complete raw history. */
  topicHistoryAllowed?(owner:string,topic:string):boolean
  /** Work-bearing dependencies actually available to this model context. */
  contextSources?(owner: string, topics: readonly {id:string;title:string;summary:string;description?:string}[], entryIds: readonly string[]): string[]
  /** Source check + topic/entry insertion in one synchronous SQLite transaction. */
  createExtractedTopic(input: CreateThreadInput, entries: Array<Omit<CreateEntryInput, 'threadId'>>, authorized: () => boolean): string | null
  create(input: CreateThreadInput): Promise<string>
  update(id: string, partial: UpdateThreadInput): Promise<void>
  list(chatId: string): Promise<ThreadRecord[]>
  get(id: string): Promise<ThreadRecord | null>
  tagVocabulary(n: number, chatId?: string): Promise<string[]>
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
  /** Synchronous insertion revision, used to hold the watermark across model latency. */
  extractRevision?(chatId:string,throughTs?:string):number
  setExtractState(chatId: string, patch: Partial<ExtractState>, guard?:{entriesToTs:string|null;messageRevision:number;throughTs?:string}): Promise<void>
}

interface ThreadRow {
  id: string
  chat_id: string
  title: string
  summary: string
  description: string
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
    description: r.description,
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
  description: 'description',
  facets: 'facets',
  tags: 'tags',
  aliases: 'aliases',
  private: 'private',
  status: 'status',
  episodes: 'episodes',
  lastActive: 'last_active',
}

/** Raw by default for maintenance; user/model readers opt into source filtering. */
export function makeThreadsStore(db: Db, opts?: { filterSources?: boolean; allowWork?: boolean; allowDelegate?: boolean }): ThreadsStore {
  const contextFor = (owner: string) => ({ ...localTopicContext(owner), allowWork: opts?.allowWork, allowDelegate: opts?.allowDelegate })
  const readableEntries = (owner: string, rows: EntryRow[]) => {
    if (!opts?.filterSources) return rows
    const allowed = allowedTopicEntryIds(db, contextFor(owner), rows.map(e => e.id))
    return rows.filter(e => allowed.has(e.id))
  }
  const readableTopics = (owner: string, rows: ThreadRecord[]) => {
    if (!opts?.filterSources) return rows
    return readableTopicMetadata(db, contextFor(owner), rows)
  }
  const entryOwner = (thread: string) => db.query<{chat_id:string},[string]>('SELECT chat_id FROM threads WHERE id=?').get(thread)?.chat_id ?? ''

  const changed = (id: string) => {
    const t = db.query<{ chat_id: string }, [string]>('SELECT chat_id FROM threads WHERE id=?').get(id)
    if (t) hintWrite(db, { kind: 'topics', chatId: t.chat_id })
  }
  const stmtInsert = db.query<unknown, [string, string, string, string, string, string, string, string, number, string, string, string, string]>(
    `INSERT INTO threads(id, chat_id, title, summary, description, facets, tags, aliases, private, status, episodes, created_ts, last_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const stmtList = db.query<ThreadRow, [string]>(
    `SELECT id, chat_id, title, summary, description, facets, tags, aliases, private, status, episodes, created_ts, last_active
     FROM threads WHERE chat_id = ? ORDER BY last_active DESC`,
  )

  const stmtGet = db.query<ThreadRow, [string]>(
    `SELECT id, chat_id, title, summary, description, facets, tags, aliases, private, status, episodes, created_ts, last_active
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

  function insertThread(input: CreateThreadInput): string {
    const id = newThreadId()
    const now = new Date().toISOString()
    stmtInsert.run(
      id,
      input.chatId,
      input.title,
      redactIdentifiers(input.summary),
      redactIdentifiers(input.description ?? input.summary),
      JSON.stringify(input.facets),
      JSON.stringify(input.tags),
      JSON.stringify(input.aliases ?? []),
      input.private ? 1 : 0,
      input.status ?? 'active',
      JSON.stringify(mergeEpisodes(input.episodes)),
      now,
      input.lastActive ?? now,
    )
    changed(id)
    return id
  }

  function sourcesAllowed(owner:string,ids:readonly string[]=[]):boolean {
    const allowed=allowedTopicEntryIds(db,localTopicContext(owner),ids,true)
    return ids.every(id=>allowed.has(id))
  }

  function insertEntry(input: CreateEntryInput): string {
    const ledger= input.source==='work'&&input.matterId&&input.workCursor!==undefined&&db.query('SELECT 1 FROM matter_agents WHERE matter_id=? AND position=2 LIMIT 1').get(input.matterId)
    const ts=input.ts??new Date().toISOString()
    const prior=ledger?db.query<{id:string},[string,string]>("SELECT id FROM topic_entries WHERE thread_id=? AND matter_id=? AND source='work' AND status='live' ORDER BY created_ts,id LIMIT 1").get(input.threadId,input.matterId!):null
    if(ledger){
      const owner=entryOwner(input.threadId)
      if(!topicMatterAccess(db,localTopicContext(owner),[input.matterId!]).entryAllowed.has(input.matterId!))throw Error('topic work source changed')
      const cursor=db.query<{c:number},[string,string]>('SELECT written_back_cursor AS c FROM matter_topics WHERE matter_id=? AND thread_id=?').get(input.matterId!,input.threadId)?.c??-1
      if(input.workCursor!<=cursor)return prior?.id??''
    }
    const id=newEntryId()
    const line=oneLine(redactIdentifiers(input.line),LINE_MAX),body=redactIdentifiers((input.body??'').trim()).slice(0,BODY_MAX)
    stmtEntryInsert.run(id,input.threadId,ledger?'conclusion':input.kind,line,body,input.kind==='commitment'?input.due??null:null,input.source??'chat',input.matterId??null,ts,ts)
    if(ledger){
      const previous=db.query<{id:string},[string,string,string]>("SELECT id FROM topic_entries WHERE thread_id=? AND matter_id=? AND source='work' AND status='live' AND id<>?").all(input.threadId,input.matterId!,id)
      for(const old of previous){
        db.query("UPDATE topic_entries SET status='superseded',superseded_by=?,updated_ts=? WHERE id=?").run(id,ts,old.id)
        for(const source of db.query<{source_id:string},[string]>('SELECT source_id FROM topic_entry_sources WHERE entry_id=?').all(old.id))db.query('INSERT OR IGNORE INTO topic_entry_sources(entry_id,source_id) VALUES(?,?)').run(id,source.source_id)
      }
    }
    for(const source of input.derivedFrom??[])if(source!==id)db.query('INSERT OR IGNORE INTO topic_entry_sources(entry_id,source_id) VALUES(?,?)').run(id,source)
    if(ledger)db.query('INSERT INTO matter_topics(matter_id,thread_id,attached_ts,written_back_cursor) VALUES(?,?,?,?) ON CONFLICT(matter_id,thread_id) DO UPDATE SET written_back_cursor=MAX(written_back_cursor,excluded.written_back_cursor)').run(input.matterId!,input.threadId,ts,input.workCursor!)
    changed(id);changed(input.threadId)
    return id
  }

  return {
    extractionKey: db,
    applyConsolidation(owner,topic,plan,authorized) {
      return db.transaction(()=>{
        if(entryOwner(topic)!==owner||!authorized())return false
        for(const g of plan.groups){
          const id=insertEntry({...g.entry,threadId:topic,derivedFrom:g.originals})
          for(const original of g.originals)db.query("UPDATE topic_entries SET status='superseded',superseded_by=?,updated_ts=? WHERE id=? AND thread_id=?").run(id,plan.ts,original,topic)
        }
        for(const e of plan.strips)db.query('UPDATE topic_entries SET line=?,body=?,updated_ts=? WHERE id=? AND thread_id=?').run(e.line,e.body,e.ts,e.id,topic)
        if(plan.summary!==undefined)db.query('UPDATE threads SET summary=? WHERE id=?').run(redactIdentifiers(plan.summary),topic)
        changed(topic)
        return true
      })()
    },
    contextAllowed(owner, topics, entryIds) {
      const context=contextFor(owner)
      const allowed=allowedTopicEntryIds(db,context,entryIds)
      if(entryIds.some(id=>!allowed.has(id)))return false
      const owned=new Set(db.query<{id:string},[string]>('SELECT id FROM threads WHERE chat_id=?').all(owner).map(t=>t.id))
      const restricted=context.allowWork===false?restrictedTopicIds(db,context,topics.map(t=>t.id)):new Set<string>()
      return topics.every(t=>owned.has(t.id)&&(!(t.summary||t.description||t.title||t.tags?.length||t.aliases?.length)||!restricted.has(t.id)))
    },
    topicHistoryAllowed(owner,topic) { return entryOwner(topic)===owner&&!restrictedTopicIds(db,contextFor(owner),[topic]).has(topic) },
    contextSources(owner, _topics, entryIds) {
      // Identify work-bearing context for rewrite guards; callers select only
      // direct work rows for fallback edges so derived chat never compounds.
      return db.query<{id:string},[string,string]>(`SELECT e.id FROM topic_entries e JOIN threads t ON t.id=e.thread_id
        WHERE t.chat_id=? AND e.id IN (SELECT value FROM json_each(?)) AND (e.source!='chat' OR e.matter_id IS NOT NULL OR EXISTS(SELECT 1 FROM topic_entry_sources s WHERE s.entry_id=e.id))`)
        .all(owner,JSON.stringify(entryIds)).map(e=>e.id)
    },
    createExtractedTopic(input, entries, authorized) {
      return db.transaction(() => {
        if(!authorized())return null
        const work=entries.filter(e=>e.source==='work')
        const allowed=topicMatterAccess(db,localTopicContext(input.chatId),work.flatMap(e=>e.matterId?[e.matterId]:[])).entryAllowed
        if(work.some(e=>!e.matterId||!allowed.has(e.matterId)))return null
        if(entries.some(e=>!sourcesAllowed(input.chatId,e.derivedFrom)))return null
        const id=insertThread(input)
        for(const entry of entries)insertEntry({...entry,threadId:id})
        return id
      })()
    },
    async merge(owner,from,into) {
      if(from===into)return false
      return db.transaction(() => {
        const source=db.query<ThreadRow,[string,string]>('SELECT * FROM threads WHERE id=? AND chat_id=?').get(from,owner)
        const target=db.query<ThreadRow,[string,string]>('SELECT * FROM threads WHERE id=? AND chat_id=?').get(into,owner)
        if(!source||!target)return false
        const union = (a: string, b: string, extra: string[] = []) => JSON.stringify([...new Set([...safeJsonArray<string>(a), ...safeJsonArray<string>(b), ...extra])])
        // 合并不会把私密内容降为公开；旧话题名仍是新话题的检索别名。
        db.query(`UPDATE threads SET episodes=?, aliases=?, tags=?, facets=?, private=?, last_active=MAX(last_active,?), status=CASE WHEN status='active' OR ?='active' THEN 'active' WHEN status='dormant' OR ?='dormant' THEN 'dormant' ELSE 'done' END WHERE id=?`).run(
          JSON.stringify(mergeEpisodes([...safeJsonArray<Episode>(source.episodes),...safeJsonArray<Episode>(target.episodes)])),
          union(target.aliases,source.aliases,[source.title]),union(target.tags,source.tags),union(target.facets,source.facets),
          source.private||target.private ? 1 : 0,source.last_active,source.status,source.status,into)

        db.query(`INSERT INTO topic_bubbles(thread_id,state,opened_at,last_recalled_at,last_opened_by_owner_at,activity_revision)
          SELECT ?,state,opened_at,last_recalled_at,last_opened_by_owner_at,activity_revision+1 FROM topic_bubbles WHERE thread_id=?
          ON CONFLICT(thread_id) DO UPDATE SET state=CASE WHEN topic_bubbles.state='open' OR excluded.state='open' THEN 'open' ELSE 'closed' END,
          opened_at=COALESCE(topic_bubbles.opened_at,excluded.opened_at),
          last_recalled_at=NULLIF(MAX(COALESCE(topic_bubbles.last_recalled_at,''),COALESCE(excluded.last_recalled_at,'')),''),
          last_opened_by_owner_at=NULLIF(MAX(COALESCE(topic_bubbles.last_opened_by_owner_at,''),COALESCE(excluded.last_opened_by_owner_at,'')),''),
          activity_revision=MAX(topic_bubbles.activity_revision,excluded.activity_revision)+1,closed_sleep_id=NULL`).run(into,from)
        db.query('UPDATE topic_entries SET thread_id=? WHERE thread_id=?').run(into,from)
        db.query('INSERT OR IGNORE INTO matter_topics(matter_id,thread_id,attached_ts,written_back_cursor) SELECT matter_id,?,attached_ts,written_back_cursor FROM matter_topics WHERE thread_id=?').run(into,from)
        for(const ref of db.query<{chat_id:string;request_id:string;entry_ids:string;message_ids:string;created_at:string},[string]>('SELECT chat_id,request_id,entry_ids,message_ids,created_at FROM topic_recall_refs WHERE thread_id=?').all(from)) {
          const previous=db.query<{entry_ids:string;message_ids:string},[string,string,string]>('SELECT entry_ids,message_ids FROM topic_recall_refs WHERE chat_id=? AND request_id=? AND thread_id=?').get(owner,ref.request_id,into)
          const union=(a:string|undefined,b:string)=>JSON.stringify([...new Set([...JSON.parse(a??'[]'),...JSON.parse(b)])])
          db.query(`INSERT INTO topic_recall_refs VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id,request_id,thread_id) DO UPDATE SET entry_ids=excluded.entry_ids,message_ids=excluded.message_ids,created_at=MAX(topic_recall_refs.created_at,excluded.created_at)`)
            .run(owner,ref.request_id,into,union(previous?.entry_ids,ref.entry_ids),union(previous?.message_ids,ref.message_ids),ref.created_at)
        }
        db.query('UPDATE topic_merge_aliases SET surviving_id=? WHERE chat_id=? AND surviving_id=?').run(into,owner,from)
        db.query('INSERT OR REPLACE INTO topic_merge_aliases(chat_id,old_id,surviving_id) VALUES(?,?,?)').run(owner,from,into)
        db.query('DELETE FROM threads WHERE id=? AND chat_id=?').run(from,owner)
        hintWrite(db,{kind:'topics',chatId:owner})
        return true
      })()
    },
    async create(input) { return insertThread(input) },

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
        } else if (key === 'summary' || key === 'description') {
          values.push(redactIdentifiers(String(val)))
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
      changed(id)
    },

    async list(chatId) {
      return readableTopics(chatId, stmtList.all(chatId).map(rowToRecord))
    },

    async get(id) {
      const row = stmtGet.get(id)
      return row ? readableTopics(row.chat_id, [rowToRecord(row)])[0] ?? null : null
    },

    async tagVocabulary(n, chatId) {
      const topics = db.query<ThreadRow,[string|null]>('SELECT * FROM threads WHERE ?1 IS NULL OR chat_id=?1').all(chatId??null).map(rowToRecord)
      const visible = [...new Set(topics.map(t=>t.chatId))].flatMap(owner=>readableTopics(owner,topics.filter(t=>t.chatId===owner)))
      const counts = new Map<string,number>()
      for(const t of visible)for(const tag of t.tags)counts.set(tag,(counts.get(tag)??0)+1)
      return [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,n).map(([tag])=>tag)
    },

    async getWatermark(chatId) {
      const row = stmtGetWatermark.get(chatId)
      return row ? row.extracted_to_ts : null
    },

    async setWatermark(chatId, ts) {
      stmtSetWatermark.run(chatId, ts)
    },

    async addEntry(input) {
      return db.transaction(()=>{
        if(!sourcesAllowed(entryOwner(input.threadId),input.derivedFrom))throw new Error('topic entry sources changed')
        return insertEntry(input)
      })()
    },

    async updateEntry(id, patch) {
      const sets: string[] = [], vals: (string | null)[] = []
      if (patch.line !== undefined) { sets.push('line = ?'); vals.push(oneLine(redactIdentifiers(patch.line), LINE_MAX)) }
      if (patch.body !== undefined) { sets.push('body = ?'); vals.push(redactIdentifiers(patch.body.trim()).slice(0, BODY_MAX)) }
      if (patch.supersededBy !== undefined) { sets.push('superseded_by = ?'); vals.push(patch.supersededBy) }
      if (patch.due !== undefined) { sets.push('due = ?'); vals.push(patch.due) }
      if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status) }
      if (sets.length === 0) return
      sets.push('updated_ts = ?'); vals.push(patch.ts ?? new Date().toISOString())
      db.query(`UPDATE topic_entries SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
      const e = db.query<{ thread_id: string }, [string]>('SELECT thread_id FROM topic_entries WHERE id=?').get(id)
      if (e) changed(e.thread_id)
    },

    async getEntry(id) {
      const r = db.query<EntryRow, [string]>(`SELECT ${ENTRY_COLS} FROM topic_entries WHERE id = ?`).get(id)
      return r && readableEntries(entryOwner(r.thread_id), [r]).length ? rowToEntry(r) : null
    },

    async entries(threadId, opts) {
      const rows = db.query<EntryRow, [string]>(
        `SELECT ${ENTRY_COLS} FROM topic_entries WHERE thread_id = ?${opts?.live ? " AND status = 'live'" : ''} ORDER BY updated_ts DESC, id`,
      ).all(threadId)
      return readableEntries(entryOwner(threadId), rows).map(rowToEntry)
    },

    async entriesByThread(chatId, opts) {
      const rows = db.query<EntryRow, [string]>(
        `SELECT ${ENTRY_COLS.split(', ').map(c => `e.${c}`).join(', ')} FROM topic_entries e JOIN threads t ON t.id = e.thread_id
         WHERE t.chat_id = ?${opts?.live ? " AND e.status = 'live'" : ''} ORDER BY e.updated_ts DESC, e.id`,
      ).all(chatId)
      const out = new Map<string, TopicEntry[]>()
      for (const r of readableEntries(chatId, rows)) { const e = rowToEntry(r); const l = out.get(e.threadId); if (l) l.push(e); else out.set(e.threadId, [e]) }
      return out
    },

    async getExtractState(chatId) {
      const r = db.query<{ entries_to_ts: string | null; work_cursor: number; consolidated_to_ts: string | null }, [string]>(
        'SELECT entries_to_ts, work_cursor, consolidated_to_ts FROM thread_extract_state WHERE chat_id = ?',
      ).get(chatId)
      return { entriesToTs: r?.entries_to_ts ?? null, workCursor: r?.work_cursor ?? 0, consolidatedToTs: r?.consolidated_to_ts ?? null }
    },

    extractRevision(chatId,throughTs){return throughTs?db.query<{revision:number},[string,string]>('SELECT coalesce(max(rowid),0) AS revision FROM messages WHERE chat_id=? AND julianday(ts)<=julianday(?)').get(chatId,throughTs)!.revision:db.query<{revision:number},[string]>('SELECT coalesce(max(rowid),0) AS revision FROM messages WHERE chat_id=?').get(chatId)!.revision},
    async setExtractState(chatId, patch, guard) {
      db.transaction(()=>{
      if(guard){
        const current=db.query<{entries_to_ts:string|null},[string]>('SELECT entries_to_ts FROM thread_extract_state WHERE chat_id=?').get(chatId)?.entries_to_ts??null
        if(current!==guard.entriesToTs||(guard.throughTs&&this.extractRevision!(chatId,guard.throughTs)>guard.messageRevision))return
      }
      // 老列 extracted_to_ts 是 NOT NULL:新行给它一个占位(不再读它),已有的行不动它。
      db.query(`INSERT INTO thread_extract_state(chat_id, extracted_to_ts) VALUES (?, '1970-01-01T00:00:00Z') ON CONFLICT(chat_id) DO NOTHING`).run(chatId)
      if (patch.entriesToTs !== undefined) db.query('UPDATE thread_extract_state SET entries_to_ts = ? WHERE chat_id = ?').run(patch.entriesToTs, chatId)
      if (patch.workCursor !== undefined) db.query('UPDATE thread_extract_state SET work_cursor = ? WHERE chat_id = ?').run(patch.workCursor, chatId)
      if (patch.consolidatedToTs !== undefined) db.query('UPDATE thread_extract_state SET consolidated_to_ts = ? WHERE chat_id = ?').run(patch.consolidatedToTs, chatId)
      })()
    },
  }
}

const LINE_MAX = 80
const BODY_MAX = 600
const ENTRY_COLS = 'id, thread_id, kind, line, body, due, status, source, matter_id, superseded_by, created_ts, updated_ts'

interface EntryRow {
  id: string; thread_id: string; kind: string; line: string; body: string; due: string | null
  status: string; source: string; matter_id: string | null; superseded_by: string | null; created_ts: string; updated_ts: string
}

function rowToEntry(r: EntryRow): TopicEntry {
  return {
    id: r.id, threadId: r.thread_id, kind: r.kind as EntryKind, line: r.line, body: r.body, due: r.due,
    status: r.status as EntryStatus, source: r.source as EntrySource, matterId: r.matter_id, supersededBy: r.superseded_by, createdTs: r.created_ts, updatedTs: r.updated_ts,
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
