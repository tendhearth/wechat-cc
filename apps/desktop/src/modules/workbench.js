// @ts-check

import { Marked } from '../vendor/marked.js'

/** @typedef {{taskId:string,title:string,reason:'same_path'|'nested_path'|'writer_not_closed'}} WaitingFor */
/** @typedef {{id:string,title:string,path:string,providerId:string,status:string,createdAt:number,updatedAt:number,error:string|null,pendingPermissionCount?:number,waitingFor?:WaitingFor|null}} Task */
/** @typedef {{id:string,taskId:string,kind:'user'|'text'|'tool_call'|'system'|'error',text:string,createdAt:number}} WorkbenchEvent */
/** @typedef {{id:string,taskId:string,name:string,mime:string,size:number,sha256:string,createdAt:number,approvedAt:number|null}} Artifact */
/** @typedef {{id:string,taskId:string,tool:string,description:string,createdAt:number}} Permission */
/** @typedef {{id:string,displayName:string}} Provider */
/** @typedef {{task:Task,events:WorkbenchEvent[],artifacts:Artifact[],permissions?:Permission[]}} Detail */
/** @typedef {{tasks:Task[],providers:Provider[],defaultProvider:string,canWechat:boolean}} ListResult */
/** @typedef {{artifactId:string,html:string}|null} Preview */
/** @typedef {{tasks:Task[],providers:Provider[],defaultProvider:string,canWechat:boolean,selectedId:string|null,loadingId?:string|null,detail:Detail|null,selectedArtifactId:string|null,error:string,preview:Preview}} WorkbenchState */
/** @typedef {{path:string,text:string,title:string,providerId:string,followup:string}} Draft */
/** @typedef {{invokeWorkbenchApi:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>,invoke?:(command:string,args:Record<string,unknown>)=>Promise<unknown>,pollMs?:number}} WorkbenchDeps */

/** @type {{timer:ReturnType<typeof setInterval>,cleanup:()=>void}|null} */
let active = null
/** @type {string|null} */
let resumeScope = null

const emptyDraft = () => ({ path: '', text: '', title: '', providerId: '', followup: '' })

export function createWorkbenchDraftStore() {
  /** @type {Map<string,Draft>} */
  const values = new Map()
  return {
    /** @param {string} key @param {Draft} value */
    set(key, value) { values.set(key, { ...value }) },
    /** @param {string} key */
    get(key) { return { ...(values.get(key) ?? emptyDraft()) } },
  }
}

const pageDrafts = createWorkbenchDraftStore()

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

/** @param {number} value */
function time(value) {
  return Number.isFinite(value) ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : ''
}

/** @param {string} status */
function statusLabel(status) {
  return ({ queued: '等待中', running: '进行中', cancelling: '正在停止', completed: '已完成', failed: '未完成', cancelled: '已停止', interrupted: '已中断' })[status] ?? status
}

