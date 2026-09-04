import { describe, it, expect, vi } from 'vitest'
import { makePairing, type PairingDeps, type PairCard, type PairScheduleHandle, isAdvertisableUrl } from './pairing'
import { deriveRendezvous } from './pairing-crypto'
import { sealEnvelope } from './mailbox-crypto'
import type { MailboxClient } from './mailbox-client'
import type { A2ARegistry } from './a2a-registry'
import type { A2AAgentRecord } from '../lib/agent-config'

// ── shared in-process relay (a Map keyed by rendezvous addr) ──
function makeFakeRelay() {
  const boxes = new Map<string, string[]>()
  const client: MailboxClient = {
    async drop(_url, to, env) { (boxes.get(to) ?? boxes.set(to, []).get(to)!).push(env); return true },
    async fetch(_url, mailbox, _since) {
      const items = (boxes.get(mailbox) ?? []).map((envelope, i) => ({ cursor: i + 1, envelope }))
      return { items, next_cursor: items.length }
    },
    async ack() { throw new Error('ack must NOT be called during pairing') },
  }
  return { client, boxes }
}

type FakeChan = { id: string; seekId: string; myPrivkey: string; myPubkey: string; myChannelId: string; degree: number; peerAgentId: string | null; status: 'pending' | 'open'; peer: unknown }
function makeFakeChannelStore(): PairingDeps['channelStore'] & { rows: FakeChan[] } {
  const rows: FakeChan[] = []
  return {
    rows,
    create: (c) => { rows.push({ id: c.id, seekId: c.seekId, myPrivkey: c.myPrivkey, myPubkey: c.myPubkey, myChannelId: c.myChannelId, degree: c.degree, peerAgentId: c.peerAgentId ?? null, status: 'pending', peer: null }) },
    setPeerHandle: (id, h) => { const r = rows.find(x => x.id === id); if (r) r.peer = h },
    setStatus: (id, s) => { const r = rows.find(x => x.id === id); if (r) r.status = s },
    list: () => rows.map(r => ({ id: r.id, seek_id: r.seekId, my_privkey: r.myPrivkey, my_pubkey: r.myPubkey, my_channel_id: r.myChannelId, peer_pubkey: null, peer_channel_id: null, peer_mailbox: null, degree: r.degree, relay_via: null, peer_agent_id: r.peerAgentId, status: r.status, created_at: '' })) as never,
  }
}

function makeFakeRegistry(): A2ARegistry & { records: Map<string, A2AAgentRecord> } {
  const records = new Map<string, A2AAgentRecord>()
  return {
    records,
    list: () => [...records.values()],
    get: (id) => records.get(id) ?? null,
    verifyBearer: () => null,
    add: (rec) => { if (records.has(rec.id)) throw new Error('exists'); records.set(rec.id, rec) },
    remove: (id) => { records.delete(id) },
    setPaused: () => {},
    update: (id) => records.get(id)!,
  }
}

// Manual scheduler: remembers the latest armed callback; tick() fires it.
function makeManualScheduler() {
  let armed: (() => void) | null = null
  let cancelled = false
  const schedule: PairingDeps['schedule'] = (fn) => { armed = fn; return { cancel() { cancelled = true; armed = null } } }
  return { schedule, tick: () => { if (armed && !cancelled) armed() }, get cancelled() { return cancelled } }
}

// start() is async and can fail (relay_drop_failed) — most tests just want
// the happy-path code + expiresAt, so this helper narrows + throws loudly if
// a test's setup accidentally makes start() fail (keeps assertions honest
// instead of silently destructuring `undefined` off the failure branch).
async function mustStart(engine: { start(): Promise<{ ok: true; code: string; expiresAt: number } | { ok: false; reason: string }> }): Promise<{ code: string; expiresAt: number }> {
  const r = await engine.start()
  if (!r.ok) throw new Error(`expected start() to succeed, got: ${r.reason}`)
  return r
}

