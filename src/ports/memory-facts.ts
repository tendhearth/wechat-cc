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

/** 收回的是哪一句:表里的一行(`m:` / `u:` / `o:` …),或只给一段正文(待办「不对」、证据审阅、总览里没编号的行)。 */
export type RetractRef = { key: string } | { text: string }
export interface RetractOpts {
  verdict: 'wrong' | 'outdated' | 'delete'
  /** 收回的话列表 / corrections.md 里那一条的段名(记忆的栏、「你写的」「总览」「待办」「观察」…)。 */
  section: string
  /** 主人当地日期 YYYY-MM-DD。 */
  day: string
  /** 记忆编辑给的更正编号(主人原话的 `替换:` 指向它);没有 ⇒ 不写编号。 */
  correctionId?: string | null
  /**
   * 被收回的那句话本身(墓碑的正文,收回名单里比对的就是它)。按 key 收回时调用方也要给:那一行可能不在表里
   * (没搬进表的条目、刚被写者拿掉的),只靠 key 墓碑里就成了「m:abc」,名单里没有真正那句话(数据安全评审第 3 条)。
   */
  text?: string
  /** 清源头 / 关待办的回执(`  (…)\n`)。 */
  note?: string
  by: Omit<FactWrite, 'action'>
}
export interface RetractReceipt { key: string; targets: string[] }

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
  /** 给一行追加一条事件(出口过滤命中 `redacted_on_output` …)。没有这一行 ⇒ false。 */
  addEvent(chatId: string, key: string, e: { action: FactEventAction; note?: string | null; verdict?: string | null }, by: Omit<FactWrite, 'action'>): boolean
  /** 墓碑底下追加一段说明(CC 后来又关掉的待办 …):一条事件。没有这一行 ⇒ false。 */
  addNote(chatId: string, key: string, note: string, by: Omit<FactWrite, 'action'>): boolean
  /**
   * 这份文件的导出记录:`sha256` = 最后一次确认写到磁盘上的内容指纹,`pending` = 表已经改了、正要写的那份(写成功就清掉)。
   * 没导出过 ⇒ null。
   */
  exportRecord(chatId: string, file: string): { sha256: string | null; pending: string | null } | null
  /** 写文件之前:记下正要写的那份。 */
  markExportPending(chatId: string, file: string, sha256: string, at: number): void
  /** 写成功之后:这份就是磁盘上的了。 */
  markExportDone(chatId: string, file: string, sha256: string, at: number): void
  /**
   * 一种收回(设计稿 §2.3):一行墓碑(`c:<id>` / `c:~<n>`)+ 被收回的行改成 retracted / outdated,各一条事件,一个事务。
   * `{ key }`:就是那一行(不管它这会儿是不是 active —— 写者可能刚把它从文档里拿掉);`{ text }`:正文规范化后相等(够长)的
   * active / outdated 的条目与原话都收回;一行都没有也照样留墓碑(总览上没编号的行也能收回)。
   */
  retract(chatId: string, ref: RetractRef, opts: RetractOpts): RetractReceipt
  /** 撤销一次收回:墓碑改成 superseded,当时被它收回的行回到 active。之前随之删掉的笔记行不会回来。没有这条 ⇒ null。 */
  restore(chatId: string, tombstoneKey: string, by: Omit<FactWrite, 'action'>): { restored: string[] } | null
  /** 义务办完了(不是收回:不清源头、不过滤出口)。 */
  resolve(chatId: string, key: string, by: Omit<FactWrite, 'action'>): boolean
  /** 被另一行取代(合并重复的义务等)。 */
  supersede(chatId: string, key: string, byKey: string, by: Omit<FactWrite, 'action'>): boolean
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
