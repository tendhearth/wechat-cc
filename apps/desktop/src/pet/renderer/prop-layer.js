// @ts-check
// prop-layer.js — 道具独立于主体渲染(spec §4)。manifest 没有道具偏移,这里用一张集中的槽位表:
// 槽位是相对 anchor 的比例偏移,不是逐帧 offset。改道具位置只改这张表。
import { isProp } from '../domain/types.js'

/** @typedef {import('../assets/manifest-loader.js').PetManifest} PetManifest */
/** @typedef {import('../domain/types.js').PetProp} PetProp */
/** @typedef {'above-head' | 'beside-right' | 'in-front'} Slot */

/** 以舞台边长为 1;dx 向右为正,dy 向上为负(相对 anchor 点)。 */
/** @type {Readonly<Record<Slot, { dx: number, dy: number, scale: number }>>} */
export const SLOTS = Object.freeze({
  'above-head': { dx: 0.22, dy: -0.66, scale: 0.34 },
  'beside-right': { dx: 0.36, dy: -0.26, scale: 0.34 },
  'in-front': { dx: 0.02, dy: -0.12, scale: 0.40 },
})

/** @type {Readonly<Record<PetProp, Slot>>} */
export const PROP_SLOTS = Object.freeze({
  'micro-light': 'above-head',
  sprout: 'above-head',
  'speech-bubble': 'above-head',
  'thought-bubble': 'above-head',
  exclamation: 'above-head',
  envelope: 'beside-right',
  mug: 'beside-right',
  laptop: 'in-front',
})

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
    const slot = SLOTS[PROP_SLOTS[name]]
    const wrap = makeEl('div')
    wrap.classList.add('pet-prop')
    wrap.setAttribute('data-prop', name)
    wrap.style['--slot-dx'] = String(slot.dx)
    wrap.style['--slot-dy'] = String(slot.dy)
    wrap.style['--slot-scale'] = String(slot.scale)
    const img = makeEl('img')
    img.src = src
    img.setAttribute('alt', '')
    img.setAttribute('aria-hidden', 'true')
    wrap.appendChild(img)
    if (name === 'envelope' && badge > 0) {
      const b = makeEl('span')
      b.classList.add('pet-badge')
      b.textContent = String(badge)
      wrap.appendChild(b)
    }
    nodes.push(wrap)
  }
  container.replaceChildren(...nodes)
}
