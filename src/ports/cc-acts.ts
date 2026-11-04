/**
 * CC 自己做的事(M5,设计稿 docs/superpowers/specs/2026-11-04-m5-cc-acts-design.md):每个发起方一件长期的
 * kind='act'、initiator='cc' 的事,每做一次 = 一轮,过程 = 这一轮的步。实现只经 MatterLog 写,写不上自己吞掉。
 */
export type CcActWho = 'letters' | 'brief' | 'memory' | 'hunt' | 'atelier' | 'stickers'
export type CcActStepKind = 'agent_message' | 'artifact' | 'delivery' | 'system' | 'error'
export interface CcActTurn {
  /** 这一轮的 id(写不上时是 null):要过几小时再补一步的(记忆整理的通知)记下它,用 toTurn 补。 */
  readonly id: string | null
  /**
   * 这一轮的一步(写不上 ⇒ 什么都不做)。给 key ⇒ 这一轮里同一把 key 的再写一次就地改(别的轮用同一把 key 互不相干)。
   * 回 true = 真写进去了(M5d:靠这一步推「上次」的,写不上要退回写旧标记)。
   */
  step(kind: CcActStepKind, payload: Record<string, unknown>, opts?: { status?: 'started' | 'completed' | 'failed'; key?: string }): boolean
  /** 收这一轮(只收一次;之后的 step 照样能写,挂在已收的轮上)。回 true = 这一次真收上了(再收 / 写不上 ⇒ false)。 */
  finish(status: 'completed' | 'failed', opts?: { endedAt?: number; errorCode?: string }): boolean
}
/** 读回来的一轮(M5d:「上次什么时候做的」从轮推,不再各记一份标记)。 */
export interface CcActRun {
  readonly id: string
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted'
  readonly errorCode: string | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly policy: Record<string, unknown> | null
  readonly steps: ReadonlyArray<{ kind: CcActStepKind; status: 'started' | 'completed' | 'failed'; payload: Record<string, unknown>; at: number }>
}
export interface CcActs {
  /** 开一轮;写不上 ⇒ 给一个什么都不做的把手(原来的事照做)。 */
  begin(who: CcActWho, opts?: { startedAt?: number; policy?: Record<string, unknown> }): CcActTurn
  /** 往这个发起方的某一轮上补一步(那一轮可能早收了:记忆整理的通知几小时后才送)。那一轮不在 ⇒ 什么都不做。 */
  toTurn(who: CcActWho, turnId: string, kind: CcActStepKind, payload: Record<string, unknown>, opts?: { status?: 'started' | 'completed' | 'failed' }): void
  /**
   * 这个发起方做过的轮,新的在前(带步);给 status 只要那一种结局的;steps:false ⇒ 不读步(steps 为空)。读不出来(库坏了 / 没建过)⇒ []:调用方一律还要看旧标记(M5d 起只读不写),
   * 两边取较新的 —— 真机上第一次跑之前一轮都没有,不能当「从没做过」。
   */
  runs(who: CcActWho, opts?: { limit?: number; status?: CcActRun['status']; steps?: boolean }): CcActRun[]
  /** 这个发起方所有轮里某一种步,新的在前,不限轮数(信的抽屉要找到每一封的寄出那一步)。读不出 ⇒ []。 */
  stepsOf(who: CcActWho, kind: CcActStepKind): Array<CcActRun['steps'][number] & { turnId: string }>
  /** 这个发起方那件事的 id(没建过也给,同一个名字永远同一个 id)。 */
  matterIdOf(who: CcActWho): string
  /** 开机:上一次进程里没收的 act 轮记中断。 */
  interruptAll(): void
}
export const CC_ACT_TITLES: Record<CcActWho, string> = { letters: '信', brief: '早报', memory: '记忆整理', hunt: '打猎', atelier: '画室', stickers: '贴纸' }