function baseDeps(over: Partial<PairingDeps>): PairingDeps {
  return {
    client: makeFakeRelay().client,
    registry: makeFakeRegistry(),
    self: { mailbox_addr: 'MB', mailbox_enc_pub: 'EP', relays: ['https://r.example/mailbox'] },
    selfId: () => 'cc-self0001',
    name: () => 'me',
    now: () => 1000,
    mintKey: () => 'minted-key-000000000000',
    genCode: () => '483921',
    genNonce: () => 'nonceX',
    notify: () => {},
    schedule: () => ({ cancel() {} }),
    channelStore: makeFakeChannelStore(),
    genChannel: (() => { let n = 0; return () => { n++; return { channelId: `chan-${n}`, pubkey: `PUB${n}`, privkey: `PRIV${n}` } } })(),
    ...over,
  }
}

describe('pairing engine', () => {
  it('start → accept → poller: both sides file a correct mailbox record with crossed keys', async () => {
    const relay = makeFakeRelay()
    const regA = makeFakeRegistry(); const regB = makeFakeRegistry()
    const sched = makeManualScheduler()
    let keyI = 'keyI-0000000000000000'; let keyA = 'keyA-0000000000000000'
    const notifyB = vi.fn()

    const A = makePairing(baseDeps({
      client: relay.client, registry: regA, schedule: sched.schedule,
      self: { mailbox_addr: 'A_MB', mailbox_enc_pub: 'A_EP', relays: ['https://r/mailbox'] },
      selfId: () => 'cc-aaaa1111', name: () => 'Alice', mintKey: () => keyI, genNonce: () => 'nA', genCode: () => '483921',
    }))
    const B = makePairing(baseDeps({
      client: relay.client, registry: regB,
      self: { mailbox_addr: 'B_MB', mailbox_enc_pub: 'B_EP', relays: ['https://r/mailbox'] },
      selfId: () => 'cc-bbbb2222', name: () => 'Bob', mintKey: () => keyA, genNonce: () => 'nB', notify: notifyB,
    }))

    const { code } = await mustStart(A)
    const res = await B.accept(code)
    expect(res).toEqual({ ok: true, peer: { self_id: 'cc-aaaa1111', name: 'Alice' } })
    // accept()'s success is a SYNC outcome — the caller (WeChat dispatch /
    // internal-api / CLI) renders the "连上了" reply from `res` directly;
    // the engine itself must NOT also notify (that double-messages the
    // owner in a solo-owner install, where notify's resolveOperatorChatId
    // is the same chat as the caller's reply target).
    expect(notifyB).not.toHaveBeenCalled()

    // B filed A under A's self_id, keys crossed, transport mailbox, NO url.
    const bRec = regB.records.get('cc-aaaa1111')!
    expect(bRec.transport).toBe('mailbox')
    expect(bRec.url).toBeUndefined()
    expect(bRec.outbound_api_key).toBe(keyI) // = CardI.bearer
    expect(bRec.inbound_api_key).toBe(keyA)  // = B's minted key
    expect(bRec.mailbox_addr).toBe('A_MB'); expect(bRec.mailbox_enc_pub).toBe('A_EP')

    // Now A's poller sees CardA.
    sched.tick()
    await new Promise(r => setTimeout(r, 0)) // let the async tick settle
    const aRec = regA.records.get('cc-bbbb2222')!
    expect(aRec.outbound_api_key).toBe(keyA) // = CardA.bearer
    expect(aRec.inbound_api_key).toBe(keyI)  // = A's minted key
    // crossing proven:
    expect(aRec.outbound_api_key).toBe(bRec.inbound_api_key)
    expect(bRec.outbound_api_key).toBe(aRec.inbound_api_key)
  })

  it('accept with a code no initiator ever dropped → expired_or_wrong', async () => {
    const B = makePairing(baseDeps({}))
    expect(await B.accept('000000')).toEqual({ ok: false, reason: 'expired_or_wrong' })
  })

  it('rejects self-pair (same self_id) without dropping a card', async () => {
    const relay = makeFakeRelay()
    const A = makePairing(baseDeps({ client: relay.client, selfId: () => 'cc-same', genNonce: () => 'nA' }))
    const B = makePairing(baseDeps({ client: relay.client, selfId: () => 'cc-same' }))
    const { code } = await mustStart(A)
    expect(await B.accept(code)).toEqual({ ok: false, reason: 'self_pair' })
  })

  it('poller ignores the initiator OWN card (role/nonce filter), never self-files', async () => {
    const relay = makeFakeRelay(); const regA = makeFakeRegistry(); const sched = makeManualScheduler()
    const A = makePairing(baseDeps({ client: relay.client, registry: regA, schedule: sched.schedule, selfId: () => 'cc-aaaa' }))
    await mustStart(A)
    sched.tick() // only CardI (role initiator) is in the box — must be ignored
    await new Promise(r => setTimeout(r, 0))
    expect(regA.records.size).toBe(0)
  })

  it('poller past TTL → notifies timeout and stops (no re-arm)', async () => {
    const relay = makeFakeRelay(); const sched = makeManualScheduler(); const notify = vi.fn()
    let t = 1000
    const A = makePairing(baseDeps({ client: relay.client, schedule: sched.schedule, notify, now: () => t, ttlMs: 600_000 }))
    await mustStart(A)
    t = 1000 + 600_001
    sched.tick()
    await new Promise(r => setTimeout(r, 0))
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('过期'))
    expect(sched.cancelled).toBe(true)
  })

  it('re-pair overwrites an existing record for the same self_id AND same mailbox_addr', async () => {
    const relay = makeFakeRelay(); const regB = makeFakeRegistry()
    // A's card carries mailbox_addr 'A_MB' (its own self.mailbox_addr) → a true re-pair.
    regB.records.set('cc-aaaa1111', { id: 'cc-aaaa1111', name: 'stale', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'old', capabilities: [], paused: false, transport: 'mailbox', may_exec: false, mailbox_addr: 'A_MB' })
    const A = makePairing(baseDeps({ client: relay.client, self: { mailbox_addr: 'A_MB', mailbox_enc_pub: 'A_EP', relays: ['https://r/mailbox'] }, selfId: () => 'cc-aaaa1111', name: () => 'Alice', mintKey: () => 'keyI-0000000000000000' }))
    const B = makePairing(baseDeps({ client: relay.client, registry: regB, selfId: () => 'cc-bbbb2222', mintKey: () => 'keyA-0000000000000000' }))
    const { code } = await mustStart(A)
    await B.accept(code)
    expect(regB.records.get('cc-aaaa1111')!.outbound_api_key).toBe('keyI-0000000000000000') // overwritten
  })

  it('rejects id_conflict on accept: same self_id, DIFFERENT mailbox_addr (unrelated wechat-cc peer) — no write, no card drop', async () => {
    const relay = makeFakeRelay(); const regB = makeFakeRegistry(); const notifyB = vi.fn()
    // B already has an UNRELATED peer filed under the legacy shared id 'wechat-cc'.
    regB.records.set('wechat-cc', { id: 'wechat-cc', name: 'someone-else', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'ob', capabilities: [], paused: false, transport: 'mailbox', may_exec: false, mailbox_addr: 'OTHER_MB' })
    // A is a grandfathered daemon still self-reporting 'wechat-cc' with a DIFFERENT mailbox.
    const A = makePairing(baseDeps({ client: relay.client, self: { mailbox_addr: 'A_MB', mailbox_enc_pub: 'A_EP', relays: ['https://r/mailbox'] }, selfId: () => 'wechat-cc', name: () => 'Alice' }))
    const B = makePairing(baseDeps({ client: relay.client, registry: regB, selfId: () => 'cc-bbbb2222', notify: notifyB }))
    const { code } = await mustStart(A)
    const res = await B.accept(code)
    expect(res).toEqual({ ok: false, reason: 'id_conflict' })
    expect(regB.records.get('wechat-cc')!.name).toBe('someone-else') // untouched
    // No acceptor card dropped (only A's initiator card is in the box).
    const rvAddr = deriveRendezvous(code).addr
    expect(relay.boxes.get(rvAddr)!.length).toBe(1)
    // Sync outcome (accept()'s peek-only conflicts() check, before any card
    // drop) — the caller renders the id_conflict reply from `res.reason`
    // directly; the engine must NOT also notify.
    expect(notifyB).not.toHaveBeenCalled()
  })

  it('rejects id_conflict in the poller: acceptor card collides with an unrelated same-id record', async () => {
    const relay = makeFakeRelay(); const regA = makeFakeRegistry(); const sched = makeManualScheduler(); const notify = vi.fn()
    // A already has an unrelated peer 'wechat-cc' with mailbox OTHER_MB.
    regA.records.set('wechat-cc', { id: 'wechat-cc', name: 'someone-else', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'ob', capabilities: [], paused: false, transport: 'mailbox', may_exec: false, mailbox_addr: 'OTHER_MB' })
    const A = makePairing(baseDeps({ client: relay.client, registry: regA, schedule: sched.schedule, notify, selfId: () => 'cc-aaaa1111', name: () => 'Alice', genNonce: () => 'nA' }))
    // B is grandfathered 'wechat-cc' with a different mailbox → its acceptor card conflicts.
    const B = makePairing(baseDeps({ client: relay.client, self: { mailbox_addr: 'B_MB', mailbox_enc_pub: 'B_EP', relays: ['https://r/mailbox'] }, selfId: () => 'wechat-cc', name: () => 'Bob', genNonce: () => 'nB' }))
    const { code } = await mustStart(A)
    await B.accept(code)
    sched.tick()
    await new Promise(r => setTimeout(r, 0))
    expect(regA.records.get('wechat-cc')!.name).toBe('someone-else') // NOT clobbered
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('撞名'))
    expect(sched.cancelled).toBe(true)
  })

  it('start(): a relay drop failure (client.drop resolves false) never arms the poller nor hands back a code', async () => {
    const notify = vi.fn()
    const scheduleFn = vi.fn((): PairScheduleHandle => ({ cancel() {} }))
    // client.drop resolves false (the real MailboxClient's behavior on any
    // non-2xx — NOT a throw), which is exactly the case the old fire-and-forget
    // `.catch()` at the drop call site could never see.
    const failingClient: MailboxClient = {
      async drop() { return false },
      async fetch() { return { items: [], next_cursor: 0 } },
      async ack() { throw new Error('ack must NOT be called during pairing') },
    }
    const A = makePairing(baseDeps({ client: failingClient, schedule: scheduleFn, notify }))
    const res = await A.start()
    expect(res).toEqual({ ok: false, reason: 'relay_drop_failed' })
    // Sync outcome — the caller renders "中继暂时够不着…" from `res.reason`
    // directly; the engine must NOT also notify (there's no poller running
    // yet to justify an async-style push).
    expect(notify).not.toHaveBeenCalled()
    expect(scheduleFn).not.toHaveBeenCalled() // no poller armed for a code nobody can ever redeem
  })

  it('accept(): a relay drop failure (client.drop resolves false) writes nothing locally and reports honestly (drop-first ordering)', async () => {
    const relay = makeFakeRelay()
    const regB = makeFakeRegistry()
    const notify = vi.fn()
    const A = makePairing(baseDeps({ client: relay.client, selfId: () => 'cc-aaaa1111', name: () => 'Alice', genNonce: () => 'nA' }))
    const { code } = await mustStart(A)

    // B can still read A's card off the shared relay, but B's OWN card drop fails.
    const failingDropClient: MailboxClient = { ...relay.client, async drop() { return false } }
    const B = makePairing(baseDeps({ client: failingDropClient, registry: regB, notify, selfId: () => 'cc-bbbb2222' }))
    const res = await B.accept(code)

    expect(res).toEqual({ ok: false, reason: 'relay_drop_failed' })
    // Sync outcome — the caller renders "名片没能投到中继…" from `res.reason`
    // directly; the engine must NOT also notify.
    expect(notify).not.toHaveBeenCalled()
    expect(regB.records.size).toBe(0) // drop-first: nothing written locally on a failed drop

    // The shared box still only has A's initiator card — B's (failed) acceptor
    // drop never actually reached it either, since the fake client's own drop
    // short-circuits to `false` without touching the relay's boxes.
    const rvAddr = deriveRendezvous(code).addr
    expect(relay.boxes.get(rvAddr)!.length).toBe(1)
  })

  // ── admission-point hardening (final-review blocker: id_conflict bypass via
  // absent mailbox_addr) ──
  //
  // Drops a card DIRECTLY into the shared rendezvous box, bypassing
  // ownCard()'s guaranteed-valid construction — this is how a hostile or
  // malformed live-code-holder's card would actually arrive on the relay.
  // `sealEnvelope`'s `body` is `unknown`, so a partial/garbage object is
  // accepted at the type level exactly as it would be at the wire level.
  function dropRawCard(client: MailboxClient, rvAddr: string, rvEncPub: string, body: unknown): Promise<boolean> {
    const env = sealEnvelope({ path: '/pair', bearer: '', body }, rvEncPub)
    return client.drop('unused', rvAddr, JSON.stringify(env))
  }

  describe('card admission (readCards validates every field before trusting it)', () => {
    it('accept(): a card missing mailbox_addr for a same-id legacy PUSH peer is REJECTED — no clobber of the unrelated existing edge', async () => {
      const relay = makeFakeRelay(); const regB = makeFakeRegistry(); const notifyB = vi.fn()
      // B already has an unrelated peer filed under the legacy shared id
      // 'wechat-cc' via the OLD push transport — no mailbox_addr at all
      // (exactly the shape the id_conflict guard's `undefined !== undefined`
      // bug would misread as "no conflict").
      regB.records.set('wechat-cc', {
        id: 'wechat-cc', name: 'someone-else', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'ob',
        capabilities: [], paused: false, transport: 'push', may_exec: false, url: 'https://someone-else.example/webhook',
      })
      const code = '111222'
      const rv = deriveRendezvous(code)
      // Attacker (or a malformed live-code-holder) drops an "initiator" card
      // for 'wechat-cc' with NO mailbox_addr — never went through ownCard().
      const dropped = await dropRawCard(relay.client, rv.addr, rv.enc_pub, {
        v: 1, role: 'initiator', nonce: 'atk-nonce', self_id: 'wechat-cc', name: 'Attacker',
        mailbox_enc_pub: 'ATK_EP', relays: ['https://r/mailbox'], bearer: 'atk-bearer-key-00000000',
      })
      expect(dropped).toBe(true)

      const B = makePairing(baseDeps({ client: relay.client, registry: regB, selfId: () => 'cc-bbbb2222', notify: notifyB }))
      const res = await B.accept(code)
      // The malformed card never survives readCards's admission filter, so
      // accept() sees no valid initiator at all — same as an empty box.
      expect(res).toEqual({ ok: false, reason: 'expired_or_wrong' })
      // The pre-existing edge is completely untouched.
      const rec = regB.records.get('wechat-cc')!
      expect(rec.name).toBe('someone-else')
      expect(rec.outbound_api_key).toBe('ob')
      expect(rec.mailbox_addr).toBeUndefined()
      expect(notifyB).not.toHaveBeenCalled()
    })

    it('initiator poller: an acceptor card missing mailbox_addr for a same-id legacy PUSH peer is REJECTED — no clobber', async () => {
      const relay = makeFakeRelay(); const regA = makeFakeRegistry(); const sched = makeManualScheduler(); const notify = vi.fn()
      // A already has an unrelated peer 'wechat-cc' filed via the legacy push
      // transport — no mailbox_addr.
      regA.records.set('wechat-cc', {
        id: 'wechat-cc', name: 'someone-else', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'ob',
        capabilities: [], paused: false, transport: 'push', may_exec: false, url: 'https://someone-else.example/webhook',
      })
      const A = makePairing(baseDeps({
        client: relay.client, registry: regA, schedule: sched.schedule, notify,
        selfId: () => 'cc-aaaa1111', name: () => 'Alice', genNonce: () => 'nA',
      }))
      const { code } = await mustStart(A)
      const rv = deriveRendezvous(code)
      // Attacker drops a malformed "acceptor" card for 'wechat-cc' with NO
      // mailbox_addr, straight onto the shared box A's poller reads.
      await dropRawCard(relay.client, rv.addr, rv.enc_pub, {
        v: 1, role: 'acceptor', nonce: 'atk-nonce', self_id: 'wechat-cc', name: 'Attacker',
        mailbox_enc_pub: 'ATK_EP', relays: ['https://r/mailbox'], bearer: 'atk-bearer-key-00000000',
      })

      sched.tick()
      await new Promise(r => setTimeout(r, 0))
      const rec = regA.records.get('wechat-cc')!
      expect(rec.name).toBe('someone-else') // NOT clobbered
      expect(rec.mailbox_addr).toBeUndefined()
      // The malformed card was filtered before conflicts() ever saw it, so
      // this is silent from the poller's perspective (same as "no peer card
      // yet") — it just re-arms rather than firing the id_conflict notify.
      expect(notify).not.toHaveBeenCalled()
      expect(sched.cancelled).toBe(false)
    })

    it('rejects malformed cards (missing enc_pub / empty self_id / non-slug self_id / empty relays) — skipped, no registry mutation, no throw', async () => {
      const relay = makeFakeRelay(); const regB = makeFakeRegistry()
      const code = '333444'
      const rv = deriveRendezvous(code)
      const base = {
        v: 1 as const, role: 'initiator' as const, nonce: 'n', name: 'X',
        mailbox_addr: 'MB', mailbox_enc_pub: 'EP', relays: ['https://r/mailbox'], bearer: 'bearer-key-00000000',
      }
      const malformed = [
        { ...base, self_id: 'cc-valid1', mailbox_enc_pub: undefined }, // missing enc_pub
        { ...base, self_id: '' },                                      // empty self_id
        { ...base, self_id: 'CC-Not-A-Slug!' },                        // non-slug self_id
        { ...base, self_id: 'cc-valid2', relays: [] },                 // empty relays
      ]
      for (const card of malformed) {
        expect(await dropRawCard(relay.client, rv.addr, rv.enc_pub, card)).toBe(true)
      }

      const B = makePairing(baseDeps({ client: relay.client, registry: regB, selfId: () => 'cc-bbbb2222' }))
      await expect(B.accept(code)).resolves.toEqual({ ok: false, reason: 'expired_or_wrong' })
      expect(regB.records.size).toBe(0)
    })
  })
})

