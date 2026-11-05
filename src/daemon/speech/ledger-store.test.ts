import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeSpeechLedgerStore, mergeChannels, SPEECH_LOG_RETENTION_MS } from './ledger-store'
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
  it('带 ref 的同一个事件只有一行(S3a):第二条路问同一件事 ⇒ 改那一行、通道追加;不带 ref 的照旧一判一行', () => {
    const db = openTestDb()
    try {
      const s = makeSpeechLedgerStore(db)
      const R = 'turn:t1:2'
      s.append(entry('2026-11-05T08:00:00.000Z', { kind: 'matter_report', origin: 'report', channel: 'app', ref: R }))
      s.append(entry('2026-11-05T08:00:01.000Z', { kind: 'matter_report', origin: 'report', channel: 'wechat', ref: R }))
      s.append(entry('2026-11-05T08:00:02.000Z', { kind: 'matter_report', origin: 'report', channel: 'app', ref: R }))
      s.append(entry('2026-11-05T08:00:03.000Z', { kind: 'matter_report', origin: 'report', channel: 'wechat' }))
      s.append(entry('2026-11-05T08:00:04.000Z', { kind: 'matter_report', origin: 'report', channel: 'wechat' }))
      expect(db.query('SELECT ref,channel,outcome FROM speech_log ORDER BY id').all()).toEqual([
        { ref: R, channel: 'app+wechat', outcome: 'allowed' },
        { ref: null, channel: 'wechat', outcome: 'allowed' },
        { ref: null, channel: 'wechat', outcome: 'allowed' },
      ])
      expect(s.recent('owner', 0).at(-1)).toEqual({ ...entry('2026-11-05T08:00:02.000Z', { kind: 'matter_report', origin: 'report', ref: R }), channel: 'app+wechat' })
    } finally { db.close() }
  })
  it('带 ref:先推后、后放行 ⇒ 还是一行,结果是放行;已经放行了,另一条路被推后 / 失败 ⇒ 那一行不动', () => {
    const db = openTestDb()
    try {
      const s = makeSpeechLedgerStore(db)
      s.append(entry('2026-11-05T01:00:00.000Z', { kind: 'matter_report', origin: 'report', outcome: 'deferred', reason: 'quiet', channel: null, ref: 'turn:a:1' }))
      s.append(entry('2026-11-05T07:00:00.000Z', { kind: 'matter_report', origin: 'report', channel: 'app', ref: 'turn:a:1' }))
      s.append(entry('2026-11-05T07:00:01.000Z', { kind: 'matter_report', origin: 'report', outcome: 'deferred', reason: 'undeliverable', channel: null, ref: 'turn:a:1' }))
      s.append(entry('2026-11-05T07:00:02.000Z', { kind: 'matter_report', origin: 'report', outcome: 'failed', reason: 'boom', channel: 'wechat', ref: 'turn:a:1' }))
      expect(db.query('SELECT at,outcome,reason,channel FROM speech_log').all()).toEqual([
        { at: Date.parse('2026-11-05T07:00:00.000Z'), outcome: 'allowed', reason: null, channel: 'app' },
      ])
    } finally { db.close() }
  })
  it('mergeChannels:按先后追加、不重复、空的不算', () => {
    expect(mergeChannels(null, 'app')).toBe('app')
    expect(mergeChannels('app', 'wechat')).toBe('app+wechat')
    expect(mergeChannels('app+wechat', 'app')).toBe('app+wechat')
    expect(mergeChannels('app', null)).toBe('app')
    expect(mergeChannels(null, null)).toBeNull()
  })
})
