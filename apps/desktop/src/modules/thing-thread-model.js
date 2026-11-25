// @ts-check
import { messageDay } from './desk-page.js'

/** @typedef {import('../../../../packages/protocol/src/roster').RosterItemT & {endedAt?:number|null, sessionTitle?:string}} RosterItem */
/** @typedef {import('../../../../packages/protocol/src/places').PlaceT} Place */
/** @typedef {import('@wechat-cc/protocol').CliSessionRowT} Session */
/** @typedef {import('@wechat-cc/protocol').CliActivityPageT['items'][number] & {id:string}} Activity */

export const VISIBLE_SESSIONS = 6

/** @param {Place} place @param {RosterItem[]} roster */
export function placeSessions(place, roster) {
  if (place.sessions) {
    /** @type {RosterItem[]} */
    const sessions = place.sessions.map(s => ({
      key: s.matterId ? `matter:${s.matterId}` : `terminal:${s.sessionId}`,
      id: s.matterId ?? s.sessionId, kind: s.matterId ? 'matter' : 'terminal',
      title: place.name, sessionTitle: s.title, status: s.status, updatedAt: s.updatedAt, endedAt: s.endedAt,
      group: s.status === 'waiting' ? 'waiting' : s.status === 'working' ? 'working' : 'back',
      quiet: false, unseen: false, agents: [{ id: s.agent, current: true }],
      terminal: { sessionId: s.sessionId, code: s.sessionId.slice(0, 6), summary: null },
    }))
    const tasks = roster.filter(item => item.kind === 'matter' && !item.terminal && place.matterIds.includes(item.id))
    const live = sessions.filter(item => item.endedAt == null)
    return [...tasks, ...live, ...sessions.filter(item => item.endedAt != null)]
  }
  return roster.filter(item => item.kind === 'terminal'
    ? place.sessionIds.includes(item.id)
    : place.matterIds.includes(item.id) || (item.terminal && place.sessionIds.includes(item.terminal.sessionId)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** @param {RosterItem[]} items @param {string|undefined} [selected] @param {number} [limit] */
export function splitSessions(items, selected, limit = VISIBLE_SESSIONS) {
  const visible = items.slice(0, limit)
  const promoted = items.slice(limit).find(item => item.key === selected)
  if (promoted) visible[limit - 1] = promoted
  const keys = new Set(visible.map(item => item.key))
  return { visible, earlier: items.filter(item => !keys.has(item.key)) }
}

/** @param {RosterItem[]} ordered @param {string|null|undefined} remembered */
export function initialSession(ordered, remembered = null) {
  // Tabs keep a stable order, so "the latest" is found by time, not by position.
  const latest = ordered.filter(item => item.endedAt == null)
    .reduce((/** @type {RosterItem|undefined} */ best, item) => !best || item.updatedAt > best.updatedAt ? item : best, undefined)
  return ordered.find(item => item.key === remembered)
    ?? ordered.find(item => item.group === 'waiting') ?? latest ?? ordered[0]
}

/** @param {Session|null} session @param {string} name @param {boolean} waiting */
export function terminalInputReason(session, name, waiting) {
  if (waiting || session?.status === 'waiting') return session?.pending?.actionable || waiting
    ? '先定上面这件，它才往下走' : '先在终端里定下这件，它才往下走'
  if (!session) return '暂时读不到这次会话'
  if (session.status === 'ended') return '这次会话已经结束，接着做要在终端里重新打开'
  if (session.stale && !session.live_window) return '它的窗口不在了，回终端里接着说'
  if (session.stale) return ''
  if (!session.live_window && session.status !== 'idle') return `${name} 正在做，等这一轮停了再说`
  return ''
}

/** Merge ordered pages without reading any meaning into the server's IDs.
 * @param {Activity[]} current @param {Activity[]} incoming @param {'earlier'|'latest'} direction
 */
export function mergeActivity(current, incoming, direction) {
  const indices = new Map(current.map((item, index) => [item.id, index]))
  const merged = []
  let position = 0
  /** @type {Activity[]} */ let added = []
  for (const item of incoming) {
    const index = indices.get(item.id)
    if (index === undefined) { added.push(item); continue }
    merged.push(...current.slice(position, index), ...added, item)
    added = []
    position = index + 1
  }
  const rest = current.slice(position)
  if (!position && direction === 'earlier') return [...added, ...rest]
  return [...merged, ...rest, ...added]
}

/** @param {Activity[]} items */
export function groupActivity(items) {
  /** @type {Array<[Activity,...Activity[]]>} */ const groups = []
  let day
  for (const item of items) {
    const previous = groups.at(-1)
    const nextDay = messageDay(item.at ?? undefined)?.toDateString()
    if (item.kind === 'step' && previous?.[0]?.kind === 'step' && (!nextDay || nextDay === day)) previous.push(item)
    else groups.push([item])
    if (nextDay) day = nextDay
  }
  return groups
}
