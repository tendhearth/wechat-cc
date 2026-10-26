import type { Db } from '../../lib/db'
import type { DesiredFact, FactStatus, MemoryDerived, MemoryFactEvent, MemoryFactView } from '../../domain/memory/facts'
import type { MemoryFactsStore } from '../../ports/memory-facts'

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

  return {
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
