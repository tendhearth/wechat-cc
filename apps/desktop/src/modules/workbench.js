// @ts-check

import {workbenchRuntimePresentation} from './workbench-runtime.js'
import {icon} from './icons.js'
/** @typedef {import('./workbench-runtime.js').RuntimeSnapshot} RuntimeSnapshot */

import {createExecutionCatalogs,createContinuationPreviews,continuationPreviewKey,executionSignature,executionErrorMessage,renderExecutionControls,renderExecutionObservation} from './workbench-execution.js'
/** @typedef {import('./workbench-execution.js').ExecutionChoice} ExecutionChoice */
import {createWorkbenchThumbnails} from './workbench-thumbnails.js'
import {createWorkbenchAttachments,attachmentSignature,renderAttachmentComposer,renderMessageAttachments,renderImageArtifacts} from './workbench-attachments.js'
import { createWorkbenchDraftStore, loadWorkbenchView, saveWorkbenchView, workbenchWindowStorage } from './workbench-window-state.js'
import {readSiteArchive,SITE_ARTIFACT_MIME} from './site-preview.js'
import { isHtmlArtifact, artifactDisplayName, readWebPreview, renderArtifactFrame, renderArtifactPanel, paintWorkbenchWithPreview } from './workbench-artifact-preview.js'
import { renderPdfReader, mountPdfReader } from './pdf-reader.js'
export { createWorkbenchDraftStore } from './workbench-window-state.js'

import { mountHandoffDialog, mountHandoffRecord, defaultReviewArtifacts } from './workbench-handoff.js'
import {createQuotaHandoffAttempts,mountQuotaHandoffDialog,renderQuotaHandoff} from './workbench-quota-handoff.js'
import { mountHistoryDialog } from './workbench-history.js'
import { isAckRequiredError, isUnattendedProvider, mountUnattendedDialog, unattendedLabelSuffix } from './workbench-unattended.js'
import { isScriptApprovalRequired, mountScriptsApproveDialog, scriptErrorMessage, worktreeScriptsHtml } from './workbench-scripts-approve.js'
import { escapeWorkbenchHtml, renderWorkbenchMarkdown, renderWorkbenchUserText, renderReadingFile } from './workbench-markdown.js'
export { escapeWorkbenchHtml, renderWorkbenchMarkdown } from './workbench-markdown.js'
import { WORKBENCH_CODE_REVIEW_MIME, createReviewDiffBudget, renderReviewFileDiff, renderWorkbenchCodeReview } from './workbench-code-review.js'
import { renderReviewPanel, returnLessonText, reviewsSignature } from './workbench-review-panel.js'
import { REWIND_STALE_NOTICE, isRewindStale, renderRewindBlocked, rewindErrorMessage } from './workbench-rewind.js'
/** @typedef {import('../../../../src/features/workbench/review').ReviewTurn} ReviewTurn */
import { createWorkbenchInteractions, captureWorkbenchQuestionDrafts, syncWorkbenchQuestionChoice, renderWorkbenchQuestions, renderWorkbenchInputs } from './workbench-interaction.js'
import { renderWorkbenchTimeline, workbenchTimelineEventId, renderWorkbenchOperation, captureWorkbenchTimelineAnchor, restoreWorkbenchTimelineAnchor } from './workbench-timeline.js'
import { mergeEvents, structuralSignature, patchLiveTimeline, createLongPoll, clearLiveTimelinePatches, hasLiveTimelineInteraction } from './workbench-live.js'
import {permissionControlId,capturePermissionFocus,restorePermissionFocus} from './workbench-permission-focus.js'
import {captureTimelineReading,restoreTimelineReading} from './workbench-reading-dom.js'
import { saveFile } from './save-file.js'
import { armConfirm, showToast } from '../view.js'
import { createAgentAvatars } from '../shared/agent-avatars.js'
import { V1, v1, v1Request } from '../daemon-client.js'

/**
 * 「没确认退出」的下一步(2026-10-06):进程组还在 ⇒ 说清要先结束它(结束后会自动解除);
 * 没有相反证据(旧记录 / 执行者没交出进程组)⇒ 给「我确认它已经结束」。
 * @param {{error:string|null,writerExit?:'alive'|'unconfirmed'}} task
 */
function writerExitHtml(task) {
  if (task.error !== 'writer_not_closed') return ''
  if (task.writerExit === 'alive') return '<p class="wb-error-note">执行程序还在运行。结束它之后，这条占用会自动解除。</p>'
  return '<button type="button" class="wb-new" data-action="confirm-writer-exited">我确认它已经结束</button>'
}
/** @typedef {{taskId:string,title:string,reason:'same_path'|'nested_path'|'writer_not_closed',holderWriting?:boolean,closeInMs?:number|null}} WaitingFor */
/**
 * 做到条件成立为止(对标 #9,v80):一行「直到 `命令` 通过 · 第 n/m 轮 · 状态」;没设就不画。命令原文整条显示。
 * @param {{until?:{command:string,maxRounds:number,rounds:number,status:'active'|'passed'|'exhausted'|'stopped',lastExit:number|null,stopReason:string|null}}} task
 */
export function untilHtml(task) {
  const u = task.until
  if (!u) return ''
  const state = u.status === 'passed' ? '通过了' : u.status === 'exhausted' ? '到上限还没过，停了' : u.status === 'stopped' ? `停了${u.stopReason ? `：${u.stopReason}` : ''}` : u.rounds === 0 ? '这一轮做完就检查' : u.lastExit === 0 ? '通过了' : '上次没过，在接着改'
  return `<p class="wb-worktree wb-until">直到 <code>${escapeWorkbenchHtml(u.command)}</code> 通过 · 第 ${u.rounds}/${u.maxRounds} 轮 · ${escapeWorkbenchHtml(state)}</p>`
}
/**
 * 独立工作区那一行(2026-10-07):分支名 + 「提交到分支」「合回项目」(10-08,只快进;别的情况留给主人,时间线里有合并命令)「删除工作区」。
 * 「也交给 X 做一份」(10-08,对标 Conductor / Orca 的多执行者并行):同一个要求在另一个独立工作区里交给另一位执行者,做完挑好的那份合回。
 * 工作区脚本(10-20):tendhearth.json 配了脚本才多一行状态 + 一个「运行 / 停下」(见 workbench-scripts-approve.js)。
 * @param {{providerId:string,worktree?:{branch:string,projectPath:string,removed:boolean,merged?:boolean,port?:number,scripts?:import('./workbench-scripts-approve.js').ScriptsView}}} task @param {Provider[]} [providers]
 */
function worktreeHtml(task, providers = []) {
  const wt = task.worktree
  if (!wt) return ''
  if (wt.removed) return `<p class="wb-worktree">在分支 <code>${escapeWorkbenchHtml(wt.branch)}</code> 上做过，工作区已删除（分支还在项目里）。<button type="button" class="wb-new" data-action="worktree-reopen">重新打开工作区</button></p>`
  const status = wt.merged ? '，已合回项目' : '，不影响项目目录本身'
  return `<p class="wb-worktree">在独立分支 <code>${escapeWorkbenchHtml(wt.branch)}</code> 上做${status}。<button type="button" class="wb-new" data-action="worktree-commit">提交到分支</button><button type="button" class="wb-new" data-action="worktree-merge" title="只做快进合并；项目有没提交的改动或已经往前走时不动">合回项目</button><button type="button" class="wb-new" data-action="worktree-remove">删除工作区</button></p>${forkHtml(task, providers)}`
}
/** @param {{providerId:string}} task @param {Provider[]} providers */
function forkHtml(task, providers) {
  const others = providers.filter(p => p.id !== task.providerId)
  if (!others.length) return ''
  return `<p class="wb-worktree wb-fork"><label>同样的要求也交给 <select id="wb-fork-provider" aria-label="另一位执行者">${others.map(p => `<option value="${escapeWorkbenchHtml(p.id)}">${escapeWorkbenchHtml(p.displayName)}</option>`).join('')}</select></label><button type="button" class="wb-new" data-action="worktree-fork">另做一份</button><small>在另一个独立工作区里做，做完挑好的那份合回项目。</small></p>`
}
/** @typedef {{id:string,title:string,path:string,workspaceKind?:'managed'|'project',providerId:string,agents?:string[],origin?:string,status:string,createdAt:number,updatedAt:number,error:string|null,writerExit?:'alive'|'unconfirmed',worktree?:{branch:string,projectPath:string,removed:boolean,merged?:boolean,port?:number,scripts?:import('./workbench-scripts-approve.js').ScriptsView},phase?:string,archivedAt?:number|null,canArchive?:boolean,pendingPermissionCount?:number,pendingQuestionCount?:number,waitingFor?:WaitingFor|null,importedOnly?:boolean,runtime?:RuntimeSnapshot,networkSuspended?:{since:number}|null,until?:{command:string,maxRounds:number,rounds:number,status:'active'|'passed'|'exhausted'|'stopped',lastExit:number|null,stopReason:string|null}}} Task */
/** @typedef {{id:string,type:'command'|'read'|'edit'|'search'|'tool'|'agent',status:'running'|'completed'|'failed'|'cancelled'|'interrupted',label:string,detail?:string,output?:string,parentId?:string,agentIds?:string[]}} WorkbenchActivity */
/** @typedef {{id:string,taskId:string,kind:'user'|'text'|'tool_call'|'system'|'error',text:string,createdAt:number,attachments?:import('./workbench-attachments.js').Attachment[],sourceId?:string|null,runId?:string,activity?:WorkbenchActivity,errorCode?:'execution_model_unsupported',diagnostic?:string}} WorkbenchEvent */
/** @typedef {{id:string,taskId:string,name:string,mime:string,size:number,sha256:string,createdAt:number,approvedAt:number|null}} Artifact */
/** @typedef {{id:string,taskId:string,tool:string,description:string,createdAt:number}} Permission */
/** @typedef {{id:string,displayName:string,capabilities?:{attachments?:boolean,execution?:boolean,resume?:boolean,permissions?:string},quota?:{kind:'quota'|'rate_limit',resetAt?:number}|null,usage?:{windows:Array<{name:string,usedPercent:number}>}|null,refusal?:{code:string,since:string}|null}} Provider */
/** 执行者名 + 额度状态:用完 / 限流一眼看得出来;订阅执行者带上真实窗口(5h / 周)—— 那不是估算,是厂商自己回的。 @param {Provider} p */
function providerLabel(p) {
  // 免审记号跟在最后:额度 / 限流是一时的,免审是这位执行者的性子。
  const unattended = unattendedLabelSuffix(p)
  // 被拒着比额度更要紧:重发没用,换出口地区或换一位(daemon/provider-refusals,最近一次真跑成功才清)。
  // 只认得 region_unavailable;以后 provider-refusals 加别的常驻码,这里不认就照常显示名字 —— 加码时在这里补一句。
  if (p.refusal?.code === 'region_unavailable') return `${p.displayName}（你现在的出口地区用不了）${unattended}`
  if (p.quota?.kind === 'quota') return `${p.displayName}（额度已用完）${unattended}`
  if (p.quota?.kind === 'rate_limit') return `${p.displayName}（限流中）${unattended}`
  const windows = (p.usage?.windows ?? []).map(w => `${w.name === 'weekly' ? '周' : w.name} ${Math.round(w.usedPercent)}%`)
  return `${windows.length ? `${p.displayName} · ${windows.join(' · ')}` : p.displayName}${unattended}`
}
/** @typedef {{token:string,context:string,eventCount:number,includedEventCount:number,truncated:boolean}} RestartPreview */
/** @typedef {{mode:string,restart?:RestartPreview}} Continuation */
/** @typedef {import('../../../../src/adapters/workbench/native-adoption').NativeSource} NativeSource */
/** @typedef {import('../../../../src/adapters/workbench/native-adoption').NativeResumeDecision} NativeResume */
/** @typedef {import('../../../../src/features/workbench/handoff').HandoffView} Handoff */
/** @typedef {{agentNames?:Record<string,string>,quotaHandoff?:import('./workbench-quota-handoff.js').Offer|null,execution?:ExecutionChoice,lastExecution?:import('./workbench-execution.js').RunExecution|null,attachments?:import('./workbench-attachments.js').Attachment[],handoffs?:Handoff[],requiresExternalClose?:boolean,source?:NativeSource,task:Task,events:WorkbenchEvent[],artifacts:Artifact[],permissions?:Permission[],continuation?:Continuation,runId?:string,inputMode?:'steer'|'send'|'queue',runtime?:RuntimeSnapshot,questions?:import('./workbench-interaction.js').QuestionRequest[],inputs?:import('./workbench-interaction.js').LiveInput[],version?:number,rewind?:import('./workbench-rewind.js').RewindView}} Detail */
/** @typedef {{q:string,archived:'exclude'|'only'|'all'}} TaskQuery */
/** @typedef {{limit:number,total:number,hasMore:boolean,nextCursor:string|null}} TaskPage */
/** @typedef {{tasks:Task[],providers:Provider[],defaultProvider:string|null,canWechat:boolean,historyProviders?:string[],agentNames?:Record<string,string>,page?:TaskPage,projects?:Array<{id:string,name:string,path:string,providerId:string}>,projectProviders?:Record<string,string>}} ListResult */
/** @typedef {import('./workbench-artifact-preview.js').ArtifactPreview|null} Preview */
/** @typedef {{artifactId:string,paths:string[],comment?:string,notice?:string,restartToken?:string,asLesson?:boolean}} ReviewReturnOpen */
/** @typedef {{tasks:Task[],providers:Provider[],defaultProvider:string|null,canWechat:boolean,nativeResume?:NativeResume|null,historyProviders?:string[],agentNames?:Record<string,string>,selectedId:string|null,loadingId?:string|null,detail:Detail|null,selectedArtifactId:string|null,error:string,detailDisconnected?:boolean,preview:Preview,previewOpen?:boolean,query?:TaskQuery,page?:TaskPage,projects?:Array<{id:string,name:string,path:string,providerId:string}>,projectProviders?:Record<string,string>,loadingMore?:boolean,newScope?:string,version?:number,reviews?:ReviewTurn[],reviewsLoaded?:boolean,reviewsSignature?:string,reviewsError?:boolean,reviewReturnOpen?:ReviewReturnOpen|null,reviewReturnResult?:import('./workbench-review-panel.js').ReviewReturnResult|null,rewindOpen?:import('./workbench-rewind.js').RewindOpen|null,rewindRestoreConfirm?:boolean,lineSelect?:import('./workbench-review-panel.js').LineSelect|null,lineCompose?:import('./workbench-review-panel.js').LineCompose|null,commentsSend?:import('./workbench-review-panel.js').CommentsSend|null}} WorkbenchState */
/** @typedef {import('./workbench-window-state.js').Draft} Draft */
/** @typedef {{invokeWorkbenchApi:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>,invoke?:(command:string,args:Record<string,unknown>)=>Promise<unknown>,pollMs?:number,confirmUnattended?:()=>Promise<boolean>,confirmScripts?:(config:import('./workbench-scripts-approve.js').ScriptsConfig)=>Promise<boolean>,onDelegate?:(draft:import('./task-entry.js').Draft)=>Promise<import('./task-entry.js').EntryResult|null>}} WorkbenchDeps */
/** @typedef {{path:string,text:string,providerId?:string}} IncomingDraft */

// 一件事都没改过的任务:签名从一开始就是「空」,免得第一次拉回来白重画一整页。
const EMPTY_REVIEWS = reviewsSignature([])
// 行评论 / 按块撤回(2026-10-21):一次至多选 40 行(同服务端 MAX_COMMENT_ROWS);拒绝码 ⇒ 人话
const LINE_MAX_ROWS = 40
/** 发完照实说:发了几条、几条太长留在草稿、几条在撤掉的轮上没发。
 * @param {{sent?:number,remaining?:number,skippedDiscarded?:number}} counts */
export function sentResultText(counts) {
  const parts = [`已发出 ${Number(counts.sent) || 0} 条评论。`]
  if (Number(counts.remaining) > 0) parts.push(`还有 ${counts.remaining} 条装不下，留在草稿里，下次再发。`)
  if (Number(counts.skippedDiscarded) > 0) parts.push(`撤掉的轮上有 ${counts.skippedDiscarded} 条草稿，没有发出。`)
  return parts.join('')
}
const LINE_ERRORS = /** @type {Record<string,string>} */ ({
  review_file_changed: '这个文件之后又被改过，不能按块撤回。',
  review_hunk_stale: '这块已经变了，刷新再试。',
  review_revert_unavailable: '这一块没法自动撤回（新增或删除的文件、内容不是快照里的样子，或工作区已经不在），请手动处理。',
  review_comment_limit: '评论太多了：每件事最多 50 条草稿，每一轮最多 200 条。',
  workbench_busy: '这个文件夹还有会话或检查在跑，等它停下再撤回。',
  review_round_discarded: '这一轮已经撤掉了，不能再改。',
  rewind_needs_owner: '回退停住了，先在上面拍板再继续。',
  review_comment_sent: '这条评论已经发出，不能再改。',
  review_comment_conflict: '这条评论和已存的对不上，刷新再试。',
  review_comment_not_found: '这条评论已经不在了，刷新看看。',
})
/** 改动记录只跟着成果走:哪几件、各是什么内容。
 * @param {Detail|null|undefined} detail */
const artifactsSignature = detail => JSON.stringify((detail?.artifacts ?? []).map(a => [a.id, a.sha256]))

const windowStorage = workbenchWindowStorage()
const savedView = loadWorkbenchView(windowStorage)

/** @type {{timer:ReturnType<typeof setInterval>,cleanup:()=>void,openTask:(id:string)=>Promise<void>,openDraft:(draft:IncomingDraft)=>Promise<boolean>,getTaskId:()=>string|null}|null} */
let active = null
/** @type {string|null} */
let resumeScope = savedView.scope
/** @type {TaskQuery} */
let resumeQuery = savedView.query
let resumeSearch = savedView.search

const emptyDraft = () => ({ path: '', text: '', title: '', providerId: '', followup: '' })
/** Preserve existing work while making a new handover visibly distinct.
 * @param {string} existing @param {string} incoming */
const appendHandoverText = (existing, incoming) => !incoming ? existing : existing.trim() ? `${existing}\n\n—— 从聊天交办 ——\n${incoming}` : incoming

const pageDrafts = createWorkbenchDraftStore(windowStorage)
const quotaHandoffAttempts=createQuotaHandoffAttempts(windowStorage)
/** @type {Map<string,import('./workbench-interaction.js').InputAttempt>} */
const pageInputAttempts = new Map()

/** @param {string} name @param {string} mime @param {string} text */
export function renderWorkbenchArtifactText(name, mime, text) {
  if (mime === WORKBENCH_CODE_REVIEW_MIME) return renderWorkbenchCodeReview(text)
  return renderReadingFile(name,mime,text)
}

/** @param {number} value */
function time(value) {
  return Number.isFinite(value) ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : ''
}

/** @param {string} status @param {RuntimeSnapshot} [runtime] @param {string} [phase] @param {{since:number}|null} [networkSuspended] */
function statusLabel(status, runtime, phase, networkSuspended) {
  const observed = workbenchRuntimePresentation(status, runtime, phase, networkSuspended)
  if (observed) return observed.label
  return ({ queued: '等待中', running: '进行中', cancelling: '正在停止', completed: '已完成', failed: '未完成', cancelled: '已停止', interrupted: '已中断' })[status] ?? status
}

/** @param {Task} task */
function statusValue(task) { return task.importedOnly ? 'imported' : workbenchRuntimePresentation(task.status, task.runtime, task.phase, task.networkSuspended)?.status ?? task.status }

