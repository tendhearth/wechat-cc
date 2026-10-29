/**
 * 开机一次:knowledge/facts.db → 主库(架构终态 G7,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md
 * §3「数据怎么搬」第 2 条)。联系人事实变成 memory_facts 里 doc = 'contact' 的行(key = `k:<原 id>`,状态、时间一一对应),
 * 抽取水位与判官指纹进 knowledge_* 两张表。
 *
 * 数据安全(评审 G7 两条):
 *  - **一行一个事务**,不是整库一个:facts.db 的列全都可以为空、状态是自由字符串(MCP 以前什么都收),一行进不去不能让整库每次开机都卡住。
 *    进表之前先保守地规整:认不得的状态 ⇒ active,事件里记下原来的值;联系人 / 谓语 / 内容为空 ⇒ 跳过、记日志;数字取整;
 *    `source_msg_keys` 不是合法 JSON ⇒ 空列表、事件里记一笔;时间为空 ⇒ 用另一个时间(都没有 ⇒ 0)。
 *  - **id 不撞**:一开始就把联系人事实新 id 的下限抬到 facts.db 里最大的 id(导入前抽取先跑了也不会用到旧 id);
 *    认「同一件事」看 (联系人, 谓语, 内容),原 id 被别的事实占了就换新 id、记下来(店面的 importContactFact)。
 *  - **核对**:facts.db 的每一行(没跳过的)在表里都要有同一句,而且表里那一行不比它旧、时间一样时每个字段都一样;
 *    不满足的那几行写日志、这一次不记「导过了」(下次开机再导;已经进表的不会重复进)。
 *
 * facts.db **只读、不删、不改名**(主人 10-26 第 5 条):第一次导完用 `VACUUM INTO` 复制一份 `facts.db.imported-<日期>`,放进
 * `archiveDir`(`<stateDir>/memory-archive/knowledge/`;1.7.8 之前放在 knowledge/ 里,开机挪过去,见 lib/imported-copies)。
 * 指纹(所有行的摘要)变了 ⇒ 回滚过的老二进制写过它 ⇒ 再导一次。`'facts.db'` 只许出现在这里(scripts/facts-db.guard.test.ts)。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensureArchiveDir, importedCopyName, moveImportedCopies } from '../../lib/imported-copies'
import { openSqlite, type SqlDatabase } from '../../lib/runtime/sqlite'
import type { FactRow } from '../../ports/knowledge'
import type { MemoryFactsStore } from '../../ports/memory-facts'

export const FACTS_DB_FILE = 'facts.db'
/** memory_import 里记 facts.db 导入的那一行(不是哪个对话)。 */
export const FACTS_IMPORT_MARK = '__facts.db__'
const KNOWN_STATUS = new Set(['active', 'resolved', 'rejected', 'superseded'])

export type FactsImportOutcome =
  | { outcome: 'none' | 'unchanged' }
  | { outcome: 'imported'; first: boolean; inserted: number; updated: number; reassigned: number; skipped: number }
  | { outcome: 'mismatch'; diff: string; inserted: number; updated: number; reassigned: number; skipped: number }

const cols = (db: SqlDatabase, table: string): Set<string> => {
  try { return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(c => c.name)) } catch { return new Set() }
}
const int = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** 旧库原样的行(老形状缺的列当 NULL)。 */
function rawRows(db: SqlDatabase): Array<Record<string, unknown>> {
  const c = cols(db, 'facts')
  if (!c.size) return []
  const pick = (n: string) => (c.has(n) ? n : `NULL AS ${n}`)
  return db.query<Record<string, unknown>, []>(`SELECT id, contact, kind, predicate, value, related_contact, time_ref, confidence, source_msg_keys, status,
    created_at, updated_at, ${c.has('valid_from') ? 'valid_from' : 'created_at AS valid_from'}, ${pick('invalidated_at')}, ${pick('superseded_by')}
    FROM facts ORDER BY id`).all()
}

/** 保守地规整一行;进不了表的(没有 id / 联系人 / 谓语 / 内容)⇒ null + 原因。 */
export function coerceLegacyFact(r: Record<string, unknown>): { row: FactRow; notes: string[] } | { skip: string } {
  const id = int(r.id), contact = text(r.contact), predicate = text(r.predicate), value = text(r.value)
  if (id === null || id <= 0) return { skip: `bad id ${JSON.stringify(r.id)}` }
  if (!contact || predicate === null || value === null) return { skip: `fact ${id}: empty contact / predicate / value` }
  const notes: string[] = []
  let status = text(r.status) ?? 'active'
  if (!KNOWN_STATUS.has(status)) { notes.push(`original status ${JSON.stringify(status)} kept as active`); status = 'active' }
  let keys: string[] = []
  if (r.source_msg_keys !== null && r.source_msg_keys !== undefined && r.source_msg_keys !== '') {
    try {
      const parsed = JSON.parse(String(r.source_msg_keys))
      if (Array.isArray(parsed)) keys = parsed.map(String)
      else notes.push('source_msg_keys was not a list; dropped')
    } catch { notes.push('source_msg_keys was not valid JSON; dropped') }
  }
  const created = int(r.created_at), updated = int(r.updated_at)
  return {
    row: {
      id, contact, predicate, value, kind: text(r.kind), related_contact: text(r.related_contact), time_ref: text(r.time_ref),
      confidence: text(r.confidence) ?? 'med', source_msg_keys: keys, status,
      created_at: created ?? updated ?? 0, updated_at: updated ?? created ?? 0,
      valid_from: int(r.valid_from), invalidated_at: int(r.invalidated_at), superseded_by: int(r.superseded_by),
    },
    notes,
  }
}

