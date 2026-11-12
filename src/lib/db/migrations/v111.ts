import type { Migration } from './types'

// v111 — dependencies of model-derived entries; originals stay live.
// source_id keeps a tombstone when its topic is explicitly deleted: lost evidence
// must hide dependents, never cascade away their provenance.
export const migration: Migration = db => {
  db.exec(`CREATE TABLE IF NOT EXISTS topic_entry_sources (
    entry_id TEXT NOT NULL REFERENCES topic_entries(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    PRIMARY KEY(entry_id, source_id), CHECK(entry_id != source_id)
  );
  CREATE INDEX IF NOT EXISTS topic_entry_sources_source ON topic_entry_sources(source_id);`)
}
