// @ts-check
// pet-bridge.js — 陪伴窗那点「有状态」的胶水,搬出 DOM 好测(spec §5)。
//
// 两个轮询各拉各的:presence(处境,20 s)与 pet 端点(在做什么,2 / 10 s)。
// 谁回来都重算一拍;这里管三件事:
//  1. prev 只记**拉到过的真状态** —— 拉不到时 poller 发 DOWN_PRESENCE(unread 0),
//     拿它当基准会让下一次拉通时凭空播一次「收到信」;
//  2. 一次性动作播完即清 —— pet 端点每 2 秒来一拍,不清的话 presence 那次的
//     receive / error 会跟着每一拍重播;
//  3. 轮询快慢档由合并结果决定(亮着 / 有轮次 / 有待决权限 → 快)。
import { presenceToPet } from './presence-map.js'
import { initialBridgeState, mergeIntent } from './runtime-events.js'

/** @typedef {import('../../presence-poller.js').Presence} Presence */
/** @typedef {import('./presence-map.js').PetIntent} PetIntent */
/** @typedef {import('./pet-poller.js').PetTurn} PetTurn */

/** @param {{ now?: () => number }} [opts] */
export function createPetBridge({ now = () => Date.now() } = {}) {
  let state = initialBridgeState()
  /** @type {Presence | null} */
  let prev = null
  /** @type {PetIntent} */
  let presenceIntent = presenceToPet(null, null)

  return {
    /** @param {Presence | null} p */
    notePresence(p) {
      presenceIntent = presenceToPet(p, prev)
      if (p && p.presence !== 'down') prev = p
    },
    /**
     * `first` = 这一拍**刚刚**把状态定下来(第一次拿到 pet 端点的回答)。调用方拿它
     * 决定要不要跳过转场:开窗时 CC 已经亮着,那不是「主人刚到」,不该演点火
     * (spec §5.2「第一拍不播转场」)。之后每一拍都是 false —— 那时候的变化是真变化。
     * @param {PetTurn | null} turn
     * @returns {{ intent: PetIntent, permission: PetTurn['pending_permissions'][number] | null, permissionCount: number, fast: boolean, first: boolean }}
     */
    tick(turn) {
      const wasInitialized = state.initialized
      const r = mergeIntent({ presence: presenceIntent, turn, state, nowMs: now() })
      state = r.state
      presenceIntent = { ...presenceIntent, oneShots: [] }
      const fast = state.form === 'lit' || (turn?.turn?.phase ?? 'idle') !== 'idle' || r.permissionCount > 0
      // 拉不到端点的那几拍不算「定下来」(mergeIntent 那时不动 state.initialized),
      // 所以 first 会留到真正第一次拿到回答的那一拍。今天 bridge 不会重置 state,
      // 若将来加了重置(reset),同样应当在重置后的第一拍再报一次 first。
      return { intent: r.intent, permission: r.permission, permissionCount: r.permissionCount, fast, first: !wasInitialized && state.initialized }
    },
  }
}
