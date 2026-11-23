import { expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { canCheckNotebookMail, isNotebookReply, makeNotebookMail, notebookReplyVisible } from './notebook-mail'

const today = '2026-11-22'
const yes = () => true
const no = () => false

it('checks for replies only on the connected, paired, foreground home', () => {
  expect(canCheckNotebookMail(true, true, true, true)).toBe(true)
  expect(canCheckNotebookMail(false, true, true, true)).toBe(false)
  expect(canCheckNotebookMail(true, false, true, true)).toBe(false)
  expect(canCheckNotebookMail(true, true, false, true)).toBe(false)
  expect(canCheckNotebookMail(true, true, true, false)).toBe(false)
})

it('counts only a CC reply with at least half of its drawn body in the viewport', () => {
  expect(isNotebookReply({ author: 'cc', refId: 'owner-line' })).toBe(true)
  expect(isNotebookReply({ author: 'cc', refId: null })).toBe(false)
  expect(isNotebookReply({ author: 'owner', refId: 'owner-line' })).toBe(false)
  expect(notebookReplyVisible(80, 40, 0, 100)).toBe(true)
  expect(notebookReplyVisible(81, 40, 0, 100)).toBe(false)
  expect(notebookReplyVisible(0, 40, 20, 100)).toBe(true)
  expect(notebookReplyVisible(0, 40, 21, 100)).toBe(false)
  expect(notebookReplyVisible(0, 0, 0, 100)).toBe(false)
})

it('sends eligible replies serially in batches of 50, preserves failed IDs, and refreshes after success', async () => {
  const demo = makeDemoBackend()
  const ids = Array.from({ length: 51 }, (_, i) => `reply-${i}`)
  const read = vi.fn(async () => today)
  const seen = vi.fn<(...args: [string[]]) => Promise<void>>()
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
  const mail = makeNotebookMail({ ...demo, notebookUnseen: read, notebookSeen: seen })
  await mail.observe(ids, no, yes)
  await mail.observe(ids, yes, no)
  expect(seen).not.toHaveBeenCalled()
  await mail.observe(ids, yes, yes)
  expect(seen).toHaveBeenCalledExactlyOnceWith(ids.slice(0, 50))
  expect(read).not.toHaveBeenCalled()

  await mail.flush(yes, yes)
  expect(seen.mock.calls.map(([batch]) => batch.length)).toEqual([50, 50, 1])
  expect(seen.mock.calls[1]?.[0]).toEqual(ids.slice(0, 50))
  expect(seen.mock.calls[2]?.[0]).toEqual(ids.slice(50))
  expect(read).toHaveBeenCalledTimes(2)
  await mail.observe(ids, yes, yes)
  expect(seen).toHaveBeenCalledTimes(3)
})

it('clears a cached reply day on read failure and ignores a response started before confirmation', async () => {
  const demo = makeDemoBackend()
  let finishOld!: (day: string) => void
  const read = vi.fn(demo.notebookUnseen)
    .mockResolvedValueOnce(today)
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    .mockResolvedValueOnce(undefined)
  const mail = makeNotebookMail({ ...demo, notebookUnseen: read })
  await mail.refresh(yes)
  expect(mail.day()).toBe(today)
  await mail.refresh(yes)
  expect(mail.day()).toBeUndefined()
  const old = mail.refresh(yes)
  await mail.observe(['reply'], yes, yes)
  finishOld(today)
  await old
  expect(mail.day()).toBeUndefined()
})

it('queries again on a new Home focus while an earlier request is in flight', async () => {
  const demo = makeDemoBackend()
  let finishOld!: (day: string) => void
  const read = vi.fn(demo.notebookUnseen)
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    .mockResolvedValueOnce(undefined)
  const mail = makeNotebookMail({ ...demo, notebookUnseen: read })
  const old = mail.refresh(yes)
  await Promise.resolve()
  expect(mail.refresh(yes)).toBe(old)
  await mail.refresh(() => true)
  finishOld(today)
  await old
  expect(read).toHaveBeenCalledTimes(2)
  expect(mail.day()).toBeUndefined()
})

it('starts the demo with a reply and leaves it unread until explicitly confirmed', async () => {
  const demo = makeDemoBackend({ now: () => Date.parse(today) })
  const mail = makeNotebookMail(demo)
  await mail.refresh(yes)
  expect(mail.day()).toBe(today)
  const page = await demo.notebookPage({ day: today })
  const ids = page.entries.filter(isNotebookReply).map(row => row.id)
  expect(ids).toHaveLength(1)
  expect(await demo.notebookUnseen()).toBe(today)
  await mail.observe(ids, yes, yes)
  expect(await demo.notebookUnseen()).toBeUndefined()
  expect(mail.day()).toBeUndefined()
  demo.reset()
  expect(await demo.notebookUnseen()).toBe(today)
  const fresh = await demo.notebookPage({ day: today })
  await mail.observe(fresh.entries.filter(isNotebookReply).map(row => row.id), yes, yes)
  expect(await demo.notebookUnseen()).toBeUndefined()
})
