// @ts-check
import { escapeHtml } from '../view.js'

/** A local read failure. The caller keeps the exact view/query for retry.
 * @param {HTMLElement} host
 * @param {{ title: string, description: string, retry: () => Promise<unknown> }} options
 */
export function showPageError(host, { title, description, retry }) {
  host.innerHTML = `<section class="cc-page-status" role="status">
    <h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p>
    <button type="button" data-page-retry>重新读取</button>
  </section>`
  const button = /** @type {HTMLButtonElement|null} */ (host.querySelector('[data-page-retry]'))
  button?.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    button.textContent = '正在读取…'
    try { await retry() }
    catch (error) { console.error('page retry failed', error) }
    finally {
      button.disabled = false
      button.textContent = '重新读取'
    }
  })
}
