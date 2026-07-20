/**
 * mailbox-e2e.test.ts — the capstone: drive a REAL reveal (real makeRevealer,
 * real channel/echo/pledge/seek stores) across an in-process content-blind
 * relay (makeRelayServer, driven through fetchHandler — no socket) so that
 * BOTH channel rows cross a `peer_mailbox` (the C1 guard — Task 10), then
 * send a letter relay-direct (makeRoutePostLetter + makeMailboxSender,
 * Task 11) and receive it via the real poller/dispatch/own-channel-letter-
 * handler chain (makeMailboxPoller + makeEnvelopeDispatch +
 * makeMailboxLetterHandler, I1 / Task 8). Asserts:
 *   (a) the mailbox crossed onto BOTH channel rows (C1 end-to-end),
 *   (b) the letter is delivered relay-direct WITHOUT ever touching W's
 *       routeLetter/push (relay-direct — W is not in this path),
 *   (c) the relay only ever holds ciphertext (content-blind) and only Q's
 *       mailbox key can open it.
 * No production code changes — composition-only, mirroring
 * src/core/penpal.e2e.test.ts's idiom.
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
import { makeChannelStore } from './penpal-channel-store'
import { makeLetterStore } from './penpal-letter-store'
import { makeCorrespondent } from './penpal-correspondent'
import { makeEchoStore } from './social-echo-store'
import { makePledgeStore } from './social-pledge-store'
import { makeSeekStore } from './social-seek-store'
import { makeRevealer } from './social-reveal'
import { generateKeypair } from './penpal-crypto'
import { makeRoutePostLetter } from '../daemon/bootstrap/postletter-route'
import { makeMailboxLetterHandler } from '../daemon/bootstrap/mailbox-letter-handler'
import { buildCrossedHandle } from '../daemon/bootstrap/mailbox-dispatch-seam'
import type { MailboxClient } from './mailbox-client'

function inProcClient(relay: ReturnType<typeof makeRelayServer>): MailboxClient {
  const post = (p: string, b: unknown) => relay.fetchHandler(new Request(`http://relay${p}`, { method: 'POST', body: JSON.stringify(b) }), '127.0.0.1')
  return {
    drop: async (_r, to, envelope) => (await post('/drop', { to, envelope })).ok,
    fetch: async (_r, mailbox, since, ts, sig) => { const r = await post('/fetch', { mailbox, since, ts, sig }); return r.ok ? await r.json() as any : null },
    ack: async (_r, mailbox, up, ts, sig) => (await post('/ack', { mailbox, up_to_cursor: up, ts, sig })).ok,
  }
}
function port(store: ReturnType<typeof makeChannelStore>, mbx: { addr: string; enc_pub: string; relays: string[] }) {
  return {
    openLocal(rowId: string, ctx: any) {
      const ex = store.get(rowId)
      if (ex) return buildCrossedHandle({ my_pubkey: ex.my_pubkey, my_channel_id: ex.my_channel_id }, mbx)
      const kp = generateKeypair(); const mcid = randomUUID()
      store.create({ id: rowId, seekId: ctx.seekId, myPrivkey: kp.privateKey, myPubkey: kp.publicKey, myChannelId: mcid, degree: ctx.degree, relayVia: ctx.relayVia ?? null, peerAgentId: ctx.peerAgentId ?? null })
      return buildCrossedHandle({ my_pubkey: kp.publicKey, my_channel_id: mcid }, mbx)
    },
    finalize(rowId: string, h: any) { store.setPeerHandle(rowId, h) },
  }
}

describe('mailbox e2e — real reveal → relay-direct letter (NAT-simulated: only the relay is shared)', () => {
  it('crosses the mailbox on both rows, then delivers a letter relay-direct without touching routeLetter; relay sees only ciphertext', async () => {
    const relayDb = new Database(':memory:')
    const relay = makeRelayServer({ db: relayDb })
    const client = inProcClient(relay)
    const sDir = mkdtempSync(join(tmpdir(), 's-')); const qDir = mkdtempSync(join(tmpdir(), 'q-'))
    const s = loadMailboxIdentity(sDir); const q = loadMailboxIdentity(qDir)
    const S_MBX = { addr: s.addr, enc_pub: s.enc_pub, relays: ['https://relay/'] }
    const Q_MBX = { addr: q.addr, enc_pub: q.enc_pub, relays: ['https://relay/'] }
    const intentId = 'i1'

    // --- Q side (already self-revealed, awaiting S) ---
    const qDb = openDb({ path: ':memory:' }); const qCh = makeChannelStore(qDb); const qLetters = makeLetterStore(qDb)
    const qEch = makeEchoStore(qDb), qPld = makePledgeStore(qDb), qSk = makeSeekStore(qDb)
    qSk.create({ id: intentId, kind: 'seek', topic: 't' })
    qEch.create({ id: `${intentId}:s`, seekId: intentId, peerMasked: '某人', degree: 1, content: 'c', peerAgentId: 's' })
    qEch.setSelfRevealed(`${intentId}:s`, new Date().toISOString())
    const qPort = port(qCh, Q_MBX); qPort.openLocal(`${intentId}:s`, { seekId: intentId, degree: 1, peerAgentId: 's' })
    const qRevealer = makeRevealer({ echoStore: qEch, pledgeStore: qPld, seekStore: qSk, channel: qPort as any, notify: () => {}, postPeerReveal: async () => null })
    const qNotify = vi.fn()
    const qCorr = makeCorrespondent({ channelStore: qCh, letterStore: qLetters, postLetter: async () => true, notifyInbound: qNotify })

    // --- S side (reveals second; crossing handle built from the row, the C1 path) ---
    const sDb = openDb({ path: ':memory:' }); const sCh = makeChannelStore(sDb); const sLetters = makeLetterStore(sDb)
    const sEch = makeEchoStore(sDb), sPld = makePledgeStore(sDb), sSk = makeSeekStore(sDb)
    sSk.create({ id: intentId, kind: 'seek', topic: 't' })
    sEch.create({ id: `${intentId}:q`, seekId: intentId, peerMasked: '某人', degree: 1, content: 'c', peerAgentId: 'q' })
    const sPort = port(sCh, S_MBX)
    const sRevealer = makeRevealer({
      echoStore: sEch, pledgeStore: sPld, seekStore: sSk, channel: sPort as any, notify: () => {},
      postPeerReveal: async (_a, iid) => {
        const row = sCh.get(`${intentId}:q`)!
        return qRevealer.onInboundReveal({ agentId: 's', intentId: iid, peerHandle: buildCrossedHandle({ my_pubkey: row.my_pubkey, my_channel_id: row.my_channel_id }, S_MBX) })
      },
    })

    // (1) Drive the REAL reveal.
    expect(await sRevealer.revealEcho(`${intentId}:q`)).toEqual({ state: 'connected' })
    expect(JSON.parse(sCh.get(`${intentId}:q`)!.peer_mailbox!)).toEqual(Q_MBX)   // (a) crossed on S's row
    expect(JSON.parse(qCh.get(`${intentId}:s`)!.peer_mailbox!)).toEqual(S_MBX)   // (a) crossed on Q's row

    // (2) S sends a letter — routed relay-direct (target.mailbox set), NEVER over pushSend (the W-forward stand-in).
    const pushSpy = vi.fn(async () => true)   // stands in for letterRelay.routeLetter / push
    const sSender = makeMailboxSender({ client })
    const sPostLetter = makeRoutePostLetter({ mailboxSend: sSender.send, pushSend: pushSpy, selfId: 's' })
    const sCorr = makeCorrespondent({
      channelStore: sCh, letterStore: sLetters,
      postLetter: (target, body) => sPostLetter(target as any, body),   // sendLetter sets target.mailbox from peerMailboxOfRow
      notifyInbound: () => {},
    })
    expect(await sCorr.sendLetter(`${intentId}:q`, 'hallo penpal')).toEqual({ ok: true })
    expect(pushSpy).not.toHaveBeenCalled()   // (b) relay-direct — W's routeLetter/push untouched

    // The relay row is opaque — no plaintext leaked.
    const raw = relayDb.query('SELECT envelope FROM mailbox_item').get() as { envelope: string }
    expect(raw.envelope).not.toContain('hallo penpal')
    expect(openEnvelope(q.enc_priv, JSON.parse(raw.envelope))).toBeTruthy()   // only Q can open

    // (3) Q polls → own-channel letter handler → receiveLetter opens it.
    const poller = makeMailboxPoller({
      identity: q, relays: ['https://relay/'], client, cursors: makeCursorStore(qDir),
      dispatch: makeEnvelopeDispatch({
        registry: { verifyBearer: () => null } as any,
        onReveal: async () => ({ mutual: false }),
        onLetter: makeMailboxLetterHandler({ getByMyChannelId: (c) => qCh.getByMyChannelId(c), receiveLetter: (ev) => qCorr.receiveLetter(ev) }),
        log: () => {},
      }),
      log: () => {},
    })
    await poller.onTick()
    const inbound = qLetters.listForChannel(`${intentId}:s`).filter(l => l.direction === 'in')
    expect(inbound.map(l => l.plaintext)).toEqual(['hallo penpal'])   // delivered + decrypted, relay-direct, no W
    expect(qNotify).toHaveBeenCalledTimes(1)
    await poller.onTick()                                             // re-poll: acked → idempotent (M3)
    expect(qLetters.listForChannel(`${intentId}:s`).filter(l => l.direction === 'in')).toHaveLength(1)
  })
})
