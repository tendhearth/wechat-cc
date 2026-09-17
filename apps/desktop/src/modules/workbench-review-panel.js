// @ts-check

/** 任务详情里的「改动」面板(spec §4):按回合列出变更快照,逐文件看 diff、接受、打回。
 * 这里是纯函数 —— 不碰 document,diff 的渲染由调用方递进来(复用 workbench-code-review.js),
 * 转义也由调用方递进来(桌面用 escapeWorkbenchHtml)。 */

/** @typedef {import('../../../../src/core/workbench/review').ReviewTurn} ReviewTurn */
/** @typedef {import('../../../../src/core/workbench/review').ReviewTurnFile} ReviewTurnFile */
/** @typedef {{artifactId:string,paths:string[],comment?:string}} ReviewReturnOpen */
/** @typedef {{escapeHtml:(value:unknown)=>string,formatTime:(value:number)=>string,renderDiff:(file:ReviewTurnFile)=>string,returnOpen?:ReviewReturnOpen|null,error?:boolean}} ReviewPanelOptions */

const KIND_LABEL = /** @type {Record<string,string>} */ ({ added: '新增', deleted: '删除', modified: '修改', not_reviewed: '未展开' })
const STATUS_LABEL = /** @type {Record<string,string>} */ ({ complete: '完整', partial: '部分', unavailable: '不可用' })
const MAX_NOTES = 40
const MAX_TEXT = 2000

/** 未展开的文件没有可判断的差异,接受 / 打回都无从谈起(后台也会拒:review_file_unmarkable)。
 * @param {ReviewTurnFile} file */
const markable = file => file.kind !== 'not_reviewed'

/** @param {ReviewTurn[]|null|undefined} reviews @returns {{turns:number,files:number,accepted:number,returned:number}} */
export function reviewSummary(reviews) {
  let files = 0, accepted = 0, returned = 0
  for (const turn of reviews ?? []) for (const file of turn.files ?? []) {
    files++
    if (file.mark?.mark === 'accepted') accepted++
    else if (file.mark?.mark === 'returned') returned++
  }
  return { turns: reviews?.length ?? 0, files, accepted, returned }
}

/** 整页重画的判据之一:快照内容(sha)、每个文件的当前标记与那句意见。
 * 快照按内容寻址,所以 sha 变了就等于这一轮的 diff 变了。
 * @param {ReviewTurn[]|null|undefined} reviews */
export function reviewsSignature(reviews) {
  return JSON.stringify((reviews ?? []).map(turn => [
    turn.sha256 ?? '', turn.status ?? '',
    (turn.files ?? []).map(file => [file.path, file.mark?.mark ?? null, file.mark?.comment ?? '']),
  ]))
}

/** 展开状态要跨重画留住,所以 id 必须稳定又安全:只留快照 sha 的前 8 位十六进制。
 * @param {ReviewTurn} turn @param {number} index */
const turnKey = (turn, index) => (String(turn.sha256 ?? '').match(/[a-f0-9]+/i)?.[0] ?? '').slice(0, 8).toLowerCase() || `t${index}`

