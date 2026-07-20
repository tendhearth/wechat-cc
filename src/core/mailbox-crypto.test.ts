import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verify as edVerify, createPublicKey } from 'node:crypto'
import { generateMailboxIdentity, loadMailboxIdentity, sealEnvelope, openEnvelope, signFetch } from './mailbox-crypto'

describe('mailbox-crypto', () => {
  it('sealEnvelope → openEnvelope round-trips the inner {path,bearer,body}; wrong recipient → null', () => {
    const me = generateMailboxIdentity(); const other = generateMailboxIdentity()
    const inner = { path: '/a2a/letter', bearer: 'tok123', body: { channel_id: 'c', ct: 'x' } }
    const env = sealEnvelope(inner, me.enc_pub)
    expect(env.eph_pub).toBeTruthy(); expect(env.eph_pub).not.toBe(me.enc_pub)   // ephemeral, not the sender's identity
    expect(openEnvelope(me.enc_priv, env)).toEqual(inner)
    expect(openEnvelope(other.enc_priv, env)).toBeNull()                          // not for them
  })

  it('openEnvelope returns null (no throw) on a tampered envelope', () => {
    const me = generateMailboxIdentity()
    const env = sealEnvelope({ path: '/a2a/letter', bearer: 'b', body: 1 }, me.enc_pub)
    expect(openEnvelope(me.enc_priv, { ...env, ct: env.ct.slice(0, -2) + 'AA' })).toBeNull()
  })

  it('two seals of the same inner use different ephemeral keys (unlinkable)', () => {
    const me = generateMailboxIdentity()
    const a = sealEnvelope({ path: '/p', bearer: 'b', body: 0 }, me.enc_pub)
    const b = sealEnvelope({ path: '/p', bearer: 'b', body: 0 }, me.enc_pub)
    expect(a.eph_pub).not.toBe(b.eph_pub)
  })

  it('loadMailboxIdentity is gen-once + stable, and sign() verifies against addr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbx-'))
    const id1 = loadMailboxIdentity(dir); const id2 = loadMailboxIdentity(dir)
    expect(id2.addr).toBe(id1.addr); expect(id2.enc_pub).toBe(id1.enc_pub)   // stable across loads
    const now = 1_700_000_000_000
    const sig = signFetch(id1.sign, id1.addr, now)
    const pub = createPublicKey({ key: Buffer.from(id1.addr, 'base64url'), format: 'der', type: 'spki' })
    expect(edVerify(null, Buffer.from(`fetch:${id1.addr}:${now}`, 'utf8'), pub, Buffer.from(sig, 'base64url'))).toBe(true)
  })
})
