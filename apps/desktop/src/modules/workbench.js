// @ts-check

import {workbenchRuntimePresentation} from './workbench-runtime.js'
/** @typedef {import('./workbench-runtime.js').RuntimeSnapshot} RuntimeSnapshot */

import {createExecutionCatalogs,createContinuationPreviews,continuationPreviewKey,executionSignature,executionErrorMessage,renderExecutionControls,renderExecutionObservation} from './workbench-execution.js'
/** @typedef {import('./workbench-execution.js').ExecutionChoice} ExecutionChoice */
import {createWorkbenchAttachments,attachmentSignature,renderAttachmentComposer,renderMessageAttachments} from './workbench-attachments.js'
import { createWorkbenchDraftStore, loadWorkbenchView, saveWorkbenchView, workbenchWindowStorage } from './workbench-window-state.js'
export { createWorkbenchDraftStore } from './workbench-window-state.js'

import { mountHandoffDialog, mountHandoffRecord, defaultReviewArtifacts } from './workbench-handoff.js'
import { mountHistoryDialog } from './workbench-history.js'
import { isAckRequiredError, isUnattendedProvider, mountUnattendedDialog, unattendedLabelSuffix } from './workbench-unattended.js'
import { Marked } from '../vendor/marked.js'
import { WORKBENCH_CODE_REVIEW_MIME, createReviewDiffBudget, renderReviewFileDiff, renderWorkbenchCodeReview } from './workbench-code-review.js'
import { renderReviewPanel, reviewsSignature } from './workbench-review-panel.js'
/** @typedef {import('../../../../src/core/workbench/review').ReviewTurn} ReviewTurn */
import { createWorkbenchInteractions, captureWorkbenchQuestionDrafts, syncWorkbenchQuestionChoice, renderWorkbenchQuestions, renderWorkbenchInputs } from './workbench-interaction.js'
import { renderWorkbenchTimeline, workbenchTimelineEventId, renderWorkbenchOperation, captureWorkbenchTimelineAnchor, restoreWorkbenchTimelineAnchor } from './workbench-timeline.js'
import { mergeEvents, structuralSignature, patchLiveTimeline, createLongPoll } from './workbench-live.js'

/** @typedef {{taskId:string,title:string,reason:'same_path'|'nested_path'|'writer_not_closed',holderWriting?:boolean,closeInMs?:number|null}} WaitingFor */
/** @typedef {{id:string,title:string,path:string,providerId:string,status:string,createdAt:number,updatedAt:number,error:string|null,phase?:string,archivedAt?:number|null,canArchive?:boolean,pendingPermissionCount?:number,pendingQuestionCount?:number,waitingFor?:WaitingFor|null,importedOnly?:boolean,runtime?:RuntimeSnapshot}} Task */
/** @typedef {{id:string,type:'command'|'read'|'edit'|'search'|'tool'|'agent',status:'running'|'completed'|'failed'|'cancelled'|'interrupted',label:string,detail?:string,output?:string,parentId?:string,agentIds?:string[]}} WorkbenchActivity */
/** @typedef {{id:string,taskId:string,kind:'user'|'text'|'tool_call'|'system'|'error',text:string,createdAt:number,attachments?:import('./workbench-attachments.js').Attachment[],sourceId?:string|null,runId?:string,activity?:WorkbenchActivity}} WorkbenchEvent */
/** @typedef {{id:string,taskId:string,name:string,mime:string,size:number,sha256:string,createdAt:number,approvedAt:number|null}} Artifact */
/** @typedef {{id:string,taskId:string,tool:string,description:string,createdAt:number}} Permission */
/** @typedef {{id:string,displayName:string,capabilities?:{attachments?:boolean,execution?:boolean,resume?:boolean,permissions?:string},quota?:{kind:'quota'|'rate_limit',resetAt?:number}|null,usage?:{windows:Array<{name:string,usedPercent:number}>}|null}} Provider */
/** 执行者名 + 额度状态:用完 / 限流一眼看得出来;订阅执行者带上真实窗口(5h / 周)—— 那不是估算,是厂商自己回的。 @param {Provider} p */
function providerLabel(p) {
  // 免审记号跟在最后:额度 / 限流是一时的,免审是这位执行者的性子。
  const unattended = unattendedLabelSuffix(p)
  if (p.quota?.kind === 'quota') return `${p.displayName}（额度已用完）${unattended}`
  if (p.quota?.kind === 'rate_limit') return `${p.displayName}（限流中）${unattended}`
  const windows = (p.usage?.windows ?? []).map(w => `${w.name === 'weekly' ? '周' : w.name} ${Math.round(w.usedPercent)}%`)
  return `${windows.length ? `${p.displayName} · ${windows.join(' · ')}` : p.displayName}${unattended}`
}
/** @typedef {{token:string,context:string,eventCount:number,includedEventCount:number,truncated:boolean}} RestartPreview */
/** @typedef {{mode:string,restart?:RestartPreview}} Continuation */
/** @typedef {import('../../../../src/core/workbench/native-adoption').NativeSource} NativeSource */
/** @typedef {import('../../../../src/core/workbench/native-adoption').NativeResumeDecision} NativeResume */
/** @typedef {import('../../../../src/core/workbench/handoff').HandoffView} Handoff */
/** @typedef {{execution?:ExecutionChoice,lastExecution?:import('./workbench-execution.js').RunExecution|null,attachments?:import('./workbench-attachments.js').Attachment[],handoffs?:Handoff[],requiresExternalClose?:boolean,source?:NativeSource,task:Task,events:WorkbenchEvent[],artifacts:Artifact[],permissions?:Permission[],continuation?:Continuation,runId?:string,inputMode?:'steer'|'send'|'queue',runtime?:RuntimeSnapshot,questions?:import('./workbench-interaction.js').QuestionRequest[],inputs?:import('./workbench-interaction.js').LiveInput[],version?:number}} Detail */
/** @typedef {{q:string,archived:'exclude'|'only'|'all'}} TaskQuery */
/** @typedef {{limit:number,total:number,hasMore:boolean,nextCursor:string|null}} TaskPage */
/** @typedef {{tasks:Task[],providers:Provider[],defaultProvider:string|null,canWechat:boolean,historyProviders?:string[],page?:TaskPage,projectProviders?:Record<string,string>}} ListResult */
/** @typedef {{artifactId:string,html:string}|null} Preview */
/** @typedef {{artifactId:string,paths:string[],comment?:string,notice?:string,restartToken?:string}} ReviewReturnOpen */
/** @typedef {{tasks:Task[],providers:Provider[],defaultProvider:string|null,canWechat:boolean,nativeResume?:NativeResume|null,historyProviders?:string[],selectedId:string|null,loadingId?:string|null,detail:Detail|null,selectedArtifactId:string|null,error:string,preview:Preview,query?:TaskQuery,page?:TaskPage,projectProviders?:Record<string,string>,loadingMore?:boolean,newScope?:string,chats?:ChatMatter[],selectedMatterId?:string|null,version?:number,reviews?:ReviewTurn[],reviewsSignature?:string,reviewsError?:boolean,reviewReturnOpen?:ReviewReturnOpen|null}} WorkbenchState */
/** @typedef {import('./workbench-window-state.js').Draft} Draft */
/** @typedef {{id:string,kind:string,title:string,status:string,updatedAt:number}} ChatMatter */
/** @typedef {{invokeWorkbenchApi:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>,invoke?:(command:string,args:Record<string,unknown>)=>Promise<unknown>,pollMs?:number,mountConverse?:(host:HTMLElement)=>void,unmountConverse?:()=>void,confirmUnattended?:()=>Promise<boolean>}} WorkbenchDeps */

// 一件事都没改过的任务:签名从一开始就是「空」,免得第一次拉回来白重画一整页。
const EMPTY_REVIEWS = reviewsSignature([])
/** 改动记录只跟着成果走:哪几件、各是什么内容。
 * @param {Detail|null|undefined} detail */
const artifactsSignature = detail => JSON.stringify((detail?.artifacts ?? []).map(a => [a.id, a.sha256]))

const windowStorage = workbenchWindowStorage()
const savedView = loadWorkbenchView(windowStorage)

/** @type {{timer:ReturnType<typeof setInterval>,cleanup:()=>void,openTask:(id:string)=>Promise<void>,getTaskId:()=>string|null}|null} */
let active = null
/** @type {string|null} */
let resumeScope = savedView.scope
/** @type {TaskQuery} */
let resumeQuery = savedView.query
let resumeSearch = savedView.search

const emptyDraft = () => ({ path: '', text: '', title: '', providerId: '', followup: '' })

const pageDrafts = createWorkbenchDraftStore(windowStorage)
/** @type {Map<string,import('./workbench-interaction.js').InputAttempt>} */
const pageInputAttempts = new Map()

/** @param {unknown} value */
export function escapeWorkbenchHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

