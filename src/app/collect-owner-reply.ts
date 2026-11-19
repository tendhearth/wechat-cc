import { buildTurnReply, replyNotForOwner, type ReplyContext, type ReplyTextStrategy, type TurnTextParts } from '../domain/turn-reply'
import type { TurnSummary } from '../ports/agent-provider'

export const OWNER_REPLY_REMINDER = '上一条不是给主人的话。请直接用平常话回答主人刚才那句。'

export type OwnerReplySummary = TurnSummary & {
  replyRetried: boolean
  replySuppressed: boolean
}

/** The caller holds the same session (and its lock) across both attempts. */
export async function collectOwnerReply(
  collect: (text: string, retry: boolean) => Promise<TurnSummary>,
  prompt: string,
  strategy: ReplyTextStrategy,
  log: (tag: string, detail: string) => void,
  stopped?: () => boolean,
  replyTextForInspection: (segment: string) => string = segment => segment,
  /** 这一轮在哪种场合交付:静默令牌算不算数、哪些段会真发出去,都跟它走。 */
  context: ReplyContext = 'dm',
): Promise<OwnerReplySummary> {
  const inspect = (summary: TurnSummary) => {
    if (summary.error || summary.errorCode) return false
    // 判的是「交付那一步真会发出去的文字」:用同一个 buildTurnReply 走一遍(剥静默令牌、最后一段 NO_REPLY 在允许静默的
    // 场合整轮不发、只有标点的段不发),再看剩下的每一段是不是都是内部回声。自己另写一套规矩就会和交付对不上(独立评审四轮)。
    const { reply } = buildTurnReply({
      finalText: replyTextForInspection(summary.finalText ?? ''),
      narration: (summary.narration ?? []).map(replyTextForInspection),
    }, [], context, strategy)
    if (reply.silent) return false // 模型有意不说(或这个场合整轮静默):不是回声,也不重答
    const texts = (strategy === 'all_segments' ? reply.segments ?? [] : [reply.text]).filter(segment => segment.trim())
    if (!texts.length) return false
    const categories = texts.map(segment => replyNotForOwner(segment))
    if (categories.some(category => !category)) return false
    log('REPLY_NOT_FOR_OWNER', `category=${[...new Set(categories)].join('+')} segments=${texts.length} length=${texts.reduce((n, segment) => n + segment.length, 0)}`)
    return true
  }

  let summary = await collect(prompt, false)
  if (!inspect(summary)) return { ...summary, replyRetried: false, replySuppressed: false }
  if (stopped?.()) return { ...summary, replyRetried: false, replySuppressed: true }

  const first = summary
  summary = await collect(OWNER_REPLY_REMINDER, true)
  const replySuppressed = inspect(summary)
  return {
    ...summary,
    ...(replySuppressed ? { finalText: '', narration: [], assistantText: [], providerFinalText: undefined } : {}),
    toolCalls: [...first.toolCalls, ...summary.toolCalls],
    replyToolCalled: first.replyToolCalled || summary.replyToolCalled,
    replyRetried: true,
    replySuppressed,
  }
}

export function ownerReplyParts(summary: TurnSummary & { replySuppressed?: boolean }): TurnTextParts {
  return {
    finalText: summary.finalText ?? '',
    narration: summary.narration ?? [],
    ...(summary.replySuppressed ? { suppressed: true } : {}),
  }
}
