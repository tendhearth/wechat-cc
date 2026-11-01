/**
 * 一件事的状态 ⇒ 怎么说、画什么、上不上强调色、归哪一组(设计稿 2026-10-31 §4 U)。
 * 三端(App / 桌面 / 手机网页)只认这一张;页面里不再手写「waiting ⇒ shield」这类映射。
 * 状态词按 docs/reference/phone-wording.md:在做 / 等你决定 / 这一轮做完了 / 完成 / 没做成 / 停下了。
 * 纯数据,不 import 任何东西。
 */
export const STATUS_KEYS = ['working', 'waiting', 'replied', 'done', 'failed', 'stopped'] as const
export type StatusKey = (typeof STATUS_KEYS)[number]

/** 主页的三组:等你 → 在做 → 带回来的。 */
export type HomeGroupKey = 'waiting' | 'working' | 'back'

export type StatusIcon = 'shield' | 'done' | 'alert' | 'message' | 'pause'

export interface StatusSpec {
  /** 词条键。 */
  readonly word: `status.${StatusKey}`
  /** null ⇒ 不画图标(行里留同宽的空位)。 */
  readonly icon: StatusIcon | null
  /** 强调色只给「等你」。 */
  readonly tone: 'accent' | 'inkSoft'
  readonly group: HomeGroupKey
}

export const STATUS_TABLE: Readonly<Record<StatusKey, StatusSpec>> = {
  working: { word: 'status.working', icon: null, tone: 'inkSoft', group: 'working' },
  waiting: { word: 'status.waiting', icon: 'shield', tone: 'accent', group: 'waiting' },
  replied: { word: 'status.replied', icon: 'message', tone: 'inkSoft', group: 'back' },
  done: { word: 'status.done', icon: 'done', tone: 'inkSoft', group: 'back' },
  failed: { word: 'status.failed', icon: 'alert', tone: 'inkSoft', group: 'back' },
  stopped: { word: 'status.stopped', icon: 'pause', tone: 'inkSoft', group: 'back' },
}