/**
 * WHY(2026-09-01,Mac↔Windows 真机):配对卡片里的 url 来自
 * `a2aServer.baseUrl()` = `http://${host}:${port}`,而 a2a_listen.host
 * **默认就是 127.0.0.1**。于是卡片把一个回环地址广播给了远端对方 ——
 * 在对方机器上,它指向对方自己。
 *
 * 后果是真的:仪表盘「测试连通」走 /v1/a2a/send,用的正是 agent.url,
 * 于是对端会 POST 到自己的 8790。目前靠 bearer 不匹配才挡住,是运气
 * 不是设计。配对写的永远是 transport:'mailbox'(双方本来就直连不到),
 * 这个字段只可能误导。
 *
 * 判定按「能不能路由到别人的机器」,不是按「是不是我自己」:回环、
 * link-local(169.254/fe80)、0.0.0.0、以及裸 localhost 都不该外发。
 * 私网地址(10./192.168./172.16-31)刻意**保留** —— 同一个局域网里的
 * 两台机器互相直连是合法且有用的。
 */
describe('配对卡片不广播不可路由的 url', () => {
  const cases: Array<[string, boolean]> = [
    ['http://127.0.0.1:8790', false],
    ['http://localhost:8790', false],
    ['http://[::1]:8790', false],
    ['http://0.0.0.0:8790', false],
    ['http://169.254.10.4:8790', false],
    ['http://192.168.1.20:8790', true],
    ['http://10.84.6.254:8790', true],
    ['https://cc.example.com', true],
  ]
  for (const [url, shouldAdvertise] of cases) {
    it(`${url} → ${shouldAdvertise ? '可广播' : '不广播'}`, () => {
      expect(isAdvertisableUrl(url)).toBe(shouldAdvertise)
    })
  }
})