/** @param {string} status @param {Continuation} [continuation] @param {number|null} [archivedAt] @param {{requiresClose:boolean,decision?:NativeResume|null,providerName?:string}} [native] @param {{taskId:string,runId?:string,inputMode?:'steer'|'send'|'queue',runtime?:RuntimeSnapshot,busy?:boolean,error?:string}} [live] */
function renderTaskControlsBase(status, continuation, archivedAt,native,live) {
  if (archivedAt != null) return '<div class="wb-archived-controls"><p>已归档 <span>恢复后可继续</span></p><button type="button" class="wb-btn" data-action="restore-task">恢复任务</button></div>'
  if (status === 'running' && live?.runId && live.inputMode) {
    const retained = !!live.runtime?.retained
    const timing = retained && live.inputMode === 'queue' ? '补充保存在 CC，当前执行者暂不接收；不会自动发送。' : live.inputMode === 'send' ? '交给同一会话；执行者确认收到后显示已交付。' : live.inputMode === 'steer' ? '交给当前一轮；收到确认后显示已交付。' : '本轮正常结束后，在同一会话继续。停止或失败时保留为未发送。'
    const help = retained && live.inputMode === 'queue' ? `<small id="wb-followup-timing" class="wb-input-warning">${timing}</small>` : `<details id="wb-input-help" class="wb-input-help"><summary title="补充会在什么时候交付">${icon('arrow-down-02', {size:14})}<span>补充说明</span></summary><small id="wb-followup-timing">${timing}</small></details>`
    const note = retained ? `<p class="wb-runtime-note">${(live.runtime?.backgroundCount ?? 0) > 0 ? `后台仍有 ${escapeWorkbenchHtml(live.runtime?.backgroundCount)} 项工作。` : ''}后台会话保持连接，后续回复会继续出现在这里。结束会停止尚未结束的后台工作，并保存当前成果。</p>` : ''
    return `${note}<form class="wb-followup wb-followup-live" data-action="send-input" data-owner-task="${escapeWorkbenchHtml(live.taskId)}" data-run-id="${escapeWorkbenchHtml(live.runId)}" aria-label="运行中补充要求"><label class="wb-sr-only" for="wb-followup-text">补充要求</label><textarea id="wb-followup-text" rows="2" maxlength="20000" aria-describedby="wb-followup-timing" placeholder="补充或调整这项任务的要求…"></textarea>${live.error ? `<p class="wb-interaction-error" role="alert">${escapeWorkbenchHtml(live.error)}</p>` : ''}<div class="wb-control-actions">${help}<button class="wb-btn wb-btn-danger" type="button" data-action="cancel" title="${retained ? '结束会停止尚未结束的后台工作' : '停止当前任务'}">${icon('stop', {size:14})}<span>${retained ? '结束后台会话' : '停止任务'}</span></button><button class="wb-btn wb-btn-primary" type="submit"${live.busy ? ' disabled' : ''}>${icon(live.inputMode === 'queue' && retained ? 'archive' : 'sent', {size:14})}<span>${live.busy ? '正在提交…' : live.inputMode === 'queue' ? retained ? '保存补充' : '加入下一轮' : '发送补充'}</span></button></div></form>`
  }
  if (status === 'queued') {
    return `<form class="wb-followup wb-followup-waiting" aria-label="任务补充草稿">
    <label class="wb-sr-only" for="wb-followup-text">补充要求</label><textarea id="wb-followup-text" rows="2" aria-describedby="wb-followup-timing" placeholder="可以先写在这里"></textarea>
    <div class="wb-control-actions"><small id="wb-followup-timing">草稿只保存在当前任务；本轮结束后可发送。</small><button class="wb-btn wb-btn-danger" type="button" data-action="cancel">停止任务</button></div>
  </form>`
  }
  if (status === 'running') return `<form class="wb-followup wb-followup-waiting" aria-label="任务补充草稿">
    <label class="wb-sr-only" for="wb-followup-text">补充要求</label><textarea id="wb-followup-text" rows="2" aria-describedby="wb-followup-timing" placeholder="可以先写在这里"></textarea>
    <div class="wb-control-actions"><small id="wb-followup-timing">草稿只保存在当前任务；本轮结束后可发送。</small><button class="wb-btn wb-btn-danger" type="button" data-action="cancel">停止任务</button></div>
  </form>`
  if (status === 'cancelling') return `<form class="wb-followup wb-followup-waiting" aria-label="任务补充草稿">
    <label class="wb-sr-only" for="wb-followup-text">补充要求</label><textarea id="wb-followup-text" rows="2" placeholder="可以先写在这里"></textarea>
    <div class="wb-control-actions"><small>正在等待执行程序确认退出。</small><button class="wb-btn" type="button" disabled>正在停止…</button></div>
  </form>`
  if(native?.requiresClose){
    const decision=native.decision,fresh=continuation?.mode==='restart_required'
    const note=decision?`请先关闭原来的 ${escapeWorkbenchHtml(native.providerName||decision.providerId)} 执行程序，再从这里继续。CC 无法替你确认外部程序已退出。`:fresh?'原会话暂时无法恢复。可以查看将带入的记录，再决定新开一轮。':'已加入任务列表，尚未执行。写下接着要做的事，就能从原会话继续。'
    const context=fresh&&continuation?.restart?`<details id="wb-restart-context"><summary>查看将带入的记录</summary><pre>${escapeWorkbenchHtml(continuation.restart.context)}</pre></details>`:''
    return `<section class="wb-recovery"><p>${note}</p>${decision?.changedSinceImport?'<p>原会话加入后有新内容；继续会使用原工具现在保存的历史。</p>':''}${context}</section><form class="wb-followup" data-action="${decision?'native-continue':'native-prepare'}" data-native-token="${escapeWorkbenchHtml(decision?.token??'')}" data-restart-token="${escapeWorkbenchHtml(fresh?continuation?.restart?.token??'':'')}"><label class="wb-sr-only" for="wb-followup-text">继续这个任务</label><textarea id="wb-followup-text" rows="2" placeholder="接下来要做什么…"></textarea><button class="wb-btn wb-btn-primary" type="submit">${decision?(fresh?'原程序已关闭，带记录新开':'原程序已关闭，继续'):fresh?'查看恢复方式':'继续'}</button></form>`
  }
  if(continuation?.mode==='restart_required'&&!continuation.restart)return '<section class="wb-recovery"><p>需要与本次设置匹配的恢复说明，才能继续。</p></section><form class="wb-followup wb-followup-restart" data-action="restart"><label class="wb-sr-only" for="wb-followup-text">接下来要做什么</label><textarea id="wb-followup-text" rows="2" placeholder="接下来要做什么…"></textarea><button class="wb-btn wb-btn-primary" type="submit" disabled>读取恢复说明后继续</button></form>'
  if (continuation?.mode === 'restart_required' && continuation.restart) {
    const restart = continuation.restart
    return `<section class="wb-recovery" aria-label="继续任务前的恢复说明"><h3>原会话无法恢复</h3><p>可以带上这项任务的记录，新开一轮。原对话和成果仍然保留。</p><details id="wb-restart-context"><summary>查看将带入的记录 · ${restart.includedEventCount} / ${restart.eventCount} 条</summary>${restart.truncated ? '<p>更早的记录或过长内容未包含。</p>' : ''}<pre>${escapeWorkbenchHtml(restart.context)}</pre></details></section>
    <form class="wb-followup wb-followup-restart" data-action="restart" data-restart-token="${escapeWorkbenchHtml(restart.token)}"><label class="wb-sr-only" for="wb-followup-text">接下来要做什么</label><textarea id="wb-followup-text" rows="2" placeholder="接下来要做什么…"></textarea><button class="wb-btn wb-btn-primary" type="submit">带这些记录新开一轮</button></form>`
  }
  return '<form class="wb-followup" data-action="continue"><label class="wb-sr-only" for="wb-followup-text">继续这个任务</label><textarea id="wb-followup-text" rows="2" placeholder="继续这个任务…"></textarea><button class="wb-btn wb-btn-primary" type="submit">继续</button></form>'
}

/** @param {string} status @param {Continuation} [continuation] @param {number|null} [archivedAt] @param {{requiresClose:boolean,decision?:NativeResume|null,providerName?:string}} [native] @param {{taskId:string,runId?:string,inputMode?:'steer'|'send'|'queue',runtime?:RuntimeSnapshot,busy?:boolean,error?:string}} [live] @param {Draft} [draft] @param {string} [attachmentError] */
export function renderTaskControls(status,continuation,archivedAt,native,live,draft,attachmentError='') {
  const html=renderTaskControlsBase(status,continuation,archivedAt,native,live).replace('</textarea>','</textarea>'+renderAttachmentComposer(draft,attachmentError))
  return draft?.attachments?.some(a=>a.status!=='ready')?html.replace(/type="submit"(?! disabled)/g,'type="submit" disabled'):html
}

/** @param {Artifact[]} artifacts @param {string|null} current */
export function chooseArtifactId(artifacts, current) {
  if (current && artifacts.some(a => a.id === current)) return current
  return [...artifacts].sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null
}

/** @param {string} path */
function pathParts(path) {
  const clean = path.replace(/[\\/]+$/, '') || path
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return { name: parts.at(-1) || clean || '未命名项目', parent: clean.slice(0, Math.max(0, clean.length - (parts.at(-1)?.length ?? 0))).replace(/[\\/]+$/, '') || '/' }
}

/** 侧栏按哪个项目归组:独立工作区的任务归到源项目(2026-10-07),其余按自己的目录。 @param {Task} task */
export const projectPathOf = task => task.worktree?.projectPath ?? task.path

/** @param {Task[]} tasks @param {Array<{name:string,path:string}>} [projects] */
export function groupWorkbenchTasks(tasks,projects=[]) {
  /** @type {Map<string,Task[]>} */
  const grouped = new Map(projects.map(project=>[project.path,/** @type {Task[]} */([])]))
  const names=new Map(projects.map(project=>[project.path,project.name]))
  const managed = tasks.filter(task => task.workspaceKind === 'managed')
  for (const task of tasks) if (task.workspaceKind !== 'managed') grouped.set(projectPathOf(task), [...(grouped.get(projectPathOf(task)) ?? []), task])
  const nameCounts = new Map()
  for (const path of grouped.keys()) { const name = names.get(path)||pathParts(path).name; nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1) }
  return [...(managed.length ? [{path:'',label:'随手交办',workspaceKind:/** @type {const} */('managed'),tasks:managed}] : []), ...[...grouped].map(([path, projectTasks]) => {
    const { parent } = pathParts(path),name=names.get(path)||pathParts(path).name
    return { path, label: (nameCounts.get(name) ?? 0) > 1 ? `${name} · ${parent}` : name, tasks: projectTasks }
  })]
}

/** @param {Task} task */
const needsDecision = task => task.archivedAt == null && ((task.pendingPermissionCount ?? 0) > 0 || (task.pendingQuestionCount ?? 0) > 0)
/** Stable across sorting, filtering and pagination; paths never become selectors. @param {string} path */
const projectDisclosureId = path => 'wb-project-fold-' + (Array.from(path, c => c.codePointAt(0)?.toString(16)).join('-') || 'managed')

// 执行者头像(2026-10-19,同手机 app):行尾一组圆头像,名字只进读屏标签和 title,行里不再写执行者名字。
const AGENTS = createAgentAvatars()
/**
 * 执行者叫什么(收敛清单 ⑥):只读 daemon 给的 —— 详情 / 列表的 agentNames,再是执行者列表的 displayName;
 * 都没有(老 daemon)⇒ undefined,头像那边退回 id。桌面不存名字表。
 * @param {{providers:Provider[],agentNames?:Record<string,string>,detail?:{agentNames?:Record<string,string>}|null}} state @returns {(id:string)=>string|undefined}
 */
export const providerNameOf = state => id => state.detail?.agentNames?.[id] ?? state.agentNames?.[id] ?? state.providers.find(p => p.id === id)?.displayName
/** 任务自己的执行者在前,再接 daemon 给的 agents(审阅 / 返工 / 会话;老 daemon 不带)。 @param {{providerId:string,agents?:string[]}} task */
const taskAgents = task => AGENTS.matterAgents(task.providerId, task.agents)

/** @param {Task} task @param {(id:string)=>string|undefined} nameOf @param {string|null} selectedId @param {string} [projectName] */
function renderTask(task, nameOf, selectedId, projectName) {
  const agents = taskAgents(task)
  const provider = AGENTS.agentsLabel(agents, nameOf) || '未知执行者'
  const pendingPermissionCount = task.pendingPermissionCount ?? 0
  const pendingQuestionCount = task.pendingQuestionCount ?? 0
  const title = task.title || '未命名任务'
  const updated = time(task.updatedAt)
  const waitingLabel = task.waitingFor?.reason === 'writer_not_closed' ? '等待执行程序退出确认' : task.waitingFor ? '等待前项任务' : ''
  const attention = (pendingPermissionCount > 0 ? `，${pendingPermissionCount} 项权限请求等你确认` : '') + (pendingQuestionCount > 0 ? `，${pendingQuestionCount} 项问题等你回答` : '')
  const waiting = task.waitingFor?.reason === 'writer_not_closed'
    ? `，等待执行程序退出确认，阻塞任务「${task.waitingFor.title}」`
    : task.waitingFor ? `，等待「${task.waitingFor.title}」` : ''
  const originText = AGENTS.originLabel(task.origin)
  const accessibleLabel = `${title}，${provider}${originText ? `，${originText}` : ''}，${(task.importedOnly?'尚未执行':statusLabel(task.status, task.runtime, task.phase, task.networkSuspended))}${attention}${waiting}${updated ? `，更新于 ${updated}` : ''}`
  const attentionLabel = `${task.importedOnly?'尚未执行':statusLabel(task.status, task.runtime, task.phase, task.networkSuspended)}${attention}${waiting}`
  const stateHtml = pendingPermissionCount + pendingQuestionCount > 0
    ? `<span class="wb-task-attention" data-status="${escapeWorkbenchHtml(statusValue(task))}" aria-label="${escapeWorkbenchHtml(attentionLabel)}" title="${escapeWorkbenchHtml(attentionLabel)}">${pendingPermissionCount + pendingQuestionCount}</span>`
    : `<span class="wb-status" data-status="${escapeWorkbenchHtml(statusValue(task))}">${escapeWorkbenchHtml(waitingLabel || (task.importedOnly?'尚未执行':statusLabel(task.status, task.runtime, task.phase, task.networkSuspended)))}</span>`
  return `<button type="button" class="wb-task ${task.id === selectedId ? 'is-selected' : ''}" data-task-id="${escapeWorkbenchHtml(task.id)}" aria-label="${escapeWorkbenchHtml(accessibleLabel)}"${updated ? ` title="${escapeWorkbenchHtml(`${title} · ${updated}`)}"` : ''}>
    <span class="wb-task-title" title="${escapeWorkbenchHtml(title)}">${escapeWorkbenchHtml(title)}${task.worktree && !task.worktree.removed ? `<span class="wb-worktree-badge" title="${escapeWorkbenchHtml(task.worktree.branch)}">独立分支</span>` : ''}</span>
    <span class="wb-task-meta">${projectName ? `<span class="wb-task-provider">${escapeWorkbenchHtml(projectName)}</span>` : ''}${stateHtml}${originText ? `<span class="wb-task-marks">${AGENTS.originMarkHtml(task.origin)}${AGENTS.agentAvatarsHtml(agents, { nameOf })}</span>` : AGENTS.agentAvatarsHtml(agents, { nameOf })}</span>
  </button>`
}

/** @typedef {{detail:Detail|null,helper:string,handoffs:Handoff[],actionable:boolean,lastReply:WorkbenchEvent|undefined,otherProvider:Provider|undefined,origin:Handoff|undefined}} MessageContext */

/** 一条消息渲染要用到的上下文。整页重画和逐条增量补丁都从同一个 state 推出来,
 * 两条路才不会长歪。 @param {WorkbenchState} state @returns {MessageContext} */
export function workbenchMessageContext(state) {
  const detail = state.detail
  const handoffs = detail?.handoffs ?? []
  const events = detail?.events ?? []
  return {
    detail,
    helper: (detail ? providerNameOf(state)(detail.task.providerId) || detail.task.providerId : '') || '执行助手',
    handoffs,
    origin: handoffs.find(h => h.purpose === 'review' && h.targetTaskId === detail?.task.id),
    otherProvider: state.providers.find(p => p.id !== detail?.task.providerId),
    lastReply: events.filter(e => e.kind === 'text').at(-1),
    actionable: detail?.task.archivedAt == null && ['completed', 'failed', 'cancelled', 'interrupted'].includes(detail?.task.status ?? ''),
  }
}

/** @param {MessageContext} context @returns {(event:WorkbenchEvent)=>string} */
export function renderMessageFor({ detail, helper, handoffs, actionable, lastReply, otherProvider, origin }) {
  return event => {
    const handoff=handoffs.find(h=>h.requestEventId===Number(event.id))
    const text=handoff?.request??event.text
    const body=event.kind==='user'?renderWorkbenchUserText(text,`task:${event.taskId}:${event.id}`):event.kind==='text'?renderWorkbenchMarkdown(text):escapeWorkbenchHtml(text)
    return `<article class="wb-message" id="${workbenchTimelineEventId(event)}" data-timeline-anchor data-kind="${escapeWorkbenchHtml(event.kind)}">
    <header><span>${event.kind === 'user' ? '你' : `<span class="wb-provider-badge">${escapeWorkbenchHtml(helper)}</span>`}</span><time>${escapeWorkbenchHtml((event.sourceId?'原会话记录':time(event.createdAt)))}</time></header>
    <div class="wb-message-body${event.kind==='text'?' cc-readable-markdown wb-markdown':''}">${body}${handoff?`<button class="wb-new" data-action="handoff-record" data-handoff-id="${escapeWorkbenchHtml(handoff.id)}">查看随附的交接内容</button>`:''}</div>
    ${renderMessageAttachments(detail?.task.id??'',event.attachments)}
    ${event.kind==='text'&&detail?renderImageArtifacts(detail.task.id,(detail.artifacts??[]).filter(a=>detail.events.filter(message=>message.kind==='text'&&message.createdAt<=a.createdAt).at(-1)?.id===event.id)):''}
    ${actionable&&event.kind==='text'&&(origin||(event===lastReply&&otherProvider))?`<button type="button" class="wb-new wb-handoff-action" data-action="${origin?'handoff-revision':'handoff-review'}" data-event-id="${event.id}">${origin?'选择意见，交回原任务':`交给 ${escapeWorkbenchHtml(otherProvider?.displayName)} 检查`}</button>`:''}
  </article>`
  }
}

