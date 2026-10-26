/**
 * 主人的事实只有一个源(架构终态 G,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §2.1):
 * 主库 `memory_facts` 一行一句话、`memory_fact_events` 只追加的历史。这里只有形状和纯函数,不碰 I/O;
 * 读写在 src/adapters/store/memory-facts.ts(唯一写这两张表的地方),口在 src/ports/memory-facts.ts。
 *
 * 一行属于哪份文档(`doc`):
 *  - 'memory'  —— memory.md 的条目(`section` 是五栏之一)和认不出的行(`key` 以 `x:` 开头,`section` 为 NULL);
 *  - 'owner'   —— owner.md 的主人原话(`o:<id>`)和认不出的行(`x:`);只在主人对话出现(`scope = 'owner_only'`);
 *  - 'contact' —— 联系人事实(G7 从 facts.db 搬来,`k:<原 id>`)。
 * `key` 的前缀:`m:<hex>` 有编号的记忆条目 · `u:<n>` 没编号的记忆条目 · `o:<id>` 主人原话 · `x:<n>` 认不出的行 ·
 * `c:<id>` 只剩更正的墓碑 · `k:<id>` 联系人事实。`key` 在一个对话里唯一。`ord` 是在那份文档里的先后。
 */

export const MEMORY_SECTIONS = ['关于你', '偏好', '承诺', '身边的人', '近况'] as const
export type MemorySection = (typeof MEMORY_SECTIONS)[number]

export type FactDoc = 'memory' | 'owner' | 'contact'
export type FactStatus = 'active' | 'retracted' | 'outdated' | 'superseded' | 'resolved'
export type FactSource = 'owner' | 'nightly' | 'import' | 'extract' | 'review' | 'legacy_correction'
export type FactScope = 'chat' | 'owner_only'
/** owner.md 每条原话是在哪儿写下的(今天尾注里的第三段)。 */
export type OwnerOrigin = 'overview' | 'memory' | 'owner'

export interface MemoryFact {
  id: number
  chatId: string
  key: string
  doc: FactDoc
  /** 'owner' 或联系人 username。 */
  subject: string
  section: string | null
  ord: number
  kind: string | null
  predicate: string | null
  relatedContact: string | null
  timeRef: string | null
  confidence: string | null
  text: string
  status: FactStatus
  source: FactSource
  origin: OwnerOrigin | null
  scope: FactScope
  /** JSON:消息 key / 观察 id。 */
  evidence: string | null
  /** 最后确认日期(memory.md 尾注的日期 / owner.md 的日期),`YYYY-MM-DD`。 */
  seenAt: string | null
  validFrom: number | null
  invalidatedAt: number | null
  supersededBy: number | null
  /** 主人改写:新原话指向被收回的那一行(多半是 `c:` 墓碑)的 id。 */
  replaces: number | null
  createdAt: number
  updatedAt: number
}

/** 读出来给渲染用的一行:`replaces` 换成被替换那一行的 `key`(店面里自连接算好),渲染不用再查。 */
export interface MemoryFactView extends MemoryFact { replacesKey: string | null }

/** 插一行要给的:id / 时间由店面定;`replacesKey` 指向同一对话里已有的一行(先插被替换的那一行)。 */
export type NewMemoryFact =
  & Pick<MemoryFact, 'chatId' | 'key' | 'doc' | 'subject' | 'text' | 'status' | 'source'>
  & Partial<Pick<MemoryFact, 'section' | 'ord' | 'kind' | 'predicate' | 'relatedContact' | 'timeRef' | 'confidence' | 'origin' | 'scope' | 'evidence' | 'seenAt' | 'validFrom' | 'invalidatedAt' | 'supersededBy'>>
  & { replacesKey?: string | null }

/** 「表应该是这个样子」的一行(导入 / 写者落库时给 `mirror`):外加新墓碑的说法与说明(写进事件)。 */
export type DesiredFact = NewMemoryFact & { verdict?: string | null; notes?: readonly string[] }

export type FactEventAction = 'added' | 'updated' | 'retracted' | 'restored' | 'superseded' | 'resolved' | 'redacted_on_output'
export type FactEventActor = 'owner' | 'nightly' | 'cc' | 'judge' | 'import'

export interface MemoryFactEvent {
  /** 全库单调递增;一个对话的修订号 = 它最大的 seq。 */
  seq: number
  factId: number
  chatId: string
  ts: number
  action: FactEventAction
  actor: FactEventActor
  verdict: string | null
  prevText: string | null
  /** 清源头 / 关待办的回执(今天写在 corrections.md 那条底下)。 */
  note: string | null
}

/** 生成物缓存(总览 / 画像):`inputRev` < 当前修订号 ⇒ 过期。 */
export interface MemoryDerived { chatId: string; kind: string; body: string; inputRev: number; generatedAt: number }

// ---- 今天的文档 → 行(纯函数;G3 导入与金样测试共用)。只认结构上的形状,不依赖 features 里的解析器。----

interface DocEntry { id: string | null; text: string; seen: string | null }
interface MemoryDocShape { sections: Record<string, DocEntry[]>; extra: string[] }
interface OwnerDocShape { assertions: Array<{ id: string; text: string; date: string; origin: OwnerOrigin; replaces?: string }>; extra: string[] }

/** memory.md(已解析)→ 行:有编号的 `m:`、没编号的 `u:<n>`、认不出的 `x:<n>`;顺序进 `ord`。 */
export function factsFromMemoryDoc(chatId: string, doc: MemoryDocShape, source: FactSource): NewMemoryFact[] {
  const out: NewMemoryFact[] = []
  let ord = 0, unnumbered = 0
  for (const section of MEMORY_SECTIONS) {
    for (const e of doc.sections[section] ?? []) {
      const key = e.id ? `m:${e.id}` : `u:${++unnumbered}`
      out.push({ chatId, key, doc: 'memory', subject: 'owner', section, ord: ord++, text: e.text, status: 'active', source, seenAt: e.seen })
    }
  }
  doc.extra.forEach((line, i) => out.push({ chatId, key: `x:memory:${i + 1}`, doc: 'memory', subject: 'owner', section: null, ord: ord++, text: line, status: 'active', source }))
  return out
}

/**
 * owner.md(已解析)→ 行。`替换:<更正 id>` 指向 `c:<id>` 那一行:调用方要先插墓碑(G3 先导 corrections.md);
 * 这里只给 `replacesKey`。
 */
export function factsFromOwnerDoc(chatId: string, doc: OwnerDocShape): NewMemoryFact[] {
  const out: NewMemoryFact[] = []
  let ord = 0
  for (const a of doc.assertions) {
    out.push({ chatId, key: `o:${a.id}`, doc: 'owner', subject: 'owner', section: null, ord: ord++, text: a.text, status: 'active', source: 'owner', origin: a.origin, scope: 'owner_only', seenAt: a.date, replacesKey: a.replaces ? `c:${a.replaces}` : null })
  }
  doc.extra.forEach((line, i) => out.push({ chatId, key: `x:owner:${i + 1}`, doc: 'owner', subject: 'owner', section: null, ord: ord++, text: line, status: 'active', source: 'owner', scope: 'owner_only' }))
  return out
}
