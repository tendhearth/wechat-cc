import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore, type MessageRecord } from '../../lib/messages-store'
import { recentInboundTexts } from './recent-inbound'

function rec(id: string, dir: 'in' | 'out', text: string, ts: string, kind = 'text'): MessageRecord {
  return { id, chatId: 'chat1', ts, direction: dir, kind, text, source: 'live' }
}

describe('recentInboundTexts', () => {
  it('returns only inbound texts, ascending, skipping commands and empties', async () => {
    const store = makeMessagesStore(openTestDb() as never)
    await store.append(rec('1', 'in', 'hello', '2026-08-01T00:00:01Z'))
    await store.append(rec('2', 'out', 'reply', '2026-08-01T00:00:02Z'))
    await store.append(rec('3', 'in', 'second', '2026-08-01T00:00:03Z'))
    await store.append(rec('4', 'in', '/health', '2026-08-01T00:00:04Z', 'command'))
    await store.append(rec('5', 'in', '  ', '2026-08-01T00:00:05Z'))
    expect(await recentInboundTexts(store, 'chat1', 10)).toEqual(['hello', 'second'])
  })

  it('caps to the newest `limit` inbound messages', async () => {
    const store = makeMessagesStore(openTestDb() as never)
    for (let i = 0; i < 15; i++) {
      await store.append(rec(String(i), 'in', `m${i}`, `2026-08-01T00:00:${String(i).padStart(2, '0')}Z`))
    }
    const out = await recentInboundTexts(store, 'chat1', 10)
    expect(out).toHaveLength(10)
    expect(out[0]).toBe('m5')
    expect(out[9]).toBe('m14')
  })

  it('other chats do not leak in', async () => {
    const store = makeMessagesStore(openTestDb() as never)
    await store.append(rec('1', 'in', 'mine', '2026-08-01T00:00:01Z'))
    await store.append({ ...rec('2', 'in', 'theirs', '2026-08-01T00:00:02Z'), chatId: 'chat2' })
    expect(await recentInboundTexts(store, 'chat1')).toEqual(['mine'])
  })

  it('empty store → empty array', async () => {
    const store = makeMessagesStore(openTestDb() as never)
    expect(await recentInboundTexts(store, 'chat1')).toEqual([])
  })
})
