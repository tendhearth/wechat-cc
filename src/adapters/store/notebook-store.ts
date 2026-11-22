import { randomUUID } from 'node:crypto'
import type { NotebookRow } from '../../domain/notebook'
import type { NotebookSettings, NotebookStore } from '../../ports/notebook'
import type { Db } from '../../lib/db'
import { localParts } from '../../lib/local-time'

const columns = 'id, author, body, created_at AS createdAt, ref_id AS refId, struck_at AS struckAt, origin, client_id AS clientId'

const openingEntry = "(author = 'cc' AND origin != 'chat' AND ref_id IS NULL)"

export function makeNotebookStore(db: Db): NotebookStore {
  let calendar: { timezone: string; days: Set<string>; sorted?: string[] } | undefined
  return {
    get<K extends keyof NotebookSettings>(key: K): NotebookSettings[K] | null {
      const row = db.query<{ value: string }, [string]>('SELECT value FROM notebook_settings WHERE key = ?').get(key)
      if (!row) return null
      const value = JSON.parse(row.value)
      if (key === 'pen' && value?.font === 'xingkai') value.font = 'hand'
      return value as NotebookSettings[K]
    },
    set(key, value) {
      db.query('INSERT INTO notebook_settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
    },
    append(entry) {
      const result = db.query<NotebookRow, [string, string, string, number, string | null, string, string | null]>(`
        INSERT INTO notebook_entries(id, author, body, created_at, ref_id, origin, client_id)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO NOTHING RETURNING ${columns}
      `).get(randomUUID(), entry.author, entry.body, entry.createdAt, entry.refId, entry.origin, entry.clientId)
      if (result && calendar) {
        const day = localParts(result.createdAt, calendar.timezone).day
        if (!calendar.days.has(day)) {
          calendar.days.add(day)
          calendar.sorted = undefined
        }
      }
      return result ?? db.query<NotebookRow, [string | null]>(`SELECT ${columns} FROM notebook_entries WHERE client_id = ?`).get(entry.clientId)!
    },
    strike(id, at) {
      const result = db.query("UPDATE notebook_entries SET struck_at = ? WHERE id = ? AND author = 'owner'").run(at, id)
      if (result.changes) return 'ok'
      return db.query('SELECT 1 FROM notebook_entries WHERE id = ?').get(id) ? 'cc' : 'missing'
    },
    byId(id) {
      return db.query<NotebookRow, [string]>(`SELECT ${columns} FROM notebook_entries WHERE id = ?`).get(id)
    },
    referenceTimestamps(ids) {
      return db.query<{ id: string; createdAt: number }, [string]>(`
        SELECT entry.id, entry.created_at AS createdAt
        FROM json_each(?) AS ref
        CROSS JOIN notebook_entries AS entry ON entry.id = ref.value
      `).all(JSON.stringify(ids))
    },
    firstUnseenReplyAfter(at, seenIds) {
      return db.query<{ createdAt: number }, [number, string]>(`
        SELECT created_at AS createdAt FROM notebook_entries
        WHERE created_at > ? AND author = 'cc' AND ref_id IS NOT NULL
          AND id NOT IN (SELECT value FROM json_each(?))
        ORDER BY created_at LIMIT 1
      `).get(at, JSON.stringify(seenIds))?.createdAt ?? null
    },
    occupiedDays(timezone) {
      // Build once per timezone from the covering timestamp index. Appends
      // maintain the calendar so page reads only query the selected day.
      if (calendar?.timezone !== timezone) {
        const days = new Set<string>()
        for (const row of db.query<{ created_at: number }, []>('SELECT DISTINCT created_at FROM notebook_entries').iterate()) {
          days.add(localParts(row.created_at, timezone).day)
        }
        calendar = { timezone, days }
      }
      return calendar.sorted ??= [...calendar.days].sort().reverse()
    },
    list({ since = 0, until = Number.MAX_SAFE_INTEGER, limit = -1, query = '', olderThan = null, ownerOnly = false } = {}) {
      return db.query<NotebookRow, [number, number, string, string | null, string | null, number]>(`
        SELECT ${columns} FROM notebook_entries
        WHERE created_at >= ? AND created_at < ? AND instr(body, ?) > 0
        ${ownerOnly ? "AND author = 'owner'" : ''}
        AND (? IS NULL OR (created_at, -${openingEntry}, rowid) <
          (SELECT created_at, -${openingEntry}, rowid FROM notebook_entries WHERE id = ?))
        ORDER BY created_at DESC, ${openingEntry}, rowid DESC LIMIT ?
      `).all(since, until, query, olderThan, olderThan, limit).reverse()
    },
    atomic(fn) {
      try {
        return db.transaction(fn).immediate()
      } catch (error) {
        // An append may have updated the calendar before SQLite rolled back.
        calendar = undefined
        throw error
      }
    },
  }
}
