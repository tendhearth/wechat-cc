/**
 * CC 自己做的事(M5,设计稿 docs/superpowers/specs/2026-11-04-m5-cc-acts-design.md):每个发起方一件长期的
 * kind='act'、initiator='cc' 的事,每做一次 = 一轮,过程 = 这一轮的步。实现只经 MatterLog 写,写不上自己吞掉。
 */
export type CcActWho = 'letters' | 'brief' | 'memory' | 'hunt' | 'atelier' | 'stickers'
export type CcActStepKind = 'agent_message' | 'artifact' | 'delivery' | 'system' | 'error'
export interface CcActTurn {
  /** 这一轮的一步(写不上 ⇒ 什么都不做)。给 key ⇒ 这一轮里同一把 key 的再写一次就地改(别的轮用同一把 key 互不相干)。 */
  step(kind: CcActStepKind, payload: Record<string, unknown>, opts?: { status?: 'started' | 'completed' | 'failed'; key?: string }): void
  /** 收这一轮(只收一次;之后的 step 照样能写,挂在已收的轮上)。 */
  finish(status: 'completed' | 'failed', opts?: { endedAt?: number; errorCode?: string }): void
}
export interface CcActs {
  /** 开一轮;写不上 ⇒ 给一个什么都不做的把手(原来的事照做)。 */
  begin(who: CcActWho, opts?: { startedAt?: number; policy?: Record<string, unknown> }): CcActTurn
  /** 这个发起方那件事的 id(没建过也给,同一个名字永远同一个 id)。 */
  matterIdOf(who: CcActWho): string
  /** 开机:上一次进程里没收的 act 轮记中断。 */
  interruptAll(): void
}
export const CC_ACT_TITLES: Record<CcActWho, string> = { letters: '信', brief: '早报', memory: '记忆整理', hunt: '打猎', atelier: '画室', stickers: '贴纸' }
