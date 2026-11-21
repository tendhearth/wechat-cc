/**
 * places-store.ts —— 「地方」存下的顺序 / 名字 / 收起(v117;设计稿 2026-11-18-cc-two-sides-design.md §3)。
 * 只存主人定的东西;每一行现在怎么样由 features/roster/places-reader.ts 每次现算。
 */
import type { PlaceMapBranchT } from '@wechat-cc/protocol'
import type { Db } from '../../lib/db'
import type { PlaceRecord } from '../../domain/places'

export interface PlacesStore {
  mapPins(key: string, ids: string[]): Map<string, PlaceMapBranchT>
  setMapPin(key: string, id: string, branch: PlaceMapBranchT | null): void
  list(): PlaceRecord[]
  /** 新见到的地方;已有(同 key 或同 root)的不动。 */
  add(records: PlaceRecord[], now: number): void
  /** 挪到第 `to` 位(从 0 数,超出就放最后);其余按原顺序顺下去。没有这个 key ⇒ false。 */
  move(key: string, to: number): boolean
  setHidden(key: string, hidden: boolean): boolean
  /** 主人看了这一行(v118)。时间只往后走。没有这个 key ⇒ false。 */
  markSeen(key: string, at: number): boolean
}

type Row = { key: string; root: string; name: string; position: number; hidden: number; seen_at: number | null }

// Start at the current projection. Only explicit replacement links carry a placement forward.
const mapAncestors = `WITH RECURSIVE ancestors(root, item_id, depth) AS (
  SELECT value, value, 0 FROM json_each(?)
  UNION
  SELECT a.root, 'e:' || e.id, a.depth + 1
  FROM ancestors a JOIN topic_entries e ON e.superseded_by = substr(a.item_id, 3)
  WHERE a.depth < 8 AND substr(a.item_id, 1, 2) = 'e:' AND e.status = 'superseded'
)`

export function makePlacesStore(db: Db): PlacesStore {
  const list = (): PlaceRecord[] => db.query<Row, []>('SELECT key, root, name, position, hidden, seen_at FROM places ORDER BY position, key').all()
    .map(r => ({ key: r.key, root: r.root, name: r.name, position: r.position, hidden: r.hidden === 1, seenAt: r.seen_at }))
  return {
    list,
    mapPins(key, ids) {
      const rows = db.query<{ root: string; branch: PlaceMapBranchT }, [string, string]>(`
        ${mapAncestors}
        SELECT a.root, p.branch FROM ancestors a
        JOIN place_map_pins p ON p.place_key = ? AND p.item_id = a.item_id
        ORDER BY p.updated_ts, p.rowid
      `).all(JSON.stringify(ids), key)
      return new Map(rows.map(row => [row.root, row.branch]))
    },
    setMapPin(key, id, branch) {
      if (branch === null) {
        // Releasing a replacement also clears inherited pins so the older placement cannot reappear.
        db.query(`${mapAncestors} DELETE FROM place_map_pins
          WHERE place_key = ? AND item_id IN (SELECT item_id FROM ancestors)`).run(JSON.stringify([id]), key)
      } else {
        db.query(`INSERT OR REPLACE INTO place_map_pins(place_key, item_id, branch, updated_ts)
          VALUES (?, ?, ?, ?)`).run(key, id, branch, new Date().toISOString())
      }
    },
    add(records, now) {
      if (!records.length) return
      const ins = db.query('INSERT OR IGNORE INTO places(key, root, name, position, hidden, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      db.transaction(() => { for (const r of records) ins.run(r.key, r.root, r.name, r.position, r.hidden ? 1 : 0, now) })()
    },
    move(key, to) {
      const rows = list()
      const at = rows.findIndex(r => r.key === key)
      if (at < 0) return false
      const [row] = rows.splice(at, 1)
      rows.splice(Math.min(Math.max(0, to), rows.length), 0, row!)
      const upd = db.query('UPDATE places SET position = ? WHERE key = ?')
      db.transaction(() => { rows.forEach((r, i) => upd.run(i, r.key)) })()
      return true
    },
    setHidden(key, hidden) {
      return db.query('UPDATE places SET hidden = ? WHERE key = ?').run(hidden ? 1 : 0, key).changes > 0
    },
    markSeen(key, at) {
      return db.query('UPDATE places SET seen_at = MAX(COALESCE(seen_at, 0), ?) WHERE key = ?').run(at, key).changes > 0
    },
  }
}
