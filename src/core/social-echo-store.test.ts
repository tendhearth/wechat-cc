import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeEchoStore } from './social-echo-store'

describe('makeEchoStore', () => {
  it('creates pending echoes, lists by seek + all, and updates status', () => {
    const db = openDb({ path: ':memory:' })
    const e = makeEchoStore(db)
    e.create({ id: 'e1', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: '我认识个老师傅' })
    e.create({ id: 'e2', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: '我家布偶生了一窝' })
    expect(e.get('e1')!.status).toBe('pending')
    expect(e.listForSeek('k1').map(r => r.id).sort()).toEqual(['e1', 'e2'])
    e.setStatus('e1', 'revealed')
    expect(e.get('e1')!.status).toBe('revealed')
    expect(e.listAll().length).toBe(2)
  })
})
