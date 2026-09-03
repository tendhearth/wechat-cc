import { describe, expect, it } from 'vitest'
import { openDb } from '../lib/db'
import { makeTurnRecordStore, TURN_RECORDS_MAX_PER_CHAT } from './turn-record-store'
import type { TurnRecord } from './conversation-coordinator'

function rec(over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    chatId: 'chat-1',
    provider: 'claude',
    alias: 'a',
    mode: 'solo',
    startedAt: 1000,
    endedAt: 1200,
    durationMs: 200,
    outcome: 'completed',
    replyToolCalled: true,
    textChunks: 2,
    ...over,
  }
}

describe('turn-record-store', () => {
  it('append() round-trips a record (camelCase shape, bool mapping) via recentForChat', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ outcome: 'timeout', error: 'turn timed out', replyToolCalled: false }))
    const rows = store.recentForChat('chat-1', 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      chatId: 'chat-1', provider: 'claude', alias: 'a', mode: 'solo',
      startedAt: 1000, endedAt: 1200, durationMs: 200,
      outcome: 'timeout', replyToolCalled: false, textChunks: 2, error: 'turn timed out',
    })
    expect(typeof rows[0]!.id).toBe('string')
  })

  it('recentForChat orders newest-first and respects the limit', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ endedAt: 100, textChunks: 1 }))
    store.append(rec({ endedAt: 300, textChunks: 3 }))
    store.append(rec({ endedAt: 200, textChunks: 2 }))
    const rows = store.recentForChat('chat-1', 2)
    expect(rows.map(r => r.endedAt)).toEqual([300, 200])
  })

  it('recentForChat filters by chatId', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ chatId: 'chat-A' }))
    store.append(rec({ chatId: 'chat-B' }))
    expect(store.recentForChat('chat-A', 10)).toHaveLength(1)
    expect(store.recentForChat('chat-A', 10)[0]!.chatId).toBe('chat-A')
  })

  it('recent() returns the newest turns across all chats', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ chatId: 'chat-A', endedAt: 100 }))
    store.append(rec({ chatId: 'chat-B', endedAt: 300 }))
    store.append(rec({ chatId: 'chat-C', endedAt: 200 }))
    const rows = store.recent(2)
    expect(rows.map(r => r.chatId)).toEqual(['chat-B', 'chat-C'])
  })

  it('prunes to TURN_RECORDS_MAX_PER_CHAT newest rows per chat on append', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    const N = TURN_RECORDS_MAX_PER_CHAT
    for (let i = 0; i < N + 5; i++) store.append(rec({ endedAt: 1000 + i }))
    const rows = store.recentForChat('chat-1', N + 100)
    expect(rows).toHaveLength(N)
    // The 5 oldest (endedAt 1000..1004) were pruned; newest survives.
    expect(rows[0]!.endedAt).toBe(1000 + (N + 5) - 1)
    expect(rows[rows.length - 1]!.endedAt).toBe(1000 + 5)
  })

  it('pruning is per-chat — a busy chat does not evict another chat', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ chatId: 'quiet', endedAt: 1 }))
    for (let i = 0; i < TURN_RECORDS_MAX_PER_CHAT + 10; i++) store.append(rec({ chatId: 'busy', endedAt: 1000 + i }))
    expect(store.recentForChat('quiet', 10)).toHaveLength(1)
  })

  it('truncates an overlong error string', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ outcome: 'error', error: 'x'.repeat(20_000) }))
    const r = store.recentForChat('chat-1', 1)[0]!
    expect(r.error!.length).toBeLessThanOrEqual(8192)
  })
})

// 2026-09-02:owner 要「app 里也可以查询」某条回答是不是联网查来的。
// 前提是它得落库 —— 日志会滚动,而且不能查。
describe('tool_calls —— 一条回答是「查来的」还是「想出来的」', () => {
  it('存下来、读回来,并且去重', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append({
      chatId: 'c1', provider: 'agy', alias: 'a', mode: 'solo',
      startedAt: 1, endedAt: 2, durationMs: 1, outcome: 'completed',
      replyToolCalled: false, textChunks: 3,
      toolCalls: ['search_web', 'search_web', 'wechat/reply'],
    })
    expect(store.recentForChat('c1', 10)[0]!.toolCalls).toEqual(['search_web', 'wechat/reply'])
  })

  it('没调工具 → 空数组', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append({
      chatId: 'c1', provider: 'claude', alias: 'a', mode: 'solo',
      startedAt: 1, endedAt: 2, durationMs: 1, outcome: 'completed',
      replyToolCalled: true, textChunks: 1, toolCalls: [],
    })
    expect(store.recentForChat('c1', 10)[0]!.toolCalls).toEqual([])
  })

  it('v35 之前的老行读出来也是空数组(表示「不知道」,不是「没调」)', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append({
      chatId: 'c1', provider: 'claude', alias: 'a', mode: 'solo',
      startedAt: 1, endedAt: 2, durationMs: 1, outcome: 'completed',
      replyToolCalled: true, textChunks: 1,
    })
    db.exec("UPDATE turn_records SET tool_calls = NULL")
    expect(store.recentForChat('c1', 10)[0]!.toolCalls).toEqual([])
  })

  it('坏 JSON 不炸,退成空数组', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append({
      chatId: 'c1', provider: 'claude', alias: 'a', mode: 'solo',
      startedAt: 1, endedAt: 2, durationMs: 1, outcome: 'completed',
      replyToolCalled: true, textChunks: 1, toolCalls: ['x'],
    })
    db.exec("UPDATE turn_records SET tool_calls = '{oops'")
    expect(store.recentForChat('c1', 10)[0]!.toolCalls).toEqual([])
  })
})
