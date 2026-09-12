// @ts-check

/** @typedef {{id:string,title:string,path:string,providerId:string,status:string,createdAt:number,updatedAt:number,error:string|null}} Task */
/** @typedef {{id:string,taskId:string,kind:'user'|'text'|'tool_call'|'system'|'error',text:string,createdAt:number}} WorkbenchEvent */
/** @typedef {{id:string,taskId:string,name:string,mime:string,size:number,sha256:string,createdAt:number,approvedAt:number|null}} Artifact */

let active = null

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

/** @param {any} state */
export function renderWorkbench(state) {
  const tasks = state.tasks ?? []
  const detail = state.detail
  const selectedArtifact = detail?.artifacts?.find((/** @type {Artifact} */ a) => a.id === state.selectedArtifactId)
  const taskList = tasks.length ? tasks.map((/** @type {Task} */ task) => `
    <button type="button" class="wb-task ${task.id === state.selectedId ? 'is-selected' : ''}" data-task-id="${escapeWorkbenchHtml(task.id)}">
      <span class="wb-task-title">${escapeWorkbenchHtml(task.title || '未命名任务')}</span>
      <span class="wb-task-meta"><span class="wb-status" data-status="${escapeWorkbenchHtml(task.status)}">${escapeWorkbenchHtml(statusLabel(task.status))}</span><time>${escapeWorkbenchHtml(time(task.updatedAt))}</time></span>
      <span class="wb-task-path">${escapeWorkbenchHtml(task.path)}</span>
    </button>`).join('') : '<p class="wb-empty-copy">还没有任务。选一个文件夹，把要做的事交给 CC。</p>'
  const center = detail ? `
    <header class="wb-task-head"><div><p class="wb-kicker">任务 ${escapeWorkbenchHtml(detail.task.id)}</p><h2>${escapeWorkbenchHtml(detail.task.title || '未命名任务')}</h2><p class="wb-path">${escapeWorkbenchHtml(detail.task.path)}</p></div><span class="wb-status" data-status="${escapeWorkbenchHtml(detail.task.status)}">${escapeWorkbenchHtml(statusLabel(detail.task.status))}</span></header>
    <div class="wb-events" aria-live="polite">${detail.events.length ? detail.events.map((event) => `<article class="wb-event" data-kind="${escapeWorkbenchHtml(event.kind)}"><div class="wb-event-meta"><span>${escapeWorkbenchHtml(event.kind === 'user' ? '你' : event.kind === 'tool_call' ? '操作' : event.kind === 'error' ? '错误' : 'CC')}</span><time>${escapeWorkbenchHtml(time(event.createdAt))}</time></div><p>${escapeWorkbenchHtml(event.text)}</p></article>`).join('') : '<p class="wb-empty-copy">任务已创建，等待第一条进展。</p>'}</div>
    ${detail.task.error ? `<div class="wb-error" role="alert">${escapeWorkbenchHtml(detail.task.error)}</div>` : ''}
    <div class="wb-controls">${renderTaskControls(detail.task.status)}</div>` : `
    <div class="wb-welcome"><p class="wb-kicker">新的文件夹任务</p><h1>把一件事交给 CC</h1><p>原始文件默认保留不动；待交付文件会集中放进任务成果目录。</p>
      <form id="wb-create-form" class="wb-create-form">
        <label>文件夹<div class="wb-folder-row"><input id="wb-path" name="path" required placeholder="选择一个本机文件夹"><button type="button" class="wb-btn" data-action="choose-folder">选择…</button></div></label>
        <label>要做什么<textarea id="wb-create-text" name="text" rows="7" required placeholder="例如：整理这些访谈记录，做一份主题摘要和引用表"></textarea></label>
        <label>执行服务<select id="wb-provider" name="providerId">${(state.providers ?? []).map((p) => `<option value="${escapeWorkbenchHtml(p.id)}" ${p.id === state.defaultProvider ? 'selected' : ''}>${escapeWorkbenchHtml(p.displayName)}</option>`).join('')}</select></label>
        <label>任务名称 <span class="wb-optional">可选</span><input id="wb-title" name="title" placeholder="CC 会在留空时自动概括"></label>
        <button class="wb-btn wb-btn-primary" type="submit">开始任务</button>
      </form></div>`
  const artifacts = detail?.artifacts?.length ? detail.artifacts.map((artifact) => `<button type="button" class="wb-artifact ${artifact.id === state.selectedArtifactId ? 'is-selected' : ''}" data-artifact-id="${escapeWorkbenchHtml(artifact.id)}"><span>${escapeWorkbenchHtml(artifact.name)}</span><small>${escapeWorkbenchHtml((artifact.size / 1024).toFixed(1))} KB · ${artifact.approvedAt ? '已确认' : '待确认'}</small></button>`).join('') : '<p class="wb-empty-copy">成果文件会在这里出现。失败或停止后，已经生成的文件仍可查看。</p>'
  return `<div class="workbench-shell"><aside class="wb-sidebar"><header><p class="wb-kicker">CC 工作台</p><button type="button" class="wb-new" data-action="new-task">＋ 新任务</button></header><div class="wb-task-list">${taskList}</div></aside><main class="wb-main">${state.error ? `<div class="wb-error" role="alert">${escapeWorkbenchHtml(state.error)}</div>` : ''}${center}</main><aside class="wb-artifacts"><header><p class="wb-kicker">成果</p><span>${detail?.artifacts?.length ?? 0} 件</span></header><div class="wb-artifact-list">${artifacts}</div><div id="wb-preview" class="wb-preview">${selectedArtifact ? `<p class="wb-preview-name">${escapeWorkbenchHtml(selectedArtifact.name)}</p><p class="wb-preview-hint">选择“打开预览”读取这份不可变快照。</p><button type="button" class="wb-btn" data-action="preview-artifact">打开预览</button><button type="button" class="wb-btn" data-action="download-artifact">下载</button>${selectedArtifact.approvedAt ? '<p class="wb-approved">已确认此版本</p>' : '<button type="button" class="wb-btn wb-btn-primary" data-action="approve-artifact">确认这份成果</button>'}` : ''}</div></aside></div>`
}

