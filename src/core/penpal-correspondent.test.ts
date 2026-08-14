import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makeChannelStore } from './penpal-channel-store'
import { makeLetterStore } from './penpal-letter-store'
import { generateKeypair } from './penpal-crypto'
import { makeCorrespondent } from './penpal-correspondent'

/** Sets up two independent in-memory dbs (A and B), each with its own
 *  channel/letter stores, and opens a channel on both sides by hand with
 *  crossed keypairs — mirrors what the reveal flow would have done. */
function makeCrossedChannels() {
  const a = generateKeypair()
  const b = generateKeypair()

  const dbA = openDb({ path: ':memory:' })
  const channelStoreA = makeChannelStore(dbA)
  const letterStoreA = makeLetterStore(dbA)
  channelStoreA.create({ id: 'a:chan', seekId: 'seek-a', myPrivkey: a.privateKey, myPubkey: a.publicKey, myChannelId: 'chan-A', degree: 1, peerAgentId: 'ccb' })
  channelStoreA.setPeerHandle('a:chan', { pubkey: b.publicKey, channel_id: 'chan-B' })

  const dbB = openDb({ path: ':memory:' })
  const channelStoreB = makeChannelStore(dbB)
  const letterStoreB = makeLetterStore(dbB)
  channelStoreB.create({ id: 'b:chan', seekId: 'seek-b', myPrivkey: b.privateKey, myPubkey: b.publicKey, myChannelId: 'chan-B', degree: 1, peerAgentId: 'cca' })
  channelStoreB.setPeerHandle('b:chan', { pubkey: a.publicKey, channel_id: 'chan-A' })

  return { channelStoreA, letterStoreA, channelStoreB, letterStoreB }
}

