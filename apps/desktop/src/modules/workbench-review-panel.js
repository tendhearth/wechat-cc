// @ts-check

/** 任务详情里的「改动」面板(spec §4):按回合列出变更快照,逐文件看 diff、接受、打回。
 * 这里是纯函数 —— 不碰 document,diff 的渲染由调用方递进来(复用 workbench-code-review.js),
 * 转义也由调用方递进来(桌面用 escapeWorkbenchHtml)。 */

/** @typedef {import('../../../../src/features/workbench/review').ReviewTurn} ReviewTurn */
/** @typedef {import('../../../../src/features/workbench/review').ReviewTurnFile} ReviewTurnFile */
/** asLesson:「同时记成这个项目的经验」勾没勾(10-20)。
 * @typedef {{artifactId:string,paths:string[],comment?:string,notice?:string,restartToken?:string,asLesson?:boolean}} ReviewReturnOpen */
/** 打回发出去之后那一句(只在顺手记经验时出现):记上了,或者为什么没记上。
 * @typedef {{artifactId:string,text:string}} ReviewReturnResult */
/** @typedef {{open?:import('./workbench-rewind.js').RewindOpen|null,view?:import('./workbench-rewind.js').RewindView|null,busy?:boolean}} ReviewRewindOptions */
/** @typedef {import('../../../../src/features/workbench/review-annotations').ReviewCommentView} ReviewCommentView */
/** @typedef {import('../../../../src/features/workbench/review-annotations').ReviewHunkView} ReviewHunkView */
/** 行评论(2026-10-21):选中的行 / 正在写的那条 / 面板底部的发出栏。都活在 state 里,重画不丢。
 * @typedef {{artifactId:string,path:string,hunk:number,hunkSha256:string,anchor:number,rowStart:number,rowEnd:number}} LineSelect
 * @typedef {{artifactId:string,path:string,hunk:number,hunkSha256?:string,rowStart?:number,rowEnd?:number,commentId:string,body:string,edit?:boolean,notice?:string}} LineCompose
 * @typedef {{summary?:string,notice?:string,result?:string,restartToken?:string}} CommentsSend
 * @typedef {{select?:LineSelect|null,compose?:LineCompose|null,send?:CommentsSend|null}} ReviewLineOptions */
/** @typedef {{escapeHtml:(value:unknown)=>string,formatTime:(value:number)=>string,renderDiff:(file:ReviewTurnFile,lines?:import('./workbench-code-review.js').LineView)=>string,compactSummary?:boolean,returnOpen?:ReviewReturnOpen|null,returnResult?:ReviewReturnResult|null,lesson?:boolean,error?:boolean,budget?:{limited:boolean},rewind?:ReviewRewindOptions,lines?:ReviewLineOptions,track?:{composePlaced:boolean}}} ReviewPanelOptions */

import { renderRewindConfirm, rewindButtonHtml, rewindUndoHtml } from './workbench-rewind.js'
import { splitDiffHunks } from './workbench-code-review.js'

const KIND_LABEL = /** @type {Record<string,string>} */ ({ added: '新增', deleted: '删除', modified: '修改', not_reviewed: '未展开' })
const STATUS_LABEL = /** @type {Record<string,string>} */ ({ complete: '完整', partial: '部分', unavailable: '不可用' })
const MAX_NOTES = 40
const MAX_TEXT = 2000
// 就地展开差异的回合数。再往前的回合照样能接受 / 打回,只是不把 diff 铺进这一页 ——
// 一个跑了十几轮的任务,把每一轮的每个文件都渲出来会把整页压垮。
const INLINE_TURNS = 3
const LESSON_FAIL = /** @type {Record<string,string>} */ ({ no_project: '这件事没有项目，记不了。', too_long: '太长了（最多 200 字）。', full: '这个项目的经验已经满 10 条。', invalid: '经验里不能带尖括号。' })
/** 打回成功后那一句:打回本身总是「已发回」,经验记没记上另说。
 * @param {unknown} lesson 后台回的 {ok:true} | {ok:false,error} */
