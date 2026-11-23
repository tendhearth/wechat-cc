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

export const PERMISSION_WHITESPACE_NOTICE_ZH = '这处改动只在换行或空白上有差别，这里看不出来。'
export const PERMISSION_NO_FINAL_NEWLINE_ZH = '（文件末尾没有换行）'

const withoutWhitespace = (value: string) => value.replace(/\s/g, '')

// Cancel unchanged lines before looking for matching text with different whitespace.
// Keep line endings in the comparison so CRLF and LF remain distinguishable.
function hasWhitespaceChange(before: string, after: string): boolean {
  if (before === after) return false
  if (withoutWhitespace(before) === withoutWhitespace(after)) return true
  const counts = new Map<string, number>()
  const lines = (value: string) => value.match(/[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/g) ?? []
  for (const line of lines(before)) counts.set(line, (counts.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of lines(after)) {
    const count = counts.get(line) ?? 0
    if (count > 0) counts.set(line, count - 1)
    else added.push(line)
  }
  const removedText = new Set([...counts].filter(([, count]) => count > 0).map(([line]) => withoutWhitespace(line)))
  return added.some(line => removedText.has(withoutWhitespace(line)))
}

export function permissionEditPreview(before: string, after: string) {
  const beforeEndsWithNewline = /[\r\n]$/.test(before)
  const afterEndsWithNewline = /[\r\n]$/.test(after)
  const newlineChanged = beforeEndsWithNewline !== afterEndsWithNewline
  const noFinalNewline = before.length > 0 && after.length > 0 && newlineChanged
    ? (beforeEndsWithNewline ? 'after' : 'before') : undefined
  return {
    before: permissionLines(before),
    after: permissionLines(after),
    whitespaceChange: hasWhitespaceChange(before, after),
    noFinalNewline,
  }
}

/** Full terminal contents reconstructed from the received structured input. */
export function permissionOperationSource(display: PermissionDisplay): string {
  const { body, note, extra } = display
  const fields = (values: NonNullable<PermissionDisplay['extra']>) => values.map(({ name, value }) => `${name}: ${value}`)
  let source: string[]
  switch (body.kind) {
    case 'command': source = [body.command, ...(body.cwd !== undefined ? [`Working directory: ${body.cwd}`] : [])]; break
    case 'edit': source = body.changes.flatMap(({ path, before, after }) => [
      path ?? body.path, ...(body.replaceAll !== undefined ? [`replace_all: ${body.replaceAll}`] : []),
      // Quoting makes tabs, CRLF and the exact end of each value inspectable.
      `Before: ${JSON.stringify(before)}`, `After: ${JSON.stringify(after)}`,
    ]); break
    case 'write': source = [body.path, body.content]; break
    case 'patch': source = body.files.flatMap(({ path, change, movePath, diff }) => [path, change, ...(movePath !== undefined ? [movePath] : []), diff]); break
    case 'url': source = [body.url, ...(body.prompt !== undefined ? [body.prompt] : [])]; break
    case 'query': source = [body.query]; break
    case 'fields': source = fields(body.fields); break
    case 'text': source = [body.text]; break
  }
  return [...(note ? [note] : []), ...source, ...fields(extra ?? [])].join('\n')
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
