import type { Migration } from './types'

// v60 — matter(事):主人心里的"一件事",跨表面、跨供应商会话的统一原语
// (2026-09-16 定案,docs/cc-workbench.md「一件事」)。全部是加法:三张新表 +
// workbench_tasks 一列可空的 matter_id。存量任务回填成 kind='task' 的 matter,
// id 与任务 id 相同(一对一,微信里照样好念);聊天的 matter 在首次入站时才建。
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS matters (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('chat','task','companion')),
        title TEXT NOT NULL, project_path TEXT,
        status TEXT NOT NULL CHECK(status IN ('open','replied','done','archived')),
        owner_chat_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS matters_updated ON matters(updated_at);
      CREATE TABLE IF NOT EXISTS matter_bindings (
        matter_id TEXT NOT NULL REFERENCES matters(id),
        surface TEXT NOT NULL CHECK(surface IN ('wechat','desktop','phone','cli')),
        surface_key TEXT NOT NULL, last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(matter_id, surface, surface_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS matter_bindings_key ON matter_bindings(surface, surface_key);
      CREATE TABLE IF NOT EXISTS matter_sessions (
        matter_id TEXT NOT NULL REFERENCES matters(id),
        provider_id TEXT NOT NULL, session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('main','review','handoff')), created_at INTEGER NOT NULL,
        PRIMARY KEY(matter_id, provider_id, session_id)
      ) STRICT;
    `)
    const columns=db.query<{name:string},[]>('PRAGMA table_info(workbench_tasks)').all()
    if(!columns.some(column=>column.name==='matter_id'))db.exec('ALTER TABLE workbench_tasks ADD COLUMN matter_id TEXT REFERENCES matters(id)')
    db.exec(`
      INSERT INTO matters(id, kind, title, project_path, status, owner_chat_id, created_at, updated_at)
        SELECT id, 'task', title, path,
               CASE WHEN archived_at IS NOT NULL THEN 'archived'
                    WHEN status IN ('completed','failed','cancelled') THEN 'done'
                    ELSE 'open' END,
               owner_chat_id, created_at, updated_at
        FROM workbench_tasks WHERE id NOT IN (SELECT id FROM matters);
      UPDATE workbench_tasks SET matter_id = id WHERE matter_id IS NULL;
    `)
  }
