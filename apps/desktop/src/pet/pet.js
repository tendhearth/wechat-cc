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

const BREATHING_BEHAVIORS = new Set(['idle', 'working', 'thinking', 'permission', 'companion', 'sleep'])
/** 一次性行为在没有专属帧的形态下(v1 的 unlit)露多久就回落。 */
const ONE_SHOT_FALLBACK_MS = 600

/**
 * @param {{ stage: any, img: any, props: any, hint?: any }} root
 * @param {{ manifestUrl: string, fetchImpl?: typeof fetch, reducedMotion?: boolean, makeEl?: (tag: string) => any, schedule?: (fn: () => void, ms: number) => unknown, cancel?: (h: unknown) => void, preload?: (url: string) => void }} opts
 */
export async function createPet(root, opts) {
  const makeEl = opts.makeEl ?? ((/** @type {string} */ tag) => document.createElement(tag))
  const schedule = opts.schedule ?? ((/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms))
  const cancel = opts.cancel ?? ((/** @type {unknown} */ h) => clearTimeout(/** @type {any} */ (h)))
  /** @type {unknown} */ let oneShotTimer = null
  /** 转场里被挡下的一次性行为(setState 返回 'ignored'):转场落地后按顺序补播。 */
  /** @type {string[]} */
  const heldOneShots = []
  let hadTransition = false
  const renderer = createSpriteRenderer({ img: root.img, stage: root.stage, schedule, cancel, preload: opts.preload, reducedMotion: opts.reducedMotion })
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
    return { machine, warnings, setState: machine.setState, setForm: machine.setForm, setProps: machine.setProps, applyIntent: () => {}, setHint, beginDrag: machine.beginDrag, endDrag: machine.endDrag, destroy: () => { renderer.stop() } }
  }
  const manifest = loaded.manifest
  warn(...manifest.warnings)
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
  const onSnapshot = (/** @type {ReturnType<typeof machine.snapshot>} */ s) => {
    render(s)
    const wasTransitioning = hadTransition
    hadTransition = s.transition !== null
    // 转场落地:把转场期间被挡下的一次性行为补播回来(先清列表,补播会重入这里)
    if (wasTransitioning && !hadTransition && heldOneShots.length > 0) {
      for (const b of heldOneShots.splice(0, heldOneShots.length)) machine.setState(b)
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
      for (const b of intent.oneShots) {
        // 转场里一次性行为进不来(状态机让路给转场)。丢掉就等于「出了错但没人告诉你」——
        // 记下来,转场一落地就补播。
        if (machine.setState(b) === 'ignored' && machine.snapshot().transition !== null && !heldOneShots.includes(b)) heldOneShots.push(b)
      }
      setHint(intent.hint)
    },
    setHint,
    beginDrag: machine.beginDrag,
    endDrag: machine.endDrag,
    destroy() { off(); renderer.stop(); heldOneShots.length = 0; if (oneShotTimer !== null) { cancel(oneShotTimer); oneShotTimer = null } },
  }
}
