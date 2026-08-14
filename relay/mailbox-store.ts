/**
 * mailbox-store.ts — the relay's content-blind store-and-forward table.
 * `envelope` is opaque bytes: the store never parses it. One monotonic cursor
 * per row (SQLite AUTOINCREMENT); fetch is a since-cursor page; ack deletes at
 * or below a cursor; TTL + a per-recipient depth cap bound storage.
 * See docs/superpowers/specs/2026-07-19-penpal-mailbox-transport-B-design.md §3.1.
 */
import type { Database } from 'bun:sqlite'

export interface MailboxStore {
  drop(to: string, envelope: string, now: number): void
  fetchSince(mailbox: string, since: number, now: number, limit: number): { items: Array<{ cursor: number; envelope: string }>; next_cursor: number }
  ackUpTo(mailbox: string, upToCursor: number): void
  sweep(now: number): number
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000   // 7 days
const DEFAULT_DEPTH_CAP = 256

export function makeMailboxStore(db: Database, opts: { ttlMs?: number; depthCap?: number } = {}): MailboxStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const depthCap = opts.depthCap ?? DEFAULT_DEPTH_CAP
  db.run(`CREATE TABLE IF NOT EXISTS mailbox_item (
    recipient TEXT NOT NULL,
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    envelope BLOB NOT NULL,
    expires_at INTEGER NOT NULL
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_mailbox_item_to ON mailbox_item(recipient, cursor)')

  const insert = db.query('INSERT INTO mailbox_item (recipient, envelope, expires_at) VALUES (?, ?, ?)')
  const trim = db.query(`DELETE FROM mailbox_item WHERE recipient = ?1 AND cursor NOT IN
    (SELECT cursor FROM mailbox_item WHERE recipient = ?1 ORDER BY cursor DESC LIMIT ?2)`)
  const selectSince = db.query('SELECT cursor, envelope FROM mailbox_item WHERE recipient = ? AND cursor > ? AND expires_at > ? ORDER BY cursor ASC LIMIT ?')
  const del = db.query('DELETE FROM mailbox_item WHERE recipient = ? AND cursor <= ?')
  const sweepQ = db.query('DELETE FROM mailbox_item WHERE expires_at <= ?')

  return {
    drop(to, envelope, now) {
      insert.run(to, envelope, now + ttlMs)
      trim.run(to, depthCap)
    },
    fetchSince(mailbox, since, now, limit) {
      const rows = selectSince.all(mailbox, since, now, limit) as Array<{ cursor: number; envelope: string }>
      const next_cursor = rows.length > 0 ? rows[rows.length - 1]!.cursor : since
      return { items: rows.map(r => ({ cursor: r.cursor, envelope: String(r.envelope) })), next_cursor }
    },
    ackUpTo(mailbox, upToCursor) { del.run(mailbox, upToCursor) },
    sweep(now) { return sweepQ.run(now).changes },
  }
}
