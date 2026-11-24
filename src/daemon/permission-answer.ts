/**
 * 主人对一张待批拍板卡的回答(微信「y / n」、带码、引用卡片回)—— 消费它的只有这一处。
 *
 * 两个调用方:命令表里的 `permission-reply`(wiring/pipeline-deps.ts,走完整入站流水线的那条),和 poll loop 的快车道
 * (wiring/lifecycle-deps.ts → poll-loop.ts 的 fastLane:一轮在等拍板时,回答一到就当场放开它)。两边同一个判定、
 * 同一行留痕。没消费(不是回答、或者那条待批已经被桌面拍过 / 到点过期了)⇒ false,调用方照普通消息处理。
 */
import type { WechatPermissions } from '../ports/wechat'
import { classifyWorkbenchQuote, summarizedWorkbenchQuote } from './pending-permissions'

export interface PermissionAnswerMsg { text?: string; chatId: string; quote?: { type?: string; text?: string } }

export function makePermissionAnswer(deps: {
  ilink: Pick<WechatPermissions, 'handlePermissionReply'>
  log: (tag: string, line: string) => void
}): (m: PermissionAnswerMsg) => boolean {
  return (m) => {
    const quoted = m.quote?.text
    const card = quoted === undefined ? null : classifyWorkbenchQuote(quoted)
    let consumed: boolean
    try {
      consumed = deps.ilink.handlePermissionReply(m.text ?? '', m.chatId, quoted)
    } finally {
      // The poll fast lane runs before ordinary routing, prompts and history.
      if (card) m.quote = { type: 'text', text: summarizedWorkbenchQuote(card.marker) }
    }
    if (!consumed) return false
    deps.log('PERMISSION', `consumed reply from chat=${m.chatId}`)
    return true
  }
}
