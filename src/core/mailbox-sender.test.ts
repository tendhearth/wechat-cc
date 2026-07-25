import { describe, it, expect } from 'vitest'
import { makeMailboxSender } from './mailbox-sender'
import { generateMailboxIdentity, openEnvelope } from './mailbox-crypto'
import type { MailboxClient } from './mailbox-client'

describe('makeMailboxSender', () => {
  it('seals the inner to the peer enc_pub and drops the opaque envelope to each relay', async () => {
    const peer = generateMailboxIdentity()
    const dropped: Array<{ relay: string; to: string; envelope: string }> = []
    const client: MailboxClient = {
      drop: async (relay, to, envelope) => { dropped.push({ relay, to, envelope }); return true },
      fetch: async () => null, ack: async () => true,
    }
    const ok = await makeMailboxSender({ client }).send(
      { path: '/a2a/letter', bearer: 'b', body: { hi: 1 } },
      { addr: peer.addr, enc_pub: peer.enc_pub, relays: ['https://r1/', 'https://r2/'] },
    )
    expect(ok).toBe(true)
    expect(dropped.map(d => d.relay)).toEqual(['https://r1/', 'https://r2/'])
    expect(dropped[0]!.to).toBe(peer.addr)
    // the relay-visible payload is an opaque string; only the peer can open it
    const env = JSON.parse(dropped[0]!.envelope)
    expect(openEnvelope(peer.enc_priv, env)).toEqual({ path: '/a2a/letter', bearer: 'b', body: { hi: 1 } })
  })
  it('returns false when every relay drop fails, and never throws', async () => {
    const peer = generateMailboxIdentity()
    const client: MailboxClient = { drop: async () => false, fetch: async () => null, ack: async () => true }
    expect(await makeMailboxSender({ client }).send({ path: '/p', bearer: 'b', body: 0 }, { addr: peer.addr, enc_pub: peer.enc_pub, relays: ['https://r/'] })).toBe(false)
  })
})
