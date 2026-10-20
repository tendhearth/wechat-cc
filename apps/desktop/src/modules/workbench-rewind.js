// @ts-check

/** 回到某一轮(spec 2026-10-21-workbench-rewind-design「入口 · 桌面」):改动面板里每轮一个按钮 + 预览确认块,
 * 撤销回退,停住时的拍板提示。纯函数 —— 不碰 document,转义由调用方递进来。 */

/** @typedef {{status:string,path:string}} RewindPath */
/** @typedef {{token:string,target:{artifactId:string,to:'start'|'end',round:number},discarded:Array<{artifactId:string,round:number}>,files:{count:number,paths:RewindPath[]},extraChanges:{count:number,paths:RewindPath[]}|null,droppedCommits:{count:number,elsewhere:boolean},rebuildHint:string,refsNote?:string,session:'none'|'will_close',devServer:boolean,goal:{status:string,willStop:boolean}|null}} RewindPreview */
/** @typedef {{artifactId:string,to:'start'|'end',round:number,status:'loading'|'ready'|'error',preview?:RewindPreview,notice?:string,error?:string}} RewindOpen */
/** @typedef {{undo:{rewindId:string,createdAt:number}|null,blocked:{rewindId:string,backupRef:string,reason:string|null}|null}} RewindView */

const MAX_PATHS = 50
const PATH_LABEL = /** @type {Record<string,string>} */ ({ A: '会删掉', D: '会恢复', M: '会改回', T: '会改回', R: '会改回' })
export const REWIND_STALE_NOTICE = '工作区刚变过，请再看一眼。'

const UNAVAILABLE = /** @type {Record<string,string>} */ ({
  worktree_missing: '工作区目录不在了',
  not_isolated: '这件事不在独立工作区里',
  not_linked_worktree: '这件事不在独立工作区里',
  branch_moved: '工作区已经不在这件事自己的分支上',
  git_in_progress: '工作区里有没做完的合并或 rebase，或者留着 .git 锁文件',
  unborn: '分支上还没有任何提交',
  no_checkpoint: '这一轮没有留下回退点',
  checkpoint_missing: '这一轮的回退点找不到了',
  backup_missing: '那次回退的备份找不到了',
  filter_repo: '项目用了 LFS 或必需的 Git 过滤器，不能按轮回退',
  too_large: '工作区太大，打不了备份（上限 200MB）',
  file_too_large: '有单个文件超过 50MB，打不了备份',
  too_many_paths: '工作区文件太多，打不了备份（上限 2 万个路径）',
})
const CODES = /** @type {Record<string,string>} */ ({
  rewind_noop: '这一轮之后没有要撤的改动。',
  workbench_busy: '这个工作区还有会话、脚本或检查占着，先收工再回退。',
  rewind_shared_folder: '还有别的任务在用这个文件夹、而且之后做过改动，不能回退。',
  rewind_merged: '要撤掉的提交已经合回项目了，不能回退。',
  rewind_ignored_conflict: '回退会覆盖被 Git 忽略、但后来改过的文件，先把它挪开再试。',
  review_round_discarded: '这一轮已经撤掉了。',
  rewind_needs_owner: '这件事停住了，先在上面选怎么处理。',
  rewind_undo_stale: '这次回退之后又做过新的一轮，或者已经撤销过，不能再撤销；备份还在。',
  rewind_undo_unavailable: '现在没有可以撤销的回退。',
  rewind_failed: '回退没做成，时间线里写了现在的样子和备份在哪。',
  rewind_not_blocked: '这件事已经不用处理了。',
  workbench_archived: '这项任务已归档，恢复后才能回退。',
  worktree_removed: '工作区已删除，先重新打开工作区。',
  not_worktree: '只有在独立工作区里做的任务才能回退。',
  rewind_confirmation_required: REWIND_STALE_NOTICE,
  rewind_confirmation_stale: REWIND_STALE_NOTICE,
})

/** 后台的错误码(可能带 `:reason`)说成人话;认不出 ⇒ null,交给调用方的通用说法。
 * @param {unknown} error @returns {string|null} */
