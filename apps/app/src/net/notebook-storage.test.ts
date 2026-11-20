import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNotebookStorage, notebookStorage } from './notebook-storage'

const disk = vi.hoisted(() => new Map<string, string>())
const set = vi.hoisted(() => vi.fn(async (key: string, value: string) => {
  if (new TextEncoder().encode(value).length > 1800) throw new Error('large secure-store item')
  disk.set(key, value)
}))
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => disk.get(key) ?? null,
  setItemAsync: set,
  deleteItemAsync: async (key: string) => { disk.delete(key) },
}))

const active = () => true
const row = { clientId: 'stable-id', body: '写🪶\n'.repeat(1200), createdAt: 1 }
beforeEach(() => { disk.clear(); set.mockClear() })

describe('notebook SecureStore', () => {
  it('restores an offline line after a restart, including supplementary characters', async () => {
    await notebookStorage('pair-a', active).saveQueue([row])
    expect(await notebookStorage('pair-a', active).loadQueue()).toEqual([row])
  })

  it('keeps the last committed queue if a chunk write fails', async () => {
    const storage = notebookStorage('pair-a', active)
    await storage.saveQueue([row])
    set.mockImplementationOnce(async (key, value) => { disk.set(key, value) })
      .mockRejectedValueOnce(new Error('interrupted'))
    await expect(storage.saveQueue([{ ...row, body: 'newer' }])).rejects.toThrow('interrupted')
    expect(await notebookStorage('pair-a', active).loadQueue()).toEqual([row])
    await storage.saveQueue([])
    expect(await notebookStorage('pair-a', active).loadQueue()).toEqual([])
    expect([...disk.values()].some(value => value.includes('写'))).toBe(false)
  })

  it('keeps both page and queue scoped to their paired computer and clears on unpair', async () => {
    const storage = notebookStorage('pair-a', active)
    const day = '2026-11-04'
    const page = { day, today: day, days: [], entries: [], paper: 'plain', penPending: false, pen: { font: 'kai', ink: 'blueBlack', reason: '' } }
    await storage.savePage(page)
    await storage.saveQueue([row])
    expect(await notebookStorage('pair-a', active).loadPage()).toEqual(page)
    expect(await notebookStorage('pair-b', active).loadPage()).toBeUndefined()
    expect(await notebookStorage('pair-b', active).loadQueue()).toBeUndefined()
    expect(disk.size).toBe(0)
    await storage.saveQueue([row])
    await clearNotebookStorage(active)
    expect(disk.size).toBe(0)
  })
})
