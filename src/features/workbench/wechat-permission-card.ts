import { createHash } from 'node:crypto'
import {
  PermissionDisplaySchema, PERMISSION_INVISIBLE_NOTICE_ZH, PERMISSION_SNAPSHOT_NOTICE, PERMISSION_WHITESPACE_NOTICE_ZH,
  hasInvisiblePermissionText, isPermissionCommandTool, permissionActionZh, permissionCwd, permissionEditPreview, permissionLines,
  permissionPatchLabel, permissionTextSegments, resolvePermissionDisplay,
} from '@wechat-cc/protocol'
import { MAX_TEXT_CHUNK } from '../../lib/config'
import { providerDisplayName } from '../../domain/provider-display-names'
import { wechatPermissionHeader } from '../../domain/workbench/wechat-permission-header'
import { wechatPermissionSource, type PendingWorkbenchPermission } from '../../ports/workbench'
import { WECHAT_PERMISSION_INCOMPLETE, type WechatPermissionCard } from '../../ports/wechat'

export function workbenchPermissionReplyLine(permission: PendingWorkbenchPermission, code: string | null): string {
  return code ? `回「y ${code}」允许这一步、「n ${code}」拒绝。${permission.canDenyWithReason ? `拒绝理由选填：「n ${code} 理由」。` : ''}${permission.canAllowTask ? `回「yt ${code}」本任务同命令都允许，任务结束失效。` : ''}` : ''
}

const LINE_LIMIT = 6
const SNAPSHOT_SUFFIX = '\n\n' + PERMISSION_SNAPSHOT_NOTICE
const COMMAND_START = '〔命令开始〕'
const COMMAND_END = '〔命令结束〕'
const pathTools = new Set(['read', 'readfile', 'listfiles', 'glob', 'grep', 'edit', 'multiedit', 'notebookedit', 'write', 'move', 'delete', 'filechange'])
const escapeInvisible = (value: string) => permissionTextSegments(value).map(segment => segment.text).join('')
// The renderer owns request markers and reply instructions. Submitted text
// may contain their syntax, including inside a title, note or command.
const controlCopy = /〔请求|\[approval:|「(?:yt?|n)\s+[a-z0-9]+」|^回「[yn]」/gim
const hasControlCopy = (text: string) => text.search(controlCopy) !== -1
const neutralizeControlCopy = (text: string) => text.replace(controlCopy, match =>
  `\\u{${match.charCodeAt(0).toString(16).toUpperCase()}}${match.slice(1)}`)
const escapeLineSeparators = (value: string) => value.replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
const oneLine = (value: string) => escapeLineSeparators(value).replaceAll('\n', '\\n').replaceAll('\t', '\\t')
const visible = (value: string) => neutralizeControlCopy(escapeInvisible(value)).replace(/[\uD800-\uDFFF]/gu, char =>
  `\\u{${char.charCodeAt(0).toString(16).toUpperCase()}}`)
const hasUnpairedSurrogate = (value: string) => /[\uD800-\uDFFF]/u.test(value)

function textValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(textValues)
  return []
}

