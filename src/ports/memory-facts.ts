/**
 * 主人事实表的口(架构终态 G2,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §2.1)。
 * 实现在 src/adapters/store/memory-facts.ts —— 唯一写 memory_facts / memory_fact_events / memory_derived 的地方。
 * 只有类型,没有逻辑。G2 只有插入与读;收回 / 恢复 / 办完 / 取代(retract / restore / resolve / supersede)G5 加在这里。
 */
import type { DesiredFact, FactEventAction, FactEventActor, FactDoc, FactStatus, MemoryDerived, MemoryFactEvent, MemoryFactView, NewMemoryFact } from '../domain/memory/facts'
import type { RenderableTombstone } from '../domain/memory/corrections'

export interface ListMemoryFacts { doc?: FactDoc; statuses?: FactStatus[] }
export interface FactWrite { actor: FactEventActor; ts: number; action?: Extract<FactEventAction, 'added'>; note?: string | null }

export interface MirrorOpts {
  by: Omit<FactWrite, 'action'>
  /** 表里有、`desired` 里没有的哪些 key 算「从文件里没了」(⇒ `outdated` + 一条事件)。墓碑(`c:`)永远不算。 */
  goneIf: (key: string) => boolean
}
export interface MirrorResult { added: number; updated: number; statusChanged: number; gone: number }

export interface MemoryFactsStore {
  /** 在一个事务里跑 `fn`(SQLite 的 immediate 事务;`fn` 抛错 ⇒ 全部回滚)。 */
  atomically<T>(fn: () => T): T
  /**
   * 让表里这个对话的行变成 `desired` 的样子(导入、写者落库共用):没有的插(新墓碑记 `retracted`,别的记 `added`)、
   * 字段变了的改(`updated`,带旧正文)、状态变了的改(回到 active 记 `restored`,收回记 `retracted`)、墓碑多出来的说明追加一条事件;
   * `goneIf` 认的、不在 `desired` 里的 active 行 ⇒ `outdated`。顺序(`ord`)跟着变,不记事件。不删任何一行。
   */
  mirror(chatId: string, desired: readonly DesiredFact[], opts: MirrorOpts): MirrorResult
  /** 一个对话的墓碑(`c:` 行),带说法与说明 —— 渲染 corrections.md / 收回的话列表用。 */
  tombstones(chatId: string): Array<RenderableTombstone & { id: number; status: FactStatus }>
  /** 上次「文件 → 表」核对通过时文件的总指纹;没导入过 ⇒ null。 */
  importHash(chatId: string): string | null
  setImportHash(chatId: string, filesHash: string, at: number): void
  /** 墓碑底下追加一段说明(CC 后来又关掉的待办 …):一条事件。没有这一行 ⇒ false。 */
  addNote(chatId: string, key: string, note: string, by: Omit<FactWrite, 'action'>): boolean
  /** 我们最后一次导出这份文件时的内容指纹;没导出过 ⇒ null。 */
  exportHash(chatId: string, file: string): string | null
  setExportHash(chatId: string, file: string, sha256: string, at: number): void
  /** 一个事务里插这些行,每行记一条 `added` 事件;任何一行失败 ⇒ 全部不插。`replacesKey` 要指向同一对话里已有的(或这一批里更早的)一行。 */
  insert(facts: readonly NewMemoryFact[], by: FactWrite): MemoryFactView[]
  /** 一个对话的行,按 doc、ord、id 排;`replacesKey` 已经解析好。 */
  list(chatId: string, filter?: ListMemoryFacts): MemoryFactView[]
  byKey(chatId: string, key: string): MemoryFactView | null
  /** 一个对话的修订号 = 它最大的事件 seq;还没有事件 ⇒ 0。 */
  revision(chatId: string): number
  /** 一个对话 seq 大于 `afterSeq` 的事件,按 seq 升序。 */
  events(chatId: string, afterSeq?: number): MemoryFactEvent[]
  getDerived(chatId: string, kind: string): MemoryDerived | null
  putDerived(d: MemoryDerived): void
}
