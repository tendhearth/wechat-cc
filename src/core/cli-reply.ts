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
  | { kind: 'view'; code: string }
  | { kind: 'say'; code: string; text: string }

const VIEW_RE = /^看\s*([a-z0-9]{4,12})\s*$/i
const SAY_RE = /^@([a-z0-9]{4,12})\s+([\s\S]+)$/i

export function parseCliReply(text: string): CliReply | null {
  const t = text.trim()
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
