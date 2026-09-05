// @ts-check
// pet.js — 组装:loader → resolver → state machine → renderer + props(spec §7)。
// 业务代码只认这里导出的语义接口;帧文件名到此为止。
import { loadManifest } from './assets/manifest-loader.js'
import { resolveAnimation, resolveTransition } from './assets/animation-resolver.js'
import { createPetStateMachine } from './domain/state-machine.js'
import { ONE_SHOT } from './domain/types.js'
import { createSpriteRenderer } from './renderer/sprite-renderer.js'
import { renderProps } from './renderer/prop-layer.js'

/** @typedef {import('./bridge/presence-map.js').PetIntent} PetIntent */
/** @typedef {import('./domain/types.js').PetForm} PetForm */
/** @typedef {import('./assets/manifest-loader.js').Animation} Animation */

const BREATHING_BEHAVIORS = new Set(['idle', 'working', 'thinking', 'permission', 'companion', 'sleep'])
/** 一次性行为在没有专属帧的形态下(v1 的 unlit)露多久就回落。 */
const ONE_SHOT_FALLBACK_MS = 600
/** 空闲小动作的随机区间(spec §4):blink 6–12 s、look 25–60 s。 */
const BLINK_MIN_MS = 6_000, BLINK_SPAN_MS = 6_000
const LOOK_MIN_MS = 25_000, LOOK_SPAN_MS = 35_000
/** 只有「什么也没在发生」的画面才排空闲小动作。 */
const CALM_BEHAVIORS = new Set(['idle', 'companion'])

/**
 * @param {{ stage: any, img: any, props: any, hint?: any }} root
 * @param {{ manifestUrl: string, fetchImpl?: typeof fetch, reducedMotion?: boolean, makeEl?: (tag: string) => any, schedule?: (fn: () => void, ms: number) => unknown, cancel?: (h: unknown) => void, preload?: (url: string) => void, random?: () => number }} opts
 */
