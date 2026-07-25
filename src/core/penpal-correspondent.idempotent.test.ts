import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makeChannelStore } from './penpal-channel-store'
import { makeLetterStore } from './penpal-letter-store'
import { makeCorrespondent } from './penpal-correspondent'
import { generateKeypair, deriveSharedKey, sealLetter } from './penpal-crypto'

describe('receiveLetter idempotency (M3)', () => {
  it('a re-delivered letter (same channel_id+nonce) creates no duplicate row and does not re-notify', () => {
    const db = openDb({ path: ':memory:' })
    const channelStore = makeChannelStore(db); const letterStore = makeLetterStore(db)
    const me = generateKeypair(); const peer = generateKeypair()
    channelStore.create({ id: 'r1', seekId: 's', myPrivkey: me.privateKey, myPubkey: me.publicKey, myChannelId: 'mc', degree: 0, peerAgentId: 'q' })
    channelStore.setPeerHandle('r1', { pubkey: peer.publicKey, channel_id: 'pc' })
    const sealed = sealLetter(deriveSharedKey(peer.privateKey, me.publicKey), 'hello')
    const notify = vi.fn()
    const c = makeCorrespondent({ channelStore, letterStore, postLetter: async () => true, notifyInbound: notify })
    const ev = { channel_id: 'mc', nonce: sealed.nonce, ct: sealed.ct, tag: sealed.tag }
    expect(c.receiveLetter(ev)).toEqual({ ok: true })
    expect(c.receiveLetter(ev)).toEqual({ ok: true })          // re-delivery
    expect(letterStore.listForChannel('r1').filter(l => l.direction === 'in')).toHaveLength(1)   // no dup
    expect(notify).toHaveBeenCalledTimes(1)                     // no re-notify
  })
})
