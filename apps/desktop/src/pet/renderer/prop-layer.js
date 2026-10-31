// @ts-check
// prop-layer.js — 道具独立于主体渲染(spec §4)。manifest 没有道具偏移,这里用一张集中的槽位表:
// 槽位是相对 anchor 的比例偏移,不是逐帧 offset。改道具位置只改这张表。
import { isProp } from '../domain/types.js'

/** @typedef {import('../assets/manifest-loader.js').PetManifest} PetManifest */
/** @typedef {import('../domain/types.js').PetProp} PetProp */
/** @typedef {'above-head' | 'above-left' | 'beside-right' | 'in-front'} Slot */

/** 以舞台边长为 1;dx 向右为正,dy 向上为负(相对 anchor 点)。 */
/** @type {Readonly<Record<Slot, { dx: number, dy: number, scale: number }>>} */
export const SLOTS = Object.freeze({
  'above-head': { dx: 0.28, dy: -0.68, scale: 0.32 },
  // Keep the luminous stars left of the taller C, separate from permission.
  'above-left': { dx: -0.26, dy: -0.67, scale: 0.30 },
  'beside-right': { dx: 0.30, dy: -0.24, scale: 0.32 },
  'in-front': { dx: 0.01, dy: -0.04, scale: 0.34 },
})

/** @type {Readonly<Record<PetProp, Slot>>} */
export const PROP_SLOTS = Object.freeze({
  'micro-light': 'above-left',
  sprout: 'above-head',
  'speech-bubble': 'above-head',
  'thought-bubble': 'above-head',
  exclamation: 'above-head',
  envelope: 'beside-right',
  mug: 'beside-right',
  laptop: 'in-front',
})

export const PROP_FADE_MS = 160
/** @type {Readonly<Record<string, readonly PetProp[]>>} */
const BEHAVIOR_PROPS = Object.freeze({
  working: ['laptop'], thinking: ['thought-bubble', 'mug'], permission: ['exclamation'],
  receive: ['envelope'], look: ['micro-light'],
})

/** Facts own their slots; decorate only the behavior selected by the state machine.
 * @param {string} behavior @param {string[]} facts @param {{decorative: boolean}} options */
export function composeProps(behavior, facts, { decorative }) {
  const result = [...new Set(facts.filter(isProp).filter(name => decorative || name !== 'micro-light'))]
  const occupied = new Set(result.map(name => PROP_SLOTS[name]))
  for (const name of BEHAVIOR_PROPS[behavior] ?? []) {
    if ((!decorative && name === 'micro-light') || occupied.has(PROP_SLOTS[name])) continue
    result.push(name); occupied.add(PROP_SLOTS[name])
  }
  return result
}

/** @param {PetProp} name @param {number} badge @param {PetManifest} manifest @param {(tag:string)=>any} makeEl */
function propNode(name, badge, manifest, makeEl) {
  const slot = SLOTS[PROP_SLOTS[name]], wrap = makeEl('div')
  wrap.classList.add('pet-prop'); wrap.setAttribute('data-prop', name)
  wrap.style.setProperty('--slot-dx', String(slot.dx)); wrap.style.setProperty('--slot-dy', String(slot.dy)); wrap.style.setProperty('--slot-scale', String(slot.scale))
  const img = makeEl('img'); img.src = manifest.props[name]
  img.setAttribute('alt', ''); img.setAttribute('aria-hidden', 'true'); wrap.appendChild(img)
  const entry = { node: wrap, image: img, badge: /** @type {any} */ (null), timer: /** @type {unknown} */ (null), leaving: false }
  updateBadge(entry, name, badge, makeEl)
  return entry
}
/** @param {any} parent @param {any} child */
function removeChild(parent, child) {
  if (typeof parent.removeChild === 'function') parent.removeChild(child)
  else parent.replaceChildren(...Array.from(parent.children).filter(node => node !== child))
}
/** @param {ReturnType<typeof propNode>} entry @param {string} name @param {number} value @param {(tag:string)=>any} makeEl */
function updateBadge(entry, name, value, makeEl) {
  if (name !== 'envelope') return
  const count = Math.max(0, Math.trunc(Number(value) || 0))
  if (!count) { if (entry.badge) removeChild(entry.node, entry.badge); entry.badge = null; return }
  if (!entry.badge) { entry.badge = makeEl('span'); entry.badge.classList.add('pet-badge'); entry.node.appendChild(entry.badge) }
  entry.badge.textContent = String(count)
}

