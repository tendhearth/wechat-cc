/**
 * cli-reply.ts — 主人在微信里对某条终端会话说话(spec 2026-09-09-cli-hook-push §6.4)。
 *
 *   看 a1b2c3          → 把那条会话的尾巴渲染成页面发链接
 *   @a1b2c3 改成 X     → `claude -p --resume` / `codex exec resume` 接着原来的对话跑,结果回微信
 *
 * 纯逻辑:解析 + 组命令行。跑与回都在 daemon/cli-reply-handler.ts。
 */
import type { CliSource } from './cli-events'

export type CliReply =
  | { kind: 'list' }
  | { kind: 'today' }
  | { kind: 'view'; code: string }
  | { kind: 'say'; code: string; text: string }

const VIEW_RE = /^看\s*([a-z0-9]{4,12})\s*$/i
const SAY_RE = /^@([a-z0-9]{4,12})\s+([\s\S]+)$/i
/**
 * 「终端」—— 列出终端里的会话(2026-10-14)。整句匹配,只认这几种说法:
 * 终端 / 终端会话 / 终端列表 / 看终端 / 看看终端 / 会话列表 / /cli,可带问号。
 * 不认单独的「会话」:日常聊天里太容易整句说出来。说法更散的(「我终端里那几个在干嘛」)
 * 交给模型,它有只读工具 terminal_sessions。
 */
const LIST_RE = /^(?:看看?)?(?:终端(?:会话|列表)?|会话列表|\/cli)\s*[?？]?$/i

/**
 * 「日报」—— 过去 24 小时终端 + 一起做的一眼看完(2026-10-14,core/overseer-today.ts)。整句匹配:
 * 日报 / 今日日报 / 今天日报 / 看日报 / 看看日报 / /today,可带问号。
 * 不认「今天」「今天怎么样」:前者是 CC 问「什么时候」时最常见的整句回答,后者是日常寒暄,
 * 而且句尾的「怎么样」本来就归管家(mw-task-reference 的 STATUS_VERB)。
 */
const TODAY_RE = /^(?:(?:看看?)?(?:今[天日])?日报|\/today)\s*[?？]?$/i

export function parseCliReply(text: string): CliReply | null {
  const t = text.trim()
  if (LIST_RE.test(t)) return { kind: 'list' }
  if (TODAY_RE.test(t)) return { kind: 'today' }
  const v = VIEW_RE.exec(t)
  if (v) return { kind: 'view', code: v[1]!.toLowerCase() }
  const s = SAY_RE.exec(t)
  if (s) return { kind: 'say', code: s[1]!.toLowerCase(), text: s[2]!.trim() }
  return null
}

/**
 * 接着原来的对话再说一句。两家都是「新进程 + 原会话 id」:Claude 写回同一份 transcript,
 * Codex 写回同一份 rollout。daemon 的 --dangerously 姿态原样带过去 —— 非交互模式下
 * 没人能在终端里点「允许」。
 */
export function resumeCommand(source: CliSource, sessionId: string, text: string, dangerously: boolean): { cmd: string; args: string[] } {
  if (source === 'claude') {
    return { cmd: 'claude', args: ['-p', '--resume', sessionId, ...(dangerously ? ['--dangerously-skip-permissions'] : []), text] }
  }
  return { cmd: 'codex', args: ['exec', '--skip-git-repo-check', ...(dangerously ? ['--dangerously-bypass-approvals-and-sandbox'] : []), 'resume', sessionId, text] }
}
