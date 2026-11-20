import { describe, expect, it, vi } from 'vitest'
import type { NotebookEntryT, NotebookPageResponseT } from '@wechat-cc/protocol'
import {
  acknowledgeNotebookLine, flushNotebookQueue, notebookDate, notebookLines, notebookNeighbors, notebookPen,
  notebookSignature, readNotebookPage, type PendingLine,
} from './notebook'

const today = '2026-11-04', yesterday = '2026-11-03'
function entry(id: string, author: NotebookEntryT['author'] = 'owner', hour = 14, day = today): NotebookEntryT {
  return { id, day, author, body: 'A line', clientId: null, origin: 'app', struckAt: null, refId: null,
    createdAt: new Date(2026, 10, 4, hour).getTime() }
}
function page(day: string, entries: NotebookEntryT[] = []): NotebookPageResponseT {
  return { day, today, entries, days: [today, yesterday], paper: 'ruled', penPending: false,
    pen: { font: 'kai', ink: 'blueBlack', reason: '' } }
}

describe('notebook', () => {
  it('uses the daemon calendar day in either language', () => {
    expect(notebookDate(today, 'zh-Hans', today)).toBe('今天')
    expect(notebookDate(today, 'en', today)).toBe('Today')
    expect(notebookDate(today, 'zh-Hans')).toBe('11 月 4 日')
    expect(notebookDate(today, 'en')).toBe('November 4')
    expect(notebookNeighbors(today, [today, '2026-10-28', yesterday, yesterday])).toEqual({ previous: yesterday, next: undefined })
  })

  it.each([
    [4, '夜里', 'at night'], [5, '清晨', 'at dawn'], [8, '上午', 'in the morning'],
    [12, '下午', 'in the afternoon'], [17, '傍晚', 'in the evening'], [20, '夜里', 'at night'],
  ])('localizes the signature period at hour %i', (hour, zh, en) => {
    const cc = entry('cc', 'cc', hour)
    expect(notebookSignature(cc, undefined, 'zh-Hans')).toBe(`CC，${zh}`)
    expect(notebookSignature(cc, undefined, 'en')).toBe(`CC, ${en}`)
  })

  it('signs only at the end of an uninterrupted same-day, same-period run', () => {
    const cc = entry('first', 'cc')
    expect(notebookSignature(cc, entry('next', 'cc', 15), 'zh-Hans')).toBeNull()
    for (const next of [entry('owner'), entry('morning', 'cc', 10), entry('tomorrow', 'cc', 14, '2026-11-05')]) {
      expect(notebookSignature(cc, next, 'zh-Hans')).toBe('CC，下午')
    }
    expect(notebookSignature(entry('owner'), cc, 'en')).toBeNull()
  })

  it.each([
    ['kai', 'blueBlack', 'THPenKai-Regular', '#24405f'],
    ['hand', 'darkGreen', 'THPenHand-Regular', '#304d3c'],
    ['fangsong', 'ochre', 'THPenFangsong-Regular', '#744729'],
    ['songItalic', 'greyPurple', undefined, '#584863'],
  ] as const)('maps %s and %s to the bundled family and desktop ink', (font, ink, family, color) => {
    expect(notebookPen({ font, ink, reason: '' })).toEqual({ family, color })
  })

  it('follows nextAfter on the first response day and assembles the full page', async () => {
    const first = entry('first'), second = entry('second'), third = entry('third')
    const read = vi.fn()
      .mockResolvedValueOnce({ ...page(today, [first]), nextAfter: first.id })
      .mockResolvedValueOnce({ ...page(today, [first, second]), nextAfter: second.id })
      .mockResolvedValueOnce(page(today, [third]))
    expect((await readNotebookPage(read)).entries).toEqual([first, second, third])
    expect(read.mock.calls).toEqual([
      [{ day: undefined, fonts: 'kai,hand,fangsong,songItalic' }],
      [{ day: today, after: first.id, fonts: 'kai,hand,fangsong,songItalic' }],
      [{ day: today, after: second.id, fonts: 'kai,hand,fangsong,songItalic' }],
    ])
  })

  it('keeps failed writes queued, retries the same ID and files the receipt on its daemon day', async () => {
    const row = { body: 'A line', clientId: 'client', day: today, createdAt: 1 }
    let state = { pending: [row] as PendingLine[], pages: new Map([[today, page(today)], [yesterday, page(yesterday)]]) }
    const receipt = { ...entry('server', 'owner', 14, yesterday), clientId: row.clientId }
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(receipt)
    const ack = (saved: NotebookEntryT) => { state = acknowledgeNotebookLine(state.pending, state.pages, saved) }
    await flushNotebookQueue(state.pending, send, ack)
    expect(state.pending).toEqual([row])
    expect(notebookLines([], state.pending, today, today).map(line => line.id)).toEqual(['client'])
    await flushNotebookQueue(state.pending, send, ack)
    expect(send.mock.calls).toEqual([[{ body: row.body, clientId: row.clientId }], [{ body: row.body, clientId: row.clientId }]])
    expect(state.pending).toEqual([])
    expect(state.pages.get(today)?.entries).toEqual([])
    expect(state.pages.get(yesterday)?.entries).toEqual([receipt])
  })

  it('can render a locally written line before learning the daemon day', () => {
    const row = { body: 'A line', clientId: 'client', createdAt: 1 }
    expect(notebookLines([], [row]).map(line => line.clientId)).toEqual(['client'])
    expect(notebookLines([], [row], yesterday, today)).toEqual([])
  })
})
