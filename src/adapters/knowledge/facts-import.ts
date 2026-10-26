/**
 * 开机一次:knowledge/facts.db → 主库(架构终态 G7,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md
 * §3「数据怎么搬」第 2 条)。联系人事实变成 memory_facts 里 doc = 'contact' 的行(key = `k:<原 id>`,id、状态、时间一一对应),
 * 抽取水位与判官指纹进 knowledge_* 两张表。
 *
 *  - 一个事务;导完逐行核对(表里读出来的和 facts.db 的那一行每个字段都一样)才记「导过了」,不等 ⇒ 整个回滚、日志写第一处差异。
 *  - **facts.db 只读、不删、不改名**(主人 10-26 第 5 条的 `*.imported-*` 规矩):第一次导完用 `VACUUM INTO` 复制一份
 *    `facts.db.imported-<日期>`(连 WAL 里没落盘的一起);原文件留着给回滚的老二进制。
 *  - 之后知识库不再打开 facts.db。指纹(所有行的摘要)变了 ⇒ 回滚过的老二进制写过它 ⇒ 再导一次:没有的插、facts.db 那边更新过的照它改。
 * `'facts.db'` 这个文件名只许出现在这里(scripts/facts-db.guard.test.ts 守)。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openSqlite, type SqlDatabase } from '../../lib/runtime/sqlite'
import type { FactRow } from '../../ports/knowledge'
import type { MemoryFactsStore } from '../../ports/memory-facts'

export const FACTS_DB_FILE = 'facts.db'
/** memory_import 里记 facts.db 导入的那一行(不是哪个对话)。 */
export const FACTS_IMPORT_MARK = '__facts.db__'

export type FactsImportOutcome =
  | { outcome: 'none' | 'unchanged' }
  | { outcome: 'imported'; first: boolean; inserted: number; updated: number }
  | { outcome: 'mismatch'; diff: string }

const cols = (db: SqlDatabase, table: string): Set<string> => {
  try { return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(c => c.name)) } catch { return new Set() }
}

/** facts.db 里的行(老形状缺的列当 NULL;valid_from 缺就用 created_at,和 G1 的 v001 回填一样)。 */
function legacyRows(db: SqlDatabase): FactRow[] {
  const c = cols(db, 'facts')
  if (!c.size) return []
  const pick = (n: string) => (c.has(n) ? n : `NULL AS ${n}`)
  const raw = db.query<any, []>(`SELECT id, contact, kind, predicate, value, related_contact, time_ref, confidence, source_msg_keys, status,
    created_at, updated_at, ${c.has('valid_from') ? 'valid_from' : 'created_at AS valid_from'},
    ${pick('invalidated_at')}, ${pick('superseded_by')} FROM facts ORDER BY id`).all()
  return raw.map(r => ({ ...r, confidence: r.confidence ?? 'med', status: r.status ?? 'active', source_msg_keys: r.source_msg_keys ? JSON.parse(r.source_msg_keys) : [] }))
}

function digest(rows: FactRow[], marks: unknown[], judges: unknown[]): string {
  return createHash('sha256').update(JSON.stringify([rows, marks, judges])).digest('hex')
}

const FIELDS = ['id', 'contact', 'kind', 'predicate', 'value', 'related_contact', 'time_ref', 'confidence', 'source_msg_keys', 'status', 'created_at', 'updated_at', 'valid_from', 'invalidated_at', 'superseded_by'] as const
const canon = (r: FactRow) => JSON.stringify(FIELDS.map(k => (r as unknown as Record<string, unknown>)[k] ?? null))
const same = (a: FactRow, b: FactRow) => canon(a) === canon(b)

class Mismatch extends Error {}   // 核对不过(上面 catch 统一按「不搬」处理)

export function importFactsDb(d: { store: MemoryFactsStore; knowledgeRoot: string; now: () => number; log: (tag: string, line: string) => void }): FactsImportOutcome {
  const file = join(d.knowledgeRoot, FACTS_DB_FILE)
  if (!existsSync(file)) return { outcome: 'none' }
  const legacy = openSqlite(file, { readonly: true })
  try {
    const rows = legacyRows(legacy)
    const marks = cols(legacy, 'extraction_state').size ? legacy.query<{ contact: string; last_ts: number; last_local_id: number | null; updated_at: number | null }, []>('SELECT contact, last_ts, last_local_id, updated_at FROM extraction_state ORDER BY contact').all() : []
    const judges = cols(legacy, 'judge_state').size ? legacy.query<{ key: string; fingerprint: string | null; judged_at: number | null }, []>('SELECT key, fingerprint, judged_at FROM judge_state ORDER BY key').all() : []
    const h = digest(rows, marks, judges)
    const prior = d.store.importHash(FACTS_IMPORT_MARK)
    if (prior === h) return { outcome: 'unchanged' }
    const nowMs = d.now()
    let inserted = 0, updated = 0
    try {
      d.store.atomically(() => {
        for (const r of rows) {
          const o = d.store.importContactFact(r, nowMs)
          if (o === 'inserted') inserted++
          else if (o === 'updated') updated++
        }
        for (const m of marks) d.store.importFactWatermark(m.contact, m.last_ts ?? 0, m.last_local_id ?? 0, m.updated_at ?? 0)
        for (const j of judges) d.store.importJudgeState(j.key, j.fingerprint, j.judged_at ?? 0)
        // 核对:facts.db 的每一行在表里都一模一样(表里比它新的那几行是新二进制后来改的,不算差异)
        for (const r of rows) {
          const got = d.store.contactFacts.factById(r.id)
          if (!got) throw new Mismatch(`fact ${r.id} missing after import`)
          if ((got.updated_at ?? 0) === (r.updated_at ?? 0) && !same(got, r)) throw new Mismatch(`fact ${r.id}: want ${JSON.stringify(r)} got ${JSON.stringify(got)}`)
        }
        d.store.setImportHash(FACTS_IMPORT_MARK, h, nowMs)
      })
    } catch (e) {
      // 核对不过,或者插不进去(比如新二进制已经记了同一句、id 不同):整个回滚,表里照旧,下次开机再试
      const msg = e instanceof Error ? e.message : String(e)
      d.log('FACTS_IMPORT', `NOT imported — ${msg}; knowledge facts stay as they are in the main db, retried next boot`)
      return { outcome: 'mismatch', diff: msg }
    }
    if (prior === null) {
      const day = new Date(nowMs).toISOString().slice(0, 10)
      const copy = join(d.knowledgeRoot, `${FACTS_DB_FILE}.imported-${day}`)
      if (!existsSync(copy)) { try { legacy.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`) } catch (e) { d.log('FACTS_IMPORT', `archive copy failed (facts.db itself is untouched): ${e instanceof Error ? e.message : String(e)}`) } }
    }
    d.log('FACTS_IMPORT', `${prior === null ? 'imported' : 're-synced'} facts.db: +${inserted} ~${updated}`)
    return { outcome: 'imported', first: prior === null, inserted, updated }
  } finally {
    legacy.close()
  }
}