/** @param {{invokeWorkbenchApi:Function,render:Function}} deps */
export function createWorkbenchController(deps) {
  const state = { tasks: [], providers: [], defaultProvider: '', canWechat: false, selectedId: null, detail: null, selectedArtifactId: null, error: '' }
  let detailRequest = 0
  let composingNewTask = false
  const paint = () => deps.render(state)
  return {
    state,
    async refresh() {
      const result = await deps.invokeWorkbenchApi('GET', '/v1/workbench')
      Object.assign(state, result)
      if (state.selectedId) await this.selectTask(state.selectedId)
      else if (!composingNewTask && state.tasks[0]?.id) await this.selectTask(state.tasks[0].id)
      else paint()
    },
    async selectTask(id) {
      state.selectedId = id
      composingNewTask = false
      const request = ++detailRequest
      const result = await deps.invokeWorkbenchApi('GET', `/v1/workbench/task?id=${encodeURIComponent(id)}`)
      if (request !== detailRequest || state.selectedId !== id) return
      state.detail = result
      state.selectedArtifactId = chooseArtifactId(result.artifacts ?? [], state.selectedArtifactId)
      state.error = ''
      paint()
    },
    newTask() { detailRequest++; composingNewTask = true; state.selectedId = null; state.detail = null; state.selectedArtifactId = null; paint() },
    paint,
  }
}

/** @param {string} base64 */
function decodeBase64(base64) {
  const bytes = atob(base64); const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i)
  return out
}

