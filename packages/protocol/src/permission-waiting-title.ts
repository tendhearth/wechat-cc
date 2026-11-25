import { isPermissionCommandTool, type PermissionDisplay, type PermissionMcpTarget } from './permission-display'
import { permissionToolAction, permissionWebAction } from './permission-tool-words'
import { permissionTextSegments } from './permission-presentation'

const targetFields = new Set(['path', 'file_path', 'filePath', 'directory', 'dir_path', 'notebook_path', 'pattern', 'url', 'query', 'description'])

/** One-line list title with an optional generic approval label. */
export function permissionWaitingTitle(
  display: PermissionDisplay | undefined, tool: string, summary: string | null | undefined, lang: 'zh-Hans' | 'en',
  fallback = '', mcp?: PermissionMcpTarget, maxChars = 120,
): string {
  const visible = (value: string) => permissionTextSegments(value).map(part => part.text).join('')
  const singleLine = (value: string) => visible(value.replace(/\s+/g, ' ').trim())
  const body = display?.body
  const name = tool === 'permission' ? '' : singleLine(tool)
  const detail = singleLine(summary ?? '')
  const zh = lang === 'zh-Hans'
  const run = (command: string) => `${zh ? '想运行' : 'Wants to run'} ${command}`
  const withDetail = (action: string, target?: string) => {
    const value = target ? visible(target.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\t', '\\t')
      .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')) : detail
    if (!value) return action
    const prefix = action + (zh ? '：' : ': ')
    const chars = Array.from(value)
    const available = maxChars - prefix.length
    if (available < 3 || chars.length <= available) return prefix + value
    // A long shared directory prefix should leave room for the filename.
    const head = Math.floor((available - 1) / 2)
    return prefix + chars.slice(0, head).join('') + '…' + chars.slice(-(available - 1 - head)).join('')
  }
  let title: string
  if (body?.kind === 'command') title = run(singleLine(body.command))
  else if (body?.kind === 'edit' || (body?.kind === 'patch' && body.files.length === 1)) {
    const path = body.kind === 'edit' ? body.path : body.files[0]!.path
    title = `${zh ? '想改' : 'Wants to edit'} ${singleLine(path)}`
  } else if (body?.kind === 'write') title = `${zh ? '想写' : 'Wants to write'} ${singleLine(body.path)}`
  else if (!body && detail && (isPermissionCommandTool(name) || name === 'local_shell')) title = run(detail)
  else if (body?.kind === 'url' || body?.kind === 'query') {
    title = withDetail(permissionWebAction(body.kind, lang), body.kind === 'url' ? body.url : body.query)
  }
  else if (name) {
    const action = permissionToolAction(tool, lang, '', mcp)
    title = action ?? (mcp
      ? zh ? `想用 ${singleLine(mcp.server)} 的「${singleLine(mcp.tool)}」` : `Wants to use ${singleLine(mcp.server)}’s “${singleLine(mcp.tool)}”`
      : `${zh ? '想用' : 'Wants to use'} ${name}`)
    if (action && body?.kind === 'fields') {
      const target = body.fields.filter(field => targetFields.has(field.name) && field.value.trim()).map(field => field.value).join(' · ')
      title = withDetail(title, target)
    } else if (action && (!body || body.kind === 'text')) title = withDetail(title)
    else if (detail && !body) title += `${zh ? '：' : ': '}${detail}`
  } else title = detail || fallback
  const chars = Array.from(title)
  return chars.length <= maxChars ? title : `${chars.slice(0, maxChars - 1).join('')}…`
}
