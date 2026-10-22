import type { Migration } from './types'

// v12 — a2a_events: observability log for A2A inbound/outbound calls.
// See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE a2a_events (
        id TEXT PRIMARY KEY NOT NULL,
        ts TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        urgency TEXT,
        status TEXT NOT NULL DEFAULT 'ok',
        http_status INTEGER
      ) STRICT;
      CREATE INDEX a2a_events_agent_ts ON a2a_events(agent_id, ts DESC);
    `)
  }
