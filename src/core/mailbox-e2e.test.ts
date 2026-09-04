/**
 * mailbox-e2e.test.ts — the capstone for the store-and-forward leg: two
 * daemons that share NOTHING but a relay (NAT-simulated — no direct HTTP
 * between them) exchange a real sealed letter. S sends relay-direct
 * (makeRoutePostLetter + makeMailboxSender), Q receives it through the real
 * poller/dispatch/own-channel-letter-handler chain (makeMailboxPoller +
 * makeEnvelopeDispatch + makeMailboxLetterHandler). Asserts:
 *   (a) the letter is delivered relay-direct WITHOUT ever touching the push
 *       leg (pushSend is never called),
 *   (b) the relay only ever holds ciphertext (content-blind) and only Q's
 *       mailbox key can open it,
 *   (c) re-polling is idempotent (M3 — acked cursor, no duplicate row).
 *
 * 2026-09-04:两侧的信道行原先是**跑一遍真 reveal**(seek/echo/pledge 三张表
 * + makeRevealer)建起来的。那条掮客管道退役之后,这里直接把配对完成后的
 * 终态写进 channelStore —— 配对(pairing)本来就是这么写的。测的东西没变:
 * 交叉过信箱坐标的两条信道行 → 一封信 → 只走 relay。
 * No production code changes — composition-only.
 */