/** @param {{quotaAttempt?:import('./workbench-quota-handoff.js').Attempt|null,catalog?:import('./workbench-execution.js').CatalogState,restartPreview?:import('./workbench-execution.js').ContinuationPreviewState,busy?:boolean,sidebarDisclosures?:Map<string,boolean>}} [executionView] @param {WorkbenchState} state @param {import('./workbench-interaction.js').Interactions} [interactions] @param {Draft} [draft] @param {string} [attachmentError] */
export function renderWorkbench(state, interactions, draft, attachmentError='',executionView={}) {
  const tasks = state.tasks ?? []
  const detail = state.detail
  const query = state.query ?? { q: '', archived: 'exclude' }
  const listEmptyCopy = state.error ? '暂时没能读取任务列表。' : query.q ? '没有找到匹配的任务。试试其他任务名称或文件夹。' : query.archived === 'only' ? '还没有已归档的任务。' : '还没有交办的事。直接写下要求，就能开始。'
  const selectedArtifact = detail?.artifacts?.find(a => a.id === state.selectedArtifactId)
  const decisionCount = (detail?.permissions ?? []).filter(p => p.taskId === detail?.task.id).length + (detail?.questions ?? []).filter(q => q.taskId === detail?.task.id).length
  const observed = detail ? workbenchRuntimePresentation(detail.task.status, detail.runtime ?? detail.task.runtime, detail.task.phase, detail.task.networkSuspended) : null
  // A retained/idle process or an old file is not evidence of a finished turn.
  const answered = !!detail && !detail.task.importedOnly && !detail.task.error && observed?.status !== 'paused' && (detail.task.status === 'completed' || detail.task.status === 'running' && detail.task.phase === 'replied')
  const taskFocus = decisionCount ? 'decision' : answered ? 'outcome' : 'progress'
  const reviewIds = new Set((state.reviews ?? []).map(review => review.artifactId))
  const promoteArtifacts = taskFocus === 'outcome' && Array.isArray(state.reviews) && state.reviewsLoaded !== false && !state.reviewsError && !!detail?.artifacts.some(artifact => !reviewIds.has(artifact.id))
  const activeProject=state.projects?.find(project=>state.newScope===`new:${project.path}`)
  const projects=groupWorkbenchTasks(tasks,state.projects).filter(project=>!query.q&&query.archived!=='only'||project.tasks.length||query.archived!=='only'&&project.label.toLowerCase().includes(query.q.toLowerCase()))
  const attentionTasks = tasks.filter(needsDecision)
  const projectName = (/** @type {Task} */ task) => task.workspaceKind === 'managed' ? '随手交办' : projects.find(p => p.path === projectPathOf(task))?.label ?? pathParts(projectPathOf(task)).name
  const attentionList = attentionTasks.length ? `<section class="wb-attention-list" aria-label="等你处理"><header><h3>等你处理</h3><small>${state.page?.hasMore ? '当前列表' : `${attentionTasks.length} 件`}</small></header>${attentionTasks.map(task => renderTask(task, providerNameOf(state), state.loadingId ?? state.selectedId, projectName(task))).join('')}</section>` : ''
  const regularProjects = projects.map(project => ({...project, tasks:project.tasks.filter(task => !needsDecision(task))}))
  const visibleProjects = regularProjects.filter(project => project.tasks.length || activeProject?.path === project.path)
  const selectedTask = tasks.find(task => task.id === (state.loadingId ?? state.selectedId)) ?? detail?.task
  const isSelectedProject = (/** @type {typeof regularProjects[number]} */ project) => activeProject?.path === project.path || !!selectedTask && (selectedTask.workspaceKind === 'managed' ? project.path === '' : project.path === projectPathOf(selectedTask))
  const projectPriority = (/** @type {typeof regularProjects[number]} */ project) => isSelectedProject(project) ? 0 : project.tasks.some(task => ['running','queued','cancelling'].includes(statusValue(task))) ? 1 : 2
  visibleProjects.sort((a,b) => projectPriority(a)-projectPriority(b) || Math.max(0,...b.tasks.map(t=>t.updatedAt))-Math.max(0,...a.tasks.map(t=>t.updatedAt)))
  const otherProjects = regularProjects.filter(project => !project.tasks.length && activeProject?.path !== project.path)
  const renderProject = (/** @type {typeof regularProjects[number]} */ project, /** @type {number} */ index) => {
    const id = projectDisclosureId(project.path)
    const selected = isSelectedProject(project)
    const working = project.tasks.some(task => ['running','queued','cancelling'].includes(statusValue(task)))
    const open = !!query.q || (executionView.sidebarDisclosures?.get(id) ?? (selected || working || index === 0))
    const create = 'workspaceKind' in project && project.workspaceKind === 'managed'
      ? '<button type="button" class="wb-new wb-project-new" data-action="task-entry" aria-label="随手交办一件事">＋ 交办</button>'
      : `<button type="button" class="wb-new wb-project-new" data-action="task-entry" data-project-path="${escapeWorkbenchHtml(project.path)}" aria-label="在 ${escapeWorkbenchHtml(project.label)} 交办">＋ 交办</button>`
    return `<section class="wb-project"><details id="${id}" data-sidebar-disclosure${open ? ' open' : ''}><summary title="${escapeWorkbenchHtml(project.path)}"><h3>${escapeWorkbenchHtml(project.label)}</h3><small>${project.tasks.length}</small></summary><div class="wb-project-tasks">${project.tasks.map(task => renderTask(task, providerNameOf(state), state.loadingId ?? state.selectedId)).join('') || '<p class="wb-empty-copy">在这个项目里交办一件事。</p>'}</div></details>${create}</section>`
  }
  const otherId = 'wb-other-projects'
  const otherList = otherProjects.length ? `<details id="${otherId}" class="wb-other-projects" data-sidebar-disclosure${query.q || executionView.sidebarDisclosures?.get(otherId) ? ' open' : ''}><summary>其他项目 <small>${otherProjects.length}</small></summary><div>${otherProjects.map(project => `<section class="wb-project wb-project-empty"><h3 title="${escapeWorkbenchHtml(project.path)}">${escapeWorkbenchHtml(project.label)}</h3><button type="button" class="wb-new wb-project-new" data-action="task-entry" data-project-path="${escapeWorkbenchHtml(project.path)}" aria-label="在 ${escapeWorkbenchHtml(project.label)} 交办">＋ 交办</button></section>`).join('')}</div></details>` : ''
  const taskList = visibleProjects.length || otherProjects.length || attentionTasks.length ? attentionList + visibleProjects.map(renderProject).join('') + otherList : `<p class="wb-empty-copy">${listEmptyCopy}</p>`
  // 「一件事」:在桌面露过面的对话(主人跟 CC 说的那条)也在这张列表里,排在任务上面。
  const listControls = `<div class="wb-list-controls"><form id="wb-search-form" class="wb-search"><label class="wb-sr-only" for="wb-search">搜索任务名称、文件夹或任务编号</label><input id="wb-search" name="q" type="search" maxlength="200" placeholder="搜索任务或项目" value="${escapeWorkbenchHtml(query.q)}"><button class="wb-new" type="submit" aria-label="搜索任务">搜索</button></form><div class="wb-list-filters">${query.archived === 'only' ? '<button class="wb-new" type="button" data-action="toggle-archived" aria-pressed="true">返回任务</button>' : ''}${query.q ? '<button class="wb-new" type="button" data-action="clear-search">清除搜索</button>' : ''}<details id="wb-list-more" class="wb-list-more" data-sidebar-disclosure${executionView.sidebarDisclosures?.get('wb-list-more') ? ' open' : ''}><summary>更多</summary><div><button type="button" class="wb-new" data-action="add-project">添加项目</button>${query.archived === 'only' ? '' : '<button class="wb-new" type="button" data-action="toggle-archived" aria-pressed="false">已归档的任务</button>'}${state.historyProviders?.length?'<button class="wb-new" type="button" data-action="native-history">导入已有会话</button>':''}</div></details></div>${query.archived === 'only' ? '<p class="wb-archive-label">已归档的任务</p>' : ''}</div>`
  const pagination = state.page?.hasMore ? `<button type="button" class="wb-new wb-load-more" data-action="load-more"${state.loadingMore ? ' disabled' : ''}>${state.loadingMore ? '正在加载…' : '加载更早的任务'}</button>` : ''
  const messageContext = workbenchMessageContext(state)
  const { helper, handoffs } = messageContext
  const renderMessage = renderMessageFor(messageContext)
  const events = detail?.events ?? []
  const permissions = (detail?.permissions ?? []).filter(permission => permission.taskId === detail?.task.id)
  const queuedCopy = detail?.task.waitingFor?.reason === 'writer_not_closed'
    ? '执行程序尚未确认退出，这项队列不会继续。请检查原进程和输出，确认退出后再处理。可以停止这项排队任务；其他文件夹的任务仍可继续。'
    : detail?.task.waitingFor?.reason === 'same_path'
      ? `正在等待「${escapeWorkbenchHtml(detail.task.waitingFor.title)}」结束；这些任务使用同一个文件夹。`
      : detail?.task.waitingFor?.reason === 'nested_path'
        ? `正在等待「${escapeWorkbenchHtml(detail.task.waitingFor.title)}」结束；任务文件夹彼此包含。`
        : '任务已记下，正在等待执行。'
  // 挡路的那位已经答复、正数着秒自己让开:说人话,别让主人去取消一件已经做成了的事。
  // `writer_not_closed` 那种挡路方永远不安静(`holderWriting` 恒为 true),这句话盖不到它头上——
  // 终审 I3 的教训。「收工」直接关的是挡路者的会话,不是这条排队任务自己。
  const holderWaiting = detail?.task.waitingFor
  // 向下取:宁可显示得比实际剩的更少,也不能报出一个还没到手的秒数(评审 #3)。
  const holderCloseSeconds = holderWaiting?.closeInMs != null ? Math.max(0, Math.floor(holderWaiting.closeInMs / 1000)) : null
  const holderHandoffReady = !!holderWaiting && holderWaiting.reason !== 'writer_not_closed' && holderWaiting.holderWriting === false && holderCloseSeconds != null
  const queuedGuidance = detail?.task.status === 'queued' && detail.task.waitingFor
    ? holderHandoffReady
      ? `<p class="wb-queue-guidance" role="status">「${escapeWorkbenchHtml(holderWaiting.title)}」已答复，会话还开着；${holderCloseSeconds} 秒后自动让出文件夹 —— 也可以现在就让它收工 <button type="button" class="wb-btn" data-action="cancel" data-cancel-task-id="${escapeWorkbenchHtml(holderWaiting.taskId)}">收工</button></p>`
      : `<p class="wb-queue-guidance" role="status">${queuedCopy}</p>`
    : ''
  const related=handoffs.length?`<details id="wb-handoffs" class="wb-disclosure wb-handoffs"><summary>交接记录 · ${handoffs.length}</summary>${handoffs.map(h=>{
    const outgoing=h.sourceTaskId===detail?.task.id
    return `<div class="wb-handoff-link"><button class="wb-new" data-task-id="${escapeWorkbenchHtml(outgoing?h.targetTaskId:h.sourceTaskId)}">${h.purpose==='review'?'检查':'修订'} · ${escapeWorkbenchHtml(outgoing?h.targetTitle:h.sourceTitle)}</button><button class="wb-new" data-action="handoff-record" data-handoff-id="${escapeWorkbenchHtml(h.id)}">查看当时的内容</button></div>`
  }).join('')}</details>`:''
  const dialogueHtml = events.length ? renderWorkbenchTimeline(events, { status:detail?.task.status ?? '', runId:detail?.runId, runtime:detail?.runtime, renderMessage, escapeHtml:escapeWorkbenchHtml, formatTime:time })
    : `<p class="wb-empty-copy">${detail?.task.status === 'running' ? `${escapeWorkbenchHtml(helper)} 正在处理，有回复时会按顺序显示在这里。` : detail?.task.status === 'queued' ? queuedCopy : '这项任务还没有对话记录。'}</p>`
  const permissionHtml = permissions.length ? `<section class="wb-permissions" aria-label="等待处理的权限请求"><header><h3>需要你的决定</h3><span>${permissions.length} 项</span></header>${permissions.map(permission => `<article class="wb-permission"><div><span class="wb-permission-tool">${escapeWorkbenchHtml(permission.tool)}</span><p>${escapeWorkbenchHtml(permission.description)}</p><time>${escapeWorkbenchHtml(time(permission.createdAt))}</time></div><div class="wb-permission-actions">${['deny-permission','allow-permission'].map(action=>`<button id="${permissionControlId(permission.taskId,permission.id,action)}" class="wb-btn${action==='allow-permission'?' wb-btn-primary':''}" type="button" data-action="${action}" data-owner-task="${escapeWorkbenchHtml(permission.taskId)}" data-request-id="${escapeWorkbenchHtml(permission.id)}">${action==='allow-permission'?'允许':'拒绝'}</button>`).join('')}</div></article>`).join('')}</section>` : ''
  const listedArtifacts = promoteArtifacts ? [...(detail?.artifacts ?? [])].sort((a,b) => Number(reviewIds.has(a.id)) - Number(reviewIds.has(b.id))) : detail?.artifacts ?? []
  const artifacts = listedArtifacts.length ? listedArtifacts.map(artifact => `<button type="button" class="wb-artifact ${artifact.id === state.selectedArtifactId ? 'is-selected' : ''}" data-artifact-id="${escapeWorkbenchHtml(artifact.id)}"><span>${escapeWorkbenchHtml(artifactDisplayName(artifact.name))}</span><small>${/\.preview\.json$/i.test(artifact.name) ? '网页预览' : `${escapeWorkbenchHtml((artifact.size / 1024).toFixed(1))} KB · ${artifact.approvedAt ? '已确认' : '待确认'}`}</small></button>`).join('') : ''
  const artifactPanel = renderArtifactPanel(detail?.artifacts ?? [], state.previewOpen || (state.preview && state.previewOpen !== false) ? selectedArtifact : undefined, state.preview)
  // 审阅快照仍先看改动；已答复且确有保存的交付物时，成果提升到对话之前。
  // 整块面板共用一份预览额度(和「成果」里那份报告同样的 256KiB / 4000 行):
  // 十几轮 × 几十个文件不能各渲各的,不然这一页会被 diff 压垮。
  const reviewBudget = createReviewDiffBudget()
  // 回到某一轮(2026-10-21):确认块 / 撤销回退只在有这些字段时才画,老后台照旧
  const rewindOptions = detail && (state.rewindOpen || detail.rewind) ? { rewind: { open: state.rewindOpen ?? null, view: detail.rewind ?? null, busy: !!executionView.busy } } : {}
  const reviewHtml = detail ? renderReviewPanel(state.reviews ?? [], { compactSummary: true, escapeHtml: escapeWorkbenchHtml, formatTime: time, renderDiff: (file, lines) => renderReviewFileDiff(file, escapeWorkbenchHtml, reviewBudget, lines), budget: reviewBudget, returnOpen: state.reviewReturnOpen ?? null, returnResult: state.reviewReturnResult ?? null, lesson: detail.task.workspaceKind !== 'managed', error: !!state.reviewsError, ...rewindOptions, lines: { select: state.lineSelect ?? null, compose: state.lineCompose ?? null, send: state.commentsSend ?? null } }) : ''
  const rewindBlocked = detail ? renderRewindBlocked(detail, !!state.rewindRestoreConfirm, escapeWorkbenchHtml, !!executionView.busy) : ''
  const artifactHtml = detail?.artifacts?.length && !artifactPanel ? `<details id="wb-artifacts" class="wb-disclosure wb-artifacts${promoteArtifacts ? ' is-outcome' : ''}"${promoteArtifacts ? ' open' : ''}><summary><span>成果</span><small>${detail.artifacts.length} 件</small></summary><div class="wb-artifact-list">${artifacts}</div><button type="button" class="wb-new" data-action="back-to-dialogue">回到对话</button></details>` : ''
  const execution=draft?.execution??detail?.execution??{defaults:/** @type {const} */('provider'),model:null,reasoningEffort:null}
  const executionDisabled=!!executionView.busy||!!(detail&&(detail.task.archivedAt!=null||['running','queued','cancelling'].includes(detail.task.status)))
  const executionControls=renderExecutionControls(execution,executionView.catalog,executionDisabled)
  // 执行者与来源放进任务详情，标题只保留项目和真实状态。
  const detailAgentIds = detail ? taskAgents(detail.task) : []
  // 出生地字形放在头像组旁边、名字前面;名字后面再写一句「从哪来的」(不知道 ⇒ 都不画)。
  const detailOrigin = detail ? AGENTS.originLabel(detail.task.origin) : ''
  const detailAgents = detailAgentIds.length || detailOrigin ? `<p class="wb-task-agents">${detailOrigin ? AGENTS.originMarkHtml(detail?.task.origin) : ''}${AGENTS.agentAvatarsHtml(detailAgentIds, { nameOf: providerNameOf(state) })}<span>${escapeWorkbenchHtml([AGENTS.agentsLabel(detailAgentIds, providerNameOf(state)), detailOrigin].filter(Boolean).join(' · '))}</span></p>` : ''
  const progress = detail ? `<div class="wb-task-progress"><span class="wb-status" data-status="${escapeWorkbenchHtml(statusValue({...detail.task,runtime:detail.runtime ?? detail.task.runtime}))}">${escapeWorkbenchHtml(detail.task.importedOnly ? '尚未执行' : statusLabel(detail.task.status, detail.runtime ?? detail.task.runtime, detail.task.phase, detail.task.networkSuspended))}</span>${decisionCount ? `<button type="button" class="wb-new wb-decision-jump" data-action="show-decisions" aria-label="${decisionCount} 项等你处理，查看请求" title="${decisionCount} 项等你处理，查看请求">${icon('arrow-down-02', {size:14})}<span aria-hidden="true">${decisionCount}</span></button>` : ''}</div>` : ''
  const taskHeader = detail ? `<header class="wb-task-head"><div><p class="wb-task-context">${detail.task.workspaceKind==='managed'?'随手交办':escapeWorkbenchHtml(state.projects?.find(project => project.path === projectPathOf(detail.task))?.name ?? pathParts(projectPathOf(detail.task)).name)}</p><h2 title="${escapeWorkbenchHtml(detail.task.title || '未命名任务')}">${escapeWorkbenchHtml(detail.task.title || '未命名任务')}</h2>${progress}${untilHtml(detail.task)}${worktreeScriptsHtml(detail.task.worktree)}${isUnattendedProvider(state.providers.find(p => p.id === detail.task.providerId)) ? '<p class="wb-task-unattended">免审执行者 · 看不到单步,只能停止</p>' : ''}</div><div class="wb-task-head-actions">${detail.artifacts.length ? `<button type="button" class="wb-new" data-action="show-artifacts">成果 · ${detail.artifacts.length}</button>` : ''}<details id="wb-task-info" class="wb-task-info"><summary>任务详情</summary><div class="wb-task-info-body">${detailAgents}${worktreeHtml(detail.task, state.providers)}<dl><div><dt>完整路径</dt><dd class="wb-path">${escapeWorkbenchHtml(detail.task.path)}${detail.task.workspaceKind==='managed'?'<button type="button" class="wb-new" data-action="open-task-folder">打开工作位置</button>':''}</dd></div><div><dt>任务编号</dt><dd><code>${escapeWorkbenchHtml(detail.task.id)}</code></dd></div><div><dt>执行者</dt><dd>${escapeWorkbenchHtml(helper)}</dd></div><div><dt>更新时间</dt><dd>${escapeWorkbenchHtml(time(detail.task.updatedAt))}</dd></div>${detail.source?`<div><dt>原会话</dt><dd>${escapeWorkbenchHtml(detail.source.providerId)} · <code>${escapeWorkbenchHtml(detail.source.nativeId)}</code></dd></div><div><dt>已保存的原记录</dt><dd>${detail.source.selectedMessageCount} 段${detail.source.truncated?' · 部分文字':''}</dd></div>`:''}</dl><section class="wb-task-execution"><h3>下一轮使用</h3>${executionControls}${renderExecutionObservation(detail.lastExecution)}</section>${detail.task.archivedAt != null ? '<div class="wb-task-organization"><button type="button" class="wb-btn" data-action="restore-task">恢复任务</button></div>' : detail.task.canArchive === true ? `<div class="wb-task-organization"><button type="button" class="wb-btn" data-action="archive-task">归档任务</button>${detail.task.worktree && !detail.task.worktree.removed ? '<small>独立工作区没有没提交的改动时会一起删掉（分支保留）。</small>' : ''}</div>` : ''}${state.canWechat && detail.task.archivedAt == null ? `<div class="wb-wechat"><span>在微信继续</span><code>任务 ${escapeWorkbenchHtml(detail.task.id)}</code><button type="button" class="wb-btn" data-action="copy-wechat-command">复制</button></div>` : ''}</div></details></div></header>` : ''
  const modelErrorInTimeline=detail?.task.error==='execution_model_unsupported'&&detail.events.filter(event=>event.kind==='error').at(-1)?.errorCode==='execution_model_unsupported'
  const content = detail ? `
    ${rewindBlocked}
    ${related}
    ${promoteArtifacts ? artifactHtml : ''}
    <section class="wb-dialogue" aria-live="polite">${dialogueHtml}</section>
    ${queuedGuidance}
    ${renderWorkbenchInputs(detail.task.id, detail.inputs ?? [], interactions,!!detail.runtime?.retained)}
    ${renderQuotaHandoff(detail,state.providers,executionView.quotaAttempt)}
    ${detail.task.error&&detail.task.error!=='rewind_needs_owner'&&(!detail.quotaHandoff||!['provider_quota_exhausted','provider_rate_limited'].includes(detail.task.error)) ? `<div class="wb-error" role="alert">${modelErrorInTimeline?'':escapeWorkbenchHtml(executionErrorMessage(detail.task.error)??detail.task.error)}${detail.task.error==='execution_model_unsupported'&&!executionDisabled?'<button type="button" class="wb-new" data-action="choose-task-model">为这件事选择模型</button>':''}${writerExitHtml(detail.task)}</div>` : ''}
    ${reviewHtml}
    ${promoteArtifacts ? '' : artifactHtml}` : !state.loadingId && state.projects && !activeProject && state.newScope !== 'new:add-project' && !draft?.text.trim() ? `
    <div class="wb-welcome"><p class="wb-kicker">交办一件事</p><h1>希望 CC 帮你做什么？</h1><p>写下要求、加上材料，再确认工作位置。</p><button type="button" class="wb-btn wb-btn-primary" data-action="task-entry">交给 CC 做</button></div>` : !detail && !state.loadingId && state.projects && !activeProject && (state.newScope === 'new:add-project' || !!draft?.text.trim()) ? `
    <div class="wb-welcome"><p class="wb-kicker">添加项目</p><h1>把同一件工作的对话放在一起</h1><p>选择一次文件夹。之后在项目里新开对话，不用重复设置。</p>
      ${draft?.text ? `<details class="wb-options"><summary>已保留交办要求</summary><p class="wb-field-help">添加项目后，可继续检查要求并开始。</p><p class="wb-handover-preview">${escapeWorkbenchHtml(draft.text)}</p></details>` : ''}
      <form id="wb-project-form" class="wb-create-form">
        <label>项目文件夹<div class="wb-folder-row"><input id="wb-path" name="path" required placeholder="选择或粘贴一个本机文件夹"><button type="button" class="wb-btn" data-action="choose-folder">选择…</button></div></label>
        <label>项目名称 <span class="wb-optional">可选</span><input id="wb-title" name="name" maxlength="100" placeholder="默认使用文件夹名称"></label>
        <label>默认执行者<select id="wb-provider" name="providerId">${state.providers.map(p=>`<option value="${escapeWorkbenchHtml(p.id)}" ${p.id===state.defaultProvider?'selected':''}>${escapeWorkbenchHtml(providerLabel(p))}</option>`).join('')}</select></label>
        <button class="wb-btn wb-btn-primary" type="submit" ${state.providers.length?'':'disabled'}>添加项目</button>
      </form></div>` : state.loadingId ? `
    <div class="wb-welcome wb-task-loading" role="status"><p class="wb-kicker">打开任务</p><h1>正在打开任务…</h1><p>正在读取这项任务的对话和成果。</p></div>` : `
    ${state.error && !state.providers.length ? '<div class="wb-welcome"><p class="wb-kicker">一起做</p><h1>暂时没能打开手头的事。</h1><p>连接恢复后，就能继续查看任务和交代新事情。</p><button class="wb-btn" type="button" data-action="refresh">重新连接</button></div>' : ''}
    <div class="wb-welcome" ${state.error && !state.providers.length ? 'hidden' : ''}><p class="wb-kicker">${activeProject?escapeWorkbenchHtml(activeProject.name)+' · 新对话':'新的一件事'}</p><h1>我们一起做点什么？</h1><p>${activeProject?'这是一段独立对话，同项目的其他对话不会自动带入。':'说说你想做的事，再选一个放材料的文件夹。'}</p>
      <form id="wb-create-form" class="wb-create-form">
        ${activeProject?`<input id="wb-path" name="path" type="hidden" value="${escapeWorkbenchHtml(activeProject.path)}"><p class="wb-field-help">${escapeWorkbenchHtml(activeProject.path)}</p>`:`<label>文件夹<div class="wb-folder-row"><input id="wb-path" name="path" required aria-describedby="wb-folder-help" placeholder="选择或粘贴一个本机文件夹"><button type="button" class="wb-btn" data-action="choose-folder">选择…</button></div><small id="wb-folder-help" class="wb-field-help">也可以直接粘贴完整路径；原生选择目前只在 macOS 提供。</small></label>`}
        <label>要做什么<textarea id="wb-create-text" name="text" rows="4" maxlength="20000" placeholder="例如：整理这些访谈记录，做一份主题摘要和引用表"></textarea></label>
        ${renderAttachmentComposer(draft,attachmentError)}
        ${state.providers.length ? '' : '<p class="wb-provider-missing" role="alert">暂时没有可用的工作执行者。请连接或管理一个支持工作任务的执行者后再开始任务。</p>'}
        <details id="wb-options" class="wb-options"><summary>执行者与命名 <span>当前使用 ${escapeWorkbenchHtml((p => p ? providerLabel(p) : '尚未选择执行者')(state.providers.find(p => p.id === state.defaultProvider)))}</span></summary><label>执行者<select id="wb-provider" name="providerId"${executionView.busy?' disabled':''}>${(state.providers ?? []).map((p) => `<option value="${escapeWorkbenchHtml(p.id)}" ${p.id === state.defaultProvider ? 'selected' : ''}>${escapeWorkbenchHtml(providerLabel(p))}</option>`).join('')}</select></label>
        ${executionControls}<label>任务名称 <span class="wb-optional">可选</span><input id="wb-title" name="title" placeholder="留空时使用任务要求的前 40 个字"></label></details>
        <button class="wb-btn wb-btn-primary" type="submit"${state.providers.length&&!draft?.attachments?.some(a=>a.status!=='ready') ? '' : ' disabled'}>开始任务</button>
      </form></div>`
  const chosenContinuation=executionView.restartPreview?(executionView.restartPreview.status==='ready'?executionView.restartPreview.continuation??undefined:{mode:'restart_required'}):detail?.continuation
  const previewError=executionView.restartPreview?.error?`<p class="wb-interaction-error" role="alert">${escapeWorkbenchHtml(executionView.restartPreview.error)} <button type="button" class="wb-new" data-action="retry-continuation-preview">重新读取恢复说明</button></p>`:''
  const controls = detail ? `<div class="wb-controls"><div class="wb-controls-inner">${permissionHtml}${renderWorkbenchQuestions(detail.task.id, detail.questions ?? [], interactions)}${previewError}${renderTaskControls(detail.task.status, chosenContinuation, detail.task.archivedAt,{requiresClose:!!detail.requiresExternalClose,decision:state.nativeResume?.taskId===detail.task.id?state.nativeResume:null,providerName:state.nativeResume?.taskId===detail.task.id?providerNameOf(state)(state.nativeResume.providerId):undefined},{taskId:detail.task.id,runId:detail.runId,inputMode:detail.inputMode,runtime:detail.runtime,...interactions?.inputState(detail.task.id)},draft,attachmentError)}</div></div>` : ''
  return `<div class="workbench-shell${artifactPanel ? ' has-preview' : ''}"><aside class="wb-sidebar"><header><h2>一起做</h2><button type="button" class="wb-btn wb-btn-primary wb-delegate" data-action="task-entry">交办</button></header>${listControls}<div class="wb-task-list">${taskList}</div>${pagination}</aside><main class="wb-main">${taskHeader}<div class="wb-content"><div class="wb-content-inner" data-task-focus="${taskFocus}">${state.error ? `<div class="wb-error" role="alert">${escapeWorkbenchHtml(state.error)}</div>` : ''}${detail && state.detailDisconnected ? '<div class="wb-error" role="status">任务更新暂时中断，正在重新连接。当前显示的是上次收到的内容。<button type="button" class="wb-btn" data-action="refresh">立即重试</button></div>' : ''}${content}</div></div>${detail ? '<div class="wb-reading-bar" hidden><button type="button" class="wb-btn" data-action="latest-content">有新内容 ↓</button></div>' : ''}${controls}</main>${artifactPanel}</div>`
}

