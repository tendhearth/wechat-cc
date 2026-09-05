// @ts-check
// manifest-loader.js — 资产包的唯一视觉索引(spec 2026-09-05-cc-desktop-pet §3)。
// 接受两种形状:v1 扁平(states 全是 lit,canonical 两张 master)与 forms 嵌套。
// 归一后业务层只认 forms[form].states[behavior] / transitions / props。
// 两级校验:无法解析 → ok:false;可降级缺失 → 丢掉那一项 + warning。纯函数,不碰 DOM。

/** @typedef {{ frames: string[], fps: number, loop: boolean, next: string | null }} Animation */
/** @typedef {{ master: string, states: Record<string, Animation> }} FormAssets */
/** @typedef {{ canvas: { width: number, height: number, anchor: [number, number] }, forms: { unlit: FormAssets, lit: FormAssets }, transitions: Record<string, Animation>, props: Record<string, string>, warnings: string[] }} PetManifest */

const DEFAULT_FPS = 4

/** @param {unknown} v */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** @param {string} baseUrl @param {string} p */
function resolvePath(baseUrl, p) {
  if (!baseUrl || /^(https?:|data:|\/|[a-zA-Z]:)/.test(p)) return p
  return `${baseUrl.replace(/\/+$/, '')}/${p.replace(/^\.?\//, '')}`
}

/**
 * @param {unknown} raw
 * @param {string} baseUrl
 * @param {string[]} warnings
 * @param {string} label   // 'lit/blink' / 'transition/unlit-to-lit',只用于 warning
 * @returns {Animation | null}
 */
function normalizeAnimation(raw, baseUrl, warnings, label) {
  if (!isObj(raw)) { warnings.push(`state_invalid:${label}`); return null }
  const o = /** @type {Record<string, unknown>} */ (raw)
  const frames = Array.isArray(o.frames) ? o.frames.filter((f) => typeof f === 'string' && f.length > 0).map((f) => resolvePath(baseUrl, /** @type {string} */ (f))) : []
  if (frames.length === 0) { warnings.push(`state_empty:${label}`); return null }
  const fps = typeof o.fps === 'number' && Number.isFinite(o.fps) && o.fps > 0 ? o.fps : DEFAULT_FPS
  const loop = o.loop === true
  const next = loop ? null : (typeof o.next === 'string' && o.next.length > 0 ? o.next : 'idle')
  return { frames, fps, loop, next }
}

/**
 * @param {unknown} rawStates
 * @param {string} baseUrl
 * @param {string[]} warnings
 * @param {string} form
 */
function normalizeStates(rawStates, baseUrl, warnings, form) {
  /** @type {Record<string, Animation>} */
  const out = {}
  if (!isObj(rawStates)) return out
  for (const [name, raw] of Object.entries(/** @type {Record<string, unknown>} */ (rawStates))) {
    const a = normalizeAnimation(raw, baseUrl, warnings, `${form}/${name}`)
    if (a) out[name] = a
  }
  return out
}

/** @param {unknown} rawCanvas @returns {{ width: number, height: number, anchor: [number, number] } | null} */
function normalizeCanvas(rawCanvas) {
  if (!isObj(rawCanvas)) return null
  const c = /** @type {Record<string, unknown>} */ (rawCanvas)
  const width = typeof c.width === 'number' && c.width > 0 ? c.width : 0
  const height = typeof c.height === 'number' && c.height > 0 ? c.height : 0
  if (!width || !height) return null
  /** @type {[number, number]} */
  let anchor = [0.5, 0.9]
  const a = c.anchor
  if (Array.isArray(a) && a.length === 2 && a.every((n) => typeof n === 'number')) {
    const [x, y] = /** @type {[number, number]} */ (a)
    anchor = x > 1 || y > 1 ? [x / width, y / height] : [x, y]
  } else if (isObj(a)) {
    const o = /** @type {{ x?: unknown, y?: unknown }} */ (a)
    if (typeof o.x === 'number' && typeof o.y === 'number') anchor = o.x > 1 || o.y > 1 ? [o.x / width, o.y / height] : [o.x, o.y]
  }
  return { width, height, anchor }
}

/**
 * @param {unknown} raw
 * @param {string} [baseUrl]
 * @returns {{ ok: true, manifest: PetManifest } | { ok: false, reason: string }}
 */
