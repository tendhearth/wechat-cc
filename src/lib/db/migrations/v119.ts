import type { Migration } from './types'

export const migration: Migration = db => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebook_entries (
      id TEXT PRIMARY KEY NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('owner', 'cc')),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
      created_at INTEGER NOT NULL,
      ref_id TEXT REFERENCES notebook_entries(id),
      struck_at INTEGER CHECK (struck_at IS NULL OR author = 'owner'),
      origin TEXT NOT NULL CHECK (origin IN ('desktop', 'app', 'chat')),
      client_id TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS notebook_entries_time ON notebook_entries(created_at);
    CREATE TABLE IF NOT EXISTS notebook_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `)
}
