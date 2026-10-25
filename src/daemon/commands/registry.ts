/**
 * 微信命令注册表(重构第二批步 2 / 3b,spec 2026-10-20-refactor-batch2-design §1)。
 *
 * 以前 77 条命令散在 9 套分发里,顺序靠人记。这里是一张表:每条命令一个 id、一个只读的 probe、一个 handle;
 * 入站流水线只有一站 `command`(mw-command.ts)查这张表。
 *
 * **表的顺序就是优先级**,读 `ids` 就是真实顺序,不用回头看:
 *  - 唯一的整理规则 —— 某条命令声明 `ownsSlash`(这几个 /词 归我),建表时给它生成一条 `<id>:slash`,
 *    放在 `slashCatchAll` 那条(mode:认任何 /词,兜底「不认识 /xx」)之前。具体的 /词 先于兜底;
 *    这条命令的非斜杠写法(「终端」「串门」)留在原位。
 * 冲突由基线快照与冲突测试抓(command-baseline.test.ts、__e2e__/command-routing.e2e.test.ts)。
 */
import type { InboundMsg } from '../../domain/prompt-format'
import type { MatterOrigin } from '../../adapters/store/matters-store'

/**
 * 这一轮的上下文(只有少数命令要看)。origin:App 一轮(桌面 / 手机)里建出来的事记在哪个表面;
 * 省略 ⇒ 真的是微信入站;null ⇒ App 一轮但分不清表面。与 InboundCtx.origin 同义。
 */
export interface CommandTurn {
  origin?: MatterOrigin | null
}

export interface WechatCommand {
  /** 唯一:trace 里记它,冲突测试按它报。 */
  id: string
  /** consumedBy 的标签(trace / welcome / milestone / activity 看它);缺省 'command'。沿用老标签,下游的站不用改。 */
  group?: string
  /** 只读,不许有副作用;抛错当作不认领。 */
  probe(msg: InboundMsg): boolean
  /** 真处理了 ⇒ true;认领了但这次不处理(比如状态变了)⇒ false,交给下一条认领的。 */
  handle(msg: InboundMsg, turn?: CommandTurn): Promise<boolean>
  /** 这条消息是我认的 /词(/cli、/today、/visit…)⇒ 建表时排到 slashCatchAll 之前。 */
  ownsSlash?(msg: InboundMsg): boolean
  /** 认任何 /词的兜底(mode)。整张表最多一条。 */
  slashCatchAll?: true
}

export interface CommandRegistry {
  readonly ids: readonly string[]
  probe(msg: InboundMsg): boolean
  /** 处理了它的命令(id + group);没有 ⇒ null。 */
  handle(msg: InboundMsg, turn?: CommandTurn): Promise<{ id: string; group: string } | null>
}

function arrange(commands: readonly WechatCommand[]): WechatCommand[] {
  const catchAll = commands.findIndex(c => c.slashCatchAll)
  if (catchAll < 0) return [...commands]
  if (commands.filter(c => c.slashCatchAll).length > 1) throw new Error('only one slashCatchAll command')
  const slashes: WechatCommand[] = commands.filter(c => c.ownsSlash).map(c => ({
    id: `${c.id}:slash`,
    ...(c.group ? { group: c.group } : {}),
    probe: (m) => c.ownsSlash!(m) && c.probe(m),
    handle: (m, turn) => c.handle(m, turn),
  }))
  return [...commands.slice(0, catchAll), ...slashes, ...commands.slice(catchAll)]
}

export function makeCommandRegistry(input: readonly WechatCommand[]): CommandRegistry {
  const commands = arrange(input)
  const seen = new Set<string>()
  for (const c of commands) { if (seen.has(c.id)) throw new Error(`duplicate command id: ${c.id}`); seen.add(c.id) }
  const claims = (c: WechatCommand, msg: InboundMsg) => { try { return c.probe(msg) } catch { return false } }
  return {
    ids: commands.map(c => c.id),
    probe: (msg) => commands.some(c => claims(c, msg)),
    async handle(msg, turn) {
      for (const c of commands) if (claims(c, msg) && await c.handle(msg, turn)) return { id: c.id, group: c.group ?? 'command' }
      return null
    },
  }
}

/**
 * 文本命令的老形状:`probe` 认不认这句,`handle` 处理并自己回话(返回 true = 这句它吃了)。
 * 功能交给命令表的就是它(日历、定时、经验、导入记忆 ……),经 fromReplyHandler 接进来。
 */
export interface ReplyHandler { probe(text: string, chatId: string): boolean; handle(text: string, chatId: string): Promise<boolean> }

/** 老的 (text, chatId) 形状的处理器(ReplyHandler)接进来。 */
export function fromReplyHandler(id: string, h: ReplyHandler, extra: Pick<WechatCommand, 'ownsSlash' | 'group'> = {}): WechatCommand {
  return { id, ...extra, probe: (m) => h.probe(m.text ?? '', m.chatId), handle: (m) => h.handle(m.text ?? '', m.chatId) }
}

/**
 * 管家刚问了「你说的是哪一件?回数字」(30 分钟)⇒ 管家**真会吃掉**的那句(裸数字、在选项范围内)这几条命令不认,
 * 让它落到管家(整合者评审 #659)。命令表排在管家前面(INTENT_ORDER),早报里「回 2」的拍板要是先认,任务那一问就丢了。
 * 只让管家会吃的:越界的数字、「2 不要」这种管家不认,让出去就掉进聊天了(第二轮评审)。只包给定的这几条,别的命令照旧。
 */
export function yieldNumbersToOpenChoice(commands: readonly WechatCommand[], butlerTakes: (chatId: string, text: string) => boolean): WechatCommand[] {
  return commands.map(c => ({ ...c, probe: (m: InboundMsg) => !butlerTakes(m.chatId, m.text ?? '') && c.probe(m) }))
}
