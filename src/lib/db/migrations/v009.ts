import type { Migration } from './types'

// v9 — identity columns on conversations (chatId → userId/accountId/lastUserName).
// Surfaces WeChat identity alongside mode so the dashboard can primary-display
// user (instead of opaque chatId) and the in-memory accountChatIndex from
// v0.6 PR4 can be replaced by `WHERE account_id = ?`. SQLite's STRICT mode
// doesn't allow ALTER TABLE...ADD COLUMN with constraints; nullable TEXT is
// the simplest forward-compatible shape — older rows get NULL until next
// inbound repopulates via the upcoming mw-identity middleware.
export const migration: Migration = (db) => {
    db.exec(`
      ALTER TABLE conversations ADD COLUMN user_id TEXT;
      ALTER TABLE conversations ADD COLUMN account_id TEXT;
      ALTER TABLE conversations ADD COLUMN last_user_name TEXT;
    `)
  }
