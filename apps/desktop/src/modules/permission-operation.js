// @ts-check
import {
  permissionTextSegments, permissionEditPreview as bundledEditPreview, permissionLines as bundledLines, permissionPatchLabel, permissionRelativePath,
  PERMISSION_INVISIBLE_NOTICE_ZH, PERMISSION_NO_FINAL_NEWLINE_ZH, PERMISSION_SNAPSHOT_NOTICE, PERMISSION_WHITESPACE_NOTICE_ZH,
} from '../generated/permission-display.js'
import { escapeWorkbenchHtml as escape } from './workbench-markdown.js'

/** @typedef {import('../../../../packages/protocol/src/permission-display').PermissionDisplay} PermissionDisplay */
/** @typedef {{showSnapshotNotice?:boolean,hasScriptPreview?:boolean}} SnapshotOptions */
/** @typedef {{cwd?:string,projectPath?:string,raw?:string,summary?:string,summaryTruncated?:boolean,summaryOnly?:boolean,disclosureId?:string,compact?:()=>void} & SnapshotOptions} OperationOptions */
/** @typedef {{name:string,value:string}} Field */

/** @type {typeof import('../../../../packages/protocol/src/permission-presentation').permissionLines} */
const permissionLines = bundledLines
/** @typedef {typeof import('../../../../packages/protocol/src/permission-presentation').permissionEditPreview} EditPreview */
const permissionEditPreview = /** @type {EditPreview} */ (/** @type {unknown} */ (bundledEditPreview))

/** @param {string} value @param {() => void} [onMarked] */
export function renderPermissionText(value, onMarked) {
  return permissionTextSegments(value).map(({ text, marked }) => {
    const safe = escape(text)
    if (!marked) return safe
    onMarked?.()
    return `<span class="approval-invisible" role="img" aria-label="不可见字符 ${safe}">${safe}</span>`
  }).join('')
}

const SUMMARY_WHITESPACE = '摘要里的换行和连续空格可能被并掉了。'

/** @param {PermissionDisplay} display @param {{cwd?:string, summaryTruncated?:boolean} & SnapshotOptions} options */
export function renderCompactPermissionOperation(display, options) {
  let needsFullView = false
  const html = renderPermissionOperation(display, { ...options, compact: () => { needsFullView = true } })
  return { html, needsFullView }
}

/** @param {string[]} lines */
function patchWhitespaceChange(lines) {
  let before = '', after = ''
  let last = ''
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (permissionEditPreview(before, after).whitespaceChange) return true
      before = after = ''
    } else if (line.startsWith('-')) before += line.slice(1) + '\n'
    else if (line.startsWith('+')) after += line.slice(1) + '\n'
    else if (line === '\\ No newline at end of file') {
      if (last === '-') before = before.slice(0, -1)
      if (last === '+') after = after.slice(0, -1)
    }
    last = line.charAt(0)
  }
  return permissionEditPreview(before, after).whitespaceChange
}