export function returnLessonText(lesson) {
  const l = /** @type {{ok?:unknown,error?:unknown}|null} */ (lesson && typeof lesson === 'object' ? lesson : null)
  if (l?.ok === true) return '已发回。已记成这个项目的经验。'
  // 一样的已经在了 = 这条经验确实记着(重试时第一次其实已经记上),不当失败说(#458 评审)
  if (l?.error === 'duplicate') return '已发回。这个项目的经验里本来就有这一条。'
  return `已发回。经验没记上：${LESSON_FAIL[String(l?.error ?? '')] ?? '稍后再试一次。'}`
}
const OLDER_TURN = '<p class="wb-review-note">较早的一轮：请在「成果」里打开这份变更记录查看差异。</p>'

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
    // 回退(2026-10-21):撤掉了 / 能不能回退变了也要重画;老后台不带这两个字段 ⇒ 与以前同值
    ...(turn.discarded || turn.rewindable ? [turn.discarded === true, turn.rewindable?.start ?? null, turn.rewindable?.end ?? null] : []),
    // 行评论(2026-10-21):块的撤回小签与评论(id、状态、正文)变了也要重画;不带这两样 ⇒ 与以前同值
    (turn.files ?? []).map(file => [file.path, file.mark?.mark ?? null, file.mark?.comment ?? '',
      ...(file.hunks || file.comments ? [(file.hunks ?? []).map(h => [h.sha256, h.reverted?.at ?? null]), (file.comments ?? []).map(c => [c.id, c.state, c.body, c.sentAt ?? null, c.laterTouched ?? null])] : [])]),
  ]))
}

/** 展开状态要跨重画留住,所以 id 必须稳定又安全:只留快照 sha 的前 8 位十六进制。
 * @param {ReviewTurn} turn @param {number} index */
const turnKey = (turn, index) => (String(turn.sha256 ?? '').match(/[a-f0-9]+/i)?.[0] ?? '').slice(0, 8).toLowerCase() || `t${index}`

/** 评论落在哪几行(服务端从快照算好的行号;删掉的行写「原第 n 行」)。
 * @param {ReviewCommentView} c */
function lineLabel(c) {
  const a = c.lineStart, b = c.lineEnd ?? a
  if (a == null) return `第 ${c.hunk + 1} 块`
  const range = b != null && b !== a ? `${a}–${b}` : `${a}`
  return c.side === 'old' ? `原第 ${range} 行（已删）` : `第 ${range} 行`
}

/** 行下就地的输入框:新写 / 改一条都是它;元数据全在 state.lineCompose 里,表单只带正文。
 * @param {LineCompose} compose @param {(value:unknown)=>string} esc */
function composeForm(compose, esc) {
  const notice = compose.notice ? `<p class="wb-review-note" role="status">${esc(compose.notice)}</p>` : ''
  return `<form class="wb-line-compose" data-action="line-comment-save">${notice}<label class="wb-sr-only" for="wb-line-compose-body">行评论</label><textarea id="wb-line-compose-body" name="body" data-comment-id="${esc(compose.commentId)}" rows="3" maxlength="${MAX_TEXT}" placeholder="这几行要怎么改…">${esc(compose.body ?? '')}</textarea><div class="wb-control-actions"><button type="button" class="wb-new" data-action="line-comment-cancel">取消</button><button type="submit" class="wb-btn wb-btn-primary">存为草稿</button></div></form>`
}

/** 一条已有的评论:草稿可改 / 删;已发出只读,外加「之后改没改过这个文件」(从不说「已解决」)。
 * @param {ReviewCommentView} c @param {{esc:(value:unknown)=>string,formatTime:(value:number)=>string,gone:boolean,compose:LineCompose|null,track?:{composePlaced:boolean}}} ctx */
function renderComment(c, ctx) {
  const { esc, gone, compose } = ctx
  if (!gone && c.state === 'draft' && compose?.edit && compose.commentId === c.id) { if (ctx.track) ctx.track.composePlaced = true; return composeForm(compose, esc) }
  const meta = c.state === 'sent' ? `已发出 · ${esc(ctx.formatTime(c.sentAt ?? 0))}` : gone ? '草稿 · 这一轮已撤掉，草稿不会发出' : '草稿'
  const later = c.state === 'sent' ? `<p class="wb-line-comment-later">${c.laterTouched ? `之后第 ${c.laterTouched} 轮又改过这个文件` : '之后没再动过这个文件'}</p>` : ''
  const actions = c.state === 'draft' && !gone ? `<div class="wb-line-comment-actions"><button type="button" class="wb-new" data-action="line-comment-edit" data-comment-id="${esc(c.id)}">改</button><button type="button" class="wb-new" data-action="line-comment-delete" data-comment-id="${esc(c.id)}">删</button></div>` : ''
  return `<div class="wb-line-comment" data-comment-id="${esc(c.id)}" data-state="${c.state === 'sent' ? 'sent' : 'draft'}"><p class="wb-line-comment-meta"><span>${meta}</span><span>${esc(lineLabel(c))}</span></p><p class="wb-line-comment-body">${esc(String(c.body ?? '').slice(0, MAX_TEXT))}</p>${later}${actions}</div>`
}

