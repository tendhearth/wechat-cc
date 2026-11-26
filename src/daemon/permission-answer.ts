/**
 * 主人对一张待批拍板卡的回答(微信「y / n」、带码、引用卡片回)—— 消费它的只有这一处。
 *
 * 两个调用方:命令表里的 `permission-reply`(wiring/pipeline-deps.ts,走完整入站流水线的那条),和 poll loop 的快车道
 * (wiring/lifecycle-deps.ts → poll-loop.ts 的 fastLane:一轮在等拍板时,回答一到就当场放开它)。两边同一个判定、
 * 同一行留痕。判定没有消费或说明没送达时返回 false，调用方照普通消息处理。
 */
import type { WechatPermissions, WechatReplyRoute } from '../ports/wechat'
import { summarizeApprovalQuote } from './pending-permissions'

export interface PermissionAnswerMsg { text?: string; chatId: string; quote?: { type?: string; text?: string }; accountId?: string; contextToken?: string; msgId?: string }

export function makePermissionAnswer(deps: {
  ilink: Pick<WechatPermissions, 'handlePermissionReply'>
  log: (tag: string, line: string) => void
}): (m: PermissionAnswerMsg) => boolean | Promise<boolean> {
  return (m) => {
    const quoted = m.quote?.text
    const summary = quoted === undefined ? undefined : summarizeApprovalQuote(quoted)
    const route: WechatReplyRoute | undefined = m.accountId === undefined ? undefined : { accountId: m.accountId, contextToken: m.contextToken }
    let consumed: boolean | Promise<boolean>
    try {
      consumed = deps.ilink.handlePermissionReply(m.text ?? '', m.chatId, quoted, route, m.msgId)
    } finally {
      // The poll fast lane runs before ordinary routing, prompts and history.
      if (summary) m.quote = { type: 'text', text: summary }
    }
    const record = (accepted: boolean) => {
      if (accepted) deps.log('PERMISSION', `consumed reply from chat=${m.chatId}`)
      return accepted
    }
    return typeof consumed === 'boolean' ? record(consumed) : consumed.then(record)
  }
}