/**
 * @param {{ replaceChildren(...c: any[]): void }} container
 * @param {string[]} props
 * @param {number} badge
 * @param {PetManifest} manifest
 * @param {(tag: string) => any} makeEl
 */
export function renderProps(container, props, badge, manifest, makeEl) {
  /** @type {any[]} */
  const nodes = []
  for (const name of props) {
    if (!isProp(name)) continue
    const src = manifest.props[name]
    if (!src) continue
    nodes.push(propNode(name, badge, manifest, makeEl).node)
  }
  container.replaceChildren(...nodes)
}

/** Runtime owns stable nodes; static tools above remain immediate.
 * @param {{container:any, manifest:PetManifest, makeEl:(tag:string)=>any, schedule:(fn:()=>void,ms:number)=>unknown, cancel:(handle:unknown)=>void}} deps */
export function createPropRenderer({ container, manifest, makeEl, schedule, cancel }) {
  /** @type {Map<PetProp, ReturnType<typeof propNode>>} */ const entries = new Map()
  let suppressed = false, disposed = false
  const clear = (/** @type {ReturnType<typeof propNode>} */ entry) => { if (entry.timer !== null) { cancel(entry.timer); entry.timer = null } }
  const drop = (/** @type {PetProp} */ name, /** @type {ReturnType<typeof propNode>} */ entry) => {
    clear(entry); removeChild(container, entry.node); entries.delete(name)
  }
  return {
    /** @param {string[]} props @param {number} badge */
    render(props, badge) {
      if (disposed) return
      const desired = new Set(props.filter(isProp).filter(name => manifest.props[name]))
      for (const [name, entry] of entries) {
        updateBadge(entry, name, badge, makeEl)
        if (desired.has(name)) continue
        if (suppressed) { drop(name, entry); continue }
        if (entry.leaving) continue
        entry.leaving = true; entry.node.setAttribute('data-prop-leaving', 'true'); entry.node.style.setProperty('opacity', '0')
        entry.timer = schedule(() => { entry.timer = null; if (!disposed && entry.leaving && entries.get(name) === entry) drop(name, entry) }, PROP_FADE_MS)
      }
      for (const name of desired) {
        let entry = entries.get(name)
        if (!entry) {
          entry = propNode(name, badge, manifest, makeEl); entries.set(name, entry)
          if (!suppressed) { entry.node.classList.add('pet-prop-motion'); entry.node.style.setProperty('opacity', '0') }
          container.appendChild(entry.node)
          // Establish only this new node's initial style. Subsequent changes use
          // the existing CSS transition, including a reversal halfway through.
          if (!suppressed) entry.node.getBoundingClientRect?.()
        }
        clear(entry); entry.leaving = false; entry.node.setAttribute('data-prop-leaving', 'false')
        entry.node.style.setProperty('opacity', '1'); updateBadge(entry, name, badge, makeEl)
      }
    },
    /** @param {boolean} on */
    setMotionSuppressed(on) {
      if (disposed || suppressed === on) return
      suppressed = on
      for (const [name, entry] of entries) {
        if (on && entry.leaving) { drop(name, entry); continue }
        if (on) { clear(entry); entry.node.classList.remove('pet-prop-motion'); entry.node.style.setProperty('opacity', '1') }
        else entry.node.classList.add('pet-prop-motion')
      }
    },
    destroy() { if (disposed) return; disposed = true; for (const [name, entry] of entries) drop(name, entry) },
  }
}
