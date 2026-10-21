/**
 * 微信命令注册表(重构第二批步 2,spec 2026-10-20-refactor-batch2-design §1)。
 *
 * 以前 77 条命令散在 9 套分发里,顺序靠人记。这里是一张表:每条命令一个 id、一个只读的 probe、一个 handle;
 * 入站流水线只有一站 `command`(mw-command.ts)查这张表。表的顺序就是优先级;冲突由基线快照与冲突测试抓
 * (command-baseline.test.ts、__e2e__/command-routing.e2e.test.ts)。
 * 步 2 先收文本命令链(定时 / 日历 / 做过的事 / 经验 / 导入记忆 / 终端会话)与 command-router(串门 / 回信 / 配对 / 派 / 认识 / 访客);
 * admin / mode / onboarding / 权限回复在步 3 搬进来。
 */
import type { InboundMsg } from '../../core/prompt-format'

export interface WechatCommand {
  /** 唯一:trace 里记它,冲突测试按它报。 */
  id: string
  /** 只读,不许有副作用;抛错当作不认领。 */
  probe(msg: InboundMsg): boolean
  /** 真处理了 ⇒ true;认领了但这次不处理(比如状态变了)⇒ false,交给下一条认领的。 */
  handle(msg: InboundMsg): Promise<boolean>
}

export interface CommandRegistry {
  readonly ids: readonly string[]
  probe(msg: InboundMsg): boolean
  /** 返回处理了它的命令 id;没有 ⇒ null。 */
  handle(msg: InboundMsg): Promise<string | null>
}

export function makeCommandRegistry(commands: readonly WechatCommand[]): CommandRegistry {
  const seen = new Set<string>()
  for (const c of commands) { if (seen.has(c.id)) throw new Error(`duplicate command id: ${c.id}`); seen.add(c.id) }
  const claims = (c: WechatCommand, msg: InboundMsg) => { try { return c.probe(msg) } catch { return false } }
  return {
    ids: commands.map(c => c.id),
    probe: (msg) => commands.some(c => claims(c, msg)),
    async handle(msg) {
      for (const c of commands) if (claims(c, msg) && await c.handle(msg)) return c.id
      return null
    },
  }
}

/** 老的 (text, chatId) 形状的处理器(scheduled-jobs/command.ts 的 ReplyHandler)接进来。 */
export function fromReplyHandler(id: string, h: { probe(text: string, chatId: string): boolean; handle(text: string, chatId: string): Promise<boolean> }): WechatCommand {
  return { id, probe: (m) => h.probe(m.text ?? '', m.chatId), handle: (m) => h.handle(m.text ?? '', m.chatId) }
}
