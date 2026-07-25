/**
 * pairing-crypto.ts — derive a DETERMINISTIC rendezvous identity from a pairing
 * code (spec §4). Both peers run this on the SAME 6-digit code and get the SAME
 * Ed25519 mailbox address + X25519 encryption keypair, letting them use the
 * already-deployed content-blind relay as a shared meeting box with NO relay
 * change. FIXED HKDF params — the relay URL is deliberately NOT mixed in (two
 * peers' configured URL strings need not be byte-identical; §4).
 *
 * node:crypto has no "import a raw 32-byte Ed25519/X25519 seed" API, so we wrap
 * the seed in a fixed PKCS#8 DER prefix (the algorithm header + the `04 20`
 * OCTET STRING tag/length) and hand the concatenation to createPrivateKey.
 * Prefixes verified against node:crypto (see the plan's Global Constraints and
 * pairing-crypto.test.ts). The result is a structural superset of MailboxIdentity,
 * so it drops straight into sealEnvelope / openEnvelope / signFetch.
 */
import { hkdfSync, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto'

/** Same shape as MailboxIdentity — usable by sealEnvelope/openEnvelope/signFetch. */
export interface RendezvousIdentity { addr: string; enc_pub: string; enc_priv: string; sign(message: string): string }

// Domain-separation constants — FIXED on both sides (spec §4). Never add relayUrl.
const HKDF_SALT = Buffer.from('wcc-pair-v1')
const HKDF_INFO = Buffer.from('rendezvous')
const OKM_LEN = 64 // 32B Ed25519 seed + 32B X25519 seed

// PKCS#8 DER prefixes: algorithm header for the curve + `04 20` (OCTET STRING,
// length 32) framing the raw seed. Concatenated with a 32-byte seed → a valid
// PKCS#8 private key node:crypto imports.
const ED_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const X_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

export function deriveRendezvous(code: string): RendezvousIdentity {
  const okm = Buffer.from(hkdfSync('sha256', Buffer.from(code, 'utf8'), HKDF_SALT, HKDF_INFO, OKM_LEN))
  const edSeed = okm.subarray(0, 32)
  const xSeed = okm.subarray(32, 64)

  const edPriv = createPrivateKey({ key: Buffer.concat([ED_PKCS8_PREFIX, edSeed]), format: 'der', type: 'pkcs8' })
  // node:crypto's createPublicKey() accepts a private KeyObject at runtime (documented
  // Node.js behavior — derives the public key from the private key); the installed
  // @types/node's createPublicKey() overloads just don't list KeyObject, hence the cast.
  const edPub = createPublicKey(edPriv as unknown as Parameters<typeof createPublicKey>[0])
  const addr = edPub.export({ type: 'spki', format: 'der' }).toString('base64url')

  const xPriv = createPrivateKey({ key: Buffer.concat([X_PKCS8_PREFIX, xSeed]), format: 'der', type: 'pkcs8' })
  const xPub = createPublicKey(xPriv as unknown as Parameters<typeof createPublicKey>[0])
  const enc_pub = xPub.export({ type: 'spki', format: 'der' }).toString('base64url')
  const enc_priv = xPriv.export({ type: 'pkcs8', format: 'der' }).toString('base64url')

  return {
    addr,
    enc_pub,
    enc_priv,
    sign: (message) => edSign(null, Buffer.from(message, 'utf8'), edPriv).toString('base64url'),
  }
}
