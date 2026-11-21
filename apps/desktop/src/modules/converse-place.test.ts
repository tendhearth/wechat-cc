import {expect, it} from 'vitest'
import {canReadEarlier, placeCards, shouldReadAnotherPage} from './converse-place.js'
import type {RosterItem} from './converse-place.js'

it('only offers earlier pages for a selected place that still has unloaded messages', () => {
  const loaded = [{messageId: 'loaded'}, {terminalId: 'session'}]
  expect(canReadEarlier('', null, loaded)).toBe(false)
  expect(canReadEarlier('cursor', null, loaded)).toBe(true)
  expect(canReadEarlier('cursor', new Set(), loaded)).toBe(false)
  expect(canReadEarlier('cursor', new Set(['loaded']), loaded)).toBe(false)
  expect(canReadEarlier('cursor', new Set(['loaded', 'somewhere earlier']), loaded)).toBe(true)
})

it('stops the filtered search on a hit, at the end, on a repeated cursor, at 20 pages or after changing places', () => {
  const search = {pages: 19, previousCursor: 'old', cursor: 'new', canRead: true, found: false, samePlace: true}
  expect(shouldReadAnotherPage(search)).toBe(true)
  for (const stop of [
    {found: true}, {canRead: false}, {cursor: 'old'}, {pages: 20}, {samePlace: false},
  ]) expect(shouldReadAnotherPage({...search, ...stop})).toBe(false)
})

const matter = (id: string, updatedAt: number): RosterItem => ({
  key: `matter:${id}`, id, kind: 'matter', title: `事项 ${id}`, group: 'working', status: 'working',
  agents: [], quiet: false, unseen: false, updatedAt,
})

it('projects only missing references in time order, limits the initial view and clears it with the filter', () => {
  const roster = Array.from({length: 12}, (_, i) => matter(String(12 - i), 12 - i))
  roster.push({
    ...matter('session', 13), key: 'terminal:session', kind: 'terminal', project: 'melu',
    terminal: {sessionId: 'session', code: 'abc', summary: '最近一句'},
  })
  const filter = {matterIds: new Set(roster.map(item => item.id)), sessionIds: new Set(['session'])}
  const shown = placeCards(filter, roster, [{matterId: '12'}])
  expect(shown.remaining).toBe(2)
  expect(shown.cards.map(item => item.at)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 13])
  expect(shown.cards.at(-1)).toMatchObject({terminalId: 'session', text: '最近一句'})
  expect(placeCards(filter, roster, [{matterId: '12'}, {terminalId: 'session'}], true).cards.map(item => item.at))
    .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  expect(placeCards(null, roster, [], true)).toEqual({cards: [], remaining: 0})
})

it('falls back to the project name when the terminal summary is blank', () => {
  const item: RosterItem = {
    ...matter('session', 1), key: 'terminal:session', kind: 'terminal', project: 'melu',
    terminal: {sessionId: 'session', code: 'abc', summary: ' '},
  }
  expect(placeCards({matterIds: new Set(), sessionIds: new Set(['session'])}, [item], []).cards[0]?.text).toBe('melu')
})
