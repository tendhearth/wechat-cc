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
  // 收信的沿:拿上一次**拉到过的真状态**比。拉不到时 poller 发的是 DOWN_PRESENCE(unread 0),
  // 拿它当基准会让下一次拉通时凭空「收到」一堆信 —— 所以 down 不作数(窗口那边也不更新 prev)。
  // offline 一样会收到信(明信片、串门都还在落库),所以这条沿在离线时也算。
  const received = !!prev && prev.presence !== 'down' && unread > unreadOf(prev)
  if (p.presence === 'offline') return { form: 'unlit', behavior: 'sleep', props: envelope, badge, hint: null, oneShots: received ? ['receive'] : [] }

  const degraded = p.presence === 'degraded'
  if (degraded) { props.push('exclamation'); if (!prev || prev.presence !== 'degraded') oneShots.push('error') }
  const kind = p.activity?.kind ?? 'idle'
  /** @type {'unlit' | 'lit'} */
  const form = kind === 'chatting' ? 'lit' : 'unlit'
  /** @type {PetBehavior} */
  let behavior = 'idle'
  if (COMPANION_KINDS.has(kind)) behavior = 'companion'
  // working 的帧自带笔记本,再叠一个 laptop 道具就是两台(见 final-review 8)。
  else if (WORKING_KINDS.has(kind)) behavior = 'working'
  props.push(...envelope)
  if (received) oneShots.push('receive')
  return { form, behavior, props, badge, hint: null, oneShots }
}
