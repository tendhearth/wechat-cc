import type { Migration } from './types'

// v86 — OpenAI 兼容对话的会话历史(架构终态 B2,2026-10-25):对话和工作台合成一种会话,持久化都走 api-sessions;
// 工作台那张 workbench_api_sessions 的 task_id 外键指着 workbench_tasks,对话放不进去 ⇒ 另一张表,列照着它。
// 以前对话的历史只在内存里,daemon 一重启 / 会话一释放就从头来。
export const migration: Migration = (db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS openai_chat_sessions(
    id TEXT PRIMARY KEY NOT NULL,
    chat_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    path TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=0),
    messages_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','ready','interrupted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_openai_chat_sessions_chat ON openai_chat_sessions(chat_id, alias);`)
}
