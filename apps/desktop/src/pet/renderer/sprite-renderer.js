// @ts-check
// sprite-renderer.js — 只管按 resolved animation 换帧、fps、loop、anchor、呼吸、淡出淡入(spec §4)。
// DOM 与计时器都是注入的,所以能在没有 jsdom 的测试里跑。不认识 behavior,不认识文件名的含义。

/** @typedef {import('../assets/manifest-loader.js').Animation} Animation */
/** @typedef {{ style: Record<string, string>, classList: { add(c: string): void, remove(c: string): void, contains(c: string): boolean }, setAttribute(k: string, v: string): void, getAttribute(k: string): string | null, src?: string }} ElLike */

const DEFAULT_FADE_MS = 240

/**
 * @param {{
 *   img: ElLike, stage: ElLike,
 *   schedule?: (fn: () => void, ms: number) => unknown, cancel?: (h: unknown) => void,
 *   reducedMotion?: boolean, fadeMs?: number, preload?: (url: string) => void,
 * }} deps
 */
export function createSpriteRenderer(deps) {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = deps.cancel ?? ((h) => clearTimeout(/** @type {any} */ (h)))
  const reduced = deps.reducedMotion === true
  const fadeMs = deps.fadeMs ?? DEFAULT_FADE_MS
  const preload = deps.preload ?? ((url) => { try { const i = new Image(); i.src = url } catch { /* 非浏览器环境 */ } })
  /** @type {Set<string>} */
  const preloaded = new Set()
  /** @type {unknown} */ let timer = null
  /** @type {unknown} */ let fadeIn = null      // 淡入结束的计时器,与帧计时器分开持有
  /** @type {string | null} */ let frame = null
  let generation = 0

  const clear = () => { if (timer !== null) { cancel(timer); timer = null } if (fadeIn !== null) { cancel(fadeIn); fadeIn = null } deps.img.classList.remove('pet-fading') }
  /** @param {string} url */
  const show = (url) => { frame = url; deps.img.src = url }

  /**
   * @param {Animation} a
   * @param {(() => void) | undefined} onEnd
   */
  function run(a, onEnd) {
    clear()
    const gen = ++generation
    for (const f of a.frames) if (!preloaded.has(f)) { preloaded.add(f); preload(f) }
    const frames = a.frames.length ? a.frames : [frame ?? '']
    const stepMs = Math.max(16, Math.round(1000 / (a.fps > 0 ? a.fps : 1)))
    let i = 0
    show(/** @type {string} */ (frames[0]))
    if (frames.length === 1 && a.loop) return
    // reduced motion:一次性多帧动画只显示首末帧,时长不变(给 CSS cross-fade 留时间)
    if (reduced && !a.loop && frames.length > 1) {
      timer = schedule(() => { if (gen !== generation) return; timer = null; show(/** @type {string} */ (frames[frames.length - 1])); onEnd?.() }, stepMs * frames.length)
      return
    }
    const step = () => {
      if (gen !== generation) return
      i += 1
      if (i >= frames.length) {
        if (a.loop) { i = 0 } else { timer = null; onEnd?.(); return }
      }
      show(/** @type {string} */ (frames[i]))
      timer = schedule(step, stepMs)
    }
    timer = schedule(step, stepMs)
  }

  return {
    /** @param {[number, number]} anchor */
    applyAnchor(anchor) {
      deps.stage.style['--pet-anchor-x'] = `${anchor[0] * 100}%`
      deps.stage.style['--pet-anchor-y'] = `${anchor[1] * 100}%`
    },
    /** @param {Animation} a @param {{ onEnd?: () => void }} [opts] */
    play(a, opts = {}) { run(a, opts.onEnd) },
    /** @param {Animation} a @param {{ onEnd?: () => void }} [opts] */
    fadeTo(a, opts = {}) {
      clear()
      const gen = ++generation
      deps.img.classList.add('pet-fading')
      timer = schedule(() => {
        if (gen !== generation) return
        deps.img.classList.remove('pet-fading')
        run(a, undefined)                 // run() 会 clear(),所以 fadeIn 必须在它之后再排
        const gen2 = generation
        fadeIn = schedule(() => { if (gen2 !== generation) return; fadeIn = null; opts.onEnd?.() }, fadeMs)
      }, fadeMs)
    },
    /** @param {boolean} on */
    setBreathing(on) {
      if (on && !reduced) deps.stage.classList.add('pet-breathing')
      else deps.stage.classList.remove('pet-breathing')
    },
    stop() { generation += 1; clear() },
    currentFrame() { return frame },
  }
}
