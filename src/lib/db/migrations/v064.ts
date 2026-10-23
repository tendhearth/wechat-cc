import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v64 — matter 记住出生地:哪次陪伴交流(origin_matter_id,它本身是一行 kind='chat'
// 的 matter)、哪条消息(origin_message_id,messages.id)。两列可空:桌面上亲手派的
// 事没有出生地,而「没有出生地 ⇒ 不回报」正是设计里的判据,不另设开关。
export const migration: Migration = (db) => {
    if(!hasTable(db,'matters'))return
    const columns=db.query<{name:string},[]>('PRAGMA table_info(matters)').all()
    if(!columns.some(column=>column.name==='origin_matter_id'))db.exec('ALTER TABLE matters ADD COLUMN origin_matter_id TEXT REFERENCES matters(id)')
    if(!columns.some(column=>column.name==='origin_message_id'))db.exec('ALTER TABLE matters ADD COLUMN origin_message_id TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS matters_origin ON matters(origin_matter_id)')
  }