export function rewindErrorMessage(error) {
  const message = String(error instanceof Error ? error.message : error)
  const unavailable = message.match(/\brewind_unavailable(?::([a-z_]+))?/)
  if (unavailable) return `这一轮现在回不去：${UNAVAILABLE[unavailable[1] ?? ''] ?? 'Git 出错了'}。`
  const code = message.match(/\b(rewind_[a-z_]+|review_round_discarded|workbench_busy|workbench_archived|worktree_removed|not_worktree)\b/)?.[1]
  return code ? CODES[code] ?? null : null
}

/** @param {unknown} error */
export const isRewindStale = error => /\brewind_confirmation_(stale|required)\b/.test(String(error instanceof Error ? error.message : error))

/** 一轮旁边那一个按钮:最新一轮「撤掉这一轮」(to:start),更早的「回到这一轮结束时」(to:end)。没有回退点就不画。
 * @param {{artifactId:string,discarded?:boolean,rewindable?:{start:boolean,end:boolean}}} turn
 * @param {number} round @param {boolean} latest @param {(value:unknown)=>string} esc */
export function rewindButtonHtml(turn, round, latest, esc) {
  if (turn.discarded || !turn.rewindable) return ''
  const to = latest ? 'start' : 'end'
  if (!turn.rewindable[to]) return ''
  return `<button type="button" class="wb-new wb-rewind-open" data-action="rewind-open" data-artifact-id="${esc(turn.artifactId)}" data-to="${to}" data-round="${round}">${latest ? '撤掉这一轮' : '回到这一轮结束时'}</button>`
}

/** @param {RewindPath[]} paths @param {(value:unknown)=>string} esc */
const pathList = (paths, esc) => paths.length ? `<ul class="wb-rewind-paths">${paths.slice(0, MAX_PATHS).map(p => `<li><span class="wb-review-kind">${esc(PATH_LABEL[p.status?.[0] ?? ''] ?? p.status)}</span><span class="wb-review-path">${esc(p.path)}</span></li>`).join('')}</ul>` : ''
/** @param {number[]} ns */
const roundsText = ns => {
  const s = [...ns].sort((a, b) => a - b)
  if (!s.length) return ''
  const run = s.every((n, i) => i === 0 || n === (s[i - 1] ?? 0) + 1)
  return s.length === 1 ? `第 ${s[0]} 轮` : run ? `第 ${s[0]}–${s.at(-1)} 轮` : `第 ${s.join('、')} 轮`
}

/** 预览确认块:会撤掉哪几轮、多少文件、额外改动、重新构建、已合并 / 远端提示、会话怎么处理。
 * @param {RewindOpen} open @param {(value:unknown)=>string} esc @param {boolean} [busy] */