/** @param {ReviewTurn} turn @param {number} round @param {number} index @param {ReviewPanelOptions} options */
function renderTurn(turn, round, index, options) {
  const esc = options.escapeHtml
  const key = turnKey(turn, index)
  const cut = (/** @type {string} */ text) => esc(String(text ?? '').slice(0, MAX_TEXT))
  const notes = (turn.notes ?? []).length ? `<ul class="wb-review-notes">${(turn.notes ?? []).slice(0, MAX_NOTES).map(note => `<li>${cut(note)}</li>`).join('')}</ul>` : ''
  const preexisting = (turn.preexistingPaths ?? []).length ? `<p class="wb-review-note">开始时 Git 已有 ${(turn.preexistingPaths ?? []).length} 处修改，不都是这一轮做的。</p>` : ''
  const files = (turn.files ?? []).map((file, fileIndex) => {
    const mark = file.mark?.mark === 'accepted' || file.mark?.mark === 'returned' ? file.mark : null
    const badge = mark ? `<span class="wb-review-badge" data-mark="${mark.mark}">${mark.mark === 'accepted' ? '已接受' : '已打回'}</span>` : ''
    const comment = mark?.comment ? `<p class="wb-review-note">意见：${cut(mark.comment)}</p>` : ''
    const reason = file.reason ? `<p class="wb-review-note">${cut(file.reason)}</p>` : ''
    const actions = markable(file)
      ? `<div class="wb-review-file-actions"><button type="button" class="wb-new" data-action="review-accept" data-artifact-id="${esc(turn.artifactId)}" data-path="${esc(file.path)}">${mark?.mark === 'accepted' ? '已接受' : '接受'}</button><button type="button" class="wb-new" data-action="review-return" data-artifact-id="${esc(turn.artifactId)}" data-path="${esc(file.path)}">打回</button></div>`
      : ''
    return `<div class="wb-review-file-row"><details id="wb-review-${key}-${fileIndex}" class="wb-review-file" data-review-disclosure data-review-file-path="${esc(file.path)}"><summary><span class="wb-review-kind" data-kind="${esc(file.kind)}">${KIND_LABEL[file.kind] ?? esc(file.kind)}</span><span class="wb-review-path">${esc(file.path)}</span>${file.preexisting ? '<small>开始时已有修改</small>' : ''}${badge}</summary>${reason}${options.renderDiff(file)}</details>${comment}${actions}</div>`
  }).join('')
  const open = options.returnOpen && options.returnOpen.artifactId === turn.artifactId ? options.returnOpen : null
  const checked = new Set(open?.paths ?? [])
  const choices = (turn.files ?? []).filter(markable)
  const form = open && choices.length
    ? `<form class="wb-review-return-form" data-action="review-return-submit" data-artifact-id="${esc(turn.artifactId)}"><p>选择要打回的文件，并写一句要怎么改。</p><ul class="wb-review-return-paths">${choices.map(file => `<li><label><input type="checkbox" name="paths" value="${esc(file.path)}"${checked.has(file.path) ? ' checked' : ''}><span>${esc(file.path)}</span></label></li>`).join('')}</ul><label class="wb-sr-only" for="wb-review-comment">修改意见</label><textarea id="wb-review-comment" name="comment" rows="3" maxlength="${MAX_TEXT}" placeholder="说明要怎么改…">${esc(open.comment ?? '')}</textarea><div class="wb-control-actions"><button type="button" class="wb-new" data-action="review-return-cancel">取消</button><button type="submit" class="wb-btn wb-btn-primary">发回</button></div></form>`
    : ''
  const status = STATUS_LABEL[turn.status] ?? esc(String(turn.status ?? ''))
  const empty = files ? '' : '<p class="wb-review-note">这一轮没有列出可展开的文件。</p>'
  return `<section class="wb-review-turn" data-review-turn="${esc(turn.sha256)}"><header><h4>第 ${round} 轮 · ${esc(options.formatTime(turn.createdAt))} · ${status}</h4></header>${notes}${preexisting}${files}${empty}${form}</section>`
}

/** 新的一轮排在最前面(后台按新→旧给)。没有任何一轮、也没出错时不占地方。
 * @param {ReviewTurn[]|null|undefined} reviews @param {ReviewPanelOptions} options */
export function renderReviewPanel(reviews, options) {
  const list = Array.isArray(reviews) ? reviews : []
  if (!list.length && !options.error) return ''
  const counts = reviewSummary(list)
  const unavailable = options.error ? '<p class="wb-review-note" role="status">改动记录暂时读不到，稍后再看。已有的改动不受影响。</p>' : ''
  const turns = list.map((turn, index) => renderTurn(turn, list.length - index, index, options)).join('')
  return `<details id="wb-review" class="wb-disclosure wb-review" data-review-disclosure><summary><span>改动</span><small>${counts.turns} 轮 · ${counts.files} 个文件 · 已接受 ${counts.accepted} · 已打回 ${counts.returned}</small></summary>${unavailable}${turns}</details>`
}