/** 一个文件的差异 + 它上面的评论。按块渲染只在:就地展开的轮、有 diff、服务端给了块清单、客户端切得对。
 * 放不进行下的评论(切块对不上、额度用完、较早的一轮)列在差异下面。
 * @param {ReviewTurn} turn @param {ReviewTurnFile} file @param {boolean} inline @param {boolean} gone @param {ReviewPanelOptions} options */
function renderFileDiff(turn, file, inline, gone, options) {
  const esc = options.escapeHtml
  const comments = Array.isArray(file.comments) ? file.comments : []
  const lo = options.lines
  const own = (/** @type {{artifactId:string,path:string}|null|undefined} */ item) => item && item.artifactId === turn.artifactId && item.path === file.path ? item : null
  const select = /** @type {LineSelect|null} */ (gone ? null : own(lo?.select))
  const compose = /** @type {LineCompose|null} */ (gone ? null : own(lo?.compose))
  const ctx = { esc, formatTime: options.formatTime, gone, compose, track: options.track }
  /** @type {Set<string>} */
  const shown = new Set()
  let diff
  if (!inline && file.diff) diff = OLDER_TURN
  else if (lo && file.diff && Array.isArray(file.hunks) && file.hunks.length && splitDiffHunks(file.diff, file.hunks)) {
    const base = ` data-artifact-id="${esc(turn.artifactId)}" data-path="${esc(file.path)}"`
    const canRevert = file.kind === 'modified'
    const newHere = (/** @type {number} */ h, /** @type {number|null} */ r) => !!compose && !compose.edit && compose.hunk === h && (r === null ? compose.rowEnd == null : compose.rowEnd === r)
    diff = options.renderDiff(file, {
      hunks: file.hunks, attrs: base, actions: !gone,
      head: (hunk, complete) => {
        const badge = hunk.reverted ? '<span class="wb-review-badge" data-mark="reverted">已撤回</span>' : ''
        if (gone || !complete) return badge
        const attrs = `${base} data-hunk="${hunk.index}" data-hunk-sha="${esc(hunk.sha256)}"`
        const revert = canRevert ? `<button type="button" class="wb-new" data-action="review-hunk" data-hunk-action="${hunk.reverted ? 'restore' : 'revert'}"${attrs}>${hunk.reverted ? '恢复这一块' : '撤回这一块'}</button>` : ''
        return `${badge}<span class="wb-review-hunk-actions"><button type="button" class="wb-new" data-action="line-comment-hunk"${attrs}>评论这一块</button>${revert}</span>`
      },
      selected: (h, r) => !!select && select.hunk === h && r >= select.rowStart && r <= select.rowEnd,
      after: (h, r) => {
        let out = ''
        for (const c of comments) if (c.hunk === h && (r === null ? c.rowEnd == null : c.rowEnd === r) && !shown.has(c.id)) { shown.add(c.id); out += renderComment(c, ctx) }
        if (newHere(h, r)) { if (options.track) options.track.composePlaced = true; out += composeForm(/** @type {LineCompose} */ (compose), esc) }
        else if (select && r !== null && select.hunk === h && select.rowEnd === r) {
          const n = select.rowEnd - select.rowStart + 1
          out += `<div class="wb-line-select" data-line-select><span>已选 ${n} 行</span><button type="button" class="wb-new" data-action="line-comment-open">评论</button><button type="button" class="wb-new" data-action="line-select-clear">取消</button></div>`
        }
        return out
      },
    })
  } else diff = options.renderDiff(file)
  const rest = comments.filter(c => !shown.has(c.id))
  return diff + (rest.length ? `<div class="wb-line-comments">${rest.map(c => renderComment(c, ctx)).join('')}</div>` : '')
}

/** 面板底部:「N 条评论待发出」+ 可选一句总的意见 + 发出;发完照实说发了几条、留下几条。
 * @param {ReviewTurn[]} list @param {CommentsSend|null|undefined} send @param {(value:unknown)=>string} esc */
