/**
 * 告诉主人一句社交上的事(笔友来信、心愿的答复、介绍、串门见闻)—— 第三批 3a。
 * 经 CC 开口那道门的 `tell`:kind 决定别烦我 / 免打扰拦不拦(core/speech/kinds 的 social_*);放行就经 sendAssistantText 发
 * (它还管 App 那头的回话截获和旁听,投递不换)。report / blocking 被推后 ⇒ 门自己的「待说」队列接住,之后补说
 * (speech/pending-notices.ts);CC 自己的见闻(initiative)推后就是这一句不说,东西在背包里。
 * 门取不到 ⇒ 不发、记一行,不退回直接发。
 */
import type { SocialNotice } from '../../core/speech/kinds'
import type { SpeechPolicy } from '../speech/policy'

export function makeTellOwner(d: {
  resolveOperatorChatId: () => string | null
  sendAssistantText: ((chatId: string, text: string) => Promise<unknown>) | undefined
  speech?: () => SpeechPolicy | null
  log: (tag: string, line: string) => void
}): (kind: SocialNotice, text: string) => Promise<void> {
  return async (kind, text) => {
    const op = d.resolveOperatorChatId()
    const send = d.sendAssistantText
    if (!op || !send) return
    const speech = d.speech?.()
    if (!speech) { d.log('SOCIAL', `${kind} notice not sent: speech policy not wired yet`); return }
    try { await speech.tell(kind, op, text, send) } catch (err) { d.log('SOCIAL', `${kind} notice failed: ${err instanceof Error ? err.message : String(err)}`) }
  }
}