export async function createPet(root, opts) {
  const makeEl = opts.makeEl ?? ((/** @type {string} */ tag) => document.createElement(tag))
  const schedule = opts.schedule ?? ((/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms))
  const cancel = opts.cancel ?? ((/** @type {unknown} */ h) => clearTimeout(/** @type {any} */ (h)))
  const random = opts.random ?? Math.random
  /** @type {unknown} */ let oneShotTimer = null
  /** @type {unknown} */ let blinkTimer = null
  /** @type {unknown} */ let lookTimer = null
  /** 被挡下的一次性行为(setState 返回 'ignored':转场 / 拖动 / 让位给更高优先级的那次)。 */
  /** @type {string[]} */
  const heldOneShots = []
  // renderer 在 manifest 到手之前就建好了(它只管画),坏帧回调先挂个空的,加载完再接上。
  /** @type {(url: string) => void} */
  let onFrameError = () => {}
  const renderer = createSpriteRenderer({ img: root.img, stage: root.stage, schedule, cancel, preload: opts.preload, reducedMotion: opts.reducedMotion, onFrameError: (url) => onFrameError(url) })
  const machine = createPetStateMachine()
  /** @type {string[]} */
  const warnings = []
  const warn = (/** @type {string[]} */ ...ws) => { for (const w of ws) if (!warnings.includes(w)) { warnings.push(w); console.warn('[pet]', w) } }

  const setHint = (/** @type {string | null} */ text) => {
    if (!root.hint) return
    root.hint.textContent = text ?? ''
    root.hint.hidden = !text
  }

  const loaded = await loadManifest(opts.manifestUrl, opts.fetchImpl)
  if (!loaded.ok) {
    warn(`manifest:${loaded.reason}`)
    setHint('桌宠资产没加载出来')
    // 没有 manifest:状态机照常工作(逻辑状态仍真实),只是画不出来
    return { machine, warnings, setState: machine.setState, setForm: machine.setForm, setProps: machine.setProps, applyIntent: () => {}, setHint, beginDrag: machine.beginDrag, endDrag: machine.endDrag, reportFrameError: () => {}, destroy: () => { renderer.stop() } }
  }
  // 坏帧要就地从帧表里摘掉,所以拿一份深拷贝,不动 loader 的返回值。
  const manifest = structuredClone(loaded.manifest)
  warn(...loaded.manifest.warnings)
  renderer.applyAnchor(manifest.canvas.anchor)
  setHint(null)

  /** 上一次画的是什么,避免同一快照重复 play / 重建道具 */
  let lastKey = ''
  let lastPropsKey = ''
  const render = (/** @type {ReturnType<typeof machine.snapshot>} */ s) => {
    const propsKey = `${s.badge}|${s.props.join(',')}`
    if (propsKey !== lastPropsKey) { lastPropsKey = propsKey; renderProps(root.props, s.props, s.badge, manifest, makeEl) }
    const key = s.transition ? `t:${s.transition}` : `b:${s.form}/${s.behavior}`
    if (key === lastKey) return
    lastKey = key
    // 画的东西换了:上一个一次性行为的兜底回落不再有意义(它只对 lastKey 那次有效)
    if (oneShotTimer !== null) { cancel(oneShotTimer); oneShotTimer = null }
    if (s.transition && s.targetForm) {
      renderer.setBreathing(false)
      const t = resolveTransition(manifest, s.transition, s.targetForm)
      warn(...t.warnings)
      if (t.kind === 'frames') renderer.play(t.animation, { onEnd: () => machine.notifyAnimationEnded() })
      else renderer.fadeTo(t.to, { onEnd: () => machine.notifyAnimationEnded() })
      return
    }
    const r = resolveAnimation(manifest, s.form, s.behavior)
    warn(...r.warnings)
    renderer.setBreathing(BREATHING_BEHAVIORS.has(s.behavior))
    const oneShot = ONE_SHOT.has(s.behavior)
    if (oneShot && r.animation.loop) {
      // 一次性行为被 fallback 成了 loop 动画(unlit 下只有 master):renderer 永远不会 onEnd,
      // 这里兜底 —— 露一下就回落,逻辑上这次一次性行为仍然「发生过」。
      renderer.play(r.animation)
      oneShotTimer = schedule(() => { oneShotTimer = null; machine.notifyAnimationEnded() }, ONE_SHOT_FALLBACK_MS)
      return
    }
    renderer.play(r.animation, { onEnd: oneShot || !r.animation.loop ? () => machine.notifyAnimationEnded() : undefined })
  }

  // ── 帧加载失败(404 / 坏文件):把那一帧从 manifest 里摘掉,重画(spec §3「跳过该帧」)。
  //    整条动画一帧不剩就连状态一起删掉,resolver 会自然回退到同形态 idle 并记一条 warning。
  /** 已经确认加载不出来的帧;不记着的话摘完重画又撞上同一张,会绕死。 */
  /** @type {Set<string>} */
  const badFrames = new Set()
  // 浏览器里 img.src 读回来是绝对 URL,manifest 里是相对路径 —— 按尾巴认。
  const isFrame = (/** @type {string} */ frame, /** @type {string} */ bad) => bad === frame || bad.endsWith(frame.replace(/^\.?\//, '/'))
  const dropFrame = (/** @type {Record<string, Animation>} */ animations, /** @type {string} */ bad) => {
    for (const [name, a] of Object.entries(animations)) {
      if (!a.frames.some((f) => isFrame(f, bad))) continue
      a.frames = a.frames.filter((f) => !isFrame(f, bad))
      if (a.frames.length === 0) delete animations[name]
    }
  }
  const reportFrameError = (/** @type {string} */ url) => {
    if (typeof url !== 'string' || !url || badFrames.has(url)) return
    badFrames.add(url)
    dropFrame(manifest.forms.unlit.states, url)
    dropFrame(manifest.forms.lit.states, url)
    dropFrame(manifest.transitions, url)
    warn(`frame_missing:${url}`)
    lastKey = ''                        // 帧表变了,同一个状态也得重画
    render(machine.snapshot())
  }
  onFrameError = reportFrameError

  // ── 空闲小动作(spec §4):idle / companion 且没有转场、没在拖时,随机眨眼 / 张望。
  //    它们不声称任何活动,所以不算撒谎;reduced-motion 下一律不排;
  //    当前形态没有自己的 blink / look 帧就别排 —— 回退成 idle 只会白白掐掉呼吸。
  const cancelIdleMoves = () => {
    if (blinkTimer !== null) { cancel(blinkTimer); blinkTimer = null }
    if (lookTimer !== null) { cancel(lookTimer); lookTimer = null }
  }
  const armIdleMoves = (/** @type {ReturnType<typeof machine.snapshot>} */ s) => {
    if (opts.reducedMotion) return
    if (s.transition !== null || !CALM_BEHAVIORS.has(s.behavior)) { cancelIdleMoves(); return }
    const states = manifest.forms[s.form]?.states ?? {}
    if (blinkTimer === null && states.blink) blinkTimer = schedule(() => { blinkTimer = null; machine.setState('blink') }, BLINK_MIN_MS + random() * BLINK_SPAN_MS)
    if (lookTimer === null && states.look) lookTimer = schedule(() => { lookTimer = null; machine.setState('look') }, LOOK_MIN_MS + random() * LOOK_SPAN_MS)
  }

  /** 一次性行为:进不去就记下来,等画面闲下来补播 —— 丢掉就等于「出了错但没人告诉你」。 */
  const requestOneShot = (/** @type {string} */ b) => {
    if (machine.setState(b) === 'ignored' && !heldOneShots.includes(b)) heldOneShots.push(b)
  }
  const onSnapshot = (/** @type {ReturnType<typeof machine.snapshot>} */ s) => {
    render(s)
    armIdleMoves(s)
    // 闲下来了(没转场、没在拖、没在播别的一次性行为):把欠的补播回来。
    // 先清列表,补播会重入这里。
    if (heldOneShots.length > 0 && s.transition === null && !ONE_SHOT.has(s.behavior)) {
      for (const b of heldOneShots.splice(0, heldOneShots.length)) requestOneShot(b)
    }
  }
  const off = machine.subscribe(onSnapshot)
  onSnapshot(machine.snapshot())

  return {
    machine, warnings,
    setState: machine.setState,
    setForm: machine.setForm,
    setProps: machine.setProps,
    /** @param {PetIntent} intent */
    applyIntent(intent) {
      machine.setForm(intent.form)
      machine.setProps(intent.props, intent.badge)
      machine.setState(intent.behavior)
      for (const b of intent.oneShots) requestOneShot(b)
      setHint(intent.hint)
    },
    setHint,
    beginDrag: machine.beginDrag,
    endDrag: machine.endDrag,
    /** 某一帧图片加载失败(renderer 的 img error 会自动喂进来,也可以手动报)。 */
    reportFrameError,
    destroy() { off(); renderer.stop(); heldOneShots.length = 0; cancelIdleMoves(); if (oneShotTimer !== null) { cancel(oneShotTimer); oneShotTimer = null } },
  }
}
