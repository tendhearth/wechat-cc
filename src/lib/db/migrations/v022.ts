import type { Migration } from './types'

// v22 — 匿名笔友通道 (sub-project A). The E2E pen-pal channel: penpal_channel
// holds the per-connection X25519 keypair (my_privkey LOCAL-only) + the peer's
// crossed handle (pubkey + channel id), nullable until mutual reveal opens the
// channel. penpal_letter is the local correspondence thread — sealed ct+nonce+tag
// on the wire, decrypted plaintext kept locally for the owner. social_relay gains
// two nullable handle columns so the intermediary (W) can persist each endpoint's
// presented pubkey handle to hand to the OTHER leg — W crosses pubkeys the
// endpoints supplied, never a real identity. Nullable-TEXT ADD COLUMN is safe on
// STRICT; social_relay is created unconditionally by v21, so the ALTER is safe
// even in the user_version=9 test harnesses.
// See docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md.
export const migration: Migration = (db) => {
    db.exec(`
      ALTER TABLE social_relay ADD COLUMN upstream_handle TEXT;
      ALTER TABLE social_relay ADD COLUMN downstream_handle TEXT;
      CREATE TABLE IF NOT EXISTS penpal_channel (
        id                TEXT PRIMARY KEY,        -- = the echo/pledge/relay-leg id it opened from
        seek_id           TEXT NOT NULL,           -- the local seek (or intent) this channel belongs to
        my_privkey        TEXT NOT NULL,           -- LOCAL-only X25519 private (pkcs8 DER base64url)
        my_pubkey         TEXT NOT NULL,           -- crossed to the peer (spki DER base64url)
        my_channel_id     TEXT NOT NULL,           -- my inbound address; peer addresses letters TO me by it
        peer_pubkey       TEXT,                    -- crossed FROM the peer (nullable until reveal)
        peer_channel_id   TEXT,                    -- peer's inbound address (nullable until reveal)
        degree            INTEGER NOT NULL DEFAULT 1,
        relay_via         TEXT,                    -- the intermediary agent id for a 2-hop channel (nullable)
        peer_agent_id     TEXT,                    -- direct peer's agent id (nullable for relay channels)
        status            TEXT NOT NULL,           -- 'pending' | 'open'
        created_at        TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_penpal_channel_mychan ON penpal_channel(my_channel_id);
      CREATE TABLE IF NOT EXISTS penpal_letter (
        id                TEXT PRIMARY KEY,
        channel_id        TEXT NOT NULL,
        direction         TEXT NOT NULL,           -- 'in' | 'out'
        sealed_ciphertext TEXT NOT NULL,           -- base64url AES-GCM ct (the ONLY thing on the wire)
        nonce             TEXT NOT NULL,           -- base64url 12-byte GCM nonce
        tag               TEXT NOT NULL,           -- base64url GCM auth tag
        plaintext         TEXT NOT NULL,           -- decrypted, kept LOCAL for the owner's thread
        created_at        TEXT NOT NULL,
        read_at           TEXT                     -- nullable; set when the owner has seen it
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_penpal_letter_channel ON penpal_letter(channel_id);
    `)
  }