/** @param {{invokeWorkbenchApi:WorkbenchDeps['invokeWorkbenchApi'],render:(state:WorkbenchState)=>void,initialScope?:string|null,initialQuery?:TaskQuery,patchLive?:(changed:WorkbenchEvent[])=>boolean}} deps */
export function createWorkbenchController(deps) {
  /** @type {WorkbenchState} */
  const state = { reviewsLoaded: false, reviews: /** @type {ReviewTurn[]} */ ([]), reviewsSignature: EMPTY_REVIEWS, reviewsError: false, reviewReturnOpen: /** @type {ReviewReturnOpen|null} */ (null), version: 0, tasks: [], providers: [], defaultProvider: '', canWechat: false, selectedId: null, loadingId: null, detail: null, selectedArtifactId: null, error: '', detailDisconnected:false, preview: null, query: { ...(deps.initialQuery ?? { q: '', archived: 'exclude' }) }, loadingMore: false, newScope: deps.initialScope?.startsWith('new:') ? deps.initialScope : 'new' }
  let detailRequest = 0
  let listRequest = 0
  let loadedPages = 1
  /** @type {string|null} */
  let desiredId = null
  let composingNewTask = deps.initialScope === 'new' || !!deps.initialScope?.startsWith('new:')
  let preferredInitialId = deps.initialScope?.startsWith('task:') ? deps.initialScope.slice(5) : null
  let alive = true
  let lastPaint = ''
  // 列表每 3 秒回来一次,而任务的 updated_at 每条事件都在动:那个时间戳不该把整页
  // 重画拽起来(会打断流式补丁、输入和滚动)。列表上的时间标签因此可能晚一拍。
  // `waitingFor.closeInMs` 是同一类字段:后端按 `Date.now()` 现算,只要列表里有任务武装着
  // 自动让位的计时,这个数字每次都不一样——不摘掉的话,那个功能要呈现的正是让整页每 3 秒重画
  // 一次的那种状态。摘掉它不会漏该有的重画:计时武装/取消这两下真正的转变都在 `holderWriting`
  // 上,那个字段没被摘,该重画的时候照样重画。
  // 改动快照里是整段 diff:每次 paint 都 stringify 一遍太贵,用它的签名代替(签名含快照 sha 与标记)。
  // closeInMs 抹平成 0 只是为了去掉「每次都不一样的数字」——但 null(没有计时器)与非 null
  // (已武装)是两种不同的状态,抹平不能把它们并成同一个键,否则「没计时」→「已武装」这个真转变
  // 会被去重吞掉(终审 M1)。用 0 只代表「已武装、数字不重要」,null 保留 null。
  const paintKey = () => JSON.stringify({ ...state, reviews: undefined, tasks: (state.tasks ?? []).map(task => ({ ...task, updatedAt: 0, ...(task.waitingFor ? { waitingFor: { ...task.waitingFor, closeInMs: task.waitingFor.closeInMs == null ? null : 0 } } : {}) })) })
  const paint = (force = false) => {
    const snapshot = paintKey()
    if (!force && snapshot === lastPaint) return
    lastPaint = snapshot
    deps.render(state)
  }
  // 增量补丁已经把变过的行写进 DOM 了:把重画基准对齐,免得下一次 paint() 为同一批
  // 事件再整页重画一次(那会打断输入和滚动)。
  const syncPaintSnapshot = () => { lastPaint = paintKey() }
  const forgetReviews = () => { state.reviewsLoaded = false; state.reviews = []; state.reviewsSignature = EMPTY_REVIEWS; state.reviewsError = false; state.reviewReturnOpen = null; state.reviewReturnResult = null; state.rewindOpen = null; state.rewindRestoreConfirm = false; state.lineSelect = null; state.lineCompose = null; state.commentsSend = null }
  /** 改动记录跟详情并行拉:读不到只在面板上照实说一句,详情照旧。
   * 标记可能是别的面(微信)改的,所以每次长轮询回来都再问一次;签名没变就不重画。
   * @param {string} id */
  const loadReviews = id => {
    const request = detailRequest, artifactKey = artifactsSignature(state.detail)
    const current = () => alive && request === detailRequest && state.selectedId === id && artifactKey === artifactsSignature(state.detail)
    void v1(deps.invokeWorkbenchApi, V1.workbench.review, { query: { id: id } }).then(response => {
      if (!current()) return
      const list = /** @type {{reviews?:ReviewTurn[]}} */ (response)?.reviews
      // Older endpoints may answer without review data; keep provenance unknown.
      if (!Array.isArray(list)) return
      const reviews = list
      const signature = reviewsSignature(reviews)
      const changed = signature !== state.reviewsSignature || state.reviewsError || !state.reviewsLoaded
      state.reviews = reviews
      state.reviewsLoaded = true
      state.reviewsSignature = signature
      state.reviewsError = false
      if (changed) paint()
    }).catch(() => {
      if (!current() || state.reviewsError) return
      state.reviewsError = true
      paint()
    })
  }
  let liveVersioned = false
  /** 长轮询回来的详情:结构没变就逐条补丁,补不上才整页重画。
   * @param {Detail} detail */
  const applyLiveDetail = detail => {
    if (!alive || !state.detail || !detail?.task || detail.task.id !== state.selectedId || desiredId) return
    const reconnected = state.detailDisconnected
    state.detailDisconnected = false
    const previousVersion = state.version
    const previous = state.detail
    const previousSignature = structuralSignature(previous)
    const previousArtifacts = artifactsSignature(previous)
    const changed = detail.events ?? []
    state.detail = { ...detail, events: mergeEvents(previous.events ?? [], changed) }
    // 中途不带 version 的响应会让长轮询停下来:同时收掉这面旗,3 秒那条腿才会真的接手重拉。
    if (typeof detail.version === 'number') state.version = detail.version
    else liveVersioned = false
    state.selectedArtifactId = chooseArtifactId(state.detail.artifacts ?? [], state.selectedArtifactId)
    if (state.preview && state.preview.artifactId !== state.selectedArtifactId) state.preview = null
    // 新的一轮快照会换掉成果清单;version 往前走了却没有新事件的那一次,多半是别的面(微信)改了
    // 标记 —— 这两种才去重拉。结构签名里还有 runtime、权限、输入回执这些跟改动记录无关的东西,
    // 拿它当重拉的理由等于每次前后台切换都白问一趟,所以这里只认成果自己的签名。
    // 逐字流的每一小段不必问,长轮询等到超时空手回来(version 原地不动)更不必问。
    const advanced = typeof detail.version === 'number' ? detail.version !== previousVersion : true
    const restructured = structuralSignature(state.detail) !== previousSignature
    if (artifactsSignature(state.detail) !== previousArtifacts) state.reviewsLoaded = false
    if (artifactsSignature(state.detail) !== previousArtifacts || (advanced && !changed.length)) loadReviews(detail.task.id)
    if (restructured || reconnected) { paint(true); return }
    if (!changed.length) { syncPaintSnapshot(); return }
    // 第一条事件要顶掉「还没有对话记录」那句:那不是补丁干得了的事。
    if (!(previous.events ?? []).length || !deps.patchLive?.(changed)) { paint(true); return }
    syncPaintSnapshot()
  }
  const livePoll = createLongPoll({
    fetchDetail: (id, since, waitMs) => v1(deps.invokeWorkbenchApi, V1.workbench.task, { query: { id: id, since: since, wait_ms: waitMs } }),
    onDetail: detail => applyLiveDetail(/** @type {Detail} */ (detail)),
    // A healthy list says nothing about whether this task is still updating.
    onError: () => {
      if (!alive || !state.detail || desiredId || state.detailDisconnected) return
      state.detailDisconnected = true
      paint(true)
    },
  })
  /** @param {string|null} [cursor] */
  const listQuery = cursor => {
    const params = new URLSearchParams()
    if (state.query?.q) params.set('q', state.query.q)
    if (state.query?.archived && state.query.archived !== 'exclude') params.set('archived', state.query.archived)
    if (cursor) params.set('cursor', cursor)
    return params
  }
  /** @param {string|null} [cursor] */
  const listTasks = cursor => v1(deps.invokeWorkbenchApi, V1.workbench.list, { query: listQuery(cursor) })
  /** @param {Task[]} tasks */
  const dedupe = tasks => [...new Map(tasks.map(task => [task.id, task])).values()]
  return {
    state,
    getTargetTaskId() { return desiredId ?? state.selectedId },
    /** @param {{force?:boolean}} [options] */
    async refresh({ force = false } = {}) {
      if (!alive) return
      if (force) state.loadingMore = false
      if (state.loadingMore) {
        if (state.selectedId && !desiredId && (force || !livePoll.active)) await this.selectTask(state.selectedId)
        return
      }
      const request = ++listRequest
      /** @type {ListResult} */
      let result
      let pages = 1
      try {
        result = /** @type {ListResult} */ (await listTasks())
        if (!alive || request !== listRequest) return
        while (pages < loadedPages && result.page?.hasMore && result.page.nextCursor) {
          const next = /** @type {ListResult} */ (await listTasks(result.page.nextCursor))
          if (!alive || request !== listRequest) return
          result = { ...next, tasks: dedupe([...result.tasks, ...next.tasks]), projectProviders: { ...result.projectProviders, ...next.projectProviders }, agentNames: { ...result.agentNames, ...next.agentNames } }
          pages++
        }
      }
      catch (error) { if (!alive || request !== listRequest) return; throw error }
      if (!alive || request !== listRequest) return
      loadedPages = pages
      Object.assign(state, result, { tasks: dedupe(result.tasks), page: result.page, projectProviders: result.projectProviders ?? {} })
      state.error = ''
      if (desiredId) paint()
      // 选中任务的详情归长轮询管;列表这条腿只管列表,免得每 3 秒把流打断一次。
      else if (state.selectedId && livePoll.active && !force) paint()
      else if (state.selectedId) await this.selectTask(state.selectedId)
      else if (!composingNewTask && (preferredInitialId || state.tasks[0]?.id)) {
        const target = preferredInitialId || state.tasks[0]?.id
        preferredInitialId = null
        if (target) await this.selectTask(target)
      }
      else paint()
    },
    async loadMore() {
      if (!alive || state.loadingMore || !state.page?.hasMore || !state.page.nextCursor) return
      const request = ++listRequest
      const cursor = state.page.nextCursor
      state.loadingMore = true
      paint()
      try {
        const result = /** @type {ListResult} */ (await listTasks(cursor))
        if (!alive || request !== listRequest) return
        state.tasks = dedupe([...state.tasks, ...result.tasks])
        state.page = result.page
        state.projectProviders = { ...state.projectProviders, ...result.projectProviders }
        state.agentNames = { ...state.agentNames, ...result.agentNames }
        state.error = ''
        loadedPages++
      } catch (error) { if (!alive || request !== listRequest) return; throw error }
      finally { if (alive && request === listRequest) { state.loadingMore = false; paint() } }
    },
    /** @param {TaskQuery} query */
    async filterTasks(query) {
      listRequest++
      loadedPages = 1
      state.query = { q: query.q.trim().slice(0, 200), archived: query.archived }
      state.tasks = []
      state.page = undefined
      state.projectProviders = {}
      state.loadingMore = false
      paint()
      await this.refresh()
    },
    /** @param {string} id */
    async selectTask(id) {
      if (state.selectedId !== id) forgetReviews()
      livePoll.stop()
      desiredId = id
      composingNewTask = false
      const request = ++detailRequest
      if (!state.detail) { state.loadingId = id; paint() }
      /** @type {Detail} */
      let result
      try { result = /** @type {Detail} */ (await v1(deps.invokeWorkbenchApi, V1.workbench.task, { query: { id: id } })) }
      catch (error) {
        if (!alive || request !== detailRequest || desiredId !== id) return
        desiredId = null
        state.loadingId = null
        throw error
      }
      if (!alive || request !== detailRequest || desiredId !== id) return
      if (state.selectedId !== id) { state.previewOpen = false; state.preview = null; state.selectedArtifactId = null }
      state.selectedId = id
      desiredId = null
      state.loadingId = null
      if (artifactsSignature(state.detail) !== artifactsSignature(result)) state.reviewsLoaded = false
      state.detail = result
      state.detailDisconnected = false
      state.selectedArtifactId = chooseArtifactId(result.artifacts ?? [], state.selectedArtifactId)
      if (state.preview && state.preview.artifactId !== state.selectedArtifactId) state.preview = null
      state.error = ''
      paint()
      loadReviews(id)
      // since 永远取上一次响应里的 version:后台回卷最多重放一行,不会漏。
      // 旧后台不带 version,就退回 3 秒重拉。
      liveVersioned = typeof result.version === 'number'
      state.version = liveVersioned ? Number(result.version) : 0
      if (liveVersioned) livePoll.start(id, state.version)
    },
    /** @param {string} [path] */
    newTask(path) { detailRequest++; livePoll.stop(); forgetReviews(); desiredId = null; composingNewTask = true; state.newScope = path ? `new:${path}` : 'new'; state.selectedId = null; state.loadingId = null; state.detail = null; state.selectedArtifactId = null; state.previewOpen = false; state.preview = null; paint() },
    destroy() { alive = false; livePoll.stop(); detailRequest++; listRequest++ },
    /** 面板被藏起来时停掉这条长连接,重新露面再接上。 */
    liveActive: () => livePoll.active,
    stopLive: () => livePoll.stop(),
    resumeLive: () => { if (alive && liveVersioned && state.selectedId && !desiredId && !livePoll.active) livePoll.start(state.selectedId, state.version ?? 0) },
    paint,
  }
}

/** @param {string} base64 */
function decodeBase64(base64) {
  const bytes = atob(base64); const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i)
  return out
}

/** @param {string} id */
function input(id) { return /** @type {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|null} */ (document.getElementById(id)) }

/** @param {HTMLElement} root */
export function syncWorkbenchProviderLabel(root) {
  const select = /** @type {HTMLSelectElement|null} */ (root.querySelector('#wb-provider'))
  const label = root.querySelector('#wb-options summary span')
  if (label) label.textContent = `当前使用 ${select?.selectedOptions?.[0]?.textContent || '尚未选择服务'}`
}

