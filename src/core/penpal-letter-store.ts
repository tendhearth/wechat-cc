/**
 * penpal-letter-store.ts — the LOCAL correspondence thread for a channel. The
 * wire only ever carries sealed_ciphertext + nonce + tag; the decrypted
 * plaintext is kept here for the owner (spec §5). Mirrors social-pledge-store.ts.
 */
import type { Db } from '../lib/db'

export interface LetterRow {
  id: string; channel_id: string; direction: 'in' | 'out'
  sealed_ciphertext: string; nonce: string; tag: string
  plaintext: string; created_at: string; read_at: string | null
}
export interface LetterStore {
  create(l: { id: string; channelId: string; direction: 'in' | 'out'; sealedCiphertext: string; nonce: string; tag: string; plaintext: string }): void
  listForChannel(channelId: string): LetterRow[]
  get(id: string): LetterRow | null
  markRead(id: string, at: string): void
  /** M3 — idempotency check: has an INBOUND letter with this (channel_id, nonce)
   *  already been persisted? A mailbox re-fetch after an ack-network-failure
   *  redelivers the same envelope; `correspondent.receiveLetter` uses this to
   *  no-op instead of creating a duplicate row + re-notifying the owner. */
  hasInbound(channelId: string, nonce: string): boolean
}

export function makeLetterStore(db: Db): LetterStore {
  const ins = db.query<unknown, [string, string, string, string, string, string, string, string]>(
    `INSERT INTO penpal_letter(id, channel_id, direction, sealed_ciphertext, nonce, tag, plaintext, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selByChan = db.query<LetterRow, [string]>('SELECT * FROM penpal_letter WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC')
  const selOne = db.query<LetterRow, [string]>('SELECT * FROM penpal_letter WHERE id = ?')
  const updRead = db.query<unknown, [string, string]>('UPDATE penpal_letter SET read_at = ? WHERE id = ?')
  const selInbound = db.query<unknown, [string, string]>("SELECT 1 FROM penpal_letter WHERE channel_id = ? AND nonce = ? AND direction = 'in' LIMIT 1")
  return {
    create(l) { ins.run(l.id, l.channelId, l.direction, l.sealedCiphertext, l.nonce, l.tag, l.plaintext, new Date().toISOString()) },
    listForChannel(channelId) { return selByChan.all(channelId) },
    get(id) { return selOne.get(id) ?? null },
    markRead(id, at) { updRead.run(at, id) },
    hasInbound(channelId, nonce) { return !!selInbound.get(channelId, nonce) },
  }
}
