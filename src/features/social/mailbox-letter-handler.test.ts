import { describe, it, expect, vi } from 'vitest'
import { makeMailboxLetterHandler } from './mailbox-letter-handler'

describe('makeMailboxLetterHandler (I1 own-channel guard)', () => {
  it('routes an own-channel letter to receiveLetter', async () => {
    const receiveLetter = vi.fn(() => ({ ok: true }))
    const h = makeMailboxLetterHandler({ getByMyChannelId: (c) => c === 'mine' ? { id: 'r1' } : null, receiveLetter })
    expect(await h!({ agent_id: 'x', channel_id: 'mine', nonce: 'n', ct: 'c', tag: 't' })).toEqual({ ok: true })
    expect(receiveLetter).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'mine', ct: 'c' }))
  })
  it('DROPS a non-own-channel letter — never forwards (routeLetter is unreachable)', async () => {
    const receiveLetter = vi.fn(() => ({ ok: true }))
    const h = makeMailboxLetterHandler({ getByMyChannelId: () => null, receiveLetter })
    expect(await h!({ agent_id: 'attacker', channel_id: 'not-mine', nonce: 'n', ct: 'c', tag: 't' })).toEqual({ ok: false, error: 'unknown_channel' })
    expect(receiveLetter).not.toHaveBeenCalled()
  })
})