import { describe, it, expect, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { makeRelayServer } from '../../relay/server'
import { loadMailboxIdentity, openEnvelope } from './mailbox-crypto'
import { makeMailboxSender } from './mailbox-sender'
import { makeMailboxPoller } from './mailbox-poller'
import { makeEnvelopeDispatch } from './mailbox-dispatch'
import { makeCursorStore } from './mailbox-cursor-store'
import { openDb } from '../lib/db'
import { makeChannelStore, type ChannelStore } from './penpal-channel-store'
import { makeLetterStore } from './penpal-letter-store'
import { makeCorrespondent } from './penpal-correspondent'
import { generateKeypair } from './penpal-crypto'
import { makeRoutePostLetter } from '../daemon/bootstrap/postletter-route'
import { makeMailboxLetterHandler } from '../daemon/bootstrap/mailbox-letter-handler'
import type { PeerMailbox } from './mailbox-crypto'
import type { MailboxClient } from './mailbox-client'

function inProcClient(relay: ReturnType<typeof makeRelayServer>): MailboxClient {
  const post = (p: string, b: unknown) => relay.fetchHandler(new Request(`http://relay${p}`, { method: 'POST', body: JSON.stringify(b) }), '127.0.0.1')
  return {
    drop: async (_r, to, envelope) => (await post('/drop', { to, envelope })).ok,
    fetch: async (_r, mailbox, since, ts, sig) => { const r = await post('/fetch', { mailbox, since, ts, sig }); return r.ok ? await r.json() as any : null },
    ack: async (_r, mailbox, up, ts, sig) => (await post('/ack', { mailbox, up_to_cursor: up, ts, sig })).ok,
  }
}

/** 一条**配对完成**的信道行 —— 我方钥匙 + 信道号已生成,对端的手牌(含它的
 *  信箱坐标)已交叉,状态 open。这正是 pairing 走完之后 DB 里的样子。 */
function openChannel(store: ChannelStore, rowId: string, peerAgentId: string) {
  const kp = generateKeypair()
  const myChannelId = randomUUID()
  store.create({ id: rowId, seekId: rowId, myPrivkey: kp.privateKey, myPubkey: kp.publicKey, myChannelId, degree: 1, peerAgentId })
  return { rowId, pubkey: kp.publicKey, channelId: myChannelId }
}
function cross(store: ChannelStore, rowId: string, peer: { pubkey: string; channelId: string }, mailbox: PeerMailbox) {
  store.setPeerHandle(rowId, { pubkey: peer.pubkey, channel_id: peer.channelId, mailbox })
  store.setStatus(rowId, 'open')
}

describe('mailbox e2e — relay-direct letter (NAT-simulated: only the relay is shared)', () => {
  it('delivers a letter relay-direct without touching the push leg; relay sees only ciphertext; re-poll is idempotent', async () => {
    const relayDb = new Database(':memory:')
    const relay = makeRelayServer({ db: relayDb })
    const client = inProcClient(relay)
    const sDir = mkdtempSync(join(tmpdir(), 's-')); const qDir = mkdtempSync(join(tmpdir(), 'q-'))
    const s = loadMailboxIdentity(sDir); const q = loadMailboxIdentity(qDir)
    const S_MBX: PeerMailbox = { addr: s.addr, enc_pub: s.enc_pub, relays: ['https://relay/'] }
    const Q_MBX: PeerMailbox = { addr: q.addr, enc_pub: q.enc_pub, relays: ['https://relay/'] }

    // --- 两侧各自的库 + 一条配对完成的信道行,互相交叉手牌 ---
    const qDb = openDb({ path: ':memory:' }); const qCh = makeChannelStore(qDb); const qLetters = makeLetterStore(qDb)
    const sDb = openDb({ path: ':memory:' }); const sCh = makeChannelStore(sDb); const sLetters = makeLetterStore(sDb)
    const qSide = openChannel(qCh, 'ch:q', 's')
    const sSide = openChannel(sCh, 'ch:s', 'q')
    cross(qCh, qSide.rowId, sSide, S_MBX)
    cross(sCh, sSide.rowId, qSide, Q_MBX)
    expect(JSON.parse(sCh.get(sSide.rowId)!.peer_mailbox!)).toEqual(Q_MBX)
    expect(JSON.parse(qCh.get(qSide.rowId)!.peer_mailbox!)).toEqual(S_MBX)

    const qNotify = vi.fn()
    const qCorr = makeCorrespondent({ channelStore: qCh, letterStore: qLetters, postLetter: async () => true, onInbound: qNotify })

    // (1) S 写信 —— target.mailbox 有值 ⇒ 走 relay,绝不落到 pushSend 那条腿。
    const pushSpy = vi.fn(async () => true)
    const sSender = makeMailboxSender({ client })
    const sPostLetter = makeRoutePostLetter({ mailboxSend: sSender.send, pushSend: pushSpy, selfId: 's' })
    const sCorr = makeCorrespondent({
      channelStore: sCh, letterStore: sLetters,
      postLetter: (target, body) => sPostLetter(target as any, body),   // sendLetter sets target.mailbox from peerMailboxOfRow
      onInbound: () => {},
    })
    expect(await sCorr.sendLetter(sSide.rowId, 'hallo penpal')).toEqual({ ok: true })
    expect(pushSpy).not.toHaveBeenCalled()   // (a) relay-direct

    // (b) relay 那行是不透明的 —— 没有明文泄露,只有 Q 的钥匙能拆。
    const raw = relayDb.query('SELECT envelope FROM mailbox_item').get() as { envelope: string }
    expect(raw.envelope).not.toContain('hallo penpal')
    expect(openEnvelope(q.enc_priv, JSON.parse(raw.envelope))).toBeTruthy()

    // (2) Q 取件 → own-channel letter handler → receiveLetter 拆开。
    const poller = makeMailboxPoller({
      identity: q, relays: ['https://relay/'], client, cursors: makeCursorStore(qDir),
      dispatch: makeEnvelopeDispatch({
        registry: { verifyBearer: () => null } as any,
        onLetter: makeMailboxLetterHandler({ getByMyChannelId: (c) => qCh.getByMyChannelId(c), receiveLetter: (ev) => qCorr.receiveLetter(ev) }),
        log: () => {},
      }),
      log: () => {},
    })
    await poller.onTick()
    const inbound = qLetters.listForChannel(qSide.rowId).filter(l => l.direction === 'in')
    expect(inbound.map(l => l.plaintext)).toEqual(['hallo penpal'])
    expect(qNotify).toHaveBeenCalledTimes(1)
    await poller.onTick()                                             // (c) 再取一次:已 ack ⇒ 幂等
    expect(qLetters.listForChannel(qSide.rowId).filter(l => l.direction === 'in')).toHaveLength(1)
  })
})
