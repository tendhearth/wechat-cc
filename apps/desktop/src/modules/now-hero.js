// @ts-check
// Home consumes existing snapshots. Only the shared pet owns picture timers.
import { createPet } from '../pet/pet.js'
import { presenceToPet } from '../pet/bridge/presence-map.js'
import { progressTransitions } from './workbench-attention.js'
import { createCompanionPreferences, MOTION_STORAGE_KEY } from '../companion-preferences.js'

/** @typedef {import('../pet/bridge/presence-map.js').PetIntent} PetIntent */
/** @typedef {{intent:PetIntent,align:boolean}} HeroUpdate */

/** Independent baselines: another stream arriving cannot turn history into an event. */
export function createNowHeroFacts() {
  /** @type {import('../presence-poller.js').Presence|null} */ let previousPresence = null
  /** @type {PetIntent} */ let presenceIntent = presenceToPet(null, null)
  /** @type {Map<string,string>|null} */ let progress = null
  let attentionWaiting = false, attentionStale = false, terminalWaiting = false
  let converseObserved = false, pending = false, converseFailed = false
  /** @type {Set<number>} */ let converseIds = new Set()
  let active = true, quiet = false, reducedMotion = false
  const connected = () => presenceIntent.form === 'lit'
  /** @param {PetIntent['oneShots']} [events] @param {boolean} [align] @returns {HeroUpdate} */
  const result = (events = [], align = false) => {
    const phases = progress ? [...progress.values()] : []
    const waiting = attentionWaiting || terminalWaiting
    const failed = phases.some(p => p === 'failed' || p === 'interrupted')
    const props = [...presenceIntent.props]
    if ((attentionStale || failed || converseFailed) && connected() && !props.includes('exclamation')) props.push('exclamation')
    /** @type {PetIntent['behavior']} */ let behavior = presenceIntent.behavior
    if (connected()) {
      if (waiting) behavior = 'permission'
      else if (pending) behavior = 'thinking'
      else if (phases.includes('working')) behavior = 'working'
    }
    return { align, intent: { ...presenceIntent, behavior, props, oneShots: active && !quiet && !reducedMotion && connected() && !waiting ? [...new Set(events)] : [] } }
  }
  return {
    current: () => result(),
    /** @param {import('../presence-poller.js').Presence|null} p */
    presence(p) {
      const wasConnected = connected()
      const next = presenceToPet(p, previousPresence)
      const align = !previousPresence || !wasConnected
      if (!wasConnected) { progress = null; converseObserved = false }
      presenceIntent = { ...next, oneShots: [] }
      if (next.form === 'unlit') {
        previousPresence = null
        progress = null; converseObserved = false
        // Stale task facts cannot keep claiming a current work phase across a disconnect.
        pending = false
      } else previousPresence = p
      return result(align ? [] : next.oneShots, align)
    },
    /** @param {import('./workbench-attention.js').AttentionState|null} state */
    attention(state) {
      attentionStale = !state || state.stale
      attentionWaiting = !attentionStale && !!state?.tasks.some(t => t.pendingPermissionCount + t.pendingQuestionCount > 0)
      const next = !attentionStale && state?.progress instanceof Map ? new Map(state.progress) : null
      const moved = progressTransitions(progress, next)
      progress = next
      return result(moved.stopped.length ? ['error'] : moved.replied.length ? ['done'] : [])
    },
    /** @param {Array<{id:string,hash?:string|null}>} rows */
    terminal(rows) { terminalWaiting = rows.length > 0; return result() },
    /** A local pending row must precede a new CC reply; initial shared history is never a receipt.
     * @param {Array<{id:number,role:string,pending?:boolean}>} msgs */
    converse(msgs) {
      const nextPending = msgs.some(m => m.role === 'cc' && m.pending)
      const lastOutcome = [...msgs].reverse().find(m => m.role === 'error' || (m.role === 'cc' && !m.pending))
      converseFailed = !nextPending && lastOutcome?.role === 'error'
      const errored = converseObserved && converseFailed && lastOutcome && !converseIds.has(lastOutcome.id)
      const received = converseObserved && pending && !nextPending && msgs.some(m => m.role === 'cc' && !m.pending && !converseIds.has(m.id))
      converseIds = new Set(msgs.map(m => m.id))
      pending = nextPending; converseObserved = true
      return result(errored ? ['error'] : received ? ['receive'] : [])
    },
    /** @param {boolean} on */
    setActive(on) { const resumed = on && !active; active = on; return result([], resumed) },
    /** @param {{quiet?:boolean,reducedMotion?:boolean}} motion */
    setMotion(motion) {
      if (motion.quiet !== undefined) quiet = motion.quiet
      if (motion.reducedMotion !== undefined) reducedMotion = motion.reducedMotion
      return result()
    },
  }
}