/** @param {string} status */
export function renderTaskControls(status) {
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
  return '<form class="wb-followup" data-action="continue"><label class="wb-sr-only" for="wb-followup-text">继续这个任务</label><textarea id="wb-followup-text" rows="2" placeholder="继续这个任务…"></textarea><button class="wb-btn wb-btn-primary" type="submit">继续</button></form>'
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
  const title = task.title || '未命名任务'
  const updated = time(task.updatedAt)
  const waitingLabel = task.waitingFor?.reason === 'writer_not_closed' ? '等待执行程序退出确认' : task.waitingFor ? '等待前项任务' : ''
  const attention = pendingPermissionCount > 0 ? `，${pendingPermissionCount} 项权限请求等你确认` : ''
  const waiting = task.waitingFor?.reason === 'writer_not_closed'
    ? `，等待执行程序退出确认，阻塞任务「${task.waitingFor.title}」`
    : task.waitingFor ? `，等待「${task.waitingFor.title}」` : ''
  const accessibleLabel = `${title}，${provider}，${statusLabel(task.status)}${attention}${waiting}${updated ? `，更新于 ${updated}` : ''}`
  const stateHtml = pendingPermissionCount > 0
    ? `<span class="wb-task-attention" data-status="${escapeWorkbenchHtml(task.status)}" aria-label="${escapeWorkbenchHtml(statusLabel(task.status))}，${escapeWorkbenchHtml(pendingPermissionCount)} 项权限请求等你确认">等你确认 · ${escapeWorkbenchHtml(pendingPermissionCount)}</span>`
    : `<span class="wb-status" data-status="${escapeWorkbenchHtml(task.status)}">${escapeWorkbenchHtml(waitingLabel || statusLabel(task.status))}</span>`
  return `<button type="button" class="wb-task ${task.id === selectedId ? 'is-selected' : ''}" data-task-id="${escapeWorkbenchHtml(task.id)}" aria-label="${escapeWorkbenchHtml(accessibleLabel)}"${updated ? ` title="${escapeWorkbenchHtml(`${title} · ${updated}`)}"` : ''}>
    <span class="wb-task-title" title="${escapeWorkbenchHtml(title)}">${escapeWorkbenchHtml(title)}</span>
    <span class="wb-task-meta"><span class="wb-task-provider">${escapeWorkbenchHtml(provider)}</span>${stateHtml}</span>
  </button>`
}

