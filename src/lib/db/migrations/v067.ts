import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v67 — journal.matter_id(回忆的持久去重 + 可回溯;评审修复轮 2 新
// Important):recordRecollection 写的行以前完全不带任何 matter/task 标识,
// 结构上就不可能"按 matter 查一次"——daemon 重启会换一个新的 in-memory
// Set(recollect-sink.ts),同一个 matter 只要重启后再次够格,就会再写一条
// 几乎一样的「一段回忆」,且已上线的空闲自动重启会让长期开着的事每次重启
// 各留一条。这列既是持久去重的键(recordRecollection 之前先按 matter_id
// 查一次 kind='recollection' 的行在不在),也顺手修了复审指出的产品缺陷
// ——面板上的回忆条目以前回溯不到哪件事。只给 journal 加一个可空列,不
// 影响其它 kind(hunt/visit/postcard 继续传 NULL,老行也是 NULL——历史
// 数据没有 matter 可补,查不到不算错)。
export const migration: Migration = (db) => {
    if(!hasTable(db,'journal'))return
    const columns=db.query<{name:string},[]>('PRAGMA table_info(journal)').all()
    if(!columns.some(column=>column.name==='matter_id'))db.exec('ALTER TABLE journal ADD COLUMN matter_id TEXT')
  }
