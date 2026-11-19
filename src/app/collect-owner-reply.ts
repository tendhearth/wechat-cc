import { replyNotForOwner, type ReplyTextStrategy, type TurnTextParts } from '../domain/turn-reply'
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
): Promise<OwnerReplySummary> {
  const inspect = (summary: TurnSummary) => {
    if (summary.error || summary.errorCode) return false
    const final = summary.finalText ?? ''
    const text = strategy === 'all_segments' ? [...(summary.narration ?? []), final].join('\n\n') : final
    const category = replyNotForOwner(text)
    if (!category) return false
    log('REPLY_NOT_FOR_OWNER', `category=${category} length=${text.length}`)
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
