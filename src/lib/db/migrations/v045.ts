import type { Migration } from './types'

// v45 — explicit postcard favorites survive journal retention.
export const migration: Migration = (db) => {
    const cols = db.query<{ name: string }, []>('PRAGMA table_info(journal)').all()
    if (cols.length && !cols.some(c => c.name === 'favorite')) {
      db.exec('ALTER TABLE journal ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1))')
    }
  }
