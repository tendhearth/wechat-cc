import * as SecureStore from 'expo-secure-store'
import { NotebookBody, NotebookDay, NotebookEntry, NotebookPageResponse, type NotebookEntryT, type NotebookPageResponseT } from '@wechat-cc/protocol'
import z from 'zod'

const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }
const keys = { page: 'tendhearth.notebook.page.v1', queue: 'tendhearth.notebook.queue.v1', receipts: 'tendhearth.notebook.receipts.v1' } as const
const pointerSchema = z.object({ scope: z.string(), bank: z.union([z.literal(0), z.literal(1)]), count: z.number().int().nonnegative() })
const pendingSchema = z.object({ clientId: z.string(), body: NotebookBody, day: NotebookDay.optional(), createdAt: z.number() }).array()
let operations = Promise.resolve()

function serial<T>(run: () => Promise<T>) {
  const result = operations.then(run)
  operations = result.then(() => {}, () => {})
  return result
}

async function readPointer(key: string) {
  const raw = await SecureStore.getItemAsync(key, options)
  return raw === null ? null : pointerSchema.parse(JSON.parse(raw))
}

async function clearBank(key: string, bank: number, keep = 0) {
  const prefix = `${key}.${bank}`
  const count = Number(await SecureStore.getItemAsync(`${prefix}.count`, options))
  for (let i = keep; i < count; i++) await SecureStore.deleteItemAsync(`${prefix}.${i}`, options)
  if (keep === 0 && count) await SecureStore.deleteItemAsync(`${prefix}.count`, options)
}

async function clear(key: string) {
  await Promise.all([clearBank(key, 0), clearBank(key, 1)])
  await SecureStore.deleteItemAsync(key, options)
}

export function clearNotebookStorage(current: () => boolean) {
  return serial(async () => {
    if (current()) await Promise.all(Object.values(keys).map(clear))
  })
}

async function read<T>(key: string, scope: string, parse: (value: unknown) => T): Promise<T | undefined> {
  const pointer = await readPointer(key)
  if (!pointer) return
  if (pointer.scope !== scope) {
    await clear(key)
    return
  }
  let json = ''
  for (let start = 0; start < pointer.count; start += 8) {
    const parts = await Promise.all(Array.from({ length: Math.min(8, pointer.count - start) }, (_, i) =>
      SecureStore.getItemAsync(`${key}.${pointer.bank}.${start + i}`, options)))
    if (parts.some(part => part === null)) throw new Error('notebook_storage_incomplete')
    json += parts.join('')
  }
  return parse(JSON.parse(json))
}

/** SecureStore values are kept below 1800 UTF-8 bytes. Switching the pointer last keeps the previous committed value on a partial write. */
async function write(key: string, scope: string, json: string, current: () => boolean) {
  if (!current()) return
  const previous = await readPointer(key)
  const bank = previous?.bank === 0 ? 1 : 0
  const prefix = `${key}.${bank}`
  const parts = json.match(/[^]{1,450}/gu) ?? []
  const oldCount = Number(await SecureStore.getItemAsync(`${prefix}.count`, options))
  await SecureStore.setItemAsync(`${prefix}.count`, String(Math.max(oldCount, parts.length)), options)
  for (let i = 0; i < parts.length; i++) {
    await SecureStore.setItemAsync(`${prefix}.${i}`, parts[i]!, options)
  }
  await clearBank(key, bank, parts.length)
  await SecureStore.setItemAsync(`${prefix}.count`, String(parts.length), options)
  if (!current()) return
  await SecureStore.setItemAsync(key, JSON.stringify({ scope, bank, count: parts.length }), options)
  if (previous) await clearBank(key, previous.bank).catch(() => {})
}

export function notebookStorage(scope: string, current: () => boolean) {
  const committed = new Map<string, string>()
  const save = async (key: string, value: unknown) => {
    const json = JSON.stringify(value)
    if (!current() || committed.get(key) === json) return
    await write(key, scope, json, current)
    if (current()) committed.set(key, json)
  }
  const readReceipts = async () => (await read(keys.receipts, scope, value => NotebookEntry.array().parse(value))) ?? []
  return {
    loadPage: () => serial(async () => current() ? read(keys.page, scope, value => NotebookPageResponse.parse(value)) : undefined),
    loadQueue: () => serial(async () => current() ? read(keys.queue, scope, value => pendingSchema.parse(value)) : undefined),
    loadReceipts: () => serial(async () => current() ? readReceipts() : []),
    saveReceipt: (entry: NotebookEntryT) => serial(async () => {
      if (!current()) return
      const receipts = await readReceipts()
      await save(keys.receipts, [...receipts.filter(row => row.id !== entry.id), entry])
    }),
    savePage: (page: NotebookPageResponseT) => serial(async () => {
      await save(keys.page, page)
      if (!current()) return
      const receipts = await readReceipts()
      const ids = new Set(page.entries.map(entry => entry.id))
      const remaining = receipts.filter(row => row.day !== page.day || !ids.has(row.id))
      if (remaining.length !== receipts.length) await save(keys.receipts, remaining)
    }),
    saveQueue: (queue: unknown) => serial(() => save(keys.queue, queue)),
  }
}
