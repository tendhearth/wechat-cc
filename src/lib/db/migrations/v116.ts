import type {Migration} from './types'

// v116 — 终端参与目标事，保留原 CLI binding；历史关系与凭据分开。
export const migration: Migration = db=>{
  db.exec(`CREATE TABLE IF NOT EXISTS terminal_participations (
    id TEXT PRIMARY KEY,
    matter_id TEXT NOT NULL REFERENCES matters(id),
    session_id TEXT NOT NULL,
    source_matter_id TEXT NOT NULL REFERENCES matters(id),
    run_id TEXT NOT NULL UNIQUE,
    generation INTEGER NOT NULL CHECK(generation>0),
    author TEXT NOT NULL,
    attached_at INTEGER NOT NULL,
    detached_at INTEGER,
    detach_reason TEXT,
    UNIQUE(session_id,generation)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS terminal_participation_session ON terminal_participations(session_id) WHERE detached_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS terminal_participation_matter ON terminal_participations(matter_id) WHERE detached_at IS NULL;
  CREATE TRIGGER IF NOT EXISTS terminal_participation_prune AFTER DELETE ON cli_sessions BEGIN
    UPDATE terminal_participations SET detached_at=CAST(strftime('%s','now') AS INTEGER)*1000,detach_reason='pruned' WHERE session_id=OLD.session_id AND detached_at IS NULL;
  END;
  CREATE TRIGGER IF NOT EXISTS terminal_participation_binding_insert AFTER INSERT ON matter_bindings WHEN NEW.surface='cli' BEGIN
    UPDATE terminal_participations SET detached_at=CAST(strftime('%s','now') AS INTEGER)*1000,detach_reason='binding_changed' WHERE session_id=NEW.surface_key AND source_matter_id!=NEW.matter_id AND detached_at IS NULL;
  END;
  CREATE TRIGGER IF NOT EXISTS terminal_participation_binding_delete AFTER DELETE ON matter_bindings WHEN OLD.surface='cli' BEGIN
    UPDATE terminal_participations SET detached_at=CAST(strftime('%s','now') AS INTEGER)*1000,detach_reason='binding_changed' WHERE session_id=OLD.surface_key AND detached_at IS NULL;
  END;
  CREATE TRIGGER IF NOT EXISTS terminal_participation_binding_update AFTER UPDATE ON matter_bindings WHEN OLD.surface='cli' AND (NEW.matter_id!=OLD.matter_id OR NEW.surface!=OLD.surface OR NEW.surface_key!=OLD.surface_key) BEGIN
    UPDATE terminal_participations SET detached_at=CAST(strftime('%s','now') AS INTEGER)*1000,detach_reason='binding_changed' WHERE session_id=OLD.surface_key AND detached_at IS NULL;
  END;
  CREATE TRIGGER IF NOT EXISTS terminal_participation_matter_end AFTER UPDATE ON matters BEGIN
    UPDATE terminal_participations SET detached_at=NEW.updated_at,detach_reason='matter_ended' WHERE detached_at IS NULL AND ((matter_id=NEW.id AND NEW.archived_at IS NOT NULL) OR (source_matter_id=NEW.id AND (NEW.state='done' OR NEW.archived_at IS NOT NULL)));
  END;`)
}