export function renderRewindConfirm(open, esc, busy = false) {
  const title = open.to === 'start' ? `撤掉第 ${open.round} 轮` : `回到第 ${open.round} 轮结束时`
  const cancel = '<button type="button" class="wb-new" data-action="rewind-cancel">算了</button>'
  if (open.status === 'loading') return `<div class="wb-rewind-confirm" data-rewind-confirm><p class="wb-rewind-title">${esc(title)}</p><p class="wb-review-note" role="status">正在核对工作区……</p><div class="wb-control-actions">${cancel}</div></div>`
  if (open.status === 'error' || !open.preview) return `<div class="wb-rewind-confirm" data-rewind-confirm><p class="wb-rewind-title">${esc(title)}</p><p class="wb-interaction-error" role="alert">${esc(open.error ?? '暂时读不到回退预览，请稍后再试。')}</p><div class="wb-control-actions">${cancel}</div></div>`
  const p = open.preview
  const lines = []
  if (open.notice) lines.push(`<p class="wb-review-note" role="status">${esc(open.notice)}</p>`)
  lines.push(`<p>${p.discarded.length ? `会撤掉${esc(roundsText(p.discarded.map(d => d.round)))}。` : '不会撤掉任何一轮，只撤最后一轮之后的改动。'}</p>`)
  lines.push(`<p>${p.files.count ? `${p.files.count} 个文件会变回那一刻的样子${p.files.count > MAX_PATHS ? `（下面列出前 ${MAX_PATHS} 个）` : ''}：` : '文件内容不变。'}</p>${pathList(p.files.paths, esc)}`)
  if (p.extraChanges?.count) lines.push(`<p class="wb-rewind-warn">最后一轮做完之后又有 ${p.extraChanges.count} 处改动（你手改的、检查输出之类），也会一起撤掉；回退前会先整体备份。</p>${pathList(p.extraChanges.paths, esc)}`)
  if (p.droppedCommits.count) lines.push(`<p>分支会退回，撤掉 ${p.droppedCommits.count} 个提交${p.droppedCommits.elsewhere ? '；这些提交在别的分支或远端里还有一份，那边不受影响' : ''}。</p>`)
  lines.push(`<p class="wb-rewind-warn">${esc(p.rebuildHint)}</p>`)
  if (p.devServer) lines.push('<p>开发服务还在跑，回退后可能要重启它。</p>')
  if (p.goal?.willStop) lines.push('<p>「直到检查通过」会停下，要再检查请重新设。</p>')
  lines.push(`<p>${p.session === 'will_close' ? '这件事安静着的会话会先关掉；' : ''}执行者下一轮会被告知工作区回退了。回退可以撤销。</p>`)
  return `<div class="wb-rewind-confirm" data-rewind-confirm><p class="wb-rewind-title">${esc(title)}</p>${lines.join('')}<div class="wb-control-actions">${cancel}<button type="button" class="wb-btn wb-btn-primary" data-action="rewind-confirm"${busy ? ' disabled' : ''}>确认回退</button></div></div>`
}

/** 最近一次回退的「撤销回退」(只撤最近一次,之后又有新的一轮就不给)。
 * @param {RewindView|null|undefined} view @param {(value:unknown)=>string} esc */
export function rewindUndoHtml(view, esc) {
  if (!view?.undo) return ''
  return `<p class="wb-review-note wb-rewind-undo">刚回退过，撤掉的改动都备份着。<button type="button" class="wb-new" data-action="rewind-undo" data-rewind-id="${esc(view.undo.rewindId)}">撤销回退</button></p>`
}

/** 回退停住了(rewind_needs_owner):详情最上面一条提示 + 两个选择;「恢复」要再确认一次。
 * @param {{task:{error:string|null},rewind?:RewindView|null}|null|undefined} detail @param {boolean} confirmRestore
 * @param {(value:unknown)=>string} esc @param {boolean} [busy] */
export function renderRewindBlocked(detail, confirmRestore, esc, busy = false) {
  const blocked = detail?.rewind?.blocked
  if (!blocked && detail?.task.error !== 'rewind_needs_owner') return ''
  const reason = blocked?.reason || '上次回退没做完，CC 没有再动工作区。'
  const off = busy ? ' disabled' : ''
  const choices = confirmRestore
    ? `<p>确认后，CC 先把现在的样子再备份一次，再把工作区和分支恢复到那次回退之前。</p><div class="wb-control-actions"><button type="button" class="wb-new" data-action="rewind-restore-cancel">算了</button><button type="button" class="wb-btn wb-btn-primary" data-action="rewind-restore-confirm"${off}>确认恢复</button></div>`
    : `<div class="wb-rewind-choice"><button type="button" class="wb-new" data-action="rewind-keep"${off}>保留现在的样子</button><small>工作区就按现在磁盘上的样子接着做，有的文件可能停在半路。</small></div><div class="wb-rewind-choice"><button type="button" class="wb-new" data-action="rewind-restore"${off}>恢复到回退之前</button><small>先备份现状，再把工作区和分支恢复成那次回退之前的样子。</small></div>`
  return `<section class="wb-rewind-blocked" data-rewind-blocked aria-label="回退停住了"><p class="wb-rewind-title">这件事停住了，等你决定</p><p>${esc(reason)}</p>${blocked?.backupRef ? `<p class="wb-review-note">回退前的完整状态备份在 <code>${esc(blocked.backupRef)}</code>。</p>` : ''}${choices}</section>`
}
