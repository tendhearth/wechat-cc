import type { Db } from '../../lib/db'
import type { DesiredFact, FactStatus, MemoryDerived, MemoryFactEvent, MemoryFactView } from '../../domain/memory/facts'
import type { MemoryFactsStore } from '../../ports/memory-facts'
import type { FactRow, KnowledgeFactsStore } from '../../ports/knowledge'
import type { DerivedFence, DerivedKind } from '../../lib/derived-fence'

/** 联系人事实那几行的 chat_id(它们不属于哪个对话;设计稿说「记主人的 chat」,但主人会换、知识库不认主人,固定一个空串)。 */
export const CONTACT_CHAT = ''
/** 从旧事实库导入那几条事件的说明。 */
const LEGACY_NOTE = 'imported from the knowledge facts file'
/** Confidence ranking for upsertFact's merge (higher wins, never downgrades). */
const CONF_RANK: Record<string, number> = { low: 0, med: 1, high: 2 }
import { MIN_RETRACTED_CHARS, normalizeFactText } from '../../domain/memory/corrections'

/**
 * 主人事实表的店面(架构终态 G2,迁移 v87;设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §2.1)。
 * **唯一**写 memory_facts / memory_fact_events / memory_derived 的地方:每次改行都在同一个事务里记一条事件,
 * 一个对话的修订号就是它最大的事件 seq。G2 时还没人调它(G3 的导入是第一个写者)。
 */
const SELECT = `SELECT f.id, f.chat_id AS chatId, f.key, f.doc, f.subject, f.section, f.ord, f.kind, f.predicate,
  f.related_contact AS relatedContact, f.time_ref AS timeRef, f.confidence, f.text, f.status, f.source, f.origin, f.scope,
  f.evidence, f.seen_at AS seenAt, f.valid_from AS validFrom, f.invalidated_at AS invalidatedAt, f.superseded_by AS supersededBy,
  f.replaces, r.key AS replacesKey, f.created_at AS createdAt, f.updated_at AS updatedAt
  FROM memory_facts f LEFT JOIN memory_facts r ON r.id = f.replaces`
const ORDER = ' ORDER BY f.doc, f.ord, f.id'
/** 改字段时比的那几列(ord 不算:顺序变了不记事件)。 */
const FIELDS = ['doc', 'subject', 'section', 'kind', 'predicate', 'relatedContact', 'timeRef', 'confidence', 'text', 'origin', 'scope', 'evidence', 'seenAt', 'validFrom', 'invalidatedAt', 'supersededBy'] as const
const COLUMN: Record<(typeof FIELDS)[number], string> = {
  doc: 'doc', subject: 'subject', section: 'section', kind: 'kind', predicate: 'predicate', relatedContact: 'related_contact', timeRef: 'time_ref',
  confidence: 'confidence', text: 'text', origin: 'origin', scope: 'scope', evidence: 'evidence', seenAt: 'seen_at',
  validFrom: 'valid_from', invalidatedAt: 'invalidated_at', supersededBy: 'superseded_by',
}
const DEFAULTS: Partial<Record<(typeof FIELDS)[number], unknown>> = { scope: 'chat' }
const isRetracted = (s: FactStatus) => s === 'retracted' || s === 'outdated'
const EVENT_SELECT = `SELECT seq, fact_id AS factId, chat_id AS chatId, ts, action, actor, verdict, prev_text AS prevText, note FROM memory_fact_events`