/** @param {WorkbenchState} state */
export function renderWorkbench(state) {
  const tasks = state.tasks ?? []
  const detail = state.detail
  const selectedArtifact = detail?.artifacts?.find(a => a.id === state.selectedArtifactId)
  const taskList = tasks.length ? groupWorkbenchTasks(tasks).map((project, index) => `<section class="wb-project" aria-labelledby="wb-project-${index}">
    <header title="${escapeWorkbenchHtml(project.path)}"><h3 id="wb-project-${index}">${escapeWorkbenchHtml(project.label)}</h3></header>
    <div>${project.tasks.map(task => renderTask(task, state.providers, state.loadingId ?? state.selectedId)).join('')}</div>
  </section>`).join('') : `<p class="wb-empty-copy">${state.error ? '暂时没能读取任务列表。' : '还没有任务。选一个文件夹，把要做的事交给执行者。'}</p>`
  const helper = state.providers.find(p => p.id === detail?.task.providerId)?.displayName || detail?.task.providerId || '执行助手'
  const events = detail?.events ?? []
  const dialogue = events.filter(event => event.kind === 'user' || event.kind === 'text')
  const operations = events.filter(event => event.kind !== 'user' && event.kind !== 'text')
  const permissions = (detail?.permissions ?? []).filter(permission => permission.taskId === detail?.task.id)
  const queuedCopy = detail?.task.waitingFor?.reason === 'writer_not_closed'
    ? '执行程序尚未确认退出，这项队列不会继续。请检查原进程和输出，确认退出后再处理。可以停止这项排队任务；其他文件夹的任务仍可继续。'
    : detail?.task.waitingFor?.reason === 'same_path'
      ? `正在等待「${escapeWorkbenchHtml(detail.task.waitingFor.title)}」结束；这些任务使用同一个文件夹。`
      : detail?.task.waitingFor?.reason === 'nested_path'
        ? `正在等待「${escapeWorkbenchHtml(detail.task.waitingFor.title)}」结束；任务文件夹彼此包含。`
        : '任务已记下，正在等待执行。'
  const queuedGuidance = detail?.task.status === 'queued' && detail.task.waitingFor
    ? `<p class="wb-queue-guidance" role="status">${queuedCopy}</p>`
    : ''
  const dialogueHtml = dialogue.length ? dialogue.map(event => `<article class="wb-message" data-kind="${escapeWorkbenchHtml(event.kind)}">
    <header><span>${event.kind === 'user' ? '你' : `<span class="wb-provider-badge">${escapeWorkbenchHtml(helper)}</span>`}</span><time>${escapeWorkbenchHtml(time(event.createdAt))}</time></header>
    ${event.kind === 'text' ? `<div class="wb-message-body wb-markdown">${renderWorkbenchMarkdown(event.text)}</div>` : `<p class="wb-message-body">${escapeWorkbenchHtml(event.text)}</p>`}
  </article>`).join('') : `<p class="wb-empty-copy">${detail?.task.status === 'running' ? `${escapeWorkbenchHtml(helper)} 正在处理，有回复时会按顺序显示在这里。` : detail?.task.status === 'queued' ? queuedCopy : '这项任务还没有对话记录。'}</p>`
  const operationHtml = operations.length ? `<details id="wb-tools" class="wb-disclosure wb-tools"><summary>工具与运行记录 <span>${operations.length} 条</span></summary><div class="wb-events">${operations.map(event => `<article class="wb-event" data-kind="${escapeWorkbenchHtml(event.kind)}"><div class="wb-event-meta"><span>${escapeWorkbenchHtml(event.kind === 'tool_call' ? '工具' : event.kind === 'error' ? '错误' : '系统')}</span><time>${escapeWorkbenchHtml(time(event.createdAt))}</time></div><p>${escapeWorkbenchHtml(event.text)}</p></article>`).join('')}</div></details>` : ''
  const permissionHtml = permissions.length ? `<section class="wb-permissions" aria-label="等待处理的权限请求"><header><h3>需要你的决定</h3><span>${permissions.length} 项</span></header>${permissions.map(permission => `<article class="wb-permission"><div><span class="wb-permission-tool">${escapeWorkbenchHtml(permission.tool)}</span><p>${escapeWorkbenchHtml(permission.description)}</p><time>${escapeWorkbenchHtml(time(permission.createdAt))}</time></div><div class="wb-permission-actions"><button class="wb-btn" type="button" data-action="deny-permission" data-request-id="${escapeWorkbenchHtml(permission.id)}">拒绝</button><button class="wb-btn wb-btn-primary" type="button" data-action="allow-permission" data-request-id="${escapeWorkbenchHtml(permission.id)}">允许</button></div></article>`).join('')}</section>` : ''
  const artifacts = detail?.artifacts?.length ? detail.artifacts.map(artifact => `<button type="button" class="wb-artifact ${artifact.id === state.selectedArtifactId ? 'is-selected' : ''}" data-artifact-id="${escapeWorkbenchHtml(artifact.id)}"><span>${escapeWorkbenchHtml(artifact.name)}</span><small>${escapeWorkbenchHtml((artifact.size / 1024).toFixed(1))} KB · ${artifact.approvedAt ? '已确认' : '待确认'}</small></button>`).join('') : ''
  const previewContent = selectedArtifact && state.preview?.artifactId === selectedArtifact.id ? state.preview.html : '<p class="wb-preview-hint">选择“打开预览”读取这份不可变快照。</p>'
  const artifactHtml = detail?.artifacts?.length ? `<details id="wb-artifacts" class="wb-disclosure wb-artifacts"><summary><span>成果</span><small>${detail.artifacts.length} 件</small></summary><div class="wb-artifact-list">${artifacts}</div><div id="wb-preview" class="wb-preview">${selectedArtifact ? `<p class="wb-preview-name">${escapeWorkbenchHtml(selectedArtifact.name)}</p><div class="wb-preview-content">${previewContent}</div><button type="button" class="wb-btn" data-action="preview-artifact">打开预览</button><button type="button" class="wb-btn" data-action="download-artifact">下载</button>${selectedArtifact.approvedAt ? '<p class="wb-approved">已确认此版本</p>' : '<button type="button" class="wb-btn wb-btn-primary" data-action="approve-artifact">确认这份成果</button>'}` : ''}</div></details>` : ''
  const taskHeader = detail ? `<header class="wb-task-head"><div><p class="wb-task-context">${escapeWorkbenchHtml(pathParts(detail.task.path).name)} · ${escapeWorkbenchHtml(helper)}</p><h2 title="${escapeWorkbenchHtml(detail.task.title || '未命名任务')}">${escapeWorkbenchHtml(detail.task.title || '未命名任务')}</h2></div><div class="wb-task-head-actions"><span class="wb-status" data-status="${escapeWorkbenchHtml(detail.task.status)}">${escapeWorkbenchHtml(statusLabel(detail.task.status))}</span><details id="wb-task-info" class="wb-task-info"><summary>任务详情</summary><div class="wb-task-info-body"><dl><div><dt>完整路径</dt><dd class="wb-path">${escapeWorkbenchHtml(detail.task.path)}</dd></div><div><dt>任务编号</dt><dd><code>${escapeWorkbenchHtml(detail.task.id)}</code></dd></div><div><dt>执行者</dt><dd>${escapeWorkbenchHtml(helper)}</dd></div><div><dt>更新时间</dt><dd>${escapeWorkbenchHtml(time(detail.task.updatedAt))}</dd></div></dl>${state.canWechat ? `<div class="wb-wechat"><span>在微信继续</span><code>任务 ${escapeWorkbenchHtml(detail.task.id)}</code><button type="button" class="wb-btn" data-action="copy-wechat-command">复制</button></div>` : ''}</div></details></div></header>` : ''
  const content = detail ? `
    <section class="wb-dialogue" aria-live="polite">${dialogueHtml}</section>
    ${queuedGuidance}
    ${operationHtml}
    ${detail.task.error ? `<div class="wb-error" role="alert">${escapeWorkbenchHtml(detail.task.error)}</div>` : ''}
    ${artifactHtml}` : state.loadingId ? `
    <div class="wb-welcome wb-task-loading" role="status"><p class="wb-kicker">打开任务</p><h1>正在打开任务…</h1><p>正在读取这项任务的对话和成果。</p></div>` : `
    ${state.error && !state.providers.length ? '<div class="wb-welcome"><p class="wb-kicker">一起做</p><h1>暂时没能打开手头的事。</h1><p>连接恢复后，就能继续查看任务和交代新事情。</p><button class="wb-btn" type="button" data-action="refresh">重新连接</button></div>' : ''}
    <div class="wb-welcome" ${state.error && !state.providers.length ? 'hidden' : ''}><p class="wb-kicker">新的一件事</p><h1>我们一起做点什么？</h1><p>说说你想做的事，再选一个放材料的文件夹。</p>
      <form id="wb-create-form" class="wb-create-form">
        <label>文件夹<div class="wb-folder-row"><input id="wb-path" name="path" required aria-describedby="wb-folder-help" placeholder="选择或粘贴一个本机文件夹"><button type="button" class="wb-btn" data-action="choose-folder">选择…</button></div><small id="wb-folder-help" class="wb-field-help">也可以直接粘贴完整路径；原生选择目前只在 macOS 提供。</small></label>
        <label>要做什么<textarea id="wb-create-text" name="text" rows="4" required placeholder="例如：整理这些访谈记录，做一份主题摘要和引用表"></textarea></label>
        ${state.providers.length ? '' : '<p class="wb-provider-missing" role="alert">没有检测到可用的 Claude Code 或 Codex。安装并连接其中一个后才能开始任务。</p>'}
        <details id="wb-options" class="wb-options"><summary>执行者与命名 <span>当前使用 ${escapeWorkbenchHtml(state.providers.find(p => p.id === state.defaultProvider)?.displayName || '尚未选择执行者')}</span></summary><label>执行者<select id="wb-provider" name="providerId">${(state.providers ?? []).map((p) => `<option value="${escapeWorkbenchHtml(p.id)}" ${p.id === state.defaultProvider ? 'selected' : ''}>${escapeWorkbenchHtml(p.displayName)}</option>`).join('')}</select></label>
        <label>任务名称 <span class="wb-optional">可选</span><input id="wb-title" name="title" placeholder="留空时使用任务要求的前 40 个字"></label></details>
        <button class="wb-btn wb-btn-primary" type="submit"${state.providers.length ? '' : ' disabled'}>开始任务</button>
      </form></div>`
  const controls = detail ? `<div class="wb-controls"><div class="wb-controls-inner">${permissionHtml}${renderTaskControls(detail.task.status)}</div></div>` : ''
  return `<div class="workbench-shell"><aside class="wb-sidebar"><header><p class="wb-kicker">任务</p><button type="button" class="wb-new" data-action="new-task">＋ 新建</button></header><div class="wb-task-list">${taskList}</div></aside><main class="wb-main">${taskHeader}<div class="wb-content"><div class="wb-content-inner">${state.error ? `<div class="wb-error" role="alert">${escapeWorkbenchHtml(state.error)}</div>` : ''}${content}</div></div>${controls}</main></div>`
}

