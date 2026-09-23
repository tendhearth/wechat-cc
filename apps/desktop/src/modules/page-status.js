// @ts-check
import { escapeHtml } from '../view.js'

/** @typedef {{ title: string, detail?: string, actionLabel?: string }} PageStatus */
/** @param {PageStatus} state */
export function pageStatusHtml(state) {
  return `<div class="cc-page-status" role="status"><h2>${escapeHtml(state.title)}</h2>${state.detail ? `<p>${escapeHtml(state.detail)}</p>` : ''}${state.actionLabel ? `<button type="button" data-page-retry>${escapeHtml(state.actionLabel)}</button>` : ''}</div>`
}

/** Recovery stays with the caller: this component never changes data or routes.
 * @param {HTMLElement|null} host @param {PageStatus} state
 * @param {() => unknown | Promise<unknown>} [recover] */
export function showPageStatus(host, state, recover) {
  if (!host) return
  host.innerHTML = pageStatusHtml({ ...state, actionLabel: recover ? state.actionLabel : undefined })
  const button = /** @type {HTMLButtonElement|null} */ (host.querySelector('[data-page-retry]'))
  button?.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    try { await recover?.() } catch (err) { console.error('page recovery failed', err) }
    finally { button.disabled = false }
  })
}
