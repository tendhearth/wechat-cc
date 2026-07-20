/**
 * pairing.integration.test.ts — two REAL pairing engines against the REAL
 * in-process relay (relay/server.ts's fetchHandler, same idiom as
 * relay/server.test.ts). Proves the round-trip through the actual relay
 * auth/store code, not a Map fake — and (Critical-1 regression guard) that
 * the peer record registry.add() writes during accept() survives on disk
 * through a real createA2ARegistry + resolveSelfAgentId, across a second
 * pairing.
 *
 * Interface note: `start()` is async (`Promise<PairStartResult>` =
 * `{ok:true, code, expiresAt} | {ok:false, reason:'relay_drop_failed'}`) and
 * `accept()` is drop-first (drops the acceptor card before writing the
 * peer). See src/core/pairing.ts + pairing.test.ts for the current surface.
 */
import { describe, it, expect } from 'vitest'
import { Database } from 'bun:sqlite'
import { makeRelayServer } from '../../relay/server'
import { makePairing, type PairingDeps } from './pairing'
import type { MailboxClient } from './mailbox-client'

const NOW = 1_700_000_000_000

// A MailboxClient that speaks to an in-process relay via its fetchHandler
// (same idiom as relay/server.test.ts). drop/fetch only — pairing never acks.
function inProcessClient(srv: ReturnType<typeof makeRelayServer>): MailboxClient {
  const req = (path: string, body: unknown) => new Request(`http://relay${path}`, { method: 'POST', body: JSON.stringify(body) })
  return {
    async drop(_url, to, envelope) { return (await srv.fetchHandler(req('/drop', { to, envelope }), '127.0.0.1')).ok },
    async fetch(_url, mailbox, since, ts, sig) {
      const r = await srv.fetchHandler(req('/fetch', { mailbox, since, ts, sig }), '127.0.0.1')
      if (!r.ok) return null
      return await r.json() as { items: Array<{ cursor: number; envelope: string }>; next_cursor: number }
    },
    async ack() { throw new Error('ack must not be called during pairing') },
  }
}

// A tiny in-memory A2ARegistry for the test (add/get/remove only).
function memRegistry() {
  const m = new Map<string, any>()
  return { m, list: () => [...m.values()], get: (id: string) => m.get(id) ?? null, verifyBearer: () => null,
    add: (r: any) => { if (m.has(r.id)) throw new Error('exists'); m.set(r.id, r) }, remove: (id: string) => { m.delete(id) },
    setPaused: () => {}, update: (id: string) => m.get(id) } as any
}

function makeScheduler() {
  let armed: (() => void) | null = null; let cancelled = false
  return { schedule: ((fn: () => void) => { armed = fn; return { cancel() { cancelled = true; armed = null } } }) as PairingDeps['schedule'],
    tick: () => armed && !cancelled && armed(), get cancelled() { return cancelled } }
}