describe('makeCorrespondent', () => {
  it('seals an outbound letter, posts it to the peer channel_id, and persists an OUT row with local plaintext', async () => {
    const { channelStoreA, letterStoreA } = makeCrossedChannels()
    const postLetter = vi.fn().mockResolvedValue(true)
    const notifyInbound = vi.fn()
    const correspondent = makeCorrespondent({ channelStore: channelStoreA, letterStore: letterStoreA, postLetter, notifyInbound })

    const result = await correspondent.sendLetter('a:chan', '你好')
    expect(result).toEqual({ ok: true })

    expect(postLetter).toHaveBeenCalledTimes(1)
    const [target, body] = postLetter.mock.calls[0]!
    expect(target).toEqual({ agentId: 'ccb', relayVia: null })
    expect(body.channel_id).toBe('chan-B') // peer's inbound address
    expect(body.nonce).toBeTruthy()
    expect(body.ct).not.toContain('你好')
    expect(body.tag).toBeTruthy()

    const rows = letterStoreA.listForChannel('a:chan')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.direction).toBe('out')
    expect(rows[0]!.plaintext).toBe('你好')
    expect(rows[0]!.sealed_ciphertext).toBe(body.ct)
    expect(rows[0]!.nonce).toBe(body.nonce)
    expect(rows[0]!.tag).toBe(body.tag)
  })

  it('round-trips: A seals a letter, B opens it, recovers plaintext, and persists an IN row', async () => {
    const { channelStoreA, letterStoreA, channelStoreB, letterStoreB } = makeCrossedChannels()
    const postLetter = vi.fn().mockResolvedValue(true)
    const correspondentA = makeCorrespondent({ channelStore: channelStoreA, letterStore: letterStoreA, postLetter, notifyInbound: vi.fn() })

    await correspondentA.sendLetter('a:chan', '你好')
    const [, sealedBody] = postLetter.mock.calls[0]!

    const notifyInbound = vi.fn()
    const correspondentB = makeCorrespondent({ channelStore: channelStoreB, letterStore: letterStoreB, postLetter: vi.fn(), notifyInbound })
    const result = correspondentB.receiveLetter(sealedBody)

    expect(result).toEqual({ ok: true })
    const rows = letterStoreB.listForChannel('b:chan')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.direction).toBe('in')
    expect(rows[0]!.plaintext).toBe('你好')
    expect(notifyInbound).toHaveBeenCalledWith('b:chan', '你好'.slice(0, 40))
  })

  it('rejects a tampered ciphertext without persisting anything', async () => {
    const { channelStoreA, letterStoreA, channelStoreB, letterStoreB } = makeCrossedChannels()
    const postLetter = vi.fn().mockResolvedValue(true)
    const correspondentA = makeCorrespondent({ channelStore: channelStoreA, letterStore: letterStoreA, postLetter, notifyInbound: vi.fn() })
    await correspondentA.sendLetter('a:chan', '你好')
    const [, sealedBody] = postLetter.mock.calls[0]!

    const buf = Buffer.from(sealedBody.ct, 'base64url')
    buf[0]! ^= 0xff
    const tampered = { ...sealedBody, ct: buf.toString('base64url') }

    const notifyInbound = vi.fn()
    const correspondentB = makeCorrespondent({ channelStore: channelStoreB, letterStore: letterStoreB, postLetter: vi.fn(), notifyInbound })
    const result = correspondentB.receiveLetter(tampered)

    expect(result).toEqual({ ok: false, error: 'open_failed' })
    expect(letterStoreB.listForChannel('b:chan')).toHaveLength(0)
    expect(notifyInbound).not.toHaveBeenCalled()
  })

  it('drops a letter addressed to an unknown channel_id as a safe no-op', () => {
    const { channelStoreB, letterStoreB } = makeCrossedChannels()
    const notifyInbound = vi.fn()
    const correspondentB = makeCorrespondent({ channelStore: channelStoreB, letterStore: letterStoreB, postLetter: vi.fn(), notifyInbound })

    const result = correspondentB.receiveLetter({ channel_id: 'nope', nonce: 'N', ct: 'CT', tag: 'T' })

    expect(result).toEqual({ ok: false, error: 'unknown_channel' })
    expect(letterStoreB.listForChannel('b:chan')).toHaveLength(0)
    expect(notifyInbound).not.toHaveBeenCalled()
  })

  it('refuses to send on a channel that is not open', async () => {
    const dbA = openDb({ path: ':memory:' })
    const channelStore = makeChannelStore(dbA)
    const letterStore = makeLetterStore(dbA)
    const a = generateKeypair()
    channelStore.create({ id: 'a:pending', seekId: 'seek-a', myPrivkey: a.privateKey, myPubkey: a.publicKey, myChannelId: 'chan-A', degree: 1 })
    const postLetter = vi.fn().mockResolvedValue(true)
    const correspondent = makeCorrespondent({ channelStore, letterStore, postLetter, notifyInbound: vi.fn() })

    const result = await correspondent.sendLetter('a:pending', 'hi')

    expect(result).toEqual({ ok: false, error: 'channel_not_open' })
    expect(postLetter).not.toHaveBeenCalled()
    expect(letterStore.listForChannel('a:pending')).toHaveLength(0)
  })

  it('on a relay (degree-2) channel, posts to the INTERMEDIARY (relay_via), not the final peer — content-blind 2-hop', async () => {
    // Regression test for the inverted-target bug: a relay channel has BOTH
    // peer_agent_id (the final answerer) and relay_via (the intermediary) set.
    // The letter must go to relay_via so the intermediary can route the
    // ciphertext onward without seeing it (Task 9).
    const dbA = openDb({ path: ':memory:' })
    const channelStore = makeChannelStore(dbA)
    const letterStore = makeLetterStore(dbA)
    const a = generateKeypair()
    const b = generateKeypair()
    channelStore.create({ id: 'a:relay', seekId: 'seek-a', myPrivkey: a.privateKey, myPubkey: a.publicKey, myChannelId: 'chan-A', degree: 2, relayVia: 'cc-intermediary', peerAgentId: 'cc-final-peer' })
    channelStore.setPeerHandle('a:relay', { pubkey: b.publicKey, channel_id: 'chan-B' })
    const postLetter = vi.fn().mockResolvedValue(true)
    const correspondent = makeCorrespondent({ channelStore, letterStore, postLetter, notifyInbound: vi.fn() })

    const result = await correspondent.sendLetter('a:relay', 'hi via relay')

    expect(result).toEqual({ ok: true })
    expect(postLetter).toHaveBeenCalledTimes(1)
    const [target] = postLetter.mock.calls[0]!
    expect(target).toEqual({ agentId: 'cc-intermediary', relayVia: 'cc-intermediary' })
  })

  it('Task 11: a peer that crossed a mailbox at reveal gets a postLetter target carrying `mailbox` (relay-direct)', async () => {
    // Exercises the actual wiring point — sendLetter's peerMailboxOfRow(ch)
    // read — not just the pure routing function (postletter-route.test.ts)
    // or the store round-trip (penpal-channel-store.mailbox.test.ts). If
    // this line regressed, neither of those other layers would catch it.
    const dbA = openDb({ path: ':memory:' })
    const channelStore = makeChannelStore(dbA)
    const letterStore = makeLetterStore(dbA)
    const a = generateKeypair()
    const b = generateKeypair()
    channelStore.create({ id: 'a:mailbox', seekId: 'seek-a', myPrivkey: a.privateKey, myPubkey: a.publicKey, myChannelId: 'chan-A', degree: 1, peerAgentId: 'ccb' })
    channelStore.setPeerHandle('a:mailbox', { pubkey: b.publicKey, channel_id: 'chan-B', mailbox: { addr: 'A', enc_pub: 'E', relays: ['https://r/'] } })
    const postLetter = vi.fn().mockResolvedValue(true)
    const correspondent = makeCorrespondent({ channelStore, letterStore, postLetter, notifyInbound: vi.fn() })

    const result = await correspondent.sendLetter('a:mailbox', 'hi via mailbox')

    expect(result).toEqual({ ok: true })
    expect(postLetter).toHaveBeenCalledTimes(1)
    const [target] = postLetter.mock.calls[0]!
    expect(target).toEqual({ agentId: 'ccb', relayVia: null, mailbox: { addr: 'A', enc_pub: 'E', relays: ['https://r/'] } })
  })

  it('send_failed 返回落库行的 letter_id;resendLetter 重投同 nonce/ct/tag,不落第二行', async () => {
    const { channelStoreA, letterStoreA } = makeCrossedChannels()
    const postLetter = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const correspondent = makeCorrespondent({ channelStore: channelStoreA, letterStore: letterStoreA, postLetter, notifyInbound: vi.fn() })

    const fail = await correspondent.sendLetter('a:chan', '第一封')
    expect(fail.ok).toBe(false)
    expect(fail.error).toBe('send_failed')
    expect(fail.letter_id).toBeTruthy()

    const retry = await correspondent.resendLetter(fail.letter_id!)
    expect(retry).toEqual({ ok: true })

    expect(postLetter).toHaveBeenCalledTimes(2)
    const [, firstBody] = postLetter.mock.calls[0]!
    const [target2, secondBody] = postLetter.mock.calls[1]!
    expect(secondBody).toEqual(firstBody)                          // 同字节:同 nonce,接收端可去重
    expect(target2).toEqual({ agentId: 'ccb', relayVia: null })
    expect(letterStoreA.listForChannel('a:chan')).toHaveLength(1)  // 没有第二行
  })

  it('resend 全链路:原投递+重投都到达时,接收端只收一封、只提醒一次(nonce 去重)', async () => {
    const { channelStoreA, letterStoreA, channelStoreB, letterStoreB } = makeCrossedChannels()
    const postLetter = vi.fn().mockResolvedValue(true)
    const correspondentA = makeCorrespondent({ channelStore: channelStoreA, letterStore: letterStoreA, postLetter, notifyInbound: vi.fn() })
    await correspondentA.sendLetter('a:chan', '只此一封')
    const [, body1] = postLetter.mock.calls[0]!

    const notifyInbound = vi.fn()
    const correspondentB = makeCorrespondent({ channelStore: channelStoreB, letterStore: letterStoreB, postLetter: vi.fn(), notifyInbound })
    expect(correspondentB.receiveLetter(body1)).toEqual({ ok: true })

    // “投到了但 ack 丢了”场景:发送端重投同一封
    const letterId = letterStoreA.listForChannel('a:chan')[0]!.id
    await correspondentA.resendLetter(letterId)
    const [, body2] = postLetter.mock.calls[1]!
    expect(correspondentB.receiveLetter(body2)).toEqual({ ok: true })   // 幂等 no-op

    expect(letterStoreB.listForChannel('b:chan')).toHaveLength(1)
    expect(notifyInbound).toHaveBeenCalledTimes(1)
  })

  it('resendLetter 守卫:未知 id / inbound 行 / 信道未开', async () => {
    const { channelStoreA, letterStoreA, channelStoreB, letterStoreB } = makeCrossedChannels()
    const postLetter = vi.fn().mockResolvedValue(true)
    const correspondentA = makeCorrespondent({ channelStore: channelStoreA, letterStore: letterStoreA, postLetter, notifyInbound: vi.fn() })
    expect(await correspondentA.resendLetter('nope')).toEqual({ ok: false, error: 'unknown_letter' })

    await correspondentA.sendLetter('a:chan', 'x')
    const [, body] = postLetter.mock.calls[0]!
    const correspondentB = makeCorrespondent({ channelStore: channelStoreB, letterStore: letterStoreB, postLetter: vi.fn(), notifyInbound: vi.fn() })
    correspondentB.receiveLetter(body)
    const inId = letterStoreB.listForChannel('b:chan')[0]!.id
    expect(await correspondentB.resendLetter(inId)).toEqual({ ok: false, error: 'unknown_letter' })   // in 行不可重投

    const outId = letterStoreA.listForChannel('a:chan')[0]!.id
    channelStoreA.setStatus('a:chan', 'pending')
    expect(await correspondentA.resendLetter(outId)).toEqual({ ok: false, error: 'channel_not_open' })
  })

  it('receiveLetter is a safe no-op on a channel that exists but is still pending (not yet open)', () => {
    const dbB = openDb({ path: ':memory:' })
    const channelStore = makeChannelStore(dbB)
    const letterStore = makeLetterStore(dbB)
    const b = generateKeypair()
    channelStore.create({ id: 'b:pending', seekId: 'seek-b', myPrivkey: b.privateKey, myPubkey: b.publicKey, myChannelId: 'chan-B', degree: 1 })
    const notifyInbound = vi.fn()
    const correspondent = makeCorrespondent({ channelStore, letterStore, postLetter: vi.fn(), notifyInbound })

    const result = correspondent.receiveLetter({ channel_id: 'chan-B', nonce: 'N', ct: 'CT', tag: 'T' })

    expect(result).toEqual({ ok: false, error: 'unknown_channel' })
    expect(letterStore.listForChannel('b:pending')).toHaveLength(0)
    expect(notifyInbound).not.toHaveBeenCalled()
  })
})
