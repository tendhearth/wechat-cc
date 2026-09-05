// @ts-check
// animation-resolver.js — form + behavior + manifest → 动画(spec §3 的 fallback 链)。
// 业务层永远拿不到帧文件名;缺什么都有一条 warning,从不抛。纯函数。
import { isBehavior } from '../domain/types.js'

/** @typedef {import('./manifest-loader.js').PetManifest} PetManifest */
/** @typedef {import('./manifest-loader.js').Animation} Animation */
/** @typedef {import('../domain/types.js').PetForm} PetForm */
/** @typedef {import('../domain/types.js').PetTransition} PetTransition */

/** @param {string} master @returns {Animation} */
const masterLoop = (master) => ({ frames: [master], fps: 1, loop: true, next: null })

/**
 * @param {PetManifest} manifest
 * @param {PetForm} form
 * @param {string} behavior
 * @returns {{ animation: Animation, source: 'exact' | 'same-form-idle' | 'form-master' | 'lit-idle', warnings: string[] }}
 */
export function resolveAnimation(manifest, form, behavior) {
  /** @type {string[]} */
  const warnings = []
  let want = behavior
  if (!isBehavior(behavior)) { warnings.push(`unknown_behavior:${behavior}`); want = 'idle' }
  const f = manifest.forms[form]
  const exact = f?.states[want]
  if (exact && want === behavior) return { animation: exact, source: 'exact', warnings }
  if (exact) { warnings.push(`fallback:${form}/${behavior}→${form}/idle`); return { animation: exact, source: 'same-form-idle', warnings } }
  if (f?.states.idle) { warnings.push(`fallback:${form}/${behavior}→${form}/idle`); return { animation: f.states.idle, source: 'same-form-idle', warnings } }
  if (f?.master) { warnings.push(`fallback:${form}/${behavior}→${form}/master`); return { animation: masterLoop(f.master), source: 'form-master', warnings } }
  warnings.push(`fallback:${form}/${behavior}→lit/idle`)
  const lit = manifest.forms.lit
  return { animation: lit?.states.idle ?? masterLoop(lit?.master ?? ''), source: 'lit-idle', warnings }
}

/**
 * @param {PetManifest} manifest
 * @param {PetTransition} transition
 * @param {PetForm} toForm
 * @returns {{ kind: 'frames', animation: Animation, warnings: string[] } | { kind: 'fade', to: Animation, warnings: string[] }}
 */
export function resolveTransition(manifest, transition, toForm) {
  const a = manifest.transitions[transition]
  if (a) return { kind: 'frames', animation: a, warnings: [] }
  // 缺转场:淡出淡入到目标形态的 idle。不倒放另一方向(handoff §4.3)。
  const to = resolveAnimation(manifest, toForm, 'idle').animation
  return { kind: 'fade', to, warnings: [`fallback:transition/${transition}→fade`] }
}
