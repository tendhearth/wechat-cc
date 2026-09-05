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
     * @param {PetTurn | null} turn
     * @returns {{ intent: PetIntent, permission: PetTurn['pending_permissions'][number] | null, permissionCount: number, fast: boolean }}
     */
    tick(turn) {
      const r = mergeIntent({ presence: presenceIntent, turn, state, nowMs: now() })
      state = r.state
      presenceIntent = { ...presenceIntent, oneShots: [] }
      const fast = state.form === 'lit' || (turn?.turn?.phase ?? 'idle') !== 'idle' || r.permissionCount > 0
      return { intent: r.intent, permission: r.permission, permissionCount: r.permissionCount, fast }
    },
  }
}