/** @param {WorkbenchDeps} deps */
export function initWorkbenchPage(deps) {
  stopWorkbenchPolling()
  const root = document.getElementById('workbench-root')
  if (!root) return
  /** @type {Set<string>} */
  const busy = new Set()
  let forking = false
  let alive = true
  let handoffCleanup = /** @type {(()=>void)|null} */ (null)
  let quotaHandoffCleanup=/** @type {(()=>void)|null} */(null)
  let nativeHistoryCleanup = /** @type {(()=>void)|null} */ (null)
  let artifactRequest = 0
  let navigationGeneration = 0
  /** @type {string|null} */
  let objectUrl = null
  /** @type {string|null} */
  let hostedPreviewId = null
  let pdfHost = /** @type {HTMLElement|null} */ (null)
  let pdfCleanup = /** @type {(()=>void)|null} */ (null)
  const releaseHostedPreview = () => {
    const id = hostedPreviewId; hostedPreviewId = null
    if (id && deps.invoke) void deps.invoke('release_workbench_html_preview', {id}).catch(() => {})
  }
  let attachmentPreviewCleanup=/** @type {(()=>void)|null} */(null)
  let attachmentPreviewRequest = 0
  const initialScope = resumeScope
  let searchDraft = resumeSearch
  let renderedScope = initialScope ?? 'new'
  let hasPainted = false
  const interactions = createWorkbenchInteractions({ invokeWorkbenchApi: deps.invokeWorkbenchApi, storage: windowStorage, inputAttempts: pageInputAttempts, changed: () => { if (alive) controller.paint(true) } })
  /** @type {Map<string, Map<string, boolean>>} */
  const disclosures = new Map()
  /** Sidebar folding belongs to this page, independently of the selected task. @type {Map<string,boolean>} */
  const sidebarDisclosures = new Map()
  /** Explicit artifact choices survive progress → answer transitions. @type {Map<string,boolean>} */
  const artifactDisclosureChoices = new Map()
  // A first completed-task visit waits for review provenance before discovering results.
  // User interaction cancels this one-time positioning; streaming transitions never enter it.
  /** Default reading position while provenance is pending. @type {Map<string,number>} */
  const pendingOutcomeDiscovery = new Map()
  let renderedSidebarSearch = false
  /** @type {Map<string, number>} */
  const scrollPositions = new Map()
  /** @type {Map<string,{signature:string,following:boolean,unread:boolean}>} */
  const reading = new Map()
  /** @type {Map<string,import('./workbench-timeline.js').TimelineAnchor>} */
  const readingAnchors = new Map()
  const atEnd = (/** @type {Element|null} */ element) => !!element && element.clientHeight > 0 && element.scrollHeight - element.clientHeight - element.scrollTop <= 48
  const showReadingNotice = () => {
    const bar = /** @type {HTMLElement|null} */ (root.querySelector('.wb-reading-bar'))
    if (bar) bar.hidden = !reading.get(renderedScope)?.unread
  }
  /** @type {Map<string, {signature:string,scrollTop:number}>} */
  const permissionScrollPositions = new Map()
  /** @type {Map<string, number>} */
  const taskInfoScrollPositions = new Map()
  /** @type {Map<string,number>} */
  const resultReturnPositions = new Map()
  // 正在看 diff 也算在翻结果:这时候流进来的新行不该把视线拽走。
  const browsingResults = () => !!root.querySelector('.wb-artifact-panel') || !!root.querySelector('#wb-artifacts[open]') || !!root.querySelector('#wb-review[open]') || !!root.querySelector('[data-timeline-disclosure][open]') || resultReturnPositions.has(renderedScope) || hasLiveTimelineInteraction(root)
  const scopeFor = (/** @type {WorkbenchState} */ state) => state.selectedId ? `task:${state.selectedId}` : state.newScope ?? 'new'
  const readingSignatureFor = (/** @type {WorkbenchState} */ state) => state.detail ? JSON.stringify([state.detail.task.status, state.detail.task.error, state.detail.task.writerExit ?? null, state.detail.events, state.detail.artifacts.map(a => [a.id, a.sha256])]) : ''
  const permissionSignatureFor = (/** @type {WorkbenchState} */ state) => JSON.stringify((state.detail?.permissions ?? []).filter(permission => permission.taskId === state.detail?.task.id).map(permission => permission.id).sort())
  const captureDraft = () => {
    captureWorkbenchQuestionDrafts(root, interactions)
    // 打回表单(勾选 + 意见)整个活在重画会被冲掉的 DOM 里:重画前先收回 state,渲染时再填回去。
    const open = controller.state.reviewReturnOpen
    const returnForm = open ? root.querySelector('.wb-review-return-form') : null
    if (open && returnForm) {
      // 跟发回时读的是同一处(表单自己),免得两边各读各的、对不上。
      const field = /** @type {HTMLTextAreaElement|null} */ (returnForm.querySelector?.('textarea[name="comment"]'))
      if (field) open.comment = field.value
      const boxes = /** @type {HTMLInputElement[]} */ (Array.from(returnForm.querySelectorAll?.('input[name="paths"]') ?? []))
      if (boxes.length) open.paths = [...new Set(boxes.filter(box => box.checked).map(box => box.value))]
      const lesson = /** @type {HTMLInputElement|null} */ (returnForm.querySelector?.('input[name="asLesson"]'))
      if (lesson) open.asLesson = lesson.checked
    }
    // 行评论的输入框 / 发出栏里那句总的意见:同理先收回 state
    const compose = controller.state.lineCompose
    // 只认同一条的输入框:刚换成另一条时,旧框还在 DOM 里,不能把它的字抄过去
    const composeField = compose ? /** @type {HTMLTextAreaElement|null} */ (root.querySelector('.wb-line-compose textarea[name="body"]')) : null
    if (compose && composeField && composeField.dataset.commentId === compose.commentId) compose.body = composeField.value
    const summaryField = /** @type {HTMLTextAreaElement|null} */ (root.querySelector('.wb-review-send textarea[name="summary"]'))
    if (summaryField && summaryField.value !== (controller.state.commentsSend?.summary ?? '')) controller.state.commentsSend = { ...(controller.state.commentsSend ?? {}), summary: summaryField.value }
    if (!document.getElementById('wb-create-form') && !document.getElementById('wb-project-form') && !input('wb-followup-text')) return
    const model=input('wb-model'),effort=input('wb-reasoning-effort'),draft=pageDrafts.get(renderedScope)
    const execution=model&&effort?{defaults:/** @type {'provider'|'native'} */(model.dataset.executionDefaults??draft.execution?.defaults??controller.state.detail?.execution?.defaults??'provider'),model:model.value||null,reasoningEffort:effort.value||null}:undefined
    // Chat metadata can paint first with an empty provider select. A real select
    // cannot hold its saved value until options arrive; that is not a user edit.
    const providerId = input('wb-provider')?.value || draft.providerId
    pageDrafts.set(renderedScope, { ...draft,...(execution?{execution}:{}), path: input('wb-path')?.value ?? '', text: input('wb-create-text')?.value ?? draft.text, title: input('wb-title')?.value ?? '', providerId, followup: input('wb-followup-text')?.value ?? '' })
  }
  const restoreDraft = (/** @type {string} */ scope) => {
    const draft = pageDrafts.get(scope)
    if(draft.execution){const model=input('wb-model'),effort=input('wb-reasoning-effort');if(model)model.value=draft.execution.model??'';if(effort)effort.value=draft.execution.reasoningEffort??''}
    for (const [id, value] of /** @type {Array<[string,string]>} */ ([['wb-path', draft.path], ['wb-create-text', draft.text], ['wb-title', draft.title], ['wb-provider', draft.providerId], ['wb-followup-text', draft.followup]])) {
      const field = input(id); if (field && value) field.value = value
    }
  }
  const thumbnails=createWorkbenchThumbnails({invoke:deps.invokeWorkbenchApi})
  const attachments=createWorkbenchAttachments({preview:thumbnails.local,removePreview:thumbnails.remove,drafts:pageDrafts,invokeWorkbenchApi:deps.invokeWorkbenchApi,changed:scope=>{if(alive&&scope===renderedScope)controller.paint(true)}})
  const attachmentPayload=(/** @type {Draft} */ draft)=>draft.attachments?.length?{attachmentIds:draft.attachments.map(a=>a.id),draftId:draft.draftId}:{}
  const executionContext=()=>{
    const detail=controller.state.detail
    return detail?{providerId:detail.task.providerId,path:detail.task.path}:{providerId:input('wb-provider')?.value??pageDrafts.get(renderedScope).providerId??controller.state.defaultProvider??'',path:input('wb-path')?.value??pageDrafts.get(renderedScope).path}
  }
  const catalogs=createExecutionCatalogs({invokeWorkbenchApi:deps.invokeWorkbenchApi,changed:(providerId,path)=>{const current=executionContext();if(alive&&current.providerId===providerId&&current.path===path&&controller.getTargetTaskId()===controller.state.selectedId)controller.paint(true)}})
  const loadExecutionCatalog=(retry=false)=>{if(!root.querySelector('#wb-options[open]')&&!root.querySelector('#wb-task-info[open]'))return;const {providerId,path}=executionContext();void catalogs.load(providerId,path,retry)}
  const executionPayload=(/** @type {Draft} */ draft)=>draft.execution?{execution:structuredClone(draft.execution)}:{}
  const restartPreviewContext=()=>{
    const detail=controller.state.detail
    if(!detail?.execution||detail.requiresExternalClose||detail.task.archivedAt!=null||['running','queued','cancelling'].includes(detail.task.status)||detail.continuation?.mode!=='restart_required'||controller.getTargetTaskId()!==detail.task.id)return null
    return{taskId:detail.task.id,version:detail.continuation.restart?.token??'',execution:pageDrafts.get(`task:${detail.task.id}`).execution??detail.execution}
  }
  const recoveryPreviews=createContinuationPreviews({invokeWorkbenchApi:deps.invokeWorkbenchApi,changed:context=>{const current=restartPreviewContext();if(alive&&current&&continuationPreviewKey(current)===continuationPreviewKey(context))controller.paint(true)}})
  /** 逐字流的增量:只把变过的行写回正在跑的那一组,不重画整页 —— 输入框、展开状态、
   * 正在读的位置都不动。补不上(找不到 live 组)就回 false,调用方整页重画。
   * @param {WorkbenchEvent[]} changed @returns {boolean} */
  const patchLive = changed => {
    if (!alive || !hasPainted || !controller.state.detail) return false
    if (renderedScope !== scopeFor(controller.state)) return false
    const content = root.querySelector('.wb-content')
    const following = atEnd(content) && !browsingResults()
    const result = patchLiveTimeline(root, changed, {
      eventId: workbenchTimelineEventId,
      message: renderMessageFor(workbenchMessageContext(controller.state)),
      operation: event => renderWorkbenchOperation(event, { escapeHtml: escapeWorkbenchHtml, formatTime: time }),
    })
    if (result.missing > 0) return false
    const current = reading.get(renderedScope)
    if (current) {
      current.signature = readingSignatureFor(controller.state)
      current.following = following
      current.unread = following ? false : current.unread || result.patched + result.appended + (result.deferred??0) > 0
    }
    if (following && content) content.scrollTop = content.scrollHeight
    thumbnails.mount(root)
    showReadingNotice()
    return true
  }
  const controller = createWorkbenchController({ invokeWorkbenchApi: deps.invokeWorkbenchApi, initialScope, initialQuery: resumeQuery, patchLive, render: state => {
    if (!alive) return
    if (hasPainted) { captureDraft(); searchDraft = input('wb-search')?.value ?? searchDraft }
    if (state.detail) {
      const taskScope = `task:${state.detail.task.id}`
      const acknowledged = interactions.acknowledgedInputDraft(state.detail.task.id, state.detail.inputs ?? [],pageDrafts.get(taskScope).attachments,pageDrafts.get(taskScope).execution)
      if (acknowledged !== null) {
        const draft = pageDrafts.get(taskScope)
        if (draft.followup === acknowledged) { draft.followup = ''; if(draft.attachments?.length){draft.attachments.forEach(a=>thumbnails.remove(a.id));draft.attachments=[]}; pageDrafts.set(taskScope, draft) }
        const field = input('wb-followup-text')
        if (renderedScope === taskScope && field?.value === acknowledged) field.value = ''
      }
    }
    const permissionFocus=capturePermissionFocus(root)
    const activeField = document.activeElement instanceof Element && root.contains(document.activeElement) && 'value' in document.activeElement
      ? /** @type {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} */ (document.activeElement)
      : null
    const focused = activeField
      ? { id: activeField.id, start: 'selectionStart' in activeField ? activeField.selectionStart : null, end: 'selectionEnd' in activeField ? activeField.selectionEnd : null }
      : null
    const focusedDisclosure = document.activeElement instanceof Element
      ? document.activeElement.closest('summary')?.parentElement?.id
      : null
    const nextScope = scopeFor(state)
    for (const disclosure of root.querySelectorAll?.('[data-sidebar-disclosure]') ?? []) {
      if (!renderedSidebarSearch || disclosure.id === 'wb-list-more') sidebarDisclosures.set(disclosure.id, disclosure.hasAttribute('open'))
    }
    if (nextScope !== renderedScope) {
      const selectedPath = state.detail?.task.workspaceKind === 'managed' ? '' : state.detail?.task.path ?? (state.newScope?.startsWith('new:') ? state.newScope.slice(4) : undefined)
      if (selectedPath !== undefined) sidebarDisclosures.set(projectDisclosureId(selectedPath), true)
    }
    const hasStoredScroll = scrollPositions.has(nextScope) || hasPainted && renderedScope === nextScope
    const openState = new Map(['wb-artifacts', 'wb-review', 'wb-options', 'wb-task-info', 'wb-restart-context', 'wb-artifact-source','wb-handoffs'].map(id => [id, !!root.querySelector(`#${id}[open]`)]))
    openState.set('wb-input-help', root.querySelector('#wb-input-help') ? !!root.querySelector('#wb-input-help[open]') : disclosures.get(renderedScope)?.get('wb-input-help') ?? false)
    if (root.querySelector('#wb-inputs')) openState.set('wb-inputs', !!root.querySelector('#wb-inputs[open]'))
    for (const disclosure of root.querySelectorAll?.('[data-review-disclosure]') ?? []) openState.set(disclosure.id, disclosure.hasAttribute('open'))
    for (const disclosure of root.querySelectorAll?.('[data-timeline-disclosure]') ?? []) openState.set(disclosure.id, disclosure.hasAttribute('open'))
    for (const disclosure of root.querySelectorAll?.('[data-user-source]') ?? []) openState.set(disclosure.id, disclosure.hasAttribute('open'))
    disclosures.set(renderedScope, openState)
    const oldContent = root.querySelector('.wb-content')
    const contentScroll = oldContent?.scrollTop ?? 0
    const previousReading = reading.get(renderedScope)
    if (previousReading) previousReading.following = atEnd(oldContent) && !browsingResults()
    const anchor = previousReading && !previousReading.following ? captureWorkbenchTimelineAnchor(root, oldContent) : null
    if (anchor) readingAnchors.set(renderedScope, anchor)
    else readingAnchors.delete(renderedScope)
    const nextReading = reading.get(nextScope) ?? { signature: '', following: true, unread: false }
    const signature = readingSignatureFor(state)
    const newActivity = signature !== nextReading.signature
    if (nextReading.signature && newActivity && !nextReading.following) nextReading.unread = true
    nextReading.signature = signature
    reading.set(nextScope, nextReading)
    const sidebarScroll = root.querySelector('.wb-sidebar')?.scrollTop ?? 0
    // A restored scope can exist before its first content; loading is not saved reading.
    if (hasPainted && oldContent) scrollPositions.set(renderedScope, contentScroll)
    const currentPermissionScroll = root.querySelector('.wb-permissions')?.scrollTop
    const currentPermissionState = permissionScrollPositions.get(renderedScope)
    if (currentPermissionScroll !== undefined && currentPermissionState) currentPermissionState.scrollTop = currentPermissionScroll
    const currentTaskInfoScroll = root.querySelector('.wb-task-info-body')?.scrollTop
    if (currentTaskInfoScroll !== undefined) taskInfoScrollPositions.set(renderedScope, currentTaskInfoScroll)
    const nextPermissionSignature = permissionSignatureFor(state)
    const sameScope = renderedScope === scopeFor(state)
    if (!sameScope) { releaseHostedPreview(); attachmentPreviewRequest++; attachmentPreviewCleanup?.() }
    const discoverOutcome = sameScope && pendingOutcomeDiscovery.has(nextScope) && contentScroll === pendingOutcomeDiscovery.get(nextScope) && !focused && !focusedDisclosure && !hasLiveTimelineInteraction(root)
    const timelineReading = sameScope ? captureTimelineReading(root) : null
    const questionPanelScroll = root.querySelector('.wb-questions')?.scrollTop ?? 0
    const nextDraft=pageDrafts.get(nextScope),providerId=state.detail?.task.providerId??nextDraft.providerId??state.defaultProvider??'',path=state.detail?.task.path??nextDraft.path
    const focusedPreviewAction = document.activeElement?.closest?.('.wb-artifact-panel') ? /** @type {HTMLElement} */ (document.activeElement).dataset.action : null
    const previousPreview = root.querySelector('#wb-preview')
    const previewScroll = previousPreview?.scrollTop ?? 0
    paintWorkbenchWithPreview(root, renderWorkbench(state, interactions,nextDraft,attachments.error(nextScope),{quotaAttempt:quotaHandoffAttempts.get(state.detail?.task.id??''),sidebarDisclosures,catalog:catalogs.get(providerId||state.defaultProvider||'',path),...(restartPreviewContext()?{restartPreview:recoveryPreviews.get(/** @type {import('./workbench-execution.js').ContinuationContext} */(restartPreviewContext()))}:{}),busy:busy.has(state.detail?`task:${state.detail.task.id}`:'create')}))
    const nextPreview = root.querySelector('#wb-preview')
    if (nextPreview && sameScope) nextPreview.scrollTop = previewScroll
    const nextPdfHost = /** @type {HTMLElement|null} */ (root.querySelector('#wb-preview .cc-pdf-reader'))
    if (nextPdfHost !== pdfHost) {
      pdfCleanup?.(); pdfCleanup = null; pdfHost = nextPdfHost
      if (nextPdfHost && state.preview?.pdfData) pdfCleanup = mountPdfReader(nextPdfHost, state.preview.pdfData, state.detail?.artifacts.find(a => a.id === state.preview?.artifactId)?.name ?? 'PDF')
    }
    thumbnails.mount(root)
    renderedSidebarSearch = !!state.query?.q
    const questionPanel = root.querySelector('.wb-questions')
    if (questionPanel && sameScope) questionPanel.scrollTop = questionPanelScroll
    hasPainted = true
    const search = input('wb-search'); if (search) search.value = searchDraft
    const sidebar = root.querySelector('.wb-sidebar'); if (sidebar) sidebar.scrollTop = sidebarScroll
    for (const [id, open] of disclosures.get(scopeFor(state)) ?? []) {
      if (id === 'wb-artifacts' && root.querySelector('#wb-artifacts.is-outcome') && !artifactDisclosureChoices.has(nextScope)) continue
      root.querySelector(`#${id}`)?.toggleAttribute('open', open)
    }
    const artifactChoice = artifactDisclosureChoices.get(nextScope)
    if (artifactChoice !== undefined) root.querySelector('#wb-artifacts')?.toggleAttribute('open', artifactChoice)
    restoreTimelineReading(root,timelineReading)
    const content = root.querySelector('.wb-content')
    if (content) {
      const resultReady = !!root.querySelector('#wb-artifacts.is-outcome[open]')
      const firstOutcome = resultReady && !hasStoredScroll
      const resolvedDiscovery = discoverOutcome && (state.reviewsLoaded || state.reviewsError)
      const showOutcome = firstOutcome || resolvedDiscovery && resultReady
      const follow = !showOutcome && nextScope.startsWith('task:') && nextReading.following && (newActivity || !sameScope || resolvedDiscovery)
      content.scrollTop = showOutcome ? 0 : follow ? content.scrollHeight : hasStoredScroll ? (scrollPositions.get(nextScope) ?? 0) : nextScope.startsWith('task:') ? content.scrollHeight : 0
      // Until provenance arrives, an answered task still opens at its latest reply.
      // Remember that default position so a real scroll cancels later result discovery.
      if (!hasStoredScroll && state.reviewsLoaded === false && state.detail?.artifacts.length && root.querySelector('[data-task-focus="outcome"]')) pendingOutcomeDiscovery.set(nextScope, content.scrollTop)
      if (state.reviewsLoaded || state.reviewsError) pendingOutcomeDiscovery.delete(nextScope)
      if (follow) nextReading.unread = false
      else if (!showOutcome && !nextReading.following) {
        restoreWorkbenchTimelineAnchor(root, content, readingAnchors.get(nextScope))
        scrollPositions.set(nextScope, content.scrollTop)
      }
    }
    const permissionPanel = root.querySelector('.wb-permissions')
    if (permissionPanel) {
      const saved = permissionScrollPositions.get(nextScope)
      const scrollTop = saved?.signature === nextPermissionSignature ? saved.scrollTop : 0
      permissionPanel.scrollTop = scrollTop
      permissionScrollPositions.set(nextScope, { signature: nextPermissionSignature, scrollTop })
    } else permissionScrollPositions.delete(nextScope)
    const taskInfoBody = root.querySelector('.wb-task-info-body')
    if (taskInfoBody) taskInfoBody.scrollTop = taskInfoScrollPositions.get(nextScope) ?? 0
    renderedScope = scopeFor(state)
    if (!state.loadingId) saveWorkbenchView(windowStorage,{scope:renderedScope,query:state.query ?? {q:'',archived:'exclude'},search:searchDraft})
    showReadingNotice()
    restoreDraft(renderedScope)
    syncWorkbenchProviderLabel(root)
    const preparing=restartPreviewContext()
    if(preparing)queueMicrotask(()=>{const current=restartPreviewContext();if(alive&&current&&continuationPreviewKey(current)===continuationPreviewKey(preparing))void recoveryPreviews.load(current)})
    if (focusedDisclosure && sameScope) {
      const summary = /** @type {HTMLElement|null} */ (root.querySelector(`#${focusedDisclosure} > summary`))
      summary?.focus({ preventScroll: true })
    }
    const nextFocus = focused && sameScope ? input(focused.id) : null
    if(permissionFocus&&sameScope)restorePermissionFocus(root,permissionFocus)
    else if (focusedPreviewAction && sameScope) /** @type {HTMLElement|null} */ (root.querySelector(`.wb-artifact-panel [data-action="${focusedPreviewAction}"]`))?.focus({preventScroll:true})
    else if (nextFocus) { nextFocus.focus({ preventScroll: true }); if (focused && focused.start !== null && focused.end !== null && 'setSelectionRange' in nextFocus) nextFocus.setSelectionRange(focused.start, focused.end) }
  } })
  /** @param {unknown} error */
  const recoveryCode = (/** @type {unknown} */ error) => String(error).match(/\brestart_confirmation_(required|stale)\b/)?.[1]
  /** @param {unknown} error */
  const fail = error => {
    if (!alive) return
    const executionError=executionErrorMessage(error)
    if(executionError){controller.state.error=executionError;controller.paint();return}
    const message = error instanceof Error ? error.message : String(error)
    if(/external_close_confirmation_stale|native_history_changed/.test(message))controller.state.nativeResume=null
    const nativeErrors=/** @type {Record<string,string>} */({'external_close_confirmation_required':'请先确认原执行程序已关闭，再从这里继续。','external_close_confirmation_stale':'原会话或恢复信息已更新。任务尚未开始，请重新点击继续。','native_session_busy':'这条会话或文件夹仍被另一项任务占用，请先结束原任务。','native_session_identity_mismatch':'原工具返回了另一条会话，CC 已停止处理并保留原记录。','native_history_changed':'原会话记录已更新，请重新打开确认。','native_history_unsupported':'当前版本不支持读取这类原会话。','native_history_unavailable':'暂时读不到原会话，记录仍然保留，请稍后重试。'})
    if(nativeErrors[message]){controller.state.error=nativeErrors[message];controller.paint();return}
    const recovery = recoveryCode(error)
    controller.state.error = recovery === 'stale' ? '记录已更新，尚未重新开始。请核对新的恢复内容。'
      : recovery === 'required' ? '原会话无法恢复，任务尚未开始。请查看恢复说明后再决定。'
        : /\bworkbench_archived\b/.test(message) ? '这项任务已归档，恢复后可继续。'
          : ['HTTP 404','workbench_endpoint_missing'].includes(message) ? '当前运行的后台还没有提供这个接口，请更新后台后重试。' : message === 'workbench_read_only_preview' ? '当前预览只允许查看任务，请使用已启用执行的桌面端。' : message === 'workbench_connection_unavailable' ? '暂时连不上任务服务，请检查后台是否运行。' : message
    controller.paint()
  }
  /** @param {string} filename @param {string} mime @param {Uint8Array} bytes
   * @param {Element|null} button @param {Element|null} [status] */
  const saveDownload = async (filename, mime, bytes, button, status = null) => {
    if (button instanceof HTMLButtonElement && button.disabled) return
    if (button instanceof HTMLButtonElement) button.disabled = true
    if (status) status.textContent = ''
    const report = (/** @type {string} */ message) => {
      if (!alive) return
      if (status?.isConnected) status.textContent = message
      else showToast(message)
    }
    try {
      const path = await saveFile(deps, filename, mime, bytes)
      if (path) report(`已保存到「下载」：${path.split(/[\\/]/).pop()}`)
    } catch {
      report('下载失败，请重试。')
    } finally {
      if (button instanceof HTMLButtonElement) button.disabled = false
    }
  }
  const confirmUnattended = deps.confirmUnattended ?? (() => mountUnattendedDialog())
  const confirmScripts = deps.confirmScripts ?? (config => mountScriptsApproveDialog(config))
  /** 第一次把事交给免审执行者时后台回 428。当面确认一次,登记下来,再把同一份请求
   * 原样重发;主人说「先不用」就到此为止,不当成出错。
   * @param {'GET'|'POST'} method @param {string} path @param {Record<string,unknown>} body */
  const sendMutation = async (method, path, body) => {
    try { return /** @type {{task?:Task}} */ (await deps.invokeWorkbenchApi(method, path, body)) }
    catch (error) {
      if (!isAckRequiredError(error)) throw error
      if (!(await confirmUnattended()) || !alive) return null
      await v1(deps.invokeWorkbenchApi, V1.workbench.unattendedAck)
      return /** @type {{task?:Task}} */ (await deps.invokeWorkbenchApi(method, path, body))
    }
  }
  /** onError 让调用方自己接住一类错误(打回遇上「要重开」就是这样):回 true 表示这一笔已经
   * 当场交代清楚了,别再往全局那条错误里塞一句看不懂的话。
   * @param {import('../daemon-client.js').V1Key} call @param {Record<string,unknown>} body
   * @param {(error:unknown)=>boolean|Promise<boolean>} [onError] @param {(result:unknown)=>void} [onResult] 成功时先看一眼回来的结果(发评论要报发了几条) */
  const mutate = async (call, body, onError, onResult) => {
    const { method, path } = v1Request(call)
    const key = call === V1.workbench.create ? 'create' : `task:${String(body.id ?? '')}`
    if (busy.has(key) || !alive) return false
    busy.add(key);controller.paint(true)
    const navigation = navigationGeneration
    try {
      const result = await sendMutation(method, path, body)
      if (!alive || !result) return false
      onResult?.(result)
      const id = result.task?.id ?? controller.state.selectedId
      await controller.refresh({ force: true })
      if (alive && call === V1.workbench.create && navigation === navigationGeneration && id && controller.state.selectedId !== id) await controller.selectTask(id)
      return alive
    } catch (e) {
      if (alive && navigation === navigationGeneration) {
        if (recoveryCode(e)) {
          try { await controller.refresh() } catch { /* Preserve the actionable recovery error and the draft. */ }
        }
        let handled = false
        if (alive && navigation === navigationGeneration && onError) handled = (await onError(e)) === true
        if (alive && navigation === navigationGeneration && !handled) fail(e)
      }
      return false
    } finally { busy.delete(key);if(alive)controller.paint(true) }
  }
  let rewindRequest = 0
  /** 拉一遍回退预览,结果放进确认块;换了任务 / 点了「算了」就丢掉。
   * @param {{artifactId:string,to:'start'|'end',round:number}} target @param {string} [notice] */
  const loadRewindPreview = async (target, notice) => {
    const id = controller.state.selectedId
    if (!id || !alive) return
    const request = ++rewindRequest
    const keep = notice ? { notice } : {}
    controller.state.rewindOpen = { ...target, status: 'loading', ...keep }
    controller.paint(true)
    /** @type {import('./workbench-rewind.js').RewindOpen} */
    let next
    try {
      const result = /** @type {{preview?:import('./workbench-rewind.js').RewindPreview}} */ (await v1(deps.invokeWorkbenchApi, V1.workbench.rewindPreview, { query: { id: id, artifactId: target.artifactId, to: target.to } }))
      next = result?.preview ? { ...target, status: 'ready', preview: result.preview, ...keep } : { ...target, status: 'error', error: '暂时读不到回退预览，请稍后再试。' }
    } catch (error) {
      next = { ...target, status: 'error', error: rewindErrorMessage(error) ?? String(error instanceof Error ? error.message : error) }
    }
    if (!alive || request !== rewindRequest || controller.state.selectedId !== id) return
    controller.state.rewindOpen = next
    controller.paint(true)
  }
  /** 撤销回退 / 拍板被拒:认得的码说成人话放进全局那条错误;认不出交给 fail。
   * @param {unknown} e */
  const rewindFailure = e => {
    const message = rewindErrorMessage(e)
    if (!message) return false
    fail(new Error(message))
    return true
  }
  const openTask = async (/** @type {string} */ id) => {
    if (!alive || !id) return
    captureDraft();quotaHandoffCleanup?.();quotaHandoffCleanup=null; artifactRequest++
    const navigation = ++navigationGeneration
    try { await controller.selectTask(id) }
    catch (error) { if (alive && navigation === navigationGeneration) fail(error) }
  }
  const refreshInteraction = async (/** @type {string} */ taskId, /** @type {number} */ navigation) => {
    if (!alive || navigation !== navigationGeneration || controller.getTargetTaskId() !== taskId) return
    try { await controller.refresh({ force: true }) }
    catch { /* The acknowledged receipt remains visible; ordinary polling can reconnect. */ }
  }
  const answerQuestion = async (/** @type {string|undefined} */ taskId, /** @type {string|undefined} */ requestId, decline = false) => {
    if (!taskId || controller.getTargetTaskId() !== taskId) return
    const request = controller.state.detail?.questions?.find(item => item.taskId === taskId && item.id === requestId)
    if (!request) return
    captureDraft()
    const navigation = navigationGeneration
    if (await interactions.answer(request, decline)) await refreshInteraction(taskId, navigation)
  }
  /** 行评论 / 按块撤回被拒:认得的码说成人话。
   * @param {unknown} error @returns {string|null} */
  const lineErrorMessage = error => {
    const code = String(error instanceof Error ? error.message : error).match(/\b(review_file_changed|review_hunk_stale|review_revert_unavailable|review_comment_limit|workbench_busy|review_round_discarded|rewind_needs_owner|review_comment_sent|review_comment_conflict|review_comment_not_found)\b/)?.[1]
    return code ? LINE_ERRORS[code] ?? null : null
  }
  /** @param {HTMLElement} row @param {boolean} extend */
  const selectLine = (row, extend) => {
    const box = /** @type {HTMLElement|null} */ (row.closest('[data-review-lines]'))
    const block = /** @type {HTMLElement|null} */ (row.closest('[data-review-hunk]'))
    const artifactId = box?.dataset.artifactId, path = box?.dataset.path
    const hunk = Number(row.dataset.hunk), at = Number(row.dataset.row)
    if (!artifactId || !path || !Number.isInteger(hunk) || !Number.isInteger(at)) return
    const view = controller.state.reviews?.find(turn => turn.artifactId === artifactId)?.files.find(file => file.path === path)?.hunks?.find(h => h.index === hunk)
    if (!view || (block && block.dataset.reviewHunk !== String(hunk))) return
    captureDraft()
    const current = controller.state.lineSelect
    const same = current && current.artifactId === artifactId && current.path === path && current.hunk === hunk
    if (extend && same) {
      // Shift 点会顺手拉出一段文字选区:清掉,只留行选区
      try { window.getSelection?.()?.removeAllRanges() } catch { /* 没有选区可清 */ }
      const anchor = current.anchor
      let start = Math.min(anchor, at), end = Math.max(anchor, at)
      if (end - start + 1 > LINE_MAX_ROWS) { if (at > anchor) end = anchor + LINE_MAX_ROWS - 1; else start = anchor - LINE_MAX_ROWS + 1 }
      controller.state.lineSelect = { ...current, rowStart: start, rowEnd: end }
    } else if (same && current.rowStart === at && current.rowEnd === at) controller.state.lineSelect = null
    else controller.state.lineSelect = { artifactId, path, hunk, hunkSha256: view.sha256, anchor: at, rowStart: at, rowEnd: at }
    controller.paint(true)
  }
  /** 打开行下的输入框;正在写的那条还有字 ⇒ 不顶掉它。
   * @param {import('./workbench-review-panel.js').LineCompose} next */
  const openCompose = next => {
    captureDraft()
    const current = controller.state.lineCompose
    if (current && current.body.trim() && current.commentId !== next.commentId) return fail(new Error('先存好或取消正在写的那条评论。'))
    controller.state.lineCompose = next
    controller.paint(true)
    input('wb-line-compose-body')?.focus({ preventScroll: true })
  }
  /** @param {string} action @param {HTMLElement} target */
  const onLineAction = async (action, target) => {
    const id = controller.state.selectedId
    if (!id) return
    if (action === 'line-select-clear') { controller.state.lineSelect = null; controller.paint(true); return }
    if (action === 'line-comment-cancel') { controller.state.lineCompose = null; controller.paint(true); return }
    if (action === 'line-comment-open') {
      const select = controller.state.lineSelect
      if (!select) return
      controller.state.lineSelect = null
      // id 在客户端生成:网络断了重存一次 ⇒ 同一个 id,后台按幂等回原行
      return openCompose({ artifactId: select.artifactId, path: select.path, hunk: select.hunk, hunkSha256: select.hunkSha256, rowStart: select.rowStart, rowEnd: select.rowEnd, commentId: crypto.randomUUID(), body: '' })
    }
    const { artifactId, path } = target.dataset, hunk = Number(target.dataset.hunk), hunkSha256 = target.dataset.hunkSha
    if (action === 'line-comment-hunk' && artifactId && path && Number.isInteger(hunk) && hunkSha256) return openCompose({ artifactId, path, hunk, hunkSha256, commentId: crypto.randomUUID(), body: '' })
    const commentId = target.dataset.commentId
    if ((action === 'line-comment-edit' || action === 'line-comment-delete') && commentId) {
      /** @type {{turn:ReviewTurn,file:import('../../../../src/features/workbench/review').ReviewTurnFile,comment:import('./workbench-review-panel.js').ReviewCommentView}|null} */
      let found = null
      for (const turn of controller.state.reviews ?? []) for (const file of turn.files ?? []) for (const comment of file.comments ?? []) if (comment.id === commentId) found = { turn, file, comment }
      if (!found || found.comment.state !== 'draft') return
      if (action === 'line-comment-edit') return openCompose({ artifactId: found.turn.artifactId, path: found.file.path, hunk: found.comment.hunk, commentId, body: found.comment.body, edit: true })
      if (!armConfirm(target, '再点一次：删掉这条')) return
      const done = await mutate(V1.workbench.reviewComment, { id, commentId, delete: true }, e => { const message = lineErrorMessage(e); if (!message) return false; fail(new Error(message)); return true })
      if (done && controller.state.lineCompose?.commentId === commentId) { controller.state.lineCompose = null; controller.paint(true) }
      return
    }
    // 按块撤回 / 恢复:点两下才算(恢复就是退路);被拒的原因说成人话
    const hunkAction = target.dataset.hunkAction
    if (action === 'review-hunk' && artifactId && path && Number.isInteger(hunk) && hunkSha256 && (hunkAction === 'revert' || hunkAction === 'restore')) {
      if (!armConfirm(target, hunkAction === 'revert' ? '再点一次：撤回这一块' : '再点一次：恢复这一块')) return
      return mutate(V1.workbench.reviewHunk, { id, artifactId, path, hunk, hunkSha256, action: hunkAction }, e => {
        const message = lineErrorMessage(e)
        if (!message) return false
        fail(new Error(message))
        return true
      })
    }
  }
  /** @param {Event} event */
  const onClick = async event => {
    pendingOutcomeDiscovery.delete(renderedScope)
    // Capture before the summary's default toggle, including keyboard activation.
    const summary=event.target instanceof Element?event.target.closest('#wb-artifacts > summary'):null
    if(summary)artifactDisclosureChoices.set(renderedScope,!summary.parentElement?.hasAttribute('open'))
    if(summary&&!summary.parentElement?.hasAttribute('open')&&!resultReturnPositions.has(renderedScope))resultReturnPositions.set(renderedScope,root.querySelector('.wb-content')?.scrollTop??0)
    // 收起也在点的这一刻放掉(2026-10-06):toggle 是异步的,连点两下还会被合并成一个、甚至在下一次滚动之后才到,
    // 只靠它放掉的话,收起后紧接着的那次滚动仍算「在翻成果」⇒ 停在底部也不跟新回复。
    else if(summary&&summary.parentElement?.hasAttribute('open'))resultReturnPositions.delete(renderedScope)
    const target = event.target instanceof Element ? event.target.closest('button') : null
    // 行评论(2026-10-21):点一行选中,Shift 点扩到同一块里(≤ 40 行);再点同一行取消
    const lineRow = !target && event.target instanceof Element ? /** @type {HTMLElement|null} */ (event.target.closest('[data-row]')) : null
    if (lineRow) return selectLine(lineRow, !!(/** @type {MouseEvent} */ (event).shiftKey))
    if (!target) return
    if (target.dataset.taskId) return openTask(target.dataset.taskId)
    let action = target.dataset.action
    const reloadLivePreview = action === 'refresh-artifact'
    if (action === 'show-decisions') {
      const panel = root.querySelector('.wb-permissions,.wb-questions')
      panel?.scrollIntoView({block:'nearest'})
      const control = /** @type {HTMLElement|null|undefined} */ (panel?.querySelector('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)'))
      control?.scrollIntoView({block:'nearest'})
      control?.focus({preventScroll:true})
      return
    }
    if(action==='choose-attachments'){
      captureDraft();const scope=renderedScope
      const picker=document.createElement('input');picker.type='file';picker.multiple=true
      picker.addEventListener('change',()=>{void attachments.add(scope,Array.from(picker.files??[]))},{once:true})
      picker.click();return
    }
    if(action==='retry-continuation-preview'){const context=restartPreviewContext();if(context)void recoveryPreviews.load(context,true);return}
    if(action==='retry-execution-models'){loadExecutionCatalog(true);return}
    if(action==='choose-task-model'){const info=root.querySelector('#wb-task-info');if(info instanceof HTMLDetailsElement){info.open=true;loadExecutionCatalog();const model=root.querySelector('#wb-model');if(model instanceof HTMLElement)model.focus()}return}
    if(action==='remove-attachment'&&target.dataset.attachmentId){captureDraft();attachments.remove(renderedScope,target.dataset.attachmentId);if(controller.state.selectedId)interactions.editInputDraft(controller.state.selectedId,input('wb-followup-text')?.value??'',pageDrafts.get(renderedScope).attachments,pageDrafts.get(renderedScope).execution);return}
    if((action==='preview-input-attachment'||action==='download-input-attachment'||action==='preview-image-artifact')&&(target.dataset.attachmentId||target.dataset.artifactId)){
      if(target.dataset.thumbnailId)thumbnails.retry(target)
      const taskId=target.dataset.ownerTask,id=target.dataset.attachmentId||target.dataset.artifactId,navigation=navigationGeneration
      const previewRequest = action === 'download-input-attachment' ? 0 : ++attachmentPreviewRequest
      if(!taskId||!id||controller.getTargetTaskId()!==taskId)return
      try{
        const data=action==='preview-image-artifact'?await (async()=>{const result=/** @type {{name:string,mime:string,size:number,sha256:string,contentBase64:string}} */(await v1(deps.invokeWorkbenchApi, V1.workbench.artifact, { query: { id: taskId, artifactId: id } }));return{attachment:{id,...result},base64:result.contentBase64}})():/** @type {{attachment:import('./workbench-attachments.js').Attachment,base64:string}} */(await v1(deps.invokeWorkbenchApi, V1.workbench.attachment, { query: { taskId: taskId, id: id } }))
        if(!alive||navigation!==navigationGeneration||controller.state.selectedId!==taskId||(previewRequest && previewRequest!==attachmentPreviewRequest))return
        if(data.attachment.id!==id)throw Error('附件版本不匹配，请重新打开。')
        const a=data.attachment,bytes=decodeBase64(data.base64),url=URL.createObjectURL(new Blob([bytes],{type:a.mime}))
        const download=(/** @type {Element|null} */ button,/** @type {Element|null} */ status=null)=>saveDownload(a.name,a.mime,bytes,button,status)
        if(action==='download-input-attachment'){await download(target);setTimeout(()=>URL.revokeObjectURL(url),1000);return}
        attachmentPreviewCleanup?.()
        const dialog=document.createElement('dialog');dialog.className='wb-history-dialog wb-input-preview';dialog.setAttribute('aria-label',a.name)
        const body=a.mime.startsWith('image/')?`<img src="${url}" alt="${escapeWorkbenchHtml(a.name)}">`:a.mime==='application/pdf'?renderPdfReader(`attachment:${a.id}`,a.name):a.mime.startsWith('text/')||a.mime==='application/json'?renderWorkbenchArtifactText(a.name,a.mime,new TextDecoder().decode(bytes)):'<p>下载后可在本机应用中查看。</p>'
        dialog.innerHTML=`<header><h2>${escapeWorkbenchHtml(a.name)}</h2><button type="button" class="wb-new" data-close-attachment>关闭</button></header><div class="wb-input-preview-body">${body}</div><footer>${a.mime.startsWith('image/')?'<button type="button" class="wb-btn" data-zoom-attachment>放大图片</button>':''}<button type="button" class="wb-btn" data-download-attachment>下载</button><span role="status" aria-live="polite" data-download-status></span></footer>`
        let readerCleanup = /** @type {(()=>void)|null} */ (null)
        let closed = false
        const cleanup=()=>{if(closed)return;closed=true;readerCleanup?.();URL.revokeObjectURL(url);dialog.remove();if(attachmentPreviewCleanup===cleanup)attachmentPreviewCleanup=null}
        attachmentPreviewCleanup=cleanup;dialog.addEventListener('close',()=>{attachmentPreviewRequest++;cleanup()},{once:true});dialog.querySelector('[data-close-attachment]')?.addEventListener('click',()=>dialog.close());const downloadButton=dialog.querySelector('[data-download-attachment]');downloadButton?.addEventListener('click',()=>{void download(downloadButton,dialog.querySelector('[data-download-status]'))})
        dialog.querySelector('[data-zoom-attachment]')?.addEventListener('click',event=>{const zoomed=dialog.querySelector('.wb-input-preview-body')?.classList.toggle('is-zoomed');if(event.target instanceof HTMLElement)event.target.textContent=zoomed?'适合窗口':'放大图片'})
        document.body.append(dialog);dialog.showModal()
        const reader = /** @type {HTMLElement|null} */ (dialog.querySelector('.cc-pdf-reader'))
        if (reader) readerCleanup = mountPdfReader(reader,bytes,a.name)
      }catch(error){if(alive&&navigation===navigationGeneration&&controller.state.selectedId===taskId)fail(error)}
      return
    }
    // 改动面板的按钮也带 data-artifact-id(那是快照那件成果),必须赶在下面
    // 「点成果就预览」那条分支之前认领,否则一点接受就跳去预览了。
    if (action === 'review-accept' && controller.state.selectedId && target.dataset.artifactId && target.dataset.path) {
      return mutate(V1.workbench.reviewMark, { id: controller.state.selectedId, artifactId: target.dataset.artifactId, path: target.dataset.path, mark: 'accepted' })
    }
    if (action?.startsWith('line-') || action === 'review-hunk') return onLineAction(action, target)
    // 也交给另一位做一份(10-08):原样的第一句要求 + 同一个源项目 + 独立工作区,走普通交办入口;成了就打开新的那件。
    if (action === 'worktree-fork' && controller.state.detail?.task.worktree && !forking) {
      const detail = controller.state.detail, task = detail.task
      const providerId = /** @type {HTMLSelectElement|null} */ (root.querySelector('#wb-fork-provider'))?.value ?? ''
      const project = controller.state.projects?.find(p => p.path === projectPathOf(task))
      const text = detail.events.find(event => event.kind === 'user')?.text ?? ''
      if (!providerId || !project || !text.trim()) return fail(new Error(!project ? '找不到这件事的源项目，请在交办里重新选择项目。' : '找不到这件事最初的要求，请用「交给 CC 做」重新交办。'))
      /** @param {unknown} value */
      const taskIdOf = value => /** @type {{receipt?:{taskId?:unknown}}|null} */ (value)?.receipt?.taskId
      forking = true;target.setAttribute('disabled', '')
      try {
        const requestId = crypto.randomUUID()
        const body = { requestId, text, title: task.title, providerId, target: { kind: 'project', projectId: project.id, isolation: 'worktree' } }
        let created = taskIdOf(await v1(deps.invokeWorkbenchApi, V1.workbench.createEntry, { body: body }).catch(async error => {
          // 回执不确定 ⇒ 按同一个 requestId 问一次,免得点第二下多建一件
          try { return await v1(deps.invokeWorkbenchApi, V1.workbench.entryReceipt, { query: { requestId: requestId } }) } catch { throw error }
        }))
        if (typeof created !== 'string') throw new Error('没有收到新任务的回执，请刷新看看。')
        await controller.refresh({ force: true })
        await openTask(created)
      } catch (error) {
        const code = String(error instanceof Error ? error.message : error).match(/\b(worktree_not_git|worktree_branch_exists|unavailable_provider|provider_quota_exhausted|network_unprotected)\b/)?.[1]
        fail(code ? new Error(executionErrorMessage(code) ?? code) : error)
      } finally { forking = false;target.removeAttribute('disabled') }
      return
    }
    // 工作区脚本(2026-10-20):运行 / 停下;没批过 ⇒ 后台回 428,当面给主人看三条原文,批了再原样重发一次。
    if ((action === 'worktree-run' || action === 'worktree-stop' || action === 'worktree-approve-scripts') && controller.state.selectedId && controller.state.detail?.task.worktree?.scripts?.configured) {
      const id = controller.state.selectedId, scripts = controller.state.detail.task.worktree.scripts
      /** 主人看过原文、点了确认 ⇒ 按他看到的那份(hash)登记;取消 ⇒ false。 */
      const approve = async () => {
        if (!(await confirmScripts(scripts.config)) || !alive) return false
        await v1(deps.invokeWorkbenchApi, V1.workbench.scriptApprove, { body: { id, hash: scripts.hash } })
        return true
      }
      const explain = (/** @type {unknown} */ error) => { const message = scriptErrorMessage(error); fail(message ? new Error(message) : error) }
      if (action === 'worktree-approve-scripts') {
        try { if (await approve()) await controller.refresh({ force: true }) } catch (error) { explain(error); await controller.refresh({ force: true }).catch(() => {}) }
        return
      }
      return mutate(V1.workbench.worktree, { id, action: action.slice('worktree-'.length) }, async e => {
        if (isScriptApprovalRequired(e)) {
          try { if (await approve()) { await v1(deps.invokeWorkbenchApi, V1.workbench.worktree, { body: { id, action: 'run' } }); await controller.refresh({ force: true }) } }
          catch (error) { explain(error); await controller.refresh({ force: true }).catch(() => {}) }
          return true
        }
        const message = scriptErrorMessage(e)
        if (!message) return false
        fail(new Error(message))
        return true
      })
    }
    // 独立工作区(2026-10-07):提交到分支 / 合回项目(10-08,只快进)/ 删除工作区(合回、删除都点两下才算)。
    if ((action === 'worktree-commit' || action === 'worktree-merge' || action === 'worktree-remove' || action === 'worktree-reopen') && controller.state.selectedId && controller.state.detail?.task.worktree && controller.state.detail.task.worktree.removed === (action === 'worktree-reopen')) {
      if (action === 'worktree-remove' && !armConfirm(target, '再点一次：删除工作区（分支保留）')) return
      if (action === 'worktree-merge' && !armConfirm(target, '再点一次：快进合并到项目当前分支')) return
      return mutate(V1.workbench.worktree, { id: controller.state.selectedId, action: action.slice('worktree-'.length) }, e => {
        const code = String(e instanceof Error ? e.message : e).match(/\b(workbench_busy|worktree_dirty|worktree_removed|worktree_git_failed|not_worktree|worktree_uncommitted|project_dirty|project_detached|worktree_not_ff|project_busy|worktree_branch_missing|worktree_open|worktree_conflict|workbench_archived)\b/)?.[1]
        if (!code) return false
        fail(new Error(code === 'workbench_busy' ? '这个工作区还有会话占着，先收工再操作。' : executionErrorMessage(code) ?? code))
        return true
      })
    }
    // 回到某一轮(2026-10-21):点按钮先拉预览(后台先打备份 B、回 token),确认块里看清再带 token 执行;
    // 工作区在那之后变了(409 stale)⇒ 重新拉一遍预览、提示再看一眼。
    if (action === 'rewind-open' && controller.state.selectedId && target.dataset.artifactId && (target.dataset.to === 'start' || target.dataset.to === 'end')) {
      return loadRewindPreview({ artifactId: target.dataset.artifactId, to: target.dataset.to, round: Number(target.dataset.round) || 0 })
    }
    if (action === 'rewind-cancel') { rewindRequest++; controller.state.rewindOpen = null; controller.paint(true); return }
    if (action === 'rewind-confirm' && controller.state.selectedId && controller.state.rewindOpen?.status === 'ready' && controller.state.rewindOpen.preview) {
      const open = controller.state.rewindOpen, preview = open.preview
      if (!preview) return
      const { artifactId, to, round } = open
      const done = await mutate(V1.workbench.rewind, { id: controller.state.selectedId, artifactId, to, token: preview.token }, e => {
        if (isRewindStale(e)) { void loadRewindPreview({ artifactId, to, round }, REWIND_STALE_NOTICE); return true }
        controller.state.rewindOpen = { artifactId, to, round, status: 'error', error: rewindErrorMessage(e) ?? String(e instanceof Error ? e.message : e) }
        controller.paint(true)
        return true
      })
      if (done) { controller.state.rewindOpen = null; controller.paint(true) }
      return
    }
    if (action === 'rewind-undo' && controller.state.selectedId && target.dataset.rewindId) {
      if (!armConfirm(target, '再点一次：撤销回退')) return
      return mutate(V1.workbench.rewind, { id: controller.state.selectedId, undo: target.dataset.rewindId }, rewindFailure)
    }
    // 回退停住了:保留现在的样子(直接)/ 恢复到回退之前(再确认一次)
    if (action === 'rewind-keep' && controller.state.selectedId) return mutate(V1.workbench.rewindResolve, { id: controller.state.selectedId, choice: 'keep' }, rewindFailure)
    if (action === 'rewind-restore' || action === 'rewind-restore-cancel') { controller.state.rewindRestoreConfirm = action === 'rewind-restore'; controller.paint(true); return }
    if (action === 'rewind-restore-confirm' && controller.state.selectedId) {
      const done = await mutate(V1.workbench.rewindResolve, { id: controller.state.selectedId, choice: 'restore_backup' }, rewindFailure)
      if (done) { controller.state.rewindRestoreConfirm = false; controller.paint(true) }
      return
    }
    // 逐文件撤销(2026-10-06):点两下才算;被拒的原因说成人话(daemon 那边全是拒绝条件,没有「尽量」)。
    if (action === 'review-revert' && controller.state.selectedId && target.dataset.artifactId && target.dataset.path) {
      if (!armConfirm(target, '再点一次：恢复成这一轮开始前')) return
      return mutate(V1.workbench.reviewRevert, { id: controller.state.selectedId, artifactId: target.dataset.artifactId, path: target.dataset.path }, e => {
        const code = String(e instanceof Error ? e.message : e).match(/\b(workbench_busy|review_file_changed|review_revert_unavailable)\b/)?.[1]
        if (!code) return false
        fail(new Error({
          workbench_busy: '这个文件夹还有会话占着，先收工再撤销。',
          review_file_changed: '这个文件之后又被改过，不能直接撤销。',
          review_revert_unavailable: '这个文件没法自动恢复（内容太大、不是文本，或只改了权限），请手动处理。',
        }[code]))
        return true
      })
    }
    if (action === 'review-return' && target.dataset.artifactId && target.dataset.path) {
      captureDraft()
      const artifactId = target.dataset.artifactId, path = target.dataset.path
      const open = controller.state.reviewReturnOpen
      if (open?.artifactId === artifactId) {
        const paths = open.paths.includes(path) ? open.paths.filter(item => item !== path) : [...open.paths, path]
        controller.state.reviewReturnOpen = paths.length ? { ...open, paths } : null
      } else controller.state.reviewReturnOpen = { artifactId, paths: [path], comment: '' }
      controller.state.reviewReturnResult = null
      controller.paint(true)
      return
    }
    if (action === 'review-return-cancel') { controller.state.reviewReturnOpen = null; controller.paint(true); return }
    if (action === 'decline-question') return answerQuestion(target.dataset.ownerTask, target.dataset.requestId, true)
    if (action === 'withdraw-input' || action === 'copy-held-input') {
      const taskId = target.dataset.ownerTask, requestId = target.dataset.requestId
      if (!taskId || !requestId || controller.getTargetTaskId() !== taskId) return
      const receipt = controller.state.detail?.inputs?.find(item => item.taskId === taskId && item.id === requestId)
      if (action === 'copy-held-input' && receipt?.status === 'held') {
        const field = input('wb-followup-text')
        if (field) {
          captureDraft();const scope=`task:${taskId}`,draft=pageDrafts.get(scope),existing=draft.attachments??[]
          const restored=(receipt.attachments??[]).filter(a=>!existing.some(b=>b.id===a.id)).map(a=>({...a,status:/** @type {const} */('ready')}))
          if(existing.length+restored.length>8||[...existing,...restored].reduce((n,a)=>n+a.size,0)>24*1024*1024)return fail(new Error('请先移除一些草稿附件，再放回这条补充。'))
          if(restored.length)pageDrafts.set(scope,{...draft,draftId:draft.draftId??crypto.randomUUID(),attachments:[...existing,...restored]})
          interactions.resetInput(taskId, requestId); field.value = field.value.trim() ? `${field.value}\n\n${receipt.text}` : receipt.text; captureDraft(); controller.paint(true); input('wb-followup-text')?.focus({ preventScroll: true }) }
      } else if (action === 'withdraw-input' && receipt?.status === 'pending') {
        const navigation = navigationGeneration
        if (await interactions.withdraw(taskId, requestId)) {
          if (alive && controller.state.detail?.task.id === taskId) { receipt.status = 'withdrawn'; controller.paint(true) }
          await refreshInteraction(taskId, navigation)
        }
      }
      return
    }
    if (action === 'show-artifacts') {
      const artifacts = controller.state.detail?.artifacts ?? []
      if (!artifacts.length) return
      if (!resultReturnPositions.has(renderedScope)) resultReturnPositions.set(renderedScope, root.querySelector('.wb-content')?.scrollTop ?? 0)
      controller.state.previewOpen = true
      const id = controller.state.selectedArtifactId ?? artifacts[0]?.id
      if (!id) return
      const cached = controller.state.preview?.artifactId === id ? controller.state.preview : null
      if (cached && cached.kind !== 'web' && (cached.kind !== 'html' || hostedPreviewId)) {
        controller.paint();
        /** @type {HTMLElement|null} */ (root.querySelector('#wb-artifact-choice'))?.focus({preventScroll:true})
        return
      }
      controller.state.selectedArtifactId = id
      controller.state.preview = null
      controller.paint()
      ;/** @type {HTMLElement|null} */ (root.querySelector('#wb-artifact-choice'))?.focus({preventScroll:true})
      action = 'preview-artifact'
    }
    if (target.dataset.artifactId) {
      if (!resultReturnPositions.has(renderedScope)) resultReturnPositions.set(renderedScope, root.querySelector('.wb-content')?.scrollTop ?? 0)
      controller.state.previewOpen = true
      artifactRequest++; controller.state.selectedArtifactId = target.dataset.artifactId; controller.state.preview = null; controller.paint(); /** @type {HTMLElement|null} */ (root.querySelector('#wb-artifact-choice'))?.focus({preventScroll:true}); action = 'preview-artifact'
    }
    if (['artifact-preview-mode', 'artifact-source-mode', 'artifact-width', 'refresh-artifact', 'open-preview-browser'].includes(action ?? '')) {
      const preview = controller.state.preview
      if (!preview) return
      if (action === 'open-preview-browser') {
        if (!preview.url || preview.kind !== 'web') return
        try { if (deps.invoke) await deps.invoke('open_url', {url:preview.url}); else window.open(preview.url, '_blank', 'noopener,noreferrer') } catch (error) { fail(error) }
        return
      }
      if (action === 'refresh-artifact') action = 'preview-artifact'
      if (action !== 'preview-artifact') {
        if (action === 'artifact-width') preview.narrow = !preview.narrow
        else preview.mode = action === 'artifact-source-mode' ? 'source' : 'preview'
        controller.paint()
        return
      }
    }
    if (action === 'latest-content') {
      artifactRequest++
      releaseHostedPreview()
      controller.state.previewOpen = false
      controller.paint(true)
      root.querySelector('#wb-artifacts')?.removeAttribute('open')
      artifactDisclosureChoices.set(renderedScope,false)
      for (const disclosure of root.querySelectorAll?.('[data-timeline-disclosure][open]') ?? []) disclosure.removeAttribute('open')
      resultReturnPositions.delete(renderedScope)
      readingAnchors.delete(renderedScope)
      const content = root.querySelector('.wb-content'), current = reading.get(renderedScope)
      if (current) { current.following = true; current.unread = false }
      if (content) { content.scrollTop = content.scrollHeight; scrollPositions.set(renderedScope, content.scrollTop) }
      showReadingNotice(); input('wb-followup-text')?.focus({ preventScroll: true })
      return
    }
    if (action === 'open-task-folder') {
      const task=controller.state.detail?.task,navigation=navigationGeneration
      if(!task||task.workspaceKind!=='managed')return
      try{if(!deps.invoke)throw Error('请在桌面应用中打开工作位置');await deps.invoke('open_workbench_folder',{taskId:task.id})}
      catch(error){if(alive&&navigation===navigationGeneration)fail(error)}
      return
    }
    if (action === 'back-to-dialogue') {
      artifactRequest++
      releaseHostedPreview()
      controller.state.previewOpen = false
      controller.paint()
      const content = root.querySelector('.wb-content')
      const returnPosition=resultReturnPositions.get(renderedScope)
      root.querySelector('#wb-artifacts')?.removeAttribute('open')
      artifactDisclosureChoices.set(renderedScope,false)
      const results = /** @type {HTMLElement|null} */ (root.querySelector('[data-action="show-artifacts"]'))
      results?.focus({ preventScroll:true })
      if (content) content.scrollTop = returnPosition ?? 0
      resultReturnPositions.delete(renderedScope)
      if(content)scrollPositions.set(renderedScope,content.scrollTop)
      const current=reading.get(renderedScope)
      if(current){current.following=atEnd(content)&&!browsingResults();if(current.following)current.unread=false}
      showReadingNotice()
      return
    }
    if(action==='quota-handoff-open'&&target.dataset.quotaTask)return openTask(target.dataset.quotaTask)
    if(action==='quota-handoff'){
      const detail=controller.state.detail;if(!detail||(!detail.quotaHandoff&&!quotaHandoffAttempts.get(detail.task.id)))return
      captureDraft();quotaHandoffCleanup?.();const navigation=navigationGeneration,sourceId=detail.task.id
      quotaHandoffCleanup=mountQuotaHandoffDialog({invoke:deps.invokeWorkbenchApi,source:detail.task,initial:detail.quotaHandoff??null,providers:controller.state.providers,attempts:quotaHandoffAttempts,current:()=>alive&&navigation===navigationGeneration&&controller.state.selectedId===sourceId,opened:async id=>{if(alive&&navigation===navigationGeneration&&controller.state.selectedId===sourceId)await openTask(id)}});return
    }
    if(action==='handoff-record'&&controller.state.selectedId&&target.dataset.handoffId){
      captureDraft();handoffCleanup?.();handoffCleanup=mountHandoffRecord(deps.invokeWorkbenchApi,controller.state.selectedId,target.dataset.handoffId);return
    }
    if(action==='handoff-review'||action==='handoff-revision'){
      const detail=controller.state.detail;if(!detail)return
      const origin=detail.handoffs?.find(h=>h.purpose==='review'&&h.targetTaskId===detail.task.id)
      const revision=action==='handoff-revision',event=detail.events.find(e=>Number(e.id)===Number(target.dataset.eventId)&&e.kind==='text')
      const providerId=revision?origin?.sourceProviderId:controller.state.providers.find(p=>p.id!==detail.task.providerId&&!isUnattendedProvider(p))?.id
      if(!providerId||(revision&&(!origin||!event)))return
      const selection=window.getSelection()?.toString()??''
      const quote=event&&(selection&&event.text.includes(selection)?selection:event.text)
      if(revision&&quote&&quote.length>8000)return fail(new Error('这段回复较长，请先选中要采纳的一段原文，再交回。'))
      captureDraft();handoffCleanup?.()
      handoffCleanup=mountHandoffDialog(deps.invokeWorkbenchApi,{sourceTaskId:detail.task.id,targetProviderId:providerId,purpose:revision?'revision':'review',request:revision?'请按选中的意见修改，并说明验证结果。':'请检查是否符合本任务要求，指出有依据的问题和遗漏。',artifacts:revision?[]:defaultReviewArtifacts(detail.artifacts),...(revision&&origin&&event?{targetTaskId:origin.sourceTaskId,quote:{taskId:detail.task.id,eventId:Number(event.id),text:quote??''}}:{})},revision?[]:detail.artifacts,detail.task.title,async id=>{if(!alive)return;navigationGeneration++;artifactRequest++;await controller.refresh({force:true});await controller.selectTask(id)},(detail.attachments??[]).map(a=>({...a,taskId:detail.task.id})),providerNameOf(controller.state)(providerId))
      return
    }
    if (action === 'native-history') { captureDraft(); nativeHistoryCleanup?.(); nativeHistoryCleanup=mountHistoryDialog(deps.invokeWorkbenchApi,controller.state.historyProviders??[],async id=>{if(!alive)return;navigationGeneration++;await controller.refresh({force:true});await controller.selectTask(id)},controller.state.agentNames??{}); return }
    if (action === 'refresh') return controller.refresh({ force: true }).catch(fail)
    if (action === 'task-entry') { captureDraft(); try { await deps.onDelegate?.({text:'',...(target.dataset.projectPath ? {projectPath:target.dataset.projectPath} : {})}) } catch(error) { if(alive)fail(error) }; return }
    if (action === 'new-task' || action === 'add-project') { captureDraft(); navigationGeneration++; artifactRequest++; controller.newTask(); if(action==='add-project'){controller.state.newScope='new:add-project';controller.paint(true)}; return }
    if (action === 'new-project-task' && target.dataset.projectPath) {
      captureDraft()
      const path = target.dataset.projectPath
      const scope = `new:${path}`
      if (!pageDrafts.has(scope)) {
        const recent = controller.state.tasks.filter(task => task.path === path).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))[0]
        pageDrafts.set(scope, { ...emptyDraft(), path, providerId: controller.state.projectProviders?.[path] ?? recent?.providerId ?? controller.state.defaultProvider ?? '' })
      }
      navigationGeneration++; artifactRequest++
      return controller.newTask(path)
    }
    if (action === 'load-more') return controller.loadMore().catch(fail)
    if (action === 'clear-search') {
      searchDraft = ''
      const field = input('wb-search'); if (field) field.value = ''
      return controller.filterTasks({ q: '', archived: controller.state.query?.archived ?? 'exclude' }).catch(fail)
    }
    if (action === 'toggle-archived') return controller.filterTasks({ q: controller.state.query?.q ?? '', archived: controller.state.query?.archived === 'only' ? 'exclude' : 'only' }).catch(fail)
    if (action === 'choose-folder') {
      const scope=renderedScope,navigation=navigationGeneration
      const current=()=>alive&&navigation===navigationGeneration&&scope===renderedScope&&scope===scopeFor(controller.state)&&controller.getTargetTaskId()===null
      try {
        const path=await deps.invoke?.('choose_workbench_folder',{})
        if(!current())return
        const field=input('wb-path')
        if(typeof path==='string'&&field){field.value=path;field.dispatchEvent(new Event('change',{bubbles:true}))}
      } catch(error) { if(current())fail(error) }
      return
    }
    // 停止要说清楚停的是哪一轮:长轮询期间显示的那一轮可能已经换了。
    // 等待行里的「收工」关的是挡路者的会话(`data-cancel-task-id`),不是当前打开的这条排队任务——
    // 那条 runId 是这条排队任务自己的,和挡路者对不上号,带上去只会被当成过期请求拒掉。
    if (action === 'cancel') {
      const holderId = target.dataset.cancelTaskId
      return mutate(V1.workbench.cancel, { id: holderId || controller.state.selectedId, ...(!holderId && typeof controller.state.detail?.runId === 'string' && controller.state.detail.runId ? { expectedRunId: controller.state.detail.runId } : {}) })
    }
    // 「没确认退出」的旧记录(2026-10-06):没有相反证据时主人可以确认它已经结束;点两下才算。
    if (action === 'confirm-writer-exited' && controller.state.detail?.task.writerExit === 'unconfirmed') {
      if (!armConfirm(target, '再点一次：确认它已经结束')) return
      return mutate(V1.workbench.writerExited, { id: controller.state.selectedId })
    }
    if (action === 'archive-task' && controller.state.detail?.task.canArchive === true) return mutate(V1.workbench.archive, { id: controller.state.selectedId, archived: true })
    if (action === 'restore-task' && controller.state.detail?.task.archivedAt != null) return mutate(V1.workbench.archive, { id: controller.state.selectedId, archived: false })
    if ((action === 'allow-permission' || action === 'deny-permission') && target.dataset.requestId) return mutate(V1.workbench.permission, { id: controller.state.selectedId, requestId: target.dataset.requestId, decision: action === 'allow-permission' ? 'allow' : 'deny' })
    if (action === 'copy-wechat-command' && controller.state.selectedId) { try { await navigator.clipboard.writeText(`任务 ${controller.state.selectedId}`) } catch { fail(new Error('复制不了，请手动选中任务编号。')) } return }
    const artifact = controller.state.detail?.artifacts?.find(a => a.id === controller.state.selectedArtifactId)
    if (!artifact) return
    if (action === 'approve-artifact') return mutate(V1.workbench.approve, { id: controller.state.selectedId, artifactId: artifact.id, sha256: artifact.sha256 })
    if (action === 'preview-artifact' || action === 'download-artifact') {
      const taskId = controller.state.selectedId
      const requestedArtifactId = artifact.id
      const request = action === 'download-artifact' ? artifactRequest : ++artifactRequest
      const navigation = navigationGeneration
      try {
        const data = /** @type {{name:string,mime:string,contentBase64:string,size:number,sha256:string}} */ (await v1(deps.invokeWorkbenchApi, V1.workbench.artifact, { query: { id: taskId ?? '', artifactId: requestedArtifactId } }))
        if (!alive || request !== artifactRequest || navigation !== navigationGeneration || controller.state.selectedId !== taskId || controller.state.selectedArtifactId !== requestedArtifactId) return
        const bytes = decodeBase64(data.contentBase64)
        if (action === 'download-artifact') {
          await saveDownload(data.name, data.mime, bytes, target)
          return
        }
        const text = new TextDecoder().decode(bytes)
        const webUrl = readWebPreview(data.name, text, window.location?.origin)
        const htmlFile = isHtmlArtifact(data.name, data.mime)
        const siteFile = data.mime === SITE_ARTIFACT_MIME
        releaseHostedPreview()
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        objectUrl = URL.createObjectURL(new Blob([bytes], {type:htmlFile ? 'text/html' : data.mime}))
        /** @type {Preview} */
        const preview = {artifactId:artifact.id,html:'<p class="wb-preview-hint">这种文件请下载后在本机应用中查看。</p>'}
        if (webUrl) {
          // A running page is not owned by this saved artifact. Detect a stopped
          // service before opening an otherwise blank browser error frame.
          let available = false
          try { await fetch(webUrl, {method:'HEAD',mode:'no-cors',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(5000)}); available = true } catch { /* Visible recovery stays in the reader. */ }
          if (!alive || request !== artifactRequest || navigation !== navigationGeneration || controller.state.selectedId !== taskId || controller.state.selectedArtifactId !== requestedArtifactId) return
          Object.assign(preview, {kind:'web',url:webUrl,html:available ? renderArtifactFrame(webUrl,artifactDisplayName(data.name),'web') : '<p class="wb-preview-hint" role="alert">网页服务暂时没有响应。服务启动后可以重新打开，或让 CC 交付可保存的 HTML 成品。</p><button type="button" class="wb-btn" data-action="preview-artifact">重新打开</button>'})
        }
        else if (htmlFile || siteFile) {
          if (!deps.invoke) throw new Error('请在桌面中打开这份网页成果。')
          const site = siteFile ? readSiteArchive(bytes) : null
          const url = /** @type {string} */ (await deps.invoke(site ? 'prepare_workbench_site_preview' : 'prepare_workbench_html_preview', site ? {entry:site.entry,files:site.files} : {html:text}))
          const id = new URL(url).pathname.match(/\/([a-f0-9]{32})\//)?.[1]
          if (!id) throw new Error('网页预览暂时没能打开。')
          if (!alive || request !== artifactRequest || navigation !== navigationGeneration || controller.state.selectedId !== taskId || controller.state.selectedArtifactId !== requestedArtifactId) {
            void deps.invoke('release_workbench_html_preview', {id}).catch(() => {})
            return
          }
          hostedPreviewId = id
          Object.assign(preview, {kind:'html',url,source:site?.source ?? text,html:renderArtifactFrame(url,artifactDisplayName(data.name),'html')})
        }
        else if (data.mime === 'application/pdf' || /\.pdf$/i.test(data.name)) Object.assign(preview, {kind:'pdf',pdfData:bytes,html:renderPdfReader(`artifact:${artifact.id}:${data.sha256}`,data.name)})
        else if (data.mime.startsWith('image/')) preview.html = `<img src="${objectUrl}" alt="${escapeWorkbenchHtml(data.name)}">`
        else if (data.mime === WORKBENCH_CODE_REVIEW_MIME || data.mime.startsWith('text/') || data.mime === 'application/json') preview.html = renderWorkbenchArtifactText(data.name,data.mime,text)
        controller.state.preview = preview
        controller.paint()
        if (reloadLivePreview && webUrl) {
          const frame = /** @type {HTMLIFrameElement|null} */ (root.querySelector('#wb-preview-frame'))
          if (frame) frame.src = webUrl
        }
      } catch (e) {
        if (!alive || request !== artifactRequest || navigation !== navigationGeneration || controller.state.selectedId !== taskId || controller.state.selectedArtifactId !== requestedArtifactId) return
        if (action === 'download-artifact') { showToast('下载失败，请重试。'); return }
        controller.state.preview = {artifactId:requestedArtifactId,html:`<p class="wb-preview-hint" role="alert">${escapeWorkbenchHtml(e instanceof Error ? e.message : '成果暂时没能打开。')}</p><button type="button" class="wb-btn" data-action="preview-artifact">重新打开</button>`}
        controller.paint()
      }
    }
  }
  /** @param {SubmitEvent} event */
  const onSubmit = async event => {
    event.preventDefault()
    const form = event.target instanceof Element && event.target.tagName === 'FORM' ? /** @type {HTMLFormElement} */ (event.target) : null
    if (!form) return
    if (form.dataset.action === 'answer-question') return answerQuestion(form.dataset.ownerTask, form.dataset.requestId)
    // 行评论:存草稿(新建带客户端 id,改只带 id + 正文);被拒的原因留在输入框里,字不丢
    if (form.dataset.action === 'line-comment-save') {
      const taskId = controller.state.selectedId, compose = controller.state.lineCompose
      if (!taskId || !compose || controller.getTargetTaskId() !== taskId) return
      captureDraft()
      const body = compose.body.trim()
      const keep = (/** @type {string} */ notice) => { if (controller.state.lineCompose === compose) { compose.notice = notice; controller.paint(true) } }
      if (!body) return keep('先写一句再存。')
      // 同一件事上还有一笔没回来(撤回 / 删 / 别的存)⇒ mutate 会直接回 false;说一声,字留着
      if (busy.has(`task:${taskId}`)) return keep('上一个操作还没完成，稍等再存。')
      compose.notice = ''
      const payload = compose.edit ? { id: taskId, commentId: compose.commentId, body }
        : { id: taskId, commentId: compose.commentId, artifactId: compose.artifactId, path: compose.path, hunk: compose.hunk, hunkSha256: compose.hunkSha256, ...(compose.rowStart !== undefined && compose.rowEnd !== undefined ? { rowStart: compose.rowStart, rowEnd: compose.rowEnd } : {}), body }
      const done = await mutate(V1.workbench.reviewComment, payload, e => { const message = lineErrorMessage(e); if (!message) return false; keep(message); return true })
      if (done && controller.state.lineCompose === compose) { controller.state.lineCompose = null; controller.paint(true) }
      return
    }
    // 发出行评论:投递同打回 —— 执行者在写 ⇒ 等它答复;原会话不可恢复 ⇒ 当面确认一次,带重开令牌再发
    if (form.dataset.action === 'line-comments-send') {
      const taskId = controller.state.selectedId
      if (!taskId || controller.getTargetTaskId() !== taskId) return
      captureDraft()
      const summary = (controller.state.commentsSend?.summary ?? '').trim()
      const restartToken = controller.state.commentsSend?.restartToken
      const keep = (/** @type {string} */ notice, /** @type {string|undefined} */ token) => {
        const next = { ...(controller.state.commentsSend ?? {}), notice }
        delete next.result
        if (token === undefined) delete next.restartToken
        else next.restartToken = token
        controller.state.commentsSend = next
        controller.paint(true)
      }
      if (controller.state.detail?.task.phase !== 'replied' && ['running', 'queued', 'cancelling'].includes(controller.state.detail?.task.status ?? '')) return keep('执行者还在写，等它答复后再发出评论。', restartToken)
      /** @type {{sent?:number,remaining?:number,skippedDiscarded?:number}} */
      let counts = {}
      const done = await mutate(V1.workbench.reviewCommentsSend, { id: taskId, ...(summary ? { summary } : {}), ...(restartToken ? { restartToken } : {}) }, async error => {
        const recovery = recoveryCode(error)
        if (recovery === 'stale') { keep('', undefined); return false }
        if (recovery === 'required') {
          let token = controller.state.detail?.continuation?.restart?.token
          if (typeof token !== 'string') { try { await controller.refresh({ force: true }) } catch { /* 让 fail() 照实报 */ } token = controller.state.detail?.continuation?.restart?.token }
          if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false
          keep('原会话无法恢复。点「带记录重新开始并发回」，CC 会带上这段记录重新开始，再把这几条评论交回去。', token)
          return true
        }
        const code = String(error instanceof Error ? error.message : error).match(/\b(workbench_busy|review_comment_not_found|rewind_needs_owner)\b/)?.[1]
        if (!code) return false
        keep(code === 'workbench_busy' ? '执行者还在写，等它答复后再发出评论。' : code === 'review_comment_not_found' ? '没有能发出的草稿。' : LINE_ERRORS[code] ?? code, restartToken)
        return true
      }, result => { counts = /** @type {typeof counts} */ (result) ?? {} })
      if (done) {
        // 旧的发出栏还在 DOM 里:先清掉那句,免得重画时又被抄回来
        const field = /** @type {HTMLTextAreaElement|null} */ (root.querySelector('.wb-review-send textarea[name="summary"]'))
        if (field) field.value = ''
        controller.state.commentsSend = { summary: '', result: sentResultText(counts) }
        controller.paint(true)
      }
      return
    }
    if (form.dataset.action === 'review-return-submit') {
      const taskId = controller.state.selectedId, artifactId = form.dataset.artifactId
      if (!taskId || !artifactId || controller.getTargetTaskId() !== taskId) return
      captureDraft()
      const boxes = /** @type {HTMLInputElement[]} */ (Array.from(form.querySelectorAll?.('input[name="paths"]') ?? []))
      const paths = boxes.filter(box => box.checked).map(box => box.value)
      const comment = (/** @type {HTMLTextAreaElement|null} */ (form.querySelector?.('textarea[name="comment"]'))?.value ?? '').trim()
      if (!paths.length) return fail(new Error('请先勾选要打回的文件。'))
      if (!comment) return fail(new Error('请写一句要怎么改，再发回。'))
      // 同时记成这个项目的经验:随手交办没有项目,框不画;记没记上只是附带的一句,不影响「已发回」
      const asLesson = controller.state.detail?.task.workspaceKind !== 'managed' && !!(/** @type {HTMLInputElement|null} */ (form.querySelector?.('input[name="asLesson"]'))?.checked)
      // 这一笔没发出去的话,勾选、意见和「为什么没发出去」都得留在 state 里 —— 表单本体活在会被重画冲掉的 DOM。
      const keep = (/** @type {string} */ notice, /** @type {string|undefined} */ token) => {
        const current = controller.state.reviewReturnOpen
        if (!current || current.artifactId !== artifactId) return
        current.paths = paths; current.comment = comment; current.notice = notice; current.asLesson = asLesson
        if (token === undefined) delete current.restartToken
        else current.restartToken = token
        controller.paint(true)
      }
      const opened = controller.state.reviewReturnOpen
      const restartToken = opened?.artifactId === artifactId ? opened.restartToken : undefined
      if (opened?.artifactId === artifactId) opened.notice = ''
      // 任务自己在跑的时候后台回的是 workbench_busy,那句「另一个任务正在写」在这儿是误报。
      // 但「已答复」的保留会话状态也是 running(会话留着等续接):这时打回是送得出去的,
      // 后台会把它当作续接投给同一条会话(评审 2026-09-21 #7),别在这儿先把它挡了。
      if (controller.state.detail?.task.phase !== 'replied' && ['running', 'queued', 'cancelling'].includes(controller.state.detail?.task.status ?? '')) return keep('这项任务正在跑，等它答复后再打回。', restartToken)
      /** @type {unknown} */
      let lesson
      const done = await mutate(V1.workbench.reviewReturn, { id: taskId, artifactId, paths, comment, ...(restartToken ? { restartToken } : {}), ...(asLesson ? { asLesson: true } : {}) }, async error => {
        const recovery = recoveryCode(error)
        if (!recovery) return false
        // 令牌过期:丢掉它,重新走一遍「先确认再发」。fail() 那句「记录已更新」照常说。
        if (recovery === 'stale') { keep('', undefined); return false }
        // 原会话不可恢复。拿到这一份恢复预览的令牌,当面确认一次再发 —— 打回就不是死胡同了。
        let token = controller.state.detail?.continuation?.restart?.token
        if (typeof token !== 'string') { try { await controller.refresh({ force: true }) } catch { /* 让 fail() 照实报 */ } token = controller.state.detail?.continuation?.restart?.token }
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false
        keep('原会话无法恢复。点「带记录重新开始并发回」，CC 会带上这段记录重新开始，再把这几处交回去。', token)
        return true
      }, result => { lesson = /** @type {{lesson?:unknown}} */ (result)?.lesson })
      if (done) {
        controller.state.reviewReturnOpen = null
        controller.state.reviewReturnResult = asLesson ? { artifactId, text: returnLessonText(lesson) } : null
        controller.paint(true)
      }
      return
    }
    if (form.dataset.action === 'send-input') {
      const detail = controller.state.detail, taskId = form.dataset.ownerTask, runId = form.dataset.runId
      if (!taskId || !runId || controller.getTargetTaskId() !== taskId || detail?.task.id !== taskId || detail.runId !== runId || !detail.inputMode || detail.task.status !== 'running' || detail.task.archivedAt != null) return
      const text = input('wb-followup-text')?.value ?? '', navigation = navigationGeneration
      captureDraft()
      const sent=pageDrafts.get(`task:${taskId}`)
      if(!attachments.ready(`task:${taskId}`))return fail(new Error('请等附件上传完成，或移除上传失败的附件。'))
      const release=attachments.reserve(`task:${taskId}`,sent)
      const receipt = await interactions.sendInput(taskId, runId, text,{...sent,execution:detail.lastExecution?.choice??detail.execution,draftExecution:sent.execution}).finally(release)
      if (!receipt) return
      const scope = `task:${taskId}`, draft = pageDrafts.get(scope)
      const unchanged=attachmentSignature(draft.attachments)===attachmentSignature(sent.attachments)&&executionSignature(draft.execution)===executionSignature(sent.execution)
      if (draft.followup === text&&unchanged) { draft.followup = ''; if(draft.attachments?.length){draft.attachments.forEach(a=>thumbnails.remove(a.id));draft.attachments=[]}; pageDrafts.set(scope, draft) }
      if (!alive) return
      const current = input('wb-followup-text')
      if (unchanged&&controller.state.selectedId === taskId && current?.value === text) current.value = ''
      if (controller.state.detail?.task.id === taskId) {
        controller.state.detail.inputs = [...(controller.state.detail.inputs ?? []).filter(item => item.id !== receipt.id), receipt].slice(-50)
        controller.paint(true)
      }
      await refreshInteraction(taskId, navigation)
      return
    }
    if (form.id === 'wb-search-form') {
      searchDraft = input('wb-search')?.value ?? ''
      return controller.filterTasks({ q: searchDraft, archived: controller.state.query?.archived ?? 'exclude' }).catch(fail)
    }
    if(form?.id==='wb-project-form'){
      if(busy.has('project'))return
      captureDraft()
      const data=new FormData(form),navigation=navigationGeneration
      busy.add('project')
      try{
        const result=/** @type {{project:{path:string,providerId:string}}} */(await v1(deps.invokeWorkbenchApi, V1.workbench.project, { body: {path:String(data.get('path')??''),name:String(data.get('name')??'').trim()||undefined,providerId:String(data.get('providerId')??'')} }))
        await controller.refresh({force:true})
        if(!alive||navigation!==navigationGeneration)return
        const {path,providerId}=result.project,scope=`new:${path}`
        const pendingText=pageDrafts.get('new').text
        const draft=pageDrafts.has(scope)?pageDrafts.get(scope):{...emptyDraft(),path,providerId}
        navigationGeneration++;artifactRequest++
        controller.newTask(path)
        pageDrafts.set(scope,{...draft,text:appendHandoverText(draft.text,pendingText)})
        restoreDraft(scope)
        syncWorkbenchProviderLabel(root)
        // Navigation captures the outgoing form; clear only after that capture.
        pageDrafts.delete('new')
      }catch(error){if(alive&&navigation===navigationGeneration)fail(error)}finally{busy.delete('project')}
      return
    }
    if (form?.id === 'wb-create-form') {
      const data = new FormData(form)
      const sent = { path:String(data.get('path') ?? ''), text:String(data.get('text') ?? ''), title:String(data.get('title') ?? ''), providerId:String(data.get('providerId') ?? '') }
      const scope = renderedScope
      captureDraft()
      const files=pageDrafts.get(scope)
      if(!sent.text.trim()&&!files.attachments?.length)return
      if(!attachments.ready(scope))return fail(new Error('请等附件上传完成，或移除上传失败的附件。'))
      const release=attachments.reserve(scope,files)
      if (await mutate(V1.workbench.create, { title: sent.title || undefined, path: sent.path, providerId: sent.providerId, text: sent.text,...attachmentPayload(files),...executionPayload(files) }).finally(release)) {
        const draft = pageDrafts.get(scope)
        const changedAttachments=attachmentSignature(draft.attachments)!==attachmentSignature(files.attachments)||executionSignature(draft.execution)!==executionSignature(files.execution)
        // Submitted IDs now belong to the created task. A newly edited task
        // draft keeps only material that was added after this submission.
        files.attachments?.forEach(a=>thumbnails.remove(a.id))
        if(files.attachments?.length)draft.attachments=(draft.attachments??[]).filter(a=>!files.attachments?.some(sent=>sent.id===a.id))
        if(changedAttachments){pageDrafts.set(scope,draft);return}
        if (scope.startsWith('new:') && draft.path === sent.path && draft.text === sent.text && draft.title === sent.title && draft.providerId === sent.providerId) {
          pageDrafts.delete(scope)
          return
        }
        if (scope === 'new' && draft.path === sent.path) draft.path = ''
        if (draft.text === sent.text) draft.text = ''
        if (draft.title === sent.title) draft.title = ''
        pageDrafts.set(scope, draft)
      }
      return
    }
    if(form.dataset.action==='native-prepare'){
      const id=controller.state.selectedId,text=input('wb-followup-text')?.value
      if(!id||(!text?.trim()&&!pageDrafts.get(renderedScope).attachments?.length)||busy.has(`task:${id}`))return
      if(!attachments.ready(renderedScope))return fail(new Error('请等附件上传完成，或移除上传失败的附件。'))
      captureDraft();const sent=pageDrafts.get(renderedScope);busy.add(`task:${id}`);controller.paint(true)
      try{
        const mode=controller.state.detail?.continuation?.mode==='restart_required'?'fresh_context':'native_resume'
        const decision=/** @type {NativeResume} */(await v1(deps.invokeWorkbenchApi, V1.workbench.prepareResume, { body: {id,mode,...executionPayload(sent)} }))
        if(alive&&controller.state.selectedId===id&&executionSignature(pageDrafts.get(`task:${id}`).execution)===executionSignature(sent.execution)){controller.state.nativeResume=decision;controller.paint()}
      }catch(error){await controller.refresh({force:true}).catch(()=>{});if(alive&&controller.state.selectedId===id)fail(error)}
      finally{busy.delete(`task:${id}`);if(alive)controller.paint(true)}
      return
    }
    if (form.dataset.action === 'continue' || form.dataset.action === 'restart' || form.dataset.action==='native-continue') {
      const field = input('wb-followup-text')
      const text = field?.value??''
      let files=pageDrafts.get(renderedScope)
      if (!text.trim()&&!files.attachments?.length) return
      if(!attachments.ready(renderedScope))return fail(new Error('请等附件上传完成，或移除上传失败的附件。'))
      const taskId = controller.state.selectedId
      if(!taskId||busy.has(`task:${taskId}`))return
      captureDraft()
      files=pageDrafts.get(renderedScope)
      if (controller.state.detail?.task.archivedAt != null) return fail(new Error('workbench_archived'))
      const sourceClosedToken=form.dataset.action==='native-continue'?form.dataset.nativeToken:undefined
      const restart = form.dataset.action === 'restart'||(!!sourceClosedToken&&controller.state.detail?.continuation?.mode==='restart_required')
      const recoveryContext=sourceClosedToken?null:restartPreviewContext(),recovery=recoveryContext?recoveryPreviews.get(recoveryContext):null
      if(recovery&&recovery.status!=='ready'){if(recoveryContext)void recoveryPreviews.load(recoveryContext);return}
      const continuation=recovery?.continuation??controller.state.detail?.continuation
      if (!restart && continuation?.mode === 'restart_required') return fail(new Error('restart_confirmation_required'))
      const restartToken = form.dataset.restartToken
      if(restart&&recovery&&(continuation?.mode!=='restart_required'||restartToken!==continuation.restart?.token))return fail(new Error('restart_confirmation_stale'))
      if (restart && !/^[a-f0-9]{64}$/.test(restartToken ?? '')) return fail(new Error('restart_confirmation_stale'))
      const inputRequestId=sourceClosedToken?undefined:interactions.continuationRequest(taskId,text,files.attachments,files.execution)
      const release=attachments.reserve(`task:${taskId}`,files)
      if (await mutate(V1.workbench.continue, { id: taskId, text,...attachmentPayload(files),...executionPayload(files),...(inputRequestId?{inputRequestId}:{}), ...(restart ? { restartToken } : {}),...(sourceClosedToken?{sourceClosedToken}:{}) }).finally(release)) {
        const scope = `task:${taskId}`
        const draft = pageDrafts.get(scope)
        const unchanged=attachmentSignature(draft.attachments)===attachmentSignature(files.attachments)&&executionSignature(draft.execution)===executionSignature(files.execution)
        if (draft.followup === text&&unchanged) {draft.followup = '';if(draft.attachments?.length){draft.attachments.forEach(a=>thumbnails.remove(a.id));draft.attachments=[]}}
        pageDrafts.set(scope, draft)
        const current = input('wb-followup-text')
        if (unchanged&&controller.state.selectedId === taskId && current?.value === text) current.value = ''
      }
    }
  }
  const onScroll = (/** @type {Event} */ event) => {
    const content = root.querySelector('.wb-content')
    if (event.target !== content || !content) return
    if (content.scrollTop !== pendingOutcomeDiscovery.get(renderedScope)) pendingOutcomeDiscovery.delete(renderedScope)
    scrollPositions.set(renderedScope, content.scrollTop)
    const current = reading.get(renderedScope)
    if(current){current.following=atEnd(content)&&!browsingResults();if(current.following){current.unread=false;showReadingNotice()}}
  }
  root.addEventListener('scroll', onScroll, true)
  const saveWindowState = () => {
    captureDraft()
    saveWorkbenchView(windowStorage,{scope:renderedScope,query:controller.state.query ?? {q:'',archived:'exclude'},search:input('wb-search')?.value ?? searchDraft})
  }
  const onInput = (/** @type {Event} */ event) => {
    pendingOutcomeDiscovery.delete(renderedScope)
    if (event.target instanceof Element && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) syncWorkbenchQuestionChoice(/** @type {HTMLInputElement|HTMLTextAreaElement} */ (event.target))
    if (event.target === input('wb-followup-text') && controller.state.selectedId) interactions.editInputDraft(controller.state.selectedId, input('wb-followup-text')?.value ?? '',pageDrafts.get(renderedScope).attachments,pageDrafts.get(renderedScope).execution)
    saveWindowState()
  }
  const addFiles=(/** @type {File[]} */ files)=>{captureDraft();const scope=renderedScope;void attachments.add(scope,files)}
  const onChange = (/** @type {Event} */ event) => {
    if (event.target instanceof Element && event.target.id === 'wb-artifact-choice') {
      const button = document.createElement('button'); button.dataset.artifactId = /** @type {HTMLSelectElement} */ (event.target).value
      void onClick(/** @type {MouseEvent} */ (/** @type {unknown} */ ({target:button})))
      return
    }
    if(event.target===input('wb-attachment-files')){const picker=/** @type {HTMLInputElement} */(event.target);const files=Array.from(picker.files??[]);picker.value='';addFiles(files);return}
    const executionEdit=event.target===input('wb-provider')||event.target===input('wb-model')||event.target===input('wb-reasoning-effort')
    if(event.target===input('wb-provider')){const model=input('wb-model'),effort=input('wb-reasoning-effort');if(model)model.value='';if(effort)effort.value=''}
    if(event.target===input('wb-model')){const effort=input('wb-reasoning-effort');if(effort)effort.value=''}
    syncWorkbenchProviderLabel(root); onInput(event)
    if(executionEdit){controller.state.nativeResume=null;const draft=pageDrafts.get(renderedScope);if(controller.state.selectedId)interactions.editInputDraft(controller.state.selectedId,draft.followup,draft.attachments,draft.execution);controller.paint(true)}
    if(executionEdit||event.target===input('wb-path'))loadExecutionCatalog()
  }
  const inComposer=(/** @type {Event} */ event)=>event.target instanceof Element&&!!event.target.closest('#wb-create-form,.wb-followup')
  const onPaste=(/** @type {ClipboardEvent} */ event)=>{if(!inComposer(event))return;const files=Array.from(event.clipboardData?.files??[]);if(files.length){event.preventDefault();addFiles(files)}}
  const onDrop=(/** @type {DragEvent} */ event)=>{if(!inComposer(event))return;event.preventDefault();addFiles(Array.from(event.dataTransfer?.files??[]))}
  const onDragOver=(/** @type {DragEvent} */ event)=>{if(inComposer(event)&&Array.from(event.dataTransfer?.types??[]).includes('Files'))event.preventDefault()}
  const onToggle=(/** @type {Event} */event)=>{
    if(!(event.target instanceof Element)||!root.contains(event.target))return
    if(['wb-options','wb-task-info'].includes(event.target.id))loadExecutionCatalog()
    if(event.target.id==='wb-artifacts'&&!event.target.hasAttribute('open'))resultReturnPositions.delete(renderedScope)
    // 「在不在跟随最新」取决于有没有在翻成果 / 改动(browsingResults 看这些展开状态),而 toggle 是异步到的:
    // 收起之前若先来了一次滚动,当时算出的是「不跟随」,收起后没人重算 ⇒ 停在底部也不再跟新回复(2026-10-06)。
    const content=root.querySelector('.wb-content'),current=reading.get(renderedScope)
    if(current&&content){current.following=atEnd(content)&&!browsingResults();if(current.following){current.unread=false;showReadingNotice()}}
  }
  root.addEventListener('toggle',onToggle,true)
  root.addEventListener('paste',onPaste);root.addEventListener('drop',onDrop);root.addEventListener('dragover',onDragOver)
  root.addEventListener('input', onInput)
  window.addEventListener?.('pagehide', saveWindowState)
  root.addEventListener('change', onChange)
  root.addEventListener('click', onClick, true)
  root.addEventListener('submit', onSubmit)
  controller.refresh().catch(fail)
  const timer = setInterval(() => {
    // 面板被藏起来就别占着长连接;重新露面时把它接回来。
    if (root.closest('[hidden]')) { controller.stopLive(); return }
    controller.resumeLive()
    controller.refresh().catch(fail)
  }, deps.pollMs ?? 3000)
  const openDraft = async (/** @type {IncomingDraft} */ incoming) => {
    if (!incoming.text.trim()) return false
    const navigation = ++navigationGeneration
    await controller.refresh({force:true})
    if (!alive || navigation !== navigationGeneration) return false
    captureDraft()
    const path = incoming.path, scope = path ? `new:${path}` : 'new'
    const recent = controller.state.tasks.filter(task => task.path === path).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))[0]
    const project = controller.state.projects?.find(project => project.path === path)
    if (path && controller.state.projects && !project) return false
    const providerId = incoming.providerId ?? controller.state.projectProviders?.[path] ?? recent?.providerId ?? project?.providerId ?? controller.state.defaultProvider ?? ''
    artifactRequest++
    controller.newTask(path)
    const draft = pageDrafts.has(scope) ? pageDrafts.get(scope) : {...emptyDraft(),path,providerId}
    pageDrafts.set(scope,{...draft,providerId:draft.providerId || providerId,text:appendHandoverText(draft.text,incoming.text)})
    restoreDraft(scope)
    syncWorkbenchProviderLabel(root)
    if (!path) controller.paint(true)
    input('wb-create-text')?.focus()
    return true
  }
  active = { timer, openTask, openDraft, getTaskId: () => controller.getTargetTaskId(), cleanup: () => {
    saveWindowState()
    resumeQuery = { ...(controller.state.query ?? { q: '', archived: 'exclude' }) }
    resumeSearch = input('wb-search')?.value ?? searchDraft
    if (controller.state.selectedId) resumeScope = `task:${controller.state.selectedId}`
    else if (document.getElementById('wb-create-form')) resumeScope = scopeFor(controller.state)
    releaseHostedPreview();pdfCleanup?.();clearLiveTimelinePatches(root);thumbnails.destroy();recoveryPreviews.destroy();catalogs.destroy();root.removeEventListener('toggle',onToggle,true);handoffCleanup?.();quotaHandoffCleanup?.(); nativeHistoryCleanup?.();attachmentPreviewCleanup?.();root.removeEventListener('paste',onPaste);root.removeEventListener('drop',onDrop);root.removeEventListener('dragover',onDragOver); alive = false; artifactRequest++; controller.destroy(); root.removeEventListener('input', onInput); window.removeEventListener?.('pagehide', saveWindowState); root.removeEventListener('scroll', onScroll, true); root.removeEventListener('change', onChange); root.removeEventListener('click', onClick, true); root.removeEventListener('submit', onSubmit); if (objectUrl) URL.revokeObjectURL(objectUrl)
  } }
  return controller
}

export function stopWorkbenchPolling() {
  if (!active) return
  clearInterval(active.timer); active.cleanup(); active = null
}

/** The caller opens the workbench pane first. This never submits a draft.
 * @param {string} id */
export async function openWorkbenchTask(id) {
  if (!id) return
  if (active) await active.openTask(id)
  else resumeScope = `task:${id}`
}

/** The caller opens the workbench pane first. A successful handover only fills
 * its existing form; execution still requires its explicit start action.
 * @param {IncomingDraft} draft */
export async function openWorkbenchDraft(draft) {
  return active ? active.openDraft(draft) : false
}

export function getActiveWorkbenchTaskId() { return active?.getTaskId() ?? null }