/** One projection decides eligibility for both task commands and registry replies. */
export function renderWechatPermissionCard(
  title: string,
  permission: PendingWorkbenchPermission,
  provider: string,
  code: string | null = null,
): WechatPermissionCard {
  const source = permission[wechatPermissionSource]
  const description = source?.description ?? permission.description
  const raw = !source && permission.showSnapshotNotice && description.endsWith(SNAPSHOT_SUFFIX)
    ? description.slice(0, -SNAPSHOT_SUFFIX.length) : description
  const suppliedDisplay = source?.display ?? permission.display
  const display = resolvePermissionDisplay(permission.tool, raw, suppliedDisplay, provider)
  const { body } = display
  const tool = permission.tool.toLowerCase()
  const commandRequest = body.kind === 'command' || source?.command !== undefined ||
    isPermissionCommandTool(tool) || tool === 'execute' || tool === 'commandexecution'
  const needsCwd = commandRequest || body.kind === 'write' ||
    source?.paths?.some(path => !permissionCwd(path)) ||
    (body.kind === 'edit' && body.changes.some(change => !permissionCwd(change.path ?? body.path))) ||
    (body.kind !== 'edit' && pathTools.has(tool))
  const cwd = permissionCwd(permission.cwd)
  const securityText = [...textValues(display), ...textValues(permission.mcp), source?.argumentJson ?? '', title, permission.tool, permission.cwd ?? '', source?.cwd ?? '', source?.command ?? '',
    ...(!suppliedDisplay ? [raw] : [])].join('\n')
  const invisible = hasInvisiblePermissionText(securityText)
  const opaqueCommand = commandRequest && (body.kind === 'text' || body.kind === 'fields')
  const commandShown = !commandRequest || body.kind === 'command' || (opaqueCommand && source?.command !== undefined)
  let complete = (!tool.startsWith('mcp__') || !!permission.mcp) && !source?.incomplete && !display.truncated && !permission.scripts?.length &&
    (suppliedDisplay === undefined || PermissionDisplaySchema.safeParse(suppliedDisplay).success) &&
    !invisible && !hasUnpairedSurrogate(securityText) && !hasControlCopy(securityText) && (!needsCwd || !!cwd) && commandShown

  const marker = createHash('sha256').update('workbench-wechat-permission\0').update(permission.id).digest('hex').slice(0, 16)
  const header = [wechatPermissionHeader(oneLine(visible(title)), permission.taskId), `〔请求 ${marker}〕`]
  const actor = providerDisplayName(provider)
  const action = oneLine(visible(opaqueCommand
    ? permissionActionZh({ kind: 'command', command: '' }, '', actor)
    : permissionActionZh(body, permission.tool, actor, permission.mcp)))
  const historyText = `待批：${commandRequest ? '运行命令' : '工具操作'} · ${header[1]}`
  const lines = [`${action}：`]
  // Encode every string value as a JSON string. In particular, literal
  // backslashes cannot impersonate escapes for real whitespace.
  const inline = (value: string) => escapeLineSeparators(JSON.stringify(visible(value)))
  const field = (name: string, value: string) => `${/^[\p{L}\p{N}_-]+$/u.test(name) ? name : inline(name)}：${inline(value)}`
  const commandBlock = (value: string) => {
    const commandLines = value.split('\n')
    if (commandLines.some(line => line.trim() === COMMAND_START || line.trim() === COMMAND_END)) complete = false
    // An empty final line retains the trailing LF, and escaping backslashes
    // first distinguishes a literal escape from actual whitespace.
    lines.push(COMMAND_START, ...commandLines.map(line => '│ ' + visible(line.replaceAll('\\', '\\\\'))
      .replaceAll('\t', '\\t').replaceAll('\u2028', '\\u{2028}').replaceAll('\u2029', '\\u{2029}')
      .replace(/^ +| +$| {2,}/g, spaces => '\\x20'.repeat(spaces.length))), COMMAND_END)
  }
  const excerpt = (value: string, prefix: string, limit: number, ending: string) => {
    const all = permissionLines(value)
    lines.push(...all.slice(0, limit).map(line => prefix + inline(line)))
    if (all.length > limit) {
      lines.push('…')
      complete = false
    } else if (value && !value.endsWith('\n')) lines.push(ending)
  }

  switch (body.kind) {
    case 'command':
      commandBlock(body.command)
      if (source?.command !== undefined && source.command !== body.command) {
        lines.push(field('实际命令', source.command))
        complete = false
      }
      break
    case 'edit':
      lines[0] = action.replace(/一个文件(?:的 \d+ 处)?$/, () => ` ${inline(body.path)}（${body.changes.length} 处）`) + '：'
      if (body.replaceAll !== undefined) lines.push('replace_all：' + String(body.replaceAll))
      for (const change of body.changes) {
        if (body.changes.length > 1 || change.path !== undefined) lines.push(`改动 ${inline(change.path ?? body.path)}：`)
        const preview = permissionEditPreview(change.before, change.after)
        const beforeLimit = Math.min(preview.before.length, LINE_LIMIT - Math.min(preview.after.length, LINE_LIMIT / 2))
        excerpt(change.before, '- ', beforeLimit, '〔原文末尾无换行〕')
        excerpt(change.after, '+ ', LINE_LIMIT - beforeLimit, '〔改后末尾无换行〕')
        if (preview.whitespaceChange) {
          lines.push(PERMISSION_WHITESPACE_NOTICE_ZH)
          complete = false
        }
      }
      break
    case 'write':
      lines.push(inline(body.path))
      excerpt(body.content, '| ', LINE_LIMIT, '〔文件末尾无换行〕')
      break
    case 'patch':
      complete = false
      for (const file of body.files) lines.push(`${inline(file.path)}（${oneLine(visible(permissionPatchLabel(file.change, file.movePath)))}）`)
      break
    case 'url':
      lines.push(field('网址', body.url))
      if (body.prompt !== undefined) lines.push(field('要求', body.prompt))
      break
    case 'query':
      lines.push(field('搜索', body.query))
      break
    case 'fields':
      if (opaqueCommand && source?.command !== undefined) commandBlock(source.command)
      lines.push(...body.fields.map(item => field(item.name, item.value)))
      // SaveArtifact's digest is reviewable metadata, but is not the content about to be written.
      if (permission.tool === 'SaveArtifact') complete = false
      break
    case 'text':
      if (commandRequest) {
        if (source?.command !== undefined) commandBlock(source.command)
        if (body.text !== source?.command) lines.push(field('执行者说明', body.text))
      } else lines.push(visible(body.text))
      complete = false
      break
  }
  lines.push(...(display.extra ?? []).map(item => field(item.name, item.value)))
  if (source?.argumentJson !== undefined) lines.push('参数 JSON：' + escapeLineSeparators(visible(source.argumentJson)))
  if (display.note !== undefined) lines.push(field('原因', display.note))
  if (cwd !== undefined) lines.push(`在 ${inline(cwd)}`)
  const reportedCwd = source?.cwd ?? (body.kind === 'command' ? body.cwd : undefined)
  if (reportedCwd !== undefined && reportedCwd !== permission.cwd) {
    lines.push(field('cwd', reportedCwd))
    complete = false
  }
  if (body.kind === 'command' && body.cwd !== undefined && body.cwd !== reportedCwd && body.cwd !== permission.cwd) {
    lines.push(field('命令给出的 cwd', body.cwd))
    complete = false
  }
  if (invisible) lines.push(PERMISSION_INVISIBLE_NOTICE_ZH)
  const snapshot = permission.showSnapshotNotice ? [PERMISSION_SNAPSHOT_NOTICE] : []
  const explicit = (verb: string) => `任务 ${permission.taskId} ${verb} ${permission.id}`
  const reply = workbenchPermissionReplyLine(permission, code) || `允许：${explicit('允许')}\n拒绝：${explicit('拒绝')}`
  const full = [...header, ...lines, ...snapshot, reply].join('\n')
  // WeChat replies can only quote one message. The existing 4,000-unit
  // transport split is stricter than the previous 6,000-unit lookup limit.
  if (complete && full.length <= MAX_TEXT_CHUNK) return { text: full, marker, historyText, complete: true }

  const deny = code
    ? `回「n ${code}」拒绝。${permission.canDenyWithReason ? `拒绝理由选填：「n ${code} 理由」。` : ''}`
    : `拒绝：${explicit('拒绝')}`
  const footer = [...snapshot, WECHAT_PERMISSION_INCOMPLETE, deny]
  const preview = [...header, ...lines, ...footer].join('\n')
  const summary = [...header, ...footer].join('\n')
  return {
    text: preview.length <= MAX_TEXT_CHUNK ? preview : summary.length <= MAX_TEXT_CHUNK ? summary
      : [wechatPermissionHeader('', permission.taskId), header[1], ...footer].join('\n'),
    marker,
    historyText,
    complete: false,
  }
}
