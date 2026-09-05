// @ts-check
// presence-map.js — presence(处境)→ CC 的意图(spec §5.1 处境部分)。Phase A 先用 presence 的
// 「在聊」(3 分钟入站窗)当微光;Phase B 换成真实 contact 时间与 turn 端点。纯函数。

/** @typedef {import('../../presence-poller.js').Presence} Presence */
/** @typedef {import('../domain/types.js').PetBehavior} PetBehavior */
/** @typedef {{ form: 'unlit' | 'lit', behavior: PetBehavior, props: string[], badge: number, hint: string | null, oneShots: PetBehavior[] }} PetIntent */

const COMPANION_KINDS = new Set(['hosting_human', 'visiting', 'hosting_peer'])
const WORKING_KINDS = new Set(['foraging', 'working'])

/** @param {Presence | null} p */
const unreadOf = (p) => Math.max(0, Math.trunc(Number(p?.news?.unread) || 0))

/**
 * @param {Presence | null} p
 * @param {Presence | null} prev
 * @returns {PetIntent}
 */
export function presenceToPet(p, prev) {
  if (!p || p.presence === 'down') return { form: 'unlit', behavior: 'sleep', props: [], badge: 0, hint: 'daemon 没起', oneShots: [] }
  const unread = unreadOf(p)
  const badge = unread
  /** @type {string[]} */
  const props = []
  /** @type {PetBehavior[]} */
  const oneShots = []
  const envelope = unread > 0 ? ['envelope'] : []
  if (p.presence === 'offline') return { form: 'unlit', behavior: 'sleep', props: envelope, badge, hint: null, oneShots }

  const degraded = p.presence === 'degraded'
  if (degraded) { props.push('exclamation'); if (!prev || prev.presence !== 'degraded') oneShots.push('error') }
  const kind = p.activity?.kind ?? 'idle'
  /** @type {'unlit' | 'lit'} */
  const form = kind === 'chatting' ? 'lit' : 'unlit'
  /** @type {PetBehavior} */
  let behavior = 'idle'
  if (COMPANION_KINDS.has(kind)) behavior = 'companion'
  else if (WORKING_KINDS.has(kind)) { behavior = 'working'; props.push('laptop') }
  props.push(...envelope)
  if (prev && unread > unreadOf(prev)) oneShots.push('receive')
  return { form, behavior, props, badge, hint: null, oneShots }
}
