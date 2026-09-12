// @ts-check

/** @typedef {{id:string,title:string,path:string,providerId:string,status:string,createdAt:number,updatedAt:number,error:string|null}} Task */
/** @typedef {{id:string,taskId:string,kind:'user'|'text'|'tool_call'|'system'|'error',text:string,createdAt:number}} WorkbenchEvent */
/** @typedef {{id:string,taskId:string,name:string,mime:string,size:number,sha256:string,createdAt:number,approvedAt:number|null}} Artifact */
/** @typedef {{id:string,displayName:string}} Provider */
/** @typedef {{task:Task,events:WorkbenchEvent[],artifacts:Artifact[]}} Detail */
/** @typedef {{tasks:Task[],providers:Provider[],defaultProvider:string,canWechat:boolean}} ListResult */
/** @typedef {{artifactId:string,html:string}|null} Preview */
/** @typedef {{tasks:Task[],providers:Provider[],defaultProvider:string,canWechat:boolean,selectedId:string|null,detail:Detail|null,selectedArtifactId:string|null,error:string,preview:Preview}} WorkbenchState */
/** @typedef {{path:string,text:string,title:string,providerId:string,followup:string}} Draft */
/** @typedef {{invokeWorkbenchApi:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>,invoke?:(command:string,args:Record<string,unknown>)=>Promise<unknown>,pollMs?:number}} WorkbenchDeps */

/** @type {{timer:ReturnType<typeof setInterval>,cleanup:()=>void}|null} */
let active = null

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
  if (status === 'queued' || status === 'running') return '<button class="wb-btn wb-btn-danger" type="button" data-action="cancel">停止任务</button>'
  if (status === 'cancelling') return '<button class="wb-btn" type="button" disabled>正在停止…</button>'
  return '<form class="wb-followup" data-action="continue"><label for="wb-followup-text">继续这个任务</label><textarea id="wb-followup-text" rows="3" placeholder="补充要求，仍会续接同一个任务"></textarea><button class="wb-btn wb-btn-primary" type="submit">继续</button></form>'
}

/** @param {Artifact[]} artifacts @param {string|null} current */
export function chooseArtifactId(artifacts, current) {
  if (current && artifacts.some(a => a.id === current)) return current
  return [...artifacts].sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null
}

