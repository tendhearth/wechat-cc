import type { Migration } from './types'

// v120 — 主人在实验图上放置的条目。
export const migration: Migration = db => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS place_map_pins (
      place_key TEXT NOT NULL,
      item_id TEXT NOT NULL,
      branch TEXT NOT NULL CHECK(branch IN ('open','active','decided','done','noted')),
      updated_ts TEXT NOT NULL,
      PRIMARY KEY(place_key,item_id)
    ) STRICT
  `)
}