describe('pairing integration (two engines, one in-process relay)', () => {
  it('start → accept → poll: both registries get a correct, url-less mailbox record; keys cross', async () => {
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW })
    const client = inProcessClient(srv)
    const regA = memRegistry(); const regB = memRegistry(); const sched = makeScheduler()
    const relays = ['https://brain.example/mailbox']

    const A = makePairing({
      client, registry: regA, self: { mailbox_addr: 'A_MB', mailbox_enc_pub: 'A_EP', relays },
      selfId: () => 'cc-aaaa1111', name: () => 'Alice', now: () => NOW,
      mintKey: () => 'A-inbound-key-0000000000', genCode: () => '246810', genNonce: () => 'nA',
      notify: () => {}, schedule: sched.schedule,
    })
    const B = makePairing({
      client, registry: regB, self: { mailbox_addr: 'B_MB', mailbox_enc_pub: 'B_EP', relays },
      selfId: () => 'cc-bbbb2222', name: () => 'Bob', now: () => NOW,
      mintKey: () => 'B-inbound-key-0000000000', genCode: () => 'unused', genNonce: () => 'nB',
      notify: () => {}, schedule: () => ({ cancel() {} }),
    })

    const startRes = await A.start()
    expect(startRes.ok).toBe(true)
    if (!startRes.ok) throw new Error('unreachable')
    const { code } = startRes
    const res = await B.accept(code)
    expect(res.ok).toBe(true)

    sched.tick()
    await new Promise(r => setTimeout(r, 0))

    const a = regA.m.get('cc-bbbb2222'); const b = regB.m.get('cc-aaaa1111')
    expect(a.transport).toBe('mailbox'); expect(a.url).toBeUndefined()
    expect(b.transport).toBe('mailbox'); expect(b.url).toBeUndefined()
    // self_id cross-reference
    expect(a.id).toBe('cc-bbbb2222'); expect(b.id).toBe('cc-aaaa1111')
    // bearer crossing
    expect(a.outbound_api_key).toBe(b.inbound_api_key) // B-inbound-key
    expect(b.outbound_api_key).toBe(a.inbound_api_key) // A-inbound-key
    // mailbox fields carried across
    expect(a.mailbox_addr).toBe('B_MB'); expect(b.mailbox_addr).toBe('A_MB')
    // records validate under the (url-optional) schema:
    const { A2AAgentRecord } = await import('../lib/agent-config')
    expect(A2AAgentRecord.safeParse(a).success).toBe(true)
    expect(A2AAgentRecord.safeParse(b).success).toBe(true)
  })

  it('cards on the relay are ciphertext (content-blind spot-check)', async () => {
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW })
    const client = inProcessClient(srv)
    const regA = memRegistry(); const sched = makeScheduler()
    const relays = ['https://brain.example/mailbox']

    const A = makePairing({
      client, registry: regA, self: { mailbox_addr: 'A_MB', mailbox_enc_pub: 'A_EP', relays },
      selfId: () => 'cc-aaaa1111', name: () => 'Alice', now: () => NOW,
      mintKey: () => 'A-inbound-key-0000000000', genCode: () => '135791', genNonce: () => 'nA',
      notify: () => {}, schedule: sched.schedule,
    })
    const startRes = await A.start()
    expect(startRes.ok).toBe(true)
    if (!startRes.ok) throw new Error('unreachable')

    // Fetch the raw box straight off the relay (no MailboxClient/pairing
    // decoding involved) and confirm it never leaks plaintext card fields.
    const { deriveRendezvous } = await import('./pairing-crypto')
    const rv = deriveRendezvous(startRes.code)
    const { signFetch } = await import('./mailbox-crypto')
    const ts = NOW
    const fReq = new Request('http://relay/fetch', { method: 'POST', body: JSON.stringify({ mailbox: rv.addr, since: 0, ts, sig: signFetch(rv.sign, rv.addr, ts) }) })
    const fRes = await srv.fetchHandler(fReq, '127.0.0.1')
    expect(fRes.ok).toBe(true)
    const page = await fRes.json() as { items: Array<{ cursor: number; envelope: string }> }
    expect(page.items.length).toBe(1)
    const raw = page.items[0]!.envelope
    // The relay stores whatever the client dropped verbatim (content-blind);
    // the dropped envelope is itself JSON (sealEnvelope's wire format), so
    // assert on what must NOT appear inside it: the plaintext card fields.
    expect(raw).not.toContain('Alice')
    expect(raw).not.toContain('cc-aaaa1111')
    expect(raw).not.toContain('A-inbound-key-0000000000')
    expect(raw).not.toContain('A_MB')
    expect(raw).not.toContain('initiator')
  })

  // CRITICAL-1 regression: reproduce the exact clobber trace against a REAL
  // registry (writes agent-config.json) + the REAL resolver (persists
  // self_agent_id), memoizing selfId ONCE the way wire-pairing does. The peer
  // record registry.add wrote must SURVIVE on disk after accept() — and after a
  // second pairing (proving the resolver's merge-persist never wipes a2a_agents).
  it('the written peer record survives on disk after accept() and a second pairing', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const { createA2ARegistry } = await import('./a2a-registry')
    const { loadAgentConfig } = await import('../lib/agent-config')
    const { resolveSelfAgentId } = await import('./self-agent-id')

    const stateDir = mkdtempSync(join(tmpdir(), 'pair-disk-'))
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude', mailbox_relays: ['https://brain.example/mailbox'] }))
    const srv = makeRelayServer({ db: new Database(':memory:'), now: () => NOW })
    const client = inProcessClient(srv)
    const relays = ['https://brain.example/mailbox']

    const registryB = createA2ARegistry({ stateDir })              // REAL — read-modify-writes agent-config.json
    const selfIdB = resolveSelfAgentId(loadAgentConfig(stateDir), stateDir) // resolved ONCE (persists self_agent_id via merge)
    const B = makePairing({
      client, registry: registryB, self: { mailbox_addr: 'B_MB', mailbox_enc_pub: 'B_EP', relays },
      selfId: () => selfIdB, name: () => 'Bob', now: () => NOW,
      mintKey: () => 'B-inbound-key-0000000000', genCode: () => 'x', genNonce: () => 'nB',
      notify: () => {}, schedule: () => ({ cancel() {} }),
    })
    const initiator = (id: string, code: string) => makePairing({
      client, registry: memRegistry(), self: { mailbox_addr: `${id}_MB`, mailbox_enc_pub: 'EP', relays },
      selfId: () => id, name: () => id, now: () => NOW,
      mintKey: () => `${id}-key-000000000000`, genCode: () => code, genNonce: () => `n-${id}`,
      notify: () => {}, schedule: () => ({ cancel() {} }),
    })

    const p1 = initiator('cc-aaaa1111', '135790')
    {
      const startRes = await p1.start()
      expect(startRes.ok).toBe(true)
      if (!startRes.ok) throw new Error('unreachable')
      expect((await B.accept(startRes.code)).ok).toBe(true)
    }
    const disk1 = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect(disk1.self_agent_id).toBe(selfIdB)
    expect(disk1.a2a_agents.map((a: any) => a.id)).toContain('cc-aaaa1111') // survived, not wiped

    const p2 = initiator('cc-cccc3333', '246802')
    {
      const startRes = await p2.start()
      expect(startRes.ok).toBe(true)
      if (!startRes.ok) throw new Error('unreachable')
      expect((await B.accept(startRes.code)).ok).toBe(true)
    }
    const disk2 = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect(disk2.a2a_agents.map((a: any) => a.id).sort()).toEqual(['cc-aaaa1111', 'cc-cccc3333']) // BOTH survive
  })
})