/** @param {{invokeWorkbenchApi:Function,invoke?:Function,pollMs?:number}} deps */
export function initWorkbenchPage(deps) {
  stopWorkbenchPolling()
  const root = document.getElementById('workbench-root')
  if (!root) return
  let busy = false
  let objectUrl = null
  const captureDrafts = () => ({ path: document.getElementById('wb-path')?.value, text: document.getElementById('wb-create-text')?.value, title: document.getElementById('wb-title')?.value, followup: document.getElementById('wb-followup-text')?.value })
  const restoreDrafts = (drafts) => { for (const [id, value] of [['wb-path', drafts.path], ['wb-create-text', drafts.text], ['wb-title', drafts.title], ['wb-followup-text', drafts.followup]]) { const el = document.getElementById(id); if (el && value !== undefined) el.value = value } }
  const controller = createWorkbenchController({ invokeWorkbenchApi: deps.invokeWorkbenchApi, render: state => { const drafts = captureDrafts(); root.innerHTML = renderWorkbench(state); restoreDrafts(drafts) } })
  const fail = (error) => { controller.state.error = error instanceof Error ? error.message : String(error); controller.paint() }
  const mutate = async (method, path, body) => { if (busy) return; busy = true; try { const result = await deps.invokeWorkbenchApi(method, path, body); const id = result?.task?.id ?? controller.state.selectedId; await controller.refresh(); if (id) await controller.selectTask(id) } catch (e) { fail(e) } finally { busy = false } }
  root.addEventListener('click', async event => {
    const target = event.target instanceof Element ? event.target.closest('button') : null
    if (!target) return
    if (target.dataset.taskId) return controller.selectTask(target.dataset.taskId).catch(fail)
    if (target.dataset.artifactId) { controller.state.selectedArtifactId = target.dataset.artifactId; return controller.paint() }
    const action = target.dataset.action
    if (action === 'new-task') return controller.newTask()
    if (action === 'choose-folder') { try { const path = await deps.invoke?.('choose_workbench_folder', {}); const input = document.getElementById('wb-path'); if (path && input) input.value = path } catch (e) { fail(e) } return }
    if (action === 'cancel') return mutate('POST', '/v1/workbench/cancel', { id: controller.state.selectedId })
    const artifact = controller.state.detail?.artifacts?.find(a => a.id === controller.state.selectedArtifactId)
    if (!artifact) return
    if (action === 'approve-artifact') return mutate('POST', '/v1/workbench/approve', { id: controller.state.selectedId, artifactId: artifact.id, sha256: artifact.sha256 })
    if (action === 'preview-artifact' || action === 'download-artifact') {
      try {
        const data = await deps.invokeWorkbenchApi('GET', `/v1/workbench/artifact?id=${encodeURIComponent(controller.state.selectedId)}&artifactId=${encodeURIComponent(artifact.id)}`)
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        objectUrl = URL.createObjectURL(new Blob([decodeBase64(data.contentBase64)], { type: data.mime }))
        if (action === 'download-artifact') { const a = document.createElement('a'); a.href = objectUrl; a.download = data.name; a.click(); return }
        const preview = document.getElementById('wb-preview'); if (!preview) return
        if (data.mime.startsWith('text/') || data.mime === 'application/json') preview.innerHTML = `<pre>${escapeWorkbenchHtml(new TextDecoder().decode(decodeBase64(data.contentBase64)))}</pre>`
        else if (data.mime.startsWith('image/')) preview.innerHTML = `<img src="${objectUrl}" alt="${escapeWorkbenchHtml(data.name)}">`
        else if (data.mime === 'application/pdf') preview.innerHTML = `<iframe src="${objectUrl}" title="${escapeWorkbenchHtml(data.name)}"></iframe>`
        else preview.innerHTML = '<p class="wb-preview-hint">这种文件请下载后在本机应用中查看。</p>'
      } catch (e) { fail(e) }
    }
  })
  root.addEventListener('submit', event => {
    event.preventDefault()
    const form = event.target
    if (form?.id === 'wb-create-form') { const data = new FormData(form); mutate('POST', '/v1/workbench/create', { title: data.get('title') || undefined, path: data.get('path'), providerId: data.get('providerId'), text: data.get('text') }); return }
    if (form?.dataset?.action === 'continue') { const text = document.getElementById('wb-followup-text')?.value; if (text?.trim()) mutate('POST', '/v1/workbench/continue', { id: controller.state.selectedId, text }) }
  })
  controller.refresh().catch(fail)
  const timer = setInterval(() => { if (!root.closest('[hidden]')) controller.refresh().catch(fail) }, deps.pollMs ?? 3000)
  active = { timer, cleanup: () => { if (objectUrl) URL.revokeObjectURL(objectUrl) } }
  return controller
}

export function stopWorkbenchPolling() {
  if (!active) return
  clearInterval(active.timer); active.cleanup(); active = null
}
