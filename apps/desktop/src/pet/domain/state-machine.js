// @ts-check
// state-machine.js — CC 的状态机(spec §2):优先级、一次性 / 持续、转场、拖动、道具。
// 纯:不碰 DOM、不碰计时器。renderer 播完一次性动画 / 转场时调 notifyAnimationEnded()。
import { ONE_SHOT, PRIORITY, isBehavior, isForm, isProp } from './types.js'

/** @typedef {import('./types.js').PetForm} PetForm */
/** @typedef {import('./types.js').PetBehavior} PetBehavior */
/** @typedef {import('./types.js').PetTransition} PetTransition */
/** @typedef {{ form: PetForm, behavior: PetBehavior, transition: PetTransition | null, targetForm: PetForm | null, resting: PetBehavior, props: string[], badge: number }} PetSnapshot */

/**
 * @param {{ initialForm?: PetForm }} [opts]
 */
export function createPetStateMachine(opts = {}) {
  /** @type {PetForm} */ let form = isForm(opts.initialForm) ? opts.initialForm : 'unlit'
  /** @type {PetBehavior} */ let behavior = 'idle'
  /** @type {PetBehavior} */ let resting = 'idle'
  /** @type {PetTransition | null} */ let transition = null
  /** @type {PetForm | null} */ let targetForm = null
  /** @type {string[]} */ let props = []
  let badge = 0
  let dragging = false
  /** @type {Set<(s: PetSnapshot) => void>} */
  const subs = new Set()

  /** @returns {PetSnapshot} */
  const snapshot = () => ({ form, behavior, transition, targetForm, resting, props: [...props], badge })
  const notify = () => { const s = snapshot(); for (const cb of Array.from(subs)) { try { cb({ ...s, props: [...s.props] }) } catch (err) { console.error('pet subscriber threw', err) } } }

  /** 转场被更高优先级的东西打断:直接落到目标形态。 */
  const finishTransitionNow = () => { if (transition && targetForm) { form = targetForm } transition = null; targetForm = null }
  const playingOneShot = () => ONE_SHOT.has(behavior)

  return {
    snapshot,
    /** @param {(s: PetSnapshot) => void} cb */
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb) } },

    /** @param {PetForm} f */
    setForm(f) {
      if (!isForm(f)) return false
      if (transition) {
        if (targetForm === f) return false
        // 转到一半要求回去:结束当前转场留在原态,不再转
        transition = null; targetForm = null; notify(); return false
      }
      if (f === form) return false
      transition = f === 'lit' ? 'unlit-to-lit' : 'lit-to-unlit'
      targetForm = f
      notify()
      return true
    },

    /** @param {string} b @returns {'applied' | 'queued' | 'ignored'} */
    setState(b) {
      if (!isBehavior(b)) return 'ignored'
      const oneShot = ONE_SHOT.has(b)
      if (dragging) {
        if (oneShot) return 'ignored'
        if (resting !== b) { resting = b; notify() }
        return 'queued'
      }
      if (oneShot) {
        if (transition) return 'ignored'
        if (playingOneShot() && PRIORITY[behavior] > PRIORITY[b]) return 'ignored'
        behavior = b; notify(); return 'applied'
      }
      // 持续行为
      const changedResting = resting !== b
      resting = b
      if (transition) {
        if (PRIORITY[b] > PRIORITY.transition) { finishTransitionNow(); behavior = b; notify(); return 'applied' }
        if (changedResting) notify()
        return 'queued'
      }
      if (playingOneShot() && PRIORITY[behavior] > PRIORITY[b]) { if (changedResting) notify(); return 'queued' }
      if (behavior !== b) { behavior = b; notify() } else if (changedResting) notify()
      return 'applied'
    },

    /** @param {string[]} list @param {number} [b] */
    setProps(list, b = 0) {
      const next = Array.from(new Set((Array.isArray(list) ? list : []).filter(isProp)))
      const nextBadge = Math.max(0, Math.trunc(Number(b) || 0))
      const same = nextBadge === badge && next.length === props.length && next.every((p, i) => p === props[i])
      if (same) return
      props = next; badge = nextBadge; notify()
    },

    notifyAnimationEnded() {
      if (transition) { finishTransitionNow(); behavior = resting; notify(); return }
      if (dragging) return
      if (playingOneShot()) { behavior = resting; notify() }
    },

    beginDrag() {
      if (dragging) return
      dragging = true
      finishTransitionNow()
      behavior = 'drag'
      notify()
    },
    endDrag() {
      if (!dragging) return
      dragging = false
      behavior = resting
      notify()
    },
  }
}
