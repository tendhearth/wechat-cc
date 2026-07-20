import { describe, it, expect } from 'vitest'
import { A2AAgentRecord } from './agent-config'

describe('A2AAgentRecord mailbox fields', () => {
  it('accepts transport:mailbox with addr/enc_pub/relays', () => {
    const rec = A2AAgentRecord.parse({
      id: 'peer', name: 'Peer', url: 'http://x/a2a', inbound_api_key: '0123456789abcdef', outbound_api_key: 'k',
      capabilities: [], transport: 'mailbox', mailbox_addr: 'ED', mailbox_enc_pub: 'X', relays: ['https://relay.example/'],
    })
    expect(rec.transport).toBe('mailbox'); expect(rec.mailbox_addr).toBe('ED'); expect(rec.relays).toEqual(['https://relay.example/'])
  })
  it('still accepts a push record with no mailbox fields (backward compatible)', () => {
    const rec = A2AAgentRecord.parse({ id: 'p', name: 'P', url: 'http://x/a2a', inbound_api_key: '0123456789abcdef', outbound_api_key: 'k', capabilities: [] })
    expect(rec.transport).toBe('push'); expect(rec.mailbox_addr).toBeUndefined()
  })
})
