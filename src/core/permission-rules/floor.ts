/**
 * floor.ts — 固定红线(规则和模型都改不了)与低风险分类(初审只在这里面跑)。纯函数。
 *
 * 红线宁可错杀:命中 ⇒ 主人亲手批(decide 里变成 ask),错杀的代价只是多问一次。
 * 低风险宁可漏:shell 里只要出现复合 / 重定向 / 子命令替换就不算 —— 红线藏在 `ls && git push` 的后半截。
 */
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { isDestructiveBash } from '../user-tier'
import type { PermissionAsk } from './types'

export type ToolClass = 'read' | 'write' | 'shell' | 'other'

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'read', 'search'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'fileChange', 'edit', 'delete', 'move'])
const SHELL_TOOLS = new Set(['Bash', 'commandExecution', 'execute', 'shell'])

export function toolClass(tool: string): ToolClass {
  if (READ_TOOLS.has(tool)) return 'read'
  if (WRITE_TOOLS.has(tool)) return 'write'
  if (SHELL_TOOLS.has(tool)) return 'shell'
  return 'other'
}

/** 每一条都在 root 下(`..` 先归一;按分隔符边界)。空 ⇒ false。调用方负责先 realpath 根。 */
export function pathsUnder(paths: readonly string[], root: string): boolean {
  if (!paths.length) return false
  const r = resolve(root)
  const prefix = r.endsWith(sep) ? r : r + sep
  return paths.every(p => { const a = resolve(r, p); return a === r || a.startsWith(prefix) })
}

const W = String.raw`(?:^|[;&|\x60$()\s'"=])`
const PUBLISH = [
  new RegExp(`${W}git\\s+push\\b`),
  new RegExp(`${W}git\\s+clean\\b`),
  new RegExp(`${W}(?:npm|pnpm|yarn|bun|cargo)\\s+publish\\b`),
  new RegExp(`${W}gh\\s+release\\b`),
  new RegExp(`${W}wechat-cc\\s+self\\s+(?:deploy|change)\\b`),
]
const SYSTEM = [
  new RegExp(`${W}sudo\\b`),
  new RegExp(`${W}launchctl\\b`),
  /\.(?:zshrc|zprofile|bashrc|bash_profile|profile)\b/,
]
const SECRETS = [
  /(?:^|[\s'"=/~])\.ssh(?:\/|\b)/,
  /\.private_keys\b/,
  /(?:^|[\s'"=/])\.env(?:$|[\s'"./-]|\b)/,
  /\.(?:p8|pem|p12|key)\b/,
  new RegExp(`${W}security\\s+(?:find|dump|export)-`),
]
const CC_CONFIG = /(?:permission-rules|agent-config|access)\.json\b/
const NET_ALWAYS = new RegExp(`${W}(?:nc|ncat|ssh|scp|sftp|rsync|telnet|ftp)\\s`)
const NET_HTTP = new RegExp(`${W}(?:curl|wget)\\b`, 'g')
const LOCAL_TARGET = /^(?:['"]?)(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|['"]?$)/

/** curl / wget 后面任何看起来像主机的参数(带 `.` 或 `:`)都得是本机,否则算外呼。 */
function outbound(cmd: string): boolean {
  if (NET_ALWAYS.test(cmd + ' ')) return true
  NET_HTTP.lastIndex = 0
  const m = NET_HTTP.exec(cmd)
  if (!m) return false
  const rest = cmd.slice(m.index + m[0].length).split(/\s+/).filter(Boolean)
  return rest.some(t => !t.startsWith('-') && /[.:]/.test(t) && !LOCAL_TARGET.test(t))
}

/** 命中红线 ⇒ 一句中文理由;否则 null。 */
export function floorReason(ask: PermissionAsk, home: string = homedir()): string | null {
  const cmd = ask.command ?? ''
  const paths = ask.paths ?? []
  const text = [cmd, ...paths].join('\n').replaceAll(home, '~')
  if (toolClass(ask.tool) === 'write' && paths.length && (!ask.project || !pathsUnder(paths, ask.project))) return '写到了项目目录之外'
  if (cmd && isDestructiveBash(cmd)) return '破坏性命令'
  if (cmd && PUBLISH.some(r => r.test(cmd))) return '推送 / 发布 / 部署'
  if (SYSTEM.some(r => r.test(text))) return '改系统或 shell 配置'
  if (SECRETS.some(r => r.test(text))) return '碰到密钥'
  if (CC_CONFIG.test(text)) return '改 CC 自己的配置'
  if (cmd && outbound(cmd)) return '往外连网'
  return null
}

const READ_ONLY_CMD = /^(?:ls|cat|head|tail|wc|pwd|grep|rg|find|git\s+(?:status|diff|log|show)|(?:npm|bun|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|lint))|bunx?\s+tsc\s+--noEmit)(?:\s|$)/
const COMPOUND = /[;&|><\x60\n\r]|\$\(/
const FIND_ACTIONS = /\s-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/

export function isLowRisk(ask: PermissionAsk): boolean {
  switch (toolClass(ask.tool)) {
    case 'read': return true
    case 'shell': {
      const c = ask.command?.trim()
      if (!c || COMPOUND.test(c) || !READ_ONLY_CMD.test(c)) return false
      return !(c.startsWith('find') && FIND_ACTIONS.test(c))
    }
    case 'write':
      return ask.surface === 'workbench' && ask.isolatedWorktree && !!ask.project && !!ask.paths?.length && pathsUnder(ask.paths, ask.project)
    default: return false
  }
}
