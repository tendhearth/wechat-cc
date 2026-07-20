/**
 * mailbox-auth.ts — the relay's ownership proof for fetch/ack. The mailbox
 * address IS an Ed25519 pubkey; a fetch/ack must carry a detached signature
 * over a fixed message string, proving the caller holds the mailbox private
 * key. A freshness window bounds replay. (X25519 can't sign — hence Ed25519;
 * see the plan's Resolved-ambiguities.) See spec §3.1.
 */
import { verify as edVerify, createPublicKey } from 'node:crypto'

const FRESHNESS_MS = 5 * 60_000

function verifySig(mailbox: string, message: string, sig: string, ts: number, now: number): boolean {
  if (Math.abs(now - ts) > FRESHNESS_MS) return false
  try {
    const pub = createPublicKey({ key: Buffer.from(mailbox, 'base64url'), format: 'der', type: 'spki' })
    return edVerify(null, Buffer.from(message, 'utf8'), pub, Buffer.from(sig, 'base64url'))
  } catch { return false }
}

export function verifyFetchSig(mailbox: string, ts: number, sig: string, now: number): boolean {
  return verifySig(mailbox, `fetch:${mailbox}:${ts}`, sig, ts, now)
}
export function verifyAckSig(mailbox: string, upToCursor: number, ts: number, sig: string, now: number): boolean {
  return verifySig(mailbox, `ack:${mailbox}:${upToCursor}:${ts}`, sig, ts, now)
}