/** @param {WorkbenchState} state */
export function renderWorkbench(state) {
  const tasks = state.tasks ?? []
  const detail = state.detail
  const selectedArtifact = detail?.artifacts?.find(a => a.id === state.selectedArtifactId)
  const taskList = tasks.length ? tasks.map(task => `
    <button type="button" class="wb-task ${task.id === state.selectedId ? 'is-selected' : ''}" data-task-id="${escapeWorkbenchHtml(task.id)}">
      <span class="wb-task-title">${escapeWorkbenchHtml(task.title || '未命名任务')}</span>
      <span class="wb-task-meta"><span class="wb-status" data-status="${escapeWorkbenchHtml(task.status)}">${escapeWorkbenchHtml(statusLabel(task.status))}</span><time>${escapeWorkbenchHtml(time(task.updatedAt))}</time></span>
      <span class="wb-task-path">${escapeWorkbenchHtml(task.path)}</span>
    </button>`).join('') : `<p class="wb-empty-copy">${state.error ? '暂时没能读取任务列表。' : '还没有任务。选一个文件夹，把要做的事交给 CC。'}</p>`
  const helper = state.providers.find(p => p.id === detail?.task.providerId)?.displayName || detail?.task.providerId || '执行助手'
  const events = detail?.events ?? []
  const lastUser = events.map(e => e.kind).lastIndexOf('user')
  const latestReply = [...events.slice(lastUser + 1)].reverse().find(e => e.kind === 'text' && e.text.trim())
  const report = latestReply?.text || (detail?.task.status === 'running' ? '正在处理这件事，有新的回复会出现在这里。' : detail?.task.status === 'queued' ? '已记下这件事，正在等待执行。' : '这一轮还没有留下文字回复，可以展开记录查看。')
  const center = detail ? `
    <header class="wb-task-head"><div><p class="wb-kicker">任务 ${escapeWorkbenchHtml(detail.task.id)}</p><h2>${escapeWorkbenchHtml(detail.task.title || '未命名任务')}</h2><p class="wb-path">${escapeWorkbenchHtml(detail.task.path)}</p></div><span class="wb-status" data-status="${escapeWorkbenchHtml(detail.task.status)}">${escapeWorkbenchHtml(statusLabel(detail.task.status))}</span></header>
    <section class="wb-report" aria-live="polite"><img src="./assets/pet/cc-v1/canonical/lit/front.png" alt="CC"><div><small>${escapeWorkbenchHtml(helper)} 的回复</small><p>${escapeWorkbenchHtml(report)}</p></div></section>
    <details id="wb-process" class="wb-process"><summary>查看过程与记录 <span>${detail.events.length} 条</span></summary><div class="wb-events">${detail.events.length ? detail.events.map(event => `<article class="wb-event" data-kind="${escapeWorkbenchHtml(event.kind)}"><div class="wb-event-meta"><span>${escapeWorkbenchHtml(event.kind === 'user' ? '你' : event.kind === 'tool_call' ? '操作' : event.kind === 'error' ? '错误' : event.kind === 'system' ? '系统' : helper)}</span><time>${escapeWorkbenchHtml(time(event.createdAt))}</time></div><p>${escapeWorkbenchHtml(event.text)}</p></article>`).join('') : '<p class="wb-empty-copy">任务已创建，等待第一条进展。</p>'}</div></details>
    ${detail.task.error ? `<div class="wb-error" role="alert">${escapeWorkbenchHtml(detail.task.error)}</div>` : ''}
    ${state.canWechat ? `<div class="wb-wechat"><span>在微信继续</span><code>任务 ${escapeWorkbenchHtml(detail.task.id)}</code><button type="button" class="wb-btn" data-action="copy-wechat-command">复制</button></div>` : ''}
    <div class="wb-controls">${renderTaskControls(detail.task.status)}</div>` : `
    ${state.error && !state.providers.length ? '<div class="wb-welcome"><p class="wb-kicker">一起做</p><h1>暂时没能打开手头的事。</h1><p>连接恢复后，就能继续查看任务和交代新事情。</p><button class="wb-btn" type="button" data-action="refresh">重新连接</button></div>' : ''}
    <div class="wb-welcome" ${state.error && !state.providers.length ? 'hidden' : ''}><p class="wb-kicker">新的一件事</p><h1>我们一起做点什么？</h1><p>说说你想做的事，再选一个放材料的文件夹。</p>
      <form id="wb-create-form" class="wb-create-form">
        <label>文件夹<div class="wb-folder-row"><input id="wb-path" name="path" required aria-describedby="wb-folder-help" placeholder="选择或粘贴一个本机文件夹"><button type="button" class="wb-btn" data-action="choose-folder">选择…</button></div><small id="wb-folder-help" class="wb-field-help">也可以直接粘贴完整路径；原生选择目前只在 macOS 提供。</small></label>
        <label>要做什么<textarea id="wb-create-text" name="text" rows="4" required placeholder="例如：整理这些访谈记录，做一份主题摘要和引用表"></textarea></label>
        <details id="wb-options" class="wb-options"><summary>执行与命名 <span>当前使用 ${escapeWorkbenchHtml(state.providers.find(p => p.id === state.defaultProvider)?.displayName || '尚未选择服务')}</span></summary><label>执行服务<select id="wb-provider" name="providerId">${(state.providers ?? []).map((p) => `<option value="${escapeWorkbenchHtml(p.id)}" ${p.id === state.defaultProvider ? 'selected' : ''}>${escapeWorkbenchHtml(p.displayName)}</option>`).join('')}</select></label>
        <label>任务名称 <span class="wb-optional">可选</span><input id="wb-title" name="title" placeholder="留空时使用任务要求的前 40 个字"></label></details>
        <button class="wb-btn wb-btn-primary" type="submit">开始任务</button>
      </form></div>`
  const artifacts = detail?.artifacts?.length ? detail.artifacts.map(artifact => `<button type="button" class="wb-artifact ${artifact.id === state.selectedArtifactId ? 'is-selected' : ''}" data-artifact-id="${escapeWorkbenchHtml(artifact.id)}"><span>${escapeWorkbenchHtml(artifact.name)}</span><small>${escapeWorkbenchHtml((artifact.size / 1024).toFixed(1))} KB · ${artifact.approvedAt ? '已确认' : '待确认'}</small></button>`).join('') : '<p class="wb-empty-copy">成果文件会在这里出现。失败或停止后，已经生成的文件仍可查看。</p>'
  const previewContent = selectedArtifact && state.preview?.artifactId === selectedArtifact.id ? state.preview.html : '<p class="wb-preview-hint">选择“打开预览”读取这份不可变快照。</p>'
  return `<div class="workbench-shell"><aside class="wb-sidebar"><header><p class="wb-kicker">手头的事</p><button type="button" class="wb-new" data-action="new-task">＋ 新事情</button></header><div class="wb-task-list">${taskList}</div></aside><main class="wb-main">${state.error ? `<div class="wb-error" role="alert">${escapeWorkbenchHtml(state.error)}</div>` : ''}${center}${detail ? `<section class="wb-artifacts"><header><p class="wb-kicker">成果</p><span>${detail?.artifacts?.length ?? 0} 件</span></header><div class="wb-artifact-list">${artifacts}</div><div id="wb-preview" class="wb-preview">${selectedArtifact ? `<p class="wb-preview-name">${escapeWorkbenchHtml(selectedArtifact.name)}</p><div class="wb-preview-content">${previewContent}</div><button type="button" class="wb-btn" data-action="preview-artifact">打开预览</button><button type="button" class="wb-btn" data-action="download-artifact">下载</button>${selectedArtifact.approvedAt ? '<p class="wb-approved">已确认此版本</p>' : '<button type="button" class="wb-btn wb-btn-primary" data-action="approve-artifact">确认这份成果</button>'}` : ''}</div></section>` : ''}</main></div>`
}

