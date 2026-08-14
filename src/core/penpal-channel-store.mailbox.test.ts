/**
 * peer_mailbox additive plumbing (Task 9) — setPeerHandle carries an
 * optional PeerMailbox through to the row; peerMailboxOfRow parses it back.
 * Nothing populates handle.mailbox at the source yet (Task 10's C1 fix);
 * this only proves the column + round-trip exist.
 */
import { describe, it, expect } from 'vitest'
import { openTestDb } from '../lib/db'
import { makeChannelStore, peerMailboxOfRow } from './penpal-channel-store'

describe('penpal-channel-store peer_mailbox', () => {
  it('setPeerHandle persists a crossed mailbox and get() returns it', () => {
    const store = makeChannelStore(openTestDb())
    store.create({ id: 'r1', seekId: 's1', myPrivkey: 'pk', myPubkey: 'pub', myChannelId: 'mc', degree: 1, peerAgentId: 'q' })
    store.setPeerHandle('r1', { pubkey: 'ppub', channel_id: 'pc', mailbox: { addr: 'A', enc_pub: 'E', relays: ['https://r/'] } })
    const row = store.get('r1')!
    expect(row.peer_pubkey).toBe('ppub')
    expect(row.status).toBe('open')
    expect(JSON.parse(row.peer_mailbox!)).toEqual({ addr: 'A', enc_pub: 'E', relays: ['https://r/'] })
    expect(peerMailboxOfRow(row)).toEqual({ addr: 'A', enc_pub: 'E', relays: ['https://r/'] })
  })

  it('setPeerHandle with no mailbox leaves peer_mailbox null (push peer)', () => {
    const store = makeChannelStore(openTestDb())
    store.create({ id: 'r2', seekId: 's', myPrivkey: 'pk', myPubkey: 'pub', myChannelId: 'mc', degree: 0, peerAgentId: 'q' })
    store.setPeerHandle('r2', { pubkey: 'ppub', channel_id: 'pc' })
    const row = store.get('r2')!
    expect(row.peer_mailbox).toBeNull()
    expect(peerMailboxOfRow(row)).toBeNull()
  })
})
