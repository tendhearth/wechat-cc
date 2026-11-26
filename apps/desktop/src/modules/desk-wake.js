// @ts-check

const wakeButton = 'button[data-wake-cc]'
const cardError = '[data-wake-cc-error]'
const conversationError = '#converse-wake-error'

export function hideDeskWakeFailures() {
  document.querySelectorAll(`${conversationError}, ${cardError}`).forEach(error => error.setAttribute('hidden', ''))
}

/** @param {HTMLButtonElement} button */
function wakeFailureTarget(button) {
  const note = button.closest('[data-waiting-offline]')
  if (!note) {
    const conversation = button.closest('#converse-root')
    return () => conversation?.querySelector(conversationError)
  }

  const waiting = note.closest('#desk-waiting')
  const card = note.closest('.desk-waiting-card')
  const key = card?.getAttribute('data-item-key')
  const place = card?.getAttribute('data-place-key')
  const request = card?.getAttribute('data-request-id')
  return () => {
    if (note.isConnected) return note.querySelector(cardError)
    // The waiting list may redraw while the daemon is starting.
    if (!waiting?.isConnected || !key) return
    const replacement = Array.from(waiting.querySelectorAll('.desk-waiting-card')).find(current =>
      current.getAttribute('data-item-key') === key && current.getAttribute('data-place-key') === place
      && current.getAttribute('data-request-id') === request)
    return replacement?.querySelector(cardError)
  }
}

/** @param {() => Promise<unknown>} wake @param {AbortSignal} [signal] */
export function wireDeskWake(wake, signal) {
  let waking = false
  document.addEventListener('click', async event => {
    const button = event.target instanceof Element ? event.target.closest(wakeButton) : null
    const root = document.documentElement
    if (!(button instanceof HTMLButtonElement) || button.disabled || waking || !root.hasAttribute('data-desk-cc-stopped')) return
    const failure = wakeFailureTarget(button)
    waking = true
    hideDeskWakeFailures()

    /** @type {Map<HTMLButtonElement, {label: string, disabled: boolean}>} */
    const controls = new Map()
    const markPending = (/** @type {Element} */ control) => {
      if (!(control instanceof HTMLButtonElement) || controls.has(control)) return
      controls.set(control, { label: control.textContent ?? '', disabled: control.disabled })
      control.disabled = true
      control.textContent = '在叫…'
    }
    const observer = new MutationObserver(records => {
      for (const { addedNodes } of records) {
        for (const node of addedNodes) {
          if (!(node instanceof Element)) continue
          if (node.matches(wakeButton)) markPending(node)
          node.querySelectorAll(wakeButton).forEach(markPending)
        }
      }
    })
    observer.observe(root, { childList: true, subtree: true })
    document.querySelectorAll(wakeButton).forEach(markPending)

    try {
      await wake()
    } catch { /* Keep the retry available when the connection check fails. */ } finally {
      observer.disconnect()
      for (const [control, { label, disabled }] of controls) {
        control.disabled = disabled
        control.textContent = label
      }
      waking = false
      if (root.hasAttribute('data-desk-cc-stopped')) failure()?.removeAttribute('hidden')
    }
  }, { signal })
}
