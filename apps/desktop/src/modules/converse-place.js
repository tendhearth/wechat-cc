// @ts-check

/** @typedef {import('../../../../packages/protocol/src/roster').RosterItemT} RosterItem */
/** @typedef {{matterIds:ReadonlySet<string>,sessionIds:ReadonlySet<string>}} PlaceReferences */
/** @typedef {{messageId?:string,matterId?:string,terminalId?:string}} Reference */
/** @typedef {{key:string,at:number,text:string,matterId?:string,terminalId?:string}} PlaceCard */

export const PLACE_CARD_LIMIT = 10
export const PLACE_SEARCH_LIMIT = 20

/** @param {string} cursor @param {ReadonlySet<string>|null} placeIds @param {Reference[]} messages */
export function canReadEarlier(cursor, placeIds, messages) {
  if (!cursor) return false
  if (!placeIds) return true
  const loaded = new Set(messages.map(message => message.messageId))
  return [...placeIds].some(id => !loaded.has(id))
}

/** @param {{pages:number,previousCursor:string,cursor:string,canRead:boolean,found:boolean,samePlace:boolean}} search */
export function shouldReadAnotherPage({pages, previousCursor, cursor, canRead, found, samePlace}) {
  return samePlace && canRead && !found && cursor !== previousCursor && pages < PLACE_SEARCH_LIMIT
}

/** @param {PlaceReferences|null} place @param {RosterItem[]} roster @param {Reference[]} messages @param {boolean} expanded */
export function placeCards(place, roster, messages, expanded = false) {
  if (!place) return {cards: [], remaining: 0}
  const matters = new Set(messages.map(message => message.matterId))
  const sessions = new Set(messages.map(message => message.terminalId))
  /** @type {PlaceCard[]} */
  const cards = []
  for (const item of roster) {
    if (item.kind === 'matter' && place.matterIds.has(item.id) && !matters.has(item.id)) {
      cards.push({key: item.key, matterId: item.id, at: item.updatedAt, text: item.title})
      matters.add(item.id)
    }
    if (item.kind === 'terminal' && place.sessionIds.has(item.id) && !sessions.has(item.id)) {
      cards.push({key: item.key, terminalId: item.id, at: item.updatedAt, text: item.terminal?.summary?.trim() || item.project || item.title})
      sessions.add(item.id)
    }
  }
  cards.sort((a, b) => a.at - b.at)
  const remaining = expanded ? 0 : Math.max(0, cards.length - PLACE_CARD_LIMIT)
  return {cards: cards.slice(remaining), remaining}
}