export function makeMemoryFactsStore(db: Db): MemoryFactsStore {
  const byKey = (chatId: string, key: string): MemoryFactView | null =>
    db.query<MemoryFactView, [string, string]>(`${SELECT} WHERE f.chat_id = ? AND f.key = ?`).get(chatId, key) ?? null
  const insertFact = db.query(`INSERT INTO memory_facts(chat_id, key, doc, subject, section, ord, kind, predicate, related_contact, time_ref,
    confidence, text, status, source, origin, scope, evidence, seen_at, valid_from, invalidated_at, superseded_by, replaces, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertEvent = db.query(`INSERT INTO memory_fact_events(fact_id, chat_id, ts, action, actor, verdict, prev_text, note) VALUES (?,?,?,?,?,NULL,NULL,?)`)
  const event = db.query(`INSERT INTO memory_fact_events(fact_id, chat_id, ts, action, actor, verdict, prev_text, note) VALUES (?,?,?,?,?,?,?,?)`)
  const notesOf = (factId: number): string =>
    db.query<{ note: string }, [number]>('SELECT note FROM memory_fact_events WHERE fact_id = ? AND note IS NOT NULL ORDER BY seq').all(factId).map(r => r.note).join('')
  const verdictOf = (factId: number): string | null =>
    db.query<{ verdict: string }, [number]>('SELECT verdict FROM memory_fact_events WHERE fact_id = ? AND verdict IS NOT NULL ORDER BY seq DESC LIMIT 1').get(factId)?.verdict ?? null
  const resolveReplaces = (f: DesiredFact): number | null => {
    if (!f.replacesKey) return null
    const target = byKey(f.chatId, f.replacesKey)
    if (!target) throw new Error(`memory-facts: ${f.chatId} ${f.key} replaces ${f.replacesKey}, which is not in the table`)
    return target.id
  }
  const atomically = <T>(fn: () => T): T => db.transaction(fn).immediate()

  /** 改状态只经这里(G5 起守卫钉住:`UPDATE memory_facts SET status` 只在本文件)。 */
  const setStatus = (id: number, status: FactStatus, ts: number) => { db.query('UPDATE memory_facts SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id) }


  // ---- 联系人事实(架构终态 G7:以前在 knowledge/facts.db)----------------------------------------------------------
  // memory_facts 里 doc = 'contact' 的行,chat_id = CONTACT_CHAT,key = 'k:<id>'(id 就是 facts.db 的原 id,待办页 / MCP 认它)。
  // 时间列沿用 facts.db 的单位(秒);事件的 ts 照表里别的事件用毫秒。facts 的 'rejected' 在表里是 'retracted'(进出时换名)。
  const C = CONTACT_CHAT
  const FACT_SELECT = `SELECT CAST(substr(key, 3) AS INTEGER) AS id, subject AS contact, kind, predicate, text AS value, related_contact,
    time_ref, confidence, evidence AS source_msg_keys, CASE status WHEN 'retracted' THEN 'rejected' ELSE status END AS status,
    created_at, updated_at, valid_from, invalidated_at, superseded_by FROM memory_facts WHERE doc = 'contact'`
  const toStatus = (s: string): string => (s === 'rejected' ? 'retracted' : s)
  const parseRow = (r: any): FactRow => ({ ...r, confidence: r.confidence ?? 'med', source_msg_keys: r.source_msg_keys ? JSON.parse(r.source_msg_keys) : [] })
  const rows = (sql: string, ...args: unknown[]): FactRow[] => (db.query(sql).all(...(args as never[])) as any[]).map(parseRow)
  const factRowId = (factId: number): number | null =>
    db.query<{ id: number }, [string, string]>('SELECT id FROM memory_facts WHERE chat_id = ? AND key = ?').get(C, `k:${factId}`)?.id ?? null
  const factEvent = (rowId: number, nowSec: number, action: string, note: string | null = null) =>
    event.run(rowId, C, nowSec * 1000, action, 'judge', null, null, note)
  /** 改联系人事实的状态只经这几个(和记忆那边的 retract / restore / resolve / supersede 同一个 setStatus)。 */
  const factTransition = (factId: number, to: FactStatus, nowSec: number, action: string, onlyFrom?: FactStatus): boolean => {
    const rowId = factRowId(factId)
    if (rowId === null) return false
    const cur = db.query<{ status: FactStatus }, [number]>('SELECT status FROM memory_facts WHERE id = ?').get(rowId)!.status
    if (onlyFrom && cur !== onlyFrom) return false
    setStatus(rowId, to, nowSec)
    factEvent(rowId, nowSec, action)
    return true
  }
  /** 下一个联系人事实 id:表里最大的、和旧事实库还没导完时它最大的,两者取大再加一(永远不和旧库撞 id)。 */
  const FLOOR_MARK = '__facts.db.id_floor__'
  const contactIdFloor = () => Number(db.query<{ h: string }, [string]>('SELECT files_hash AS h FROM memory_import WHERE chat_id = ?').get(FLOOR_MARK)?.h ?? 0) || 0
  const nextContactId = () => Math.max(
    db.query<{ m: number | null }, []>("SELECT MAX(CAST(substr(key, 3) AS INTEGER)) AS m FROM memory_facts WHERE doc = 'contact'").get()?.m ?? 0,
    contactIdFloor(),
  ) + 1
  const contactFacts: KnowledgeFactsStore = {
    upsertFact(fact, now) {
      return atomically(() => {
        const keys = [...(fact.source_msg_keys ?? [])]
        const conf = fact.confidence || 'med'
        const cur = rows(`${FACT_SELECT} AND subject = ? AND predicate = ? AND text = ?`, fact.contact, fact.predicate, fact.value)[0]
        if (!cur) {
          const next = nextContactId()
          const r = insertFact.run(C, `k:${next}`, 'contact', fact.contact, null, 0, fact.kind ?? null, fact.predicate, fact.related_contact ?? null,
            fact.time_ref ?? null, conf, fact.value, 'active', 'extract', null, 'chat', JSON.stringify(keys), null, now, null, null, null, now, now)
          factEvent(Number(r.lastInsertRowid), now, 'added')
          return { outcome: 'inserted' as const, id: next }
        }
        const merged = [...new Set([...cur.source_msg_keys, ...keys])] // ordered union
        const best = (CONF_RANK[conf] ?? 1) > (CONF_RANK[cur.confidence ?? 'med'] ?? 1) ? conf : cur.confidence
        db.query(`UPDATE memory_facts SET kind = ?, related_contact = ?, time_ref = ?, confidence = ?, evidence = ?, updated_at = ?
          WHERE chat_id = ? AND key = ?`) // status + valid_from untouched
          .run(fact.kind || cur.kind, fact.related_contact || cur.related_contact, fact.time_ref || cur.time_ref, best, JSON.stringify(merged), now, C, `k:${cur.id}`)
        return { outcome: 'merged' as const, id: cur.id }
      })
    },
    activeFactsSharingPredicate(contact, predicate, excludeValue) {
      return rows(`${FACT_SELECT} AND subject = ? AND predicate = ? AND text <> ? AND status = 'active' ORDER BY updated_at DESC`, contact, predicate, excludeValue)
    },
    supersedeFactById(oldId, newId, now) {
      return atomically(() => {
        if (!factTransition(oldId, 'superseded', now, 'superseded', 'active')) return false
        db.query('UPDATE memory_facts SET invalidated_at = ?, superseded_by = ? WHERE chat_id = ? AND key = ?').run(now, newId, C, `k:${oldId}`)
        return true
      })
    },
    factById(id) { return rows(`${FACT_SELECT} AND key = ?`, `k:${id}`)[0] ?? null },
    obligationHeavyContacts(limit, minCount = 2) {
      return db.query(`SELECT subject AS contact, COUNT(*) AS n FROM memory_facts WHERE doc = 'contact' AND kind = 'obligation' AND status = 'active'
        GROUP BY subject HAVING n >= ? ORDER BY n DESC LIMIT ?`).all(minCount, limit) as Array<{ contact: string; n: number }>
    },
    conflictedFactGroups(limit) {
      const groups = db.query(`SELECT subject AS contact, predicate FROM memory_facts WHERE doc = 'contact' AND status = 'active'
        GROUP BY subject, predicate HAVING COUNT(DISTINCT text) >= 2 ORDER BY MAX(updated_at) DESC LIMIT ?`).all(limit) as Array<{ contact: string; predicate: string }>
      return groups.map(g => ({ contact: g.contact, predicate: g.predicate,
        facts: rows(`${FACT_SELECT} AND subject = ? AND predicate = ? AND status = 'active' ORDER BY updated_at DESC, id DESC`, g.contact, g.predicate) }))
    },
    judgeFingerprint(key) {
      return db.query<{ fingerprint: string | null }, [string]>('SELECT fingerprint FROM knowledge_judge_state WHERE key = ?').get(key)?.fingerprint ?? null
    },
    setJudgeFingerprint(key, fingerprint, now) {
      db.query(`INSERT INTO knowledge_judge_state(key, fingerprint, judged_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET fingerprint = excluded.fingerprint, judged_at = excluded.judged_at`).run(key, fingerprint, now)
    },
    factWatermark(contact) {
      const r = db.query<{ last_ts: number; last_local_id: number }, [string]>('SELECT last_ts, last_local_id FROM knowledge_extraction_state WHERE contact = ?').get(contact)
      return r ? [r.last_ts, r.last_local_id] : [0, 0]
    },
    advanceFactWatermark(contact, ts, localId, now) {
      const [pt, pl] = contactFacts.factWatermark(contact)
      const nt = ts > pt || (ts === pt && localId > pl) ? [ts, localId] : [pt, pl] // monotonic tuple
      db.query(`INSERT INTO knowledge_extraction_state(contact, last_ts, last_local_id, updated_at) VALUES (?,?,?,?)
        ON CONFLICT(contact) DO UPDATE SET last_ts = excluded.last_ts, last_local_id = excluded.last_local_id, updated_at = excluded.updated_at`)
        .run(contact, nt[0]!, nt[1]!, now)
    },
    allFactWatermarks() {
      const m = new Map<string, [number, number]>()
      for (const r of db.query<{ contact: string; last_ts: number; last_local_id: number }, []>('SELECT contact, last_ts, last_local_id FROM knowledge_extraction_state').all())
        m.set(r.contact, [r.last_ts, r.last_local_id])
      return m
    },
    factsForContact(contact, status) {
      return rows(`${FACT_SELECT} AND subject = ? AND status = ? ORDER BY updated_at DESC`, contact, toStatus(status))
    },
    findFactRows(kind, predicate, query, status, limit) {
      let sql = `${FACT_SELECT} AND status = ?`
      const args: unknown[] = [toStatus(status)]
      if (kind) { sql += ' AND kind = ?'; args.push(kind) }
      if (predicate) { sql += ' AND predicate = ?'; args.push(predicate) }
      if (query) { sql += " AND (predicate LIKE '%'||?||'%' OR text LIKE '%'||?||'%')"; args.push(query, query) }
      sql += ' ORDER BY updated_at DESC LIMIT ?'
      args.push(limit)
      return rows(sql, ...args)
    },
    changeFactStatus(id, status, now) {
      return atomically(() => {
        switch (status) {
          case 'resolved': return factTransition(id, 'resolved', now, 'resolved')
          case 'rejected': return factTransition(id, 'retracted', now, 'retracted')
          case 'superseded': return factTransition(id, 'superseded', now, 'superseded')
          case 'active': return factTransition(id, 'active', now, 'restored')
          default: return false
        }
      })
    },
    factCountsByKind() {
      const out: Record<string, number> = {}
      for (const r of db.query<{ kind: string; n: number }, []>("SELECT kind, COUNT(*) AS n FROM memory_facts WHERE doc = 'contact' GROUP BY kind").all()) out[r.kind] = r.n
      return out
    },
  }

  // ---- 生成物的过期围栏(架构终态 G8)----------------------------------------------------------------------------
  const fenceRow = (chatId: string) => db.query<{ rev: number; overview_retracted: number; profile_retracted: number }, [string]>(
    'SELECT rev, overview_retracted, profile_retracted FROM memory_source_revisions WHERE chat_id = ?').get(chatId) ?? null
  const fence = (chatId: string): DerivedFence => {
    const rev = () => fenceRow(chatId)?.rev ?? 0
    const derivedRev = (kind: DerivedKind) => db.query<{ r: number }, [string, string]>('SELECT input_rev AS r FROM memory_derived WHERE chat_id = ? AND kind = ?').get(chatId, kind)?.r ?? null
    // 没有围栏行(从没改过源)⇒ 生成物算新的(和以前没有 .derived-state.json 时一样)
    const fresh = (kind: DerivedKind) => { const row = fenceRow(chatId); return !row || derivedRev(kind) === row.rev }
    const self: DerivedFence = {
      revision: rev,
      isStale: (kind) => !fresh(kind),
      status(kind) {
        if (fresh(kind)) return 'fresh'
        return (fenceRow(chatId)?.[`${kind}_retracted`] ?? 1) ? 'retracted' : 'added'
      },
      invalidate(reason = 'retracted') {
        atomically(() => {
          const row = fenceRow(chatId)
          // 已经因为 retracted 过期、还没重新生成的,别被一次 added 冲掉
          const flag = (kind: DerivedKind) => (reason === 'retracted' ? 1 : (!row || fresh(kind)) ? 0 : row[`${kind}_retracted`])
          const o = flag('overview'), p = flag('profile'), next = (row?.rev ?? 0) + 1
          db.query(`INSERT INTO memory_source_revisions(chat_id, rev, overview_retracted, profile_retracted, updated_at) VALUES (?,?,?,?,?)
            ON CONFLICT(chat_id) DO UPDATE SET rev = excluded.rev, overview_retracted = excluded.overview_retracted, profile_retracted = excluded.profile_retracted, updated_at = excluded.updated_at`)
            .run(chatId, next, o, p, Date.now())
        })
      },
      commit(kind, expectedRevision, body, write) {
        if (rev() !== expectedRevision) return false
        write()
        if (rev() !== expectedRevision) return false   // 同步写的时候源又被改了:不盖住更新的围栏
        atomically(() => {
          db.query(`INSERT INTO memory_derived(chat_id, kind, body, input_rev, generated_at) VALUES (?,?,?,?,?)
            ON CONFLICT(chat_id, kind) DO UPDATE SET body = excluded.body, input_rev = excluded.input_rev, generated_at = excluded.generated_at`)
            .run(chatId, kind, body, expectedRevision, Date.now())
          if (fenceRow(chatId)) db.query(`UPDATE memory_source_revisions SET ${kind}_retracted = 0 WHERE chat_id = ?`).run(chatId)
          else db.query('INSERT INTO memory_source_revisions(chat_id, rev, updated_at) VALUES (?, 0, ?)').run(chatId, Date.now())
        })
        return true
      },
      body: (kind) => db.query<{ body: string }, [string, string]>('SELECT body FROM memory_derived WHERE chat_id = ? AND kind = ?').get(chatId, kind)?.body || null,
      generatedAt: (kind) => db.query<{ at: number }, [string, string]>('SELECT generated_at AS at FROM memory_derived WHERE chat_id = ? AND kind = ?').get(chatId, kind)?.at ?? null,
    }
    return self
  }

  return {
    fence,
    importFence(chatId, st, at) {
      return atomically(() => {
        if (fenceRow(chatId)) return false
        const stale = !st.fresh.overview || !st.fresh.profile
        const r = stale ? 1 : 0
        db.query('INSERT INTO memory_source_revisions(chat_id, rev, overview_retracted, profile_retracted, updated_at) VALUES (?,?,?,?,?)')
          .run(chatId, r, st.fresh.overview ? 0 : st.retracted.overview ? 1 : 0, st.fresh.profile ? 0 : st.retracted.profile ? 1 : 0, at)
        for (const kind of ['overview', 'profile'] as const) {
          // 没有原文、旧围栏说它是新的 ⇒ 记一行空正文,只为了「新」这个状态(读正文的把空当没有)
          const b = st.bodies[kind] ?? (st.fresh[kind] ? { body: '', at } : null)
          if (!b) continue
          db.query(`INSERT INTO memory_derived(chat_id, kind, body, input_rev, generated_at) VALUES (?,?,?,?,?)
            ON CONFLICT(chat_id, kind) DO NOTHING`).run(chatId, kind, b.body, st.fresh[kind] ? r : r - 1, b.at)
        }
        return true
      })
    },
    contactFacts,
    contactIdFloor,
    contactFactByText: (contact, predicate, value) => rows(`${FACT_SELECT} AND subject = ? AND predicate = ? AND text = ?`, contact, predicate, value)[0] ?? null,
    raiseContactIdFloor(maxLegacyId) {
      if (maxLegacyId <= contactIdFloor()) return
      db.query(`INSERT INTO memory_import(chat_id, files_hash, at) VALUES (?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET files_hash = excluded.files_hash, at = excluded.at`).run(FLOOR_MARK, String(maxLegacyId), Date.now())
    },
    /**
     * 旧事实库的一行进表(调用方已经把它规整好:状态是认得的四种之一、数字是整数、正文 / 联系人不为空)。
     * 认「是不是同一件事」看 (联系人, 谓语, 内容),不看 id —— 老二进制回滚后用 max(rowid)+1 编的号可能正好是新二进制用过的:
     *  - 表里已经有这一句 ⇒ 同一件事:facts.db 那边严格更新过才照改,否则不动;
     *  - 没有这一句、原 id 空着 ⇒ 用原 id 插;
     *  - 没有这一句、原 id 被别的事实占了 ⇒ 冲突:换一个新 id 插,事件里记下原 id(`reassigned`)。
     */
    importContactFact(f, nowMs, notes = []) {
      return atomically(() => {
        const st = toStatus(f.status ?? 'active') as FactStatus
        const same = rows(`${FACT_SELECT} AND subject = ? AND predicate = ? AND text = ?`, f.contact, f.predicate, f.value)[0]
        if (!same) {
          const taken = contactFacts.factById(f.id) !== null
          const id = taken ? nextContactId() : f.id
          const r = insertFact.run(C, `k:${id}`, 'contact', f.contact, null, 0, f.kind ?? null, f.predicate, f.related_contact ?? null, f.time_ref ?? null,
            f.confidence ?? 'med', f.value, st, 'import', null, 'chat', JSON.stringify(f.source_msg_keys ?? []), null,
            f.valid_from ?? null, f.invalidated_at ?? null, f.superseded_by ?? null, null, f.created_at, f.updated_at)
          const rowId = Number(r.lastInsertRowid)
          event.run(rowId, C, nowMs, 'added', 'import', null, null, [LEGACY_NOTE, ...(taken ? [`id ${f.id} was taken by another fact; reassigned to ${id}`] : []), ...notes].join('; '))
          if (st === 'retracted') event.run(rowId, C, nowMs, 'retracted', 'import', null, null, `${LEGACY_NOTE}: rejected`)
          if (st === 'superseded') event.run(rowId, C, nowMs, 'superseded', 'import', null, null, f.superseded_by ? `by:k:${f.superseded_by}` : null)
          if (st === 'resolved') event.run(rowId, C, nowMs, 'resolved', 'import', null, null, LEGACY_NOTE)
          return { outcome: taken ? 'reassigned' as const : 'inserted' as const, id }
        }
        if ((f.updated_at ?? 0) <= (same.updated_at ?? 0)) return { outcome: 'same' as const, id: same.id }
        const rowId = factRowId(same.id)!
        db.query(`UPDATE memory_facts SET kind = ?, related_contact = ?, time_ref = ?, confidence = ?, evidence = ?,
          valid_from = ?, invalidated_at = ?, superseded_by = ?, updated_at = ? WHERE id = ?`)
          .run(f.kind ?? null, f.related_contact ?? null, f.time_ref ?? null, f.confidence ?? 'med', JSON.stringify(f.source_msg_keys ?? []),
            f.valid_from ?? null, f.invalidated_at ?? null, f.superseded_by ?? null, f.updated_at, rowId)
        const note = [LEGACY_NOTE, ...notes].join('; ')
        if (toStatus(same.status) !== st) { setStatus(rowId, st, f.updated_at); event.run(rowId, C, nowMs, st === 'active' ? 'restored' : st === 'retracted' ? 'retracted' : st, 'import', null, null, note) }
        else event.run(rowId, C, nowMs, 'updated', 'import', null, null, note)
        return { outcome: 'updated' as const, id: same.id }
      })
    },
    importFactWatermark(contact, lastTs, lastLocalId, updatedAt) {
      const [pt, pl] = contactFacts.factWatermark(contact)
      if (lastTs > pt || (lastTs === pt && lastLocalId > pl)) contactFacts.advanceFactWatermark(contact, lastTs, lastLocalId, updatedAt)
    },
    importJudgeState(key, fingerprint, judgedAt) {
      const cur = db.query<{ judged_at: number }, [string]>('SELECT judged_at FROM knowledge_judge_state WHERE key = ?').get(key)
      if (!cur || cur.judged_at < judgedAt) db.query(`INSERT INTO knowledge_judge_state(key, fingerprint, judged_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET fingerprint = excluded.fingerprint, judged_at = excluded.judged_at`).run(key, fingerprint, judgedAt)
    },
    atomically,
    mirror(chatId, desired, opts) {
      return atomically(() => {
        const ts = opts.by.ts, actor = opts.by.actor
        const res = { added: 0, updated: 0, statusChanged: 0, gone: 0 }
        const seen = new Set<string>()
        for (const f of desired) {
          if (f.chatId !== chatId) throw new Error(`memory-facts: mirror(${chatId}) got a row for ${f.chatId}`)
          seen.add(f.key)
          const cur = byKey(chatId, f.key)
          const replaces = resolveReplaces(f)
          if (!cur) {
            const r = insertFact.run(f.chatId, f.key, f.doc, f.subject, f.section ?? null, f.ord ?? 0, f.kind ?? null, f.predicate ?? null,
              f.relatedContact ?? null, f.timeRef ?? null, f.confidence ?? null, f.text, f.status, f.source, f.origin ?? null, f.scope ?? 'chat',
              f.evidence ?? null, f.seenAt ?? null, f.validFrom ?? null, f.invalidatedAt ?? null, f.supersededBy ?? null, replaces, ts, ts)
            event.run(Number(r.lastInsertRowid), chatId, ts, isRetracted(f.status) ? 'retracted' : 'added', actor, f.verdict ?? null, null, f.notes?.join('') || null)
            res.added++
            continue
          }
          const changed = FIELDS.filter(k => ((f as Record<string, unknown>)[k] ?? DEFAULTS[k] ?? null) !== ((cur as unknown as Record<string, unknown>)[k] ?? null))
          if (changed.length || replaces !== cur.replaces) {
            const sets = [...changed.map(k => `${COLUMN[k]} = ?`), 'replaces = ?', 'updated_at = ?']
            db.query(`UPDATE memory_facts SET ${sets.join(', ')} WHERE id = ?`).run(...changed.map(k => ((f as Record<string, unknown>)[k] ?? DEFAULTS[k] ?? null) as never), replaces, ts, cur.id)
            event.run(cur.id, chatId, ts, 'updated', actor, null, changed.includes('text') ? cur.text : null, null)
            res.updated++
          }
          if ((f.ord ?? 0) !== cur.ord) db.query('UPDATE memory_facts SET ord = ? WHERE id = ?').run(f.ord ?? 0, cur.id)
          if (f.status !== cur.status) {
            setStatus(cur.id, f.status, ts)
            event.run(cur.id, chatId, ts, f.status === 'active' ? 'restored' : isRetracted(f.status) ? 'retracted' : 'updated', actor, f.verdict ?? null, null, null)
            res.statusChanged++
          }
          const want = f.notes?.join('') ?? ''
          if (want) {
            const have = notesOf(cur.id)
            if (want !== have && want.startsWith(have)) { event.run(cur.id, chatId, ts, 'updated', actor, null, null, want.slice(have.length)); res.updated++ }
          }
        }
        for (const r of db.query<{ id: number; key: string }, [string]>("SELECT id, key FROM memory_facts WHERE chat_id = ? AND status = 'active'").all(chatId)) {
          if (seen.has(r.key) || r.key.startsWith('c:') || !opts.goneIf(r.key)) continue
          setStatus(r.id, 'outdated', ts)
          event.run(r.id, chatId, ts, 'updated', actor, 'gone', null, null)
          res.gone++
        }
        return res
      })
    },
    tombstones(chatId) {
      return db.query<{ id: number; key: string; kind: string | null; section: string | null; ord: number; text: string; seenAt: string | null; status: FactStatus }, [string]>(
        "SELECT id, key, kind, section, ord, text, seen_at AS seenAt, status FROM memory_facts WHERE chat_id = ? AND key LIKE 'c:%' ORDER BY ord, id",
      ).all(chatId).map(t => ({ ...t, verdict: verdictOf(t.id), notes: [notesOf(t.id)].filter(Boolean) }))
    },
    importHash(chatId) {
      return db.query<{ h: string }, [string]>('SELECT files_hash AS h FROM memory_import WHERE chat_id = ?').get(chatId)?.h ?? null
    },
    setImportHash(chatId, filesHash, at) {
      db.query(`INSERT INTO memory_import(chat_id, files_hash, at) VALUES (?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET files_hash = excluded.files_hash, at = excluded.at`).run(chatId, filesHash, at)
    },
    retract(chatId, ref, opts) {
      return atomically(() => {
        const ts = opts.by.ts, actor = opts.by.actor
        const status: FactStatus = opts.verdict === 'outdated' ? 'outdated' : 'retracted'
        let targets: MemoryFactView[] = []
        if ('key' in ref) {
          const row = byKey(chatId, ref.key)
          if (row && !ref.key.startsWith('c:') && row.status !== 'retracted') targets = [row]
        } else {
          const n = normalizeFactText(ref.text)
          if ([...n].length >= MIN_RETRACTED_CHARS) {
            targets = db.query<MemoryFactView, [string]>(`${SELECT} WHERE f.chat_id = ? AND f.status IN ('active', 'outdated') AND (f.key LIKE 'm:%' OR f.key LIKE 'u:%' OR f.key LIKE 'o:%')`)
              .all(chatId).filter(r => normalizeFactText(r.text) === n)
          }
        }
        // 正文优先用调用方给的那句;按 key 收回、调用方没给时才用表里那一行的;都没有 ⇒ 不收回(不许拿 key 当正文)
        const text = opts.text?.trim() || ('key' in ref ? (targets[0]?.text ?? byKey(chatId, ref.key)?.text ?? null) : ref.text)
        if (!text) throw new Error(`memory-facts: retract ${'key' in ref ? ref.key : '(text)'} without the sentence itself`)
        const tombs = db.query<{ key: string; ord: number }, [string]>("SELECT key, ord FROM memory_facts WHERE chat_id = ? AND key LIKE 'c:%'").all(chatId)
        const key = opts.correctionId ? `c:${opts.correctionId}` : `c:~${tombs.filter(t => t.key.startsWith('c:~')).length + 1}`
        const ord = tombs.reduce((m, t) => Math.max(m, t.ord + 1), 0)
        const r = insertFact.run(chatId, key, 'memory', 'owner', opts.section, ord, null, null, null, null, null, text, status, 'review', null, 'chat',
          null, opts.day, null, null, null, null, ts, ts)
        const tombId = Number(r.lastInsertRowid)
        event.run(tombId, chatId, ts, 'retracted', actor, opts.verdict, null, opts.note || null)
        for (const t of targets) {
          setStatus(t.id, status, ts)
          event.run(t.id, chatId, ts, 'retracted', actor, opts.verdict, null, `by:${key}`)
        }
        return { key, targets: targets.map(t => t.key) }
      })
    },
    restore(chatId, tombstoneKey, by) {
      return atomically(() => {
        const tomb = byKey(chatId, tombstoneKey)
        if (!tomb || !tombstoneKey.startsWith('c:') || (tomb.status !== 'retracted' && tomb.status !== 'outdated')) return null
        setStatus(tomb.id, 'superseded', by.ts)
        event.run(tomb.id, chatId, by.ts, 'restored', by.actor, null, null, '之前随之删掉的笔记行不会回来')
        const restored: string[] = []
        const hit = db.query<{ id: number; key: string; status: FactStatus }, [string, string]>(
          "SELECT DISTINCT f.id, f.key, f.status FROM memory_fact_events e JOIN memory_facts f ON f.id = e.fact_id WHERE e.chat_id = ? AND e.action = 'retracted' AND e.note = ?",
        ).all(chatId, `by:${tombstoneKey}`)
        for (const t of hit) {
          if (t.status === 'active') continue
          setStatus(t.id, 'active', by.ts)
          event.run(t.id, chatId, by.ts, 'restored', by.actor, null, null, `by:${tombstoneKey}`)
          restored.push(t.key)
        }
        return { restored }
      })
    },
    resolve(chatId, key, by) {
      return atomically(() => {
        const row = byKey(chatId, key)
        if (!row || row.status !== 'active') return false
        setStatus(row.id, 'resolved', by.ts)
        event.run(row.id, chatId, by.ts, 'resolved', by.actor, null, null, null)
        return true
      })
    },
    supersede(chatId, key, byKey_, by) {
      return atomically(() => {
        const row = byKey(chatId, key), keeper = byKey(chatId, byKey_)
        if (!row || !keeper || row.status !== 'active') return false
        setStatus(row.id, 'superseded', by.ts)
        db.query('UPDATE memory_facts SET superseded_by = ?, invalidated_at = ? WHERE id = ?').run(keeper.id, by.ts, row.id)
        event.run(row.id, chatId, by.ts, 'superseded', by.actor, null, null, `by:${byKey_}`)
        return true
      })
    },
    addEvent(chatId, key, e, by) {
      const cur = byKey(chatId, key)
      if (!cur) return false
      event.run(cur.id, chatId, by.ts, e.action, by.actor, e.verdict ?? null, null, e.note ?? null)
      return true
    },
    addNote(chatId, key, note, by) {
      const cur = byKey(chatId, key)
      if (!cur) return false
      event.run(cur.id, chatId, by.ts, 'updated', by.actor, null, null, note)
      return true
    },
    exportRecord(chatId, file) {
      return db.query<{ sha256: string | null; pending: string | null }, [string, string]>('SELECT sha256, pending_sha256 AS pending FROM memory_exports WHERE chat_id = ? AND file = ?').get(chatId, file) ?? null
    },
    markExportPending(chatId, file, sha256, at) {
      db.query(`INSERT INTO memory_exports(chat_id, file, sha256, pending_sha256, at) VALUES (?,?,NULL,?,?)
        ON CONFLICT(chat_id, file) DO UPDATE SET pending_sha256 = excluded.pending_sha256, at = excluded.at`).run(chatId, file, sha256, at)
    },
    markExportDone(chatId, file, sha256, at) {
      db.query(`INSERT INTO memory_exports(chat_id, file, sha256, pending_sha256, at) VALUES (?,?,?,NULL,?)
        ON CONFLICT(chat_id, file) DO UPDATE SET sha256 = excluded.sha256, pending_sha256 = NULL, at = excluded.at`).run(chatId, file, sha256, at)
    },
    insert(facts, by) {
      return atomically(() => {
        const inserted: MemoryFactView[] = []
        for (const f of facts) {
          const replaces = resolveReplaces(f)
          const r = insertFact.run(f.chatId, f.key, f.doc, f.subject, f.section ?? null, f.ord ?? 0, f.kind ?? null, f.predicate ?? null,
            f.relatedContact ?? null, f.timeRef ?? null, f.confidence ?? null, f.text, f.status, f.source, f.origin ?? null, f.scope ?? 'chat',
            f.evidence ?? null, f.seenAt ?? null, f.validFrom ?? null, f.invalidatedAt ?? null, f.supersededBy ?? null, replaces, by.ts, by.ts)
          insertEvent.run(Number(r.lastInsertRowid), f.chatId, by.ts, by.action ?? 'added', by.actor, by.note ?? null)
          inserted.push(byKey(f.chatId, f.key)!)
        }
        return inserted
      })
    },
    list(chatId, filter = {}) {
      const where = ['f.chat_id = ?']
      const params: string[] = [chatId]
      if (filter.doc) { where.push('f.doc = ?'); params.push(filter.doc) }
      if (filter.statuses?.length) { where.push(`f.status IN (${filter.statuses.map(() => '?').join(',')})`); params.push(...filter.statuses) }
      return db.query<MemoryFactView, string[]>(`${SELECT} WHERE ${where.join(' AND ')}${ORDER}`).all(...params)
    },
    byKey,
    lastEventAt(chatId) {
      return db.query<{ ts: number | null }, [string]>('SELECT MAX(ts) AS ts FROM memory_fact_events WHERE chat_id = ?').get(chatId)?.ts ?? null
    },
    revision(chatId) {
      return db.query<{ rev: number | null }, [string]>('SELECT MAX(seq) AS rev FROM memory_fact_events WHERE chat_id = ?').get(chatId)?.rev ?? 0
    },
    events(chatId, afterSeq = 0) {
      return db.query<MemoryFactEvent, [string, number]>(`${EVENT_SELECT} WHERE chat_id = ? AND seq > ? ORDER BY seq`).all(chatId, afterSeq)
    },
    getDerived(chatId, kind) {
      return db.query<MemoryDerived, [string, string]>('SELECT chat_id AS chatId, kind, body, input_rev AS inputRev, generated_at AS generatedAt FROM memory_derived WHERE chat_id = ? AND kind = ?').get(chatId, kind) ?? null
    },
    putDerived(d) {
      db.query(`INSERT INTO memory_derived(chat_id, kind, body, input_rev, generated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(chat_id, kind) DO UPDATE SET body = excluded.body, input_rev = excluded.input_rev, generated_at = excluded.generated_at`)
        .run(d.chatId, d.kind, d.body, d.inputRev, d.generatedAt)
    },
  }
}
