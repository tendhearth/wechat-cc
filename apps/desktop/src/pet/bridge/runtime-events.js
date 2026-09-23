// @ts-check
// runtime-events.js — presence(处境)+ pet 端点(在做什么)→ 一个意图(spec §5.1–§5.3)。
// 纯函数;所有「变化」都靠传进来的 state 做边沿检测,不用任何计时器。
// LIT_DIM_MS 与 daemon 端 core/pet-turn.ts 的同名常量一致;desktop 侧无法直接 import 那份
// TypeScript 源,这里有意重复一份数值,改动时两边一起改。
export const LIT_DIM_MS = 20 * 60_000

/** @typedef {import('./presence-map.js').PetIntent} PetIntent */
/** @typedef {import('./pet-poller.js').PetTurn} PetTurn */
/** @typedef {{ form: 'unlit' | 'lit', lastContactMs: number | null, lastDoneMs: number | null, initialized: boolean }} BridgeState */

/** @returns {BridgeState} */
export const initialBridgeState = () => ({ form: 'unlit', lastContactMs: null, lastDoneMs: null, initialized: false })

/** @param {string | null | undefined} iso */
const ms = (iso) => { if (!iso) return null; const v = Date.parse(iso); return Number.isFinite(v) ? v : null }

// 单调高水位:daemon 重启会丢内存里的联系时间,只剩更旧的 latestInboundTs,
// 端点可能因此吐出一个比我们已经见过的更早的时间戳。high-water mark 不跟着
// 倒退,不然「变旧又变新」的假象会在下一拍被当成一次新联系触发 receive。
/** @param {number | null} incoming @param {number | null} prevMark */
const highWaterMark = (incoming, prevMark) => incoming === null ? prevMark : (prevMark === null || incoming > prevMark ? incoming : prevMark)

/**
 * @param {{ presence: PetIntent, turn: PetTurn | null, state: BridgeState, nowMs: number }} a
 * @returns {{ intent: PetIntent, state: BridgeState, permission: PetTurn['pending_permissions'][number] | null, permissionCount: number }}
 */
export function mergeIntent({ presence, turn, state, nowMs }) {
  // 这一拍没拉到 pet 端点(超时 / 500 / 启动中 503)。还没初始化过就只能照 presence
  // 画(Phase A 的 3 分钟近似,除此之外无事可依);已经初始化过就**守住已知的事实**:
  // form 保持上一拍的 form,不跟着 presence 的近似值退回 unlit —— 不然一次超时会
  // 演一遍「灭掉又点亮」,而现实里什么都没发生(spec §5「不许撒谎」)。
  // behavior 仍照 presence 走(睡着了就是睡着了,这是一次诚实的降级)。
  if (!turn) {
    if (!state.initialized) return { intent: presence, state, permission: null, permissionCount: 0 }
    const kept = presence.behavior === 'sleep' ? presence.form : state.form
    return { intent: { ...presence, form: kept }, state, permission: null, permissionCount: 0 }
  }
  const contactMs = ms(turn.owner_last_contact_at)
  const doneMs = ms(turn.last_done_at)
  const pending = Array.isArray(turn.pending_permissions) ? turn.pending_permissions : []
  const phase = turn.turn?.phase ?? 'idle'
  /** @type {string[]} */ const props = [...presence.props]
  /** @type {PetIntent['oneShots']} */ const oneShots = [...presence.oneShots]

  /** @type {'unlit' | 'lit'} */
  let form = state.form
  if (!state.initialized) {
    form = contactMs !== null && nowMs - contactMs <= LIT_DIM_MS ? 'lit' : 'unlit'
  } else {
    if (contactMs !== null && (state.lastContactMs === null || contactMs > state.lastContactMs)) {
      if (state.form === 'unlit') form = 'lit'
      else { oneShots.push('receive'); if (!props.includes('micro-light')) props.push('micro-light') }
    }
    if (form === 'lit' && contactMs !== null && nowMs - contactMs > LIT_DIM_MS && phase === 'idle' && pending.length === 0) form = 'unlit'
    if (state.lastDoneMs !== null && doneMs !== null && doneMs > state.lastDoneMs) oneShots.push('done')
  }

  // presence 说睡(down / offline)→ 画面照 presence;事实 form 仍按上面维护
  const asleep = presence.behavior === 'sleep'
  /** @type {PetIntent['behavior']} */
  let behavior = presence.behavior
  if (!asleep && phase !== 'idle') behavior = phase
  const intent = { form: asleep ? presence.form : form, behavior, props, badge: presence.badge, hint: presence.hint, oneShots }
  return { intent, state: { form, lastContactMs: highWaterMark(contactMs, state.lastContactMs), lastDoneMs: highWaterMark(doneMs, state.lastDoneMs), initialized: true }, permission: pending[0] ?? null, permissionCount: pending.length }
}
