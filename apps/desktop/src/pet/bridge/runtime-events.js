// @ts-check
// runtime-events.js — presence(处境)+ pet 端点(在做什么)→ 一个意图(spec §5.1–§5.3)。
// 纯函数;所有「变化」都靠传进来的 state 做边沿检测,不用任何计时器。
//
// 明暗(form)只来自 presence:够得着 daemon = lit(presence-map.js;主人 2026-10-01 拍板,
// 与「此刻」页、手机同一个信号)。以前的「20 分钟没说话就退潮」已经删掉;联系时间只剩两个用处:
// 联系前进时播一次 receive + micro-light,以及决定 pet 端点轮询的快慢档(recentContact)。
export const RECENT_CONTACT_MS = 20 * 60_000

/** @typedef {import('./presence-map.js').PetIntent} PetIntent */
/** @typedef {import('./pet-poller.js').PetTurn} PetTurn */
/** @typedef {{ lastContactMs: number | null, lastDoneMs: number | null, initialized: boolean }} BridgeState */

/** @returns {BridgeState} */
export const initialBridgeState = () => ({ lastContactMs: null, lastDoneMs: null, initialized: false })

/** 主人刚说过话(窗口内)。只给轮询快慢档用。 @param {BridgeState} state @param {number} nowMs */
export const recentContact = (state, nowMs) => state.lastContactMs !== null && nowMs - state.lastContactMs <= RECENT_CONTACT_MS

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
  // 这一拍没拉到 pet 端点(超时 / 500 / 启动中 503):画面照 presence(明暗本来就只看它),什么都不记。
  if (!turn) return { intent: presence, state, permission: null, permissionCount: 0 }
  const contactMs = ms(turn.owner_last_contact_at)
  const doneMs = ms(turn.last_done_at)
  const pending = Array.isArray(turn.pending_permissions) ? turn.pending_permissions : []
  const phase = turn.turn?.phase ?? 'idle'
  /** @type {string[]} */ const props = [...presence.props]
  /** @type {PetIntent['oneShots']} */ const oneShots = [...presence.oneShots]

  // presence 说睡(down)→ 画面照 presence;联系 / 完成的时间照样记,只是不演。
  const asleep = presence.behavior === 'sleep'
  if (state.initialized && !asleep) {
    if (contactMs !== null && (state.lastContactMs === null || contactMs > state.lastContactMs)) {
      oneShots.push('receive'); if (!props.includes('micro-light')) props.push('micro-light')
    }
    if (state.lastDoneMs !== null && doneMs !== null && doneMs > state.lastDoneMs) oneShots.push('done')
  }

  /** @type {PetIntent['behavior']} */
  let behavior = presence.behavior
  if (!asleep && phase !== 'idle') behavior = phase
  const intent = { form: presence.form, behavior, props, badge: presence.badge, hint: presence.hint, oneShots }
  return { intent, state: { lastContactMs: highWaterMark(contactMs, state.lastContactMs), lastDoneMs: highWaterMark(doneMs, state.lastDoneMs), initialized: true }, permission: pending[0] ?? null, permissionCount: pending.length }
}
