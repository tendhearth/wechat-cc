import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeNightlySources } from './nightly-sources'

describe('makeNightlySources.messagesSince', () => {
  it('keeps the NEWEST 200 text messages since `from`, in chronological order', async () => {
    const db = openTestDb()
    const store = makeMessagesStore(db)
    const from = '2026-09-20T00:00:00.000Z'
    // 一条在 from 之前,不该出现
    await store.append({ id: 'old', chatId: 'owner', ts: '2026-09-19T00:00:00.000Z', direction: 'in', kind: 'text', text: 'before-from', source: 'live' })
    const base = Date.parse('2026-09-21T00:00:00.000Z')
    for (let i = 0; i < 450; i++) {
      await store.append({ id: `m${i}`, chatId: 'owner', ts: new Date(base + i * 60_000).toISOString(), direction: 'in', kind: 'text', text: `msg#${i}#`, source: 'live' })
    }
    const lines = await makeNightlySources({ db, stateDir: '/nonexistent', ownerChatId: () => 'owner' }).messagesSince(from)
    expect(lines).toHaveLength(200)
    const text = (l: string | { text: string }) => (typeof l === 'string' ? l : l.text)
    expect(text(lines[0]!)).toContain('msg#250#')
    expect(text(lines[199]!)).toContain('msg#449#')
    expect(lines.some(l => text(l).includes('before-from'))).toBe(false)
    // 出处(10-20):每行带消息 id 与时间
    expect(lines[0]).toMatchObject({ id: 'm250', ts: new Date(base + 250 * 60_000).toISOString() })
  })
})
