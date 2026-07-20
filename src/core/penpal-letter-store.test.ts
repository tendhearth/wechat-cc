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
