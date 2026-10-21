import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeSpeechLedgerStore, SPEECH_LOG_RETENTION_MS } from './ledger-store'
import type { SpeechLedgerEntry } from './policy'

const entry = (ts: string, o: Partial<SpeechLedgerEntry> = {}): SpeechLedgerEntry => ({ kind: 'companion', origin: 'initiative', chatId: 'owner', outcome: 'allowed', reason: null, channel: 'wechat', ts, ...o })

describe('speech_log 外发账', () => {
  it('写进去、按对话按时间读回来(新的在前);只有种类和原因', () => {
    const db = openTestDb()
    try {
      const s = makeSpeechLedgerStore(db)
      s.append(entry('2026-10-21T08:00:00.000Z'))
      s.append(entry('2026-10-21T09:00:00.000Z', { kind: 'guest_visit', outcome: 'dropped', reason: 'care_off', channel: null }))
      s.append(entry('2026-10-21T09:30:00.000Z', { chatId: 'other' }))
      expect(s.recent('owner', Date.parse('2026-10-21T00:00:00.000Z'))).toEqual([
        entry('2026-10-21T09:00:00.000Z', { kind: 'guest_visit', outcome: 'dropped', reason: 'care_off', channel: null }),
        entry('2026-10-21T08:00:00.000Z'),
      ])
    } finally { db.close() }
  })
  it('90 天前的行在写入时顺手删(一小时最多删一次)', () => {
    const db = openTestDb()
    try {
      let now = Date.parse('2026-10-21T00:00:00.000Z')
      const s = makeSpeechLedgerStore(db, { now: () => now })
      s.append(entry(new Date(now).toISOString()))
      s.append(entry(new Date(now - SPEECH_LOG_RETENTION_MS - 1000).toISOString()))
      // 第一次写时删过一轮(那时老的那行还没进来)⇒ 还在;一小时之内再写不删
      expect(s.recent('owner', 0)).toHaveLength(2)
      now += 60 * 60_000 + 1
      s.append(entry(new Date(now).toISOString()))
      expect(s.recent('owner', 0).map(e => e.ts)).toEqual([new Date(now).toISOString(), '2026-10-21T00:00:00.000Z'])
    } finally { db.close() }
  })
})
