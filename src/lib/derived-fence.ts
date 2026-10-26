/**
 * 生成物(总览 / 画像)的过期围栏 —— 只有类型(架构终态 G8,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §2.2 / §3)。
 * 以前是每个对话目录里的一份 JSON(lib/memory-derived-state);现在在主库(memory_source_revisions + memory_derived),
 * 实现在 src/adapters/store/memory-facts.ts 的 `fence(chatId)`。lib 里的合成、记忆文件读写拿到的是这个口,不认表。
 *
 * 为什么过期:
 * - added:源里多了东西(整理、CC 写笔记、园丁压缩、导入)—— 旧生成物只是不全,贴一句标签照常用;
 * - retracted:主人删了 / 改了东西(纠正、过期、桌面编辑)—— 旧生成物里可能正好有要忘掉的那句,总览会进串门人设,所以藏起来,
 *   重新生成以后再给。一个生成物只要在这段过期里碰到过一次 retracted 就一直是 retracted,直到它重新生成。
 */
export type InvalidationReason = 'added' | 'retracted'
export type DerivedStatus = 'fresh' | 'added' | 'retracted'
export type DerivedKind = 'overview' | 'profile'

export interface DerivedFence {
  /** 改源之前调(中途崩了也往保守那边走)。缺省 retracted。 */
  invalidate(reason?: InvalidationReason): void
  status(kind: DerivedKind): DerivedStatus
  isStale(kind: DerivedKind): boolean
  /** 这个对话的源修订号;开始生成前取一次,提交时对比。 */
  revision(): number
  /** 修订号没变才提交:先调 `write`(导出文件),再记缓存(正文 + 修订号)。中途源又变了 ⇒ false。 */
  commit(kind: DerivedKind, expectedRevision: number, body: string, write: () => void): boolean
  /** 缓存的生成物正文(总览 = 导出的那份全文;画像 = JSON);没生成过 ⇒ null。 */
  body(kind: DerivedKind): string | null
  /** 缓存是什么时候生成的(毫秒);没有 ⇒ null。 */
  generatedAt(kind: DerivedKind): number | null
}
