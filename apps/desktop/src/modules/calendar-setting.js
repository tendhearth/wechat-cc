// @ts-check
import { DAEMON_DOWN_TEXT, isDaemonDownError } from '../daemon-errors.js'
import { V1, v1 } from '../daemon-client.js'

const PERMISSION_TEXT = {
  granted: '关着，Mac 已授权。',
  not_determined: 'Mac 还没授权。',
  denied: 'Mac 没给权限。要用的话去『系统设置 → 隐私与安全性 → 日历 / 提醒事项』里打开 Tendhearth CC，再回来开一次。',
  unavailable: '这台电脑目前读不了日历和提醒。',
}

/** @typedef {{ enabled: boolean, permission: keyof typeof PERMISSION_TEXT }} CalendarStatus */

/** @param {typeof import('../api.js').invokeWorkbenchApi} invokeWorkbenchApi */
export function wireCalendarSetting(invokeWorkbenchApi) {
  const toggle = document.getElementById('calendar-toggle')
  const feedback = document.getElementById('calendar-toggle-feedback')
  if (!(toggle instanceof HTMLButtonElement) || !feedback) return () => {}
  let saving = false
  let refreshId = 0

  /** @param {boolean} on */
  const showToggle = (on) => {
    toggle.classList.toggle('on', on)
    toggle.setAttribute('aria-pressed', String(on))
  }

  /** @param {CalendarStatus} status */
  const showStatus = ({ enabled, permission }) => {
    if (typeof enabled !== 'boolean' || !Object.hasOwn(PERMISSION_TEXT, permission)) throw new Error('invalid_calendar_status')
    showToggle(enabled)
    feedback.textContent = enabled && permission === 'granted' ? '开着，Mac 已授权。' : PERMISSION_TEXT[permission]
  }

  toggle.addEventListener('click', async () => {
    if (toggle.disabled) return
    const on = toggle.getAttribute('aria-pressed') !== 'true'
    saving = true
    toggle.disabled = true
    toggle.setAttribute('aria-busy', 'true')
    feedback.textContent = on ? '正在请求授权…' : '正在关闭…'
    let daemonDown = false
    try {
      const result = await v1(invokeWorkbenchApi, V1.calendar.setEnabled, { body: { on } })
      if (on) {
        const status = /** @type {CalendarStatus} */ (result)
        showStatus(status)
        if (status.permission !== 'granted') showToggle(false)
      } else {
        const stopped = /** @type {{ enabled: boolean, text: string }} */ (result)
        if (stopped?.enabled !== false || typeof stopped.text !== 'string') throw new Error('invalid_calendar_status')
        showToggle(false)
        feedback.textContent = stopped.text
      }
    } catch (err) {
      daemonDown = isDaemonDownError(String(/** @type {Error} */ (err)?.message ?? err))
      feedback.textContent = daemonDown ? DAEMON_DOWN_TEXT : '没能更新日历设置。请稍后再试。'
    } finally {
      saving = false
      toggle.disabled = daemonDown
      toggle.removeAttribute('aria-busy')
    }
  })

  return async function refresh() {
    if (saving) return
    const id = ++refreshId
    toggle.disabled = true
    feedback.textContent = ''
    try {
      const result = await v1(invokeWorkbenchApi, V1.calendar.status)
      if (id !== refreshId) return
      showStatus(/** @type {CalendarStatus} */ (result))
      toggle.disabled = false
    } catch (err) {
      if (id !== refreshId) return
      showToggle(false)
      feedback.textContent = isDaemonDownError(String(/** @type {Error} */ (err)?.message ?? err))
        ? DAEMON_DOWN_TEXT : '暂时读不到日历设置。'
    }
  }
}
