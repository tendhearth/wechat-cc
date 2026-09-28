import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../../lib/db'
import { wireA2a } from './wire-a2a'

describe('wireA2a', () => {
  it('conversations 空 ⇒ null 且不缓存;有行后 ⇒ 最早 updated_at 的 chat 并缓存正命中', () => {
    const db = openTestDb()
    const s = wireA2a({ stateDir: mkdtempSync(join(tmpdir(), 'wa-')), db })
    expect(s.a2aRegistry).toBeDefined()
    expect(s.a2aClient).toBeDefined()
    expect(s.a2aEventsStore).toBeDefined()
    expect(s.resolveOperatorChatId()).toBeNull()
    // 列见 src/lib/db.ts:77(STRICT 表,updated_at 是 TEXT)
    db.exec("INSERT INTO conversations (chat_id, mode_kind, updated_at) VALUES ('b', 'solo', '2026-01-02T00:00:00Z'), ('a', 'solo', '2026-01-01T00:00:00Z')")
    expect(s.resolveOperatorChatId()).toBe('a')
    db.exec('DELETE FROM conversations')
    expect(s.resolveOperatorChatId()).toBe('a')   // 只缓存正命中
  })
})
