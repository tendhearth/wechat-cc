import type { Migration } from './types'

// v121 — latest private outline for each place in the map experiment.
export const migration: Migration = db => {
  db.exec(`CREATE TABLE IF NOT EXISTS place_outlines (
    place_key TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK(state IN ('running','ready','empty','failed')),
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    call_day TEXT NOT NULL DEFAULT '',
    started_ts TEXT NOT NULL,
    finished_ts TEXT NOT NULL DEFAULT ''
  ) STRICT`)
}
