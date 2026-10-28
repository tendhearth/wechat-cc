// @ts-check

/** @typedef {import('../../../../src/features/workbench/git-review').GitReview} GitReview */
/** @typedef {import('../../../../src/features/workbench/git-review').ReviewFile} ReviewFile */

export const WORKBENCH_CODE_REVIEW_MIME = 'application/vnd.cc.workbench-review+json'
const MAX_SOURCE_CHARS = 128 * 1024
const MAX_JSON_CHARS = 8 * 1024 * 1024
const MAX_FILES = 200
const MAX_DIFF_CHARS = 256 * 1024
const MAX_LINES = 4000

/** @param {string} value */
const escape = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value @returns {value is string[]} */
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string')
/** @param {unknown} value */
const timestamp = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
/** @param {unknown} value */
const optionalString = value => value === undefined || typeof value === 'string'
/** @param {unknown} value @returns {value is ReviewFile} */
function reviewFile(value) {
  return object(value) && typeof value.path === 'string' && !!value.path && typeof value.preexisting === 'boolean'
    && typeof value.kind === 'string' && ['added', 'deleted', 'modified', 'not_reviewed'].includes(value.kind)
    && optionalString(value.diff) && optionalString(value.reason)
    && [value.beforeSha256, value.afterSha256].every(hash => hash === undefined || typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
}
/** @param {unknown} value @returns {value is GitReview} */
function review(value) {
  return object(value) && value.version === 1 && value.scope === 'working-tree-before-after'
    && timestamp(value.startedAt) && timestamp(value.finishedAt) && Number(value.finishedAt) >= Number(value.startedAt)
    && [value.headBefore, value.headAfter].every(head => head === null || typeof head === 'string')
    && typeof value.status === 'string' && ['complete', 'partial', 'unavailable'].includes(value.status)
    && strings(value.notes) && strings(value.preexistingPaths) && Array.isArray(value.files) && value.files.every(reviewFile)
}

/** @param {string} source */
function sourceDisclosure(source) {
  return `<details id="wb-artifact-source" class="wb-disclosure wb-review-source"><summary>原始 JSON</summary>${source.length > MAX_SOURCE_CHARS ? '<p>原文预览已截断，请下载完整记录。</p>' : ''}<pre>${escape(source.slice(0, MAX_SOURCE_CHARS))}</pre></details>`
}
/** @param {string} message @param {string} source */
function fallback(message, source) {
  return `<section class="wb-code-review"><p class="wb-review-status" data-status="unavailable">暂时无法解读这份文件对比</p><p>${message} 可查看原始 JSON 或下载完整记录。</p></section>${sourceDisclosure(source)}`
}

/** @typedef {{charsLeft:number,linesLeft:number,limited:boolean}} DiffBudget */

/** 一份新的预览额度。整份快照(或整块「改动」面板)共用一份,谁先渲染谁先用,
 * 用光了后面的文件就只剩一句照实的说明 —— 预览永远不假装自己是完整的。
 * @returns {DiffBudget} */
export function createReviewDiffBudget() { return { charsLeft: MAX_DIFF_CHARS, linesLeft: MAX_LINES, limited: false } }

/** 按块渲染时调用方(改动面板)递进来的东西。没有它 ⇒ 照旧整段 `<pre>`。
 * @typedef {import('../../../../src/features/workbench/review-annotations').ReviewHunkView} ReviewHunkView
 * @typedef {{hunks:ReviewHunkView[],attrs:string,actions:boolean,head:(hunk:ReviewHunkView,complete:boolean)=>string,selected?:(hunk:number,row:number)=>boolean,after?:(hunk:number,row:number|null)=>string}} LineView */

/** @param {string} line */
const lineKind = line => line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'deleted' : 'context'

/** 一行进预览:扣额度,回这一行的 html 正文;额度用完 ⇒ null。
 * @param {string} line @param {DiffBudget} limits @param {(value:string)=>string} escapeHtml */
function takeLine(line, limits, escapeHtml) {
  if (limits.charsLeft <= 0 || limits.linesLeft <= 0) return null
  const shown = Math.min(line.length, limits.charsLeft, 4000)
  const truncated = shown < line.length
  if (truncated) limits.limited = true
  limits.charsLeft -= shown + 1
  limits.linesLeft--
  return `${escapeHtml(line.slice(0, shown))}${truncated ? '…' : ''}`
}

/** 客户端照服务端的切法(`^(?=@@ )`)切块,再和块清单对:块数、块头、块体行数(不算 `\ No newline`)。
 * 对不上 ⇒ null,调用方退回整段显示、不给动作。
 * @param {string|undefined} diff @param {ReviewHunkView[]|undefined} hunks @returns {Array<{header:string,lines:string[]}>|null} */
export function splitDiffHunks(diff, hunks) {
  if (!diff || !Array.isArray(hunks) || !hunks.length) return null
  const parts = diff.split(/^(?=@@ )/m)
  if (parts[0] !== '' && !parts[0]?.startsWith('@@ ')) return null
  const raw = parts.filter(part => part.startsWith('@@ '))
  if (raw.length !== hunks.length) return null
  const out = []
  for (const [index, part] of raw.entries()) {
    const lines = part.split('\n')
    if (lines.at(-1) === '') lines.pop()
    const header = lines.shift() ?? ''
    const view = hunks[index]
    if (!view || view.index !== index || view.header !== header || lines.filter(line => !line.startsWith('\\')).length !== view.rows) return null
    out.push({ header, lines })
  }
  return out
}

/** 按块渲染:每块一个块头 + 若干段 `<pre>`,行下的评论 / 输入框插在两段之间。
 * 额度在块中间用完 ⇒ 那一块只读(不给 data-row、块头不给按钮),后面的块不再渲。
 * @param {Array<{header:string,lines:string[]}>} split @param {LineView} view @param {(value:string)=>string} escapeHtml @param {DiffBudget} limits */
function renderHunks(split, view, escapeHtml, limits) {
  const blocks = []
  for (const [index, part] of split.entries()) {
    const hunk = view.hunks[index]
    const header = hunk ? takeLine(part.header, limits, escapeHtml) : null
    if (!hunk || header === null) { limits.limited = true; break }
    /** @type {Array<{kind:string,html:string,row:number|null}>} */
    const rows = []
    let row = 0, complete = true
    for (const line of part.lines) {
      const html = takeLine(line, limits, escapeHtml)
      if (html === null) { complete = false; limits.limited = true; break }
      const marker = line.startsWith('\\')
      rows.push({ kind: marker ? 'context' : lineKind(line), html, row: marker ? null : row })
      if (!marker) row++
    }
    const live = complete && view.actions
    const segments = []
    let open = []
    for (const item of rows) {
      const selected = live && item.row !== null && !!view.selected?.(index, item.row)
      open.push(`<span data-line="${item.kind}"${live && item.row !== null ? ` data-hunk="${index}" data-row="${item.row}"` : ''}${selected ? ' class="is-selected"' : ''}>${item.html}</span>`)
      const extra = complete && item.row !== null ? view.after?.(index, item.row) ?? '' : ''
      if (extra) { segments.push(`<pre class="wb-review-diff"><code>${open.join('')}</code></pre>`, extra); open = [] }
    }
    if (open.length) segments.push(`<pre class="wb-review-diff"><code>${open.join('')}</code></pre>`)
    if (complete) segments.push(view.after?.(index, null) ?? '')
    blocks.push(`<div class="wb-review-hunk" data-review-hunk="${index}"${hunk.reverted ? ' data-reverted' : ''}><div class="wb-review-hunk-head"><code>${header}</code>${view.head(hunk, complete)}</div>${segments.join('')}</div>`)
    if (!complete) break
  }
  return blocks.length ? `<div class="wb-review-hunks" data-review-lines${view.attrs} aria-label="文件差异">${blocks.join('')}</div>` : '<p class="wb-review-note">此文件的差异未在预览中展开，请下载完整记录。</p>'
}

/** 一个文件的差异正文:整份快照共用一份预览额度(`budget`),单独渲染一个文件时自己开一份。
 * 输出只有 `<pre class="wb-review-diff">` 或一句照实的说明 —— diff 内容永远只当文本。
 * 给了 `lines` 且客户端切块与服务端块清单对得上 ⇒ 按块渲染(改动面板的行评论 / 按块撤回);否则照旧。
 * @param {ReviewFile} file @param {(value:string)=>string} [escapeHtml] @param {DiffBudget} [budget] @param {LineView} [lines] */
export function renderReviewFileDiff(file, escapeHtml = escape, budget, lines) {
  const limits = budget ?? { charsLeft: MAX_DIFF_CHARS, linesLeft: MAX_LINES, limited: false }
  const diff = file.diff
  if (!diff) return file.reason ? '' : '<p class="wb-review-note">这项记录没有可展开的文本差异。</p>'
  const split = lines ? splitDiffHunks(diff, lines.hunks) : null
  if (split && lines) return renderHunks(split, lines, escapeHtml, limits)
  const rows = []
  let offset = 0
  while (offset < diff.length && limits.charsLeft > 0 && limits.linesLeft > 0) {
    const newline = diff.indexOf('\n', offset)
    const end = newline < 0 ? diff.length : newline
    const length = end - offset
    const shown = Math.min(length, limits.charsLeft, 4000)
    const line = diff.slice(offset, offset + shown)
    const kind = lineKind(line)
    const truncated = shown < length
    if (truncated) limits.limited = true
    rows.push(`<span data-line="${kind}">${escapeHtml(line)}${truncated ? '…' : ''}</span>`)
    limits.charsLeft -= shown + 1
    limits.linesLeft--
    offset = newline < 0 ? diff.length : newline + 1
  }
  if (offset < diff.length) limits.limited = true
  return rows.length ? `<pre class="wb-review-diff" aria-label="文件差异"><code>${rows.join('')}</code></pre>` : '<p class="wb-review-note">此文件的差异未在预览中展开，请下载完整记录。</p>'
}

/** Render immutable custom-MIME report text only; never turn diff content into executable markup.
 * @param {string} source */
export function renderWorkbenchCodeReview(source) {
  if (source.length > MAX_JSON_CHARS) return fallback('内容超过预览大小限制。', source)
  /** @type {unknown} */
  let value
  try { value = JSON.parse(source) } catch { return fallback('文件格式无法读取。', source) }
  if (!review(value)) return fallback('记录格式不完整，或来自暂不支持的版本。', source)
  const report = value
  const budget = createReviewDiffBudget()
  budget.limited = report.files.length > MAX_FILES || report.notes.length > 40 || report.preexistingPaths.length > MAX_FILES
  /** @param {string} text @param {number} [limit] */
  const label = (text, limit = 1000) => {
    if (text.length > limit) budget.limited = true
    return escape(text.slice(0, limit)) + (text.length > limit ? '…' : '')
  }
  const files = report.files.slice(0, MAX_FILES).map((file, index) => {
    const kind = { added: '新增', deleted: '删除', modified: '修改', not_reviewed: '未展开' }[file.kind]
    return `<details id="wb-review-file-${index}" class="wb-review-file" data-review-disclosure data-review-file="${index}"${index === 0 ? ' open' : ''}><summary><span class="wb-review-kind" data-kind="${file.kind}">${kind}</span><span class="wb-review-path">${label(file.path)}</span>${file.preexisting ? '<small>开始时已有修改</small>' : ''}</summary>${file.reason ? `<p class="wb-review-note">${label(file.reason, 2000)}</p>` : ''}${renderReviewFileDiff(file, escape, budget)}</details>`
  }).join('')
  const notes = report.notes.length ? `<ul class="wb-review-notes">${report.notes.slice(0, 40).map(note => `<li>${label(note, 2000)}</li>`).join('')}</ul>` : ''
  const preexisting = report.preexistingPaths.length ? `<details id="wb-review-preexisting" class="wb-disclosure" data-review-disclosure><summary>初始 Git 状态中的修改 <small>${report.preexistingPaths.length} 项</small></summary><p class="wb-review-note">这是开始时 Git 报告的状态，不等于本轮新增的修改。</p><ul class="wb-review-paths">${report.preexistingPaths.slice(0, MAX_FILES).map(path => `<li>${label(path)}</li>`).join('')}</ul></details>` : ''
  const formatTime = (/** @type {number} */ date) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date))
  const provenance = `<details id="wb-review-provenance" class="wb-disclosure" data-review-disclosure><summary>时间与版本信息</summary><dl><dt>开始</dt><dd>${escape(formatTime(report.startedAt))}</dd><dt>结束记录</dt><dd>${escape(formatTime(report.finishedAt))}</dd><dt>开始时 HEAD</dt><dd>${report.headBefore ? label(report.headBefore) : '未记录'}</dd><dt>结束时 HEAD</dt><dd>${report.headAfter ? label(report.headAfter) : '未记录'}</dd></dl></details>`
  const status = { complete: '对比记录可用', partial: '部分文件未能比较', unavailable: '无法完成对比' }[report.status]
  const empty = report.status === 'unavailable' ? '结束时的记录不完整，不能据此判断有没有修改。' : '已检查范围内暂无可展示差异。'
  const skipped = report.files.filter(file => file.kind === 'not_reviewed').length
  return `<section class="wb-code-review"><header><h3>本轮开始与结束时的文件对比</h3><p class="wb-review-status" data-status="${report.status}">${status}${report.files.length ? ` · 报告列出 ${report.files.length} 个文件${skipped ? `，${skipped} 个未展开` : ''}` : ''}</p></header><p class="wb-review-note">外部程序在此期间的修改也会包含，不能据此认定修改来自哪一方。</p>${notes}${report.status === 'unavailable' && files ? `<p class="wb-review-note">${empty}</p>` : ''}${budget.limited ? '<p class="wb-review-limit">预览已限量显示，请下载完整记录。报告中的检查范围与预览显示范围可能不同。</p>' : ''}${files || `<p class="wb-review-note">${empty}</p>`}${preexisting}${provenance}</section>${sourceDisclosure(source)}`
}
