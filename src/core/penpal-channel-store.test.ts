import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeChannelStore } from './penpal-channel-store'

describe('makeChannelStore', () => {
  it('creates a pending channel, looks it up by id + my_channel_id, opens it on peer handle', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeChannelStore(db)
    s.create({ id: 'i1:ccb', seekId: 'i1', myPrivkey: 'PRIV', myPubkey: 'PUB', myChannelId: 'chan-A', degree: 1, peerAgentId: 'ccb' })
    const row = s.get('i1:ccb')!
    expect(row.status).toBe('pending')
    expect(row.peer_pubkey).toBeNull()
    expect(row.my_channel_id).toBe('chan-A')
    expect(s.getByMyChannelId('chan-A')!.id).toBe('i1:ccb')

    s.setPeerHandle('i1:ccb', { pubkey: 'PEERPUB', channel_id: 'chan-B' })
    const opened = s.get('i1:ccb')!
    expect(opened.status).toBe('open')
    expect(opened.peer_pubkey).toBe('PEERPUB')
    expect(opened.peer_channel_id).toBe('chan-B')
  })

  it('getByMyChannelId returns null for an unknown address', () => {
    const s = makeChannelStore(openDb({ path: ':memory:' }))
    expect(s.getByMyChannelId('nope')).toBeNull()
  })
})
