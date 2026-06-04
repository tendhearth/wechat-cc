import { describe, it, expect } from 'vitest'
import { groupChats } from './sessions-helpers'
import type { SessionRecord } from '../core/session-store'

function rec(p: Partial<SessionRecord>): SessionRecord {
  return {
    alias: 'a', provider: 'claude', chat_id: 'c', session_id: 's',
    last_used_at: '2026-06-01T00:00:00.000Z', summary: null, summary_updated_at: null,
    ...p,
  } as SessionRecord
}

describe('groupChats', () => {
  it('groups records by chat_id, counts distinct aliases, takes max last_used_at, sorts desc', () => {
    const records = [
      rec({ chat_id: 'c1', alias: 'wechat-cc', last_used_at: '2026-06-01T10:00:00.000Z' }),
      rec({ chat_id: 'c1', alias: 'blog',      last_used_at: '2026-06-03T10:00:00.000Z' }),
      rec({ chat_id: 'c1', alias: 'blog', provider: 'codex', last_used_at: '2026-06-02T10:00:00.000Z' }),
      rec({ chat_id: 'c2', alias: 'wechat-cc', last_used_at: '2026-06-04T10:00:00.000Z' }),
    ]
    const nameOf = (id: string) => (id === 'c1' ? '小白' : null)
    const accountOf = (id: string) => (id === 'c1' ? 'bot1' : null)
    const out = groupChats(records, nameOf, accountOf)
    expect(out).toEqual([
      { chat_id: 'c2', user_name: null, account_id: null, session_count: 1, last_used_at: '2026-06-04T10:00:00.000Z' },
      { chat_id: 'c1', user_name: '小白', account_id: 'bot1', session_count: 2, last_used_at: '2026-06-03T10:00:00.000Z' },
    ])
  })

  it('returns [] for no records', () => {
    expect(groupChats([], () => null, () => null)).toEqual([])
  })
})