describe('配对即开信道(spec 2026-09-04-wish-postcard §2)', () => {
  function pairBoth() {
    const relay = makeFakeRelay()
    const sA = makeManualScheduler(), sB = makeManualScheduler()
    const chanA = makeFakeChannelStore(), chanB = makeFakeChannelStore()
    const A = makePairing(baseDeps({ client: relay.client, selfId: () => 'cc-aaaa0001', name: () => 'A', self: { mailbox_addr: 'MA', mailbox_enc_pub: 'EA', relays: ['https://r/mailbox'] }, schedule: sA.schedule, channelStore: chanA, genNonce: () => 'n0nce' }))
    const B = makePairing(baseDeps({ client: relay.client, selfId: () => 'cc-bbbb0002', name: () => 'B', self: { mailbox_addr: 'MB', mailbox_enc_pub: 'EB', relays: ['https://r/mailbox'] }, schedule: sB.schedule, channelStore: chanB }))
    return { A, B, sA, chanA, chanB }
  }

  it('双方 card 带 channel 字段;完成后各一条 open 信道,peer_agent_id 互指,peer_mailbox 是对方的', async () => {
    const { A, B, sA, chanA, chanB } = pairBoth()
    const { code } = await mustStart(A)
    const r = await B.accept(code)
    expect(r.ok).toBe(true)
    sA.tick()                       // initiator 轮询到 acceptor 的 card
    await new Promise(r => setTimeout(r, 0))
    expect(chanB.rows).toHaveLength(1)
    expect(chanB.rows[0]).toMatchObject({ id: 'pair:n0nce', degree: 1, peerAgentId: 'cc-aaaa0001', status: 'open' })
    expect(chanB.rows[0]!.peer).toMatchObject({ channel_id: 'chan-1', pubkey: 'PUB1', mailbox: { addr: 'MA', enc_pub: 'EA' } })
    expect(chanA.rows).toHaveLength(1)
    expect(chanA.rows[0]).toMatchObject({ id: 'pair:n0nce', peerAgentId: 'cc-bbbb0002', status: 'open' })
    expect(chanA.rows[0]!.peer).toMatchObject({ mailbox: { addr: 'MB', enc_pub: 'EB' } })
  })

  it('同一对端已有 open 信道 → 重新配对不建第二条', async () => {
    const { A, B, sA, chanB } = pairBoth()
    chanB.rows.push({ id: 'pair:old', seekId: 'pair:old', myPrivkey: 'p', myPubkey: 'P', myChannelId: 'c', degree: 1, peerAgentId: 'cc-aaaa0001', status: 'open', peer: null })
    const { code } = await mustStart(A)
    expect((await B.accept(code)).ok).toBe(true)
    sA.tick(); await new Promise(r => setTimeout(r, 0))
    expect(chanB.rows).toHaveLength(1)
  })

  it('v1 旧 card(没有 channel 字段)不被认可', async () => {
    const relay = makeFakeRelay()
    const chanB = makeFakeChannelStore()
    const B = makePairing(baseDeps({ client: relay.client, channelStore: chanB }))
    // 手工往 rendezvous 信箱塞一张 v1 initiator card(没有 channel_id/channel_pub,
    // v:1 而不是 2),绕过 ownCard() 的保证有效构造 —— 就像文件里已有的 malformed
    // card 测试那样直接伪造对端在中继上会长成的样子。
    const code = '123456'
    const rv = deriveRendezvous(code)
    const v1 = { v: 1, role: 'initiator', nonce: 'x', self_id: 'cc-old00001', name: 'old', mailbox_addr: 'MO', mailbox_enc_pub: 'EO', relays: ['https://r/mailbox'], bearer: 'bearer-key-00000000' }
    const env = sealEnvelope({ path: '/pair', bearer: '', body: v1 }, rv.enc_pub)
    await relay.client.drop('https://r/mailbox', rv.addr, JSON.stringify(env))
    const r = await B.accept(code)
    expect(r.ok).toBe(false)
    expect(chanB.rows).toHaveLength(0)
  })
})
