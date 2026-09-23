// @ts-check
// sprite-renderer.js — 只管按 resolved animation 换帧、fps、loop、anchor、呼吸、淡出淡入(spec §4)。
// DOM 与计时器都是注入的,所以能在没有 jsdom 的测试里跑。不认识 behavior,不认识文件名的含义。

/** @typedef {import('../assets/manifest-loader.js').Animation} Animation */
/** @typedef {{ style: { setProperty(name: string, value: string): void, [k: string]: unknown }, classList: { add(c: string): void, remove(c: string): void, contains(c: string): boolean }, setAttribute(k: string, v: string): void, getAttribute(k: string): string | null, src?: string, addEventListener?: (type: string, fn: () => void) => void }} ElLike */

const DEFAULT_FADE_MS = 240
/** 行为切换的交叉淡化:上一帧留在 ghost 上淡出这么久。短于最快的帧步(8fps = 125ms)之外还要让人看得见。 */
export const CROSSFADE_MS = 160

/**
 * @param {{
 *   img: ElLike, stage: ElLike, ghost?: ElLike,
 *   schedule?: (fn: () => void, ms: number) => unknown, cancel?: (h: unknown) => void,
 *   reducedMotion?: boolean, fadeMs?: number, preload?: (url: string) => void,
 *   onFrameError?: (url: string) => void,
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
  /** @type {unknown} */ let ghostTimer = null
  let ghostFlip = false

  // 交叉淡化(spec §4「小动作用变换,不变形」的补充):每个行为只有一张静态帧,working → thinking
  // 这种切换 C 会一帧跳过去。把上一帧放到 ghost 上淡出 160ms,两帧实体 mask 相同、只有 C 不同,
  // 看起来就是柔和的形变。只在**新动画开始**时做,不在序列内逐帧做(眨眼 8fps 不该糊成一团)。
  // 两个类名交替使用:同名 animation 不会重启,换名字才会。reduced motion 下不做(硬切)。
  const crossfade = (/** @type {string} */ prev) => {
    const g = deps.ghost
    if (!g || reduced) return
    if (ghostTimer !== null) { cancel(ghostTimer); ghostTimer = null }
    g.src = prev
    ghostFlip = !ghostFlip
    g.classList.remove(ghostFlip ? 'pet-ghost-out-b' : 'pet-ghost-out-a')
    g.classList.add(ghostFlip ? 'pet-ghost-out-a' : 'pet-ghost-out-b')
    ghostTimer = schedule(() => { ghostTimer = null; g.classList.remove('pet-ghost-out-a'); g.classList.remove('pet-ghost-out-b') }, CROSSFADE_MS)
  }

  /** 某一帧加载不出来:renderer 不认识文件名的含义,只把 url 报上去,由 pet.js 决定怎么摘。 */
  const reportFrameError = (/** @type {string} */ url) => { if (url) deps.onFrameError?.(url) }
  // 真浏览器里坏帧走 img 的 error 事件;测试桩没有 addEventListener,就手动调 reportFrameError。
  deps.img.addEventListener?.('error', () => { reportFrameError(deps.img.src ?? '') })

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
    const prev = frame
    if (prev && prev !== frames[0]) crossfade(prev)
    show(/** @type {string} */ (frames[0]))
    if (frames.length === 1 && a.loop) return
    // reduced motion:一次性多帧动画只显示首末两帧(硬切,不做 cross-fade),时长不变
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
      // 自定义属性只能走 setProperty:style['--x'] = v 在真实 CSSStyleDeclaration 上是静默 no-op,
      // 之前所有道具因此全部落在默认值(anchor 点 = 脚底)。写成无单位比例,CSS 里再乘舞台边长。
      deps.stage.style.setProperty('--pet-anchor-x', String(anchor[0]))
      deps.stage.style.setProperty('--pet-anchor-y', String(anchor[1]))
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
        frame = null                      // 淡出已经把画面清空,新帧不该再跟一张 ghost 交叉
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
    /** @param {string} url */
    reportFrameError(url) { reportFrameError(url) },
    stop() { generation += 1; clear(); if (ghostTimer !== null) { cancel(ghostTimer); ghostTimer = null } },
    currentFrame() { return frame },
  }
}
