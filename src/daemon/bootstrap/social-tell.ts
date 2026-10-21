/**
 * 告诉主人一句社交上的事(笔友来信、心愿的答复、介绍、串门见闻)—— 第三批 3a。
 * 先问 CC 开口那道门(kind 决定别烦我 / 免打扰拦不拦,见 core/speech/kinds 的 social_*),放行才经 sendAssistantText 发:
 * 它还管 App 那头的回话截获和旁听,投递不动,只把「能不能说」交给门。门取不到 ⇒ 不发、记一行,不退回直接发。
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
    try {
      const o = await speech.say({ kind, chatId: op }, async () => { await send(op, text) })
      if (!('allow' in o)) d.log('SOCIAL', `${kind} notice ${'defer' in o ? 'deferred' : 'dropped'}: ${o.reason}`)
    } catch (err) {
      d.log('SOCIAL', `${kind} notice failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
