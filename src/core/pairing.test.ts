import { describe, it, expect, vi } from 'vitest'
import { makePairing, type PairingDeps, type PairCard, type PairScheduleHandle } from './pairing'
import { deriveRendezvous } from './pairing-crypto'
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
    regB.records.set('cc-aaaa1111', { id: 'cc-aaaa1111', name: 'stale', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'old', capabilities: [], paused: false, transport: 'mailbox', mailbox_addr: 'A_MB' })
    const A = makePairing(baseDeps({ client: relay.client, self: { mailbox_addr: 'A_MB', mailbox_enc_pub: 'A_EP', relays: ['https://r/mailbox'] }, selfId: () => 'cc-aaaa1111', name: () => 'Alice', mintKey: () => 'keyI-0000000000000000' }))
    const B = makePairing(baseDeps({ client: relay.client, registry: regB, selfId: () => 'cc-bbbb2222', mintKey: () => 'keyA-0000000000000000' }))
    const { code } = await mustStart(A)
    await B.accept(code)
    expect(regB.records.get('cc-aaaa1111')!.outbound_api_key).toBe('keyI-0000000000000000') // overwritten
  })

  it('rejects id_conflict on accept: same self_id, DIFFERENT mailbox_addr (unrelated wechat-cc peer) — no write, no card drop', async () => {
    const relay = makeFakeRelay(); const regB = makeFakeRegistry(); const notifyB = vi.fn()
    // B already has an UNRELATED peer filed under the legacy shared id 'wechat-cc'.
    regB.records.set('wechat-cc', { id: 'wechat-cc', name: 'someone-else', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'ob', capabilities: [], paused: false, transport: 'mailbox', mailbox_addr: 'OTHER_MB' })
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
    regA.records.set('wechat-cc', { id: 'wechat-cc', name: 'someone-else', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'ob', capabilities: [], paused: false, transport: 'mailbox', mailbox_addr: 'OTHER_MB' })
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
})