/** @param {{invokeWorkbenchApi:WorkbenchDeps['invokeWorkbenchApi'],render:(state:WorkbenchState)=>void}} deps */
export function createWorkbenchController(deps) {
  /** @type {WorkbenchState} */
  const state = { tasks: [], providers: [], defaultProvider: '', canWechat: false, selectedId: null, detail: null, selectedArtifactId: null, error: '', preview: null }
  let detailRequest = 0
  let composingNewTask = false
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
      const result = /** @type {ListResult} */ (await deps.invokeWorkbenchApi('GET', '/v1/workbench'))
      if (!alive) return
      Object.assign(state, result)
      state.error = ''
      if (state.selectedId) await this.selectTask(state.selectedId)
      else if (!composingNewTask && state.tasks[0]?.id) await this.selectTask(state.tasks[0].id)
      else paint()
    },
    /** @param {string} id */
    async selectTask(id) {
      state.selectedId = id
      composingNewTask = false
      const request = ++detailRequest
      const result = /** @type {Detail} */ (await deps.invokeWorkbenchApi('GET', `/v1/workbench/task?id=${encodeURIComponent(id)}`))
      if (!alive || request !== detailRequest || state.selectedId !== id) return
      state.detail = result
      state.selectedArtifactId = chooseArtifactId(result.artifacts ?? [], state.selectedArtifactId)
      if (state.preview && state.preview.artifactId !== state.selectedArtifactId) state.preview = null
      state.error = ''
      paint()
    },
    newTask() { detailRequest++; composingNewTask = true; state.selectedId = null; state.detail = null; state.selectedArtifactId = null; paint() },
    destroy() { alive = false; detailRequest++ },
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
  let busy = false
  let alive = true
  /** @type {string|null} */
  let objectUrl = null
  let renderedScope = 'new'
  /** @type {Map<string, Map<string, boolean>>} */
  const disclosures = new Map()
  const scopeFor = (/** @type {WorkbenchState} */ state) => state.selectedId ? `task:${state.selectedId}` : 'new'
  const captureDraft = () => pageDrafts.set(renderedScope, { path: input('wb-path')?.value ?? '', text: input('wb-create-text')?.value ?? '', title: input('wb-title')?.value ?? '', providerId: input('wb-provider')?.value ?? '', followup: input('wb-followup-text')?.value ?? '' })
  const restoreDraft = (/** @type {string} */ scope) => {
    const draft = pageDrafts.get(scope)
    for (const [id, value] of /** @type {Array<[string,string]>} */ ([['wb-path', draft.path], ['wb-create-text', draft.text], ['wb-title', draft.title], ['wb-provider', draft.providerId], ['wb-followup-text', draft.followup]])) {
      const field = input(id); if (field && value) field.value = value
    }
  }
  const controller = createWorkbenchController({ invokeWorkbenchApi: deps.invokeWorkbenchApi, render: state => {
    if (!alive) return
    captureDraft()
    const activeField = document.activeElement instanceof Element && 'value' in document.activeElement
      ? /** @type {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} */ (document.activeElement)
      : null
    const focused = activeField
      ? { id: activeField.id, start: 'selectionStart' in activeField ? activeField.selectionStart : null, end: 'selectionEnd' in activeField ? activeField.selectionEnd : null }
      : null
    const focusedDisclosure = document.activeElement instanceof Element
      ? document.activeElement.closest('summary')?.parentElement?.id
      : null
    const openState = new Map(['wb-process', 'wb-options'].map(id => [id, !!root.querySelector(`#${id}[open]`)]))
    disclosures.set(renderedScope, openState)
    const mainScroll = root.querySelector('.wb-main')?.scrollTop ?? 0
    const sameScope = renderedScope === scopeFor(state)
    root.innerHTML = renderWorkbench(state)
    for (const [id, open] of disclosures.get(scopeFor(state)) ?? []) root.querySelector(`#${id}`)?.toggleAttribute('open', open)
    const main = root.querySelector('.wb-main')
    if (main && sameScope) main.scrollTop = mainScroll
    renderedScope = scopeFor(state)
    restoreDraft(renderedScope)
    syncWorkbenchProviderLabel(root)
    if (focusedDisclosure && sameScope) {
      const summary = /** @type {HTMLElement|null} */ (root.querySelector(`#${focusedDisclosure} > summary`))
      summary?.focus()
    }
    const nextFocus = focused ? input(focused.id) : null
    if (nextFocus) { nextFocus.focus(); if (focused && focused.start !== null && focused.end !== null && 'setSelectionRange' in nextFocus) nextFocus.setSelectionRange(focused.start, focused.end) }
  } })
  /** @param {unknown} error */
  const fail = error => { if (!alive) return; const message = error instanceof Error ? error.message : String(error); controller.state.error = ['HTTP 404','workbench_endpoint_missing'].includes(message) ? '当前运行的后台还没有提供这个接口，请更新后台后重试。' : message === 'workbench_read_only_preview' ? '当前预览只允许查看任务，请使用已启用执行的桌面端。' : message === 'workbench_connection_unavailable' ? '暂时连不上任务服务，请检查后台是否运行。' : message; controller.paint() }
  /** @param {'GET'|'POST'} method @param {string} path @param {Record<string,unknown>} body */
  const mutate = async (method, path, body) => {
    if (busy || !alive) return
    busy = true
    try {
      const result = /** @type {{task?:Task}} */ (await deps.invokeWorkbenchApi(method, path, body))
      if (!alive) return
      const id = result.task?.id ?? controller.state.selectedId
      await controller.refresh()
      if (alive && id) await controller.selectTask(id)
    } catch (e) { fail(e) } finally { busy = false }
  }
  /** @param {Event} event */
  const onClick = async event => {
    const target = event.target instanceof Element ? event.target.closest('button') : null
    if (!target) return
    if (target.dataset.taskId) { captureDraft(); return controller.selectTask(target.dataset.taskId).catch(fail) }
    if (target.dataset.artifactId) { controller.state.selectedArtifactId = target.dataset.artifactId; controller.state.preview = null; return controller.paint() }
    const action = target.dataset.action
    if (action === 'refresh') return controller.refresh().catch(fail)
    if (action === 'new-task') { captureDraft(); return controller.newTask() }
    if (action === 'choose-folder') { try { const path = await deps.invoke?.('choose_workbench_folder', {}); const field = input('wb-path'); if (typeof path === 'string' && field) field.value = path } catch (e) { fail(e) } return }
    if (action === 'cancel') return mutate('POST', '/v1/workbench/cancel', { id: controller.state.selectedId })
    if (action === 'copy-wechat-command' && controller.state.selectedId) { try { await navigator.clipboard.writeText(`任务 ${controller.state.selectedId}`) } catch { fail(new Error('复制不了，请手动选中任务编号。')) } return }
    const artifact = controller.state.detail?.artifacts?.find(a => a.id === controller.state.selectedArtifactId)
    if (!artifact) return
    if (action === 'approve-artifact') return mutate('POST', '/v1/workbench/approve', { id: controller.state.selectedId, artifactId: artifact.id, sha256: artifact.sha256 })
    if (action === 'preview-artifact' || action === 'download-artifact') {
      try {
        const data = /** @type {{name:string,mime:string,contentBase64:string,size:number,sha256:string}} */ (await deps.invokeWorkbenchApi('GET', `/v1/workbench/artifact?id=${encodeURIComponent(controller.state.selectedId ?? '')}&artifactId=${encodeURIComponent(artifact.id)}`))
        if (!alive) return
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        objectUrl = URL.createObjectURL(new Blob([decodeBase64(data.contentBase64)], { type: data.mime }))
        if (action === 'download-artifact') { const a = document.createElement('a'); a.href = objectUrl; a.download = data.name; a.click(); return }
        let html = '<p class="wb-preview-hint">这种文件请下载后在本机应用中查看。</p>'
        if (data.mime.startsWith('text/') || data.mime === 'application/json') html = `<pre>${escapeWorkbenchHtml(new TextDecoder().decode(decodeBase64(data.contentBase64)))}</pre>`
        else if (data.mime.startsWith('image/')) html = `<img src="${objectUrl}" alt="${escapeWorkbenchHtml(data.name)}">`
        else if (data.mime === 'application/pdf') html = `<iframe src="${objectUrl}" title="${escapeWorkbenchHtml(data.name)}"></iframe>`
        controller.state.preview = { artifactId: artifact.id, html }
        controller.paint()
      } catch (e) { fail(e) }
    }
  }
  /** @param {SubmitEvent} event */
  const onSubmit = event => {
    event.preventDefault()
    const form = event.target instanceof Element && event.target.tagName === 'FORM' ? /** @type {HTMLFormElement} */ (event.target) : null
    if (!form) return
    if (form?.id === 'wb-create-form') { const data = new FormData(form); mutate('POST', '/v1/workbench/create', { title: data.get('title') || undefined, path: data.get('path'), providerId: data.get('providerId'), text: data.get('text') }); return }
    if (form.dataset.action === 'continue') { const text = input('wb-followup-text')?.value; if (text?.trim()) mutate('POST', '/v1/workbench/continue', { id: controller.state.selectedId, text }) }
  }
  const onChange = () => syncWorkbenchProviderLabel(root)
  root.addEventListener('change', onChange)
  root.addEventListener('click', onClick)
  root.addEventListener('submit', onSubmit)
  controller.refresh().catch(fail)
  const timer = setInterval(() => { if (!root.closest('[hidden]')) controller.refresh().catch(fail) }, deps.pollMs ?? 3000)
  active = { timer, cleanup: () => { alive = false; controller.destroy(); root.removeEventListener('change', onChange); root.removeEventListener('click', onClick); root.removeEventListener('submit', onSubmit); if (objectUrl) URL.revokeObjectURL(objectUrl) } }
  return controller
}

export function stopWorkbenchPolling() {
  if (!active) return
  clearInterval(active.timer); active.cleanup(); active = null
}
