import { PermissionDisplaySchema, permissionDisplay, type PermissionDisplay } from './permission-display'

export function resolvePermissionDisplay(tool: string, description: string, display: unknown, executor?: string) {
  const format = executor === undefined ? 'hook' : executor === 'claude' ? 'claude' : executor === 'openai' ? 'api' : 'text'
  return PermissionDisplaySchema.safeParse(display).data ?? permissionDisplay(tool, description, format)
}

export const normalizePermissionLines = (value: string) => value.replace(/\r\n?/g, '\n')

export function permissionLines(value: string): string[] {
  if (!value) return []
  const lines = normalizePermissionLines(value).split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Only shorten descendants. Keep the spelling and separators in the visible suffix. */
export function permissionRelativePath(path: string, cwd: string): string {
  const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd)
  const normalize = (value: string) => windows ? value.replace(/\\/g, '/').toLowerCase() : value
  const base = cwd.replace(windows ? /[\\/]+$/ : /\/+$/, '')
  if (!cwd || /^[a-z]:$/i.test(cwd) || path.split(windows ? /[\\/]/ : '/').includes('..')) return path
  return normalize(path).startsWith(`${normalize(base)}/`) && path.length > base.length + 1 ? path.slice(base.length + 1) : path
}

export function permissionPatchLabel(change: string, destination?: string): string {
  if (destination !== undefined) return `改名 → ${destination}`
  switch (change) {
    case 'add': return '新建'
    case 'update': return '修改'
    case 'delete': return '删除'
    case 'move':
    case 'rename': return '改名'
    default: return change
  }
}

/** Chinese approval copy follows the App's approval.actor messages. */
export function permissionActionZh(body: PermissionDisplay['body'], tool: string, actor: string): string {
  const who = actor ? `${actor} ` : ''
  switch (body.kind) {
    case 'command': return `${who}想运行一条命令`
    case 'edit': return `${who}想改一个文件${body.changes.length > 1 ? `的 ${body.changes.length} 处` : ''}`
    case 'write': return `${who}想写一个文件`
    case 'patch': return `${who}想改 ${body.files.length === 1 ? '一个文件' : `${body.files.length} 个文件`}`
    case 'url': return `${who}想打开一个网址`
    case 'query': return `${who}想上网搜一下`
    case 'fields':
    case 'text': {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      return mcp ? `${who}想用 ${mcp[1]} 的「${mcp[2]}」` : `${who}想用「${tool}」`
    }
  }
}
