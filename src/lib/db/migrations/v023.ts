import type { Migration } from './types'

// v23 — mailbox plumbing (sub-project B, additive/GREEN checkpoint). Adds a
// nullable peer_mailbox column to penpal_channel so the peer's relay-direct
// mailbox coordinates (PeerMailbox: addr/enc_pub/relays, JSON) can ride the
// pen-pal reveal alongside pubkey/channel_id. Nothing populates it yet —
// setPeerHandle just carries handle.mailbox through when present; the C1
// fix that actually crosses a mailbox at reveal is a separate task.
// Nullable-TEXT ADD COLUMN is safe on STRICT; penpal_channel is created
// unconditionally by v22, so the ALTER is safe even in older test harnesses.
// See docs/superpowers/plans/2026-07-19-penpal-mailbox-B.md.
export const migration: Migration = (db) => {
    db.exec(`
      ALTER TABLE penpal_channel ADD COLUMN peer_mailbox TEXT;
    `)
  }
