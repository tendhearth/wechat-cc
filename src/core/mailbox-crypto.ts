/**
 * mailbox-crypto.ts — the per-daemon mailbox identity + the content-blind
 * envelope. Two keys in ONE state-dir file (0600):
 *   - Ed25519 (addr): the mailbox address = the drop `to` field AND the
 *     fetch/ack signature key. (X25519 can't sign — see the plan's
 *     Resolved-ambiguities; this is why the identity is Ed25519.)
 *   - X25519 (enc): the sealed-box target the daemon publishes to peers.
 * The envelope is a sealed-box to the peer's enc pubkey with an EPHEMERAL
 * X25519 sender key per drop (unlinkable), reusing penpal-crypto verbatim.
 * Inner plaintext = {path, bearer, body}. See spec §3.2.
 */
import { generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeypair, deriveSharedKey, sealLetter, openLetter } from './penpal-crypto'

export interface Envelope { eph_pub: string; nonce: string; ct: string; tag: string }
export interface EnvelopeInner { path: string; bearer: string; body: unknown }
export interface PeerMailbox { addr: string; enc_pub: string; relays: string[] }
export interface MailboxIdentity { addr: string; enc_pub: string; enc_priv: string; sign(message: string): string }

const KEY_FILE = 'mailbox-key.json'

export function generateMailboxIdentity(): { addr: string; addr_priv: string; enc_pub: string; enc_priv: string } {
  const ed = generateKeyPairSync('ed25519')
  const x = generateKeypair()   // penpal-crypto's X25519 keypair, base64url DER
  return {
    addr: ed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    addr_priv: ed.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    enc_pub: x.publicKey,
    enc_priv: x.privateKey,
  }
}

function toIdentity(k: { addr: string; addr_priv: string; enc_pub: string; enc_priv: string }): MailboxIdentity {
  const priv = createPrivateKey({ key: Buffer.from(k.addr_priv, 'base64url'), format: 'der', type: 'pkcs8' })
  return {
    addr: k.addr, enc_pub: k.enc_pub, enc_priv: k.enc_priv,
    sign: (message) => edSign(null, Buffer.from(message, 'utf8'), priv).toString('base64url'),
  }
}

export function loadMailboxIdentity(stateDir: string): MailboxIdentity {
  const file = join(stateDir, KEY_FILE)
  try {
    return toIdentity(JSON.parse(readFileSync(file, 'utf8')) as { addr: string; addr_priv: string; enc_pub: string; enc_priv: string })
  } catch {
    const k = generateMailboxIdentity()
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(k, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, file)
    return toIdentity(k)
  }
}

export function sealEnvelope(inner: EnvelopeInner, peerEncPub: string): Envelope {
  const eph = generateKeypair()
  const key = deriveSharedKey(eph.privateKey, peerEncPub)
  const sealed = sealLetter(key, JSON.stringify(inner))
  return { eph_pub: eph.publicKey, nonce: sealed.nonce, ct: sealed.ct, tag: sealed.tag }
}

export function openEnvelope(myEncPriv: string, env: Envelope): EnvelopeInner | null {
  try {
    const key = deriveSharedKey(myEncPriv, env.eph_pub)
    const pt = openLetter(key, { nonce: env.nonce, ct: env.ct, tag: env.tag })
    const inner = JSON.parse(pt) as EnvelopeInner
    if (typeof inner.path !== 'string' || typeof inner.bearer !== 'string') return null
    return inner
  } catch { return null }
}

export function signFetch(sign: (m: string) => string, mailbox: string, ts: number): string {
  return sign(`fetch:${mailbox}:${ts}`)
}
export function signAck(sign: (m: string) => string, mailbox: string, upToCursor: number, ts: number): string {
  return sign(`ack:${mailbox}:${upToCursor}:${ts}`)
}
