/**
 * 访客申请告诉主人(「有人想跟 CC 说话,回『允许 12』」)—— 经 CC 开口那道门(第三批 3a,guest_request 归 blocking:
 * 别烦我 / 免打扰都不拦)。
 *
 * **交给门就算办完**:说出去了,或者两条路都送不到而进了待说队列 —— 都回 {}。mw-access 就标记「已通知」,
 * 访客下一句不会再塞一份进队列(以前它自己在访客下一句时重试;现在重试归待说队列那一层,别两层都重试)。
 * 申请本身一直在登记处等主人拍,码不会过期,所以可以排队补说(不像权限卡那样标 expiring)。
 * 主人只认 admins(resolveAdminChatId),从不用 resolveOperatorChatId —— 见 pipeline-deps 那段注释。
 */
import type { SpeechPolicy } from '../speech/policy'

export function makeGuestOwnerNotify(d: {
  speech: () => Pick<SpeechPolicy, 'tell'> | null
  adminChatId: () => string | null
  log: (tag: string, line: string) => void
}): (text: string) => Promise<{ error?: string }> {
  return async (text) => {
    const owner = d.adminChatId()
    if (!owner) return { error: 'no_admin_chat_configured' }
    const speech = d.speech()
    if (!speech) return { error: 'speech_not_wired' }
    const said = await speech.tell('guest_request', owner, text)
    if (!said) d.log('ACCESS', 'guest request notice handed to the pending queue (two-way undeliverable right now)')
    return {}
  }
}
