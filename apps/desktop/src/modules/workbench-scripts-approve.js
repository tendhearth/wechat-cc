// @ts-check
// 独立工作区脚本(2026-10-20,对标 Conductor):仓库根 tendhearth.json 里的 setup / run / archive。
// CC 只跑主人当面看过、批准过的内容(按仓库 + 内容哈希);内容一改就要重新确认。这里是那一行状态 + 确认框。
/** @typedef {{setup:string|null,run:string|null,archive:string|null}} ScriptsConfig */
/** @typedef {{configured:false,invalid:string}|{configured:true,approved:boolean,hash:string,config:ScriptsConfig,setup:'none'|'pending'|'running'|'done'|'failed',run:'none'|'idle'|'queued'|'running',archiving:boolean}} ScriptsView */

const esc = (/** @type {unknown} */ value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** 后台拒收时给 428 + `script_approval_required`;代理抛回的可能是 Error、裸字符串或 {error}。 @param {unknown} error */
export function isScriptApprovalRequired(error) {
  if (error === null || error === undefined) return false
  const value = typeof error === 'object'
    ? /** @type {{message?:unknown,error?:unknown}} */ (error).message ?? /** @type {{error?:unknown}} */ (error).error ?? error
    : error
  return String(value) === 'script_approval_required'
}

export const SCRIPT_ERRORS = Object.freeze({
  script_running: '已经在运行了。',
  script_setup_running: 'setup 还在跑，跑完会接着运行。',
  script_config_changed: '脚本内容变了，请重新看一遍再确认。',
  no_scripts: '这个工作区的 tendhearth.json 里没有 run 脚本。',
  workbench_busy: '工作区正在收尾，稍后再试。',
  worktree_removed: '工作区已经删除了。',
  workbench_archived: '任务已归档，先恢复再运行。',
})
/** @param {unknown} error @returns {string|null} */
export function scriptErrorMessage(error) {
  const code = String(error instanceof Error ? error.message : /** @type {{error?:unknown}} */ (error)?.error ?? error).match(/\b(script_running|script_setup_running|script_config_changed|no_scripts|workbench_busy|worktree_removed|workbench_archived)\b/)?.[1]
  return code ? SCRIPT_ERRORS[/** @type {keyof typeof SCRIPT_ERRORS} */ (code)] : null
}

/**
 * 工作区那块下面的一行:状态(待确认 / setup / 运行中 / 端口)+ 一个按钮。没配脚本 ⇒ 空串(老界面一点不变)。
 * @param {{removed:boolean,port?:number,scripts?:ScriptsView}|undefined} wt
 */
export function worktreeScriptsHtml(wt) {
  const s = wt?.scripts
  if (!wt || wt.removed || !s || !s.configured) return ''
  const parts = []
  if (!s.approved) parts.push('待确认')
  if (s.setup === 'running') parts.push('setup 进行中')
  if (s.setup === 'failed') parts.push('setup 没跑成功')
  if (s.run === 'running') parts.push('运行中')
  if (s.run === 'queued') parts.push('setup 跑完就运行')
  if (s.archiving) parts.push('正在收尾')
  if (typeof wt.port === 'number') parts.push(`端口 ${wt.port}`)
  const button = s.archiving ? ''
    : s.run === 'running' || s.run === 'queued' ? '<button type="button" class="wb-new" data-action="worktree-stop">停下</button>'
    : s.run !== 'none' ? '<button type="button" class="wb-new" data-action="worktree-run">运行</button>'
    : !s.approved ? '<button type="button" class="wb-new" data-action="worktree-approve-scripts">确认脚本</button>'
    : ''
  return `<p class="wb-worktree wb-scripts" data-scripts-status><span>工作区脚本${parts.length ? `：${esc(parts.join(' · '))}` : ''}</span>${button}</p>`
}

/** 确认框正文:三条脚本逐字给主人看。不碰 document,好单测。 @param {ScriptsConfig} config */
export function renderScriptsApproveDialog(config) {
  const block = (/** @type {string} */ name, /** @type {string|null} */ text, /** @type {string} */ when) => text
    ? `<section class="wb-scripts-item"><h3>${name}<small>${when}</small></h3><pre class="wb-scripts-text">${esc(text)}</pre></section>`
    : ''
  return `<header class="wb-history-head"><div><h2>运行这个项目的脚本？</h2><p>项目根目录的 tendhearth.json 写了下面这些命令。确认之后，CC 会在独立工作区里照原样运行它们。</p></div></header>`
    + `<div class="wb-handoff-body">${block('setup', config.setup, '建好工作区后跑一次')}${block('run', config.run, '点「运行」时启动')}${block('archive', config.archive, '删除工作区之前跑')}`
    + `<p class="wb-history-note">只认这一份内容：同一个项目里内容不变就不再问，改了一个字都要重新确认。</p></div>`
    + `<footer class="wb-handoff-footer"><span>不确认就什么都不运行。</span><div class="wb-unattended-actions">`
    + `<button type="button" class="wb-btn" data-scripts="cancel">先不用</button>`
    + `<button type="button" class="wb-btn wb-btn-primary" data-scripts="approve">确认，运行</button></div></footer>`
}

/** 弹确认框。确认 ⇒ 先跑 onApprove(登记批准),成功才回 true;取消 / 关窗 / 登记失败 ⇒ false。
 * @param {ScriptsConfig} config @param {(()=>Promise<unknown>)|undefined} [onApprove]
 * @returns {Promise<boolean>} */
export function mountScriptsApproveDialog(config, onApprove) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog')
    dialog.className = 'wb-history-dialog wb-handoff-dialog wb-unattended-dialog wb-scripts-dialog'
    dialog.setAttribute('aria-label', '运行这个项目的脚本')
    dialog.innerHTML = renderScriptsApproveDialog(config)
    document.body.append(dialog)
    let answer = false
    let settled = false
    const finish = () => { if (settled) return; settled = true; dialog.remove(); resolve(answer) }
    dialog.addEventListener('close', finish)
    dialog.addEventListener('click', event => {
      const action = event.target instanceof Element ? event.target.closest('[data-scripts]')?.getAttribute('data-scripts') : null
      if (action === 'cancel') dialog.close()
      if (action === 'approve') void (async () => {
        try { await onApprove?.(); answer = true } catch { answer = false }
        dialog.close()
      })()
    })
    dialog.showModal()
  })
}
