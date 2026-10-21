/**
 * 微信「任务 …」命令(工作台控制,core/workbench/wechat-control)—— 命令表的第一条(重构第二批步 4)。
 *
 * 以前是单独一种 intent(task-command)+ 一站 mw-workbench,排在「命令」之前;现在是命令表的 ids[0],
 * 先后不变。consumedBy 仍是 'workbench'(group)。
 */
import { isWechatTaskCommand, type WechatMessageIdentity, type WechatWorkbenchReply } from '../../core/workbench/wechat-control'
import type { WechatCommand } from './registry'

export interface TaskCommandDeps {
  handleWechat(chatId: string, text: string, identity?: WechatMessageIdentity): Promise<WechatWorkbenchReply | null>
  sendMessage(chatId: string, text: string): Promise<unknown>
}

export function makeTaskCommand(deps: TaskCommandDeps): WechatCommand {
  return {
    id: 'task-command',
    group: 'workbench',
    probe: (m) => isWechatTaskCommand(m.text ?? ''),
    async handle(msg, turn) {
      // App 一轮里的「任务」命令:出生地是桌面 / 手机,不是微信(origin 只由 daemon 在 appTurn 里填)。
      const reply = await deps.handleWechat(msg.chatId, msg.text, turn?.origin !== undefined ? { ...msg, origin: turn.origin } : msg)
      if (reply !== null && typeof reply === 'object') return true
      const sent = await deps.sendMessage(msg.chatId, reply ?? '任务控制仅对已绑定的主人开放。')
      // ilink returns an error result instead of rejecting. Leave this delivery
      // unhandled so redelivery can retrieve the existing task input or control receipt.
      if (sent && typeof sent === 'object' && 'error' in sent && sent.error) throw Error('workbench_reply_failed')
      return true
    },
  }
}
