// @ts-check
// types.js — CC 的领域词表(spec 2026-09-05-cc-desktop-pet §2)。form / behavior / transition 分开建模。

/** @typedef {'unlit' | 'lit'} PetForm */
/** @typedef {'idle'|'blink'|'look'|'receive'|'working'|'thinking'|'permission'|'done'|'companion'|'sleep'|'drag'|'wake'|'error'} PetBehavior */
/** @typedef {'unlit-to-lit' | 'lit-to-unlit'} PetTransition */
/** @typedef {'micro-light'|'sprout'|'laptop'|'envelope'|'speech-bubble'|'thought-bubble'|'exclamation'|'mug'} PetProp */

/** @type {readonly PetForm[]} */
export const FORMS = Object.freeze(['unlit', 'lit'])
/** @type {readonly PetBehavior[]} */
export const BEHAVIORS = Object.freeze(['idle', 'blink', 'look', 'receive', 'working', 'thinking', 'permission', 'done', 'companion', 'sleep', 'drag', 'wake', 'error'])
/** @type {readonly PetTransition[]} */
export const TRANSITIONS = Object.freeze(['unlit-to-lit', 'lit-to-unlit'])
/** @type {readonly PetProp[]} */
export const PROPS = Object.freeze(['micro-light', 'sprout', 'laptop', 'envelope', 'speech-bubble', 'thought-bubble', 'exclamation', 'mug'])

/** handoff §5.4:permission > drag > transition > error > receive/done/wake > working/thinking > sleep > companion > look/blink > idle */
/** @type {Readonly<Record<PetBehavior | 'transition', number>>} */
export const PRIORITY = Object.freeze({
  permission: 100, drag: 90, transition: 80, error: 70, receive: 60, done: 60, wake: 60,
  working: 50, thinking: 50, sleep: 40, companion: 30, look: 20, blink: 20, idle: 10,
})
/** 播一次就回落的行为;其余是持续行为,保持到下一个事件。 */
export const ONE_SHOT = new Set(/** @type {PetBehavior[]} */ (['blink', 'look', 'receive', 'done', 'drag', 'wake', 'error']))

/** @param {unknown} x @returns {x is PetBehavior} */
export const isBehavior = (x) => typeof x === 'string' && /** @type {readonly string[]} */ (BEHAVIORS).includes(x)
/** @param {unknown} x @returns {x is PetForm} */
export const isForm = (x) => x === 'unlit' || x === 'lit'
/** @param {unknown} x @returns {x is PetProp} */
export const isProp = (x) => typeof x === 'string' && /** @type {readonly string[]} */ (PROPS).includes(x)