export function normalizeManifest(raw, baseUrl = '') {
  if (!isObj(raw)) return { ok: false, reason: 'not_object' }
  const r = /** @type {Record<string, unknown>} */ (raw)
  const canvas = normalizeCanvas(r.canvas)
  if (!canvas) return { ok: false, reason: 'no_canvas' }
  /** @type {string[]} */
  const warnings = []
  const canonical = isObj(r.canonical) ? /** @type {Record<string, unknown>} */ (r.canonical) : {}
  const canonicalOf = (/** @type {string} */ form) => typeof canonical[form] === 'string' ? resolvePath(baseUrl, /** @type {string} */ (canonical[form])) : null

  /** @type {Partial<Record<'unlit' | 'lit', FormAssets>>} */
  const forms = {}
  if (isObj(r.forms)) {
    for (const form of /** @type {const} */ (['unlit', 'lit'])) {
      const rf = /** @type {Record<string, unknown>} */ (r.forms)[form]
      if (!isObj(rf)) continue
      const states = normalizeStates(/** @type {Record<string, unknown>} */ (rf).states, baseUrl, warnings, form)
      const master = canonicalOf(form) ?? (typeof /** @type {Record<string, unknown>} */ (rf).master === 'string' ? resolvePath(baseUrl, /** @type {string} */ (/** @type {Record<string, unknown>} */ (rf).master)) : null) ?? states.idle?.frames[0] ?? null
      if (!master) { warnings.push(`form_no_master:${form}`); continue }
      forms[form] = { master, states }
    }
  } else if (isObj(r.states)) {
    // v1 扁平:states 全是 lit
    const states = normalizeStates(r.states, baseUrl, warnings, 'lit')
    const litMaster = canonicalOf('lit') ?? states.idle?.frames[0] ?? Object.values(states)[0]?.frames[0] ?? null
    if (litMaster) forms.lit = { master: litMaster, states }
    const unlitMaster = canonicalOf('unlit')
    if (unlitMaster) forms.unlit = { master: unlitMaster, states: { idle: { frames: [unlitMaster], fps: 1, loop: true, next: null } } }
  }
  if (!forms.lit && !forms.unlit) return { ok: false, reason: 'no_forms' }
  // 缺一边:用另一边的 master 顶上,逻辑上仍是两态,只是画面一样(warning 让人知道)
  if (!forms.lit) { const other = /** @type {FormAssets} */ (forms.unlit); warnings.push('form_missing:lit'); forms.lit = { master: other.master, states: { idle: { frames: [other.master], fps: 1, loop: true, next: null } } } }
  if (!forms.unlit) { const other = /** @type {FormAssets} */ (forms.lit); warnings.push('form_missing:unlit'); forms.unlit = { master: other.master, states: { idle: { frames: [other.master], fps: 1, loop: true, next: null } } } }

  /** @type {Record<string, Animation>} */
  const transitions = {}
  if (isObj(r.transitions)) {
    for (const [name, raw2] of Object.entries(/** @type {Record<string, unknown>} */ (r.transitions))) {
      const a = normalizeAnimation(raw2, baseUrl, warnings, `transition/${name}`)
      if (a) transitions[name] = a
    }
  }
  /** @type {Record<string, string>} */
  const props = {}
  if (isObj(r.props)) {
    for (const [name, p] of Object.entries(/** @type {Record<string, unknown>} */ (r.props))) if (typeof p === 'string' && p) props[name] = resolvePath(baseUrl, p)
  }
  return { ok: true, manifest: { canvas, forms: /** @type {{ unlit: FormAssets, lit: FormAssets }} */ (forms), transitions, props, warnings } }
}

/**
 * @param {string} url
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: true, manifest: PetManifest } | { ok: false, reason: string }>}
 */
export async function loadManifest(url, fetchImpl = fetch) {
  let res
  try { res = await fetchImpl(url) } catch { return { ok: false, reason: 'fetch_failed' } }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` }
  let raw
  try { raw = await res.json() } catch { return { ok: false, reason: 'not_json' } }
  const baseUrl = url.includes('/') ? url.slice(0, url.lastIndexOf('/')) : ''
  return normalizeManifest(raw, baseUrl)
}
