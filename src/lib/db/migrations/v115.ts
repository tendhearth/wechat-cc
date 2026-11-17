import type {Migration} from './types'

// v115 — 分享一件事:链接分三档(只看 / 能讨论 / 能直接让 CC 改),和这件事里大家一起聊的那段对话。
// 只加一列(老链接默认「能讨论」)和一张表,不动已有数据。
export const migration: Migration = db=>{
  // 可重放:已有这一列就跳过,表和索引 IF NOT EXISTS。
  if(!db.query<{name:string},[]>('PRAGMA table_info(matter_shares)').all().some(c=>c.name==='mode'))db.exec("ALTER TABLE matter_shares ADD COLUMN mode TEXT NOT NULL DEFAULT 'discuss' CHECK(mode IN ('view','discuss','act'))")
  db.exec(`CREATE TABLE IF NOT EXISTS matter_talk (
    id INTEGER PRIMARY KEY,
    matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
    share_id TEXT,
    who TEXT NOT NULL CHECK(who IN ('owner','guest','cc')),
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_matter_talk_matter ON matter_talk(matter_id,id);`)
}
