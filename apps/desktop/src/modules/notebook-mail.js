// @ts-check
import { V1, v1 } from '../daemon-client.js'

const NORMAL_INTERVAL = 60_000
const REPLY_INTERVAL = 20_000
const REPLY_WINDOW = 120_000

/** @param {typeof import("../api.js").invokeApi} transport @param {(day?: string) => void} open */
export function mountNotebookMail(transport, open) {
  const envelope = document.getElementById('desk-notebook-envelope')
  const dot = document.getElementById('desk-notebook-dot')
  const row = dot?.parentElement
  /** @type {string | undefined} */
  let day
  let enabled = false
  let visible = false
  let generation = 0
  let timer = 0
  let fastUntil = 0
  let inFlight = false
  let pending = false

  function render() {
    const show = !!day && enabled && !document.documentElement.hasAttribute('data-desk-collapsed')
    envelope?.toggleAttribute('hidden', !show)
    dot?.toggleAttribute('hidden', !show)
    if (show) row?.setAttribute('aria-label', '本子，有回信')
    else row?.removeAttribute('aria-label')
  }

  async function refresh() {
    if (!visible || document.hidden) return
    if (inFlight) {
      pending = true
      return
    }
    const requestGeneration = generation
    inFlight = true
    try {
      const reply = /** @type {{ ok?: boolean, unseen?: boolean, day?: string } | null} */ (await v1(transport, V1.notebook.unseen))
      if (requestGeneration === generation) {
        day = reply?.ok === true && reply.unseen === true && typeof reply.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reply.day) ? reply.day : undefined
      }
    } catch {
      if (requestGeneration === generation) day = undefined
    } finally {
      inFlight = false
      render()
      if (pending) {
        pending = false
        void refresh()
      }
    }
  }

  function schedule() {
    window.clearTimeout(timer)
    if (!visible) return
    timer = window.setTimeout(() => {
      void refresh()
      schedule()
    }, Date.now() + REPLY_INTERVAL <= fastUntil ? REPLY_INTERVAL : NORMAL_INTERVAL)
  }

  function syncVisibility() {
    const next = enabled && !document.hidden
    if (visible === next) return
    visible = next
    generation++
    pending = false
    schedule()
    if (visible) void refresh()
  }

  document.addEventListener('visibilitychange', syncVisibility)
  window.addEventListener('focus', () => {
    if (!visible || inFlight) return
    void refresh()
    schedule()
  })
  envelope?.addEventListener('click', () => open(day))

  return {
    /** @param {boolean} active */
    sync(active) {
      enabled = active
      if (!enabled) day = undefined
      syncVisibility()
      render()
    },
    day: () => enabled && !document.documentElement.hasAttribute('data-desk-collapsed') ? day : undefined,
    canConfirm: () => enabled,
    /** @param {string[]} ids */
    async markSeen(ids) {
      const result = /** @type {{ ok?: boolean } | null} */ (await v1(transport, V1.notebook.seen, { body: { ids } }))
      if (result?.ok !== true) return false
      void refresh()
      return true
    },
    wrote() {
      if (!enabled) return
      fastUntil = Date.now() + REPLY_WINDOW
      schedule()
    },
  }
}
