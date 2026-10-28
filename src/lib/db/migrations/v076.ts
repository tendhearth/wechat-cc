import type { Migration } from './types'

// v76 — 终端会话登记处(2026-10-14):主人在 CC 之外开的 claude / codex 会话,经 hooks 报进来的
// 那些,落库而不是只在 hub 的内存表里 —— daemon 重启后「看 码」「@码」照样认得,CC 也能列出
// 「谁在跑、谁在等你批准、谁停下了」。status 由已有的 hook 事件推导(core/cli-session-store.ts);
// pending_* 是等批准那一项的摘要(只在 status='waiting' 时有意义)。行数有上限,写入时顺手修剪。
export const migration: Migration = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS cli_sessions (
      session_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      cwd TEXT NOT NULL,
      machine TEXT,
      transcript_path TEXT,
      origin_agent TEXT,
      status TEXT NOT NULL CHECK(status IN ('running','waiting','idle','ended')),
      last_event_at INTEGER NOT NULL,
      last_prompt_at INTEGER,
      last_summary TEXT,
      pending_tool TEXT,
      pending_summary TEXT,
      pending_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cli_sessions_last_event ON cli_sessions(last_event_at);`)
  }
