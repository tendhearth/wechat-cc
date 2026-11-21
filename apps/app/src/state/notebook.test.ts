import { beforeEach, expect, it, vi } from 'vitest'
import type { NotebookEntryT, NotebookPageQueryT, NotebookPageResponseT } from '@wechat-cc/protocol'
import type { Backend } from '../backend/types'
import { notebookStorage } from '../net/notebook-storage'
import { makeNotebook } from './notebook-store'

const disk = vi.hoisted(() => new Map<string, string>())
const setItem = vi.hoisted(() => vi.fn(async (key: string, value: string) => { disk.set(key, value) }))
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => disk.get(key) ?? null,
  setItemAsync: setItem,
  deleteItemAsync: async (key: string) => { disk.delete(key) },
}))

const yesterday = '2026-11-03'
const today = '2026-11-04'
const active = () => true
const receipt: NotebookEntryT = {
  id: 'e0b63c71-a49d-49ea-a3b5-479ac63c49eb', author: 'owner', body: 'offline note',
  day: today, createdAt: 2, clientId: 'queued', struckAt: null, refId: null, origin: 'app',
}
function page(day: string, current = today): NotebookPageResponseT {
  return { day, today: current, days: [yesterday], entries: day === yesterday ? [{ ...receipt, day, clientId: null }] : [],
    paper: 'ruled', penPending: false, pen: { font: 'kai', ink: 'blueBlack', reason: '' } }
}
function backend(notebookPage: (query: NotebookPageQueryT) => Promise<NotebookPageResponseT>, online = true) {
  return { mode: 'live', connection: () => ({ state: online ? 'online' : 'offline' }),
    notebookPage, notebookWrite: vi.fn().mockResolvedValue(receipt) } as unknown as Backend
}

beforeEach(() => { disk.clear(); setItem.mockClear() })

it('requests an empty today explicitly and stops after two reads', async () => {
  const read = vi.fn(async ({ day }: NotebookPageQueryT) => {
    if (read.mock.calls.length > 2) throw new Error('unexpected repeated read')
    return page(day ?? yesterday)
  })
  const notebook = makeNotebook(backend(read), null, active)
  await notebook.refresh()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(read.mock.calls.map(([query]) => query.day)).toEqual([undefined, today])
  expect(notebook.getSnapshot().day).toBe(today)
  expect(notebook.getSnapshot().entries).toEqual([])
})

it('restores an acknowledged line on its daemon day after an offline restart', async () => {
  const storage = notebookStorage('pair', active)
  await storage.savePage(page(yesterday, yesterday))
  await storage.saveQueue([{ clientId: receipt.clientId, body: receipt.body, createdAt: 1, day: yesterday }])
  const offline = vi.fn().mockRejectedValue(new Error('offline'))
  const notebook = makeNotebook(backend(offline), 'pair', active)
  await notebook.refresh()
  await notebook.flush(active)
  expect(await storage.loadQueue()).toEqual([])

  const restarted = makeNotebook(backend(offline, false), 'pair', active)
  await restarted.refresh()
  restarted.select(today)
  expect(restarted.getSnapshot().entries).toEqual([receipt])
  expect(restarted.getSnapshot().pending).toEqual([])
})

it('follows midnight with an explicit day and reads the explicit day when returning to today', async () => {
  const tomorrow = '2026-11-05'
  let current = today
  const read = vi.fn(async ({ day }: NotebookPageQueryT) => page(day ?? current, current))
  const notebook = makeNotebook(backend(read), null, active)
  await notebook.refresh()
  current = tomorrow
  await notebook.refresh()
  expect(read.mock.calls.map(([query]) => query.day)).toEqual([undefined, today, tomorrow])
  expect(notebook.getSnapshot().day).toBe(tomorrow)
  notebook.select(yesterday)
  await notebook.refresh()
  notebook.select(tomorrow)
  await notebook.refresh()
  expect(read.mock.calls.slice(3).map(([query]) => query.day)).toEqual([yesterday, tomorrow])
})

it('keeps the original queue until the receipt is durable and prunes the receipt after caching its day', async () => {
  const storage = notebookStorage('pair', active)
  const queued = { clientId: receipt.clientId, body: receipt.body, createdAt: 1, day: yesterday }
  await storage.savePage(page(yesterday, yesterday))
  await storage.saveQueue([queued])
  const read = vi.fn().mockRejectedValue(new Error('offline'))
  const client = backend(read)
  const notebook = makeNotebook(client, 'pair', active)
  await notebook.refresh()
  setItem.mockImplementation(async (key, value) => {
    if (key === 'tendhearth.notebook.receipts.v1') {
      setItem.mockImplementation(async (nextKey, nextValue) => { disk.set(nextKey, nextValue) })
      throw new Error('interrupted receipt write')
    }
    disk.set(key, value)
  })
  await notebook.flush(active)
  expect(await storage.loadQueue()).toEqual([queued])
  await notebook.flush(active)
  expect(await storage.loadQueue()).toEqual([])
  expect(await storage.loadReceipts()).toEqual([receipt])
  expect(vi.mocked(client.notebookWrite).mock.calls.map(([input]) => input.clientId)).toEqual(['queued', 'queued'])
  await storage.savePage({ ...page(today), entries: [receipt] })
  expect(await storage.loadReceipts()).toEqual([])
  expect((await storage.loadPage())?.entries).toEqual([receipt])
})
