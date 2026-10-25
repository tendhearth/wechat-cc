/**
 * chat.ts — 主人自己的对话也走放行规则(2026-10-25 主人点头,看得见的变化)。三家逐工具过闸门的执行者(Claude 的
 * permission-relay、Gemini gate、openai gate)都经这里,判定本身仍只在 domain/authorize.ts。
 *
 * 三条约束,各落在哪:
 *   1. 只在主人自己的对话里:`rules.isOwnerChat(chatId)` 在判的那一刻现算(daemon 接的是 access.json 的 admins,按原始
 *      档位,不看 --dangerously),作为 subject.ownerChat 交给 authorize。模型的输入碰不到它。访客 / 信任的对话 ⇒ 假 ⇒
 *      authorize 不要裁决,这里连规则文件都不读。
 *   2. 红线照旧问主人:permission-rules/decide 里红线之上没有 allow;对话里不初审,authorize 只认 by rule。
 *   3. 规则替主人放了 ⇒ 这一轮的回复带一行「按规则「…」放行了 …」:`rules.noteAllowed` 登记到这个对话正在进行的那一轮
 *      (daemon 的回复交付,同一条规则一轮一行)。**登记不上就不放**(落回没有规则时的老路:问,openai 是拒)——
 *      和 permission-gate「记不下来就不放」同一条规矩:CC 替主人放了,主人却看不到,是反目标。
 *
 * 规则拒绝:和终端 / 一起做一样直接拒,理由交给执行者(denyMessage)。
 */
import { authorize, type AuthSubject, type Authorization, type GateExecutor, type ToolDescriptor } from '../../domain/authorize'
import type { Decision, PermissionAsk } from '../../domain/permission-rules/types'
import { toolInputFacts } from '../../domain/permission-rules/facts'
import { isAbsolutePath, type Platform } from './paths'

/** 对话里的一次工具调用(规则只看这几样)。tool 用 SDK 形状的名字(Bash、mcp__wechat__memory_delete …),三家一致。 */
export interface ChatToolCall {
  chatId: string
  provider: GateExecutor
  tool: string
  input: Record<string, unknown>
}

/** 「按规则放行了」那一行要的东西。key 用来一轮里同一条规则只写一行。 */
export interface RuleAllowNotice { key: string; rule: string; target: string }

/** daemon 接的三样(没接 ⇒ 对话不看放行规则,和 2026-10-25 之前一样)。 */
export interface ChatOwnerRules {
  /** 这个对话此刻是不是主人自己的(access.json 的 admins,原始档位)。 */
  isOwnerChat(chatId: string): boolean
  /** permission-gate.decide(读规则文件、红线、留痕;永不抛,出事 ⇒ ask)。 */
  decide(ask: () => PermissionAsk): Promise<Decision>
  /** 登记到这个对话正在进行的那一轮;没有开着的轮 / 登记不上 ⇒ false(那就不放)。 */
  noteAllowed(chatId: string, notice: RuleAllowNotice): boolean
}

export type ChatAuthorization = Authorization & {
  /** 规则拒绝时交给执行者的话(和终端 / 一起做一样,拒绝的理由让执行者看得见)。 */
  denyMessage?: string
}

/**
 * 一次调用 → 放行规则的请求。对话没有项目根(会话目录不是工具要碰的地方)⇒ project / cwd 恒为 null;
 * 路径只认输入里明写的**绝对**路径 —— 有一条是相对的就当不知道(paths 不给):按路径 / 项目限定的规则不会因为路径空着或不明命中,
 * 写类工具缺路径 ⇒ allow 规则不生效(decide.missingFacts)。
 */
export function chatAsk(call: ChatToolCall, platform: Platform = process.platform): PermissionAsk {
  const ask: PermissionAsk = {
    surface: 'chat', provider: call.provider, tool: call.tool,
    cwd: null, project: null, isolatedWorktree: false, tier: 'admin', scope: `chat:${call.chatId}`,
  }
  // 和终端 hook、一起做同一份取法(命令原文截 2000、file_path / notebook_path / path)。
  const facts = toolInputFacts(call.input)
  if (facts.command) ask.command = facts.command
  if (facts.paths.length && facts.paths.every(p => isAbsolutePath(p, platform))) ask.paths = facts.paths
  return ask
}

const oneLine = (s: string, max: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t }

/** 那一行里「放行了 X」的 X:命令原文(截 40 字),否则工具名(wechat 自己的工具去掉 mcp__wechat__ 前缀)。 */
export function noticeTarget(call: Pick<ChatToolCall, 'tool' | 'input'>): string {
  const cmd = call.input.command
  if (typeof cmd === 'string' && cmd.trim()) return oneLine(cmd, 40)
  return call.tool.startsWith('mcp__wechat__') ? call.tool.slice('mcp__wechat__'.length) : call.tool
}

/** 「按规则「看构建产物不用问」放行了 rm -rf dist」。count > 1 ⇒ 句末加「(这一轮共 N 次)」。 */
export function ruleAllowLine(n: { rule: string; target: string }, count = 1): string {
  return `按规则「${n.rule}」放行了 ${n.target}${count > 1 ? `(这一轮共 ${count} 次)` : ''}`
}

/**
 * 对话面的一次判定:先按没有规则判;落到「问」、而且是主人自己的对话 ⇒ 问规则,再判一次。
 * subject 不带 surface / ownerChat:surface 恒为 chat,ownerChat 只能在这里现算。
 */
export async function authorizeChatCall(
  subject: Omit<AuthSubject, 'surface' | 'ownerChat'>,
  descriptor: ToolDescriptor,
  call: ChatToolCall,
  rules: ChatOwnerRules | null | undefined,
): Promise<ChatAuthorization> {
  let ownerChat = false
  if (rules) { try { ownerChat = rules.isOwnerChat(call.chatId) === true } catch { ownerChat = false } }
  const s: AuthSubject = { ...subject, surface: 'chat', ownerChat }
  // 可能判两次(先不带裁决、再带):能力表那一行只取一次(Gemini 取它要读对话模式,和以前一样只读一回)。
  if (typeof descriptor.askUser === 'function') {
    const read = descriptor.askUser
    let memo: 'per-tool' | 'never' | undefined
    descriptor = { ...descriptor, askUser: () => (memo ??= read()) }
  }
  const first = authorize(s, descriptor)
  if (!first.consultOwnerRules || !rules) return first
  const noRule = () => authorize(s, descriptor, { ownerRuling: { verdict: 'ask', by: 'default' } })
  let d: Decision
  try { d = await rules.decide(() => chatAsk(call)) } catch { return noRule() }
  const ruled = authorize(s, descriptor, { ownerRuling: d })
  if (ruled.reason !== 'owner_rules') return ruled
  if (ruled.verdict === 'deny') return { ...ruled, detail: d.reason, denyMessage: `The owner's permission rule denied this (${d.reason}). Do not retry it; tell the user it was blocked by their rule.` }
  const notice: RuleAllowNotice = { key: d.ruleId ?? d.reason, rule: d.note ?? d.ruleId ?? '放行规则', target: noticeTarget(call) }
  let noted = false
  try { noted = rules.noteAllowed(call.chatId, notice) } catch { noted = false }
  return noted ? ruled : noRule()
}