function renderSendBar(list, send, esc) {
  let pending = 0, skipped = 0
  for (const turn of list) for (const file of turn.files ?? []) for (const c of file.comments ?? []) if (c.state === 'draft') { if (turn.discarded) skipped++; else pending++ }
  const result = send?.result ? `<p class="wb-review-note" role="status">${esc(send.result)}</p>` : ''
  if (!pending) return result ? `<div class="wb-review-send">${result}</div>` : ''
  const notice = send?.notice ? `<p class="wb-review-note" role="status">${esc(send.notice)}</p>` : ''
  const skippedNote = skipped ? `<p class="wb-review-note">另有 ${skipped} 条草稿在撤掉的轮上，不会发出。</p>` : ''
  return `<form class="wb-review-send" data-action="line-comments-send"><p class="wb-review-send-count">${pending} 条评论待发出</p>${result}${notice}${skippedNote}<label class="wb-sr-only" for="wb-review-send-summary">整体说一句</label><textarea id="wb-review-send-summary" name="summary" rows="2" maxlength="${MAX_TEXT}" placeholder="整体说一句（可不写）">${esc(send?.summary ?? '')}</textarea><div class="wb-control-actions"><button type="submit" class="wb-btn wb-btn-primary">${send?.restartToken ? '带记录重新开始并发回' : '发出评论'}</button></div></form>`
}

/** @param {ReviewTurn} turn @param {number} round @param {number} index @param {ReviewPanelOptions} options @param {boolean} [latest] 最新一轮没撤掉的那一轮 */
export function renderTurn(turn, round, index, options, latest = index === 0) {
  const inline = index < INLINE_TURNS
  // 已撤掉的一轮(回退):灰掉、标「已撤掉」,不再给接受 / 打回 / 撤销(后台也会拒:review_round_discarded)
  const gone = turn.discarded === true
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
    const actions = !gone && markable(file)
      ? `<div class="wb-review-file-actions"><button type="button" class="wb-new" data-action="review-accept" data-artifact-id="${esc(turn.artifactId)}" data-path="${esc(file.path)}">${mark?.mark === 'accepted' ? '已接受' : '接受'}</button><button type="button" class="wb-new" data-action="review-return" data-artifact-id="${esc(turn.artifactId)}" data-path="${esc(file.path)}">打回</button>${file.diff ? `<button type="button" class="wb-new" data-action="review-revert" data-artifact-id="${esc(turn.artifactId)}" data-path="${esc(file.path)}">撤销改动</button>` : ''}</div>`
      : ''
    return `<div class="wb-review-file-row"><details id="wb-review-${key}-${fileIndex}" class="wb-review-file" data-review-disclosure data-review-file-path="${esc(file.path)}"><summary><span class="wb-review-kind" data-kind="${esc(file.kind)}">${KIND_LABEL[file.kind] ?? esc(file.kind)}</span><span class="wb-review-path">${esc(file.path)}</span>${file.preexisting ? '<small>开始时已有修改</small>' : ''}${file.risk?.length ? `<span class="wb-review-risk">注意 · ${esc(file.risk.join('、'))}</span>` : ''}${badge}</summary>${reason}${renderFileDiff(turn, file, inline, gone, options)}</details>${comment}${actions}</div>`
  }).join('')
  const open = options.returnOpen && options.returnOpen.artifactId === turn.artifactId ? options.returnOpen : null
  const checked = new Set(open?.paths ?? [])
  const choices = (turn.files ?? []).filter(markable)
  const form = !gone && open && choices.length
    ? `<form class="wb-review-return-form" data-action="review-return-submit" data-artifact-id="${esc(turn.artifactId)}"><p>选择要打回的文件，并写一句要怎么改。</p>${open.notice ? `<p class="wb-review-note" role="status">${cut(open.notice)}</p>` : ''}<ul class="wb-review-return-paths">${choices.map(file => `<li><label><input type="checkbox" name="paths" value="${esc(file.path)}"${checked.has(file.path) ? ' checked' : ''}><span>${esc(file.path)}</span></label></li>`).join('')}</ul><label class="wb-sr-only" for="wb-review-comment">修改意见</label><textarea id="wb-review-comment" name="comment" rows="3" maxlength="${MAX_TEXT}" placeholder="说明要怎么改…">${esc(open.comment ?? '')}</textarea>${options.lesson ? `<label class="wb-review-return-lesson"><input type="checkbox" name="asLesson"${open.asLesson ? ' checked' : ''}><span>同时记成这个项目的经验</span></label>` : ''}<div class="wb-control-actions"><button type="button" class="wb-new" data-action="review-return-cancel">取消</button><button type="submit" class="wb-btn wb-btn-primary">${open.restartToken ? '带记录重新开始并发回' : '发回'}</button></div></form>`
    : !gone && options.returnResult?.artifactId === turn.artifactId ? `<p class="wb-review-note" role="status" data-review-return-result>${cut(options.returnResult.text)}</p>` : ''
  const status = STATUS_LABEL[turn.status] ?? esc(String(turn.status ?? ''))
  const empty = files ? '' : '<p class="wb-review-note">这一轮没有列出可展开的文件。</p>'
  const rewindOpen = options.rewind?.open && options.rewind.open.artifactId === turn.artifactId ? options.rewind.open : null
  const rewindButton = rewindOpen ? '' : rewindButtonHtml(turn, round, latest, esc)
  const rewind = rewindOpen ? renderRewindConfirm(rewindOpen, esc, !!options.rewind?.busy) : ''
  const discardedBadge = gone ? '<span class="wb-review-badge" data-mark="discarded">已撤掉</span>' : ''
  return `<section class="wb-review-turn${gone ? ' is-discarded' : ''}" data-review-turn="${esc(turn.sha256)}"><header><h4>第 ${round} 轮 · ${esc(options.formatTime(turn.createdAt))} · ${status}</h4>${discardedBadge}${rewindButton}</header>${rewind}${notes}${preexisting}${files}${empty}${form}</section>`
}

