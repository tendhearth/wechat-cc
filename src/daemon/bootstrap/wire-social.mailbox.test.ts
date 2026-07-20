import { describe, it, expect } from 'vitest'
import { peerMailboxOf } from './mailbox-dispatch-seam'
import type { A2AAgentRecord } from '../../lib/agent-config'

const base: A2AAgentRecord = { id: 'p', name: 'P', url: 'http://x/a2a', inbound_api_key: '0123456789abcdef', outbound_api_key: 'k', capabilities: [], paused: false, transport: 'push' }

describe('peerMailboxOf', () => {
  it('returns the PeerMailbox for a complete mailbox record', () => {
    expect(peerMailboxOf({ ...base, transport: 'mailbox', mailbox_addr: 'A', mailbox_enc_pub: 'E', relays: ['https://r/'] }))
      .toEqual({ addr: 'A', enc_pub: 'E', relays: ['https://r/'] })
  })
  it('returns null for push, or mailbox with missing fields', () => {
    expect(peerMailboxOf(base)).toBeNull()
    expect(peerMailboxOf({ ...base, transport: 'mailbox', mailbox_addr: 'A' })).toBeNull()
  })
})
