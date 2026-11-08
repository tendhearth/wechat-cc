// @ts-check
import { CC_ACTIVITY, createCCActivity } from './generated/cc-activity.js'

/** Local UI evidence only: no draft text leaves the input, and a lease cannot survive a lost window.
 * @param {{stage:HTMLElement,doc?:Document,now?:()=>number}} o */
export function mountCCActivity({ stage, doc = stage.ownerDocument, now = Date.now }) {
  const tracker = createCCActivity()
  let connected = false, waiting = false, blocked = false, enabled = true, disposed = false
  let typingUntil = -Infinity
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('cc-local-input-v1') : null
  function render() {
    clearTimeout(timer)
    const phase = !doc.hidden && enabled ? tracker.phase({ connected, waiting, blocked, typing: now() < typingUntil, now: now() }) : 'idle'
    stage.dataset.ccPhase = phase
    if (!disposed && phase !== 'idle') timer = setTimeout(render, 100)
  }
  const stopTyping = () => { typingUntil = -Infinity; channel?.postMessage({ typing: false }); render() }
  /** @param {Event} event */
  const input = event => {
    const target = event.target
    if (!(target instanceof HTMLTextAreaElement) || target.id !== 'converse-input') return
    const typing = target === doc.activeElement && !!target.value.trim() && !target.disabled
    typingUntil = typing ? now() + CC_ACTIVITY.typingMs : -Infinity
    channel?.postMessage({ typing }); render()
  }
  /** @param {Event} event */
  const blur = event => { if (/** @type {HTMLElement|null} */ (event.target)?.id === 'converse-input') stopTyping() }
  const visibility = () => { if (doc.hidden) { tracker.observe(null, now(), false); stopTyping() } else render() }
  channel?.addEventListener('message', event => { if (typeof event.data?.typing !== 'boolean') return; typingUntil = event.data.typing ? now() + CC_ACTIVITY.typingMs : -Infinity; render() })
  doc.addEventListener('input', input); doc.addEventListener('focusout', blur); doc.addEventListener('visibilitychange', visibility)
  doc.defaultView?.addEventListener('blur', stopTyping)
  render()
  return {
    /** @param {import('./generated/cc-activity.js').CCStream|null|undefined} stream */
    observe(stream) { tracker.observe(connected && enabled && !doc.hidden ? stream : null, now()); render() },
    /** @param {{connected:boolean,waiting?:boolean,blocked?:boolean,enabled?:boolean}} facts */
    update(facts) {
      connected = facts.connected; waiting = facts.waiting === true; blocked = facts.blocked === true; enabled = facts.enabled !== false
      if (!connected || !enabled) { tracker.observe(null, now(), false); typingUntil = -Infinity }
      render()
    },
    /** @param {boolean} on */
    setEnabled(on) { enabled = on; if (!on) { tracker.observe(null, now(), false); typingUntil = -Infinity }; render() },
    destroy() { disposed = true; clearTimeout(timer); channel?.close(); doc.removeEventListener('input', input); doc.removeEventListener('focusout', blur); doc.removeEventListener('visibilitychange', visibility); doc.defaultView?.removeEventListener('blur', stopTyping); delete stage.dataset.ccPhase },
  }
}

/** Companion has no transcript reader. Read the existing owner event projection only while reachable/visible.
 * @param {{read:(cursor:number)=>Promise<import('./generated/cc-activity.js').CCStream & {cursor:number}>,observe:(s:import('./generated/cc-activity.js').CCStream|null)=>void}} deps */
export function createCCActivityFeed({ read, observe }) {
  let generation = 0, running = false, inFlight = false, cursor = 0, scope = '', primed = false
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer
  const poll = async (/** @type {number} */ token) => {
    if (!running || inFlight) return
    inFlight = true
    try {
      const value = await read(cursor)
      if (running && token === generation) {
        if (scope && value.scope && scope !== value.scope) { cursor=0; primed=false; scope=value.scope; observe(null); return }
        scope=value.scope??scope; cursor=value.cursor
        observe({ ...value, activityReady: primed })
        if (!value.events.length) primed=true
      }
    }
    catch { if (running && token === generation) { primed=false; observe(null) } }
    finally {
      inFlight = false
      if (running) {
        if (token === generation) timer = setTimeout(() => void poll(token), 1000)
        else void poll(generation) // A resumed reader waits for the retired host request to finish.
      }
    }
  }
  return {
    start() { if (running) return; running = true; void poll(++generation) },
    stop() { if (!running) return; running = false; generation++; cursor=0; scope=''; primed=false; clearTimeout(timer); observe(null) },
  }
}