/** 新的一轮排在最前面(后台按新→旧给)。没有任何一轮、也没出错时不占地方。
 * @param {ReviewTurn[]|null|undefined} reviews @param {ReviewPanelOptions} options */
export function renderReviewPanel(reviews, options) {
  const list = Array.isArray(reviews) ? reviews : []
  if (!list.length && !options.error) return ''
  const counts = reviewSummary(list)
  const unavailable = options.error ? '<p class="wb-review-note" role="status">改动记录暂时读不到，稍后再看。已有的改动不受影响。</p>' : ''
  // 「最新一轮」= 最新一轮没撤掉的(撤掉的轮之上那一轮给「撤掉这一轮」)
  const latest = list.findIndex(turn => !turn.discarded)
  // 正在写的那条落不到页面上(那段改动退回整段显示 / 额度用完 / 那一轮没了)⇒ 说一句并给「放弃这条」,不然新评论永远开不了
  const track = { composePlaced: false }
  const turns = list.map((turn, index) => renderTurn(turn, list.length - index, index, { ...options, track }, index === latest)).join('')
  const orphan = options.lines?.compose && !track.composePlaced ? '<p class="wb-review-note wb-line-orphan" role="status">有一条没写完的评论（那段改动现在显示不了）<button type="button" class="wb-new" data-action="line-comment-cancel">放弃这条</button></p>' : ''
  const undo = rewindUndoHtml(options.rewind?.view, options.escapeHtml)
  // 额度是渲染时才知道有没有用完的,所以这句只能在所有回合都渲完之后问,而且只说一次。
  const limited = options.budget?.limited ? '<p class="wb-review-limit">预览已限量显示，请在「成果」里打开这份变更记录看完整差异。</p>' : ''
  const send = renderSendBar(list, options.lines?.send, options.escapeHtml)
  const statistics = `${counts.turns} 轮 · ${counts.files} 个文件 · 已接受 ${counts.accepted} · 已打回 ${counts.returned}`
  // 默认调用保留原来的 HTML;紧凑调用只移入统计,不再套一层展开区。读不到时不把零文件当作结论。
  const summary = options.compactSummary ? (counts.files ? `<small>${counts.files} 个文件</small>` : '') : `<small>${statistics}</small>`
  const statisticsBody = options.compactSummary ? `<p class="wb-review-note">${statistics}</p>` : ''
  return `<details id="wb-review" class="wb-disclosure wb-review" data-review-disclosure><summary><span>改动</span>${summary}</summary>${statisticsBody}${unavailable}${undo}${turns}${orphan}${send}${limited}</details>`
}
