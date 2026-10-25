/**
 * 协调器各块共用的那一份:依赖、时钟、系统通知、交付模式、当前模式、换 provider 的交接账。
 * 只读地传给 plan / runner / 三种派法;每一块自己的状态(锁、取消登记、连击)留在自己那块里。
 */
import type { Mode, ProviderId } from '../conversation'
import { replyDeliveryFor, replyTextStrategyFor } from '../capability-matrix'
import type { DeliveryKind, ReplyDeliveryMode, ReplyTextStrategy } from '../turn-reply'
import { makeHandoffLedger } from '../provider-handoff'
import type { ConversationCoordinatorDeps } from './types'

/** 一轮落在哪个项目上(resolveProject 的结果)。 */
export interface ProjectRef { alias: string; path: string }

export interface CoordinatorCtx {
  deps: ConversationCoordinatorDeps
  nowMs: () => number
  /** 系统通知走 sendNotice(没接就退回 sendAssistantText)—— 与 agent 的话分家(spec §4.3)。 */
  notice(chatId: string, text: string): Promise<unknown> | undefined
  /** 这一轮这家 provider 的交付模式。没有端口 ⇒ 只能 legacy。 */
  deliveryModeFor(providerId: ProviderId): ReplyDeliveryMode
  textStrategyFor(providerId: ProviderId): ReplyTextStrategy
  /** daemon 模式下「应答轮交付为空」的连击(见 deps.onEmptyReplyStreak)。 */
  noteDelivery(providerId: ProviderId, delivery: DeliveryKind): void
  /** 持久化的模式,没有就是 daemon 默认(solo + 默认 provider)。 */
  getMode(chatId: string): Mode
  /** 换 provider 不断片 — setMode 标记,下一次 solo dispatch 取用(取即清)。 */
  handoffLedger: ReturnType<typeof makeHandoffLedger>
}

export function createCoordinatorCtx(deps: ConversationCoordinatorDeps): CoordinatorCtx {
  // 每家 provider 连续「应答轮交付为空」的轮数(daemon 模式,见 deps.onEmptyReplyStreak)。
  const emptyReplyStreak = new Map<ProviderId, number>()
  return {
    deps,
    nowMs: deps.now ?? Date.now,
    notice: (chatId, text) => (deps.sendNotice ?? deps.sendAssistantText)?.(chatId, text),
    deliveryModeFor: (providerId) =>
      deps.replyDelivery ? (deps.replyDeliveryModeFor ?? replyDeliveryFor)(providerId) : 'legacy',
    textStrategyFor: (providerId) => (deps.replyTextStrategyFor ?? replyTextStrategyFor)(providerId),
    noteDelivery(providerId, delivery) {
      const empty = delivery === 'empty' || delivery === 'silent'
      const prev = emptyReplyStreak.get(providerId) ?? 0
      if (!empty) {
        if (prev > 0) { emptyReplyStreak.set(providerId, 0); deps.onEmptyReplyStreak?.(providerId, 0) }
        return
      }
      emptyReplyStreak.set(providerId, prev + 1)
      deps.onEmptyReplyStreak?.(providerId, prev + 1)
    },
    getMode: (chatId) => deps.conversationStore.get(chatId)?.mode ?? { kind: 'solo', provider: deps.defaultProviderId },
    handoffLedger: makeHandoffLedger(),
  }
}
