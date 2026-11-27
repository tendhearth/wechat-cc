import { hasTable } from '../schema-helpers'
import type { Migration } from './types'

// v123 — hooks report the terminal location. Older rows have no location.
export const migration: Migration = db => {
  if (!hasTable(db, 'cli_sessions')) return
  const columns = db.query<{ name: string }, []>("PRAGMA table_info('cli_sessions')").all()
  if (!columns.some(column => column.name === 'terminal_json')) {
    db.exec('ALTER TABLE cli_sessions ADD COLUMN terminal_json TEXT')
  }
}
