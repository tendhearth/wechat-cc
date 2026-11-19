import { randomUUID } from 'node:crypto'
import type { NotebookEntry } from '../../domain/notebook'
import type { NotebookSettings, NotebookStore } from '../../ports/notebook'
import type { Db } from '../../lib/db'

const columns = 'id, author, body, created_at AS createdAt, ref_id AS refId, struck_at AS struckAt, origin, client_id AS clientId'

export function makeNotebookStore(db: Db): NotebookStore {
  return {
    get<K extends keyof NotebookSettings>(key: K): NotebookSettings[K] | null {
      const row = db.query<{ value: string }, [string]>('SELECT value FROM notebook_settings WHERE key = ?').get(key)
      return row ? JSON.parse(row.value) as NotebookSettings[K] : null
    },
    set(key, value) {
      db.query('INSERT INTO notebook_settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
    },
    append(entry) {
      const result = db.query<NotebookEntry, [string, string, string, number, string | null, string, string | null]>(`
        INSERT INTO notebook_entries(id, author, body, created_at, ref_id, origin, client_id)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO NOTHING RETURNING ${columns}
      `).get(randomUUID(), entry.author, entry.body, entry.createdAt, entry.refId, entry.origin, entry.clientId)
      return result ?? db.query<NotebookEntry, [string | null]>(`SELECT ${columns} FROM notebook_entries WHERE client_id = ?`).get(entry.clientId)!
    },
    strike(id, at) {
      const result = db.query("UPDATE notebook_entries SET struck_at = ? WHERE id = ? AND author = 'owner'").run(at, id)
      if (result.changes) return 'ok'
      return db.query('SELECT 1 FROM notebook_entries WHERE id = ?').get(id) ? 'cc' : 'missing'
    },
    byId(id) {
      return db.query<NotebookEntry, [string]>(`SELECT ${columns} FROM notebook_entries WHERE id = ?`).get(id)
    },
    timestamps() {
      return db.query<{ created_at: number }, []>('SELECT DISTINCT created_at FROM notebook_entries ORDER BY created_at DESC').all().map(row => row.created_at)
    },
    list({ since = 0, until = Number.MAX_SAFE_INTEGER, limit = -1, query = '', ownerOnly = false } = {}) {
      return db.query<NotebookEntry, [number, number, string, number]>(`
        SELECT ${columns} FROM notebook_entries
        WHERE created_at >= ? AND created_at < ? AND instr(body, ?) > 0
        ${ownerOnly ? "AND author = 'owner'" : ''}
        ORDER BY created_at DESC, (author = 'cc' AND origin != 'chat' AND ref_id IS NULL), rowid DESC LIMIT ?
      `).all(since, until, query, limit).reverse()
    },
    atomic(fn) { return db.transaction(fn).immediate() },
  }
}
