import type { Migration } from './types'

// v3 — conversations (chatId → Mode). PR7 commit 3.
// Mode is normalized into separate columns so future queries (e.g.
// "all chats currently using codex") don't need JSON1 extension.
// Only `solo` mode uses mode_provider; only `primary_tool` uses
// mode_primary; `parallel` / `chatroom` use neither.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        chat_id TEXT PRIMARY KEY NOT NULL,
        mode_kind TEXT NOT NULL CHECK (mode_kind IN ('solo', 'primary_tool', 'parallel', 'chatroom')),
        mode_provider TEXT,
        mode_primary TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `)
  }