/** @param {PermissionDisplay} display @param {OperationOptions} [options] */
export function renderPermissionOperation(display, { cwd, projectPath = '', raw, summary, summaryTruncated = false, summaryOnly = false,
  disclosureId, compact, showSnapshotNotice = false, hasScriptPreview = showSnapshotNotice } = {}) {
  const incomplete = display.truncated === true || (summaryTruncated && raw === undefined)
  if (incomplete || hasScriptPreview) compact?.()
  let remainingLines = 4
  const { body, extra, note } = display
  const path = (/** @type {string} */ value) => permissionRelativePath(value, cwd ?? projectPath)
  let disclosureIndex = 0
  const disclosure = (/** @type {string} */ label, /** @type {string} */ content) => {
    const id = disclosureId ? ` id="${escape(`${disclosureId}-${++disclosureIndex}`)}" data-permission-disclosure` : ''
    return `<details class="approval-disclosure"${id}><summary>${label}</summary>${content}</details>`
  }
  let marked = false
  const text = (/** @type {string} */ value) => renderPermissionText(value, () => { marked = true })
  const fit = compact ? ' data-approval-fit' : ''
  const source = (/** @type {string} */ value) => `<div class="approval-source"${fit}>${text(value)}</div>`
  const meta = (/** @type {string} */ value, fitted = false) => `<div class="approval-meta"${fitted ? fit : ''}>${text(value)}</div>`
  const compactMore = (/** @type {string} */ label) => {
    compact?.()
    return `<button type="button" class="desk-text-button approval-more" data-place-open>${label}</button>`
  }
  const moreLabel = (/** @type {number} */ hidden) => `还有 ${hidden} 行 · ${incomplete ? '展开收到的部分' : '看全部'}`
  const takeLines = (/** @type {number} */ count) => {
    const limit = Math.min(remainingLines, count)
    remainingLines -= limit
    return limit
  }
  const preview = (/** @type {string[]} */ lines, /** @type {number} */ limit, /** @type {(lines:string[])=>string} */ render) => {
    if (compact) {
      const count = takeLines(lines.length)
      const hidden = lines.length - count
      return (count ? render(lines.slice(0, count)) : '') + (hidden ? compactMore(`还有 ${hidden} 行`) : '')
    }
    const hidden = lines.length - limit
    return render(lines.slice(0, limit)) + (hidden > 0 ? disclosure(moreLabel(hidden), render(lines.slice(limit))) : '')
  }
  const sourcePreview = (/** @type {string} */ value) => {
    const lines = permissionLines(value)
    if (compact) {
      if (lines.length > remainingLines) return preview(lines, 4, part => source(part.join('\n')))
      takeLines(lines.length)
      return source(value)
    }
    return lines.length <= 8 ? source(value) : preview(lines, 8, part => source(part.join('\n')))
  }
  const filePath = (/** @type {string} */ value, /** @type {string} */ detail = '') => {
    const label = path(value) + detail
    if (compact && label.includes('\n')) compact()
    return `<div class="approval-path"${fit}>${text(compact ? label.replaceAll('\n', '\\n') : label)}</div>`
  }
  const diff = (/** @type {string[]} */ lines, /** @type {string} */ trailingNote = '') => {
    const render = (/** @type {string[]} */ part) => `<div class="wb-review-diff approval-diff"${fit}>${part.map(line => {
      const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'deleted' : 'context'
      const content = kind === 'deleted' ? '−' + line.slice(1) : line
      return `<div data-line="${kind}">${text(content)}</div>`
    }).join('')}</div>`
    if (compact && trailingNote) {
      return preview([...lines, trailingNote], 12, part => part.length > lines.length
        ? render(part.slice(0, -1)) + meta(trailingNote, true) : render(part))
    }
    return preview(lines, 12, render) + (trailingNote ? meta(trailingNote) : '')
  }
  const fieldList = (/** @type {Field[]} */ fields) => {
    const render = (/** @type {Field[]} */ rows) => `<dl class="approval-fields">${rows.map(({ name, value }) =>
      `<dt${fit}>${text(name)}</dt><dd>${source(value)}</dd>`).join('')}</dl>`
    /** @type {Field[]} */ const shown = []
    /** @type {Field[]} */ const more = []
    let remaining = compact ? remainingLines : 8
    let hidden = 0
    for (const { name, value } of fields) {
      const lines = permissionLines(value)
      const names = compact ? permissionLines(name) : []
      const count = Math.max(1, lines.length, names.length)
      if (remaining > 0) shown.push({
        name: names.length > remaining ? names.slice(0, remaining).join('\n') : name,
        value: lines.length > remaining ? lines.slice(0, remaining).join('\n') : value,
      })
      if (count > remaining) {
        if (!compact) more.push({ name, value: remaining > 0 ? lines.slice(remaining).join('\n') : value })
        hidden += count - remaining
      }
      remaining = Math.max(0, remaining - count)
    }
    if (compact) {
      remainingLines = remaining
      return (shown.length ? render(shown) : '') + (hidden ? compactMore(`还有 ${hidden} 行`) : '')
    }
    return render(shown) + (hidden > 0 ? disclosure(moreLabel(hidden), render(more)) : '')
  }

  let content
  switch (body.kind) {
    case 'command':
      content = `<div class="approval-command"><span>$ </span><div>${sourcePreview(body.command)}</div></div>`
      break
    case 'text':
      content = sourcePreview(body.text)
      break
    case 'edit': {
      const changes = compact ? body.changes.slice(0, 1) : body.changes
      content = filePath(compact ? changes[0]?.path ?? body.path : body.path, body.replaceAll ? '（全部替换）' : '') + changes.map(({ path: changePath, before, after }) => {
        const edit = permissionEditPreview(before, after)
        if (edit.whitespaceChange || edit.finalNewlineChange) compact?.()
        const fragmentNote = incomplete || summaryOnly || edit.fragmentEndsWithNewline === undefined ? ''
          : edit.fragmentEndsWithNewline ? '这一段末尾有换行' : '这一段末尾没有换行'
        return `<div class="approval-change">${!compact && changePath && changePath !== body.path ? filePath(changePath) : ''}${diff([
          ...edit.before.map(line => `- ${line}`),
          ...edit.after.map(line => `+ ${line}`),
        ], fragmentNote)}${edit.finalNewlineChange ? meta(edit.finalNewlineChange === 'removed'
          ? '这一段的末尾少了一个换行。' : '这一段的末尾多了一个换行。') : ''}${edit.whitespaceChange ? meta(PERMISSION_WHITESPACE_NOTICE_ZH) : ''}</div>`
      }).join('')
      if (compact && body.changes.length > 1) content += compactMore(`还有 ${body.changes.length - 1} 处`)
      break
    }
    case 'write':
      content = filePath(body.path) + diff(permissionLines(body.content).map(line => `+ ${line}`))
        + (body.content && !body.content.endsWith('\n') && !display.truncated && !summaryOnly ? meta(PERMISSION_NO_FINAL_NEWLINE_ZH) : '')
      break
    case 'patch': {
      const files = compact ? body.files.slice(0, 1) : body.files
      content = files.map(file => {
        const lines = permissionLines(file.diff)
        const whitespaceChange = compact && patchWhitespaceChange(lines)
        if (whitespaceChange) compact()
        return `<div class="approval-change">${filePath(file.path,
          `（${permissionPatchLabel(file.change, file.movePath === undefined ? undefined : path(file.movePath))}）`)}${diff(lines)}${whitespaceChange ? meta(PERMISSION_WHITESPACE_NOTICE_ZH) : ''}</div>`
      }).join('')
      if (compact && body.files.length > 1) content += compactMore(`共 ${body.files.length} 个文件`)
      break
    }
    case 'url':
      content = compact ? sourcePreview(body.url) : source(body.url)
      break
    case 'query':
      content = compact ? sourcePreview(`“${body.query}”`) : source(`“${body.query}”`)
      break
    case 'fields':
      content = fieldList(body.fields)
      break
  }
  const directory = cwd ? `在 ${cwd}` : projectPath ? `项目目录 ${projectPath}` : ''
  const noteHtml = note ? (compact ? `<div class="approval-meta approval-note" data-approval-fit>${text(note)}</div>` : meta(note)) : ''
  const directoryHtml = directory ? meta(directory, true) : ''
  const promptHtml = body.kind === 'url' && body.prompt ? (compact
    ? preview(permissionLines(body.prompt), 4, lines => meta(lines.join('\n'), true))
    : meta(body.prompt)) : ''
  const extraHtml = extra?.length ? `<div class="approval-extra">${fieldList(extra)}</div>` : ''
  const originalHtml = raw !== undefined ? disclosure('看完整原文', source(raw)) : ''
  const summaryHtml = summary !== undefined ? disclosure('看摘要', (summaryOnly ? '' : meta(SUMMARY_WHITESPACE)) + source(summary)) : ''
  return `<div class="approval-operation${compact ? ' approval-compact' : ''}">
    ${compact ? '' : noteHtml}
    ${summaryOnly ? '<div class="approval-meta approval-summary-label">摘要</div>' : ''}
    <div class="approval-panel" data-kind="${body.kind}">${content}</div>
    ${summaryOnly ? `<div class="approval-meta approval-summary-whitespace">${SUMMARY_WHITESPACE}</div>` : ''}
    ${directoryHtml}${compact && noteHtml ? '\n    ' + noteHtml : ''}
    ${promptHtml}
    ${extraHtml}
    ${incomplete ? meta(compact ? '这里不是全部内容。' : raw === undefined ? '这里不是全部内容，完整的请在终端里看。'
      : '这里不是全部内容，完整的在下面『看完整原文』里。') : ''}
    ${marked ? `<div class="approval-meta approval-invisible-notice">${PERMISSION_INVISIBLE_NOTICE_ZH}</div>` : ''}${showSnapshotNotice ? `
    <div class="approval-meta wb-permission-snapshot">${PERMISSION_SNAPSHOT_NOTICE}</div>` : ''}
    ${originalHtml}
    ${summaryHtml}
  </div>`
}
