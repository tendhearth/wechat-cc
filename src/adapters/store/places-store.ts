/**
 * places-store.ts —— 「地方」存下的顺序 / 名字 / 收起(v117;设计稿 2026-11-18-cc-two-sides-design.md §3)。
 * 只存主人定的东西;每一行现在怎么样由 features/places 每次现算。
 */
import type { Db } from '../../lib/db'
import type { PlaceRecord } from '../../domain/places'

export interface PlacesStore {
  list(): PlaceRecord[]
  /** 新见到的地方;已有(同 key 或同 root)的不动。 */
  add(records: PlaceRecord[], now: number): void
  /** 挪到第 `to` 位(从 0 数,超出就放最后);其余按原顺序顺下去。没有这个 key ⇒ false。 */
  move(key: string, to: number): boolean
  setHidden(key: string, hidden: boolean): boolean
}

type Row = { key: string; root: string; name: string; position: number; hidden: number }

export function makePlacesStore(db: Db): PlacesStore {
  const list = (): PlaceRecord[] => db.query<Row, []>('SELECT key, root, name, position, hidden FROM places ORDER BY position, key').all()
    .map(r => ({ key: r.key, root: r.root, name: r.name, position: r.position, hidden: r.hidden === 1 }))
  return {
    list,
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
  }
}