/** @param {{root:HTMLElement,button:HTMLElement,motionQuery?:MediaQueryList|null,storage?:Storage|null,petOptions?:Partial<Parameters<typeof createPet>[1]>}} o */
export function mountNowHero({ root, button, motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null, storage, petOptions = {} }) {
  const doc = root.ownerDocument
  const view = doc.defaultView
  if (storage === undefined) { try { storage = view?.localStorage ?? null } catch { storage = null } }
  const facts = createNowHeroFacts()
  // Visibility or motion suppression can end before a delayed stream returns.
  // Each first fresh observation consumes its own old baseline independently.
  const reobserve = new Set()
  let destroyed = false
  /** @type {Awaited<ReturnType<typeof createPet>>|null} */ let pet = null
  /** @type {(()=>void)|null} */ let offMachine = null
  const stage = doc.createElement('span'); stage.className = 'now-pet-stage'; stage.hidden = true; stage.setAttribute('aria-hidden', 'true')
  const img = doc.createElement('img'); img.className = 'pet-sprite now-pet-sprite'; img.alt = ''; img.draggable = false
  const props = doc.createElement('span'); props.className = 'now-pet-props'
  stage.append(img, props); button.append(stage)
  const isActive = () => !doc.hidden && !root.hidden && root.dataset.now !== 'chat' && !root.closest('[hidden]') && (!root.closest('.dashboard') || doc.documentElement.dataset.mode === 'dashboard')
  let active = isActive()
  facts.setActive(active)
  /** @type {import('../companion-preferences.js').MotionPreferences} */ let motion
  /** @param {HeroUpdate} update */
  const apply = ({ intent, align }) => {
    if (destroyed) return
    button.dataset.motion = motion.reducedMotion || motion.quiet ? 'reduced' : 'full'
    if (!pet) return
    // An inactive or reduced view observes facts without retaining any performance.
    pet.setPaused(!active)
    pet.setQuiet(motion.quiet)
    pet.setReducedMotion(motion.reducedMotion || align || !active)
    pet.applyIntent(intent)
    if (align || !active || motion.reducedMotion || motion.quiet) {
      pet.machine.notifyAnimationEnded()
      pet.setState(intent.behavior)
    }
    pet.setReducedMotion(motion.reducedMotion)
  }
  /** @param {import('../companion-preferences.js').MotionPreferences} s */
  const applyMotion = s => {
    if ((motion?.quiet && !s.quiet) || (motion?.reducedMotion && !s.reducedMotion)) for (const stream of ['presence', 'attention', 'terminal', 'converse']) reobserve.add(stream)
    motion = s; apply(facts.setMotion(s))
  }
  const readPreferences = () => createCompanionPreferences({ storage, systemReduced: motionQuery?.matches, onChange: applyMotion })
  let preferences = readPreferences()
  motion = preferences.snapshot(); apply(facts.setMotion(motion))
  const systemChanged = () => preferences.setSystemReduced(motionQuery?.matches === true)
  motionQuery?.addEventListener('change', systemChanged)
  const syncVisibility = () => {
    const next = isActive()
    if (active === next) return
    if (next) for (const stream of ['presence', 'attention', 'terminal', 'converse']) reobserve.add(stream)
    active = next
    preferences.refresh()
    apply(facts.setActive(active))
  }
  const observer = new MutationObserver(syncVisibility)
  // The pane itself is what switchPane toggles; ancestors cover a hidden dashboard.
  for (let el = root; el; el = /** @type {HTMLElement} */ (el.parentElement)) observer.observe(el, { attributes: true, attributeFilter: ['hidden', 'data-now', 'data-mode'] })
  doc.addEventListener('visibilitychange', syncVisibility)
  const storageChanged = (/** @type {StorageEvent} */ event) => {
    if (event.key !== MOTION_STORAGE_KEY && event.key !== null) return
    // Re-read the validated deadline without extending it or writing back to another window.
    preferences.destroy(); preferences = readPreferences()
    applyMotion(preferences.snapshot())
  }
  view?.addEventListener('storage', storageChanged)
  const reveal = () => { if (!destroyed && pet) { stage.hidden = false; button.dataset.runtime = 'ready' } }
  img.addEventListener('load', reveal)
  const ready = createPet({ stage, img, props }, { manifestUrl: './assets/pet/cc-v1/manifest.json', ...petOptions, reducedMotion: motion.reducedMotion }).then(value => {
    if (destroyed || value.warnings.some(w => w.startsWith('manifest:'))) { value.destroy(); stage.remove(); return null }
    pet = value
    offMachine = pet.machine.subscribe(s => { stage.dataset.form = s.targetForm ?? s.form; stage.dataset.behavior = s.behavior })
    // Asset latency cannot turn facts observed during loading into a performance.
    apply({ ...facts.current(), align: true })
    const s = pet.machine.snapshot(); stage.dataset.form = s.form; stage.dataset.behavior = s.behavior
    if (img.complete && img.naturalWidth > 0) reveal()
    return pet
  }).catch(() => { if (!destroyed) stage.remove(); return null })
  /** @param {string} stream @param {()=>HeroUpdate} read @param {boolean} [fresh] */
  const observe = (stream, read, fresh = true) => {
    syncVisibility()
    const update = read()
    // Errors and current permission facts remain usable during reobservation.
    if (reobserve.has(stream)) update.intent = { ...update.intent, oneShots: update.intent.oneShots.filter(b => b === 'error') }
    apply(update)
    preferences.refresh()
    if (fresh) reobserve.delete(stream)
  }
  return {
    ready,
    // Consume before expiry, and release only this stream's baseline afterward.
    /** @param {import('../presence-poller.js').Presence|null} p */
    setPresence(p) { observe('presence', () => facts.presence(p), !!p && p.presence !== 'down') },
    /** @param {import('./workbench-attention.js').AttentionState|null} state */
    setAttention(state) { observe('attention', () => facts.attention(state), !!state && !state.stale) },
    /** @param {Array<{id:string,hash?:string|null}>} rows */
    setTerminal(rows) { observe('terminal', () => facts.terminal(rows)) },
    /** @param {Array<{id:number,role:string,pending?:boolean}>} msgs */
    setConverse(msgs) { observe('converse', () => facts.converse(msgs)) },
    destroy() {
      destroyed = true; offMachine?.(); pet?.destroy(); preferences.destroy(); observer.disconnect()
      doc.removeEventListener('visibilitychange', syncVisibility); motionQuery?.removeEventListener('change', systemChanged)
      view?.removeEventListener('storage', storageChanged); img.removeEventListener('load', reveal)
      stage.remove(); delete button.dataset.runtime; delete button.dataset.motion
    },
  }
}