/** @param {{invokeWorkbenchApi:WorkbenchDeps['invokeWorkbenchApi'],render:(state:WorkbenchState)=>void,initialScope?:string|null}} deps */
export function createWorkbenchController(deps) {
  /** @type {WorkbenchState} */
  const state = { tasks: [], providers: [], defaultProvider: '', canWechat: false, selectedId: null, loadingId: null, detail: null, selectedArtifactId: null, error: '', preview: null }
  let detailRequest = 0
  let listRequest = 0
  /** @type {string|null} */
  let desiredId = null
  let composingNewTask = deps.initialScope === 'new'
  let preferredInitialId = deps.initialScope?.startsWith('task:') ? deps.initialScope.slice(5) : null
  let alive = true
  let lastPaint = ''
  const paint = () => {
    const snapshot = JSON.stringify(state)
    if (snapshot === lastPaint) return
    lastPaint = snapshot
    deps.render(state)
  }
  return {
    state,
    async refresh() {
      const request = ++listRequest
      /** @type {ListResult} */
      let result
      try { result = /** @type {ListResult} */ (await deps.invokeWorkbenchApi('GET', '/v1/workbench')) }
      catch (error) { if (!alive || request !== listRequest) return; throw error }
      if (!alive || request !== listRequest) return
      Object.assign(state, result)
      state.error = ''
      if (desiredId) paint()
      else if (state.selectedId) await this.selectTask(state.selectedId)
      else if (!composingNewTask && state.tasks[0]?.id) {
        const target = preferredInitialId && state.tasks.some(task => task.id === preferredInitialId) ? preferredInitialId : state.tasks[0].id
        preferredInitialId = null
        await this.selectTask(target)
      }
      else paint()
    },
    /** @param {string} id */
    async selectTask(id) {
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
    },
    newTask() { detailRequest++; desiredId = null; composingNewTask = true; state.selectedId = null; state.loadingId = null; state.detail = null; state.selectedArtifactId = null; paint() },
    destroy() { alive = false; detailRequest++; listRequest++ },
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
  let artifactRequest = 0
  let navigationGeneration = 0
  /** @type {string|null} */
  let objectUrl = null
  const initialScope = resumeScope
  let renderedScope = initialScope ?? 'new'
  let hasPainted = false
  /** @type {Map<string, Map<string, boolean>>} */
  const disclosures = new Map()
  /** @type {Map<string, number>} */
  const scrollPositions = new Map()
  /** @type {Map<string, {signature:string,scrollTop:number}>} */
  const permissionScrollPositions = new Map()
  /** @type {Map<string, number>} */
  const taskInfoScrollPositions = new Map()
  const scopeFor = (/** @type {WorkbenchState} */ state) => state.selectedId ? `task:${state.selectedId}` : 'new'
  const permissionSignatureFor = (/** @type {WorkbenchState} */ state) => JSON.stringify((state.detail?.permissions ?? []).filter(permission => permission.taskId === state.detail?.task.id).map(permission => permission.id).sort())
  const captureDraft = () => {
    if (!document.getElementById('wb-create-form') && !input('wb-followup-text')) return
    pageDrafts.set(renderedScope, { path: input('wb-path')?.value ?? '', text: input('wb-create-text')?.value ?? '', title: input('wb-title')?.value ?? '', providerId: input('wb-provider')?.value ?? '', followup: input('wb-followup-text')?.value ?? '' })
  }
  const restoreDraft = (/** @type {string} */ scope) => {
    const draft = pageDrafts.get(scope)
    for (const [id, value] of /** @type {Array<[string,string]>} */ ([['wb-path', draft.path], ['wb-create-text', draft.text], ['wb-title', draft.title], ['wb-provider', draft.providerId], ['wb-followup-text', draft.followup]])) {
      const field = input(id); if (field && value) field.value = value
    }
  }
  const controller = createWorkbenchController({ invokeWorkbenchApi: deps.invokeWorkbenchApi, initialScope, render: state => {
    if (!alive) return
    if (hasPainted) captureDraft()
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
    const openState = new Map(['wb-tools', 'wb-artifacts', 'wb-options', 'wb-task-info'].map(id => [id, !!root.querySelector(`#${id}[open]`)]))
    disclosures.set(renderedScope, openState)
    const contentScroll = root.querySelector('.wb-content')?.scrollTop ?? 0
    scrollPositions.set(renderedScope, contentScroll)
    const currentPermissionScroll = root.querySelector('.wb-permissions')?.scrollTop
    const currentPermissionState = permissionScrollPositions.get(renderedScope)
    if (currentPermissionScroll !== undefined && currentPermissionState) currentPermissionState.scrollTop = currentPermissionScroll
    const currentTaskInfoScroll = root.querySelector('.wb-task-info-body')?.scrollTop
    if (currentTaskInfoScroll !== undefined) taskInfoScrollPositions.set(renderedScope, currentTaskInfoScroll)
    const nextPermissionSignature = permissionSignatureFor(state)
    const sameScope = renderedScope === scopeFor(state)
    root.innerHTML = renderWorkbench(state)
    hasPainted = true
    for (const [id, open] of disclosures.get(scopeFor(state)) ?? []) root.querySelector(`#${id}`)?.toggleAttribute('open', open)
    const content = root.querySelector('.wb-content')
    if (content) content.scrollTop = hasStoredScroll ? (scrollPositions.get(nextScope) ?? 0) : nextScope.startsWith('task:') ? content.scrollHeight : 0
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
    restoreDraft(renderedScope)
    syncWorkbenchProviderLabel(root)
    if (focusedDisclosure && sameScope) {
      const summary = /** @type {HTMLElement|null} */ (root.querySelector(`#${focusedDisclosure} > summary`))
      summary?.focus({ preventScroll: true })
    }
    const nextFocus = focused && sameScope ? input(focused.id) : null
    if (nextFocus) { nextFocus.focus({ preventScroll: true }); if (focused && focused.start !== null && focused.end !== null && 'setSelectionRange' in nextFocus) nextFocus.setSelectionRange(focused.start, focused.end) }
  } })
  /** @param {unknown} error */
  const fail = error => { if (!alive) return; const message = error instanceof Error ? error.message : String(error); controller.state.error = ['HTTP 404','workbench_endpoint_missing'].includes(message) ? '当前运行的后台还没有提供这个接口，请更新后台后重试。' : message === 'workbench_read_only_preview' ? '当前预览只允许查看任务，请使用已启用执行的桌面端。' : message === 'workbench_connection_unavailable' ? '暂时连不上任务服务，请检查后台是否运行。' : message; controller.paint() }
  /** @param {'GET'|'POST'} method @param {string} path @param {Record<string,unknown>} body */
  const mutate = async (method, path, body) => {
    const key = path === '/v1/workbench/create' ? 'create' : `task:${String(body.id ?? '')}`
    if (busy.has(key) || !alive) return false
    busy.add(key)
    const navigation = navigationGeneration
    try {
      const result = /** @type {{task?:Task}} */ (await deps.invokeWorkbenchApi(method, path, body))
      if (!alive) return false
      const id = result.task?.id ?? controller.state.selectedId
      await controller.refresh()
      if (alive && path === '/v1/workbench/create' && navigation === navigationGeneration && id && controller.state.selectedId !== id) await controller.selectTask(id)
      return alive
    } catch (e) { if (alive && navigation === navigationGeneration) fail(e); return false } finally { busy.delete(key) }
  }
  /** @param {Event} event */
  const onClick = async event => {
    const target = event.target instanceof Element ? event.target.closest('button') : null
    if (!target) return
    if (target.dataset.taskId) { captureDraft(); navigationGeneration++; artifactRequest++; return controller.selectTask(target.dataset.taskId).catch(fail) }
    if (target.dataset.artifactId) { artifactRequest++; controller.state.selectedArtifactId = target.dataset.artifactId; controller.state.preview = null; return controller.paint() }
    const action = target.dataset.action
    if (action === 'refresh') return controller.refresh().catch(fail)
    if (action === 'new-task') { captureDraft(); navigationGeneration++; artifactRequest++; return controller.newTask() }
    if (action === 'choose-folder') { try { const path = await deps.invoke?.('choose_workbench_folder', {}); const field = input('wb-path'); if (typeof path === 'string' && field) field.value = path } catch (e) { fail(e) } return }
    if (action === 'cancel') return mutate('POST', '/v1/workbench/cancel', { id: controller.state.selectedId })
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
        if (data.mime.startsWith('text/') || data.mime === 'application/json') html = `<pre>${escapeWorkbenchHtml(new TextDecoder().decode(decodeBase64(data.contentBase64)))}</pre>`
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
    if (form?.id === 'wb-create-form') {
      const data = new FormData(form)
      const sent = { path:String(data.get('path') ?? ''), text:String(data.get('text') ?? ''), title:String(data.get('title') ?? '') }
      captureDraft()
      if (await mutate('POST', '/v1/workbench/create', { title: sent.title || undefined, path: sent.path, providerId: data.get('providerId'), text: sent.text })) {
        const draft = pageDrafts.get('new')
        if (draft.path === sent.path) draft.path = ''
        if (draft.text === sent.text) draft.text = ''
        if (draft.title === sent.title) draft.title = ''
        pageDrafts.set('new', draft)
      }
      return
    }
    if (form.dataset.action === 'continue') {
      const field = input('wb-followup-text')
      const text = field?.value
      if (!text?.trim()) return
      const taskId = controller.state.selectedId
      captureDraft()
      if (await mutate('POST', '/v1/workbench/continue', { id: taskId, text })) {
        const scope = `task:${taskId}`
        const draft = pageDrafts.get(scope)
        if (draft.followup === text) draft.followup = ''
        pageDrafts.set(scope, draft)
        const current = input('wb-followup-text')
        if (controller.state.selectedId === taskId && current?.value === text) current.value = ''
      }
    }
  }
  const onChange = () => syncWorkbenchProviderLabel(root)
  root.addEventListener('change', onChange)
  root.addEventListener('click', onClick)
  root.addEventListener('submit', onSubmit)
  controller.refresh().catch(fail)
  const timer = setInterval(() => { if (!root.closest('[hidden]')) controller.refresh().catch(fail) }, deps.pollMs ?? 3000)
  active = { timer, cleanup: () => {
    captureDraft()
    if (controller.state.selectedId) resumeScope = `task:${controller.state.selectedId}`
    else if (document.getElementById('wb-create-form')) resumeScope = 'new'
    alive = false; artifactRequest++; controller.destroy(); root.removeEventListener('change', onChange); root.removeEventListener('click', onClick); root.removeEventListener('submit', onSubmit); if (objectUrl) URL.revokeObjectURL(objectUrl)
  } }
  return controller
}

export function stopWorkbenchPolling() {
  if (!active) return
  clearInterval(active.timer); active.cleanup(); active = null
}