/** 核对比的字段(created_at 不比:同一件事主库可能记得更早)。 */
const FIELDS = ['contact', 'kind', 'predicate', 'value', 'related_contact', 'time_ref', 'confidence', 'source_msg_keys', 'status', 'updated_at', 'valid_from', 'invalidated_at', 'superseded_by'] as const
const canon = (r: FactRow) => JSON.stringify(FIELDS.map(k => (r as unknown as Record<string, unknown>)[k] ?? null))

export function importFactsDb(d: { store: MemoryFactsStore; knowledgeRoot: string; archiveDir: string; now: () => number; log: (tag: string, line: string) => void }): FactsImportOutcome {
  try { moveImportedCopies(d.knowledgeRoot, d.archiveDir, [FACTS_DB_FILE], line => d.log('FACTS_IMPORT', line)) } catch (e) { d.log('FACTS_IMPORT', `moving old *.imported-* copies failed: ${e instanceof Error ? e.message : String(e)}`) }
  const file = join(d.knowledgeRoot, FACTS_DB_FILE)
  if (!existsSync(file)) return { outcome: 'none' }
  const legacy = openSqlite(file, { readonly: true })
  try {
    const raw = rawRows(legacy)
    // 先把新 id 的下限抬起来:导入哪怕这次没成,知识库后面新记的事实也不会用到旧库的 id
    const maxLegacy = raw.reduce((m, r) => Math.max(m, int(r.id) ?? 0), 0)
    d.store.raiseContactIdFloor(maxLegacy)
    const marks = cols(legacy, 'extraction_state').size ? legacy.query<Record<string, unknown>, []>('SELECT contact, last_ts, last_local_id, updated_at FROM extraction_state ORDER BY contact').all() : []
    const judges = cols(legacy, 'judge_state').size ? legacy.query<Record<string, unknown>, []>('SELECT key, fingerprint, judged_at FROM judge_state ORDER BY key').all() : []
    const h = createHash('sha256').update(JSON.stringify([raw, marks, judges])).digest('hex')
    const prior = d.store.importHash(FACTS_IMPORT_MARK)
    if (prior === h) return { outcome: 'unchanged' }

    const nowMs = d.now()
    let inserted = 0, updated = 0, reassigned = 0, skipped = 0
    const problems: string[] = []
    const imported: FactRow[] = []
    for (const r of raw) {
      const c = coerceLegacyFact(r)
      if ('skip' in c) { skipped++; d.log('FACTS_IMPORT', `skipped ${c.skip}`); continue }
      try {
        const o = d.store.importContactFact(c.row, nowMs, c.notes)   // 一行一个事务
        if (o.outcome === 'inserted') inserted++
        else if (o.outcome === 'updated') updated++
        else if (o.outcome === 'reassigned') { reassigned++; d.log('FACTS_IMPORT', `fact ${c.row.id} collided with another fact; imported as ${o.id}`) }
        imported.push(c.row)
      } catch (e) {
        problems.push(`fact ${c.row.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    for (const m of marks) {
      const contact = text(m.contact)
      if (contact) d.store.importFactWatermark(contact, int(m.last_ts) ?? 0, int(m.last_local_id) ?? 0, int(m.updated_at) ?? 0)
    }
    for (const j of judges) {
      const key = text(j.key)
      if (key) d.store.importJudgeState(key, text(j.fingerprint), int(j.judged_at) ?? 0)
    }
    // 核对:每一行在表里都有同一句(按 联系人 / 谓语 / 内容 找,不按 id),表里那一行不比它旧;时间一样时字段全同
    for (const r of imported) {
      const got = d.store.contactFactByText(r.contact, r.predicate, r.value)
      if (!got) { problems.push(`fact ${r.id} not in the table after import`); continue }
      if ((got.updated_at ?? 0) < (r.updated_at ?? 0)) { problems.push(`fact ${r.id}: table row ${got.id} is older than facts.db`); continue }
      if ((got.updated_at ?? 0) === (r.updated_at ?? 0) && canon(got) !== canon(r)) problems.push(`fact ${r.id}: table row ${got.id} differs (${canon(got)} vs ${canon(r)})`)
    }
    if (problems.length) {
      d.log('FACTS_IMPORT', `imported what could be imported, but ${problems.length} row(s) did not check out — retried next boot: ${problems.slice(0, 3).join(' | ')}`)
      return { outcome: 'mismatch', diff: problems[0]!, inserted, updated, reassigned, skipped }
    }
    d.store.setImportHash(FACTS_IMPORT_MARK, h, nowMs)
    if (prior === null) {
      const day = new Date(nowMs).toISOString().slice(0, 10)
      let copy: string | null = null
      try { copy = join(ensureArchiveDir(d.archiveDir), importedCopyName(FACTS_DB_FILE, day)) } catch (e) { d.log('FACTS_IMPORT', `archive dir unavailable (facts.db itself is untouched): ${e instanceof Error ? e.message : String(e)}`) }
      if (copy && !existsSync(copy)) { try { legacy.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`) } catch (e) { d.log('FACTS_IMPORT', `archive copy failed (facts.db itself is untouched): ${e instanceof Error ? e.message : String(e)}`) } }
    }
    d.log('FACTS_IMPORT', `${prior === null ? 'imported' : 're-synced'} facts.db: +${inserted} ~${updated} reassigned ${reassigned} skipped ${skipped}`)
    return { outcome: 'imported', first: prior === null, inserted, updated, reassigned, skipped }
  } finally {
    legacy.close()
  }
}
