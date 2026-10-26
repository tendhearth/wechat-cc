import type { Db } from '../../lib/db'
import type { MemoryDerived, MemoryFactEvent, MemoryFactView, NewMemoryFact } from '../../domain/memory/facts'
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
const EVENT_SELECT = `SELECT seq, fact_id AS factId, chat_id AS chatId, ts, action, actor, verdict, prev_text AS prevText, note FROM memory_fact_events`

export function makeMemoryFactsStore(db: Db): MemoryFactsStore {
  const byKey = (chatId: string, key: string): MemoryFactView | null =>
    db.query<MemoryFactView, [string, string]>(`${SELECT} WHERE f.chat_id = ? AND f.key = ?`).get(chatId, key) ?? null
  const insertFact = db.query(`INSERT INTO memory_facts(chat_id, key, doc, subject, section, ord, kind, predicate, related_contact, time_ref,
    confidence, text, status, source, origin, scope, evidence, seen_at, valid_from, invalidated_at, superseded_by, replaces, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertEvent = db.query(`INSERT INTO memory_fact_events(fact_id, chat_id, ts, action, actor, verdict, prev_text, note) VALUES (?,?,?,?,?,NULL,NULL,?)`)

  return {
    insert(facts, by) {
      return db.transaction(() => {
        const inserted: MemoryFactView[] = []
        for (const f of facts) {
          let replaces: number | null = null
          if (f.replacesKey) {
            const target = byKey(f.chatId, f.replacesKey)
            if (!target) throw new Error(`memory-facts: ${f.chatId} ${f.key} replaces ${f.replacesKey}, which is not in the table`)
            replaces = target.id
          }
          const r = insertFact.run(f.chatId, f.key, f.doc, f.subject, f.section ?? null, f.ord ?? 0, f.kind ?? null, f.predicate ?? null,
            f.relatedContact ?? null, f.timeRef ?? null, f.confidence ?? null, f.text, f.status, f.source, f.origin ?? null, f.scope ?? 'chat',
            f.evidence ?? null, f.seenAt ?? null, f.validFrom ?? null, f.invalidatedAt ?? null, f.supersededBy ?? null, replaces, by.ts, by.ts)
          insertEvent.run(Number(r.lastInsertRowid), f.chatId, by.ts, by.action ?? 'added', by.actor, by.note ?? null)
          inserted.push(byKey(f.chatId, f.key)!)
        }
        return inserted
      }).immediate()
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
