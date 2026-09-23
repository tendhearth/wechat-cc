// @ts-check
// companion-scene-state.js — 状态 → 画面的薄映射(spec 2026-09-03-companion-presence §3.2)。
// 纯函数;animation-lab.js 只认 SceneState,不认 presence。

/** @typedef {import('./presence-poller.js').Presence} Presence */
/** @typedef {{ bearPresent: boolean, bearPose: 'idle'|'wave'|'fishing'|'busy', tint: 'normal'|'dim'|'dark', sign: string|null, prop: 'bag'|'postcard'|'letter'|null, badge: number, bubble: string|null }} SceneState */

/** @param {string | null} kind */
function propFor(kind) {
  if (kind === 'visit' || kind === 'postcard') return /** @type {const} */ ('postcard')
  if (kind === 'letter') return /** @type {const} */ ('letter')
  return /** @type {const} */ ('bag')
}

/**
 * @param {Presence | null} p
 * @returns {SceneState}
 */
export function sceneStateFrom(p) {
  // daemon 都没起(down / 拉不到):连计数都不可信,什么都不画。
  if (!p || p.presence === 'down') {
    return { bearPresent: false, bearPose: 'idle', tint: 'dark', sign: '离线', prop: null, badge: 0, bubble: null }
  }
  const unread = Math.max(0, Math.trunc(Number(p.news?.unread) || 0))
  const prop = unread > 0 ? propFor(p.news?.latest_kind ?? null) : null
  // 微信断了(offline):不是故事,是事实 —— 不画熊、不讲活动。但 daemon 还在,
  // journal 计数依然可信,带回来的东西确实在那儿等着看,所以道具/角标保留。
  if (p.presence === 'offline') {
    return { bearPresent: false, bearPose: 'idle', tint: 'dark', sign: '离线', prop, badge: unread, bubble: null }
  }
  const tint = p.presence === 'degraded' ? 'dim' : 'normal'
  const a = p.activity ?? { kind: 'idle', label: '', since: null }
  /** @type {SceneState} */
  const base = { bearPresent: true, bearPose: 'idle', tint, sign: null, prop, badge: unread, bubble: null }
  switch (a.kind) {
    case 'chatting':      return { ...base, bearPose: 'wave', bubble: a.label }
    case 'hosting_human': return { ...base, bearPose: 'wave', sign: a.label }
    case 'visiting':      return { ...base, bearPresent: false, sign: a.label }
    case 'hosting_peer':  return { ...base, sign: a.label }
    case 'foraging':      return { ...base, bearPose: 'fishing', sign: a.label }
    case 'working':       return { ...base, bearPose: 'busy', bubble: a.label }
    default:              return base
  }
}
