import { isPermissionCommandTool, type PermissionDisplay, type PermissionMcpTarget } from './permission-display'
import { permissionToolAction, permissionWebAction } from './permission-tool-words'
import { permissionTextSegments } from './permission-presentation'

/** One-line list title with an optional generic approval label. */
export function permissionWaitingTitle(
  display: PermissionDisplay | undefined, tool: string, summary: string | null | undefined, lang: 'zh-Hans' | 'en',
  fallback = '', mcp?: PermissionMcpTarget,
): string {
  const singleLine = (value: string) => permissionTextSegments(value.replace(/\s+/g, ' ').trim()).map(part => part.text).join('')
  const body = display?.body
  const name = tool === 'permission' ? '' : singleLine(tool)
  const detail = singleLine(summary ?? '')
  const zh = lang === 'zh-Hans'
  const run = (command: string) => `${zh ? '想运行' : 'Wants to run'} ${command}`
  let title: string
  if (body?.kind === 'command') title = run(singleLine(body.command))
  else if (body?.kind === 'edit' || (body?.kind === 'patch' && body.files.length === 1)) {
    const path = body.kind === 'edit' ? body.path : body.files[0]!.path
    title = `${zh ? '想改' : 'Wants to edit'} ${singleLine(path)}`
  } else if (body?.kind === 'write') title = `${zh ? '想写' : 'Wants to write'} ${singleLine(body.path)}`
  else if (!body && detail && (isPermissionCommandTool(name) || name === 'local_shell')) title = run(detail)
  else if (body?.kind === 'url' || body?.kind === 'query') title = permissionWebAction(body.kind, lang)
  else if (name) {
    const action = permissionToolAction(tool, lang, '', mcp)
    title = action ?? (mcp
      ? zh ? `想用 ${singleLine(mcp.server)} 的「${singleLine(mcp.tool)}」` : `Wants to use ${singleLine(mcp.server)}’s “${singleLine(mcp.tool)}”`
      : `${zh ? '想用' : 'Wants to use'} ${name}`)
    if (detail && (!body || (action && body.kind === 'text'))) title += `${zh ? '：' : ': '}${detail}`
  } else title = detail || fallback
  const chars = Array.from(title)
  return chars.length <= 120 ? title : `${chars.slice(0, 119).join('')}…`
}
