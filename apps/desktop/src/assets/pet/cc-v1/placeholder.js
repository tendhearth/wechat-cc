// @ts-check
// Normative VECTOR PLACEHOLDER, not approved production art. One geometry source
// for both materials, all generated frames, masks and the offline fallback.
export const CANVAS = Object.freeze({ width: 512, height: 512, anchor: [0.5, 470 / 512], baselinePx: 470, safeBboxPx: [80, 28, 432, 470] })
export const ANATOMY = Object.freeze({ feet: 2, eyes: 2, arms: 0, tails: 0, mouth: false, ears: 0, c_appendages: 1 })
export const VIEWS = Object.freeze(['front', 'three-quarter', 'side', 'back'])

/** Geometry is shared across forms. Hidden eyes remain anatomical eyes in back view. */
export function geometry(view = 'front', expression = 'idle', mask = false) {
  const side = view === 'side', quarter = view === 'three-quarter', back = view === 'back'
  const rx = side ? 132 : 152
  const feet = side ? [185, 301] : [170, 342]
  const eyeX = side ? [350, 369] : quarter ? [293, 351] : [225, 301]
  const closed = expression === 'sleep' || expression === 'blink-closed'
  const half = expression === 'blink-half'
  const h = closed ? 4 : half ? 18 : 40
  const look = expression === 'look' ? -10 : 0
  return `<g id="geometry">
<path data-part="c" d="M 230 224 C 194 203 190 164 208 125 C 226 85 257 65 294 78" fill="none" stroke="${mask ? 'white' : 'url(#material)'}" stroke-width="54" stroke-linecap="round"/>
<ellipse data-part="body" cx="256" cy="327" rx="${rx}" ry="129" fill="${mask ? 'white' : 'url(#material)'}"/>
${feet.map((x, i) => `<ellipse data-part="foot-${i + 1}" cx="${x}" cy="451" rx="31" ry="19" fill="${mask ? 'white' : 'url(#material)'}"/>`).join('\n')}
${mask ? '' : eyeX.map((x, i) => `<rect data-part="eye-${i + 1}" x="${x + look - 7}" y="${342 - h / 2}" width="14" height="${h}" rx="7" fill="currentColor" opacity="${back ? 0 : 1}"/>`).join('\n')}
</g>`
}

/** Material-only interpolation. No geometry cross-fade/double character. */
export function placeholderSvg(form = 'unlit', view = 'front', expression = 'idle', mix = form === 'lit' ? 1 : 0, mask = false) {
  const t = Math.max(0, Math.min(1, mix))
  /** @param {number[]} a @param {number[]} b */
  const blend = (a, b) => '#' + a.map((v, i) => Math.round(v + ((b[i] ?? v) - v) * t).toString(16).padStart(2, '0')).join('')
  const top = blend([39, 39, 39], [255, 247, 230])
  const bottom = blend([26, 26, 26], [234, 221, 196])
  const eye = blend([255, 247, 230], [21, 20, 18])
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" color="${eye}">
<title>CC v1 normative placeholder — ${form}/${view}/${expression}; NOT final art</title>
<defs><linearGradient id="material" x2="0" y2="1"><stop stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
${mask ? '' : '<g id="contact-shadow"><ellipse cx="256" cy="466" rx="118" ry="4" fill="#191715" opacity="0.16"/></g>'}
${geometry(view, expression, mask)}
${mask ? '' : `<g id="self-light" opacity="${(0.065 * t).toFixed(4)}"><ellipse cx="248" cy="278" rx="93" ry="50" fill="#fffdf4"/></g><g id="rim"/>`}
</svg>\n`
}

/** Works even when every external image and manifest request fails. */
export function fallbackFrame(form = 'unlit') {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(placeholderSvg(form))}`
}

/** @returns {import('../../../pet/assets/manifest-loader.js').PetManifest} */
export function emergencyManifest() {
  /** @param {string} name */
  const form = (name) => {
    const master = fallbackFrame(name)
    return { master, states: { idle: { frames: [master], fps: 1, loop: true, next: null } } }
  }
  return { canvas: { width: 512, height: 512, anchor: /** @type {[number, number]} */ ([0.5, 470 / 512]) }, forms: { unlit: form('unlit'), lit: form('lit') }, transitions: {}, props: {}, warnings: [] }
}
