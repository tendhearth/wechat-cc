// @ts-check
import {
  normalizePermissionLines, permissionEditPreview as bundledEditPreview, permissionLines as bundledLines, permissionPatchLabel, permissionRelativePath,
  PERMISSION_NO_FINAL_NEWLINE_ZH, PERMISSION_WHITESPACE_NOTICE_ZH,
} from '../generated/permission-display.js'
import { escapeWorkbenchHtml as escape } from './workbench-markdown.js'

/** @typedef {import('../../../../packages/protocol/src/permission-display').PermissionDisplay} PermissionDisplay */
/** @typedef {{cwd?:string,projectPath?:string,raw?:string,summary?:string,summaryTruncated?:boolean,disclosureId?:string}} OperationOptions */
/** @typedef {{name:string,value:string}} Field */

/** @type {typeof import('../../../../packages/protocol/src/permission-presentation').permissionLines} */
const permissionLines = bundledLines
/** @type {typeof import('../../../../packages/protocol/src/permission-presentation').permissionEditPreview} */
const permissionEditPreview = bundledEditPreview

/** @param {PermissionDisplay} display @param {OperationOptions} [options] */
export function renderPermissionOperation(display, { cwd, projectPath = '', raw, summary, summaryTruncated = false, disclosureId } = {}) {
  const incomplete = display.truncated === true || (summaryTruncated && raw === undefined)
  const { body, extra, note } = display
  const path = (/** @type {string} */ value) => permissionRelativePath(value, cwd ?? projectPath)
  let disclosureIndex = 0
  const disclosure = (/** @type {string} */ label, /** @type {string} */ content) => {
    const id = disclosureId ? ` id="${escape(`${disclosureId}-${++disclosureIndex}`)}" data-permission-disclosure` : ''
    return `<details class="approval-disclosure"${id}><summary>${label}</summary>${content}</details>`
  }
  const source = (/** @type {string} */ value) => `<div class="approval-source">${escape(value).replace(/\r/g, '&#13;')}</div>`
  const meta = (/** @type {string} */ value) => `<div class="approval-meta">${escape(normalizePermissionLines(value))}</div>`
  const moreLabel = (/** @type {number} */ hidden) => `还有 ${hidden} 行 · ${incomplete ? '展开收到的部分' : '看全部'}`
  const preview = (/** @type {string[]} */ lines, /** @type {number} */ limit, /** @type {(lines:string[])=>string} */ render) => {
    const hidden = lines.length - limit
    return render(lines.slice(0, limit)) + (hidden > 0 ? disclosure(moreLabel(hidden), render(lines.slice(limit))) : '')
  }
  const sourcePreview = (/** @type {string} */ value) => {
    const lines = permissionLines(value)
    return lines.length <= 8 ? source(normalizePermissionLines(value)) : preview(lines, 8, part => source(part.join('\n')))
  }
  const filePath = (/** @type {string} */ value, /** @type {string} */ detail = '') =>
    `<div class="approval-path">${escape(path(value) + detail)}</div>`
  const diff = (/** @type {string[]} */ lines) => preview(lines, 12, part => `<div class="wb-review-diff approval-diff">${part.map(line => {
    const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'deleted' : 'context'
    const content = kind === 'deleted' ? '−' + line.slice(1) : line
    return `<div data-line="${kind}">${escape(content)}</div>`
  }).join('')}</div>`)
  const fieldList = (/** @type {Field[]} */ fields) => {
    const render = (/** @type {Field[]} */ rows) => `<dl class="approval-fields">${rows.map(({ name, value }) =>
      `<dt>${escape(name)}</dt><dd>${source(normalizePermissionLines(value))}</dd>`).join('')}</dl>`
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
          ...(edit.noFinalNewline === 'before' ? [PERMISSION_NO_FINAL_NEWLINE_ZH] : []),
          ...edit.after.map(line => `+ ${line}`),
          ...(edit.noFinalNewline === 'after' ? [PERMISSION_NO_FINAL_NEWLINE_ZH] : []),
        ])}${edit.whitespaceChange ? meta(PERMISSION_WHITESPACE_NOTICE_ZH) : ''}</div>`
      }).join('')
      break
    case 'write':
      content = filePath(body.path) + diff(permissionLines(body.content).map(line => `+ ${line}`))
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
  return `<div class="approval-operation">
    ${note ? meta(note) : ''}
    <div class="approval-panel" data-kind="${body.kind}">${content}</div>
    ${directory ? meta(directory) : ''}
    ${body.kind === 'url' && body.prompt ? meta(body.prompt) : ''}
    ${extra?.length ? `<div class="approval-extra">${fieldList(extra)}</div>` : ''}
    ${incomplete ? meta(raw === undefined ? '这里不是全部内容，完整的请在终端里看。'
      : '这里不是全部内容，完整的在下面『看完整原文』里。') : ''}
    ${raw !== undefined ? disclosure('看完整原文', source(raw)) : ''}
    ${summary !== undefined ? disclosure('看摘要', meta('摘要里的换行和连续空格可能被并掉了。') + source(summary)) : ''}
  </div>`
}
