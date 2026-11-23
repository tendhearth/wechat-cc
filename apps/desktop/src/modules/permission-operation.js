// @ts-check
import {
  permissionTextSegments, permissionEditPreview as bundledEditPreview, permissionLines as bundledLines, permissionPatchLabel, permissionRelativePath,
  PERMISSION_INVISIBLE_NOTICE_ZH, PERMISSION_NO_FINAL_NEWLINE_ZH, PERMISSION_WHITESPACE_NOTICE_ZH,
} from '../generated/permission-display.js'
import { escapeWorkbenchHtml as escape } from './workbench-markdown.js'

/** @typedef {import('../../../../packages/protocol/src/permission-display').PermissionDisplay} PermissionDisplay */
/** @typedef {{cwd?:string,projectPath?:string,raw?:string,summary?:string,summaryTruncated?:boolean,summaryOnly?:boolean,disclosureId?:string}} OperationOptions */
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

/** @param {PermissionDisplay} display @param {OperationOptions} [options] */
export function renderPermissionOperation(display, { cwd, projectPath = '', raw, summary, summaryTruncated = false, summaryOnly = false, disclosureId } = {}) {
  const incomplete = display.truncated === true || (summaryTruncated && raw === undefined)
  const { body, extra, note } = display
  const path = (/** @type {string} */ value) => permissionRelativePath(value, cwd ?? projectPath)
  let disclosureIndex = 0
  const disclosure = (/** @type {string} */ label, /** @type {string} */ content) => {
    const id = disclosureId ? ` id="${escape(`${disclosureId}-${++disclosureIndex}`)}" data-permission-disclosure` : ''
    return `<details class="approval-disclosure"${id}><summary>${label}</summary>${content}</details>`
  }
  let marked = false
  const text = (/** @type {string} */ value) => renderPermissionText(value, () => { marked = true })
  const source = (/** @type {string} */ value) => `<div class="approval-source">${text(value)}</div>`
  const meta = (/** @type {string} */ value) => `<div class="approval-meta">${text(value)}</div>`
  const moreLabel = (/** @type {number} */ hidden) => `还有 ${hidden} 行 · ${incomplete ? '展开收到的部分' : '看全部'}`
  const preview = (/** @type {string[]} */ lines, /** @type {number} */ limit, /** @type {(lines:string[])=>string} */ render) => {
    const hidden = lines.length - limit
    return render(lines.slice(0, limit)) + (hidden > 0 ? disclosure(moreLabel(hidden), render(lines.slice(limit))) : '')
  }
  const sourcePreview = (/** @type {string} */ value) => {
    const lines = permissionLines(value)
    return lines.length <= 8 ? source(value) : preview(lines, 8, part => source(part.join('\n')))
  }
  const filePath = (/** @type {string} */ value, /** @type {string} */ detail = '') =>
    `<div class="approval-path">${text(path(value) + detail)}</div>`
  const diff = (/** @type {string[]} */ lines) => preview(lines, 12, part => `<div class="wb-review-diff approval-diff">${part.map(line => {
    const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'deleted' : 'context'
    const content = kind === 'deleted' ? '−' + line.slice(1) : line
    return `<div data-line="${kind}">${text(content)}</div>`
  }).join('')}</div>`)
  const fieldList = (/** @type {Field[]} */ fields) => {
    const render = (/** @type {Field[]} */ rows) => `<dl class="approval-fields">${rows.map(({ name, value }) =>
      `<dt>${text(name)}</dt><dd>${source(value)}</dd>`).join('')}</dl>`
    /** @type {Field[]} */ const shown = []
    /** @type {Field[]} */ const more = []
    let remaining = 8
    let hidden = 0
    for (const { name, value } of fields) {
      const lines = permissionLines(value)
      const count = Math.max(1, lines.length)
      if (remaining > 0) shown.push({ name, value: count > remaining ? lines.slice(0, remaining).join('\n') : value })
      if (count > remaining) {
        more.push({ name, value: remaining > 0 ? lines.slice(remaining).join('\n') : value })
        hidden += count - remaining
      }
      remaining = Math.max(0, remaining - count)
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
    case 'edit':
      content = filePath(body.path, body.replaceAll ? '（全部替换）' : '') + body.changes.map(({ path: changePath, before, after }) => {
        const edit = permissionEditPreview(before, after)
        return `<div class="approval-change">${changePath && changePath !== body.path ? filePath(changePath) : ''}${diff([
          ...edit.before.map(line => `- ${line}`),
          ...edit.after.map(line => `+ ${line}`),
        ])}${edit.finalNewlineChange ? meta(edit.finalNewlineChange === 'removed'
          ? '这一段的末尾少了一个换行。' : '这一段的末尾多了一个换行。') : ''}${edit.whitespaceChange ? meta(PERMISSION_WHITESPACE_NOTICE_ZH) : ''}</div>`
      }).join('')
      break
    case 'write':
      content = filePath(body.path) + diff(permissionLines(body.content).map(line => `+ ${line}`))
        + (body.content && !body.content.endsWith('\n') && !display.truncated && !summaryOnly ? meta(PERMISSION_NO_FINAL_NEWLINE_ZH) : '')
      break
    case 'patch':
      content = body.files.map(file => `<div class="approval-change">${filePath(file.path,
        `（${permissionPatchLabel(file.change, file.movePath === undefined ? undefined : path(file.movePath))}）`)}${diff(permissionLines(file.diff))}</div>`).join('')
      break
    case 'url':
      content = source(body.url)
      break
    case 'query':
      content = source(`“${body.query}”`)
      break
    case 'fields':
      content = fieldList(body.fields)
      break
  }
  const directory = cwd ? `在 ${cwd}` : projectPath ? `项目目录 ${projectPath}` : ''
  const noteHtml = note ? meta(note) : ''
  const directoryHtml = directory ? meta(directory) : ''
  const promptHtml = body.kind === 'url' && body.prompt ? meta(body.prompt) : ''
  const extraHtml = extra?.length ? `<div class="approval-extra">${fieldList(extra)}</div>` : ''
  const originalHtml = raw !== undefined ? disclosure('看完整原文', source(raw)) : ''
  const summaryHtml = summary !== undefined ? disclosure('看摘要', (summaryOnly ? '' : meta(SUMMARY_WHITESPACE)) + source(summary)) : ''
  return `<div class="approval-operation">
    ${noteHtml}
    ${summaryOnly ? '<div class="approval-meta approval-summary-label">摘要</div>' : ''}
    <div class="approval-panel" data-kind="${body.kind}">${content}</div>
    ${summaryOnly ? `<div class="approval-meta approval-summary-whitespace">${SUMMARY_WHITESPACE}</div>` : ''}
    ${directoryHtml}
    ${promptHtml}
    ${extraHtml}
    ${incomplete ? meta(raw === undefined ? '这里不是全部内容，完整的请在终端里看。'
      : '这里不是全部内容，完整的在下面『看完整原文』里。') : ''}
    ${marked ? `<div class="approval-meta approval-invisible-notice">${PERMISSION_INVISIBLE_NOTICE_ZH}</div>` : ''}
    ${originalHtml}
    ${summaryHtml}
  </div>`
}
