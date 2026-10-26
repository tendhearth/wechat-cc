/**
 * 主人事实表的口(架构终态 G2,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §2.1)。
 * 实现在 src/adapters/store/memory-facts.ts —— 唯一写 memory_facts / memory_fact_events / memory_derived 的地方。
 * 只有类型,没有逻辑。G2 只有插入与读;收回 / 恢复 / 办完 / 取代(retract / restore / resolve / supersede)G5 加在这里。
 */
import type { FactEventAction, FactEventActor, FactDoc, FactStatus, MemoryDerived, MemoryFactEvent, MemoryFactView, NewMemoryFact } from '../domain/memory/facts'

export interface ListMemoryFacts { doc?: FactDoc; statuses?: FactStatus[] }
export interface FactWrite { actor: FactEventActor; ts: number; action?: Extract<FactEventAction, 'added'>; note?: string | null }

export interface MemoryFactsStore {
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
