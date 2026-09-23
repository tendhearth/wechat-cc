// @ts-check
// 免审执行者(agy):它们不报单步操作,主人拦不下来。工作台第一次把任务
// 交给这类执行者前,当面把四条限制说清,确认过一次就不再问。
/** @typedef {{id?:string,displayName?:string,capabilities?:{permissions?:string}}} UnattendedProvider */

export const UNATTENDED_NOTES = [
  '看不到、拦不下单步操作:没有权限卡和提问,只能停止。',
  '它用的工具凭据不是按任务隔离的。',
  '时间线只有文字,没有逐条工具调用。',
  '不能带附件,不能选模型和推理档。',
]

const esc = (/** @type {unknown} */ value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** @param {UnattendedProvider|null|undefined} provider */
export function isUnattendedProvider(provider) {
  return provider?.capabilities?.permissions === 'unattended'
}

/** 执行者名后面的记号:一眼看出这一位不会来问。 @param {UnattendedProvider|null|undefined} provider */
export function unattendedLabelSuffix(provider) {
  return isUnattendedProvider(provider) ? '（免审）' : ''
}

/** 后台拒收时给的是 428 + `unattended_ack_required`。Tauri 代理把响应体里的 error
 * 原样抛回来,可能是 Error,也可能是裸字符串,两种都要认。
 * @param {unknown} error */
export function isAckRequiredError(error) {
  if (error === null || error === undefined) return false
  const value = typeof error === 'object'
    ? /** @type {{message?:unknown,error?:unknown}} */ (error).message ?? /** @type {{error?:unknown}} */ (error).error ?? error
    : error
  return String(value) === 'unattended_ack_required'
}

/** 对话框正文:标题 + 四条 + 两个按钮。不碰 document,好单测。 */
export function renderUnattendedDialog() {
  return `<header class="wb-history-head"><div><h2>免审执行者</h2><p>这位执行者跑起来不会来问你。开始之前,请先看清这四条。</p></div></header>`
    + `<div class="wb-handoff-body"><ul class="wb-unattended-notes">${UNATTENDED_NOTES.map(note => `<li>${esc(note)}</li>`).join('')}</ul>`
    + `<p class="wb-history-note">确认一次之后,微信和桌面都不会再问。</p></div>`
    + `<footer class="wb-handoff-footer"><span>不确认就不开始,任务不会被创建。</span><div class="wb-unattended-actions">`
    + `<button type="button" class="wb-btn" data-unattended="cancel">先不用</button>`
    + `<button type="button" class="wb-btn wb-btn-primary" data-unattended="ack">知道了,继续</button></div></footer>`
}

/** 弹一次确认。确认 ⇒ 先跑 onAck(登记确认),再关门并回 true;取消 / 关窗 ⇒ false。
 * @param {(()=>Promise<unknown>)|undefined} [onAck]
 * @returns {Promise<boolean>} */
export function mountUnattendedDialog(onAck) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog')
    dialog.className = 'wb-history-dialog wb-handoff-dialog wb-unattended-dialog'
    dialog.setAttribute('aria-label', '免审执行者')
    dialog.innerHTML = renderUnattendedDialog()
    document.body.append(dialog)
    let answer = false
    let settled = false
    const finish = () => { if (settled) return; settled = true; dialog.remove(); resolve(answer) }
    dialog.addEventListener('close', finish)
    dialog.addEventListener('click', event => {
      const action = event.target instanceof Element ? event.target.closest('[data-unattended]')?.getAttribute('data-unattended') : null
      if (action === 'cancel') dialog.close()
      if (action === 'ack') void (async () => {
        // onAck 失败就当没确认:宁可再问一次,也不要拿没登记的确认去重发。
        try { await onAck?.(); answer = true } catch { answer = false }
        dialog.close()
      })()
    })
    dialog.showModal()
  })
}
