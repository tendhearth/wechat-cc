import type { AgentEvent } from './agent-provider'
import type { DeliveryReport } from '../domain/turn-reply'
import type { TurnRecord } from '../domain/turn-record'
import type { ProviderId } from '../domain/conversation'

/**
 * 对话的每一轮进这件对话的 MatterLog(M3a,设计稿 docs/superpowers/specs/2026-11-02-m3-chat-turns-design.md)。
 * 协调器的 runner 开 / 收;实现(src/adapters/store/chat-turns.ts)只经 MatterLog 写,写不上自己吞掉 —— 只少一轮记录,不挡回复。
 */
export interface ChatTurnHandle {
  /** 这一轮的每个执行者事件:工具调用写成步;result 的用量 / 原生会话、error 记下,收的时候一起写。 */
  event(ev: AgentEvent): void
  /** 收这一轮:结局、模式、送达;幂等(第二次什么都不做)。 */
  end(r: { mode: TurnRecord['mode']; outcome: TurnRecord['outcome']; errorCode?: string; error?: string; report?: DeliveryReport }): void
}
export interface ChatTurnLog {
  /** 这个 chat 对应的那件对话里开一轮;找不到这件事 ⇒ null(那就不记)。 */
  begin(t: { chatId: string; provider: ProviderId; alias: string; startedAt: number }): ChatTurnHandle | null
  /** 开机:上一次进程里没收的对话轮记中断。 */
  interruptAll(): void
}
