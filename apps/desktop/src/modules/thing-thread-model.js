// @ts-check
import { messageDay } from './desk-page.js'

/** @typedef {import('../../../../packages/protocol/src/roster').RosterItemT} RosterItem */
/** @typedef {import('../../../../packages/protocol/src/places').PlaceT} Place */
/** @typedef {import('@wechat-cc/protocol').CliSessionRowT} Session */
/** @typedef {import('@wechat-cc/protocol').CliActivityPageT['items'][number] & {id:string}} Activity */

export const VISIBLE_SESSIONS = 5

/** @param {Place} place @param {RosterItem[]} roster */
export function placeSessions(place, roster) {
  return roster.filter(item => item.kind === 'terminal'
    ? place.sessionIds.includes(item.id)
    : place.matterIds.includes(item.id) || (item.terminal && place.sessionIds.includes(item.terminal.sessionId)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** @param {RosterItem[]} items */
export function splitSessions(items) {
  return { visible: items.slice(0, VISIBLE_SESSIONS), earlier: items.slice(VISIBLE_SESSIONS) }
}

/** @param {RosterItem[]} ordered @param {string|null|undefined} remembered */
export function initialSession(ordered, remembered = null) {
  return ordered.find(item => item.key === remembered)
    ?? ordered.find(item => item.group === 'waiting') ?? ordered[0]
}

/** @param {Session|null} session @param {string} name @param {boolean} waiting */
export function terminalInputReason(session, name, waiting) {
  if (waiting || session?.status === 'waiting') return session?.pending?.actionable || waiting
    ? '先定上面这件，它才往下走' : '先在终端里定下这件，它才往下走'
  if (!session || session.stale || session.status === 'ended') return '这次会话已经结束，接着做要在终端里重新打开'
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
