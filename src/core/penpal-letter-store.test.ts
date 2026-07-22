import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeLetterStore } from './penpal-letter-store'

describe('makeLetterStore', () => {
  it('stores in/out letters per channel, newest-first, and marks read', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeLetterStore(db)
    s.create({ id: 'l1', channelId: 'c1', direction: 'in', sealedCiphertext: 'CT1', nonce: 'N1', tag: 'T1', plaintext: '你好' })
    s.create({ id: 'l2', channelId: 'c1', direction: 'out', sealedCiphertext: 'CT2', nonce: 'N2', tag: 'T2', plaintext: '回信了' })
    s.create({ id: 'l3', channelId: 'c2', direction: 'in', sealedCiphertext: 'CT3', nonce: 'N3', tag: 'T3', plaintext: '别的通道' })

    expect(s.listForChannel('c1').map(r => r.id)).toEqual(['l2', 'l1'])   // newest first
    expect(s.get('l1')!.plaintext).toBe('你好')
    expect(s.get('l1')!.read_at).toBeNull()
    s.markRead('l1', '2026-07-18T00:00:00.000Z')
    expect(s.get('l1')!.read_at).toBe('2026-07-18T00:00:00.000Z')
  })
})

describe('unread bookkeeping (信箱)', () => {
  it('unreadCountByChannel 只计 inbound 未读,按信道分组', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeLetterStore(db)
    s.create({ id: 'a1', channelId: 'c1', direction: 'in',  sealedCiphertext: 'x', nonce: 'n1', tag: 't', plaintext: 'p1' })
    s.create({ id: 'a2', channelId: 'c1', direction: 'in',  sealedCiphertext: 'x', nonce: 'n2', tag: 't', plaintext: 'p2' })
    s.create({ id: 'a3', channelId: 'c1', direction: 'out', sealedCiphertext: 'x', nonce: 'n3', tag: 't', plaintext: 'p3' })
    s.create({ id: 'b1', channelId: 'c2', direction: 'in',  sealedCiphertext: 'x', nonce: 'n4', tag: 't', plaintext: 'p4' })
    s.markRead('b1', '2026-07-22T00:00:00.000Z')
    const rows = s.unreadCountByChannel()
    expect(rows).toEqual([{ channel_id: 'c1', n: 2 }])   // out 不计;已读的 c2 消失
  })

  it('markAllRead 只动该信道的 inbound 未读行', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeLetterStore(db)
    s.create({ id: 'a1', channelId: 'c1', direction: 'in',  sealedCiphertext: 'x', nonce: 'n1', tag: 't', plaintext: 'p1' })
    s.create({ id: 'a2', channelId: 'c1', direction: 'out', sealedCiphertext: 'x', nonce: 'n2', tag: 't', plaintext: 'p2' })
    s.create({ id: 'b1', channelId: 'c2', direction: 'in',  sealedCiphertext: 'x', nonce: 'n3', tag: 't', plaintext: 'p3' })
    s.markAllRead('c1', '2026-07-22T01:00:00.000Z')
    expect(s.get('a1')!.read_at).toBe('2026-07-22T01:00:00.000Z')
    expect(s.get('a2')!.read_at).toBeNull()               // outbound 不动
    expect(s.get('b1')!.read_at).toBeNull()               // 别的信道不动
    expect(s.unreadCountByChannel()).toEqual([{ channel_id: 'c2', n: 1 }])
  })
})