/** @type {import('marked').RendererObject} */
const workbenchRenderer = {
  html({ text }) { return escapeWorkbenchHtml(text) },
  link({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens)
    try {
      const url = new URL(href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return label
      return `<a href="${escapeWorkbenchHtml(url.href)}"${title ? ` title="${escapeWorkbenchHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`
    } catch { return label }
  },
  image({ text }) { return `<span class="wb-markdown-image">${escapeWorkbenchHtml(text || '图片')}</span>` },
}

const workbenchMarkdown = new Marked({ gfm: true, breaks: true, renderer: workbenchRenderer })

/** @param {string} value */
export function renderWorkbenchMarkdown(value) {
  return /** @type {string} */ (workbenchMarkdown.parse(String(value ?? '')))
}

/** @param {string} name @param {string} mime @param {string} text */
export function renderWorkbenchArtifactText(name, mime, text) {
  if (mime === WORKBENCH_CODE_REVIEW_MIME) return renderWorkbenchCodeReview(text)
  const source = `<pre>${escapeWorkbenchHtml(text)}</pre>`
  if (mime.split(';')[0] === 'text/markdown' || /\.(md|markdown)$/i.test(name)) {
    return `<article class="wb-document wb-markdown">${renderWorkbenchMarkdown(text)}</article><details id="wb-artifact-source" class="wb-disclosure"><summary>查看原文</summary>${source}</details>`
  }
  return source
}

/** @param {number} value */
function time(value) {
  return Number.isFinite(value) ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : ''
}

/** @param {string} status @param {RuntimeSnapshot} [runtime] @param {string} [phase] */
function statusLabel(status, runtime, phase) {
  const observed = workbenchRuntimePresentation(status, runtime, phase)
  if (observed) return observed.label
  return ({ queued: '等待中', running: '进行中', cancelling: '正在停止', completed: '已完成', failed: '未完成', cancelled: '已停止', interrupted: '已中断' })[status] ?? status
}

/** @param {Task} task */
function statusValue(task) { return task.importedOnly ? 'imported' : workbenchRuntimePresentation(task.status, task.runtime, task.phase)?.status ?? task.status }

/** @param {string} status @param {Continuation} [continuation] @param {number|null} [archivedAt] @param {{requiresClose:boolean,decision?:NativeResume|null}} [native] @param {{taskId:string,runId?:string,inputMode?:'steer'|'send'|'queue',runtime?:RuntimeSnapshot,busy?:boolean,error?:string}} [live] */
function renderTaskControlsBase(status, continuation, archivedAt,native,live) {
  if (archivedAt != null) return '<div class="wb-archived-controls"><p>已归档 <span>恢复后可继续</span></p><button type="button" class="wb-btn" data-action="restore-task">恢复任务</button></div>'
  if (status === 'running' && live?.runId && live.inputMode) {
    const retained = !!live.runtime?.retained
    const timing = retained && live.inputMode === 'queue' ? '补充保存在 CC，当前执行者暂不接收；不会自动发送。' : live.inputMode === 'send' ? '交给同一会话；执行者确认收到后显示已交付。' : live.inputMode === 'steer' ? '交给当前一轮；收到确认后显示已交付。' : '本轮正常结束后，在同一会话继续。停止或失败时保留为未发送。'
    const note = retained ? '<p class="wb-runtime-note">后台会话保持连接，后续回复会继续出现在这里。结束会停止尚未结束的后台工作，并保存当前成果。</p>' : ''
    return `${note}<form class="wb-followup wb-followup-live" data-action="send-input" data-owner-task="${escapeWorkbenchHtml(live.taskId)}" data-run-id="${escapeWorkbenchHtml(live.runId)}" aria-label="运行中补充要求"><label class="wb-sr-only" for="wb-followup-text">补充要求</label><textarea id="wb-followup-text" rows="2" maxlength="20000" aria-describedby="wb-followup-timing" placeholder="补充或调整这项任务的要求…"></textarea>${live.error ? `<p class="wb-interaction-error" role="alert">${escapeWorkbenchHtml(live.error)}</p>` : ''}<div class="wb-control-actions"><small id="wb-followup-timing">${timing}</small><button class="wb-btn wb-btn-danger" type="button" data-action="cancel">${retained ? '结束后台会话' : '停止任务'}</button><button class="wb-btn wb-btn-primary" type="submit"${live.busy ? ' disabled' : ''}>${live.busy ? '正在提交…' : live.inputMode === 'queue' ? retained ? '保存补充' : '加入下一轮' : '发送补充'}</button></div></form>`
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
    const note=decision?`请先关闭原来的 ${escapeWorkbenchHtml(decision.providerId==='claude'?'Claude':'Codex')} 执行程序，再从这里继续。CC 无法替你确认外部程序已退出。`:fresh?'原会话暂时无法恢复。可以查看将带入的记录，再决定新开一轮。':'已加入任务列表，尚未执行。写下接着要做的事，就能从原会话继续。'
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

/** @param {string} status @param {Continuation} [continuation] @param {number|null} [archivedAt] @param {{requiresClose:boolean,decision?:NativeResume|null}} [native] @param {{taskId:string,runId?:string,inputMode?:'steer'|'send'|'queue',runtime?:RuntimeSnapshot,busy?:boolean,error?:string}} [live] @param {Draft} [draft] @param {string} [attachmentError] */
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

/** @param {Task[]} tasks */
export function groupWorkbenchTasks(tasks) {
  /** @type {Map<string,Task[]>} */
  const grouped = new Map()
  for (const task of tasks) grouped.set(task.path, [...(grouped.get(task.path) ?? []), task])
  const nameCounts = new Map()
  for (const path of grouped.keys()) { const name = pathParts(path).name; nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1) }
  return [...grouped].map(([path, projectTasks]) => {
    const { name, parent } = pathParts(path)
    return { path, label: (nameCounts.get(name) ?? 0) > 1 ? `${name} · ${parent}` : name, tasks: projectTasks }
  })
}

/** @param {Task} task @param {Provider[]} providers @param {string|null} selectedId */
function renderTask(task, providers, selectedId) {
  const provider = providers.find(item => item.id === task.providerId)?.displayName || task.providerId || '未知执行者'
  const pendingPermissionCount = task.pendingPermissionCount ?? 0
  const pendingQuestionCount = task.pendingQuestionCount ?? 0
  const title = task.title || '未命名任务'
  const updated = time(task.updatedAt)
  const waitingLabel = task.waitingFor?.reason === 'writer_not_closed' ? '等待执行程序退出确认' : task.waitingFor ? '等待前项任务' : ''
  const attention = (pendingPermissionCount > 0 ? `，${pendingPermissionCount} 项权限请求等你确认` : '') + (pendingQuestionCount > 0 ? `，${pendingQuestionCount} 项问题等你回答` : '')
  const waiting = task.waitingFor?.reason === 'writer_not_closed'
    ? `，等待执行程序退出确认，阻塞任务「${task.waitingFor.title}」`
    : task.waitingFor ? `，等待「${task.waitingFor.title}」` : ''
  const accessibleLabel = `${title}，${provider}，${(task.importedOnly?'尚未执行':statusLabel(task.status, task.runtime, task.phase))}${attention}${waiting}${updated ? `，更新于 ${updated}` : ''}`
  const stateHtml = pendingPermissionCount > 0
    ? `<span class="wb-task-attention" data-status="${escapeWorkbenchHtml(statusValue(task))}" aria-label="${escapeWorkbenchHtml((task.importedOnly?'尚未执行':statusLabel(task.status, task.runtime, task.phase)))}，${escapeWorkbenchHtml(pendingPermissionCount)} 项权限请求等你确认">等你确认 · ${escapeWorkbenchHtml(pendingPermissionCount)}</span>`
    : pendingQuestionCount > 0 ? `<span class="wb-task-attention" aria-label="${escapeWorkbenchHtml(pendingQuestionCount)} 项问题等你回答">等你回答 · ${escapeWorkbenchHtml(pendingQuestionCount)}</span>` : `<span class="wb-status" data-status="${escapeWorkbenchHtml(statusValue(task))}">${escapeWorkbenchHtml(waitingLabel || (task.importedOnly?'尚未执行':statusLabel(task.status, task.runtime, task.phase)))}</span>`
  return `<button type="button" class="wb-task ${task.id === selectedId ? 'is-selected' : ''}" data-task-id="${escapeWorkbenchHtml(task.id)}" aria-label="${escapeWorkbenchHtml(accessibleLabel)}"${updated ? ` title="${escapeWorkbenchHtml(`${title} · ${updated}`)}"` : ''}>
    <span class="wb-task-title" title="${escapeWorkbenchHtml(title)}">${escapeWorkbenchHtml(title)}</span>
    <span class="wb-task-meta"><span class="wb-task-provider">${escapeWorkbenchHtml(provider)}</span>${stateHtml}</span>
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
    helper: state.providers.find(p => p.id === detail?.task.providerId)?.displayName || detail?.task.providerId || '执行助手',
    handoffs,
    origin: handoffs.find(h => h.purpose === 'review' && h.targetTaskId === detail?.task.id),
    otherProvider: state.providers.find(p => p.id !== detail?.task.providerId),
    lastReply: events.filter(e => e.kind === 'text').at(-1),
    actionable: detail?.task.archivedAt == null && ['completed', 'failed', 'cancelled', 'interrupted'].includes(detail?.task.status ?? ''),
  }
}

/** @param {MessageContext} context @returns {(event:WorkbenchEvent)=>string} */
export function renderMessageFor({ detail, helper, handoffs, actionable, lastReply, otherProvider, origin }) {
  return event => `<article class="wb-message" id="${workbenchTimelineEventId(event)}" data-timeline-anchor data-kind="${escapeWorkbenchHtml(event.kind)}">
    <header><span>${event.kind === 'user' ? '你' : `<span class="wb-provider-badge">${escapeWorkbenchHtml(helper)}</span>`}</span><time>${escapeWorkbenchHtml((event.sourceId?'原会话记录':time(event.createdAt)))}</time></header>
    ${handoffs.some(h=>h.requestEventId===Number(event.id))?`<div class="wb-message-body"><p>${escapeWorkbenchHtml(handoffs.find(h=>h.requestEventId===Number(event.id))?.request)}</p><button class="wb-new" data-action="handoff-record" data-handoff-id="${escapeWorkbenchHtml(handoffs.find(h=>h.requestEventId===Number(event.id))?.id)}">查看随附的交接内容</button></div>`:event.kind === 'text' ? `<div class="wb-message-body wb-markdown">${renderWorkbenchMarkdown(event.text)}</div>` : `<p class="wb-message-body">${escapeWorkbenchHtml(event.text)}</p>`}
    ${renderMessageAttachments(detail?.task.id??'',event.attachments)}
    ${actionable&&event.kind==='text'&&(origin||(event===lastReply&&otherProvider))?`<button type="button" class="wb-new wb-handoff-action" data-action="${origin?'handoff-revision':'handoff-review'}" data-event-id="${event.id}">${origin?'选择意见，交回原任务':`交给 ${escapeWorkbenchHtml(otherProvider?.displayName)} 检查`}</button>`:''}
  </article>`
}

/** @param {{catalog?:import('./workbench-execution.js').CatalogState,restartPreview?:import('./workbench-execution.js').ContinuationPreviewState,busy?:boolean}} [executionView] @param {WorkbenchState} state @param {import('./workbench-interaction.js').Interactions} [interactions] @param {Draft} [draft] @param {string} [attachmentError] */
export function renderWorkbench(state, interactions, draft, attachmentError='',executionView={}) {
  const tasks = state.tasks ?? []
  const detail = state.detail
  const query = state.query ?? { q: '', archived: 'exclude' }
  const listEmptyCopy = state.error ? '暂时没能读取任务列表。' : query.q ? '没有找到匹配的任务。试试其他任务名称或文件夹。' : query.archived === 'only' ? '还没有已归档的任务。' : '还没有任务。选一个文件夹，把要做的事交给执行者。'
  const selectedArtifact = detail?.artifacts?.find(a => a.id === state.selectedArtifactId)
  const taskList = tasks.length ? groupWorkbenchTasks(tasks).map((project, index) => `<section class="wb-project" aria-labelledby="wb-project-${index}">
    <header title="${escapeWorkbenchHtml(project.path)}"><h3 id="wb-project-${index}">${escapeWorkbenchHtml(project.label)}</h3><button type="button" class="wb-new wb-project-new" data-action="new-project-task" data-project-path="${escapeWorkbenchHtml(project.path)}" aria-label="在 ${escapeWorkbenchHtml(project.label)} 新建任务">＋</button></header>
    <div>${project.tasks.map(task => renderTask(task, state.providers, state.loadingId ?? state.selectedId)).join('')}</div>
  </section>`).join('') : `<p class="wb-empty-copy">${listEmptyCopy}</p>`
  // 「一件事」:在桌面露过面的对话(主人跟 CC 说的那条)也在这张列表里,排在任务上面。
  const chats = state.chats ?? []
  const chatList = chats.length ? `<section class="wb-project wb-chats" aria-labelledby="wb-chats"><header><h3 id="wb-chats">对话</h3></header><div>${chats.map(chat => `<button type="button" class="wb-task ${chat.id === state.selectedMatterId ? 'is-selected' : ''}" data-matter-id="${escapeWorkbenchHtml(chat.id)}" aria-label="${escapeWorkbenchHtml(chat.title)}"><span class="wb-task-title">${escapeWorkbenchHtml(chat.title)}</span><span class="wb-task-meta"><span class="wb-task-provider">跟 CC 说</span></span></button>`).join('')}</div></section>` : ''
  const listControls = `<div class="wb-list-controls"><form id="wb-search-form" class="wb-search"><label class="wb-sr-only" for="wb-search">搜索任务名称、文件夹或任务编号</label><input id="wb-search" name="q" type="search" maxlength="200" placeholder="搜索任务或文件夹" value="${escapeWorkbenchHtml(query.q)}"><button class="wb-new" type="submit" aria-label="搜索任务">搜索</button></form><div class="wb-list-filters"><button class="wb-new" type="button" data-action="toggle-archived" aria-pressed="${query.archived === 'only'}">${query.archived === 'only' ? '返回任务' : '已归档'}</button>${state.historyProviders?.length?'<button class="wb-new" type="button" data-action="native-history">已有会话</button>':''}${query.q ? '<button class="wb-new" type="button" data-action="clear-search">清除搜索</button>' : ''}</div>${query.archived === 'only' ? '<p class="wb-archive-label">已归档的任务</p>' : ''}</div>`
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
  const permissionHtml = permissions.length ? `<section class="wb-permissions" aria-label="等待处理的权限请求"><header><h3>需要你的决定</h3><span>${permissions.length} 项</span></header>${permissions.map(permission => `<article class="wb-permission"><div><span class="wb-permission-tool">${escapeWorkbenchHtml(permission.tool)}</span><p>${escapeWorkbenchHtml(permission.description)}</p><time>${escapeWorkbenchHtml(time(permission.createdAt))}</time></div><div class="wb-permission-actions"><button class="wb-btn" type="button" data-action="deny-permission" data-request-id="${escapeWorkbenchHtml(permission.id)}">拒绝</button><button class="wb-btn wb-btn-primary" type="button" data-action="allow-permission" data-request-id="${escapeWorkbenchHtml(permission.id)}">允许</button></div></article>`).join('')}</section>` : ''
  const artifacts = detail?.artifacts?.length ? detail.artifacts.map(artifact => `<button type="button" class="wb-artifact ${artifact.id === state.selectedArtifactId ? 'is-selected' : ''}" data-artifact-id="${escapeWorkbenchHtml(artifact.id)}"><span>${escapeWorkbenchHtml(artifact.name)}</span><small>${escapeWorkbenchHtml((artifact.size / 1024).toFixed(1))} KB · ${artifact.approvedAt ? '已确认' : '待确认'}</small></button>`).join('') : ''
  const previewContent = selectedArtifact && state.preview?.artifactId === selectedArtifact.id ? state.preview.html : '<p class="wb-preview-hint">选择文件，查看保存的成果版本。</p>'
  // 「改动」在「成果」之前:主人先看这一轮改了什么,再去翻保存下来的成果。
  // 整块面板共用一份预览额度(和「成果」里那份报告同样的 256KiB / 4000 行):
  // 十几轮 × 几十个文件不能各渲各的,不然这一页会被 diff 压垮。
  const reviewBudget = createReviewDiffBudget()
  const reviewHtml = detail ? renderReviewPanel(state.reviews ?? [], { escapeHtml: escapeWorkbenchHtml, formatTime: time, renderDiff: file => renderReviewFileDiff(file, escapeWorkbenchHtml, reviewBudget), budget: reviewBudget, returnOpen: state.reviewReturnOpen ?? null, error: !!state.reviewsError }) : ''
  const artifactHtml = detail?.artifacts?.length ? `<details id="wb-artifacts" class="wb-disclosure wb-artifacts"><summary><span>成果</span><small>${detail.artifacts.length} 件</small></summary><button type="button" class="wb-new wb-back-dialogue" data-action="back-to-dialogue">返回对话</button><div class="wb-artifact-list">${artifacts}</div><div id="wb-preview" class="wb-preview">${selectedArtifact ? `<p class="wb-preview-name">${escapeWorkbenchHtml(selectedArtifact.name)}</p><div class="wb-preview-content">${previewContent}</div><button type="button" class="wb-btn" data-action="download-artifact">下载</button>${selectedArtifact.approvedAt ? '<p class="wb-approved">已确认此版本</p>' : '<button type="button" class="wb-btn wb-btn-primary" data-action="approve-artifact">确认这份成果</button>'}` : ''}</div></details>` : ''
  const execution=draft?.execution??detail?.execution??{defaults:/** @type {const} */('provider'),model:null,reasoningEffort:null}
  const executionDisabled=!!executionView.busy||!!(detail&&(detail.task.archivedAt!=null||['running','queued','cancelling'].includes(detail.task.status)))
  const executionControls=renderExecutionControls(execution,executionView.catalog,executionDisabled)
  const chatHeader = !detail && state.selectedMatterId && chats.some(c => c.id === state.selectedMatterId) ? `<header class="wb-task-head"><div><p class="wb-task-context">对话 · 跟 CC 说</p><h2>${escapeWorkbenchHtml(chats.find(c => c.id === state.selectedMatterId)?.title ?? '')}</h2></div></header>` : ''
  const taskHeader = detail ? `<header class="wb-task-head"><div><p class="wb-task-context">${escapeWorkbenchHtml(pathParts(detail.task.path).name)} · ${escapeWorkbenchHtml(helper)}</p><h2 title="${escapeWorkbenchHtml(detail.task.title || '未命名任务')}">${escapeWorkbenchHtml(detail.task.title || '未命名任务')}</h2>${isUnattendedProvider(state.providers.find(p => p.id === detail.task.providerId)) ? '<p class="wb-task-unattended">免审执行者 · 看不到单步,只能停止</p>' : ''}</div><div class="wb-task-head-actions">${detail.artifacts.length ? `<button type="button" class="wb-new" data-action="show-artifacts">成果 · ${detail.artifacts.length}</button>` : ''}<span class="wb-status" data-status="${escapeWorkbenchHtml(statusValue({...detail.task,runtime:detail.runtime ?? detail.task.runtime}))}">${escapeWorkbenchHtml((detail.task.importedOnly?'尚未执行':statusLabel(detail.task.status, detail.runtime ?? detail.task.runtime)))}</span><details id="wb-task-info" class="wb-task-info"><summary>任务详情</summary><div class="wb-task-info-body"><dl><div><dt>完整路径</dt><dd class="wb-path">${escapeWorkbenchHtml(detail.task.path)}</dd></div><div><dt>任务编号</dt><dd><code>${escapeWorkbenchHtml(detail.task.id)}</code></dd></div><div><dt>执行者</dt><dd>${escapeWorkbenchHtml(helper)}</dd></div><div><dt>更新时间</dt><dd>${escapeWorkbenchHtml(time(detail.task.updatedAt))}</dd></div>${detail.source?`<div><dt>原会话</dt><dd>${escapeWorkbenchHtml(detail.source.providerId)} · <code>${escapeWorkbenchHtml(detail.source.nativeId)}</code></dd></div><div><dt>已保存的原记录</dt><dd>${detail.source.selectedMessageCount} 段${detail.source.truncated?' · 部分文字':''}</dd></div>`:''}</dl><section class="wb-task-execution"><h3>下一轮使用</h3>${executionControls}${renderExecutionObservation(detail.lastExecution)}</section>${detail.task.archivedAt != null ? '<div class="wb-task-organization"><button type="button" class="wb-btn" data-action="restore-task">恢复任务</button></div>' : detail.task.canArchive === true ? '<div class="wb-task-organization"><button type="button" class="wb-btn" data-action="archive-task">归档任务</button></div>' : ''}${state.canWechat && detail.task.archivedAt == null ? `<div class="wb-wechat"><span>在微信继续</span><code>任务 ${escapeWorkbenchHtml(detail.task.id)}</code><button type="button" class="wb-btn" data-action="copy-wechat-command">复制</button></div>` : ''}</div></details></div></header>` : ''
  const selectedChat = !detail && state.selectedMatterId ? chats.find(c => c.id === state.selectedMatterId) : undefined
  const content = selectedChat ? `
    <div id="wb-converse-host" class="wb-converse-host" data-matter-id="${escapeWorkbenchHtml(selectedChat.id)}"></div>` : detail ? `
    ${related}
    <section class="wb-dialogue" aria-live="polite">${dialogueHtml}</section>
    ${queuedGuidance}
    ${renderWorkbenchInputs(detail.task.id, detail.inputs ?? [], interactions,!!detail.runtime?.retained)}
    ${detail.task.error ? `<div class="wb-error" role="alert">${escapeWorkbenchHtml(executionErrorMessage(detail.task.error)??detail.task.error)}</div>` : ''}
    ${reviewHtml}
    ${artifactHtml}` : state.loadingId ? `
    <div class="wb-welcome wb-task-loading" role="status"><p class="wb-kicker">打开任务</p><h1>正在打开任务…</h1><p>正在读取这项任务的对话和成果。</p></div>` : `
    ${state.error && !state.providers.length ? '<div class="wb-welcome"><p class="wb-kicker">一起做</p><h1>暂时没能打开手头的事。</h1><p>连接恢复后，就能继续查看任务和交代新事情。</p><button class="wb-btn" type="button" data-action="refresh">重新连接</button></div>' : ''}
    <div class="wb-welcome" ${state.error && !state.providers.length ? 'hidden' : ''}><p class="wb-kicker">新的一件事</p><h1>我们一起做点什么？</h1><p>说说你想做的事，再选一个放材料的文件夹。</p>
      <form id="wb-create-form" class="wb-create-form">
        <label>文件夹<div class="wb-folder-row"><input id="wb-path" name="path" required aria-describedby="wb-folder-help" placeholder="选择或粘贴一个本机文件夹"><button type="button" class="wb-btn" data-action="choose-folder">选择…</button></div><small id="wb-folder-help" class="wb-field-help">也可以直接粘贴完整路径；原生选择目前只在 macOS 提供。</small></label>
        <label>要做什么<textarea id="wb-create-text" name="text" rows="4" maxlength="20000" placeholder="例如：整理这些访谈记录，做一份主题摘要和引用表"></textarea></label>
        ${renderAttachmentComposer(draft,attachmentError)}
        ${state.providers.length ? '' : '<p class="wb-provider-missing" role="alert">暂时没有可用的工作执行者。请连接或管理一个支持工作任务的执行者后再开始任务。</p>'}
        <details id="wb-options" class="wb-options"><summary>执行者与命名 <span>当前使用 ${escapeWorkbenchHtml((p => p ? providerLabel(p) : '尚未选择执行者')(state.providers.find(p => p.id === state.defaultProvider)))}</span></summary><label>执行者<select id="wb-provider" name="providerId"${executionView.busy?' disabled':''}>${(state.providers ?? []).map((p) => `<option value="${escapeWorkbenchHtml(p.id)}" ${p.id === state.defaultProvider ? 'selected' : ''}>${escapeWorkbenchHtml(providerLabel(p))}</option>`).join('')}</select></label>
        ${executionControls}<label>任务名称 <span class="wb-optional">可选</span><input id="wb-title" name="title" placeholder="留空时使用任务要求的前 40 个字"></label></details>
        <button class="wb-btn wb-btn-primary" type="submit"${state.providers.length&&!draft?.attachments?.some(a=>a.status!=='ready') ? '' : ' disabled'}>开始任务</button>
      </form></div>`
  const chosenContinuation=executionView.restartPreview?(executionView.restartPreview.status==='ready'?executionView.restartPreview.continuation??undefined:{mode:'restart_required'}):detail?.continuation
  const previewError=executionView.restartPreview?.error?`<p class="wb-interaction-error" role="alert">${escapeWorkbenchHtml(executionView.restartPreview.error)} <button type="button" class="wb-new" data-action="retry-continuation-preview">重新读取恢复说明</button></p>`:''
  const controls = detail ? `<div class="wb-controls"><div class="wb-controls-inner">${permissionHtml}${renderWorkbenchQuestions(detail.task.id, detail.questions ?? [], interactions)}${previewError}${renderTaskControls(detail.task.status, chosenContinuation, detail.task.archivedAt,{requiresClose:!!detail.requiresExternalClose,decision:state.nativeResume?.taskId===detail.task.id?state.nativeResume:null},{taskId:detail.task.id,runId:detail.runId,inputMode:detail.inputMode,runtime:detail.runtime,...interactions?.inputState(detail.task.id)},draft,attachmentError)}</div></div>` : ''
  return `<div class="workbench-shell"><aside class="wb-sidebar"><header><p class="wb-kicker">一件事</p><button type="button" class="wb-new" data-action="new-task">＋ 新建</button></header>${listControls}<div class="wb-task-list">${chatList}${taskList}</div>${pagination}</aside><main class="wb-main">${taskHeader || chatHeader}<div class="wb-content"><div class="wb-content-inner">${state.error ? `<div class="wb-error" role="alert">${escapeWorkbenchHtml(state.error)}</div>` : ''}${content}</div></div>${detail ? '<div class="wb-reading-bar" hidden><button type="button" class="wb-btn" data-action="latest-content">有新内容 ↓</button></div>' : ''}${controls}</main></div>`
}

/** @param {{invokeWorkbenchApi:WorkbenchDeps['invokeWorkbenchApi'],render:(state:WorkbenchState)=>void,initialScope?:string|null,initialQuery?:TaskQuery,patchLive?:(changed:WorkbenchEvent[])=>boolean}} deps */
export function createWorkbenchController(deps) {
  /** @type {WorkbenchState} */
  const state = { reviews: /** @type {ReviewTurn[]} */ ([]), reviewsSignature: EMPTY_REVIEWS, reviewsError: false, reviewReturnOpen: /** @type {ReviewReturnOpen|null} */ (null), chats: [], selectedMatterId: null, version: 0, tasks: [], providers: [], defaultProvider: '', canWechat: false, selectedId: null, loadingId: null, detail: null, selectedArtifactId: null, error: '', preview: null, query: { ...(deps.initialQuery ?? { q: '', archived: 'exclude' }) }, loadingMore: false, newScope: deps.initialScope?.startsWith('new:') ? deps.initialScope : 'new' }
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
  const paintKey = () => JSON.stringify({ ...state, reviews: undefined, tasks: (state.tasks ?? []).map(task => ({ ...task, updatedAt: 0, ...(task.waitingFor ? { waitingFor: { ...task.waitingFor, closeInMs: 0 } } : {}) })) })
  const paint = (force = false) => {
    const snapshot = paintKey()
    if (!force && snapshot === lastPaint) return
    lastPaint = snapshot
    deps.render(state)
  }
  // 增量补丁已经把变过的行写进 DOM 了:把重画基准对齐,免得下一次 paint() 为同一批
  // 事件再整页重画一次(那会打断输入和滚动)。
  const syncPaintSnapshot = () => { lastPaint = paintKey() }
  const forgetReviews = () => { state.reviews = []; state.reviewsSignature = EMPTY_REVIEWS; state.reviewsError = false; state.reviewReturnOpen = null }
  /** 改动记录跟详情并行拉:读不到只在面板上照实说一句,详情照旧。
   * 标记可能是别的面(微信)改的,所以每次长轮询回来都再问一次;签名没变就不重画。
   * @param {string} id */
  const loadReviews = id => {
    const request = detailRequest
    const current = () => alive && request === detailRequest && state.selectedId === id
    void deps.invokeWorkbenchApi('GET', `/v1/workbench/review?id=${encodeURIComponent(id)}`).then(response => {
      if (!current()) return
      const list = /** @type {{reviews?:ReviewTurn[]}} */ (response)?.reviews
      const reviews = Array.isArray(list) ? list : []
      const signature = reviewsSignature(reviews)
      const changed = signature !== state.reviewsSignature || state.reviewsError
      state.reviews = reviews
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
    if (artifactsSignature(state.detail) !== previousArtifacts || (advanced && !changed.length)) loadReviews(detail.task.id)
    if (restructured) { paint(true); return }
    if (!changed.length) { syncPaintSnapshot(); return }
    // 第一条事件要顶掉「还没有对话记录」那句:那不是补丁干得了的事。
    if (!(previous.events ?? []).length || !deps.patchLive?.(changed)) { paint(true); return }
    syncPaintSnapshot()
  }
  const livePoll = createLongPoll({
    fetchDetail: (id, since, waitMs) => deps.invokeWorkbenchApi('GET', `/v1/workbench/task?id=${encodeURIComponent(id)}&since=${since}&wait_ms=${waitMs}`),
    onDetail: detail => applyLiveDetail(/** @type {Detail} */ (detail)),
    // 详情这条腿安静重试:连不上后台的话,3 秒那条列表腿已经在报错了。
    onError: () => {},
  })
  /** @param {string|null} [cursor] */
  const listPath = cursor => {
    const params = new URLSearchParams()
    if (state.query?.q) params.set('q', state.query.q)
    if (state.query?.archived && state.query.archived !== 'exclude') params.set('archived', state.query.archived)
    if (cursor) params.set('cursor', cursor)
    return `/v1/workbench${params.size ? `?${params}` : ''}`
  }
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
      // 对话那一栏来自「一件事」列表;读不到就没有这一栏,任务照旧。
      void deps.invokeWorkbenchApi('GET', '/v1/matters?kind=chat&surface=desktop&status=open,replied&limit=3').then(r => {
        if (!alive || request !== listRequest) return
        const matters = /** @type {{matters?:ChatMatter[]}} */ (r)?.matters
        if (Array.isArray(matters)) { state.chats = matters; paint() }
      }).catch(() => {})
      try {
        result = /** @type {ListResult} */ (await deps.invokeWorkbenchApi('GET', listPath()))
        if (!alive || request !== listRequest) return
        while (pages < loadedPages && result.page?.hasMore && result.page.nextCursor) {
          const next = /** @type {ListResult} */ (await deps.invokeWorkbenchApi('GET', listPath(result.page.nextCursor)))
          if (!alive || request !== listRequest) return
          result = { ...next, tasks: dedupe([...result.tasks, ...next.tasks]), projectProviders: { ...result.projectProviders, ...next.projectProviders } }
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
      const path = listPath(state.page.nextCursor)
      state.loadingMore = true
      paint()
      try {
        const result = /** @type {ListResult} */ (await deps.invokeWorkbenchApi('GET', path))
        if (!alive || request !== listRequest) return
        state.tasks = dedupe([...state.tasks, ...result.tasks])
        state.page = result.page
        state.projectProviders = { ...state.projectProviders, ...result.projectProviders }
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
    // 选中一件对话:右边换成会话面(converse 控件由页面挂进 #wb-converse-host)。
    selectMatter(/** @type {string} */ id) { detailRequest++; livePoll.stop(); forgetReviews(); desiredId = null; composingNewTask = false; state.selectedMatterId = id; state.selectedId = null; state.loadingId = null; state.detail = null; state.selectedArtifactId = null; paint() },
    /** @param {string} id */
    async selectTask(id) {
      state.selectedMatterId = null
      if (state.selectedId !== id) forgetReviews()
      livePoll.stop()
      desiredId = id
      composingNewTask = false
      const request = ++detailRequest
      if (!state.detail) { state.loadingId = id; paint() }
      /** @type {Detail} */
      let result
      try { result = /** @type {Detail} */ (await deps.invokeWorkbenchApi('GET', `/v1/workbench/task?id=${encodeURIComponent(id)}`)) }
      catch (error) {
        if (!alive || request !== detailRequest || desiredId !== id) return
        desiredId = null
        state.loadingId = null
        throw error
      }
      if (!alive || request !== detailRequest || desiredId !== id) return
      state.selectedId = id
      desiredId = null
      state.loadingId = null
      state.detail = result
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
    newTask(path) { detailRequest++; livePoll.stop(); forgetReviews(); desiredId = null; composingNewTask = true; state.selectedMatterId = null; state.newScope = path ? `new:${path}` : 'new'; state.selectedId = null; state.loadingId = null; state.detail = null; state.selectedArtifactId = null; paint() },
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
  let alive = true
  let handoffCleanup = /** @type {(()=>void)|null} */ (null)
  let nativeHistoryCleanup = /** @type {(()=>void)|null} */ (null)
  let artifactRequest = 0
  let navigationGeneration = 0
  /** @type {string|null} */
  let objectUrl = null
  let attachmentPreviewCleanup=/** @type {(()=>void)|null} */(null)
  const initialScope = resumeScope
  let searchDraft = resumeSearch
  let renderedScope = initialScope ?? 'new'
  let hasPainted = false
  const interactions = createWorkbenchInteractions({ invokeWorkbenchApi: deps.invokeWorkbenchApi, storage: windowStorage, inputAttempts: pageInputAttempts, changed: () => { if (alive) controller.paint(true) } })
  /** @type {Map<string, Map<string, boolean>>} */
  const disclosures = new Map()
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
  const browsingResults = () => !!root.querySelector('#wb-artifacts[open]') || !!root.querySelector('#wb-review[open]') || !!root.querySelector('[data-timeline-disclosure][open]') || resultReturnPositions.has(renderedScope)
  const scopeFor = (/** @type {WorkbenchState} */ state) => state.selectedId ? `task:${state.selectedId}` : state.newScope ?? 'new'
  const readingSignatureFor = (/** @type {WorkbenchState} */ state) => state.detail ? JSON.stringify([state.detail.task.status, state.detail.task.error, state.detail.events, state.detail.artifacts.map(a => [a.id, a.sha256])]) : ''
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
    }
    if (!document.getElementById('wb-create-form') && !input('wb-followup-text')) return
    const model=input('wb-model'),effort=input('wb-reasoning-effort'),draft=pageDrafts.get(renderedScope)
    const execution=model&&effort?{defaults:/** @type {'provider'|'native'} */(model.dataset.executionDefaults??draft.execution?.defaults??controller.state.detail?.execution?.defaults??'provider'),model:model.value||null,reasoningEffort:effort.value||null}:undefined
    pageDrafts.set(renderedScope, { ...draft,...(execution?{execution}:{}), path: input('wb-path')?.value ?? '', text: input('wb-create-text')?.value ?? '', title: input('wb-title')?.value ?? '', providerId: input('wb-provider')?.value ?? '', followup: input('wb-followup-text')?.value ?? '' })
  }
  const restoreDraft = (/** @type {string} */ scope) => {
    const draft = pageDrafts.get(scope)
    if(draft.execution){const model=input('wb-model'),effort=input('wb-reasoning-effort');if(model)model.value=draft.execution.model??'';if(effort)effort.value=draft.execution.reasoningEffort??''}
    for (const [id, value] of /** @type {Array<[string,string]>} */ ([['wb-path', draft.path], ['wb-create-text', draft.text], ['wb-title', draft.title], ['wb-provider', draft.providerId], ['wb-followup-text', draft.followup]])) {
      const field = input(id); if (field && value) field.value = value
    }
  }
  const attachments=createWorkbenchAttachments({drafts:pageDrafts,invokeWorkbenchApi:deps.invokeWorkbenchApi,changed:scope=>{if(alive&&scope===renderedScope)controller.paint(true)}})
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
      current.unread = following ? false : current.unread || result.patched + result.appended > 0
    }
    if (following && content) content.scrollTop = content.scrollHeight
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
        if (draft.followup === acknowledged) { draft.followup = ''; if(draft.attachments?.length)draft.attachments=[]; pageDrafts.set(taskScope, draft) }
        const field = input('wb-followup-text')
        if (renderedScope === taskScope && field?.value === acknowledged) field.value = ''
      }
    }
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
    const hasStoredScroll = scrollPositions.has(nextScope) || renderedScope === nextScope
    const openState = new Map(['wb-artifacts', 'wb-review', 'wb-options', 'wb-task-info', 'wb-restart-context', 'wb-artifact-source','wb-handoffs'].map(id => [id, !!root.querySelector(`#${id}[open]`)]))
    if (root.querySelector('#wb-inputs')) openState.set('wb-inputs', !!root.querySelector('#wb-inputs[open]'))
    for (const disclosure of root.querySelectorAll?.('[data-review-disclosure]') ?? []) openState.set(disclosure.id, disclosure.hasAttribute('open'))
    for (const disclosure of root.querySelectorAll?.('[data-timeline-disclosure]') ?? []) openState.set(disclosure.id, disclosure.hasAttribute('open'))
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
    scrollPositions.set(renderedScope, contentScroll)
    const currentPermissionScroll = root.querySelector('.wb-permissions')?.scrollTop
    const currentPermissionState = permissionScrollPositions.get(renderedScope)
    if (currentPermissionScroll !== undefined && currentPermissionState) currentPermissionState.scrollTop = currentPermissionScroll
    const currentTaskInfoScroll = root.querySelector('.wb-task-info-body')?.scrollTop
    if (currentTaskInfoScroll !== undefined) taskInfoScrollPositions.set(renderedScope, currentTaskInfoScroll)
    const nextPermissionSignature = permissionSignatureFor(state)
    const sameScope = renderedScope === scopeFor(state)
    const questionPanelScroll = root.querySelector('.wb-questions')?.scrollTop ?? 0
    const nextDraft=pageDrafts.get(nextScope),providerId=state.detail?.task.providerId??nextDraft.providerId??state.defaultProvider??'',path=state.detail?.task.path??nextDraft.path
    root.innerHTML = renderWorkbench(state, interactions,nextDraft,attachments.error(nextScope),{catalog:catalogs.get(providerId||state.defaultProvider||'',path),...(restartPreviewContext()?{restartPreview:recoveryPreviews.get(/** @type {import('./workbench-execution.js').ContinuationContext} */(restartPreviewContext()))}:{}),busy:busy.has(state.detail?`task:${state.detail.task.id}`:'create')})
    const questionPanel = root.querySelector('.wb-questions')
    if (questionPanel && sameScope) questionPanel.scrollTop = questionPanelScroll
    // 会话面:每次重画都把「跟 CC 说」的控件挂回新的宿主;没选对话就放回原处。
    const converseHost = /** @type {HTMLElement|null} */ (root.querySelector('#wb-converse-host'))
    if (converseHost) deps.mountConverse?.(converseHost); else deps.unmountConverse?.()
    hasPainted = true
    const search = input('wb-search'); if (search) search.value = searchDraft
    const sidebar = root.querySelector('.wb-sidebar'); if (sidebar) sidebar.scrollTop = sidebarScroll
    for (const [id, open] of disclosures.get(scopeFor(state)) ?? []) root.querySelector(`#${id}`)?.toggleAttribute('open', open)
    const content = root.querySelector('.wb-content')
    if (content) {
      const follow = nextScope.startsWith('task:') && nextReading.following && (newActivity || !sameScope)
      content.scrollTop = follow ? content.scrollHeight : hasStoredScroll ? (scrollPositions.get(nextScope) ?? 0) : nextScope.startsWith('task:') ? content.scrollHeight : 0
      if (follow) nextReading.unread = false
      else if (!nextReading.following) {
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
    if (nextFocus) { nextFocus.focus({ preventScroll: true }); if (focused && focused.start !== null && focused.end !== null && 'setSelectionRange' in nextFocus) nextFocus.setSelectionRange(focused.start, focused.end) }
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
  const confirmUnattended = deps.confirmUnattended ?? (() => mountUnattendedDialog())
  /** 第一次把事交给免审执行者时后台回 428。当面确认一次,登记下来,再把同一份请求
   * 原样重发;主人说「先不用」就到此为止,不当成出错。
   * @param {'GET'|'POST'} method @param {string} path @param {Record<string,unknown>} body */
  const sendMutation = async (method, path, body) => {
    try { return /** @type {{task?:Task}} */ (await deps.invokeWorkbenchApi(method, path, body)) }
    catch (error) {
      if (!isAckRequiredError(error)) throw error
      if (!(await confirmUnattended()) || !alive) return null
      await deps.invokeWorkbenchApi('POST', '/v1/workbench/unattended-ack')
      return /** @type {{task?:Task}} */ (await deps.invokeWorkbenchApi(method, path, body))
    }
  }
  /** onError 让调用方自己接住一类错误(打回遇上「要重开」就是这样):回 true 表示这一笔已经
   * 当场交代清楚了,别再往全局那条错误里塞一句看不懂的话。
   * @param {'GET'|'POST'} method @param {string} path @param {Record<string,unknown>} body
   * @param {(error:unknown)=>boolean|Promise<boolean>} [onError] */
  const mutate = async (method, path, body, onError) => {
    const key = path === '/v1/workbench/create' ? 'create' : `task:${String(body.id ?? '')}`
    if (busy.has(key) || !alive) return false
    busy.add(key);controller.paint(true)
    const navigation = navigationGeneration
    try {
      const result = await sendMutation(method, path, body)
      if (!alive || !result) return false
      const id = result.task?.id ?? controller.state.selectedId
      await controller.refresh({ force: true })
      if (alive && path === '/v1/workbench/create' && navigation === navigationGeneration && id && controller.state.selectedId !== id) await controller.selectTask(id)
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
  const openTask = async (/** @type {string} */ id) => {
    if (!alive || !id) return
    captureDraft(); artifactRequest++
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
  /** @param {Event} event */
  const onClick = async event => {
    const target = event.target instanceof Element ? event.target.closest('button') : null
    if (!target) return
    if (target.dataset.taskId) return openTask(target.dataset.taskId)
    if (target.dataset.matterId) { captureDraft(); navigationGeneration++; artifactRequest++; controller.selectMatter(target.dataset.matterId); return }
    let action = target.dataset.action
    if(action==='choose-attachments'){
      captureDraft();const scope=renderedScope
      const picker=document.createElement('input');picker.type='file';picker.multiple=true
      picker.addEventListener('change',()=>{void attachments.add(scope,Array.from(picker.files??[]))},{once:true})
      picker.click();return
    }
    if(action==='retry-continuation-preview'){const context=restartPreviewContext();if(context)void recoveryPreviews.load(context,true);return}
    if(action==='retry-execution-models'){loadExecutionCatalog(true);return}
    if(action==='remove-attachment'&&target.dataset.attachmentId){captureDraft();attachments.remove(renderedScope,target.dataset.attachmentId);if(controller.state.selectedId)interactions.editInputDraft(controller.state.selectedId,input('wb-followup-text')?.value??'',pageDrafts.get(renderedScope).attachments,pageDrafts.get(renderedScope).execution);return}
    if((action==='preview-input-attachment'||action==='download-input-attachment')&&target.dataset.attachmentId){
      const taskId=target.dataset.ownerTask,id=target.dataset.attachmentId,navigation=navigationGeneration
      if(!taskId||controller.getTargetTaskId()!==taskId)return
      try{
        const data=/** @type {{attachment:import('./workbench-attachments.js').Attachment,base64:string}} */(await deps.invokeWorkbenchApi('GET',`/v1/workbench/attachment?taskId=${encodeURIComponent(taskId)}&id=${encodeURIComponent(id)}`))
        if(!alive||navigation!==navigationGeneration||controller.state.selectedId!==taskId)return
        if(data.attachment.id!==id)throw Error('附件版本不匹配，请重新打开。')
        const a=data.attachment,bytes=decodeBase64(data.base64),url=URL.createObjectURL(new Blob([bytes],{type:a.mime}))
        const download=()=>{const link=document.createElement('a');link.href=url;link.download=a.name;link.click()}
        if(action==='download-input-attachment'){download();setTimeout(()=>URL.revokeObjectURL(url),1000);return}
        attachmentPreviewCleanup?.()
        const dialog=document.createElement('dialog');dialog.className='wb-history-dialog wb-input-preview';dialog.setAttribute('aria-label',a.name)
        const body=a.mime.startsWith('image/')?`<img src="${url}" alt="${escapeWorkbenchHtml(a.name)}">`:a.mime==='application/pdf'?`<iframe src="${url}" title="${escapeWorkbenchHtml(a.name)}"></iframe>`:a.mime.startsWith('text/')||a.mime==='application/json'?`<pre>${escapeWorkbenchHtml(new TextDecoder().decode(bytes))}</pre>`:'<p>下载后可在本机应用中查看。</p>'
        dialog.innerHTML=`<header><h2>${escapeWorkbenchHtml(a.name)}</h2><button type="button" class="wb-new" data-close-attachment>关闭</button></header><div class="wb-input-preview-body">${body}</div><footer><button type="button" class="wb-btn" data-download-attachment>下载</button></footer>`
        const cleanup=()=>{URL.revokeObjectURL(url);dialog.remove();if(attachmentPreviewCleanup===cleanup)attachmentPreviewCleanup=null}
        attachmentPreviewCleanup=cleanup;dialog.addEventListener('close',cleanup,{once:true});dialog.querySelector('[data-close-attachment]')?.addEventListener('click',()=>dialog.close());dialog.querySelector('[data-download-attachment]')?.addEventListener('click',download)
        document.body.append(dialog);dialog.showModal()
      }catch(error){if(alive&&navigation===navigationGeneration&&controller.state.selectedId===taskId)fail(error)}
      return
    }
    // 改动面板的按钮也带 data-artifact-id(那是快照那件成果),必须赶在下面
    // 「点成果就预览」那条分支之前认领,否则一点接受就跳去预览了。
    if (action === 'review-accept' && controller.state.selectedId && target.dataset.artifactId && target.dataset.path) {
      return mutate('POST', '/v1/workbench/review-mark', { id: controller.state.selectedId, artifactId: target.dataset.artifactId, path: target.dataset.path, mark: 'accepted' })
    }
    if (action === 'review-return' && target.dataset.artifactId && target.dataset.path) {
      captureDraft()
      const artifactId = target.dataset.artifactId, path = target.dataset.path
      const open = controller.state.reviewReturnOpen
      if (open?.artifactId === artifactId) {
        const paths = open.paths.includes(path) ? open.paths.filter(item => item !== path) : [...open.paths, path]
        controller.state.reviewReturnOpen = paths.length ? { ...open, paths } : null
      } else controller.state.reviewReturnOpen = { artifactId, paths: [path], comment: '' }
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
    if (target.dataset.artifactId) { artifactRequest++; controller.state.selectedArtifactId = target.dataset.artifactId; controller.state.preview = null; controller.paint(); action = 'preview-artifact' }
    if (action === 'latest-content') {
      root.querySelector('#wb-artifacts')?.removeAttribute('open')
      for (const disclosure of root.querySelectorAll?.('[data-timeline-disclosure][open]') ?? []) disclosure.removeAttribute('open')
      resultReturnPositions.delete(renderedScope)
      readingAnchors.delete(renderedScope)
      const content = root.querySelector('.wb-content'), current = reading.get(renderedScope)
      if (current) { current.following = true; current.unread = false }
      if (content) { content.scrollTop = content.scrollHeight; scrollPositions.set(renderedScope, content.scrollTop) }
      showReadingNotice(); input('wb-followup-text')?.focus({ preventScroll: true })
      return
    }
    if (action === 'show-artifacts') {
      const details = root.querySelector('#wb-artifacts')
      const content = root.querySelector('.wb-content')
      if (!details) return
      if (!resultReturnPositions.has(renderedScope)) resultReturnPositions.set(renderedScope, content?.scrollTop ?? 0)
      details.setAttribute('open', '')
      const summary = /** @type {HTMLElement|null} */ (details.querySelector('summary'))
      summary?.focus({ preventScroll:true })
      details.scrollIntoView({ block:'start' })
      return
    }
    if (action === 'back-to-dialogue') {
      const content = root.querySelector('.wb-content')
      const results = /** @type {HTMLElement|null} */ (root.querySelector('[data-action="show-artifacts"]'))
      results?.focus({ preventScroll:true })
      if (content) content.scrollTop = resultReturnPositions.get(renderedScope) ?? 0
      resultReturnPositions.delete(renderedScope)
      return
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
      handoffCleanup=mountHandoffDialog(deps.invokeWorkbenchApi,{sourceTaskId:detail.task.id,targetProviderId:providerId,purpose:revision?'revision':'review',request:revision?'请按选中的意见修改，并说明验证结果。':'请检查是否符合本任务要求，指出有依据的问题和遗漏。',artifacts:revision?[]:defaultReviewArtifacts(detail.artifacts),...(revision&&origin&&event?{targetTaskId:origin.sourceTaskId,quote:{taskId:detail.task.id,eventId:Number(event.id),text:quote??''}}:{})},revision?[]:detail.artifacts,detail.task.title,async id=>{if(!alive)return;navigationGeneration++;artifactRequest++;await controller.refresh({force:true});await controller.selectTask(id)},(detail.attachments??[]).map(a=>({...a,taskId:detail.task.id})))
      return
    }
    if (action === 'native-history') { captureDraft(); nativeHistoryCleanup?.(); nativeHistoryCleanup=mountHistoryDialog(deps.invokeWorkbenchApi,controller.state.historyProviders??[],async id=>{if(!alive)return;navigationGeneration++;await controller.refresh({force:true});await controller.selectTask(id)}); return }
    if (action === 'refresh') return controller.refresh().catch(fail)
    if (action === 'new-task') { captureDraft(); navigationGeneration++; artifactRequest++; return controller.newTask() }
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
      return mutate('POST', '/v1/workbench/cancel', { id: holderId || controller.state.selectedId, ...(!holderId && typeof controller.state.detail?.runId === 'string' && controller.state.detail.runId ? { expectedRunId: controller.state.detail.runId } : {}) })
    }
    if (action === 'archive-task' && controller.state.detail?.task.canArchive === true) return mutate('POST', '/v1/workbench/archive', { id: controller.state.selectedId, archived: true })
    if (action === 'restore-task' && controller.state.detail?.task.archivedAt != null) return mutate('POST', '/v1/workbench/archive', { id: controller.state.selectedId, archived: false })
    if ((action === 'allow-permission' || action === 'deny-permission') && target.dataset.requestId) return mutate('POST', '/v1/workbench/permission', { id: controller.state.selectedId, requestId: target.dataset.requestId, decision: action === 'allow-permission' ? 'allow' : 'deny' })
    if (action === 'copy-wechat-command' && controller.state.selectedId) { try { await navigator.clipboard.writeText(`任务 ${controller.state.selectedId}`) } catch { fail(new Error('复制不了，请手动选中任务编号。')) } return }
    const artifact = controller.state.detail?.artifacts?.find(a => a.id === controller.state.selectedArtifactId)
    if (!artifact) return
    if (action === 'approve-artifact') return mutate('POST', '/v1/workbench/approve', { id: controller.state.selectedId, artifactId: artifact.id, sha256: artifact.sha256 })
    if (action === 'preview-artifact' || action === 'download-artifact') {
      const taskId = controller.state.selectedId
      const requestedArtifactId = artifact.id
      const request = ++artifactRequest
      const navigation = navigationGeneration
      try {
        const data = /** @type {{name:string,mime:string,contentBase64:string,size:number,sha256:string}} */ (await deps.invokeWorkbenchApi('GET', `/v1/workbench/artifact?id=${encodeURIComponent(taskId ?? '')}&artifactId=${encodeURIComponent(requestedArtifactId)}`))
        if (!alive || request !== artifactRequest || navigation !== navigationGeneration || controller.state.selectedId !== taskId || controller.state.selectedArtifactId !== requestedArtifactId) return
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        objectUrl = URL.createObjectURL(new Blob([decodeBase64(data.contentBase64)], { type: data.mime }))
        if (action === 'download-artifact') { const a = document.createElement('a'); a.href = objectUrl; a.download = data.name; a.click(); return }
        let html = '<p class="wb-preview-hint">这种文件请下载后在本机应用中查看。</p>'
        if (data.mime === WORKBENCH_CODE_REVIEW_MIME || data.mime.startsWith('text/') || data.mime === 'application/json') html = renderWorkbenchArtifactText(data.name, data.mime, new TextDecoder().decode(decodeBase64(data.contentBase64)))
        else if (data.mime.startsWith('image/')) html = `<img src="${objectUrl}" alt="${escapeWorkbenchHtml(data.name)}">`
        else if (data.mime === 'application/pdf') html = `<iframe src="${objectUrl}" title="${escapeWorkbenchHtml(data.name)}"></iframe>`
        controller.state.preview = { artifactId: artifact.id, html }
        controller.paint()
      } catch (e) {
        if (!alive || request !== artifactRequest || navigation !== navigationGeneration || controller.state.selectedId !== taskId || controller.state.selectedArtifactId !== requestedArtifactId) return
        fail(e)
      }
    }
  }
  /** @param {SubmitEvent} event */
  const onSubmit = async event => {
    event.preventDefault()
    const form = event.target instanceof Element && event.target.tagName === 'FORM' ? /** @type {HTMLFormElement} */ (event.target) : null
    if (!form) return
    if (form.dataset.action === 'answer-question') return answerQuestion(form.dataset.ownerTask, form.dataset.requestId)
    if (form.dataset.action === 'review-return-submit') {
      const taskId = controller.state.selectedId, artifactId = form.dataset.artifactId
      if (!taskId || !artifactId || controller.getTargetTaskId() !== taskId) return
      captureDraft()
      const boxes = /** @type {HTMLInputElement[]} */ (Array.from(form.querySelectorAll?.('input[name="paths"]') ?? []))
      const paths = boxes.filter(box => box.checked).map(box => box.value)
      const comment = (/** @type {HTMLTextAreaElement|null} */ (form.querySelector?.('textarea[name="comment"]'))?.value ?? '').trim()
      if (!paths.length) return fail(new Error('请先勾选要打回的文件。'))
      if (!comment) return fail(new Error('请写一句要怎么改，再发回。'))
      // 这一笔没发出去的话,勾选、意见和「为什么没发出去」都得留在 state 里 —— 表单本体活在会被重画冲掉的 DOM。
      const keep = (/** @type {string} */ notice, /** @type {string|undefined} */ token) => {
        const current = controller.state.reviewReturnOpen
        if (!current || current.artifactId !== artifactId) return
        current.paths = paths; current.comment = comment; current.notice = notice
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
      const done = await mutate('POST', '/v1/workbench/review-return', { id: taskId, artifactId, paths, comment, ...(restartToken ? { restartToken } : {}) }, async error => {
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
      })
      if (done) {
        controller.state.reviewReturnOpen = null
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
      if (draft.followup === text&&unchanged) { draft.followup = ''; if(draft.attachments?.length)draft.attachments=[]; pageDrafts.set(scope, draft) }
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
    if (form?.id === 'wb-create-form') {
      const data = new FormData(form)
      const sent = { path:String(data.get('path') ?? ''), text:String(data.get('text') ?? ''), title:String(data.get('title') ?? ''), providerId:String(data.get('providerId') ?? '') }
      const scope = renderedScope
      captureDraft()
      const files=pageDrafts.get(scope)
      if(!sent.text.trim()&&!files.attachments?.length)return
      if(!attachments.ready(scope))return fail(new Error('请等附件上传完成，或移除上传失败的附件。'))
      const release=attachments.reserve(scope,files)
      if (await mutate('POST', '/v1/workbench/create', { title: sent.title || undefined, path: sent.path, providerId: sent.providerId, text: sent.text,...attachmentPayload(files),...executionPayload(files) }).finally(release)) {
        const draft = pageDrafts.get(scope)
        const changedAttachments=attachmentSignature(draft.attachments)!==attachmentSignature(files.attachments)||executionSignature(draft.execution)!==executionSignature(files.execution)
        // Submitted IDs now belong to the created task. A newly edited task
        // draft keeps only material that was added after this submission.
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
        const decision=/** @type {NativeResume} */(await deps.invokeWorkbenchApi('POST','/v1/workbench/prepare-resume',{id,mode,...executionPayload(sent)}))
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
      if (await mutate('POST', '/v1/workbench/continue', { id: taskId, text,...attachmentPayload(files),...executionPayload(files),...(inputRequestId?{inputRequestId}:{}), ...(restart ? { restartToken } : {}),...(sourceClosedToken?{sourceClosedToken}:{}) }).finally(release)) {
        const scope = `task:${taskId}`
        const draft = pageDrafts.get(scope)
        const unchanged=attachmentSignature(draft.attachments)===attachmentSignature(files.attachments)&&executionSignature(draft.execution)===executionSignature(files.execution)
        if (draft.followup === text&&unchanged) {draft.followup = '';if(draft.attachments?.length)draft.attachments=[]}
        pageDrafts.set(scope, draft)
        const current = input('wb-followup-text')
        if (unchanged&&controller.state.selectedId === taskId && current?.value === text) current.value = ''
      }
    }
  }
  const onScroll = (/** @type {Event} */ event) => {
    const content = root.querySelector('.wb-content')
    if (event.target !== content || !content) return
    scrollPositions.set(renderedScope, content.scrollTop)
    const current = reading.get(renderedScope)
    if (current && atEnd(content) && !browsingResults()) { current.unread = false; showReadingNotice() }
  }
  root.addEventListener('scroll', onScroll, true)
  const saveWindowState = () => {
    captureDraft()
    saveWorkbenchView(windowStorage,{scope:renderedScope,query:controller.state.query ?? {q:'',archived:'exclude'},search:input('wb-search')?.value ?? searchDraft})
  }
  const onInput = (/** @type {Event} */ event) => {
    if (event.target instanceof Element && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) syncWorkbenchQuestionChoice(/** @type {HTMLInputElement|HTMLTextAreaElement} */ (event.target))
    if (event.target === input('wb-followup-text') && controller.state.selectedId) interactions.editInputDraft(controller.state.selectedId, input('wb-followup-text')?.value ?? '',pageDrafts.get(renderedScope).attachments,pageDrafts.get(renderedScope).execution)
    saveWindowState()
  }
  const addFiles=(/** @type {File[]} */ files)=>{captureDraft();const scope=renderedScope;void attachments.add(scope,files)}
  const onChange = (/** @type {Event} */ event) => {
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
  const onToggle=(/** @type {Event} */event)=>{if(event.target instanceof Element&&['wb-options','wb-task-info'].includes(event.target.id))loadExecutionCatalog()}
  root.addEventListener('toggle',onToggle,true)
  root.addEventListener('paste',onPaste);root.addEventListener('drop',onDrop);root.addEventListener('dragover',onDragOver)
  root.addEventListener('input', onInput)
  window.addEventListener?.('pagehide', saveWindowState)
  root.addEventListener('change', onChange)
  root.addEventListener('click', onClick)
  root.addEventListener('submit', onSubmit)
  controller.refresh().catch(fail)
  const timer = setInterval(() => {
    // 面板被藏起来就别占着长连接;重新露面时把它接回来。
    if (root.closest('[hidden]')) { controller.stopLive(); return }
    controller.resumeLive()
    controller.refresh().catch(fail)
  }, deps.pollMs ?? 3000)
  active = { timer, openTask, getTaskId: () => controller.getTargetTaskId(), cleanup: () => {
    saveWindowState()
    resumeQuery = { ...(controller.state.query ?? { q: '', archived: 'exclude' }) }
    resumeSearch = input('wb-search')?.value ?? searchDraft
    if (controller.state.selectedId) resumeScope = `task:${controller.state.selectedId}`
    else if (document.getElementById('wb-create-form')) resumeScope = scopeFor(controller.state)
    recoveryPreviews.destroy();catalogs.destroy();root.removeEventListener('toggle',onToggle,true);handoffCleanup?.(); nativeHistoryCleanup?.();attachmentPreviewCleanup?.();root.removeEventListener('paste',onPaste);root.removeEventListener('drop',onDrop);root.removeEventListener('dragover',onDragOver); alive = false; artifactRequest++; controller.destroy(); root.removeEventListener('input', onInput); window.removeEventListener?.('pagehide', saveWindowState); root.removeEventListener('scroll', onScroll, true); root.removeEventListener('change', onChange); root.removeEventListener('click', onClick); root.removeEventListener('submit', onSubmit); if (objectUrl) URL.revokeObjectURL(objectUrl)
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

export function getActiveWorkbenchTaskId() { return active?.getTaskId() ?? null }
